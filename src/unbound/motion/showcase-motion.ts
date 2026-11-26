/**
 * Unbound showcase, layer 2 (docs/claude/2026-11-14-lapwing-showcase.md): one frame of a live-choreographed performance
 * (a 'showcase' intent from src/unbound/showcase/performer.ts) into goals for layer 3. Computed on the spot from her measured body.
 *
 * Where she looks is one gaze target (E1, docs/claude/2026-11-14-eye-head-fix.md): the figure's eye-head coordinator splits it
 * between eyes, head and upper body and keeps the pupils near the middle. A target behind her is not looked at.
 */
import { REST_TARGETS, type ArmRot, type PoseTargets, type ShowcaseFace, type ShowcaseIntent } from './generator';
import { layerIdle, type LearnedIdle } from './learned-idle';
import { toHerFrame, type LensView, type V3 } from './lens-align';
import type { MorphSlot } from '../../../shared/actions';
import { FaceArrival, type ArriveSense } from './arrive';

/** Farther than this to one side (rad), a target is behind her: she does not try to look at it. */
const BEHIND = 100 * Math.PI / 180;
/** Hips forward per radian of lean (m), so the lean is a lean toward you, not a bow. */
const LEAN_HIPS_M = 0.28;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const alongLens = (lens: LensView) => ({ x: lens.camera.x - lens.axis.x * 50, z: lens.camera.z - lens.axis.z * 50 });
function aim(from: V3, to: V3, heading: number): { yaw: number; pitch: number } {
  const d = toHerFrame({ x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }, heading);
  return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(-d.y, Math.hypot(d.x, d.z)) };
}

/** Named face cues → the model's universal expression slots (weights at a full cue; layer 3 finds each slot's morph). */
export function faceSlots(face: ShowcaseFace): Partial<Record<MorphSlot, number>> {
  const out: Partial<Record<MorphSlot, number>> = {};
  const add = (slot: MorphSlot, v: number) => { if (v > 1e-4) out[slot] = Math.min(1, (out[slot] ?? 0) + v); };
  const warmEyes = face.warm ** 1.6; // the eyes follow the mouth: a true smile reaches the eyes a little after the mouth (rule 8)
  // Each named expression made unmistakable at this framing (round 2): sly = half-lidded + one mouth corner + a little brow;
  // shy = a small closed smile + a strong blush (the eyes and head are the performer's); surprise = wide eyes, brows up, a small
  // open mouth; a big laugh closes the eyes.
  // Sly is a closed-mouth smirk (one corner, named below), so it adds almost nothing to the both-corners smile.
  add('mouthSmile', 0.55 * face.confirm + 0.8 * face.warm + 0.5 * face.laugh + 0.35 * face.shy + 0.1 * face.sly + 0.5 * face.content);
  add('smileEyes', 0.2 * face.confirm + 0.75 * warmEyes + Math.min(1, 1.25 * face.laugh) + 0.2 * face.shy);
  // Round 4: the murmur's mouth opens more (on the contact sheet it barely moved at this framing).
  add('a', 0.5 * face.laugh + 0.3 * face.surprise + 0.85 * face.mouth.a + 0.55 * face.yawn);
  add('o', 0.2 * face.surprise + 0.75 * face.mouth.o + 0.35 * face.yawn);
  // Pout: Gene's ARKit pucker barely moves at this framing; the MMD 'u' shape carries most of it (round 5 contact sheet).
  add('i', 0.7 * face.mouth.i); add('u', 0.7 * face.mouth.u + 0.85 * face.pout); /* round 10: a stronger pout at this framing */ add('e', 0.7 * face.mouth.e);
  add('mouthPucker', 1.0 * face.pout);
  add('shy', face.blush); // a blush plane: it only reads near full (round 15: its own slow envelope, performer.ts)
  add('surprise', 0.95 * face.surprise);
  add('browUp', 0.15 * face.laugh + 0.9 * face.surprise + 0.15 * face.pout + 0.15 * face.sly + 0.55 * face.stress + 0.3 * face.yawn);
  add('jitome', 0.7 * face.sly + 0.2 * face.shy);
  // Sly: lids at about half (0.45 on top of the half-lidded shape); content and a yawn: eyes closed.
  add('blink', 0.95 * face.closed + 0.42 * face.half + 0.45 * face.sly + 0.92 * face.content + 0.8 * face.yawn);
  add('blinkLeft', face.wink ?? 0); // I-184: one eye (the after-beat's wink; the model's own wink shape)
  return out;
}

