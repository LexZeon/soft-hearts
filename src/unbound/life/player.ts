/**
 * Unbound v1 step 4 「她自己的生活」, the page side (docs/claude/2026-11-17-unbound-step4.md): plays the host's plans for her own
 * actions with one player for all of them, and her gaze when it is yours.
 *
 *  - A plan is key frames on a few channels (shared/unbound/life/types.ts: hip, look, tilt, smile, rate). Between keys each channel
 *    moves on S5 (zero speed and acceleration at both ends); what comes out are layer-2 goals, which the intent layer's springs carry
 *    to her bones (src/unbound/intent-layer.ts): nothing here writes a bone, so she never jumps.
 *  - A walk goes to the gait (her place goal): steps, planted feet and braking are the gait's (U1). A walk eased out mid-way stops
 *    where her braking takes her (a goal just ahead along her way), and that is where she stands.
 *  - Easing out (the host's cancel, or the director taking her body): every channel goes from where it is back to rest over the
 *    plan's easeS on S5; never a snap ("禁止只是不开始新的动作，不是定住").
 *  - The idle pause (rate channel, T-248 B1) is handed to the idle layer as its clock rate; a quick move of the idle still going waits
 *    up to waitQuickS, then the pause is skipped.
 *  - `attend` (you are interacting with her, or you face her and she looks back): her gaze is yours, eased in and out, over anything
 *    her own action looks at. The director (a peek, the opening beat before she speaks) owns her whole body while it plays: then this
 *    writes nothing (`suppressed`).
 */
import { LIFE_BODY, LIFE_CHANNELS, LIFE_REST, S5, parseLifeCommand, planEnd, sampleKeys, type LifeChannel, type LifeCommand, type LifePlan, type LifeReport } from '../../../shared/unbound/life/types';
import { REST_TARGETS, type BodySense, type PoseTargets } from '../motion/generator';
import { toHerFrame, type LensView } from '../motion/lens-align';

export interface LifeBody { readonly sense: BodySense | null; setPoseTargets(targets: PoseTargets): void }
export interface LifeFrameWorld { lens: LensView }
/** The figure's state the player reads each frame. */
export interface LifeBodyState { walking: boolean; moving: boolean; heightM: number; placement: { xM: number; depthM: number } }

/** How the attend look comes and goes (s), and how far a walk eased out may still go per m/s of speed (s). */
export const LIFE_PLAYER = Object.freeze({ attendInS: 0.5, attendOutS: 0.8, attendFacing: 0.85, stopLookaheadS: 0.8, arriveM: 0.15, settleS: 0.4 });

type Values = Record<LifeChannel, number>;
const rest = (): Values => ({ ...LIFE_REST });
const S5ramp = (from: number, to: number, u: number) => from + (to - from) * S5(u);

interface Playing {
  id: string;
  plan: LifePlan;
  trial: boolean;
  stage: 'waiting' | 'walking' | 'playing' | 'easing';
  t: number;
  wait: number;
  easeT: number;
  easeFrom: Values;
  values: Values;
  goal: { x: number; z: number } | null;
  settled: number;
}

export class LifePlayer {
  private current: Playing | null = null;
  private attendTarget = 0;
  private attendFrom = 0;
  private attendNow = 0;
  private attendT = 1;
  private attendFull = 1;
  private resting = true;
  private lastRoot: { x: number; z: number } | null = null;
  private velocity = { x: 0, z: 0 };

  /** `known`: the registered action ids; `quickBusy`: a quick move of her idle is under way now. */
  constructor(private readonly known: readonly string[], private readonly report: (report: LifeReport) => void, private readonly quickBusy: () => boolean = () => false) {}

  get active(): boolean { return !!this.current; }
  get action(): string | null { return this.current?.plan.action ?? null; }
  get stage(): Playing['stage'] | null { return this.current?.stage ?? null; }
  /** A walk of hers is under way: the scene's place must not move her meanwhile (the host learns where she stopped). */
  get walking(): boolean { return !!this.current?.goal; }
  /** Her idle's clock rate now (1 = as it plays; the pause brings it to 0 and back). */
  get idleRate(): number { return this.current ? this.current.values.rate : 1; }
  /** I-174 item 1: how much the action playing looks at you now (0..1; the window lays it on its own look, without the attend part). */
  get lookNow(): number { return this.current ? this.current.values.look : 0; }
  /** How much her gaze is yours now (0..1). */
  get attending(): number { return this.attendNow; }

