/**
 * Unbound night experiment E3 (docs/claude/2026-11-14-unbound-night-e3-speech.md): the first step of "talking while her body
 * moves". When her reply is about to show, she looks at you first (eyes, then head, then shoulders), holds that half a beat, and
 * the bubble appears as she gives one small nod; then her own idle again. Experimental, off by default, Unbound only.
 *
 * Layer 1 only: this decides what and when, as an `address` intent (look weights per group, the nod's pitch shaped in time). The
 * procedural generator (layer 2) turns it into targets and the intent layer's springs (layer 3) carry them; blinks are not touched
 * (the address targets carry blink 0 and the figure's own blink runs on top as before).
 *
 * Interruptions never stop her where she is ("禁止只是不开始新的动作，不是定住"): the bubble is let out at once and every weight
 * eases from where it is to nothing over a short release; the springs take her back to her idle.
 *
 * Numbers: Codex T-246a S02 (450 ms before the bubble) and S03 (head 10°, neck 2°, upper body 2°; 180 ms down, 120 ms hold, 350 ms
 * back), both chosen on still frames only; the rest are first picks.
 */
import type { UnboundBubble } from '../../../shared/unbound/scene';
import type { BodySense, MotionIntent, Tempo } from '../motion/generator';
import { toHerFrame, type LensView } from '../motion/lens-align';

const DEG = Math.PI / 180;
export const SPEECH_BEAT = Object.freeze({
  /** After the eyes (which go at once): the head starts this much later, the shoulders this much (s). */
  headLagS: 0.06, shoulderLagS: 0.16,
  /** Each group's weight eases in over this long once it starts (s; its spring smooths it further). */
  onsetS: 0.12,
  /**
   * The turn itself (s): longer the farther she has to turn (per degree of the angle from her head to the lens), at most `turnMaxS`;
   * about nothing when she already faces you. Then the pause: her eyes and head on you and still (s; S02's shorter trial baseline,
   * 450 ms). The bubble comes after both.
   */
  turnPerDegS: 0.01, turnMaxS: 0.35, pauseS: 0.45,
  /** The nod, from the bubble on (s, rad). */
  nod: Object.freeze({ downS: 0.18, holdS: 0.12, upS: 0.35, head: 10 * DEG, neck: 2 * DEG, torso: 2 * DEG }),
  /** After the bubble she keeps her eyes on you while the reply streams: at least this long, at most this long (s). */
  talkMinS: 1.0, talkMaxS: 8,
  /** Back to her idle: the after-glow (s, S02's 800 ms); after an interruption, quicker. */
  afterglowS: 0.8, interruptS: 0.35,
  /** Safety: the bubble is never held longer than this (ms, wall clock: frames may stop while the window is hidden). */
  bubbleCapMs: 1_100,
  /**
   * Spring tempo from the turn to the end of the talk (one tempo, so no retune while she moves: a retune changes acceleration);
   * calm for the release (the springs are at rest when it starts), so the after-glow is slow.
   */
  tempo: 'address' as Tempo,
});

export type SpeechBeatPhase = 'turn' | 'pause' | 'nod' | 'talk' | 'release' | 'done';
/** input: you moved the mouse, clicked or scrolled; hidden: her window went away (a full-screen program); reply: another reply; peek: a peek took over. */
/** 'pull': a large pull on her (2026-11-23: the mouse moving no longer winds it down). */
export type SpeechInterrupt = 'input' | 'hidden' | 'reply' | 'peek' | 'pull';
/** Why a reply got no opening beat: the switch is off, one is already playing, she is walking (or her body is not measured yet), or a peek is on. */
export type SpeechSkip = 'off' | 'busy' | 'moving' | 'peek';

const S5 = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 + x * (-15 + 6 * x)); };
/** The nod's shape 0..1 at `t` s into it: down on a quintic, a short hold, back on a quintic (zero speed at every key). */
export function nodCurve(t: number): number {
  const { downS, holdS, upS } = SPEECH_BEAT.nod;
  if (t <= 0 || t >= downS + holdS + upS) return 0;
  if (t < downS) return S5(t / downS);
  if (t < downS + holdS) return 1;
  return 1 - S5((t - downS - holdS) / upS);
}
export const NOD_S = SPEECH_BEAT.nod.downS + SPEECH_BEAT.nod.holdS + SPEECH_BEAT.nod.upS;

