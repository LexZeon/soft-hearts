/**
 * I-136 (Unbound v1 step 2; step 5 uses it again for pulls): the brain side of touches. electron/main.ts registers `touch` with
 * setTouchSink (electron/mood/touch/sink.ts), gives MoodHost `moodPort` (a pinch began, a pat / pinch / snack was accepted, the face for the
 * view), and wires four readers: the reaction journal tap (`reactionPlayed`), the chat turn's words (`chatWords`), the opening choice's
 * claimant (`claims`) and the inner loop's 'touch' line (`promptLine`). Record: docs/claude/2026-11-15-unbound-v1-step2-touch.md.
 *
 * For each touch (all local, no Claude):
 *  1. merge: the same kind and part within knobs.mergeMs is one thing with a count (shared/behaviors/touch-response/merge.ts);
 *  2. face: a new click / pull / pinch picks her face from her mood numbers and character (face.ts), published in MoodView.touchFace;
 *  3. reaction: a new click / pull asks I-037's reaction host for its top body reaction (blush, shy, tilt, pout…; only while that switch is on);
 *  4. write back: a gentle touch nudges closeness up, poking and hard pulls nudge tension up (mood.ts touchLift → MoodHost.lift);
 *  5. speak?: a little after the last touch of a click / pull / pinch, one roll from her mood values and character (speak.ts); yes →
 *     one speech cue (companion: the usual caps; Unbound: none), which the opening choice hands to the inner loop with the touch as its focus;
 *  6. tell: the next chat turn's "用户刚才……" and that proactive turn's line say what happened and what she showed (words.ts);
 *  7. journal: one 'touch' row per decision: kind, part, place, count, face, reaction, outcome, chance in tenths. Never a word.
 */
import type { MoodContext, MoodValues } from '../../../shared/foundation/mood';
import type { MoodView } from '../../../shared/mood/mood-runtime';
import type { HerContact } from '../../../shared/mood/her-state';
import type { TouchEvent, TouchPart, TouchPlace } from '../../../shared/mood/touch';
import type { Dispositions } from '../../../shared/behaviors/reactions/dispositions';
import type { ReactionDoneMark, ReactionNow, ReactionPick } from '../../../shared/behaviors/reactions/interface';
import type { ReactionJournalInput } from '../reactions/host';
import type { MoodTouchPort, TouchEpisode, TouchFaceEvent, TouchFaceId, TouchFaceView, TouchJournalRow, TouchSpeakOutcome } from '../../../shared/behaviors/touch-response/interface';
import { TOUCH_RESPONSE_KNOBS, type TouchResponseKnobs } from '../../../shared/behaviors/touch-response/knobs';
import { TouchMerger, noteOfTouch, type TouchNote } from '../../../shared/behaviors/touch-response/merge';
import { pickTouchFace, touchFaceView } from '../../../shared/behaviors/touch-response/face';
import { decideTouchSpeech } from '../../../shared/behaviors/touch-response/speak';
import { touchLift } from '../../../shared/behaviors/touch-response/mood';
import { touchWords, type TouchTell } from '../../../shared/behaviors/touch-response/words';

/** The mood host as the brain uses it (electron/mood/mood.ts MoodHost). */
export interface TouchMoodPort {
  get(): MoodView;
  lift(lift: { id: string; delta: Partial<MoodValues>; reason: string; context?: MoodContext; keepReason?: boolean }, characterId?: string): boolean;
  touchAttention(mode: 'capped' | 'free'): boolean;
  touchFaceChanged(): void;
}
export interface TouchTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }

export interface TouchBrainPorts {
  mood(): TouchMoodPort | null;
  /** The character's reaction dispositions (electron/mood/reactions/wiring.ts dispositionsFor). */
  dispositions(view: MoodView): Dispositions;
  /** I-037's reaction host (ReactionHost.touched); absent or null: no reaction. */
  reactions?(): { touched(event: 'click' | 'pull', characterId: string, key: string, body: { part?: TouchPart | null; strength?: number }): ReactionPick | null } | null;
  /** Where the old contacts (pat, pinch, snack) happen now: 'unbound' while she is out (default 'pet'). */
  place?(): TouchPlace;
  journal?(row: TouchJournalRow): void;
  clock?(): number;
  random?(): number;
  timers?: TouchTimers;
  knobs?: Partial<TouchResponseKnobs>;
  makeId?(): string;
}