/**
 * Round 16: per-model strength factors for the slots (measured from how far each slot's vertices move against Gene's: model-fit.ts;
 * null or a slot without an entry: 1, so Gene's output is unchanged). Applied after the cue weights, capped at a full weight.
 */
let slotGain: Readonly<Partial<Record<MorphSlot, number>>> | null = null;
export function setShowcaseSlotGain(gain: Readonly<Partial<Record<MorphSlot, number>>> | null): void { slotGain = gain && Object.keys(gain).length ? gain : null; }
export function applySlotGain(slots: Partial<Record<MorphSlot, number>>, gain: Readonly<Partial<Record<MorphSlot, number>>> | null): Partial<Record<MorphSlot, number>> {
  if (!gain) return slots;
  const out: Partial<Record<MorphSlot, number>> = {};
  for (const [slot, v] of Object.entries(slots) as [MorphSlot, number][]) out[slot] = Math.min(1, v * (gain[slot] ?? 1));
  return out;
}

/** Shapes outside the 17 slots, by name candidates (first found on the model wins; missing ones are skipped): a smirk for sly, a whole-face surprise. */
export function faceNamed(face: ShowcaseFace): Record<string, number> {
  const out: Record<string, number> = {};
  // Stronger whole-face versions where the model has them (MMD's 総 group morphs, then ARKit-style names); none: the slots alone.
  // (Common MMD names follow the ARKit ones, so models without ARKit shapes get the one-corner smile and a narrower pout too.)
  if (face.sly > 1e-4) out['mouthSmileLeft|mouth_smile_l|mouthsmile_l|口角上げ左'] = 1.0 * face.sly; // one corner only, mouth closed
  if (face.surprise > 1e-4) out['驚き(総|surprised|eyeWide'] = 0.7 * face.surprise;
  // Round 5: speech opens the jaw too (the vowel shapes alone barely moved at this framing); a pout pushes the lips forward and
  // puffs the cheeks a little where the model has those shapes.
  const open = Math.max(face.mouth.a, face.mouth.o, 0.6 * face.mouth.e, 0.5 * face.mouth.i, 0.6 * face.mouth.u);
  if (open > 1e-4) out['jawOpen|jaw_open|mouthOpen'] = 0.35 * open;
  if (face.pout > 1e-4) { out['mouthFunnel|mouth_funnel|う'] = 0.65 * face.pout; out['cheekPuff|cheek_puff|ぷくー|ぷく|頬膨らみ'] = 0.7 * face.pout; out['口横狭め'] = 0.5 * face.pout; /* a pucker for models without one (the slot covers those with) */ }
  return out;
}

/**
 * Round 7: the learned idle under quiet holds and her own world (off unless the page turns it on: showcase and tests only). A
 * factory, so each generator gets its own idle with its own clock.
 */
let idleFactory: (() => LearnedIdle) | null = null;
export function setShowcaseIdle(factory: (() => LearnedIdle) | null): void { idleFactory = factory; }

/** The idle's arm movements on one side scaled by how free that arm is (0 while a hand beat holds it: it never fights a gesture). */
function freeArms(idle: PoseTargets, arms: { left: number; right: number }): PoseTargets {
  if (!idle.armRot) return idle;
  const scale = (r: { pitch: number; yaw: number; roll: number }, k: number) => ({ pitch: r.pitch * k, yaw: r.yaw * k, roll: r.roll * k });
  const side = (a: ArmRot, k: number): ArmRot => ({ upper: scale(a.upper, k), elbow: scale(a.elbow, k) });
  return { ...idle, armRot: { left: side(idle.armRot.left, clamp(arms.left, 0, 1)), right: side(idle.armRot.right, clamp(arms.right, 0, 1)) } };
}

type ShowcaseSense = { head: V3 | null; root: { heading: number } } & Partial<Omit<ArriveSense, 'root'>>;

export class ShowcaseMotion {
  private readonly idle: LearnedIdle | null = idleFactory?.() ?? null;
  /** I-192: the face's closed loop (arrive.ts), made on first use. */
  private arrival: FaceArrival | null = null;
  /** The face loop's last error (her frame, m), for tests. */
  get arrivalError(): V3 | null { return this.arrival?.lastError ?? null; }
  /** The learned idle's source ('model+events', 'model', 'procedural'), or null when it is off. */
  get idleSource(): string | null { return this.idle?.id ?? null; }
  reset(): void { this.idle?.reset(); this.arrival?.reset(); }

