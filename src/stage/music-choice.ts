/**
 * 音频律动由她决定 (M1): the director between "she hears music" and what her body does.
 * Record: docs/claude/2026-11-03-music-her-choice.md.
 *
 * It owns only the decision and its timing; the motion itself (and every smooth entry and exit) is
 * the existing machinery: the R15 dance (music-dance.ts, with R29b's yield and release) for the top
 * tier, a light nod and sway through R18's small motions (music-nod.ts) for the middle one.
 *
 *  - hearing: the audio path says music is audible (what AudioReadingClient's active flag always meant);
 *  - a new song (hearing again after a gap of MUSIC_NEW_SONG_GAP_S) is judged at once, again after
 *    MUSIC_CATCH_ON_S (so a daydreaming her is carried along after a moment), then every MUSIC_REJUDGE_S;
 *  - changes in the middle of a song are limited by hysteresis (shared/music-desire.ts) and a minimum
 *    stay; falling asleep and a chat request are the exceptions and act at once;
 *  - a small random variation per judgement (injectable) keeps two songs in the same mood from always
 *    coming out the same.
 *
 * `always` is the user's fallback switch ("让她一直跟着跳"): the tier is "dance" exactly while she hears
 * music, with no timing and no judgement, which is what R15 did. Stage code treats that case as the
 * original path.
 */
import {
  danceRequestSettleMs, danceRequestStrength, danceTierName, danceTierWithHysteresis, isAsleep, moodLabelDanceDesire,
  type DanceDesire, type DanceDesireFn, type DanceDesireInput, type DanceTier,
} from '../../shared/music-desire';

export const MUSIC_NEW_SONG_GAP_S = 3;
export const MUSIC_CATCH_ON_S = 5;
export const MUSIC_REJUDGE_S = 15;
export const MUSIC_MIN_STAY_S = 8;
export const MUSIC_VARIATION = 0.05;
/**
 * R18 (docs/claude/2026-11-03-e1-r18-fixes.md): "hearing" is the capture being on, which it is in silence too. A sample with
 * RMS ≥ MUSIC_AUDIBLE_RMS (0..1) is sound.
 *
 * I-016: a song is no longer "0.3 s of
 * sound" but sound the fast layer recognizes as music (music-likeness.ts, given by the stage through `noteMusic`), so talk and
 * a show's dialogue never make her look up to listen or want to dance. The song is over after MUSIC_NEW_SONG_GAP_S without
 * music (silence, or sound that is not music), and she goes back to herself; the next song is judged anew.
 */
export const MUSIC_AUDIBLE_RMS = 0.004;
/** A request is only taken when the host's message is this fresh (a late or replayed view never starts one). */
const REQUEST_FRESH_MS = 5_000;

/** Who she is and how she is right now, supplied every frame by the stage from the host's mood view. */
export type MusicChoiceContext = Omit<DanceDesireInput, 'heardSeconds' | 'request'> & {
  /** Changes with the character / chat scope: an old request does not carry over. */
  scope: string;
  /** The host's latest chat request marker and the wall clock to judge its freshness by. */
  request: { id: string; at: number } | null;
  nowMs: number;
  /** 自动表现 on (MoodView.expressions). Off: she does not start moving on her own, as with every automatic motion. */
  expressive?: boolean;
};

/** Why she cannot move at all right now, or null. Both act at once, not at the next judgement. */
function blockedReason(context: MusicChoiceContext): string | null {
  return isAsleep(context.fatigue) ? '睡着了' : context.expressive === false ? '自动表现已暂停' : null;
}
const stillDesire = (why: string): DanceDesire => ({ score: 0, tier: 'none', parts: [{ name: why, value: -1 }], reason: `想跳 0.00 · 不动 · ${why}`, asleep: true });

export interface MusicChoiceState {
  mode: 'always' | 'her';
  hearing: boolean;
  /** What the body should do right now. */
  tier: DanceTier;
  score: number | null;
  judgements: number;
  heardSeconds: number;
  request: number;
  /** I-016: a song is playing: sound recognized as music (was R18's "sound is coming in"). */
  audible: boolean;
  /** R18: sound is coming in at all (music or not). */
  sound: boolean;
  /** R18: how many times a song became audible and she was asked to show she heard it. */
  listenCues: number;
  /** The developer line: 听到了 / 没听到, score, tier and why. */
  line: string;
}

