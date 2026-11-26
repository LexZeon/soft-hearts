// Unbound U2 experiment E2: the bundled public Gene doing one of her own acts (sway, stretch, hop) in her Unbound body, through
// the real figure (MMDLoader / CCD IK / the gait and contact owner / the intent layer), the act player (src/unbound/director/
// acts.ts) and the procedural generator, frame by frame at a fixed rate. Each frame records what was shown (world meters).
import { Quaternion, Vector3 } from 'three';
import { UNITS_PER_M, type UnboundFigure } from '../../src/unbound/figure';
import { ActPlayer, type ActBeat, type ActEnd, type BodyAct } from '../../src/unbound/director/acts';
import { ProceduralGenerator } from '../../src/unbound/motion/procedural';
import type { V3 } from '../../src/unbound/motion/lens-align';
import { geneFigure, TRACKED } from './unbound-gene';

export interface ActFrame {
  t: number; beat: ActBeat | null; active: boolean;
  rotations: Quaternion[]; root: V3; head: V3 | null; eyes: { left: V3 | null; right: V3 | null };
  /** Toes (world m) and whether each foot is planted; wrists (world m). */
  toes: (V3 | null)[]; planted: boolean[]; wrists: (V3 | null)[];
  comMargin: number | null; hopPhase: string | null; hopLift: number; armsRaised: number; blink: number;
}

const v3 = (p: Vector3, k = 1 / UNITS_PER_M): V3 => ({ x: p.x * k, y: p.y * k, z: p.z * k });

/** Runs `seconds` at `fps`; the act starts at `startAt` (s). `cancelAt`: seconds at which it is cancelled (optional). */
export async function runAct(act: BodyAct, fps: number, seconds: number, options: { startAt?: number; cancelAt?: number; amplitude?: number; liveliness?: number; seed?: number; xM?: number; depthM?: number } = {}) {
  const { fixture, figure } = await geneFigure({ xM: options.xM ?? 0.25, depthM: options.depthM ?? 1.5 });
  const ends: ActEnd[] = [];
  const player = new ActPlayer(new ProceduralGenerator(), end => ends.push(end));
  const mesh = fixture.mesh, bones = TRACKED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const wrists = ['左手首', '右手首'].map(name => mesh.skeleton.bones.find(b => b.name === name) ?? null);
  const blinkIndex = mesh.morphTargetDictionary?.['まばたき'] ?? -1;
  const startAt = options.startAt ?? 1;
  try {
    const frames: ActFrame[] = [];
    let started = false, cancelled = false;
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      if (!started && t >= startAt) started = player.start({ act, amplitude: options.amplitude ?? 1, liveliness: options.liveliness ?? 0.6, seed: options.seed ?? 0.3 });
      if (!cancelled && options.cancelAt !== undefined && t >= options.cancelAt) { player.cancel(); cancelled = true; }
      player.frame(dt, figure);
      figure.frame(dt);
      const sense = figure.sense!, report = figure.report!;
      frames.push({
        t, beat: player.beat, active: player.active,
        rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), root: v3(mesh.position), head: sense.head, eyes: { ...sense.eyes },
        toes: report.feet.map(f => f.toe ? v3(f.toe) : null), planted: report.feet.map(f => f.planted),
        wrists: wrists.map(w => w ? v3(w.getWorldPosition(new Vector3())) : null),
        comMargin: report.comMargin, hopPhase: sense.hop?.phase ?? null, hopLift: figure.hopLift, armsRaised: figure.armsRaised,
        blink: blinkIndex >= 0 ? mesh.morphTargetInfluences?.[blinkIndex] ?? 0 : 0,
      });
    }
    return { frames, ends, figure: figure as UnboundFigure, heightM: figure.heightM };
  } finally { figure.dispose(); fixture.close(); }
}

/** Planted toes (cm): over every interval a foot stays planted, the farthest its toe gets from where the interval began; and the
 * toe's travel along the floor while it touches it (any phase). `from`/`to` limit the frames. */
export function toeNumbers(frames: readonly ActFrame[]) {
  let drift = 0, slide = 0;
  for (let k = 0; k < 2; k++) {
    let anchor: V3 | null = null;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i], toe = f.toes[k];
      if (i && toe && frames[i - 1].toes[k] && toe.y < 0.002 && frames[i - 1].toes[k]!.y < 0.002) slide += Math.hypot(toe.x - frames[i - 1].toes[k]!.x, toe.z - frames[i - 1].toes[k]!.z) * 100;
      if (!f.planted[k] || !toe) { anchor = null; continue; }
      anchor ??= toe;
      drift = Math.max(drift, Math.hypot(toe.x - anchor.x, toe.y - anchor.y, toe.z - anchor.z) * 100);
    }
  }
  return { drift, slide };
}