/** How long the turn takes (s): by the angle from her head to the lens (her frame), none when she already faces you or is not measured. */
export function turnSecondsFor(lens: LensView, sense: Pick<BodySense, 'head' | 'root'> | null): number {
  if (!sense?.head) return 0;
  const d = toHerFrame({ x: lens.camera.x - sense.head.x, y: lens.camera.y - sense.head.y, z: lens.camera.z - sense.head.z }, sense.root.heading);
  const degrees = Math.hypot(Math.atan2(d.x, d.z), Math.atan2(-d.y, Math.hypot(d.x, d.z))) * 180 / Math.PI;
  return Math.min(SPEECH_BEAT.turnMaxS, Math.max(0, degrees * SPEECH_BEAT.turnPerDegS));
}

interface Weights { eyes: number; head: number; torso: number; nod: number }
const ZERO: Readonly<Weights> = Object.freeze({ eyes: 0, head: 0, torso: 0, nod: 0 });

export class SpeechBeat {
  /** The experiment switch (developer panel / preview); off: begin() never starts anything. */
  enabled = false;
  private state: SpeechBeatPhase | null = null;
  private t = 0;
  private since = 0;
  private bubbleAt: number | null = null;
  private from: Weights = { ...ZERO };
  private now: Weights = { ...ZERO };
  private releaseS: number = SPEECH_BEAT.afterglowS;
  private fresh = false;
  private turnS = 0;
  interrupted: SpeechInterrupt | null = null;
  replyId: string | null = null;
  lastSkip: SpeechSkip | null = null;
  /** Wall-clock-free log for the developer view and tests: when each phase began (beat seconds). */
  readonly phases: { phase: SpeechBeatPhase; at: number }[] = [];

  get active(): boolean { return this.state !== null && this.state !== 'done'; }
  get phase(): SpeechBeatPhase | null { return this.state; }
  /** Beat seconds since it began. */
  get clock(): number { return this.t; }
  /** Her bubble waits (only during the turn and the pause of the reply it began for). */
  holds(replyId: string): boolean { return (this.state === 'turn' || this.state === 'pause') && this.replyId === replyId; }
  /** When the bubble was let out (beat seconds), or null. */
  get bubbleTime(): number | null { return this.bubbleAt; }

  /** A reply's first words. Starts the beat when it may; otherwise says why not (the reply shows at once, as without the beat). */
  begin(replyId: string | null, body: { ready: boolean; moving: boolean }, peek: boolean): boolean {
    const skip: SpeechSkip | null = !this.enabled ? 'off' : peek ? 'peek' : this.active ? 'busy' : !body.ready || body.moving ? 'moving' : null;
    if (skip) { this.lastSkip = skip; return false; }
    this.lastSkip = null;
    this.state = 'turn'; this.t = 0; this.since = 0; this.bubbleAt = null; this.interrupted = null; this.replyId = replyId; this.fresh = true; this.turnS = 0;
    this.from = { ...ZERO }; this.now = { ...ZERO }; this.phases.length = 0; this.phases.push({ phase: 'turn', at: 0 });
    return true;
  }

  /** Clean wind-down from wherever she is: the bubble goes out now, the weights ease to nothing. */
  interrupt(reason: SpeechInterrupt): void {
    if (!this.active || this.state === 'release' && this.interrupted) return;
    this.interrupted = reason;
    if (this.bubbleAt === null) this.bubbleAt = this.t;
    this.release(SPEECH_BEAT.interruptS);
  }

  /** The turn's own length this time (s), from how far she had to turn when it began. */
  get turnSeconds(): number { return this.turnS; }

