/**
 * I-154 batch 2, row 24 脸红: the companion's painted blush (src/stage/procedural-blush.ts) on the Unbound mesh in the window
 * (docs/claude/2026-11-20-unbound-window-batch2.md). Same anchors, same calibration, same shader patch: the window engine loads her
 * with the same MMD loader, so her face materials are the companion's.
 *
 * The anchors are always measured on her rest pose (as the companion does: sampling an animated head would freeze its turn into the
 * cheeks), so the rest pose is remembered when the model is loaded and put back for the moment of a measurement (a calibration change,
 * the slider's preview), then the pose she had is restored. How much shows each frame is the face's (window-face.ts); this only paints.
 * Batch 6 (row 25): the tear surface too (window-tears.ts): it wraps the blush's materials, so this one owner unwinds and rebuilds both.
 */
import type { Bone, SkinnedMesh, Vector3 } from 'three';
import { ProceduralBlush, probeBlushAnchors, type BlushAnchors } from '../../stage';
import { ProceduralTears, tearsSupport } from '../../mood';
import type { TearsGate } from './window-tears';
import { DEFAULT_BLUSH_CALIBRATION, proceduralBlushDepth, validateBlushCalibration, type BlushCalibration } from '../../../shared/mood';
import { uiText } from '../../foundation/ui-language';

// ui-zh-ok: MMD bone names inside the model file, not interface text
const JAW = ['口', 'あご', '顎', 'jaw', 'Jaw', 'mouth'];

/**
 * I-164 (docs/claude/2026-11-20-vrm-gaps.md): a face spread over several meshes (a VRM: each glTF primitive is its own mesh, the face skin
 * and the eyes apart). The blush and tears are measured on one probe mesh made of those primitives (`mesh` of the painter) and painted on
 * the primitive that holds the cheeks (src/unbound/her/vrm-blush.ts). Absent for an MMD model: the painter works as it always did.
 */
export interface BlushSurface {
  /** The model's own bones, whose rest pose is put back for a measurement. */
  readonly bones: readonly Bone[];
  /** Every mesh whose morphs are put to 0 for a measurement. */
  readonly meshes: readonly SkinnedMesh[];
  /** Brings the probe to where the model is now (after her rest pose was put back, before measuring). */
  prepare(): void;
  /** Anchors measured on the probe → the mesh to paint and the same anchors with that mesh's material indices; null: not one mesh. */
  paintOn(anchors: BlushAnchors): { mesh: SkinnedMesh; anchors: BlushAnchors } | null;
  /** Cheeks from the model's own eyes and mouth, for the pinch, when the probe finds no face. */
  readonly fallbackCheeks: BlushAnchors | null;
}

export class WindowBlush {
  private readonly rest: { bone: Bone; quaternion: Bone['quaternion']; position: Bone['position'] }[];
  private effect: ProceduralBlush | null = null;
  private support = '';
  private disposed = false;
  /** Batch 3 (row 22 捏脸): her cheeks as last measured with the calibration in use (never a preview's), for the pinch's hit region. */
  cheeks: BlushAnchors | null = null;

  /** Made right after the model is loaded, while she is still at rest (her bind pose). */
  /** `mouth`: the profile's measured mouth in head space (another model without a mouth bone), as the companion passes it. */
  constructor(private readonly mesh: SkinnedMesh, readonly head: Bone | null, private readonly eyes: readonly Bone[], private readonly mouth: Vector3 | null = null,
    private readonly surface: BlushSurface | null = null) {
    this.rest = (surface?.bones ?? mesh.skeleton.bones).map(bone => ({ bone, quaternion: bone.quaternion.clone(), position: bone.position.clone() }));
  }

  /** The painted blush is on her face now. */
  get painted(): boolean { return !!this.effect && this.effect.getState().supported; }
  /** Why it is or is not painted (the developer panel and the calibration controls show it). */
  get reason(): string { return this.support; }

  /** (Re)measure the cheeks with this calibration and paint there; `allowed` false (the card picked her own morph, or 能脸红 off): none. */
  build(calibration: BlushCalibration | null, allowed: boolean, preview = false): boolean {
    // Batch 6: the tears wrap the blush's materials: unwound first, put back over the new blush last (the old stage's rebuildBlush).
    this.tears?.dispose(); this.tears = null;
    const painted = this.paint(calibration, allowed, preview);
    this.buildTears();
    return painted;
  }

