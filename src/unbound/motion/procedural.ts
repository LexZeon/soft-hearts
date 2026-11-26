/**
 * Unbound U2, layer 2: the procedural generator (one implementation of MotionGenerator, generator.ts). Kept modest on purpose:
 * the user wants a trained motion model here eventually (Codex T-246e); this one computes what the peek needs on the spot.
 *
 *  - notice / walk: look at the lens (the whole look; the figure's eye-head coordinator splits it between eyes, head and body).
 *  - lens-eye: lean the upper body (feed-forward, with the head pitched back by about the same so her face stays toward you), a
 *    curious tilt, and a closed loop that measures where her chosen eye actually is each frame and moves her hips (and her toes,
 *    when the lens is higher than her eyes) until that eye sits on the axis at the asked distance. The loop's outputs are targets
 *    like everything else: the figure's springs still decide how fast she gets there.
 *  - back: upright, toes down, the loop let go; startled (a short head pull and wide eyes) or with an after-smile; then home.
 */
import { REST_TARGETS, ZERO_ROT, type MotionGenerator, type MotionIntent, type MotionRequest, type PoseTargets, type Tempo } from './generator';
import { eyePoint, onAxis, toHerFrame, type LensView, type V3 } from './lens-align';
import { hopTargets, stretchTargets, swayTargets } from './own-moves';
import { ShowcaseMotion } from './showcase-motion';
import { Spring, substeps } from '../dynamics';
import { TEMPO } from '../intent-layer';
import { ARRIVAL_LOOP, ArrivalLoop } from '../../../shared/unbound/arrival'; // I-192: the peek's loop, shared with the kiss and the hug

/**
 * E3 address (docs/claude/2026-11-14-unbound-night-e3-speech.md): of the turn toward the lens, the head takes this share and her
 * shoulders (upper body yaw) this one, each within a limit (rad); the eyes take the rest. Pitch is head only (and the nod).
 */
export const ADDRESS_SHARES = Object.freeze({ head: 0.45, headYawMax: 0.35, headPitchMax: 0.25, torso: 0.15, torsoYawMax: 0.15, eyesMax: 0.35 });

type AddressGroups = { headPitch: number; headYaw: number; neckPitch: number; torsoPitch: number; torsoYaw: number };
/**
 * A forward model of her head, neck and upper body (the intent layer's own springs, same tempo): where they will be, so the eyes
 * take exactly the rest of the angle while the slower groups are still on their way. Her gaze stays on you through the turn and
 * the nod, instead of running ahead and then drifting back.
 */
class AddressMirror {
  private tempo: Tempo = 'calm';
  private readonly s: Record<keyof AddressGroups, Spring>;
  constructor() {
    const t = TEMPO.calm;
    this.s = { headPitch: new Spring({ ...t.head, eased: true }), headYaw: new Spring({ ...t.head, eased: true }), neckPitch: new Spring({ ...t.neck, eased: true }),
      torsoPitch: new Spring({ ...t.torso, eased: true }), torsoYaw: new Spring({ ...t.torso, eased: true }) };
  }
  reset(): void { for (const spring of Object.values(this.s)) spring.reset(0); this.retune('calm'); }
  private retune(tempo: Tempo): void {
    if (tempo === this.tempo) return;
    this.tempo = tempo; const t = TEMPO[tempo];
    this.s.headPitch.retune(t.head); this.s.headYaw.retune(t.head); this.s.neckPitch.retune(t.neck); this.s.torsoPitch.retune(t.torso); this.s.torsoYaw.retune(t.torso);
  }
  /** Targets in; the predicted turn of her head's own direction out (rad, her frame). */
  step(tempo: Tempo, targets: AddressGroups, dt: number): { yaw: number; pitch: number } {
    this.retune(tempo);
    for (const key of Object.keys(targets) as (keyof AddressGroups)[]) this.s[key].target = targets[key];
    const { count, h } = substeps(dt);
    for (let i = 0; i < count; i++) for (const spring of Object.values(this.s)) spring.advance(h);
    return { yaw: this.s.headYaw.value + this.s.torsoYaw.value, pitch: this.s.headPitch.value + this.s.neckPitch.value + this.s.torsoPitch.value };
  }
}