interface Extra {
  face: TouchFaceId | null;
  faceView: TouchFaceView | null;
  reactions: string[];
  /** How many touches of it she was already told about (0: none). */
  toldCount: number;
  decisions: number;
  spoke: boolean;
  timer: unknown;
  reaction: string | null;
  lifts: number;
}

const SLEEPY = new Set(['light-drowsy', 'drowsy', 'falling-asleep']);
const ASLEEP = new Set(['asleep', 'micro-awake']);
const FACE_EVENTS = new Set<string>(['click', 'pull', 'pinch']);
const REACTION_KIND: Readonly<Record<string, TouchEpisode['kind']>> = { click: 'click', pull: 'pull', pat: 'pat', pinch: 'pinch', feed: 'food' };
/** A proactive line's touch is told while its turn is built (it starts at once; a minute is generous). */
const OFFERED_MS = 60_000;

export class TouchBrain {
  private readonly knobs: TouchResponseKnobs;
  private readonly merger: TouchMerger;
  private readonly extras = new Map<string, Extra>();
  private readonly pinchFaces = new Map<string, { characterId: string; view: TouchFaceView }>();
  private readonly faceMarks = new Map<string, ReactionDoneMark[]>();
  private readonly lastSpoke = new Map<string, number>();
  private pending: { episodeId: string; characterId: string; at: number } | null = null;
  private offered: { episodeId: string; characterId: string; at: number } | null = null;
  private latestFace: { characterId: string; view: TouchFaceView } | null = null;
  private readonly clock: () => number;
  private readonly timers: TouchTimers;
  private disposed = false;
  /** The last few decisions (memory only; closed values), newest first. */
  private readonly decisions: TouchJournalRow[] = [];

