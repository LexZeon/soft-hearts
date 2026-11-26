/**
 * I-154 batch 1, rows 40 + 41「物理」「果冻」in the companion window on Unbound's engine (docs/claude/2026-11-19-unbound-in-window.md).
 *
 * The control window's switches (hair, chest, quality) and the physics lab's live values (the model's tuning, 碰了才软) reach the
 * companion window as one ModelPhysicsSettings through setPhysicsSettings (src/wiring/stage-wiring.ts applyModelPhysicsSettings); this applies them
 * to Unbound's figure the way the old stage does (src/stage/mmd/physics.ts), with the figure's own ports (attachPhysics, configureJelly):
 *  - the settings are taken as given: what the user saved wins, and 碰了才软 is exactly what the host resolved (shared/foundation/
 *    channel-defaults.ts: off in stable unless the user turned it on); nothing here turns anything on by itself. Absent: off;
 *  - the hair and chest physics (LocalModelPhysics, Ammo loaded lazily) starts only while a part is switched on with some strength, the
 *    model supports it and she is shown; switched off it fades out in place (the physics' own fade, never a snap), as on the old stage;
 *  - a load that finishes for a model that has gone, or after the switches changed, is dropped;
 *  - hidden: the physics pauses and the jelly clears (nothing on screen to jump from).
 * Batch 7: the state goes to the stage's onPhysicsState when what the control window's physics form shows changes (publish, as the old stage's
 * publishPhysicsState); as the control window's preview (previewOnly) no physics runs, only the model's support is read.
 * I-152 step 3 (docs/claude/2026-11-21-vrm-physics.md): a VRM brings its own springs (StandardBody.springs, run by present()): the same
 * switches go to them, hidden pauses them, the form shows their support, and no Ammo world is made for its standard skeleton.
 */
import type { Bone, Camera, SkinnedMesh } from 'three';
import { normalizeModelPhysicsSettings, type ModelPhysicsSettings, type ModelPhysicsState } from '../../../shared/stage';
import { buildPhysicsRigPlan, LocalModelPhysics, loadAmmoForEngine, probeModelPhysicsSupport, type AmmoModule, type VrmSpringPhysics } from '../../stage';

/** What this needs of a VRM's springs (src/stage/vrm-spring/vrm-springs.ts). */
export type WindowSprings = Pick<VrmSpringPhysics, 'configure' | 'setVisible' | 'support' | 'running' | 'bones'>;
import { uiText } from '../../foundation/ui-language';

type ModelPhysicsSupport = ModelPhysicsState['support'];

/** What this needs of the figure (src/unbound/figure.ts). */
export interface WindowPhysicsFigure {
  readonly mesh: SkinnedMesh;
  configureJelly(settings: ModelPhysicsSettings): void;
  attachPhysics(physics: LocalModelPhysics | null): void;
  hidePhysics(): void;
}

/** The physics runtime (tests pass the node Ammo). */
export interface WindowPhysicsRuntime {
  loadAmmo(): Promise<AmmoModule>;
  support(mesh: SkinnedMesh): ModelPhysicsSupport;
  make(mesh: SkinnedMesh, ammo: AmmoModule, settings: ModelPhysicsSettings): LocalModelPhysics;
  outputBones(mesh: SkinnedMesh): { hair: readonly number[]; chest: readonly number[] };
}

export const ENGINE_PHYSICS_RUNTIME: WindowPhysicsRuntime = {
  loadAmmo: loadAmmoForEngine,
  support: probeModelPhysicsSupport,
  make: (mesh, ammo, settings) => new LocalModelPhysics(mesh, ammo, settings),
  outputBones: mesh => { const plan = buildPhysicsRigPlan(mesh); return { hair: plan.hair.outputBoneIndices, chest: plan.chest.outputBoneIndices }; },
};

export class WindowPhysics {
  private settingsNow: ModelPhysicsSettings = normalizeModelPhysicsSettings(undefined);
  private figure: WindowPhysicsFigure | null = null;
  private physics: LocalModelPhysics | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private failed = false;
  private support: ModelPhysicsSupport | null = null;
  private outputs: { hair: readonly number[]; chest: readonly number[] } | null = null;
  private shown = true;
  private springs: WindowSprings | null = null;

  constructor(private readonly runtime: WindowPhysicsRuntime = ENGINE_PHYSICS_RUNTIME) {}

  /** The settings as the host sent them (a partial update keeps the last valid values, as on the old stage). */
  set(next: ModelPhysicsSettings): Promise<void> {
    const previous = this.settingsNow;
    this.settingsNow = normalizeModelPhysicsSettings(next, previous);
    const now = this.settingsNow;
    if (previous.hair.enabled !== now.hair.enabled || previous.chest.enabled !== now.chest.enabled) { this.generation++; this.pending = null; this.failed = false; }
    this.physics?.configure(now);
    this.springs?.configure(this.springSettings());
    this.figure?.configureJelly(now);
    return this.ensure();
  }

