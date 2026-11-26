/**
 * Unbound v1 step 6 (docs/claude/2026-11-23-unbound-step6.md): the jelly's shader programs are compiled ahead (src/unbound/jelly-warm.ts),
 * so the first soft touch compiles nothing (measured before: a 0.53-1.57 s frozen window when four programs were compiled on the spot).
 * - The copies compile to the same programs as her own materials will with the jelly on: the same cache key, the same hooks, the same shaders.
 * - Her own materials, hooks and uniforms are never touched; the copies are never in her scene.
 * - Warmed once per set of materials; again when the blush or tears swap theirs in; not while nothing can make her soft; never inside a render.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Scene, type Material, type Object3D, type ShaderMaterial, type SkinnedMesh } from 'three';
import { JellyMaterialPatch, createJellyUniforms } from '../src/stage/jelly/soft-shader';
import { JELLY_KEY_SUFFIX, JellyProgramWarmer as Warmer, warmCopy, type WarmRenderer } from '../src/unbound/jelly-warm';

/** The warmer as the figure makes it: with the very patch a touch uses. */
class JellyProgramWarmer extends Warmer {
  constructor(mesh: SkinnedMesh, later?: (run: () => void) => void) { super(mesh, materials => new JellyMaterialPatch(createJellyUniforms()).ensure(materials), later); }
}
import { GENE_PMX, loadPmxMesh } from './helpers/physics-lab-run';

