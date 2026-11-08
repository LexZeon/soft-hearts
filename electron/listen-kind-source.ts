/**
 * I-016 A (docs/claude/2026-11-03-listen-kind.md): the host's slower "what is playing" layer, the producer of the shared
 * ListenKindHost (shared/listen-kind.ts).
 *
 * Evidence, over a 30 s window, smoothed and with hysteresis (a new kind has to keep winning before it is taken):
 *  - the beat leads: the pet window's fast layer (src/stage/music-likeness.ts) reports its "像音乐" score with I-017's stage
 *    report (`beat`, through StageStateHost: only the pet window, fresh, in order). Sound with a high score is music, sound with a
 *    low one is not; quiet is no sound at all;
 *  - a "stretch" is sound with no quiet longer than LISTEN_STRETCH_GAP_MS. A stretch that had music (an opening song, background
 *    music) or laughter / applause and then sound that is not music is a show; one that never had any is talk;
 *  - the local recognizer's tags only help (electron/asr/ambient-route.ts observe: words or not, the event tag; only while a
 *    transcription switch is on). They were measured unreliable on their own (the same music under Chinese speech was "bgm", under
 *    English "speech"), so they correct the beat only when most recent clips agree: instrumental clips (singing, or background
 *    music with no words) turn "not music" into music (a song with no drums the beat missed); clips the model heard as speech
 *    with words turn a wavering "music" into a show (dialogue over a beat); laughter or applause marks a show.
 * No audio and no text: scores, tags and times only, in memory.
 */
import { ListenKindHost, type ListenKind, type ListenKindView } from '../shared/listen-kind';
import type { HeardKind, StageMusicState } from '../shared/her-state';
import type { AsrEventTag } from './asr/decode';
import type { AmbientHeard } from './asr/ambient-route';

export const LISTEN_TICK_MS = 1_000;
/** The smoothing window. */
export const LISTEN_WINDOW_MS = 30_000;
/** Music, a show or talk is only said with at least this much sound in the window. */
export const LISTEN_MIN_SOUND_MS = 10_000;
/** No sound for this long is quiet. */
export const LISTEN_QUIET_MS = 20_000;
/** A new kind must keep winning this long before it is taken (from quiet or unsure: LISTEN_ENTER_MS). */
export const LISTEN_SWITCH_MS = 8_000;
export const LISTEN_ENTER_MS = 3_000;
/** Quiet this long ends a stretch (what a show's opening song or laughter carries over to). */
export const LISTEN_STRETCH_GAP_MS = 60_000;
/** Music this long in a stretch, followed by sound that is not music, makes the stretch a show (an opening song, a jingle). */
export const LISTEN_SHOW_MUSIC_MS = 8_000;
/** Music and sound that is not music taking turns is a show once one stretch of the latter ran this long (a scene of dialogue). */
export const LISTEN_SHOW_TALK_RUN_MS = 10_000;
/** The stage's own thresholds (music-likeness.ts LIKENESS_MUSIC_ON / OFF). */
export const LISTEN_BEAT_MUSIC = 0.55;
export const LISTEN_BEAT_NOT = 0.35;
/** Tags: the clips of the last minute; at least LISTEN_TAG_MIN of them, and two thirds agreeing. */
export const LISTEN_TAG_WINDOW_MS = 60_000;
export const LISTEN_TAG_MIN = 3;
export const LISTEN_TAG_MAJORITY = 2 / 3;
/** Beat "music" that is this steady is not turned into a show by speech tags (it is a song, or not knowable: see below). */
export const LISTEN_STEADY_MUSIC = 0.85;
/**
 * Codex T-207: a steady beat while every recent clip (at least this many, none instrumental) is heard as speech with words is
 * conflicting evidence (a voice over a loop, a call with a rhythmic hum; perhaps an English song tagged speech): not music, but
 * unsure, and the stretch so far is taken back (since = its start), so nothing kept from it stays (宁可少记，不误记通话).
 */
export const LISTEN_VETO_CLIPS = 2;
/** A show turns into music only after this much music in a row (an insert song or the ending theme stays the show). */
export const LISTEN_SHOW_TO_MUSIC_MS = 90_000;
/** With nothing fresh from the pet window (hidden and throttled, reloading) the last kind is kept this long. */
export const LISTEN_HOLD_BLIND_MS = 120_000;