export class MusicChoice {
  private always = false;
  private hearing = false;
  private clock = 0;
  private lastHeardAt = -Infinity;
  private songStart = 0;
  private nextJudge = Infinity;
  private due = false;
  /** A developer test asked for this judgement: it is not held back by the minimum stay. */
  private rejudge = false;
  private judgements = 0;
  private decided: DanceTier = 'none';
  private changedAt = -Infinity;
  private scope = '';
  private requestId = '';
  private requestAt = -Infinity;
  private settleAt = Infinity;
  private phase = '';
  private desire: DanceDesire | null = null;
  private variation = 0;
  private lastRequest = 0;
  // R18 / I-016: sound coming in, music recognized in it, and the one "she heard it" cue per song
  private audible = false;
  private music = false;
  private lastMusicAt = -Infinity;
  private lastLoudAt = -Infinity;
  private listenPending = false;
  private listenCues = 0;

  constructor(private readonly fn: DanceDesireFn = moodLabelDanceDesire, private readonly random: () => number = Math.random) {}

  /** The fallback switch. Turning it off mid-song keeps what she is doing and judges again at once. */
  setAlways(value: boolean): void {
    const on = value === true;
    if (on === this.always) return;
    this.always = on;
    // Mid-song she keeps dancing (what "一直跟着跳" showed) and judges at once; with no song playing there is nothing to keep.
    if (!on) { const song = this.hearing && this.audible; this.decided = song ? 'dance' : 'none'; this.changedAt = this.clock; this.due = song; }
  }
  get isAlways(): boolean { return this.always; }

  /** Music is (or is no longer) audible. A short gap is the same song; a long one starts a new song. */
  setHearing(value: boolean): void {
    const on = value === true;
    if (on === this.hearing) return;
    this.hearing = on;
    // Off: nothing is heard; a song that comes back within MUSIC_NEW_SONG_GAP_S is the same song (trackAudible ends it after that).
    if (!on) { this.lastHeardAt = this.clock; this.music = false; this.lastLoudAt = -Infinity; return; }
    if (this.clock - this.lastHeardAt >= MUSIC_NEW_SONG_GAP_S) {
      this.songStart = this.clock; this.judgements = 0; this.decided = 'none'; this.changedAt = -Infinity; this.due = !this.always; this.audible = false;
    }
  }

  /** What her body should do right now. */
  get tier(): DanceTier { return !this.hearing ? 'none' : this.always ? 'dance' : this.decided; }

  /**
   * Developer test command (electron/test-commands/ "重新判一次想不想跳"): judge again at the next frame and let the answer
   * take effect without the 8-second minimum stay. Nothing to judge without music or in the "always dance" mode.
   */
  rejudgeNow(): boolean {
    if (this.always || !this.hearing || !this.audible) return false;
    this.due = true; this.rejudge = true;
    return true;
  }

  /** R18: the level of one capture sample (RMS 0..1). Only counts while the capture is on. */
  noteLevel(rms: number): void {
    if (this.hearing && Number.isFinite(rms) && rms >= MUSIC_AUDIBLE_RMS) this.lastLoudAt = this.clock;
  }

  /** I-016: the fast layer's verdict for this frame (music-likeness.ts): what she hears is music. */
  noteMusic(value: boolean): void { this.music = this.hearing && value === true; }

  /** R18: a song became audible since the last call and she may show she heard it (once per song). */
  takeListenCue(): boolean { const pending = this.listenPending; this.listenPending = false; return pending; }

  /**
   * R18 / I-016: a song (music recognized) is judged as a new song from that moment, and asks once for the listening look, in
   * any mood — but not asleep or with 自动表现 paused. A short break in it is the same song; after MUSIC_NEW_SONG_GAP_S without
   * music the song is over and what she decided ends with it (the dance and the nod leave by their own ease-out), so talk or
   * dialogue after a song never keeps her dancing, and the next song starts from her own choice again.
   */
  private trackAudible(context: MusicChoiceContext): void {
    if (this.hearing && this.music) this.lastMusicAt = this.clock;
    if (!this.audible && this.hearing && this.music) {
      this.audible = true;
      this.songStart = this.clock; this.judgements = 0; this.due = true;
      if (!blockedReason(context)) { this.listenPending = true; this.listenCues++; }
    } else if (this.audible && this.clock - this.lastMusicAt >= MUSIC_NEW_SONG_GAP_S) {
      this.audible = false; this.nextJudge = Infinity; this.due = false;
      if (this.decided !== 'none') { this.decided = 'none'; this.changedAt = this.clock; }
    }
  }

