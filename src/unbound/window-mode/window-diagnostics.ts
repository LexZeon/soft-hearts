/**
 * I-154 batch 7, row 45 诊断 (docs/claude/2026-11-19-unbound-in-window.md): the developer's two diagnostics on the window engine, the old
 * stage's watches as they are (src/stage/motion-glitch.ts, src/stage/stray-pixels.ts), counts and names only:
 *  - 动作跳变记录 (MotionGlitchWatch): a physics-owned bone (hair, chest) whose one-frame step departs from the last step by ≥ 10°
 *    ('physics'). The old stage also reports what its display guard caught ('guard'); the window engine has no display guard (Unbound
 *    only gives targets, its springs carry them), so here 'guard' is the same test as 'physics' run on the bones you see (VISIBLE_BONES:
 *    her trunk, head, arms and legs): a one-frame step ≥ 10° away from the last step is what the guard would have caught;
 *  - 色块哨兵 (StrayPixelWatch): thin strips far outside her skinned bones' reach are read back every 400 ms; two hits are a block: the
 *    numbers are inspected, her geometry is sent to the GPU again, one report. Her reach is widened by the sleep props while they show
 *    (the old stage's widenStrayReach). Not while the control window's grid shows (drawn outside her reach on purpose, as on the old stage).
 * Reports go to the stage's onMotionGlitch (the wiring sends them to the host only from the companion window, and the host writes them only
 * while the user's experience journal is on). The stray watch's own readout (canvas data-stray-pixels) only in developer mode.
 * The 色块诊断日志 (I-031 ColorBlockRecorder, temporary) is not here.
 */
import { Vector3, type Bone, type Camera, type SkinnedMesh } from 'three';
import { MotionGlitchWatch, StrayPixelWatch, boneReach, inspectModel, resendModel, skinnedBones, type MotionGlitchReport, type StrayBox } from '../../stage';
import type { MotionActivity } from '../../../shared/stage';
import type { WindowMotionEnv } from './window-motions';

// ui-zh-ok: MMD bone names inside the model file, not interface text
export const VISIBLE_BONES = ['センター', '上半身', '上半身2', '首', '頭', '左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首', // ui-zh-ok: bone names
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  '左足', '右足', '左ひざ', '右ひざ'] as const;

/** What she is doing now, in the journal's closed words (the old stage's motionActivities, on the window's state). */
export function windowActivities(env: WindowMotionEnv, extra: { chat: boolean; action: boolean; body: boolean; herLife: boolean; preview: boolean; transition: boolean }): MotionActivity[] {
  const out: MotionActivity[] = [];
  if (extra.chat) out.push('chat-gesture');
  if (extra.action) out.push('her-action');
  if (env.speaking) out.push('speaking');
  if (env.pat || env.hover) out.push('pat');
  if (env.feeding) out.push('feed');
  if (env.music) out.push('music');
  if (extra.herLife) out.push('her-life');
  if (env.showing || extra.preview) out.push('expression-preview');
  if (env.rps) out.push('rps');
  if ((env.give || env.hands) && !out.includes('her-action')) out.push('her-action');
  if (env.reacting) out.push('pose');
  if (extra.body) out.push('body-motion');
  if (extra.transition) out.push('transition');
  return out.length ? out : ['idle'];
}

/** The reach widened by projected world points (the sleep props' corners), as the old stage's widenStrayReach. */
export function widenReach(box: StrayBox | null, corners: readonly { x: number; y: number; z: number }[], camera: Camera, width: number, height: number): StrayBox | null {
  if (!box || !corners.length) return box;
  const out = { ...box }, p = new Vector3();
  for (const corner of corners) {
    p.set(corner.x, corner.y, corner.z).project(camera);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.z < -1 || p.z > 1) continue;
    const px = (p.x + 1) / 2 * width, py = (p.y + 1) / 2 * height;
    out.minX = Math.min(out.minX, px); out.maxX = Math.max(out.maxX, px); out.minY = Math.min(out.minY, py); out.maxY = Math.max(out.maxY, py);
  }
  return out;
}

export interface WindowDiagnosticsFrame {
  mesh: SkinnedMesh | null;
  camera: Camera;
  /** Her height in model units (the reach's margins and the inspection's limits). */
  height: number;
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /** The physics-owned output bones of the parts that run now (window-physics.ts), or null. */
  physicsBones: readonly number[] | null;
  activities: () => MotionActivity[];
  fps: number | null;
  frameMs: number;
  /** The control window's grid shows: no stray sampling (it is drawn outside her reach on purpose). */
  grid: boolean;
  /** World corners of what is drawn with her (the sleep props). */
  props: () => readonly { x: number; y: number; z: number }[];
}