export type ListenSource = 'none' | 'beat' | 'tags' | 'beat+tags';
/** `takeBack`: the stretch was never what it looked like (the veto above): settle fast, and since = the stretch's start. */
export interface ListenCandidate { kind: ListenKind; confidence: number; source: ListenSource; takeBack?: boolean }
export interface ListenObservation {
  /** The switch that lets her hear is on (I-017 hearingSource). */
  hearing: boolean;
  /** The pet window's fresh report, or null. */
  stage: { music: StageMusicState; beat?: number } | null;
}
interface Slice { from: number; to: number; known: boolean; sound: boolean; beat: number | null }
interface Clip { at: number; words: boolean; event: AsrEventTag | null }
interface Stretch { start: number; lastSound: number; musicMs: number; otherMs: number; otherRun: number; otherRunMax: number; cue: boolean }

const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const SHOW_CUES: readonly AsrEventTag[] = ['laughter', 'applause'];
const instrumental = (clip: Clip) => clip.event === 'sing' || (clip.event === 'bgm' && !clip.words);
const spoken = (clip: Clip) => clip.words && clip.event === 'speech';

/** The pure judgement: observations and clips in, a smoothed kind out. Time is passed in (epoch ms). */
export class ListenKindJudge {
  private slices: Slice[] = [];
  private clips: Clip[] = [];
  private stretch: Stretch | null = null;
  private lastAt: number | null = null;
  private view: ListenKindView = { kind: 'quiet', confidence: 1, since: 0, revision: 0 };
  private pending: { kind: ListenKind; since: number } | null = null;
  private last: ListenCandidate = { kind: 'quiet', confidence: 1, source: 'none' };
  private latestBeat: number | null = null;
  private lastEvidenceAt = -Infinity;

  /** One look (every LISTEN_TICK_MS). Returns the view, a new revision when the kind changed. */
  observe(now: number, observation: ListenObservation): ListenKindView {
    if (!Number.isFinite(now)) return { ...this.view };
    if (this.lastAt !== null && now < this.lastAt) { this.lastAt = now; return { ...this.view }; }
    const from = this.lastAt ?? now - LISTEN_TICK_MS, dt = Math.min(5_000, Math.max(0, now - from));
    this.lastAt = now;
    const stage = observation.hearing ? observation.stage : null;
    const known = !!stage, sound = known && stage!.music !== 'off' && stage!.music !== 'silent';
    // A window without the score (an older page) still knows music from what her body shows to it.
    const beat = !sound ? null : Number.isFinite(stage!.beat) ? clamp(stage!.beat!) : stage!.music === 'dance' || stage!.music === 'nod' ? 0.6 : null;
    this.latestBeat = known ? (Number.isFinite(stage!.beat) ? clamp(stage!.beat!) : null) : null;
    this.slices.push({ from: now - dt, to: now, known, sound, beat });
    if (known) this.lastEvidenceAt = now;
    this.slices = this.slices.filter(slice => slice.to > now - Math.max(LISTEN_WINDOW_MS, LISTEN_QUIET_MS));
    this.clips = this.clips.filter(clip => clip.at > now - LISTEN_TAG_WINDOW_MS && clip.at <= now + 1_000);
    // The stretch: sound with no long quiet in it; switching the hearing off ends it.
    if (!observation.hearing && !this.clips.length) this.stretch = null;
    if (this.stretch && now - this.stretch.lastSound > LISTEN_STRETCH_GAP_MS) this.stretch = null;
    if (sound) {
      this.stretch ??= { start: now - dt, lastSound: now, musicMs: 0, otherMs: 0, otherRun: 0, otherRunMax: 0, cue: false };
      this.stretch.lastSound = now;
      if (beat !== null && beat >= LISTEN_BEAT_MUSIC) this.stretch.musicMs += dt;
      else if (beat !== null && beat < LISTEN_BEAT_NOT) this.stretch.otherMs += dt;
      // A long run of clearly-not-music (dialogue), not the short dips of a drumless piece or the seconds before music is recognized.
      this.stretch.otherRun = beat !== null && beat < LISTEN_BEAT_NOT ? this.stretch.otherRun + dt : 0;
      this.stretch.otherRunMax = Math.max(this.stretch.otherRunMax, this.stretch.otherRun);
    }
    this.last = this.candidate(now, observation.hearing);
    const revision = this.view.revision, view = this.settle(now, this.last);
    // Codex T-207: once quiet is recognised, what played before is over. A call after a show's quiet is a new stretch (talk),
    // not more of the show; a show resumed after such a pause is a show again only from a new cue (宁可少记).
    if (view.revision !== revision && view.kind === 'quiet') this.stretch = null;
    return view;
  }

