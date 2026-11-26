// Touch twice (src/stage/jelly/soft-shader.ts jellyUniformsFor, docs/claude/2026-11-23-unbound-step6.md「第二次碰」): after a touch settles
// StageJelly drops its SoftJelly and the next touch builds a new one. three keeps a program per cache key on each material and calls
// onBeforeCompile only when that key has no program yet; the uniforms the program binds are the ones handed over THEN (WebGLRenderer.getProgram,
// three 0.170: `programs.get(key)` found -> no hook call, `materialProperties.uniforms` unchanged). The fake renderer below copies exactly that
// rule (no GL in node), so the test reads "what the GPU would be given" after each touch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3, type Material, type SkinnedMesh, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { StageJelly } from '../src/stage/jelly/stage-jelly';
import { SoftJelly } from '../src/stage/jelly/soft-jelly';
import { jellyUniformsFor, type JellyUniforms } from '../src/stage/jelly/soft-shader';
import { syntheticBody } from './helpers/jelly-body';

const INTO = new Vector3(0, 0, -1);

/** What three does per material: a program per cache key, the hook only for a key without one, uniforms bound at that moment. */
class FakeRenderer {
  private readonly programs = new Map<Material, Map<string, Record<string, { value: unknown }>>>();
  private readonly bound = new Map<Material, Record<string, { value: unknown }>>();
  compiles = 0;
  draw(material: Material): Record<string, { value: unknown }> {
    let byKey = this.programs.get(material);
    if (!byKey) this.programs.set(material, byKey = new Map());
    const key = material.customProgramCacheKey();
    if (!byKey.has(key)) {
      const shader = { vertexShader: '#include <common>\n#include <skinning_vertex>\n', uniforms: {} } as unknown as WebGLProgramParametersWithUniforms;
      material.onBeforeCompile(shader, this as unknown as WebGLRenderer);
      byKey.set(key, shader.uniforms as Record<string, { value: unknown }>);
      this.compiles++;
      this.bound.set(material, shader.uniforms as Record<string, { value: unknown }>);
    }
    return this.bound.get(material)!;
  }
}

const dentOf = (bound: Record<string, { value: unknown }>, region: number) => (bound.shJellyOffset.value as Vector3[])[region].length();

function touchOnce(jelly: StageJelly, mesh: SkinnedMesh, gpu: FakeRenderer, side: -1 | 1) {
  const region = jelly.touchPressKind('cheeks', side, INTO);
  assert.ok(region >= 0, 'the cheek is found');
  let seen = 0;
  for (let i = 0; i < 400 && jelly.softLayer; i++) {
    jelly.frame(mesh, 1 / 60);
    if (jelly.softLayer) for (const material of mesh.material as Material[]) seen = Math.max(seen, dentOf(gpu.draw(material), region));
  }
  return { seen, settled: jelly.softLayer === null };
}

test('a second touch reaches the uniforms the material really uses (the first touch\'s object is kept for the mesh\'s life)', () => {
  const { mesh } = syntheticBody();
  const jelly = new StageJelly();
  jelly.frame(mesh, 1 / 60);
  jelly.configureTouch(true, 2);
  const gpu = new FakeRenderer();
  const first = touchOnce(jelly, mesh, gpu, 1);
  assert.equal(first.settled, true, 'the first touch settles and the layer is dropped');
  assert.ok(first.seen > 0, `first touch shows on the bound uniforms (${first.seen})`);
  const compilesAfterFirst = gpu.compiles;
  const second = touchOnce(jelly, mesh, gpu, 1);
  assert.equal(second.settled, true);
  assert.ok(second.seen > 0.5 * first.seen, `second touch shows on the bound uniforms too (${second.seen} vs ${first.seen})`);
  const third = touchOnce(jelly, mesh, gpu, -1);
  assert.ok(third.seen > 0, 'a third touch, the other cheek, still shows');
  assert.equal(gpu.compiles, compilesAfterFirst, 'no recompile per touch: each material keeps its jelly program (that was the first-touch freeze)');
});

test('every SoftJelly of a mesh uses the same uniforms object, and it starts clean', () => {
  const { mesh } = syntheticBody();
  const a = new SoftJelly(mesh, false);
  a.configureTouch(true, 2);
  a.press(new Vector3().fromArray(a.regions[0].center), INTO);
  for (let i = 0; i < 6; i++) a.update(1 / 60);
  const mine: JellyUniforms = a.uniformValues();
  assert.ok(mine.shJellyOffset.value.some(v => v.lengthSq() > 0), 'the first one left a dent in it');
  a.dispose();
  const b = new SoftJelly(mesh, false);
  assert.equal(b.uniformValues(), mine, 'same object');
  assert.equal(mine.shJellyOffset.value.every(v => v.lengthSq() === 0), true, 'reset: no leftover dent');
  assert.notEqual(jellyUniformsFor({}), mine, 'another mesh has its own');
});
