// I-189: the host side of what the local pose signals are used for. Fed every checked pose signal (electron/wiring/senses-wiring.ts onSignal)
// and the one-second clock; owns no timer, keeps numbers and closed words only, and forgets everything when sensing goes off.
//  #1, #2  attention(): toward / turned / gone / unsure and for how long (the windows pause her reading, hold barge-in; userGaze carries it);
//  #3      a nod or shake right after her yes/no question becomes the user's answer (answer port), and that turn gets one private line;
//  #4-#6   moment(): slumped / close, staring, looking away after staring, sitting long: handed to the moments host (I-188 gates) as facts;
//  #6      chatTurn(): today's sitting numbers only when the user's own message asks about sitting;
//  #7      chatTurn(): "画面里好像还有一个人" once per confirmed episode: a fixed sentence, nothing from the frame.
// Nothing here calls Claude, sends a picture or words a reaction for her.
import {
  AttentionTracker, asksAboutSitting, asksYesNo, gestureTurnNote, gestureTurnText, HeadGestureDetector, parsePoseUseFact, PeopleWatch, POSE_USES_KNOBS, PostureWatch,
  SittingClock, sittingNote, StareWatch, twoPeopleNote, unheardRestNote, type HeadGesture, type PoseSignal, type PoseUse, type PoseUseEvent, type PoseUsesKnobs, type UserAttention,
} from '../../../shared/senses';

type Language = 'zh-CN' | 'en';

/** One closed journal line (shared/senses/journal-entries.ts 'pose-use'). */
export interface PoseUseRow { use: PoseUse; event: PoseUseEvent; seconds?: number }

/** What the moments host gets (structurally its PoseMomentCandidate): a kind and numbers. */
export interface PoseMomentFacts {
  readonly kind: 'posture' | 'staring' | 'staring-away' | 'sitting';
  readonly facts: { readonly posture?: 'slumped' | 'close'; readonly minutes?: number; readonly awaySeconds?: number; readonly todayMinutes?: number; readonly standUps?: number };
}

export interface PoseUsesPorts {
  clock?(): number;
  knobs?: PoseUsesKnobs;
  /** The local day (so "today" and the daily caps restart at midnight). */
  dayKey(now: number): string;
  language(): Language;
  /** Her newest line in the open conversation (finished; with when it was written), or null. Read on the clock, never per frame. */
  herLine(): { text: string; at: number } | null;
  /** A chat turn is under way, or her voice is sounding (the answer window stays open while she still reads her question). */
  herBusy(): boolean;
  /** #3 may send now: chat available, not typing, no call, no turn running. */
  canAnswer(): boolean;
  /** #3: send `text` as the user's turn (the control window's own chat box path). True when it was handed over. */
  answer(text: string): boolean;
  journal?(row: PoseUseRow): void;
}

const FRESH_MS = 3_000;
const TICK_MS = 1_000;
const GESTURE_TURN_MS = 20_000;

export class PoseUsesHost {
  private readonly knobs: PoseUsesKnobs;
  private readonly attentionTracker: AttentionTracker;
  private readonly gestures: HeadGestureDetector;
  private readonly sitting: SittingClock;
  private readonly stare: StareWatch;
  private readonly posture: PostureWatch;
  private readonly people: PeopleWatch;
  private lastSignal: { at: number; present: boolean } | null = null;
  private line: { text: string; at: number; yesNo: boolean } | null = null;
  private busy = false;
  private quietSince = -Infinity;
  private readonly answered = new Set<number>();
  private sentGesture: { gesture: HeadGesture; at: number; text: string } | null = null;
  private lastTick = -Infinity;
  private blockedAt = -Infinity;
  /** #1: her last reading ended unheard because the user stayed away (the window said so); her next turn gets one line. */
  private unheard = false;

  constructor(private readonly ports: PoseUsesPorts) {
    this.knobs = ports.knobs ?? POSE_USES_KNOBS;
    this.attentionTracker = new AttentionTracker(this.knobs.attention);
    this.gestures = new HeadGestureDetector(this.knobs.nod);
    this.sitting = new SittingClock(this.knobs.sitting);
    this.stare = new StareWatch(this.knobs.staring);
    this.posture = new PostureWatch(this.knobs.posture);
    this.people = new PeopleWatch(this.knobs.people);
  }

  /** Every checked pose signal (parsePoseSignal already ran). */
  note(signal: PoseSignal): void {
    const now = this.now(), day = this.read(() => this.ports.dayKey(now), '');
    this.lastSignal = { at: now, present: signal.present };
    if (!(now - this.lastTick < TICK_MS)) { this.lastTick = now; this.tick(); } // her line and busy state, at most once a second, only while signals come
    this.attentionTracker.note(signal, now);
    this.sitting.note(signal, now, day);
    this.stare.note(signal, now, day);
    this.posture.note(signal, now, day);
    this.people.note(signal, now);
    this.gesture(signal, now);
  }

  /** Pose sensing went on or off; off forgets everything about the user at once. */
  sensing(on: boolean): void {
    if (on) return;
    this.lastSignal = null; this.attentionTracker.forget(); this.gestures.reset();
    this.sitting.forget(); this.stare.forget(); this.posture.forget(); this.people.forget();
  }

  /** Her newest line and whether she is still busy with it (from note(), at most once a second; only while the user is in front). */
  tick(): void {
    const now = this.now();
    const busy = this.read(() => this.ports.herBusy() === true, false);
    if (this.busy && !busy) this.quietSince = now;
    this.busy = busy;
    if (!this.fresh(now) || !this.lastSignal?.present) { this.line = null; return; }
    const line = this.read(() => this.ports.herLine(), null);
    if (!line || typeof line.text !== 'string' || !Number.isFinite(line.at)) { this.line = null; return; }
    if (this.line?.at !== line.at || this.line.text !== line.text) this.line = { text: line.text, at: line.at, yesNo: safeAsks(line.text) };
  }

