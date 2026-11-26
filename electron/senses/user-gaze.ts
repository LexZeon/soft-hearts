/**
 * I-081 (docs/claude/2026-11-11-i081-gaze.md): the host side of "she looks at you or at the mouse".
 *
 *  - Keeps the latest checked pose signal's presence, facing, movement, face position and head reading (I-167: which way the head points,
 *    how far away it is; parsePoseSignal already ran) and the
 *    latest screen interest from watch-together's frame description — in memory only, a few seconds; never on disk, never in a
 *    journal line, never sent anywhere but the companion window.
 *  - Answers the companion window's poll (window.desktop.userGaze) with where the user is in her window's pointer units
 *    (shared/behaviors/gaze-attention/geometry.ts), computed from her window's bounds and the display she is on.
 *  - Takes the companion window's attention facts ('gaze'): one closed journal line, and eye contact as a small mood moment — counted only
 *    while pose sensing really says the user is here and facing her (a window cannot make one up).
 * Sensing off forgets everything about the user at once.
 */
import type { PoseFacing, PoseHead, PosePoint, PoseSignal } from '../../shared/senses/pose-signals';
import { userGazePoint, userTurn, type ScreenRect } from '../../shared/behaviors/gaze-attention/geometry';
import { turnTowardWindow } from '../../shared/behaviors/gaze-attention/looking';
import { GAZE_JOURNAL_EVENTS, isScreenInterest, type GazeJournalEvent, type GazeJournalWhy, type ScreenInterest, type UserGazeReading } from '../../shared/behaviors/gaze-attention/interface';
import { GAZE_ATTENTION_KNOBS, type GazeAttentionKnobs } from '../../shared/behaviors/gaze-attention/knobs';
import type { UserAttention } from '../../shared/behaviors/pose-uses/attention';

/** Screen interest stays usable this long after the description that carried it (a still screen gets no new description). */
export const SCREEN_INTEREST_FRESH_MS = 45_000;

/** What the companion window may tell (exact keys, closed words); anything else is refused. */
export interface GazeFact { event: GazeJournalEvent; why?: GazeJournalWhy }
export function parseGazeFact(value: unknown): GazeFact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>, keys = Object.keys(v);
  if (!(GAZE_JOURNAL_EVENTS as readonly unknown[]).includes(v.kind)) return null;
  const event = v.kind as GazeJournalEvent;
  if (event === 'start' || event === 'stop') {
    const allowed: readonly GazeJournalWhy[] = event === 'start' ? ['arrived', 'facing'] : ['left', 'turned', 'off', 'asleep'];
    if (keys.length !== 2 || !allowed.includes(v.why as GazeJournalWhy)) return null;
    return { event, why: v.why as GazeJournalWhy };
  }
  return keys.length === 1 ? { event } : null;
}

export interface GazeFactPorts {
  /** MoodMoments.note('eye-contact'): true when it changed her mood (the gate holds the cooldown). */
  moment(): boolean;
  /** The experience journal (closed words only). */
  record(line: { type: 'gaze'; event: GazeJournalEvent; why?: GazeJournalWhy }): void;
}

export class UserGazeHost {
  private seen: { present: boolean; facing: PoseFacing; energy: number; face: PosePoint | null; head: PoseHead | null; at: number } | null = null;
  private screen: { kind: ScreenInterest; at: number } | null = null;
  /** I-167: whether the head pointed at the window of the latest read (null: its direction was not known), for the eye-contact check. */
  private toward: { ok: boolean | null; at: number } | null = null;
  /** I-189: the pose uses' attention reading (electron/senses/pose-uses/host.ts), added to every answer while known. */
  private attentionSource: (() => UserAttention | null) | null = null;

  constructor(private readonly clock: () => number = Date.now, private readonly knobs: GazeAttentionKnobs['camera'] = GAZE_ATTENTION_KNOBS.camera,
    private readonly looking: GazeAttentionKnobs['looking'] = GAZE_ATTENTION_KNOBS.looking) {}

  /** Every checked pose signal (electron/main.ts onSignal). */
  note(signal: PoseSignal): void {
    const head = signal.head ? { yaw: signal.head.yaw, pitch: signal.head.pitch, distance: signal.head.distance } : null;
    this.seen = { present: signal.present, facing: signal.facing, energy: signal.energy, face: signal.face ? { x: signal.face.x, y: signal.face.y } : null, head, at: this.clock() };
  }

  /** I-189: where the answer's attention reading comes from (the wiring sets it once). */
  setAttention(source: (() => UserAttention | null) | null): void { this.attentionSource = source; }

  /** Pose sensing went on or off; off forgets the user at once. */
  sensing(on: boolean): void { if (!on) { this.seen = null; this.toward = null; } }

  /** Watch-together's frame description said how worth watching the screen is (null: it did not say). */
  screenInterest(kind: unknown): void { this.screen = isScreenInterest(kind) ? { kind, at: this.clock() } : null; }

  private fresh(): NonNullable<UserGazeHost['seen']> | null {
    const seen = this.seen, now = this.clock();
    return seen && now - seen.at >= 0 && now - seen.at <= this.knobs.freshMs ? seen : null;
  }

  /**
   * The user is here and facing her right now, as pose sensing says. I-167: and, when the head's direction is known, it points at her
   * window (or the screen she fills) as of the latest read (looking.ts turnTowardWindow, the leaving edge).
   */
  facingNow(): boolean {
    const seen = this.fresh();
    if (!seen || !seen.present || seen.facing !== 'toward') return false;
    const toward = this.toward, now = this.clock();
    return !(toward && toward.ok === false && now - toward.at >= 0 && now - toward.at <= this.knobs.freshMs);
  }

  /** The companion window's poll: null while pose sensing gives nothing fresh. */
  read(pet: ScreenRect | null | undefined, display: ScreenRect | null | undefined): UserGazeReading | null {
    const seen = this.fresh();
    if (!seen) return null;
    const now = this.clock(), screen = this.screen && now - this.screen.at >= 0 && now - this.screen.at <= SCREEN_INTEREST_FRESH_MS ? this.screen.kind : null;
    const point = seen.present ? userGazePoint(seen.face, display, pet, this.knobs, seen.head) : null;
    const turn = point ? userTurn(seen.head) : null;
    this.toward = { ok: point && turn ? turnTowardWindow(point, turn, this.looking) : null, at: now };
    let attention: UserAttention | null = null;
    try { attention = this.attentionSource?.() ?? null; } catch { attention = null; }
    return { present: seen.present, facing: seen.facing, energy: seen.energy, point, screen, ...(turn ? { turn } : {}), ...(attention && attention.state !== 'unsure' ? { attention } : {}) };
  }

  /** A 'gaze' fact from the companion window. Eye contact reaches her mood only while pose sensing says you face her now. */
  fact(value: unknown, ports: GazeFactPorts): boolean {
    const fact = parseGazeFact(value);
    if (!fact) return false;
    if (fact.event === 'eye-contact') {
      if (!this.facingNow()) return false;
      let counted = false;
      try { counted = ports.moment() === true; } catch { counted = false; }
      // One line per counted moment (the mood gate's cooldown spaces them); an eye contact inside the cooldown is not a new line.
      if (counted) try { ports.record({ type: 'gaze', event: 'eye-contact' }); } catch { /* a record never changes what she does */ }
      return counted;
    }
    try { ports.record({ type: 'gaze', event: fact.event, ...(fact.why ? { why: fact.why } : {}) }); } catch { /* as above */ }
    return true;
  }
}
