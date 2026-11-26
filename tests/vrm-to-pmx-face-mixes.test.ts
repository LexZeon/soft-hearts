/**
 * The converter makes two faces VRoid does not have, as mixes of its own targets (docs/claude/2026-11-19-mumi-pmx-face.md):
 * じと目 (half-lidded eyes: Fcl_EYE_Close x 0.5) and mouthPucker (Fcl_MTH_U + a touch of Fcl_MTH_Small). The names are the stage's own
 * first spellings in MORPH_ALIASES, so the model profile finds them without any guessing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Texture, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { convertVrmToPmx } from '../electron/stage/model-import/vrm/index';
import { defaultMapping, type MappingContext } from '../electron/stage/model-import/vrm/mapping';
import { MORPH_ALIASES } from '../shared/foundation/universal-skeleton';
import { StageModelProfile } from '../src/stage/model-profile';
import { syntheticVrm } from './helpers/synthetic-vrm';

const context = (targets: string[]): MappingContext => ({
  source: { humanoid: {}, expressions: [], colliders: [], colliderGroups: [], springs: [] } as unknown as MappingContext['source'],
  nodeNames: [], targetNames: [], morphTargets: new Set(targets),
});

test('the default mapping mixes the half-lidded eye and the pout from VRoid targets, under the stage\'s names', () => {
  const map = defaultMapping(context(['Fcl_EYE_Close', 'Fcl_MTH_U', 'Fcl_MTH_Small'])).morphs;
  assert.deepEqual(map['じと目'], { from: [{ morph: 'Fcl_EYE_Close', weight: 0.5 }], panel: 'eye' });
  assert.deepEqual(map['mouthPucker'], { from: [{ morph: 'Fcl_MTH_U', weight: 1 }, { morph: 'Fcl_MTH_Small', weight: 0.1 }], panel: 'mouth' });
  // the blink is still the whole of Fcl_EYE_Close; the half-lidded eye does not change it
  assert.deepEqual(map['まばたき'].from, [{ morph: 'Fcl_EYE_Close', weight: 1 }]);
});

test('the names are the stage\'s first alias for the slot, so the profile needs no guess', () => {
  assert.equal('じと目', MORPH_ALIASES.jitome[0]);
  assert.ok(MORPH_ALIASES.mouthPucker.some(alias => alias.toLowerCase() === 'mouthpucker'));
});

test('a model missing part of a mix gets what it has; missing all of it gets nothing; its own morph of that name is kept', () => {
  assert.deepEqual(defaultMapping(context(['Fcl_MTH_U'])).morphs['mouthPucker'].from, [{ morph: 'Fcl_MTH_U', weight: 1 }]);
  assert.equal(defaultMapping(context(['Fcl_MTH_Small'])).morphs['mouthPucker'].from[0].morph, 'Fcl_MTH_Small');
  const none = defaultMapping(context(['Fcl_MTH_A'])).morphs;
  assert.ok(!('じと目' in none) && !('mouthPucker' in none));
  const own = defaultMapping(context(['Fcl_EYE_Close', 'じと目', 'mouthPucker'])).morphs;
  assert.ok(!('じと目' in own) && !('mouthPucker' in own), 'a morph the model already has by that name stays as it is');
});

test('converted: じと目 is a group morph over Fcl_EYE_Close at half, on the eye panel, and the stage profile finds it', async () => {
  const converted = convertVrmToPmx(syntheticVrm());
  assert.equal(converted.report.morphs.mapped['じと目'], 'Fcl_EYE_Close×0.5');
  assert.equal(converted.report.morphs.mapped['まばたき'], 'Fcl_EYE_Close');
  assert.ok(!('mouthPucker' in converted.report.morphs.mapped), 'the synthetic face has no Fcl_MTH_U, so no pout is made up');
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js';
  const { MMDParser } = await import(parserModule as string) as { MMDParser: { Parser: new () => { parsePmx(buffer: ArrayBuffer, leftToRight: boolean): { morphs: { name: string; panel: number; type: number; elements: { index: number; ratio?: number }[] }[] } } } };
  const pmx = new MMDParser.Parser().parsePmx(converted.pmx.slice().buffer, true);
  const half = pmx.morphs.find(m => m.name === 'じと目')!;
  assert.equal(half.type, 0); assert.equal(half.panel, 2); assert.equal(half.elements.length, 1);
  assert.equal(pmx.morphs[half.elements[0].index].name, 'Fcl_EYE_Close'); assert.equal(half.elements[0].ratio, 0.5);
  const loader = new MMDLoader() as unknown as { meshBuilder: { materialBuilder: { _loadTexture: () => Texture }; build(data: unknown, resourcePath: string): SkinnedMesh } };
  loader.meshBuilder.materialBuilder._loadTexture = () => Object.assign(new Texture(), { readyCallbacks: [] });
  const mesh = loader.meshBuilder.build(new MMDParser.Parser().parsePmx(converted.pmx.slice().buffer, true), '');
  const profile = new StageModelProfile(mesh, { reviewed: false });
  assert.equal(profile.summary.found.jitome, 'じと目');
  assert.equal(profile.summary.found.blink, 'まばたき');
});
