/**
 * 动作跳变记录, stage side (on her own model, which tests never use).
 * Each rendered frame it looks at two things and reports what it finds (the host writes it into the experience journal while the
 * user's "保留体验记录（只存本机）" switch is on; shared/journal.ts `motion` holds the whitelist):
 *  - the display guard (pose-continuity.ts) caught a jump: which bone or morph, how big;
 *  - a physics-owned bone (hair, chest: after the guard, so it never sees them) turned unexpectedly far in one frame (its step
 *    departs from the previous step by at least PHYSICS_KICK_DEG): which bone, how many degrees.
 * Each with what she was doing then (closed names) and the frame interval. No chat, no model path. At most one line per bone and
 * kind every REPEAT_MS and BURST lines a minute, so a shaking bone cannot fill the journal. No allocation per frame when quiet.
 */
import { Quaternion, type Bone, type SkinnedMesh } from 'three';
import type { MotionActivity, MotionGlitchKind } from '../../shared/journal';
import type { PoseContinuityState } from './pose-continuity';

export interface MotionGlitchReport {
  kind: MotionGlitchKind; part: 'bone' | 'morph' | 'geometry' | 'gpu'; name: string; size: number; activities: MotionActivity[]; fps: number | null; frameMs: number | null;
  /** 色块哨兵 (kind 'block'): the block went away after the re-send. */
  cleared?: boolean;
}
/** A visible snap of a physics bone: one frame's step departing this far (degrees) from the previous one. */
export const PHYSICS_KICK_DEG = 10;
export const MOTION_GLITCH_REPEAT_MS = 2_000;
export const MOTION_GLITCH_BURST = 30;
const DEG = 180 / Math.PI;

export class MotionGlitchWatch {
  private jumps = -1;
  private resets = -1;
  private owner: SkinnedMesh | null = null;
  private bones: Bone[] = [];
  private previous: Quaternion[] = [];
  private step: Quaternion[] = [];
  private known: Uint8Array = new Uint8Array(0);
  private readonly last = new Map<string, number>();
  private window: number[] = [];
  private readonly q = new Quaternion(); private readonly s = new Quaternion(); private readonly inv = new Quaternion();

  constructor(private readonly report: (glitch: MotionGlitchReport) => void, private readonly now: () => number = () => performance.now()) {}

  /** After the guard ran this frame: a new catch (its count went up within the same guard life) is one line. */
  guard(mesh: SkinnedMesh | null, state: PoseContinuityState | null, activities: () => MotionActivity[], fps: number | null, frameMs: number | null): void {
    if (!state) return;
    const fresh = state.resets !== this.resets || state.jumps < this.jumps;
    const caught = !fresh && state.jumps > this.jumps;
    this.jumps = state.jumps; this.resets = state.resets;
    if (!caught || !state.lastJump) return;
    const property = state.lastJump.property;
    const bone = /^\.bones\[(.+)\]\.(?:quaternion|position)$/u.exec(property);
    const morph = /^\.morphTargetInfluences\[(\d+)\]$/u.exec(property);
    let name: string | null = null, part: 'bone' | 'morph' = 'bone';
    if (bone) name = bone[1];
    else if (morph) {
      part = 'morph';
      const index = Number(morph[1]);
      name = Object.entries(mesh?.morphTargetDictionary ?? {}).find(([, value]) => value === index)?.[0] ?? `#${index}`;
    }
    if (name) this.emit({ kind: 'guard', part, name, size: state.lastJump.size, activities: activities(), fps, frameMs });
  }

  /** After local physics wrote its bones this frame (`bones`: the physics-owned output bones of the parts that are on). */
  physics(mesh: SkinnedMesh | null, bones: readonly number[] | null, activities: () => MotionActivity[], fps: number | null, frameMs: number | null): void {
    if (!mesh || !bones?.length) { this.owner = null; return; }
    if (mesh !== this.owner || bones.length !== this.bones.length) {
      this.owner = mesh; this.bones = bones.map(index => mesh.skeleton.bones[index]).filter(Boolean);
      this.previous = this.bones.map(() => new Quaternion()); this.step = this.bones.map(() => new Quaternion()); this.known = new Uint8Array(this.bones.length);
    }
    for (let i = 0; i < this.bones.length; i++) {
      const shown = this.bones[i].getWorldQuaternion(this.q);
      if (this.known[i] >= 1) {
        this.s.copy(shown).multiply(this.inv.copy(this.previous[i]).invert());
        if (this.known[i] >= 2) {
          const kick = this.s.angleTo(this.step[i]) * DEG;
          if (kick >= PHYSICS_KICK_DEG) this.emit({ kind: 'physics', part: 'bone', name: this.bones[i].name, size: kick, activities: activities(), fps, frameMs });
        }
        this.step[i].copy(this.s);
        this.known[i] = 2;
      } else this.known[i] = 1;
      this.previous[i].copy(shown);
    }
  }

  /** Physics restarted (hidden, a new model, physics off): the next frame has no history to compare with. */
  forgetPhysics(): void { this.known.fill(0); }

  private emit(glitch: MotionGlitchReport): void {
    const now = this.now(), key = `${glitch.kind}|${glitch.part}|${glitch.name}`;
    if (now - (this.last.get(key) ?? -Infinity) < MOTION_GLITCH_REPEAT_MS) return;
    this.window = this.window.filter(at => now - at < 60_000);
    if (this.window.length >= MOTION_GLITCH_BURST) return;
    this.last.set(key, now); this.window.push(now);
    if (this.last.size > 256) this.last.delete(this.last.keys().next().value!);
    try { this.report({ ...glitch, size: Math.round(glitch.size * 1000) / 1000 }); } catch { /* A report never breaks a frame. */ }
  }
}