  /**
   * Batch B (docs/claude/2026-11-21-unbound-full-BG.md): you started playing with her (a game, an offer, her reach for your hand): what she
   * does eases out now, a walk brakes to a stop just ahead (the host's arbiter, where playing ranks one under a pull, agrees within its beat).
   */
  yieldNow(): void { this.ease(); }

  /** The host's command (checked again here). */
  command(value: unknown): void {
    const command: LifeCommand | null = parseLifeCommand(value, this.known);
    if (!command) return;
    if (command.type === 'attend') {
      this.attendFrom = this.attendNow; this.attendT = 0;
      this.attendTarget = command.on ? 1 : 0;
      if (command.on) this.attendFull = command.why === 'facing' ? LIFE_PLAYER.attendFacing : 1;
      return;
    }
    if (command.type === 'cancel') { if (this.current?.id === command.id) this.ease(); return; }
    if (this.current) return; // one at a time (the host never sends a second)
    const plan = command.plan;
    this.current = { id: command.id, plan, trial: command.trial, stage: plan.waitQuickS > 0 ? 'waiting' : plan.walk ? 'walking' : 'playing', t: 0, wait: 0, easeT: 0,
      easeFrom: rest(), values: rest(), goal: plan.walk ? { x: plan.walk.xM, z: -plan.walk.depthM } : null, settled: 0 };
    this.send('playing');
  }

  /**
   * One frame, after the director and before her own frame. `suppressed`: the director (or an act) has her body: nothing is written,
   * her own action eases out unseen (so nothing jumps back when the director lets go).
   */
  frame(dt: number, world: LifeFrameWorld, body: LifeBody, state: LifeBodyState, suppressed: boolean): void {
    const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    this.trackVelocity(state, step);
    this.attendT = Math.min(1, this.attendT + step / (this.attendTarget > this.attendFrom ? LIFE_PLAYER.attendInS : LIFE_PLAYER.attendOutS));
    this.attendNow = S5ramp(this.attendFrom, this.attendTarget, this.attendT);
    const p = this.current;
    if (p) {
      if (suppressed && p.stage !== 'easing' && !p.goal) this.ease();
      this.advance(p, step, state);
    }
    if (suppressed) { this.resting = false; return; }
    const playing = this.current;
    const look = Math.max(playing ? playing.values.look : 0, this.attendNow * this.attendFull);
    const quiet = !playing && look < 1e-4;
    if (quiet) { if (!this.resting) { body.setPoseTargets({ ...REST_TARGETS }); this.resting = true; } return; }
    this.resting = false;
    body.setPoseTargets(this.targets(playing, look, world, body.sense, state));
  }

  // ---- inside ---------------------------------------------------------------------------------------------------------------

  private send(phase: LifeReport['phase'], extra: Partial<LifeReport> = {}): void {
    const p = this.current;
    if (!p) return;
    try { this.report({ id: p.id, phase, ...extra }); } catch { /* the host may be gone */ }
  }

  /** Starts easing out from where every channel is now (a walk: a stop just ahead along her way). */
  private ease(): void {
    const p = this.current;
    if (!p || p.stage === 'easing') return;
    if (p.stage === 'waiting') { this.end(true); return; }
    p.easeFrom = { ...p.values }; p.easeT = 0;
    if (p.goal && this.lastRoot) {
      const ahead = LIFE_PLAYER.stopLookaheadS;
      p.goal = { x: this.lastRoot.x + this.velocity.x * ahead, z: this.lastRoot.z + this.velocity.z * ahead };
      p.settled = 0;
    }
    p.stage = 'easing';
    this.send('easing');
  }