  private paint(calibration: BlushCalibration | null, allowed: boolean, preview: boolean): boolean {
    this.effect?.dispose(); this.effect = null;
    if (this.disposed) return false;
    if (!this.head) { this.support = uiText('红晕需要可识别头骨与双眼参考点'); return false; }
    const mesh = this.mesh, head = this.head;
    const probe = this.atRest(() => probeBlushAnchors(mesh, head, [...this.eyes], this.jaw(), validateBlushCalibration(calibration ?? DEFAULT_BLUSH_CALIBRATION), this.mouth));
    if (!probe) { if (!preview && this.surface) this.cheeks = this.surface.fallbackCheeks; this.support = uiText('红晕需要可识别头骨与双眼参考点'); return false; }
    this.support = probe.reason;
    // The companion's: the pinch region works even where no blush can be painted (I-164: a VRM's cheeks from its own eyes and mouth then).
    if (!preview) this.cheeks = probe.anchors ?? this.surface?.fallbackCheeks ?? null;
    if (!allowed || !probe.supported || !probe.anchors) return false;
    const target = this.surface ? this.surface.paintOn(probe.anchors) : { mesh, anchors: probe.anchors };
    if (!target) { this.support = uiText('双颊不在同一块脸部网格上，未放置程序红晕'); return false; }
    const effect = new ProceduralBlush(head, target.anchors, target.mesh);
    if (effect.getState().supported) { this.effect = effect; return true; }
    this.support = effect.getState().reason; effect.dispose();
    return false;
  }

  /** A measurement on her rest pose (her bind pose, no morphs), then the pose she had is put back; null if it threw. */
  private atRest<T>(measure: () => T): T | null {
    const mesh = this.mesh, meshes = this.surface?.meshes ?? [mesh];
    const current = this.rest.map(({ bone }) => ({ bone, quaternion: bone.quaternion.clone(), position: bone.position.clone() }));
    const morphs = meshes.map(each => each.morphTargetInfluences?.slice());
    try {
      for (const state of this.rest) { state.bone.quaternion.copy(state.quaternion); state.bone.position.copy(state.position); }
      for (const each of meshes) each.morphTargetInfluences?.fill(0);
      this.restUpdate();
      return measure();
    } catch { return null; }
    finally {
      for (const state of current) { state.bone.quaternion.copy(state.quaternion); state.bone.position.copy(state.position); }
      meshes.forEach((each, k) => { const saved = morphs[k], values = each.morphTargetInfluences; if (saved && values) for (let index = 0; index < saved.length; index++) values[index] = saved[index]; });
      this.restUpdate();
    }
  }
  /** World matrices and skeletons after the pose changed (an MMD mesh: itself; a VRM: its meshes and the probe). */
  private restUpdate(): void {
    const mesh = this.mesh;
    if (!this.surface) { mesh.updateWorldMatrix(true, true); mesh.skeleton.update(); return; }
    this.surface.prepare(); // the whole model's tree (her bones are not under her meshes), then the probe
    for (const each of this.surface.meshes) each.skeleton?.update();
  }
  private jaw(): Bone | undefined {
    if (this.surface) return undefined; // a VRM's jaw bone sits at the jaw joint, not at the mouth: her mouth is measured instead
    return JAW.map(name => this.mesh.skeleton.bones.find(bone => bone.name === name)).find((bone): bone is Bone => !!bone);
  }

  // ---- batch 6, row 25 眼泪 (window-tears.ts): the tear surface on her face ---------------------------------------------------------
  private tears: ProceduralTears | null = null;
  /** The tears' anchors (the default calibration, measured once on her rest pose, as the old stage does); undefined: not yet. */
  private tearsAnchors: BlushAnchors | null | undefined = undefined;
  private tearsGate: TearsGate = { gene: false, card: false, reason: null };
  private tearsWhy = '';
  private tearsShown = { amount: 0, elapsedMs: 0 };

  /** Who may cry on this model (window-tears.ts windowTearsGate, from the card); a change puts the tears on or takes them off. */
  setTearsGate(gate: TearsGate): void {
    if (gate.gene === this.tearsGate.gene && gate.card === this.tearsGate.card && gate.reason === this.tearsGate.reason) return;
    this.tearsGate = { ...gate };
    this.tears?.dispose(); this.tears = null;
    this.buildTears();
  }
  /** The tears are on her face (the crying timeline only starts a cry then). */
  get tearsSupported(): boolean { return this.tears?.getState().supported === true; }
  /** Why tears show or not on this model (the developer line). */
  get tearsReason(): string { return this.tearsWhy; }
  /** The tear surface's own state (the developer readout, window-readouts.ts). */
  get tearsSurface(): unknown { return this.tears?.getState() ?? null; }
  /** This frame's cry (0..1) on its clock (ms): the paint only; the timeline eases it. */
  updateTears(amount: number, elapsedMs: number): void {
    this.tearsShown = { amount, elapsedMs };
    const tears = this.tears;
    if (tears && !tears.getState().supported) { this.tearsWhy = tears.getState().reason; tears.dispose(); this.tears = null; return; }
    tears?.update(amount, elapsedMs);
  }