  constructor(private readonly ports: TouchBrainPorts) {
    this.knobs = { ...TOUCH_RESPONSE_KNOBS, ...ports.knobs, speak: { ...TOUCH_RESPONSE_KNOBS.speak, ...ports.knobs?.speak }, lift: { ...TOUCH_RESPONSE_KNOBS.lift, ...ports.knobs?.lift } };
    this.merger = new TouchMerger(this.knobs, ports.makeId);
    this.clock = ports.clock ?? Date.now;
    this.timers = ports.timers ?? {
      set: (callback, ms) => { const handle = setTimeout(callback, ms); (handle as { unref?: () => void }).unref?.(); return handle; },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
  private now(): number { const at = this.safe(() => this.clock(), Date.now()); return Number.isFinite(at) ? at : Date.now(); }
  private view(): MoodView | null { return this.safe(() => this.ports.mood()?.get() ?? null, null); }
  private extra(id: string): Extra {
    let extra = this.extras.get(id);
    if (!extra) {
      extra = { face: null, faceView: null, reactions: [], toldCount: 0, decisions: 0, spoke: false, timer: null, reaction: null, lifts: 0 };
      this.extras.set(id, extra);
      while (this.extras.size > 32) {
        const [oldest, old] = this.extras.entries().next().value!;
        if (old.timer !== null) this.timers.clear(old.timer);
        this.extras.delete(oldest);
      }
    }
    return extra;
  }

  /** "She at this moment" for the face and the reactions: her mood numbers, character, sleepiness and recent faces. */
  private reactionNow(view: MoodView, at: number, part: TouchPart | null, strength?: number): ReactionNow {
    const phase = view.fatigue?.phase ?? '';
    return { characterId: view.characterId, dispositions: this.safe(() => this.ports.dispositions(view), {} as Dispositions), mood: view.snapshot.primary,
      sleepy: SLEEPY.has(phase), at, recent: [...(this.faceMarks.get(view.characterId) ?? [])],
      values: { ...view.snapshot.values }, baseline: { ...view.parameters.baseline }, evidence: view.parameters.evidence?.level ?? 1,
      boredom: view.snapshot.boredom, longing: view.snapshot.longing, A: typeof view.fatigue?.A === 'number' ? view.fatigue.A : null,
      ...(part ? { part } : {}), ...(strength !== undefined ? { strength } : {}) };
  }

  private pickFace(event: TouchFaceEvent, view: MoodView, episodeId: string, part: TouchPart | null, at: number, strength?: number): TouchFaceView {
    const pick = pickTouchFace(event, this.reactionNow(view, at, part, strength), { random: this.ports.random, knobs: this.knobs });
    const marks = [...(this.faceMarks.get(view.characterId) ?? []), { id: pick.face, at }].slice(-16);
    this.faceMarks.set(view.characterId, marks);
    return touchFaceView(`touch-${episodeId}`.slice(0, 160), event, pick.face, at, event === 'pinch' ? this.knobs.pinchFaceMs : this.knobs.faceHoldMs, part);
  }

  // ---------------------------------------------------------------- touches in

  /** The sink (electron/mood/touch/sink.ts): one validated touch from Unbound or the companion window. Never throws. */
  touch(event: TouchEvent): void {
    try { this.take(noteOfTouch(event)); } catch { /* A touch is never a reason for an error. */ }
  }

  private take(note: TouchNote): TouchEpisode | null {
    if (this.disposed) return null;
    const view = this.view();
    if (!view?.characterId) return null;
    const at = this.now(), stamped = { ...note, at: Number.isFinite(note.at) && Math.abs(note.at - at) < 60_000 ? note.at : at };
    const { episode, fresh, counted } = this.merger.note(view.characterId, stamped);
    const extra = this.extra(episode.id);
    const asleep = ASLEEP.has(view.fatigue?.phase ?? '');
    if ((episode.kind === 'click' || episode.kind === 'pull') && fresh && view.expressions && !asleep) {
      extra.face = null;
      const face = this.pickFace(episode.kind, view, episode.id, episode.part, at, episode.kind === 'pull' ? episode.strength : undefined);
      extra.face = face.face; extra.faceView = face;
      this.latestFace = { characterId: view.characterId, view: face };
      this.safe(() => this.ports.mood()?.touchFaceChanged(), undefined);
      const pick = this.safe(() => this.ports.reactions?.()?.touched(episode.kind as 'click' | 'pull', view.characterId, episode.id, { part: episode.part,
        ...(episode.kind === 'pull' ? { strength: episode.strength } : {}) }) ?? null, null);
      extra.reaction = pick?.id ?? null;
    }
    // Write back (a click or a pull; the old contacts have their own mood events).
    if (!asleep) {
      const lift = touchLift(episode, { fresh, counted }, this.knobs);
      if (lift) {
        extra.lifts++;
        this.safe(() => this.ports.mood()?.lift({ id: `touch-${episode.id}-${extra.lifts}`.slice(0, 160), delta: lift.delta, reason: lift.reason, context: 'neutral', keepReason: true },
          view.characterId), false);
      }
    }
    if (episode.kind === 'click' || episode.kind === 'pull' || episode.kind === 'pinch') this.schedule(episode, extra);
    return episode;
  }

  /** One roll per merged touch, a little after its last report; once more when it keeps going (repeatAt) and she has not spoken. */
  private schedule(episode: TouchEpisode, extra: Extra): void {
    if (extra.spoke) return;
    if (extra.decisions >= 2 || (extra.decisions === 1 && episode.count < this.knobs.repeatAt)) return;
    if (extra.timer !== null) this.timers.clear(extra.timer);
    const at = this.now();
    const due = Math.max(0, Math.min(episode.lastAt + this.knobs.decideAfterMs, episode.firstAt + this.knobs.decideMaxWaitMs + (extra.decisions ? this.knobs.decideAfterMs : 0)) - at);
    extra.timer = this.timers.set(() => { extra.timer = null; this.safe(() => this.decide(episode.id), undefined); }, due);
  }

  private decide(episodeId: string): void {
    if (this.disposed) return;
    const episode = this.merger.get(episodeId), extra = this.extras.get(episodeId);
    if (!episode || !extra) return;
    extra.decisions++;
    const view = this.view();
    if (!view?.characterId || view.characterId !== episode.characterId) return;
    const phase = view.fatigue?.phase ?? '', at = this.now();
    let outcome: TouchSpeakOutcome, chance: number | undefined;
    if (!view.expressions) outcome = 'off';
    else if (ASLEEP.has(phase)) outcome = 'asleep';
    else {
      const since = this.lastSpoke.get(view.characterId);
      const decision = decideTouchSpeech({ kind: episode.kind, part: episode.part, count: episode.count, strength: episode.strength, heldMs: episode.heldMs,
        values: view.snapshot.values, baseline: view.parameters.baseline, evidence: view.parameters.evidence?.level ?? 1, boredom: view.snapshot.boredom,
        longing: view.snapshot.longing, dispositions: this.safe(() => this.ports.dispositions(view), {} as Dispositions), sleepy: SLEEPY.has(phase), asleep: false,
        sinceSpokeMs: since !== undefined && at >= since ? at - since : null }, this.ports.random ?? Math.random, this.knobs);
      chance = Math.max(0, Math.min(9, Math.floor(decision.chance * 10)));
      outcome = decision.speak ? this.ask(episode, view) : 'quiet';
      if (outcome === 'asked') { extra.spoke = true; this.lastSpoke.set(view.characterId, at); }
    }
    const row: TouchJournalRow = { characterId: view.characterId, kind: episode.kind, part: episode.part, where: episode.where, count: episode.count,
      face: extra.face ?? 'none', reaction: extra.reaction, speak: outcome, ...(chance !== undefined ? { chance } : {}) };
    this.decisions.unshift(row);
    this.decisions.length = Math.min(this.decisions.length, 8);
    this.safe(() => this.ports.journal?.(row), undefined);
  }

  /** One speech cue for this touch: the companion's caps in the companion window, none in Unbound. The opening choice claims it (claims()). */
  private ask(episode: TouchEpisode, view: MoodView): TouchSpeakOutcome {
    const mood = this.ports.mood();
    if (!mood) return 'held';
    this.pending = { episodeId: episode.id, characterId: view.characterId, at: this.now() };
    let ok = false;
    try { ok = mood.touchAttention(episode.where === 'unbound' ? 'free' : 'capped'); } catch { ok = false; }
    // Claimed (claims() took it) means the opening choice handed it on; a cue held for later (you are in a meeting) is not "asked".
    const claimed = this.pending === null;
    this.pending = null;
    return ok && claimed ? 'asked' : 'held';
  }

  // ---------------------------------------------------------------- the mood host's port

  readonly moodPort: MoodTouchPort = {
    started: (kind, session, characterId) => {
      if (kind !== 'pinch' || typeof session !== 'string' || !session) return;
      const view = this.view();
      if (!view?.characterId || view.characterId !== characterId || !view.expressions) return;
      const at = this.now();
      const face = this.pickFace('pinch', view, `pinch-${session}`, 'face', at);
      this.pinchFaces.set(session, { characterId, view: face });
      while (this.pinchFaces.size > 8) this.pinchFaces.delete(this.pinchFaces.keys().next().value!);
    },
    contacted: (kind, at, characterId, session) => {
      if (kind !== 'pat' && kind !== 'pinch' && kind !== 'food') return;
      const view = this.view();
      if (!view?.characterId || view.characterId !== characterId) return;
      const place = this.safe(() => this.ports.place?.() ?? 'pet', 'pet' as TouchPlace);
      const episode = this.take({ kind, part: kind === 'pinch' ? 'face' : kind === 'pat' ? 'head' : null, side: null, where: place === 'unbound' ? 'unbound' : 'pet', at });
      if (!episode) return;
      const extra = this.extra(episode.id);
      if (kind === 'pinch' && session) {
        const face = this.pinchFaces.get(session);
        if (face && face.characterId === characterId) extra.face = face.view.face;
      }
    },
    face: (characterId, now, cheek) => {
      if (cheek) {
        const pinch = this.pinchFaces.get(cheek);
        if (pinch && pinch.characterId === characterId && now < pinch.view.until) return pinch.view;
      }
      const latest = this.latestFace;
      return latest && latest.characterId === characterId && now >= latest.view.at - 1_000 && now < latest.view.until ? latest.view : null;
    },
  };

  /** The reaction journal tap (electron/mood/reactions/wiring.ts played): what she really showed for a body event. */
  reactionPlayed(entry: ReactionJournalInput): void {
    try {
      const kind = REACTION_KIND[entry.event as string];
      if (!kind) return;
      const done = entry.picks.filter(pick => pick.done).map(pick => pick.id);
      if (!done.length) return;
      const episode = this.merger.recent(entry.characterId, this.now() - this.knobs.recentMs).find(item => item.kind === kind);
      if (!episode) return;
      const extra = this.extra(episode.id);
      for (const id of done) if (!extra.reactions.includes(id)) extra.reactions.push(id);
    } catch { /* Remembering never changes a reaction. */ }
  }

  // ---------------------------------------------------------------- telling her

  private tellOf(episode: TouchEpisode): TouchTell {
    const extra = this.extras.get(episode.id);
    return { kind: episode.kind, part: episode.part, count: episode.count, strength: episode.strength, heldMs: episode.heldMs, ended: episode.ended,
      response: episode.response ?? null, steps: episode.steps ?? 0,
      face: extra?.face ?? null, reactions: [...(extra?.reactions ?? [])] };
  }

  /**
   * The chat turn's "用户刚才……" (electron/mood/her-state-host.ts body): the clicks and pulls she was not told about yet (a moment ago), and
   * the pat / pinch / snack the turn tells (`contacts`, already chosen there) with what she showed. '' when there is nothing beyond the
   * contacts' own words (the line is then exactly as before).
   */
  chatWords(contacts: readonly HerContact[], food?: string): string {
    try {
      const view = this.view();
      if (!view?.characterId) return '';
      const now = this.now(), recent = this.merger.recent(view.characterId, now - this.knobs.recentMs);
      const items: { tell: TouchTell; at: number; episode: TouchEpisode | null }[] = [];
      let extraInfo = false;
      for (const episode of recent) {
        if (episode.kind !== 'click' && episode.kind !== 'pull') continue;
        const extra = this.extra(episode.id);
        if (extra.toldCount >= episode.count) continue;
        items.push({ tell: this.tellOf(episode), at: episode.lastAt, episode });
        extraInfo = true;
      }
      for (const contact of contacts) {
        const kind = contact === 'food' ? 'food' : contact;
        const episode = recent.find(item => item.kind === kind) ?? null;
        const tell: TouchTell = episode ? this.tellOf(episode) : { kind };
        if ((tell.face || tell.reactions?.length)) extraInfo = true;
        items.push({ tell, at: episode?.lastAt ?? 0, episode: null });
      }
      if (!extraInfo) return '';
      items.sort((a, b) => b.at - a.at);
      const line = touchWords(items.map(item => item.tell), food, this.knobs);
      for (const item of items) if (item.episode) this.extra(item.episode.id).toldCount = item.episode.count;
      return line;
    } catch { return ''; }
  }

  /** The opening choice's claimant: this speech cue is the one she just asked for to answer a touch. */
  claims(cue: { id?: unknown; kind?: unknown; at?: unknown; source?: unknown } | null | undefined): boolean {
    const pending = this.pending;
    if (!pending || !cue || cue.kind !== 'speech' || cue.source !== undefined) return false;
    this.pending = null;
    this.offered = { ...pending, at: this.now() };
    return true;
  }

  /** The inner loop's 'touch' focus line: what just happened and what she showed (one short sentence; '' when there is none). */
  promptLine(characterId: string): string {
    try {
      const offered = this.offered;
      if (!offered || offered.characterId !== characterId || this.now() - offered.at > OFFERED_MS) return '';
      const episode = this.merger.get(offered.episodeId);
      if (!episode) return '';
      this.extra(episode.id).toldCount = episode.count;
      return touchWords([this.tellOf(episode)], undefined, this.knobs);
    } catch { return ''; }
  }

  /** The last few decisions, newest first (memory only). */
  recent(): readonly TouchJournalRow[] { return this.decisions.map(row => ({ ...row })); }

  dispose(): void {
    this.disposed = true;
    for (const extra of this.extras.values()) if (extra.timer !== null) { this.timers.clear(extra.timer); extra.timer = null; }
  }
}

export function createTouchBrain(ports: TouchBrainPorts): TouchBrain { return new TouchBrain(ports); }
