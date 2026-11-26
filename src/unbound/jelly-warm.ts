/**
 * Unbound v1 step 6 (docs/claude/2026-11-23-unbound-step6.md): the first soft touch no longer freezes her for a second.
 *
 * Measured (scripts/unbound/step6-probe.mjs, the companion window on Unbound's engine, Gene): the first time a touch made her soft (step 5d
 * 「碰了才软」, src/stage/jelly/), four shader programs were compiled on the spot — her hair, face, cheek and pale materials with the jelly
 * code (`…:soft-hearts-jelly-v1`) — and the window showed no new frame for 533 ms to 1.57 s (four runs; never again after that, never
 * without the new programs). The GPU was busy compiling, not her page: no long animation frame covered the gap.
 *
 * So the same programs are compiled ahead, off to the side: copies of her materials with the same jelly patch, on a copy of her mesh that
 * shares her geometry and skeleton, compiled with `compileAsync` (it does not wait on the GPU) against the scene she is drawn in. three
 * keeps a program per cache key for the whole renderer, so when a touch later patches her own materials, their key is the same and the
 * compiled program is picked up: nothing is compiled while you touch her. Her own materials, uniforms and pose are never touched here;
 * the copies are never drawn. They are kept (so the programs stay) until her materials change (the blush and tears layers swap in their
 * own copies when they rebuild) or the model goes, then warmed again.
 *
 * Asked for only while a touch can make her soft (the figure's jelly exists). Started from her mesh's onBeforeRender (where the renderer,
 * scene and camera are known) but run in the next task, never inside a render.
 */
import { SkinnedMesh, type Camera, type Material, type Object3D, type Scene, type WebGLRenderer } from 'three';

/** The suffix the jelly patch adds to a program's cache key (src/stage/jelly/soft-shader.ts). */
export const JELLY_KEY_SUFFIX = ':soft-hearts-jelly-v1';

/**
 * Puts the jelly patch on these materials: `new JellyMaterialPatch(createJellyUniforms()).ensure(materials)` (src/stage/jelly/soft-shader.ts,
 * the very patch a touch uses; the figure hands it in, so this file adds no door into the stage).
 */
export type JellyPatchOn = (materials: Material[]) => void;

/** What of a renderer the warmer needs (tests pass a fake). */
export interface WarmRenderer { compileAsync(scene: Object3D, camera: Camera, targetScene?: Scene | null): Promise<unknown> }

/**
 * A copy of one material that compiles to the same program as the original would with the jelly on: the same type, settings and textures
 * (the original's own texture objects, so nothing new goes to the GPU), the original's own compile hook and cache key when it has them (the
 * blush and tears copies do), then the jelly patch.
 */
export function warmCopy(material: Material): Material {
  const copy = material.clone();
  const own = material as unknown as Record<string, unknown>, target = copy as unknown as Record<string, unknown>;
  const uniforms = (material as unknown as { uniforms?: Record<string, { value: unknown }> }).uniforms;
  const copied = (copy as unknown as { uniforms?: Record<string, { value: unknown }> }).uniforms;
  if (uniforms && copied) for (const [name, uniform] of Object.entries(uniforms)) {
    const value = uniform?.value as { isTexture?: boolean } | unknown[] | undefined;
    if ((value as { isTexture?: boolean } | undefined)?.isTexture) copied[name] = { value };
    else if (Array.isArray(value) && value.some(v => (v as { isTexture?: boolean })?.isTexture)) copied[name] = { value: [...value] };
  }
  if (Object.hasOwn(material, 'onBeforeCompile')) target.onBeforeCompile = own.onBeforeCompile;
  if (Object.hasOwn(material, 'customProgramCacheKey')) target.customProgramCacheKey = own.customProgramCacheKey;
  return copy;
}