  private buildTears(): void {
    if (this.tears || this.disposed || !this.head) return;
    const head = this.head;
    if (this.tearsAnchors === undefined) this.tearsAnchors = this.atRest(() => probeBlushAnchors(this.mesh, head, [...this.eyes], this.jaw(), DEFAULT_BLUSH_CALIBRATION).anchors) ?? null;
    const gate = this.tearsGate;
    const support = gate.reason !== null ? { supported: false, reason: gate.reason } : tearsSupport(this.tearsAnchors, gate.gene, gate.card);
    this.tearsWhy = support.reason;
    if (!support.supported || !this.tearsAnchors) return;
    const target = this.surface ? this.surface.paintOn(this.tearsAnchors) : { mesh: this.mesh, anchors: this.tearsAnchors };
    if (!target) { this.tearsWhy = uiText('双颊不在同一块脸部网格上，当前未放置泪痕'); return; }
    const effect = new ProceduralTears(head, target.anchors, target.mesh, gate.gene, gate.card);
    this.tearsWhy = effect.getState().reason;
    if (!effect.getState().supported) { effect.dispose(); return; }
    this.tears = effect;
    effect.update(this.tearsShown.amount, this.tearsShown.elapsedMs);
  }

  /** This frame's blush (0..1, the face's) at the card's size; the paint's own depth curve lifts the light end. */
  update(amount: number, size: number): void { this.effect?.update(proceduralBlushDepth(amount), size); }

  /** Takes the paint off her face (the model goes, the card switches to her own morph). */
  clear(): void { this.tears?.dispose(); this.tears = null; this.effect?.dispose(); this.effect = null; } // the tears wrap the blush: off first
  dispose(): void { this.disposed = true; this.clear(); }
}

/**
 * Batch 3 (row 22 捏脸): the cheeks the pinch's hit region uses, by the companion's rule (src/stage/mmd/camera.ts getInteractionRegion):
 * the anchors measured with the calibration in use, else the profile's estimate; the reviewed Gene's guarded ellipse (eyes, nose and mouth
 * kept out) only while its calibration is the default one.
 */
export function pinchCheeks(measured: BlushAnchors | null, fallback: BlushAnchors | null, reviewedGene: boolean, calibration: BlushCalibration | null): { anchors: BlushAnchors | null; reviewed: boolean } {
  const used = calibration ?? DEFAULT_BLUSH_CALIBRATION;
  const reviewed = reviewedGene && (Object.keys(DEFAULT_BLUSH_CALIBRATION) as (keyof BlushCalibration)[]).every(key => used[key] === DEFAULT_BLUSH_CALIBRATION[key]);
  return { anchors: measured ?? fallback, reviewed };
}

/** What the blush state asks of her face (window-face.ts). */
export interface BlushFace { wantsPainted(): boolean; blushMorph(): number; setPainted(on: boolean): void }

/**
 * What the stage keeps of the blush on the model shown now (split out of window-stage.ts on 2026-11-20, behaviour unchanged): the
 * painter, the saved calibration and the model it is for, what the paint was last built with, the morph the `shy` slot is bound to,
 * and the slider's preview. The face (window-face.ts) decides how much shows each frame; this follows the card and the calibration.
 */
export class WindowBlushState {
  painter: WindowBlush | null = null;
  previewing = false;
  private calibration: { value: BlushCalibration; url: string } | null = null;
  private key = '';
  private bound = Number.NaN;

  /** A model was loaded (its painter, or null): nothing of the last model's blush carries over. */
  attach(painter: WindowBlush | null): void { this.painter = painter; this.key = ''; this.bound = Number.NaN; this.previewing = false; }
  /** The model goes: the paint comes off her face. */
  clear(): void { this.painter?.dispose(); this.painter = null; this.previewing = false; }
  /** The saved calibration for a model. */
  setCalibration(value: BlushCalibration, url: string): void { this.calibration = { value, url }; }
  calibrationFor(modelUrl: string): BlushCalibration | null { return this.calibration?.url === modelUrl ? this.calibration.value : null; }

  /** The blush follows the card: painted on her face, or her own morph, or none (re-measured when the calibration changes). */
  refresh(face: BlushFace, bind: (morph: number) => void, modelUrl: string, force = false): void {
    const want = face.wantsPainted(), calibration = this.calibrationFor(modelUrl);
    const key = JSON.stringify([want, calibration]);
    if (this.painter && (force || key !== this.key)) { this.key = key; face.setPainted(this.painter.build(calibration, want)); }
    const morph = face.blushMorph();
    if (morph !== this.bound) { this.bound = morph; bind(morph); }
  }
}