  /** One transcribed clip (words or not, the event tag). */
  noteClip(at: number, heard: AmbientHeard): void {
    if (!Number.isFinite(at)) return;
    const clip: Clip = { at, words: heard.words === true, event: heard.event ?? null };
    this.clips.push(clip);
    if (this.clips.length > 32) this.clips.shift();
    if (clip.event && SHOW_CUES.includes(clip.event)) {
      this.stretch ??= { start: at, lastSound: at, musicMs: 0, otherMs: 0, otherRun: 0, otherRunMax: 0, cue: false };
      this.stretch.cue = true; this.stretch.lastSound = Math.max(this.stretch.lastSound, at);
    }
  }

  current(): ListenKindView { return { ...this.view }; }
  /** The last look's raw candidate (before smoothing) and the newest score. */
  inspect(): { candidate: ListenCandidate; beat: number | null; clips: number; stretch: Readonly<Stretch> | null } {
    return { candidate: { ...this.last }, beat: this.latestBeat, clips: this.clips.length, stretch: this.stretch ? { ...this.stretch } : null };
  }

  private candidate(now: number, hearing: boolean): ListenCandidate {
    const clips = this.clips.filter(clip => clip.at > now - LISTEN_TAG_WINDOW_MS);
    if (!hearing && !clips.length) return { kind: 'quiet', confidence: 1, source: 'none' };
    // Most recent clips agree, and the newest one too (so the opening song's clips do not keep a show's dialogue "music").
    const vote = (test: (clip: Clip) => boolean) => clips.length >= LISTEN_TAG_MIN && clips.filter(test).length / clips.length >= LISTEN_TAG_MAJORITY - 1e-9 && test(clips.at(-1)!);
    const tagMusic = vote(instrumental), tagSpoken = vote(spoken), cue = clips.some(clip => !!clip.event && SHOW_CUES.includes(clip.event)) || this.stretch?.cue === true;
    // Every recent clip heard as speech with words, at least LISTEN_VETO_CLIPS of them (none instrumental, none a show cue).
    const spokenOnly = clips.length >= LISTEN_VETO_CLIPS && clips.every(spoken);
    let known = 0, sound = 0, music = 0, other = 0, recentSound = 0, recentKnown = 0;
    for (const slice of this.slices) {
      const length = slice.to - slice.from;
      if (slice.to > now - LISTEN_WINDOW_MS && slice.known) {
        known += length;
        if (slice.sound) { sound += length; if (slice.beat !== null && slice.beat >= LISTEN_BEAT_MUSIC) music += length; else if (slice.beat !== null && slice.beat < LISTEN_BEAT_NOT) other += length; }
      }
      if (slice.to > now - LISTEN_QUIET_MS && slice.known) { recentKnown += length; if (slice.sound) recentSound += length; }
    }
    if (known >= 2_000) {
      if ((recentKnown >= LISTEN_QUIET_MS - 2_000 && recentSound < 1_000) || sound < 1_000) return { kind: 'quiet', confidence: clamp(1 - recentSound / LISTEN_QUIET_MS), source: 'beat' };
      if (sound < LISTEN_MIN_SOUND_MS) return { kind: 'unsure', confidence: 0, source: 'beat' };
      const musicShare = music / sound, otherShare = other / sound, stretch = this.stretch;
      const hadMusic = !!stretch && stretch.musicMs >= LISTEN_SHOW_MUSIC_MS;
      // Speech over background music (the Chinese measurement: "bgm" with words) is a show's cue when the beat says it is not music.
      const showCue = cue || (otherShare >= 0.6 && vote(clip => clip.words && clip.event === 'bgm'));
      // Music: mostly a clear score, or (a drumless piece hovering in the middle) hardly anything that is clearly not music.
      if (musicShare >= 0.6 || (otherShare <= 0.25 && musicShare >= 0.3)) {
        // Dialogue over a beat: most clips heard as speech with words, and the beat itself not steady.
        if (tagSpoken && musicShare < LISTEN_STEADY_MUSIC) return { kind: 'show', confidence: clamp(0.5 + 0.5 * (1 - musicShare)), source: 'beat+tags' };
        // A steady beat the recognizer only ever hears as speech: not knowable, so not a song (Codex T-207, LISTEN_VETO_CLIPS).
        if (spokenOnly && musicShare >= LISTEN_STEADY_MUSIC) return { kind: 'unsure', confidence: 0, source: 'beat+tags', takeBack: true };
        return { kind: 'music', confidence: clamp(musicShare), source: tagMusic ? 'beat+tags' : 'beat' };
      }
      if (otherShare >= 0.6) {
        // A song the beat missed (no drums): most clips instrumental or sung.
        if (tagMusic) return { kind: 'music', confidence: clamp(0.5 + 0.5 * otherShare), source: 'tags' };
        if (hadMusic || showCue) return { kind: 'show', confidence: clamp(0.6 + (hadMusic ? 0.2 : 0) + (showCue ? 0.2 : 0)), source: showCue && !hadMusic ? 'beat+tags' : 'beat' };
        return { kind: 'talk', confidence: clamp(otherShare * (tagSpoken ? 1 : 0.9)), source: tagSpoken ? 'beat+tags' : 'beat' };
      }
      // Mixed: music and other sound taking turns.
      if (cue || (hadMusic && !!stretch && stretch.otherRunMax >= LISTEN_SHOW_TALK_RUN_MS)) return { kind: 'show', confidence: 0.6, source: cue ? 'beat+tags' : 'beat' };
      if (tagMusic) return { kind: 'music', confidence: 0.6, source: 'beat+tags' };
      return { kind: 'unsure', confidence: 0, source: 'beat' };
    }
    // Nothing fresh from the stage and no clips (the pet window hidden and throttled, or reloading): keep what was known a while.
    if (!clips.length && now - this.lastEvidenceAt < LISTEN_HOLD_BLIND_MS) return { kind: this.view.kind, confidence: this.view.confidence, source: 'none' };
    // Only the clips (the rhythm switch off, a transcription switch on).
    if (clips.length < LISTEN_TAG_MIN) return { kind: 'unsure', confidence: 0, source: 'tags' };
    if (cue) return { kind: 'show', confidence: 0.6, source: 'tags' };
    if (tagMusic) return { kind: 'music', confidence: 0.6, source: 'tags' };
    if (tagSpoken) return { kind: 'talk', confidence: 0.6, source: 'tags' };
    if (clips.every(clip => !clip.words && !clip.event)) return { kind: 'quiet', confidence: 0.6, source: 'tags' };
    return { kind: 'unsure', confidence: 0, source: 'tags' };
  }