const listOf = (material: Material | Material[]): Material[] => Array.isArray(material) ? material : [material];
/** The live materials are already the jelly's (a touch is on): their programs exist, nothing to warm now. */
const patchedNow = (materials: readonly Material[]) => materials.some(m => { try { return String(m.customProgramCacheKey()).endsWith(JELLY_KEY_SUFFIX); } catch { return false; } });

export class JellyProgramWarmer {
  private wanted = false;
  private warmedFor: readonly Material[] | null = null;
  private pending = false;
  private disposed = false;
  private copies: Material[] = [];
  private readonly previous: SkinnedMesh['onBeforeRender'];
  private readonly hook: SkinnedMesh['onBeforeRender'];
  /** How many warms ran and how many programs' materials they compiled (the developer view and tests). */
  readonly stats = { warms: 0, materials: 0, failed: 0 };

  constructor(private readonly mesh: SkinnedMesh, private readonly patchOn: JellyPatchOn, private readonly later: (run: () => void) => void = run => { setTimeout(run, 0); }) {
    this.previous = mesh.onBeforeRender;
    const self = this;
    this.hook = function (this: Object3D, renderer, scene, camera, geometry, material, group) {
      self.previous.call(this, renderer, scene, camera, geometry, material, group);
      self.noticed(renderer as unknown as WarmRenderer, scene, camera);
    };
    mesh.onBeforeRender = this.hook;
  }

  /** On while a touch can make her soft (the figure's jelly exists); off drops nothing already warmed. */
  setWanted(on: boolean): void { this.wanted = on === true; }

  /** Called from her mesh's onBeforeRender: when her materials are not warmed yet, warm them in the next task (never inside the render). */
  noticed(renderer: WarmRenderer, scene: Scene, camera: Camera): void {
    if (!this.wanted || this.pending || this.disposed) return;
    const materials = listOf(this.mesh.material);
    if (this.warmedFor && this.warmedFor.length === materials.length && this.warmedFor.every((m, i) => m === materials[i])) return;
    if (patchedNow(materials) || materials.every(m => m.visible === false)) return; // nothing drawn (a VRM's skeleton carrier): nothing to compile
    this.pending = true;
    this.later(() => { void this.warm(renderer, scene, camera, materials).finally(() => { this.pending = false; }); });
  }

  private async warm(renderer: WarmRenderer, scene: Scene, camera: Camera, materials: readonly Material[]): Promise<void> {
    if (this.disposed) return;
    const now = listOf(this.mesh.material);
    if (now.length !== materials.length || now.some((m, i) => m !== materials[i]) || patchedNow(now)) return; // changed meanwhile: the next render asks again
    let copies: Material[];
    try { copies = materials.map(warmCopy); } catch { this.stats.failed++; this.warmedFor = materials; return; }
    try { this.patchOn(copies); } catch { this.stats.failed++; for (const copy of copies) copy.dispose(); this.warmedFor = materials; return; }
    const ghost = new SkinnedMesh(this.mesh.geometry, Array.isArray(this.mesh.material) ? copies : copies[0]);
    ghost.bind(this.mesh.skeleton, this.mesh.bindMatrix);
    ghost.matrixWorld.copy(this.mesh.matrixWorld);
    ghost.frustumCulled = false;
    try { await renderer.compileAsync(ghost, camera, scene); }
    catch { this.stats.failed++; for (const copy of copies) copy.dispose(); this.warmedFor = materials; return; }
    if (this.disposed) { for (const copy of copies) copy.dispose(); return; }
    for (const old of this.copies) old.dispose(); // the programs stay while her own materials or the new copies use them
    this.copies = copies;
    this.warmedFor = materials;
    this.stats.warms++; this.stats.materials += copies.length;
  }

  /** The model goes: her mesh's hook is put back and the copies are let go. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.mesh.onBeforeRender === this.hook) this.mesh.onBeforeRender = this.previous;
    for (const copy of this.copies) copy.dispose();
    this.copies = [];
  }
}
