/**
 * Unbound U2 experiment E2, layer 1 in the page: plays one of her own acts (sway, stretch, hop) live, frame by frame, from her
 * body (docs/claude/2026-11-14-unbound-night-e2-autonomy.md). What to do and when is the autonomy planner's
 * (shared/unbound/autonomy/choose.ts); how the body moves is layer 2 (motion/own-moves.ts through the generator) and layer 3 (the
 * intent layer's springs, the gait's hop). This never writes a bone.
 *
 * Off by default: only the preview (and the tests) start an act; the page exposes it on its probe, nothing in the app calls it.
 *
 * Cancel ("禁止只是不开始新的动作，不是定住"): the act stops asking for more and hands rest targets to the springs, which bring her
 * back; a hop already in the air finishes its flight and its landing first (gravity is not cancellable). She reports the end with
 * whether it completed and whether she nearly lost her balance (her COM within a hair of, or outside, her support) — the
 * autonomy writer's two inputs.
 */
import { REST_TARGETS, type BodySense, type MotionGenerator, type MotionIntent, type PoseTargets } from '../motion/generator';
import { stretchDuration, swayDuration } from '../motion/own-moves';
import type { HopPhase, HopRequest } from '../gait';

export const BODY_ACTS = ['sway', 'stretch', 'hop'] as const;
export type BodyAct = (typeof BODY_ACTS)[number];
export interface ActPlan { act: BodyAct; /** 0.5..1 */ amplitude: number; /** 0..1 */ liveliness: number; /** 0..1 */ seed: number }
export interface ActBody { readonly sense: BodySense | null; setPoseTargets(targets: PoseTargets): void; readonly intentIdle: boolean }
export interface ActEnd { act: BodyAct; completed: boolean; wobble: boolean; minMarginM: number | null; seconds: number }
/** What the act is doing now (for the preview's screenshots and the developer line). */
export type ActBeat = 'sway' | 'ready' | 'up' | 'hold' | 'down' | HopPhase | 'after' | 'settle' | 'winding';

export const ACT_PLAYER = Object.freeze({
  /** Her COM this close to the edge of her support (m) or outside it: she nearly lost her balance. */
  wobbleMarginM: 0.005,
  /** The hop: a moment of getting ready before the crouch, and after the landing (s); how long to wait for the gait to take it. */
  hopReadyS: 0.3, hopAfterS: 1.0, hopTakeS: 0.5,
  /** Settling back to rest after an act (or a cancel) takes at most this long (s). */
  settleMaxS: 4,
  /** Hop size from amplitude and liveliness: apex (m), crouch (m), the soft gravity (m/s²). */
  hop: { height: [0.04, 0.08] as const, crouch: [0.045, 0.065] as const, gravity: 6.5 },
  /** Sway: 3 cycles at 0.42–0.54 Hz (livelier → quicker). */
  sway: { cycles: 3, hz: [0.42, 0.54] as const },
});

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

export class ActPlayer {
  private plan: ActPlan | null = null;
  private t = 0;
  private stage: 'playing' | 'settling' = 'playing';
  private settleSince = 0;
  private cancelled = false;
  private minMargin: number | null = null;
  private hop: { request: HopRequest | null; started: boolean; endedAt: number | null } = { request: null, started: false, endedAt: null };
  private nextHopId = 1;
  private currentBeat: ActBeat | null = null;

  constructor(private readonly generator: MotionGenerator, private readonly onEnd?: (end: ActEnd) => void) {}

  get active(): boolean { return !!this.plan; }
  get act(): BodyAct | null { return this.plan?.act ?? null; }
  get beat(): ActBeat | null { return this.currentBeat; }
  get time(): number { return this.t; }

  /** Starts an act (false while one is playing or the plan is not one it knows). */
  start(plan: ActPlan): boolean {
    if (this.plan || !plan || !(BODY_ACTS as readonly string[]).includes(plan.act)) return false;
    const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
    this.plan = { act: plan.act, amplitude: c(plan.amplitude, 0.5, 1), liveliness: c(plan.liveliness, 0, 1), seed: c(plan.seed, 0, 1) };
    this.t = 0; this.stage = 'playing'; this.cancelled = false; this.minMargin = null; this.currentBeat = null;
    this.hop = { request: null, started: false, endedAt: null };
    this.generator.reset();
    return true;
  }

  /** Winds the act down (never a freeze: the springs bring her back; a hop in the air lands first). */
  cancel(): void {
    if (!this.plan || this.stage !== 'playing') return;
    this.cancelled = true;
    this.settle();
  }