export class WindowDiagnostics {
  private glitches: MotionGlitchWatch | null = null;
  private seen: MotionGlitchWatch | null = null;
  private stray: StrayPixelWatch | null = null;
  private bones: { mesh: SkinnedMesh; skinned: Bone[]; visible: number[] } | null = null;
  private readonly ndc = { value: new Float32Array(0) };
  private frame: WindowDiagnosticsFrame | null = null;
  /** What the display guard would have caught (the visible-bone watch), for the pretrial's `poseContinuity` readout (window-readouts.ts). */
  readonly guard: { jumps: number; maxAngleDeg: number; lastJump: { property: string; size: number } | null } = { jumps: 0, maxAngleDeg: 0, lastJump: null };

  /** `report`: the stage's onMotionGlitch (absent: the glitch watches do not run). `dataset`: developer mode (the stray readout). */
  constructor(private readonly report: ((glitch: MotionGlitchReport) => void) | undefined, private readonly dataset: () => boolean) {}

  /** Right after the frame was rendered, inside the same task (the stray watch reads the canvas then). */
  afterRender(frame: WindowDiagnosticsFrame): void {
    const mesh = frame.mesh;
    this.frame = frame;
    if (!mesh) { this.glitches?.forgetPhysics(); this.seen?.forgetPhysics(); return; }
    if (this.bones?.mesh !== mesh) {
      const visible = VISIBLE_BONES.map(name => mesh.skeleton.bones.findIndex(bone => bone.name === name)).filter(index => index >= 0);
      this.bones = { mesh, skinned: skinnedBones(mesh), visible };
      this.stray?.reset(); this.seen?.forgetPhysics();
    }
    const send = this.report;
    if (send) (this.glitches ??= new MotionGlitchWatch(glitch => send(glitch))).physics(mesh, frame.physicsBones, frame.activities, frame.fps, frame.frameMs);
    // No display guard here: a visible bone's step that departs ≥ 10° from its last step is what the guard would have caught (counted in developer mode too).
    if (send || this.dataset()) {
      (this.seen ??= new MotionGlitchWatch(glitch => {
        this.guard.jumps++; this.guard.maxAngleDeg = Math.max(this.guard.maxAngleDeg, glitch.size); this.guard.lastJump = { property: glitch.name, size: glitch.size };
        send?.({ ...glitch, kind: 'guard' });
      })).physics(mesh, this.bones.visible, frame.activities, frame.fps, frame.frameMs);
    }
    if (frame.grid) return;
    (this.stray ??= new StrayPixelWatch({
      reach: (width, height) => this.reach(width, height),
      inspect: () => this.frame?.mesh ? inspectModel(this.frame.mesh, this.frame.height, this.bones?.skinned) : { part: 'gpu', name: 'gpu' },
      recover: cause => { if (this.frame?.mesh) resendModel(this.frame.mesh, cause); },
      report: report => this.report?.({ kind: 'block', part: report.cause.part, name: report.cause.name, size: report.drawn, cleared: report.cleared,
        activities: this.frame?.activities() ?? ['idle'], fps: this.frame?.fps ?? null, frameMs: null }),
      dataset: () => this.dataset(),
    })).afterRender(frame.gl, frame.canvas);
  }

  private reach(width: number, height: number): StrayBox | null {
    const frame = this.frame, bones = this.bones;
    if (!frame?.mesh || bones?.mesh !== frame.mesh) return null;
    return widenReach(boneReach(frame.mesh, bones.skinned, frame.camera, frame.height, width, height, this.ndc), frame.props(), frame.camera, width, height);
  }

  /** Nothing is drawn (hidden, no model): the next frame has no history to compare with. */
  forget(): void { this.glitches?.forgetPhysics(); this.seen?.forgetPhysics(); }
  /** The WebGL context came back (src/stage/context-recovery.ts): the stray watch's read-back buffer belonged to the old one. */
  contextBack(): void { this.stray?.forgetContext(); }

  /** The stray watch's counts (developer view, tests). */
  get strayStats() { return this.stray?.stats ?? null; }

  dispose(): void { this.stray?.dispose(); this.stray = null; this.frame = null; this.bones = null; }
}