  private settle(now: number, candidate: ListenCandidate): ListenKindView {
    if (candidate.kind === this.view.kind) { this.pending = null; return { ...this.view }; }
    if (!this.pending || this.pending.kind !== candidate.kind) this.pending = { kind: candidate.kind, since: now };
    const fromLoose = this.view.kind === 'quiet' || this.view.kind === 'unsure';
    // Taking a song back (the veto): quickly, so little of it is kept meanwhile; the listen-together core then drops it.
    const takeBack = candidate.takeBack === true && this.view.kind === 'music';
    // A show keeps its insert songs and its ending theme: only a long run of music turns it into music (a playlist after it).
    const need = takeBack || fromLoose ? LISTEN_ENTER_MS : candidate.kind === 'unsure' ? LISTEN_SWITCH_MS * 2
      : this.view.kind === 'show' && candidate.kind === 'music' ? LISTEN_SHOW_TO_MUSIC_MS : LISTEN_SWITCH_MS;
    if (now - this.pending.since < need) return { ...this.view };
    // When it began: a song, a show or talk from quiet began with the stretch's sound; a show that grew out of its opening music
    // began with that music too; a taken-back song was unsure from the stretch's start; anything else when the new kind started winning.
    const stretchStart = this.stretch?.start;
    const since = stretchStart !== undefined && (takeBack || (candidate.kind !== 'quiet' && candidate.kind !== 'unsure' && (fromLoose || (candidate.kind === 'show' && this.view.kind === 'music'))))
      ? Math.min(stretchStart, this.pending.since) : this.pending.since;
    this.view = { kind: candidate.kind, confidence: clamp(candidate.confidence), since, revision: this.view.revision + 1 };
    this.pending = null;
    return { ...this.view };
  }
}