  generate(intent: ShowcaseIntent, dt: number, sense: ShowcaseSense): PoseTargets {
    const base = this.arrive(this.pose(intent, sense), intent, dt, sense);
    if (!this.idle) return base;
    // The idle runs every frame (its own clock keeps going), and is laid on only as much as the performer asks.
    const frame = this.idle.frame(dt, intent.idle?.activation);
    const w = intent.idle?.weight ?? 0;
    if (w <= 1e-4) return base;
    const out = layerIdle(base, freeArms(frame, intent.idle!.arms), w);
    // The gaze target is measured from the head as the posture leaves it: take the idle's own turn of the posture back out of it,
    // so her eyes stay on what she looks at while her body drifts (the coordinator then lets the head settle back).
    const turn = (k: 'yaw' | 'pitch') => w * (frame.torso[k] + frame.neck[k] + frame.head[k]);
    out.eyes = { yaw: base.eyes.yaw - turn('yaw'), pitch: clamp(base.eyes.pitch - turn('pitch'), -1.2, 1.2) };
    return out;
  }

  /** I-192: the face arrives on the lens axis (the intent's `arrive`): the loop's hips and toes, mixed in by its weight. */
  private arrive(base: PoseTargets, intent: ShowcaseIntent, dt: number, sense: ShowcaseSense): PoseTargets {
    const a = intent.arrive;
    if (!a || !sense.eyes || !sense.offsets || sense.tiptoeRise === undefined) { if (!a) this.arrival?.reset(); return base; }
    const goals = (this.arrival ??= new FaceArrival()).goals(a, intent.lens, { eyes: sense.eyes, root: sense.root, offsets: sense.offsets, tiptoeRise: sense.tiptoeRise }, dt, base.pelvis);
    return goals ? { ...base, pelvis: goals.pelvis, tiptoe: goals.tiptoe } : base;
  }

  private pose(intent: ShowcaseIntent, sense: { head: V3 | null; root: { heading: number } }): PoseTargets {
    const { gaze, lean, tilt, nod } = intent, bias = intent.bias ?? { yaw: 0, pitch: 0 };
    // The look, in her frame: at the lens (plus a small offset) or away.
    let look = { yaw: gaze.yaw, pitch: gaze.pitch };
    if (gaze.mode === 'lens') {
      const a = sense.head ? aim(sense.head, intent.lens.camera, sense.root.heading) : { yaw: 0, pitch: 0 };
      look = Math.abs(a.yaw) > BEHIND ? { yaw: 0, pitch: 0 } : { yaw: a.yaw + gaze.yaw, pitch: a.pitch + gaze.pitch };
    }
    // The posture carries only the lean, the tilt and the nod; where she looks is one gaze target, which the figure's eye-head
    // coordinator (src/stage/eye-head.ts) splits between eyes, head and upper body, keeping the eyes near the middle.
    // The three-quarter resting angle: mostly the upper body, a little the head; the gaze target is measured from the head as this
    // posture leaves it, so the posture's own turn and tilt of the chin are taken back out of it (her eyes still find you).
    const torso = { pitch: lean, yaw: 0.65 * bias.yaw, roll: 0 };
    const flick = intent.headYaw ?? 0; // round 9: a quiet moment's small head turn (the eyes stay where they look)
    const neck = { pitch: -0.3 * lean + 0.25 * nod + 0.3 * bias.pitch, yaw: 0.15 * bias.yaw + 0.3 * flick, roll: 0.35 * tilt };
    const head = { pitch: -0.7 * lean + 0.75 * nod + 0.7 * bias.pitch, yaw: 0.2 * bias.yaw + 0.7 * flick, roll: 0.65 * tilt };
    const eyes = { yaw: look.yaw - bias.yaw - flick, pitch: clamp(look.pitch - nod - bias.pitch, -1.2, 1.2) };
    return {
      ...REST_TARGETS, torso, neck, head, eyes,
      place: intent.place, facing: alongLens(intent.lens), walkSpeedMps: intent.walkSpeedMps, ...(intent.walkBrisk ? { walkBrisk: true } : {}),
      pelvis: { lateral: 0, forward: clamp(lean * LEAN_HIPS_M, -0.03, 0.12), vertical: 0 },
      breath: 1 - 0.3 * clamp(intent.stillness, 0, 1),
      expr: applySlotGain(faceSlots(intent.face), slotGain), exprNamed: faceNamed(intent.face), hands: intent.hands, gazeRecenter: intent.gazeRecenter,
      blink: clamp(intent.blink, 0, 1), tempo: intent.tempo,
    };
  }
}