  /** A new figure (or none): its physics starts from nothing (the old figure disposed its own). `springs`: a VRM's own (null for MMD). */
  attach(figure: WindowPhysicsFigure | null, springs: WindowSprings | null = null): Promise<void> {
    this.figure = figure; this.physics = null; this.outputs = null; this.generation++; this.pending = null; this.failed = false;
    this.springs = figure ? springs : null;
    try { this.support = !figure ? null : this.springs ? this.springs.support() : this.runtime.support(figure.mesh); } catch { this.support = null; }
    this.springs?.configure(this.springSettings());
    figure?.configureJelly(this.settingsNow);
    return this.ensure();
  }
  /** The switches for a VRM's springs: as saved; the control window's preview runs no physics (both parts off there). */
  private springSettings(): ModelPhysicsSettings {
    const s = this.settingsNow;
    return this.previewOnly ? { ...s, hair: { ...s.hair, enabled: false }, chest: { ...s.chest, enabled: false } } : s;
  }

  /** Shown or hidden (the host hid the window, the page is hidden, or it has no size). */
  setShown(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    if (!shown) { this.figure?.hidePhysics(); this.springs?.setVisible(false); } else void this.ensure();
  }

  get settings(): ModelPhysicsSettings { return structuredClone(this.settingsNow); }
  get running(): boolean { return this.physics !== null || this.springsRunning; }
  private get springsRunning(): boolean { return !!this.springs && this.springs.running && !this.previewOnly; }
  /** A VRM's spring bones while they run (for the frame pace: hair still swinging keeps the full pace); null otherwise. */
  springBones(): readonly Bone[] | null { return this.springsRunning ? this.springs!.bones() : null; }

  /** Batch 7: the control window's preview (the old stage's previewOnly): no physics runs; the state still says what the model supports. */
  previewOnly = false;
  private signature = '';
  /** The state for the control window's physics form (the old stage's getPhysicsState without a running world). */
  state(disposed: boolean): ModelPhysicsState {
    const s = this.settingsNow, unavailable = { supported: false, bones: 0, bodies: 0, reason: uiText('载入模型后显示支持情况') };
    const support = this.support ?? { hair: unavailable, chest: unavailable };
    const requested = s.hair.enabled || s.chest.enabled, supported = (s.hair.enabled && support.hair.supported) || (s.chest.enabled && support.chest.supported);
    return { support: structuredClone(support), enabled: { hair: s.hair.enabled, chest: s.chest.enabled }, running: this.running, quality: s.quality,
      bodyCount: 0, constraintCount: 0, steps: 0, liveObjects: 0, avgStepMs: 0,
      status: disposed ? 'disposed' : this.failed ? 'error' : !this.figure || !requested ? 'off' : !this.shown ? 'hidden' : !supported ? 'unsupported'
        : this.running ? 'running' : 'ready' };
  }
  /** The developer readout (canvas data-model-physics, window-readouts.ts): the form's state with the runtime's own numbers and per-part diagnostics. */
  readout(camera: Camera, viewport: { width: number; height: number }): Record<string, unknown> {
    return { ...this.state(false), ...(this.physics?.getState() ?? {}), previewOnly: this.previewOnly, error: this.failed ? 'failed' : '',
      parts: this.physics?.getDiagnostics(camera, viewport) ?? null };
  }
  /** Tells `report` the state when what the form shows changed (support, switches, quality, status), as the old stage's publishPhysicsState. */
  publish(report: ((state: ModelPhysicsState) => void) | undefined, disposed: boolean): void {
    if (!report) return;
    const state = this.state(disposed), signature = JSON.stringify([state.support, state.enabled, state.quality, state.status]);
    if (signature === this.signature) return;
    this.signature = signature;
    try { report(state); } catch { /* the form's own */ }
  }

  /** A part is on with some strength, the model supports it, and she is shown. */
  get wanted(): boolean {
    const s = this.settingsNow, support = this.support;
    return !!this.figure && this.shown && !!support && !this.previewOnly
      && ((s.hair.enabled && s.hair.strength > 0 && support.hair.supported) || (s.chest.enabled && s.chest.strength > 0 && support.chest.supported));
  }

  ensure(): Promise<void> {
    // A VRM's springs are its physics: no Ammo world for its standard skeleton.
    if (this.springs || this.physics || this.pending || this.failed || !this.wanted) return this.pending ?? Promise.resolve();
    const figure = this.figure!, generation = this.generation;
    const pending: Promise<void> = this.runtime.loadAmmo().then(ammo => {
      if (this.figure !== figure || generation !== this.generation || !this.wanted) return;
      // No native world is allocated until its first frame sees the final pose (LocalModelPhysics).
      this.physics = this.runtime.make(figure.mesh, ammo, this.settingsNow);
      figure.attachPhysics(this.physics);
    }).catch(() => { if (this.figure === figure && generation === this.generation) this.failed = true; /* she stands without it, as on the old stage */ })
      .finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }

  /** The bones the physics moves now (for the frame pace: hair still swinging keeps the full pace); null while none runs. */
  outputBones(): readonly number[] | null {
    const figure = this.figure;
    if (!figure || !this.physics) return null;
    if (!this.outputs) { try { this.outputs = this.runtime.outputBones(figure.mesh); } catch { this.outputs = { hair: [], chest: [] }; } }
    const s = this.settingsNow, key = `${s.hair.enabled}|${s.chest.enabled}`;
    if (this.outputKey?.key !== key || this.outputKey.from !== this.outputs) {
      this.outputKey = { key, from: this.outputs, bones: [...(s.hair.enabled ? this.outputs.hair : []), ...(s.chest.enabled ? this.outputs.chest : [])] };
    }
    return this.outputKey.bones;
  }
  private outputKey: { key: string; from: object; bones: readonly number[] } | null = null;
}