  /**
   * One frame: the intent for it (null when the beat is over). `speaking`: her reply is still streaming. `sense`: her body now
   * (the first frame reads from it how far she has to turn).
   */
  next(dt: number, speaking: boolean, lens: LensView, sense: BodySense | null = null): MotionIntent | null {
    if (!this.active) return null;
    // The cue came in between frames: the first frame after it shows the beat's start (its dt was spent before the cue).
    if (this.fresh) { this.fresh = false; this.turnS = turnSecondsFor(lens, sense); }
    else this.t += Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    const B = SPEECH_BEAT, beat = this.t - this.since;
    let tempo: Tempo = B.tempo;
    switch (this.state) {
      case 'turn': {
        if (beat >= this.turnS) { this.go('pause'); return this.next(0, speaking, lens); }
        this.now = this.full(0);
        break;
      }
      case 'pause': {
        if (beat >= B.pauseS) { this.go('nod'); this.bubbleAt = this.t; return this.next(0, speaking, lens); }
        this.now = this.full(0);
        break;
      }
      case 'nod': {
        if (beat >= NOD_S) { this.go('talk'); return this.next(0, speaking, lens); }
        this.now = this.full(nodCurve(beat));
        break;
      }
      case 'talk': {
        const since = this.t - (this.bubbleAt ?? 0);
        if ((!speaking && since >= B.talkMinS) || since >= B.talkMaxS) { this.release(B.afterglowS); return this.next(0, speaking, lens); }
        this.now = this.full(0);
        break;
      }
      case 'release': {
        tempo = 'calm';
        const k = 1 - S5(beat / this.releaseS);
        this.now = { eyes: this.from.eyes * k, head: this.from.head * k, torso: this.from.torso * k, nod: this.from.nod * k };
        if (beat >= this.releaseS) { this.go('done'); this.now = { ...ZERO }; return null; }
        break;
      }
    }
    const N = B.nod, w = this.now;
    return { kind: 'address', lens, look: { eyes: w.eyes, head: w.head, torso: w.torso }, nod: { head: N.head * w.nod, neck: N.neck * w.nod, torso: N.torso * w.nod }, tempo };
  }

  /** The look weights now (eyes at once; head and shoulders after their lags, eased in), with this nod value. */
  private full(nod: number): Weights {
    const B = SPEECH_BEAT, onset = (lag: number) => S5((this.t - lag) / B.onsetS);
    return { eyes: 1, head: onset(B.headLagS), torso: onset(B.shoulderLagS), nod };
  }
  private release(seconds: number): void { this.from = { ...this.now }; this.releaseS = seconds; this.go('release'); }
  private go(phase: SpeechBeatPhase): void { this.state = phase; this.since = this.t; this.phases.push({ phase, at: this.t }); }
}

/**
 * Holds her bubble during the turn and lets it out when the beat says (or after `bubbleCapMs` at the latest, wall clock). Off,
 * or for any reply the beat did not begin for, every event passes straight through, unchanged and in order.
 */
export class SpeechBubbleGate {
  private held: UnboundBubble[] = [];
  private timer: unknown = null;
  constructor(private readonly beat: SpeechBeat, private readonly sink: (bubble: UnboundBubble) => void,
    private readonly timers: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void } = {
      set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }) {}

  get holding(): number { return this.held.length; }

  /** An event from the host (after the director has seen its cue). */
  receive(bubble: UnboundBubble): void {
    if (this.held.length && bubble.id !== this.beat.replyId) { this.beat.interrupt('reply'); this.flush(); }
    if (this.beat.holds(bubble.id)) {
      this.held.push(bubble);
      this.timer ??= this.timers.set(() => { this.timer = null; this.beat.interrupt('hidden'); this.flush(); }, SPEECH_BEAT.bubbleCapMs);
      return;
    }
    this.flush();
    this.sink(bubble);
  }

  /** Every frame (after the director's): lets the bubble out once the beat no longer holds it. */
  poll(): void { if (this.held.length && !(this.beat.replyId !== null && this.beat.holds(this.beat.replyId))) this.flush(); }

  flush(): void {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    const out = this.held; this.held = [];
    for (const bubble of out) this.sink(bubble);
  }
}