/** Closed-loop gain (1/s) and how far the hips may be moved (m). The figure's pelvis springs (2.2 Hz) sit after it. I-192: shared/unbound/arrival/loop.ts. */
export const LENS_LOOP = ARRIVAL_LOOP;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
/** A far point on her floor straight back along the axis: turning to it, she faces the lens square on (not the camera point, which is off to one side of her root). */
const alongLens = (lens: LensView) => ({ x: lens.camera.x - lens.axis.x * 50, z: lens.camera.z - lens.axis.z * 50 });

/** Yaw / pitch (her frame: + yaw toward her left, + pitch down) from `from` toward `to`. */
function aim(from: V3, to: V3, heading: number): { yaw: number; pitch: number } {
  const d = toHerFrame(sub(to, from), heading);
  return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(-d.y, Math.hypot(d.x, d.z)) };
}

export class ProceduralGenerator implements MotionGenerator {
  readonly id = 'procedural';
  /** The loop (her frame, m): shared/unbound/arrival/loop.ts. */
  private readonly loop = new ArrivalLoop();
  /** The last loop error (m, her frame), for tests and the developer line. */
  get lastError(): V3 { return this.loop.lastError; }
  private readonly mirror = new AddressMirror();
  private addressing = false;
  /** Showcase (docs/claude/2026-11-14-lapwing-showcase.md): its own forward model of her head, made on first use. */
  private showcase: ShowcaseMotion | null = null;

  supports(_kind: MotionIntent['kind']): boolean { return true; }
  reset(): void { this.loop.reset(); this.mirror.reset(); this.addressing = false; this.showcase?.reset(); }

  generate({ intent, t, dt, sense }: MotionRequest): PoseTargets {
    if (intent.kind !== 'address') this.addressing = false;
    switch (intent.kind) {
      case 'address': return this.address(intent, dt, sense);
      case 'rest': case 'idle': return { ...REST_TARGETS }; // idle sources live in idle-*.ts; here the quiet fallback
      case 'notice': case 'walk': {
        const look = this.look(intent.lens, sense);
        // Noticing: the chin comes up a little (she perks up), on top of the turn toward the lens.
        const head = intent.kind === 'notice' ? { ...look.head, pitch: look.head.pitch - 0.05 } : look.head;
        return { ...REST_TARGETS, ...look, head, place: intent.kind === 'walk' ? intent.place : null, facing: intent.kind === 'walk' ? alongLens(intent.lens) : null, walkSpeedMps: intent.kind === 'walk' ? intent.speedMps : null,
          face: { curious: intent.kind === 'notice' ? 0.6 : 0.4, smile: 0, startle: 0 }, tempo: intent.kind === 'notice' ? 'brisk' : 'calm' };
      }
      case 'lens-eye': return this.lensEye(intent, dt, sense);
      case 'showcase': return (this.showcase ??= new ShowcaseMotion()).generate(intent, dt, sense);
      case 'sway': return swayTargets(intent, t);
      case 'stretch': return stretchTargets(intent, t);
      case 'hop': return hopTargets(intent, t);
      case 'back': {
        this.reset();
        const look = this.look(intent.lens, sense);
        const pull = intent.startled ? Math.exp(-(((t - 0.12) / 0.12) ** 2)) : 0; // a short pull back of the head, over in ~0.3 s
        return {
          ...REST_TARGETS, eyes: look.eyes,
          head: { pitch: -0.09 * pull, yaw: 0, roll: 0 }, torso: { pitch: -0.03 * pull, yaw: 0, roll: 0 },
          place: t > (intent.startled ? 0.6 : 0.9) ? intent.home : null,
          face: { curious: 0, smile: intent.startled ? (t > 0.7 ? intent.smile * 0.6 : 0) : intent.smile, startle: intent.startled ? Math.max(0, 0.7 - t) : 0 },
          tempo: intent.startled && t < 0.8 ? 'startle' : 'calm',
        };
      }
    }
  }

  /**
   * The whole look toward the lens (E1, docs/claude/2026-11-14-eye-head-fix.md): the figure's eye-head coordinator splits it (eyes
   * first, the head after and the larger part, the eyes back toward the middle) and lets it go when the lens is behind her. Before
   * E1 this split it here, eyes clamped at 20°, which with her walking look on top put the pupils at the edge (up to 37°).
   */
  private look(lens: LensView, sense: MotionRequest['sense']): Pick<PoseTargets, 'eyes' | 'head'> {
    const from = sense.head ?? null;
    if (!from) return { eyes: { yaw: 0, pitch: 0 }, head: { ...ZERO_ROT } };
    const a = aim(from, lens.camera, sense.root.heading);
    return { head: { ...ZERO_ROT }, eyes: { yaw: a.yaw, pitch: clamp(a.pitch, -1.2, 1.2) } };
  }