  /** One display frame. `context` is needed only when she chooses (not with "一直跟着跳"). */
  frame(delta: number, context?: MusicChoiceContext): void {
    this.clock += Number.isFinite(delta) ? Math.min(0.1, Math.max(0, delta)) : 0;
    // "一直跟着跳" keeps no judgement (R15), but knows whether a song is playing, for when it is switched off mid-song.
    if (this.always || !context) { if (this.hearing && this.music) this.lastMusicAt = this.clock; if (this.always) this.audible = this.hearing && this.clock - this.lastMusicAt < MUSIC_NEW_SONG_GAP_S; return; }
    this.trackAudible(context);
    this.takeRequest(context);
    // Falling asleep (or waking) is acted on at once, not at the next scheduled judgement.
    const phase = context.fatigue?.phase ?? '';
    if (phase !== this.phase) { this.phase = phase; if (this.hearing) this.due = true; }
    const blocked = blockedReason(context);
    if (this.hearing && this.decided !== 'none' && blocked) this.decide('none', blocked);
    // I-016: nothing to judge until a song is recognized (talk and dialogue never make her want to dance).
    if (!this.hearing || !this.audible) return;
    if (this.clock >= this.settleAt) { this.settleAt = Infinity; this.due = true; }
    if (this.due || this.clock >= this.nextJudge) this.judge(context);
  }

  private takeRequest(context: MusicChoiceContext): void {
    if (context.scope !== this.scope) { this.scope = context.scope; this.requestAt = -Infinity; this.settleAt = Infinity; }
    const request = context.request;
    if (!request || request.id === this.requestId) return;
    this.requestId = request.id;
    const age = context.nowMs - request.at;
    if (!(age >= -1_000 && age <= REQUEST_FRESH_MS)) return;
    this.requestAt = this.clock - Math.max(0, age) / 1000;
    // Judge now, and again once the request has reached its full strength for this card (a stubborn one gives in later).
    this.settleAt = this.requestAt + danceRequestSettleMs(context) / 1000;
    if (this.hearing) this.due = true;
  }

  private judge(context: MusicChoiceContext): void {
    const heardSeconds = this.clock - this.songStart;
    const request = Number.isFinite(this.requestAt) ? danceRequestStrength((this.clock - this.requestAt) * 1000, context) : 0;
    this.lastRequest = request;
    const blocked = blockedReason(context);
    const desire = blocked ? stillDesire(blocked) : this.fn({ ...context, heardSeconds, request });
    // A little variation per judgement; it never wakes her up.
    this.variation = desire.asleep ? 0 : (this.random() - 0.5) * 2 * MUSIC_VARIATION;
    const score = desire.asleep ? 0 : Math.min(1, Math.max(0, desire.score + this.variation));
    this.desire = { ...desire, score };
    this.judgements++;
    this.due = false;
    this.nextJudge = this.clock + (this.judgements === 1 ? MUSIC_CATCH_ON_S : MUSIC_REJUDGE_S);
    const next = danceTierWithHysteresis(score, this.decided);
    // The first two judgements of a song (the start, and the catch-on moment) and the ones that sleep or a request cause are not held back.
    const quick = this.judgements <= 2 || desire.asleep || request > 0.5 || this.rejudge;
    this.rejudge = false;
    if (next !== this.decided && (quick || this.clock - this.changedAt >= MUSIC_MIN_STAY_S)) this.decide(next, null);
  }

  private decide(tier: DanceTier, forced: string | null): void {
    this.decided = tier; this.changedAt = this.clock;
    if (forced) this.desire = stillDesire(forced);
  }

  getState(): MusicChoiceState {
    const tier = this.tier;
    const heardSeconds = this.hearing ? this.clock - this.songStart : 0;
    const audible = this.hearing && this.audible, listenCues = this.listenCues;
    const sound = this.hearing && this.clock - this.lastLoudAt < MUSIC_NEW_SONG_GAP_S;
    if (this.always) return { mode: 'always', hearing: this.hearing, tier, score: null, judgements: 0, heardSeconds, request: 0, audible, sound, listenCues,
      line: !this.hearing ? '让她一直跟着跳：开（现在没有音乐）' : audible ? '让她一直跟着跳：开（认出是音乐，在跳）' : '让她一直跟着跳：开（认出是音乐就跳；现在不是音乐）' };
    // R18: first whether she hears anything at all — the capture off, on but silent, sound that is not music, or a song (and whether she wants to move).
    const heard = !this.hearing ? '没听到（音频律动没开，或还没收到声音）' : !sound && !audible ? '没听到声音（律动开着，现在很安静）'
      : !audible ? '听到声音，还没认出是音乐' : null;
    const line = !this.desire || !audible ? (heard ? `想跳：${heard}` : '听到了 · 想跳：正在判断')
      : `${tier === 'none' ? '听到了，但不想跳 · ' : '听到了 · '}${this.desire.reason} → ${danceTierName(tier)} · 第 ${this.judgements} 次判断${this.lastRequest > 0 ? ` · 你叫她跳 ${this.lastRequest.toFixed(2)}` : ''}`;
    return { mode: 'her', hearing: this.hearing, tier, score: this.desire?.score ?? null, judgements: this.judgements, heardSeconds, request: this.lastRequest, audible, sound, listenCues, line };
  }
}