const listOf = (m: Material | Material[]) => (Array.isArray(m) ? m : [m]);
function fakeRenderer() {
  const calls: { scene: Object3D; camera: unknown; target: Scene | null | undefined }[] = [];
  const renderer: WarmRenderer = { compileAsync: async (scene, camera, target) => { calls.push({ scene, camera, target }); return scene; } };
  return { renderer, calls };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
/** Runs her mesh's onBeforeRender the way three does for one draw. */
const drawOnce = (mesh: SkinnedMesh, renderer: WarmRenderer, scene: Scene, camera: PerspectiveCamera) =>
  mesh.onBeforeRender(renderer as never, scene, camera, mesh.geometry, listOf(mesh.material)[0], null as never);

test('Gene: each warm copy has the cache key and hook her own material gets from the jelly patch', async () => {
  const mesh = await loadPmxMesh(GENE_PMX);
  const own = listOf(mesh.material);
  const copies = own.map(warmCopy);
  new JellyMaterialPatch(createJellyUniforms()).ensure(copies);
  const live = new JellyMaterialPatch(createJellyUniforms());
  live.ensure(own); // what a touch does to her own materials
  try {
    own.forEach((material, i) => {
      const copy = copies[i] as ShaderMaterial, mine = material as ShaderMaterial;
      assert.equal(copy.customProgramCacheKey(), mine.customProgramCacheKey(), `material ${i} ${material.name}: the same program cache key`);
      assert.ok(copy.customProgramCacheKey().endsWith(JELLY_KEY_SUFFIX));
      assert.equal(copy.onBeforeCompile.toString(), mine.onBeforeCompile.toString());
      assert.equal(copy.type, mine.type);
      assert.equal(copy.vertexShader, mine.vertexShader); assert.equal(copy.fragmentShader, mine.fragmentShader);
      assert.deepEqual(copy.defines, mine.defines);
      for (const key of ['transparent', 'side', 'alphaTest', 'depthWrite', 'blending', 'toneMapped', 'premultipliedAlpha'] as const) assert.equal(copy[key], mine[key], `${material.name}.${key}`);
      for (const [name, uniform] of Object.entries(mine.uniforms ?? {})) if ((uniform.value as { isTexture?: boolean } | null)?.isTexture) assert.equal(copy.uniforms[name].value, uniform.value, `${name}: her own texture object, nothing new uploaded`);
    });
  } finally { live.unpatch(); }
});

test('a material with its own hook and key (a blush or tears copy) keeps them in the warm copy', async () => {
  const mesh = await loadPmxMesh(GENE_PMX);
  const original = listOf(mesh.material)[0] as ShaderMaterial, blushed = original.clone();
  const prior = original.customProgramCacheKey;
  blushed.onBeforeCompile = (shader) => { shader.vertexShader = `// blush\n${shader.vertexShader}`; };
  blushed.customProgramCacheKey = () => `${prior.call(original)}:soft-hearts-local-blush-v1`;
  const copy = warmCopy(blushed);
  new JellyMaterialPatch(createJellyUniforms()).ensure(copy);
  new JellyMaterialPatch(createJellyUniforms()).ensure(blushed);
  assert.equal(copy.customProgramCacheKey(), blushed.customProgramCacheKey());
  assert.match(copy.customProgramCacheKey(), /:soft-hearts-local-blush-v1:soft-hearts-jelly-v1$/u);
});

test('warming leaves her own materials, hooks and uniforms as they were, and the copies never join her scene', async () => {
  const mesh = await loadPmxMesh(GENE_PMX);
  const scene = new Scene(), camera = new PerspectiveCamera();
  scene.add(mesh);
  const own = listOf(mesh.material) as ShaderMaterial[];
  const before = own.map(m => ({ key: m.customProgramCacheKey(), hook: Object.hasOwn(m, 'onBeforeCompile'), uniforms: Object.keys(m.uniforms ?? {}).sort().join(','), version: m.version }));
  const children = scene.children.length;
  const warmer = new JellyProgramWarmer(mesh, run => run());
  warmer.setWanted(true);
  const { renderer, calls } = fakeRenderer();
  drawOnce(mesh, renderer, scene, camera);
  await settle();
  assert.equal(calls.length, 1, 'one warm');
  assert.equal(calls[0].target, scene, 'compiled against the scene she is drawn in (its lights)');
  assert.notEqual(calls[0].scene, mesh, 'a copy of her mesh, not her');
  const ghost = calls[0].scene as SkinnedMesh;
  assert.equal(ghost.geometry, mesh.geometry); assert.equal(ghost.skeleton, mesh.skeleton);
  assert.ok(listOf(ghost.material).every(m => !own.includes(m as ShaderMaterial) && m.customProgramCacheKey().endsWith(JELLY_KEY_SUFFIX)));
  assert.equal(scene.children.length, children);
  own.forEach((m, i) => {
    assert.equal(m.customProgramCacheKey(), before[i].key);
    assert.equal(Object.hasOwn(m, 'onBeforeCompile'), before[i].hook);
    assert.equal(Object.keys(m.uniforms ?? {}).sort().join(','), before[i].uniforms, 'no jelly uniform bound to her own material by the warm');
    assert.equal(m.version, before[i].version, 'no program change asked of her own material');
  });
  assert.deepEqual(warmer.stats, { warms: 1, materials: own.length, failed: 0 });
  warmer.dispose();
});

test('once per set of materials, again when they are swapped; not while nothing can make her soft; never inside the render', async () => {
  const mesh = await loadPmxMesh(GENE_PMX);
  const scene = new Scene(), camera = new PerspectiveCamera();
  const queued: (() => void)[] = [];
  const warmer = new JellyProgramWarmer(mesh, run => queued.push(run));
  const { renderer, calls } = fakeRenderer();
  drawOnce(mesh, renderer, scene, camera);
  assert.equal(queued.length, 0, 'not wanted: nothing asked');
  warmer.setWanted(true);
  drawOnce(mesh, renderer, scene, camera); drawOnce(mesh, renderer, scene, camera);
  assert.equal(queued.length, 1, 'one asked, however many draws');
  assert.equal(calls.length, 0, 'nothing compiled inside the render');
  queued.shift()!(); await settle();
  assert.equal(calls.length, 1);
  drawOnce(mesh, renderer, scene, camera);
  assert.equal(queued.length, 0, 'the same materials: warmed already');
  // The blush (or tears) swaps a copy of the face material in.
  const swapped = listOf(mesh.material).slice(); swapped[0] = swapped[0].clone(); mesh.material = swapped;
  drawOnce(mesh, renderer, scene, camera);
  queued.shift()!(); await settle();
  assert.equal(calls.length, 2, 'warmed again for the new set');
  // A touch is on (her own materials carry the jelly now): their programs exist, nothing to warm.
  const live = new JellyMaterialPatch(createJellyUniforms()); live.ensure(mesh.material);
  mesh.material = listOf(mesh.material).slice();
  drawOnce(mesh, renderer, scene, camera);
  assert.equal(queued.length, 0);
  live.unpatch();
  warmer.dispose();
});

test('dispose puts her render hook back (a layer that wrapped it meanwhile keeps working) and lets the copies go', async () => {
  const mesh = await loadPmxMesh(GENE_PMX);
  const original = mesh.onBeforeRender;
  const warmer = new JellyProgramWarmer(mesh, run => run());
  assert.notEqual(mesh.onBeforeRender, original);
  warmer.setWanted(true);
  const { renderer } = fakeRenderer();
  drawOnce(mesh, renderer, new Scene(), new PerspectiveCamera());
  await settle();
  const disposed: string[] = [];
  const copies = (warmer as unknown as { copies: Material[] }).copies;
  copies.forEach(m => m.addEventListener('dispose', () => disposed.push(m.name)));
  warmer.dispose();
  assert.equal(mesh.onBeforeRender, original);
  assert.equal(disposed.length, copies.length);
  // A hook installed over the warmer's stays; the warmer's own part is then a no-op.
  const second = new JellyProgramWarmer(mesh, run => run());
  let called = 0; const wrapped = mesh.onBeforeRender; mesh.onBeforeRender = function (...args) { called++; wrapped.apply(this, args); };
  second.dispose();
  drawOnce(mesh, renderer, new Scene(), new PerspectiveCamera());
  assert.equal(called, 1);
});