  frame(dt: number, body: ActBody): void {
    const plan = this.plan;
    if (!plan) return;
    const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    this.t += step;
    const sense = body.sense;
    if (sense?.comMargin !== undefined && sense.comMargin !== null) this.minMargin = this.minMargin === null ? sense.comMargin : Math.min(this.minMargin, sense.comMargin);
    const intent = this.stage === 'playing' ? this.playing(plan, sense) : this.settling(plan, sense);
    if (sense && intent) body.setPoseTargets(this.generator.generate({ intent, t: this.stage === 'playing' ? this.t : this.t - this.settleSince, dt: step, sense }));
    else if (!intent) body.setPoseTargets({ ...REST_TARGETS });
    if (this.stage === 'settling' && !this.hopInAir(sense) && (body.intentIdle || this.t - this.settleSince > ACT_PLAYER.settleMaxS)) this.finish(plan, body);
  }

  private settle(): void { this.stage = 'settling'; this.settleSince = this.t; }
  private hopInAir(sense: BodySense | null): boolean { return this.plan?.act === 'hop' && this.hop.started && !!sense?.hop?.phase; }

  /** The intent for this frame while the act plays (null: rest). Moves to settling at the act's own end. */
  private playing(plan: ActPlan, sense: BodySense | null): MotionIntent | null {
    const side: 1 | -1 = plan.seed < 0.5 ? 1 : -1;
    switch (plan.act) {
      case 'sway': {
        const hz = lerp(ACT_PLAYER.sway.hz[0], ACT_PLAYER.sway.hz[1], plan.liveliness), cycles = ACT_PLAYER.sway.cycles;
        const T = swayDuration({ hz, cycles });
        this.currentBeat = 'sway';
        if (this.t >= T) { this.settle(); return null; }
        return { kind: 'sway', amplitude: plan.amplitude, hz, cycles, side, blinkAt: T * (0.35 + 0.3 * plan.seed) };
      }
      case 'stretch': {
        const T = stretchDuration(), b = [0.35, 0.35 + 1.05, 0.35 + 1.05 + 1.3, 0.35 + 1.05 + 1.3 + 1.0];
        this.currentBeat = this.t < b[0] ? 'ready' : this.t < b[1] ? 'up' : this.t < b[2] ? 'hold' : this.t < b[3] ? 'down' : 'settle';
        if (this.t >= T) { this.settle(); return null; }
        return { kind: 'stretch', amplitude: plan.amplitude, side };
      }
      case 'hop': {
        const H = { ...ACT_PLAYER.hop, hopReadyS: ACT_PLAYER.hopReadyS, hopTakeS: ACT_PLAYER.hopTakeS, hopAfterS: ACT_PLAYER.hopAfterS }, phase = sense?.hop?.phase ?? null;
        if (this.t >= H.hopReadyS && !this.hop.request) {
          const k = plan.amplitude * (0.5 + 0.5 * plan.liveliness);
          this.hop.request = { id: this.nextHopId++, heightM: lerp(H.height[0], H.height[1], k), crouchM: lerp(H.crouch[0], H.crouch[1], k), gravity: H.gravity };
        }
        if (phase && this.hop.request && sense?.hop?.id === this.hop.request.id) this.hop.started = true;
        let beat: Extract<MotionIntent, { kind: 'hop' }>['phase'] = 'ready';
        if (this.hop.started && phase) beat = phase;
        else if (this.hop.started) { this.hop.endedAt ??= this.t; beat = 'after'; }
        else if (this.hop.request && this.t > H.hopReadyS + H.hopTakeS) { this.settle(); return null; } // the gait did not take it (she was moving)
        this.currentBeat = beat;
        if (this.hop.endedAt !== null && this.t - this.hop.endedAt >= H.hopAfterS) { this.settle(); return null; }
        return { kind: 'hop', amplitude: plan.amplitude, request: this.hop.request, phase: beat };
      }
    }
  }

  /** After the act or a cancel: rest, except that a hop in the air keeps its hop goal until it has landed. */
  private settling(plan: ActPlan, sense: BodySense | null): MotionIntent | null {
    if (this.hopInAir(sense)) { this.currentBeat = sense!.hop!.phase; return { kind: 'hop', amplitude: plan.amplitude, request: this.hop.request, phase: sense!.hop!.phase! }; }
    this.currentBeat = this.cancelled ? 'winding' : 'settle';
    return { kind: 'rest' };
  }

  private finish(plan: ActPlan, body: ActBody): void {
    this.plan = null;
    this.currentBeat = null;
    body.setPoseTargets({ ...REST_TARGETS });
    const completed = !this.cancelled && (plan.act !== 'hop' || this.hop.endedAt !== null);
    const end: ActEnd = { act: plan.act, completed, wobble: this.minMargin !== null && this.minMargin < ACT_PLAYER.wobbleMarginM, minMarginM: this.minMargin, seconds: this.t };
    try { this.onEnd?.(end); } catch { /* the listener's problem */ }
  }
}
