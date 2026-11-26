/**
 * I-147 全身果冻, layer 3: the vertex-shader part (docs/claude/2026-11-17-whole-body-jelly.md). Our own code, written for this
 * project; the idea (push vertices by a radius and a falloff exponent, bounded) is from JiggleForge (GPL-3.0-only: ideas only, no
 * code or shader copied; ACKNOWLEDGEMENTS.md).
 *
 * Injected right after three's `skinning_vertex` (so `transformed` is the skinned position in mesh space): per vertex up to SLOTS
 * regions, each `offset[r] · mask · (1 - |position - centre[r]| / radius[r])^falloff[r]`, measured on the bind-pose position. When
 * the weights of a vertex's regions add up to more than 1 they are averaged, so no vertex moves further than the largest offset.
 *
 * The patch wraps the material's own onBeforeCompile and cache key and keeps them; unpatch() puts them back exactly. A wrapper
 * captured by someone else meanwhile (the blush and tears layers clone materials and call the original's hook) turns itself
 * transparent once the patch is gone (`live` false), so after "off" no program carries the jelly code.
 */
import { Vector2, Vector3, type Material, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { MAX_SOFT_REGIONS, SLOTS } from './soft-regions';

export const JELLY_REGION_ATTRIBUTE = 'shJellyRegion';
export const JELLY_WEIGHT_ATTRIBUTE = 'shJellyWeight';
const MARK = '/* soft-hearts jelly v1 */';

export interface JellyUniforms {
  shJellyCenter: { value: Vector3[] };
  shJellyOffset: { value: Vector3[] };
  shJellyShape: { value: Vector2[] };
}

export function createJellyUniforms(): JellyUniforms {
  const fill = <T>(make: () => T) => Array.from({ length: MAX_SOFT_REGIONS }, make);
  return { shJellyCenter: { value: fill(() => new Vector3()) }, shJellyOffset: { value: fill(() => new Vector3()) }, shJellyShape: { value: fill(() => new Vector2(1, 1)) } };
}

/**
 * One uniforms object per mesh for its whole life. three keeps a program per cache key on each material and calls onBeforeCompile only
 * when that key has no program yet; the uniforms it binds are the ones that hook handed over THEN. A touch's SoftJelly is dropped when
 * it settles and the next touch builds a new one, so a fresh object per SoftJelly left the material bound to the first touch's values
 * (the second touch changed uniforms nobody read). Every SoftJelly of a mesh uses this one object instead, reset when it starts.
 */
const uniformsOfMesh = new WeakMap<object, JellyUniforms>();
export function jellyUniformsFor(owner: object): JellyUniforms {
  let uniforms = uniformsOfMesh.get(owner);
  if (!uniforms) uniformsOfMesh.set(owner, uniforms = createJellyUniforms());
  for (const offset of uniforms.shJellyOffset.value) offset.set(0, 0, 0);
  for (const shape of uniforms.shJellyShape.value) shape.set(1, 1);
  return uniforms;
}

const DECLARATIONS = `${MARK}
attribute vec3 ${JELLY_REGION_ATTRIBUTE};
attribute vec3 ${JELLY_WEIGHT_ATTRIBUTE};
uniform vec3 shJellyCenter[${MAX_SOFT_REGIONS}];
uniform vec3 shJellyOffset[${MAX_SOFT_REGIONS}];
uniform vec2 shJellyShape[${MAX_SOFT_REGIONS}];
`;
const BODY = `
{
  vec3 shJellyMove = vec3(0.0);
  float shJellySum = 0.0;
  for (int i = 0; i < ${SLOTS}; i++) {
    float w = ${JELLY_WEIGHT_ATTRIBUTE}[i];
    if (w > 0.0) {
      int r = int(${JELLY_REGION_ATTRIBUTE}[i] + 0.5);
      vec2 shape = shJellyShape[r];
      float u = clamp(1.0 - distance(position, shJellyCenter[r]) / max(shape.x, 1e-5), 0.0, 1.0);
      float f = u > 0.0 ? w * pow(u, shape.y) : 0.0;
      shJellyMove += shJellyOffset[r] * f;
      shJellySum += f;
    }
  }
  transformed += shJellySum > 1.0 ? shJellyMove / shJellySum : shJellyMove;
}
`;

/** The source change alone (tests read it): null when the shader lacks the hooks it needs. */
export function injectJelly(vertexShader: string): string | null {
  if (vertexShader.includes(MARK)) return vertexShader;
  if (!vertexShader.includes('#include <skinning_vertex>') || !vertexShader.includes('#include <common>')) return null;
  return vertexShader.replace('#include <common>', `#include <common>\n${DECLARATIONS}`)
    .replace('#include <skinning_vertex>', `#include <skinning_vertex>\n${BODY}`);
}

interface Patched {
  material: Material;
  onBeforeCompile: Material['onBeforeCompile'];
  customProgramCacheKey: Material['customProgramCacheKey'];
  /** True when this material's own key/hook were set as own properties before the patch (else they came from the prototype). */
  ownHook: boolean;
  ownKey: boolean;
}

export class JellyMaterialPatch {
  private readonly patched: Patched[] = [];
  private readonly seen = new WeakSet<Material>();
  /** Shared by every wrapper this patch made; false after unpatch(), so a captured wrapper does nothing. */
  private readonly state = { live: true };
  /** Materials whose shader lacked the hooks (no jelly there; nothing else changes). */
  unsupported = 0;

  constructor(private readonly uniforms: JellyUniforms) {}

  /** Patches every material not seen yet (cheap to call each frame: clones made by other layers are picked up). */
  ensure(materials: Material | Material[]): void {
    if (!this.state.live) return;
    for (const material of Array.isArray(materials) ? materials : [materials]) {
      if (!material || this.seen.has(material)) continue;
      this.seen.add(material);
      this.patch(material);
    }
  }

  /** Puts every patched material's own hook and key back; programs rebuild without the jelly code. */
  unpatch(): void {
    this.state.live = false;
    for (const entry of this.patched) {
      const target = entry.material as unknown as Record<string, unknown>;
      if (entry.ownHook) target.onBeforeCompile = entry.onBeforeCompile; else delete target.onBeforeCompile;
      if (entry.ownKey) target.customProgramCacheKey = entry.customProgramCacheKey; else delete target.customProgramCacheKey;
      entry.material.needsUpdate = true;
    }
    this.patched.length = 0;
  }

  get count(): number { return this.patched.length; }

  private patch(material: Material): void {
    const state = this.state, uniforms = this.uniforms, self = this;
    const entry: Patched = { material, onBeforeCompile: material.onBeforeCompile, customProgramCacheKey: material.customProgramCacheKey,
      ownHook: Object.hasOwn(material, 'onBeforeCompile'), ownKey: Object.hasOwn(material, 'customProgramCacheKey') };
    const previousHook = entry.onBeforeCompile, previousKey = entry.customProgramCacheKey;
    material.onBeforeCompile = function (this: Material, shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) {
      previousHook.call(this, shader, renderer);
      if (!state.live) return;
      const changed = injectJelly(shader.vertexShader);
      if (changed === null) { self.unsupported++; return; }
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = changed;
    };
    material.customProgramCacheKey = function (this: Material) {
      const base = previousKey.call(this);
      return state.live ? `${base}:soft-hearts-jelly-v1` : base;
    };
    material.needsUpdate = true;
    this.patched.push(entry);
  }
}