  /** #1, #2: what the windows get (userGaze carries it). */
  attention(): UserAttention { return this.attentionTracker.read(this.now()); }

  /** #3: the answer window is open now (her latest line asked yes/no; within windowSeconds after she was done with it). */
  answerOpen(now = this.now()): boolean {
    const line = this.line;
    if (!line || !line.yesNo || this.answered.has(line.at) || now < line.at) return false;
    if (this.busy) return false; // she is still talking or reading: a nod now is listening, not an answer
    return now - Math.max(line.at, this.quietSince) <= this.knobs.nod.windowSeconds * 1000;
  }

  /** #4-#6: one fact for the moments host, or null. Taking it counts it (each watcher has its own caps). */
  moment(now = this.now()): PoseMomentFacts | null {
    if (!this.fresh(now)) return null;
    const sat = this.sitting.take(now);
    if (sat) return { kind: 'sitting', facts: { minutes: sat.minutes, todayMinutes: sat.todayMinutes, standUps: sat.standUps } };
    const posture = this.posture.take(now);
    if (posture) return { kind: 'posture', facts: { posture: posture.posture, minutes: posture.minutes } };
    const stare = this.stare.take(now);
    if (stare?.kind === 'staring') return { kind: 'staring', facts: { minutes: stare.minutes } };
    if (stare?.kind === 'away') return { kind: 'staring-away', facts: { minutes: stare.minutes, awaySeconds: stare.awaySeconds } };
    return null;
  }

  /** The chat turn's private lines from pose ('' when there is nothing): the gesture note, two people (once), sitting when asked. */
  chatTurn(text: unknown): string {
    const now = this.now(), language = this.read(() => this.ports.language(), 'zh-CN' as Language), lines: string[] = [];
    const sent = this.sentGesture;
    if (sent && now - sent.at <= GESTURE_TURN_MS && typeof text === 'string' && text.trim() === sent.text) { this.sentGesture = null; lines.push(gestureTurnNote(sent.gesture, language)); }
    if (this.unheard) { this.unheard = false; lines.push(unheardRestNote(language)); }
    if (this.fresh(now) && this.people.take()) { lines.push(twoPeopleNote(language)); this.journal({ use: 'two-people', event: 'told' }); }
    if (asksAboutSitting(text)) {
      const note = this.lastSignal ? sittingNote(this.sitting.facts(now), language) : '';
      if (note) { lines.push(note); this.journal({ use: 'sitting-asked', event: 'told' }); }
    }
    return lines.join('\n');
  }

  /**
   * A window's fact about #1 or #2 (noteJournalFact 'pose-use'): closed words and seconds, journalled as they are; a reading that ended
   * because the user stayed away also gives her next turn one line. Anything else (or another use) is refused.
   */
  fact(value: unknown): boolean {
    const fact = parsePoseUseFact(value);
    if (!fact || (fact.use !== 'read-pause' && fact.use !== 'barge-hold')) return false;
    if (fact.use === 'read-pause' && !['paused', 'resumed', 'ended'].includes(fact.event)) return false;
    if (fact.use === 'barge-hold' && fact.event !== 'held') return false;
    if (fact.use === 'read-pause' && fact.event === 'ended') this.unheard = true;
    this.journal(fact);
    return true;
  }

  // ---------------------------------------------------------------- inside

  private gesture(signal: PoseSignal, now: number): void {
    // Only while the window is open and the user faces the screen; anything else clears what was half seen.
    // Never while typing, in a call, or a moment after: that is the user doing something else (canAnswer), and it does not use up her question.
    if (!this.readyToAnswer(now)) { this.gestures.reset(); return; }
    if (!this.answerOpen(now) || !signal.present || signal.facing !== 'toward' || signal.facingConfidence < this.knobs.nod.facingConfidence) { this.gestures.reset(); return; }
    const gesture = this.gestures.push(signal.points, now);
    if (!gesture) return;
    const line = this.line;
    if (!line) return;
    this.answered.add(line.at);
    if (this.answered.size > 32) this.answered.delete(this.answered.values().next().value!);
    const text = gestureTurnText(gesture, this.read(() => this.ports.language(), 'zh-CN' as Language));
    this.sentGesture = { gesture, at: now, text };
    const sentOk = this.read(() => this.ports.answer(text) === true, false);
    if (!sentOk) { this.sentGesture = null; this.journal({ use: 'nod', event: 'not-sent' }); return; }
    this.journal({ use: 'nod', event: gesture });
  }

  /** canAnswer() held at every frame for quietAfterMs (typing, a call or a running turn ended at least that long ago). */
  private readyToAnswer(now: number): boolean {
    if (!this.read(() => this.ports.canAnswer() === true, false)) { this.blockedAt = now; return false; }
    return now - this.blockedAt >= this.knobs.nod.quietAfterMs;
  }
  private fresh(now: number): boolean { const s = this.lastSignal; return !!s && now - s.at >= 0 && now - s.at <= (s.present ? FRESH_MS : this.knobs.attention.absentFreshMs); }
  private journal(row: PoseUseRow): void { try { this.ports.journal?.(row); } catch { /* the journal never changes what happens */ } }
  private read<T>(get: () => T, fallback: T): T { try { return get(); } catch { return fallback; } }
  private now(): number { try { const value = (this.ports.clock ?? Date.now)(); return Number.isFinite(value) ? value : Date.now(); } catch { return Date.now(); } }
}

function safeAsks(text: string): boolean { try { return asksYesNo(text); } catch { return false; } }