  /**
   * E3: turn to the lens before she speaks, and the nod on top. Targets only: the director staggers the groups (look weights) and
   * shapes the nod in time; the intent layer's springs carry them (eyes first by nature, the head after, the upper body last).
   */
  private address(intent: Extract<MotionIntent, { kind: 'address' }>, dt: number, sense: MotionRequest['sense']): PoseTargets {
    if (!this.addressing) { this.mirror.reset(); this.addressing = true; }
    // E1 rule (docs/claude/2026-11-14-eye-head-fix.md): the posture carries only the nod; where she looks is one gaze target, which
    // the figure's eye-head coordinator splits (eyes first, the head ~150 ms later, the upper body last: E3's order, now by E1).
    // The gaze is measured from her head as the posture leaves it, so the nod's predicted pitch (the forward model of the same
    // springs) is taken back out: her eyes stay on you through the nod. `look.eyes` still staggers the start.
    const look = intent.look, nod = intent.nod;
    const a = sense.head ? aim(sense.head, intent.lens.camera, sense.root.heading) : { yaw: 0, pitch: 0 };
    const head = { pitch: nod.head, yaw: 0, roll: 0 };
    const neck = { pitch: nod.neck, yaw: 0, roll: 0 };
    const torso = { pitch: nod.torso, yaw: 0, roll: 0 };
    const turned = this.mirror.step(intent.tempo, { headPitch: head.pitch, headYaw: 0, neckPitch: neck.pitch, torsoPitch: torso.pitch, torsoYaw: 0 }, dt);
    const eyes = { yaw: a.yaw * look.eyes, pitch: clamp(a.pitch * look.eyes - turned.pitch, -1.2, 1.2) };
    return { ...REST_TARGETS, torso, neck, head, eyes, tempo: intent.tempo };
  }

  private lensEye(intent: Extract<MotionIntent, { kind: 'lens-eye' }>, dt: number, sense: MotionRequest['sense']): PoseTargets {
    const eye = eyePoint(sense.eyes, intent.eye); // one eye, or the point between both (I-192 follow-up)
    const lean = intent.leanRad;
    const torso = { pitch: lean, yaw: 0, roll: 0 };
    const neck = { pitch: -0.3 * lean, yaw: 0, roll: 0.3 * intent.tiltRad };
    const head = { pitch: -0.7 * lean, yaw: 0, roll: 0.7 * intent.tiltRad };
    let eyes = { yaw: 0, pitch: 0 };
    const rise = Math.max(1e-3, sense.tiptoeRise);
    if (eye) {
      // The loop. Where the eye would be with no hip offset and flat feet ("base") = measured eye − the offset already realized;
      // the offset that puts it on target = target − base = error + realized. The command follows that estimate through a
      // first-order filter (no integrator, so nothing winds up while the springs and her toes are still on their way).
      const target = onAxis(intent.lens, intent.distanceM), e = toHerFrame(sub(target, eye), sense.root.heading);
      this.loop.step(e, sense.offsets, rise, intent.loop, dt);
      const a = aim(eye, intent.lens.camera, sense.root.heading);
      const net = lean - 0.3 * lean - 0.7 * lean; // the head's own pitch in the world after the lean and the pitch back: ~0
      eyes = { yaw: clamp(a.yaw + intent.saccade.yaw, -0.3, 0.3), pitch: clamp(a.pitch - net + intent.saccade.pitch, -0.3, 0.3) };
    }
    const up = this.loop.up;
    return {
      ...REST_TARGETS, torso, neck, head, eyes, facing: alongLens(intent.lens),
      pelvis: { lateral: this.loop.lateral, forward: this.loop.forward, vertical: Math.min(0, up) },
      tiptoe: up > 0 ? Math.min(1, up / rise) : 0,
      breath: 1 - 0.6 * intent.stare,
      face: { curious: 0.25 + 0.35 * intent.stare, smile: 0, startle: 0 },
      blink: intent.blink, tempo: 'calm',
    };
  }
}