const KIND_WORDS: Readonly<Record<ListenKind, string>> = { music: '音乐', show: '剧和视频', talk: '只是说话', quiet: '安静', unsure: '说不准' };
const SOURCE_WORDS: Readonly<Record<ListenSource, string>> = { none: '没在听', beat: '节拍', tags: '标签', 'beat+tags': '节拍+标签' };

export interface ListenKindSources {
  /** The pet window's reports (I-017 StageStateHost). */
  stage: { current(now?: number): { music: StageMusicState; always: boolean; beat?: number } | null };
  /** The switch that lets her hear is on (I-017 hearingSource(...) !== null). */
  hearing(): boolean;
  now?(): number;
}

/** The host side: one judge, the shared ListenKindHost it sets, a 1 s look, and the readers I-017 and the developer line use. */
export class ListenKindSource {
  readonly host = new ListenKindHost();
  private readonly judge = new ListenKindJudge();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  constructor(private readonly sources: ListenKindSources) { this.now = sources.now ?? Date.now; }

  start(schedule: (run: () => void, ms: number) => ReturnType<typeof setInterval> = setInterval): void {
    if (this.timer) return;
    this.timer = schedule(() => this.tick(), LISTEN_TICK_MS);
    (this.timer as { unref?(): void }).unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One look; sets the shared host when the kind changed. */
  tick(): ListenKindView {
    const now = this.now();
    let hearing = false, stage: ListenObservation['stage'] = null;
    try { hearing = this.sources.hearing() === true; } catch { hearing = false; }
    try { stage = hearing ? this.sources.stage.current(now) : null; } catch { stage = null; }
    const view = this.judge.observe(now, { hearing, stage });
    if (view.revision > this.host.current().revision) this.host.set(view);
    return view;
  }

  /** One transcribed clip (AmbientAsrRoute.observe). */
  noteHeard(heard: AmbientHeard): void { this.judge.noteClip(this.now(), heard); }

  /**
   * I-017's words for what the sound is: the settled kind, or before that the stage's own guess (music in it → 'rhythm',
   * otherwise 'sound'); undefined when there is nothing to say (quiet: the stage's own "很安静" covers it).
   */
  heardKind(): HeardKind | undefined {
    const kind = this.host.current().kind;
    if (kind === 'music' || kind === 'show' || kind === 'talk') return kind;
    const beat = this.judge.inspect().beat;
    return beat === null ? undefined : beat >= LISTEN_BEAT_MUSIC ? 'rhythm' : 'sound';
  }

  /** The developer line (pet window, developer mode): kind, how sure, from what, since when, and the raw look. */
  panelLine(): string {
    const view = this.host.current(), look = this.judge.inspect();
    const ago = view.since ? `${Math.max(0, Math.round((this.now() - view.since) / 1000))} 秒前开始` : '';
    const raw = look.candidate.kind !== view.kind ? ` · 正在看：${KIND_WORDS[look.candidate.kind]}` : '';
    return `宿主：${KIND_WORDS[view.kind]} ${view.confidence.toFixed(2)}（${SOURCE_WORDS[look.candidate.source]}${look.beat !== null ? `，节拍分 ${look.beat.toFixed(2)}` : ''}${look.clips ? `，标签 ${look.clips} 段` : ''}${ago ? `，${ago}` : ''}）${raw}`;
  }
}