  private advance(p: Playing, step: number, state: LifeBodyState): void {
    switch (p.stage) {
      case 'waiting':
        if (!this.quickBusy() || p.wait >= p.plan.waitQuickS) {
          if (this.quickBusy()) { this.end(true); return; } // a quick move would not end in time: this one is skipped, never made up
          p.stage = p.goal ? 'walking' : 'playing';
        }
        p.wait += step;
        return;
      case 'walking':
        if (this.arrived(p, state, step)) { p.stage = 'playing'; this.reportAt(p, state); p.goal = null; }
        return;
      case 'playing':
        p.t += step;
        for (const channel of LIFE_CHANNELS) p.values[channel] = sampleKeys(p.plan.keys, channel, p.t);
        if (p.t >= planEnd(p.plan)) this.end(false);
        return;
      case 'easing': {
        p.easeT += step;
        const u = Math.min(1, p.easeT / Math.max(0.05, p.plan.easeS));
        for (const channel of LIFE_CHANNELS) p.values[channel] = S5ramp(p.easeFrom[channel], LIFE_REST[channel], u);
        const walkDone = !p.goal || this.arrived(p, state, step);
        if (u >= 1 && walkDone) {
          if (p.goal) { this.reportAt(p, state); p.goal = null; }
          this.end(false);
        }
        return;
      }
    }
  }

  /** At the goal (or as near as her steps settle) and standing. */
  private arrived(p: Playing, state: LifeBodyState, step: number): boolean {
    const goal = p.goal;
    if (!goal) return true;
    const near = Math.hypot(state.placement.xM - goal.x, -state.placement.depthM - goal.z) < LIFE_PLAYER.arriveM;
    p.settled = !state.walking && !state.moving ? p.settled + step : 0;
    // Standing still at the goal; or standing still for a long while short of it (the gait could not get closer): over either way.
    return near ? p.settled >= LIFE_PLAYER.settleS : p.settled >= 5 * LIFE_PLAYER.settleS;
  }

  /** Where she stands now, as her gait's goal (the scene then hands the same goal back, so nothing moves her again). */
  private reportAt(p: Playing, _state: LifeBodyState): void {
    if (!p.goal) return;
    this.send(p.stage === 'easing' ? 'easing' : 'playing', { at: { xM: p.goal.x, depthM: -p.goal.z } });
  }

  private end(skipped: boolean): void {
    this.send('done', skipped ? { skipped: true } : {});
    this.current = null;
  }

  private trackVelocity(state: LifeBodyState, step: number): void {
    const root = { x: state.placement.xM, z: -state.placement.depthM };
    if (this.lastRoot && step > 0) {
      const k = Math.min(1, step / 0.15); // a short low-pass: a frame's step is noisy
      this.velocity.x += ((root.x - this.lastRoot.x) / step - this.velocity.x) * k;
      this.velocity.z += ((root.z - this.lastRoot.z) / step - this.velocity.z) * k;
    }
    this.lastRoot = root;
  }

  /** The layer-2 goals for this frame: hips over a foot (the upper body leaning back over them, the head kept level), a tilt, a smile, the look. */
  private targets(p: Playing | null, look: number, world: LifeFrameWorld, sense: BodySense | null, state: LifeBodyState): PoseTargets {
    const v = p?.values ?? rest(), amplitude = p?.plan.amplitude ?? 1;
    const lateral = v.hip * LIFE_BODY.hipM * Math.max(0.5, Math.min(3, state.heightM)) * amplitude, roll = lateral * LIFE_BODY.torsoRollPerM;
    const targets: PoseTargets = {
      ...REST_TARGETS,
      pelvis: { lateral, forward: 0, vertical: 0 },
      torso: { pitch: 0, yaw: 0, roll },
      neck: { pitch: 0, yaw: 0, roll: -0.5 * roll },
      head: { pitch: 0, yaw: 0, roll: -0.3 * roll + v.tilt },
      face: { curious: 0, smile: v.smile, startle: 0 },
      place: p?.goal ?? null,
      walkSpeedMps: p?.goal && p.plan.walk ? p.plan.walk.speedMps : null,
      tempo: 'calm',
    };
    if (look > 1e-3 && sense?.head) {
      const d = toHerFrame({ x: world.lens.camera.x - sense.head.x, y: world.lens.camera.y - sense.head.y, z: world.lens.camera.z - sense.head.z }, sense.root.heading);
      const yaw = Math.atan2(d.x, d.z), pitch = Math.max(-1.2, Math.min(1.2, Math.atan2(-d.y, Math.hypot(d.x, d.z))));
      targets.eyes = { yaw: yaw * look, pitch: pitch * look };
    }
    return targets;
  }
}
