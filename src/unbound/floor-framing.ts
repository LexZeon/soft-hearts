/**
 * Full-screen Unbound: the page's world camera follows her depth (shared/unbound/framing/floor.ts; docs/claude/2026-11-21-unbound-floor-line.md).
 *
 * The host sends one eye height (its home fit, shared/unbound/world.ts eyeHeightFor); the page frames her with its own: every frame, right after
 * her body's frame and before anything draws, hit-tests or places with the camera, `follow()` takes the eye height for where her root stands now (her walks, a pull, a peek's walk to the lens)
 * and the camera is applied with it. Her root moves smoothly, so the eye does too, with no filter in the way (her feet stay on the line
 * while she walks). Only a jump in where she is (another model, another place, another screen) is bridged: the difference eases out on a
 * critically damped spring (FLOOR_FRAMING_KNOBS.followRate), never shown in one frame.
 *
 * Everything on the page that projects (hit testing, her bubble, her gaze, the hands, the near plane, the pull's body follow) reads this
 * camera in the same frame. The pull's floor mapping keeps the camera of its press (pull-input.ts), so a drag reads the same way it did.
 *
 * I-203: a kiss may ask the eye to dip a few centimetres (the viewer leaning in to meet her: the close-up camera sits above the height her face
 * can reach). The dip asked (`follow's dipM`, clamped to DIP_MAX_M) is followed on a critically damped spring, so it eases in and out and a
 * performance that ends mid-dip never shows a jump.
 */
import type { PerspectiveCamera } from 'three';
import type { UnboundWorld } from '../../shared/unbound/scene';
import type { Frustum } from '../../shared/unbound/world';
import { FLOOR_FRAMING_KNOBS, type FloorFramingKnobs } from '../../shared/unbound/framing/knobs';
import { FACE_SHARE_FALLBACK, framedEyeHeight, framingGeometry, type FramingGeometry, type FramingWorld } from '../../shared/unbound/framing/floor';
import { applyWorldCamera } from './camera';
import { nearBodyOf } from './pull-near';

/** The figure as the framing reads it (UnboundFigure). */
export interface FramedFigure {
  readonly rootM: { x: number; z: number };
  readonly heightM: number;
  readonly sense: Parameters<typeof nearBodyOf>[0]['sense'];
}

/** A depth change bigger than this in one frame is a jump (no walk does 0.5 m in a frame), bridged instead of shown. */
const JUMP_M = 0.5;
/** I-203: the most the eye ever dips for a kiss (m), and how quickly the dip follows what is asked (rad/s, critically damped). */
export const DIP_MAX_M = 0.08, DIP_RATE = 10;

export class FloorFraming {
  private eye: number | null = null;
  private offset = 0;
  private offsetVel = 0;
  private lastDepth: number | null = null;
  private geometry: FramingGeometry | null = null;
  private geometryKey = '';
  /** Her face's height, read once per model (her head's middle at her first measured frame, standing). */
  private face: { heightM: number; faceM: number } | null = null;
  /** I-203: the eye's dip now (m) and its speed. */
  private dip = 0;
  private dipVel = 0;
  get dipM(): number { return this.dip; }

  constructor(private readonly camera: PerspectiveCamera, private readonly knobs: FloorFramingKnobs = FLOOR_FRAMING_KNOBS) {}

  /** The eye height the camera has now (null before her first framed frame: the scene's own). */
  get eyeHeightM(): number | null { return this.eye; }
  /** The scene's world with her framed eye height. */
  world(world: UnboundWorld): UnboundWorld { return this.eye === null ? world : { ...world, eyeHeightM: this.eye }; }
  /** applyWorldCamera with her framed eye height. */
  apply(world: UnboundWorld, nearM?: number): Frustum { return applyWorldCamera(this.camera, this.world(world), nearM); }

  /**
   * Every frame, after her body's frame and before anything draws or hit-tests: the eye for where she stands now. Returns the new frustum when the eye moved (the
   * camera is applied), else null.
   */
  follow(dt: number, world: UnboundWorld | null, figure: FramedFigure | null, nearM?: number, dipM = 0): Frustum | null {
    // I-209 (2026-11-25): with others on stage too, her window frames her own body (src/unbound/company/stage-page.ts camera).
    if (!world || !figure || !(figure.heightM > 0) || !Number.isFinite(figure.rootM.z)) return null;
    return this.step(dt, world, -figure.rootM.z, figure.heightM, this.faceOf(figure), dipM) ? this.apply(world, nearM) : null;
  }
  /** Her face's height above her floor (m), once measured (I-209 step 3: her body report). */
  get faceHeightM(): number | null { return this.face?.faceM ?? null; }

  /** One step (tests drive it directly). True when the eye moved. `subject`: whose body (another one: a jump, bridged on the spring). */
  step(dt: number, world: FramingWorld, depthM: number, heightM: number, faceM: number, dipM = 0, subject = ''): boolean {
    const key = `${world.screen.widthM}:${world.screen.heightM}:${JSON.stringify(world.display)}:${JSON.stringify(world.workArea)}:${world.viewerDistanceM}:${heightM}:${faceM}:${subject}`;
    let rebase = false;
    if (key !== this.geometryKey) { this.geometry = framingGeometry(world, this.knobs); this.geometryKey = key; rebase = true; }
    const g = this.geometry;
    if (!g) return false;
    if (this.lastDepth !== null && Math.abs(depthM - this.lastDepth) > JUMP_M) rebase = true;
    this.lastDepth = depthM;
    const target = framedEyeHeight(g, depthM, { heightM, faceM }, this.knobs), before = this.eye;
    if (before === null) { this.eye = target; this.offset = 0; this.offsetVel = 0; return true; }
    if (rebase) this.offset = before - target; // from where the eye is; its speed carries on in offsetVel
    if (dt > 0 && (this.offset !== 0 || this.offsetVel !== 0)) {
      const w = this.knobs.followRate;
      this.offsetVel += (-2 * w * this.offsetVel - w * w * this.offset) * dt;
      this.offset += this.offsetVel * dt;
      if (Math.abs(this.offset) < 1e-5 && Math.abs(this.offsetVel) < 1e-4) { this.offset = 0; this.offsetVel = 0; }
    }
    // I-203: the kiss's dip, eased (never more than DIP_MAX_M, never upward).
    const wantDip = Math.min(DIP_MAX_M, Math.max(0, Number.isFinite(dipM) ? dipM : 0));
    if (dt > 0 && (wantDip !== this.dip || this.dipVel !== 0)) {
      this.dipVel += (-2 * DIP_RATE * this.dipVel - DIP_RATE * DIP_RATE * (this.dip - wantDip)) * dt;
      this.dip += this.dipVel * dt;
      if (Math.abs(this.dip - wantDip) < 1e-5 && Math.abs(this.dipVel) < 1e-4) { this.dip = wantDip; this.dipVel = 0; }
    }
    this.eye = target + this.offset - this.dip;
    return Math.abs(this.eye - before) > 1e-7;
  }

  private faceOf(figure: FramedFigure): number {
    if (this.face && this.face.heightM === figure.heightM) return this.face.faceM;
    const body = nearBodyOf(figure);
    if (!body) return figure.heightM * FACE_SHARE_FALLBACK; // not measured yet: read again next frame
    this.face = { heightM: figure.heightM, faceM: body.headY };
    return body.headY;
  }
}
