/**
 * Codex T-258 C02 / T-263 C336 input 2 (2026-11-22, docs/claude/2026-11-22-codex-paper-review.md): a model with a separate あ and う but no
 * separate pucker morph. The pout's named pucker 「mouthFunnel|mouth_funnel|う」 is a mouth SHAPE by its first name (stays while she speaks),
 * but it is WRITTEN to the first name the model has, う: the same index lip-sync flaps on. A full pucker there held う at 0.65 under the flap
 * (max of the two), so the lips stopped following the reading openness. The rule: a named shape's role is the role of the morph it lands on,
 * so on such a model the fallback is an opening and yields to lip-sync as the 'u' slot does; a model with its own funnel morph keeps it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, BufferGeometry, MeshBasicMaterial, Skeleton, SkinnedMesh } from 'three';
import { UnboundMouth } from '../src/unbound/mouth';
import { IntentLayer } from '../src/unbound/intent-layer';
import { REST_TARGETS } from '../src/unbound/motion/generator';
import { flapCalibration } from '../shared/behaviors/part-mix/mouth';

const FUNNEL = 'mouthFunnel|mouth_funnel|う';

function layerOn(dictionary: Record<string, number>) {
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.bind(new Skeleton([new Bone()]));
  mesh.morphTargetDictionary = dictionary;
  mesh.morphTargetInfluences = new Array(Object.keys(dictionary).length).fill(0);
  return { mesh, layer: new IntentLayer(mesh) };
}

/** A full pout's named pucker held for 1.5 s with lip-sync owning the opening by `talk`; the layer's morph influences. */
function poutFrame(dictionary: Record<string, number>, talk: number): number[] {
  const { mesh, layer } = layerOn(dictionary);
  layer.set({ ...REST_TARGETS, exprNamed: { [FUNNEL]: 0.65 } });
  for (let k = 0; k < 180; k++) { layer.setMouthTalk(talk); layer.advance(1 / 120); }
  layer.apply(() => {});
  return [...mesh.morphTargetInfluences!];
}

test('no separate pucker: the pucker lands on う and yields to lip-sync (the lips follow the reading openness again)', () => {
  const dictionary = { あ: 0, う: 1 };
  const quiet = poutFrame(dictionary, 0), talking = poutFrame(dictionary, 1);
  assert.ok(quiet[1] > 0.6, `not speaking: the pout shows on う (${quiet[1].toFixed(2)})`);
  assert.ok(talking[1] < 0.05, `speaking: the pucker no longer holds う (${talking[1].toFixed(2)}; before the fix 0.65, a plateau under the flap)`);
  // What the final morph does with two reading openness values: the flap's う (any value) now decides, max(base, flap) is the flap.
  for (const flap of [0.2, 0.5]) assert.equal(Math.max(talking[1], flap), flap, `the flap's う ${flap} is what shows`);
  const a = flapCalibration(0.45), b = flapCalibration(0.9);
  assert.notEqual(a.gain, b.gain, 'and the calibration still sets the flap by the model (the two openness values differ)');
});

test('a model with its own funnel morph keeps the pucker while she speaks (it is a shape there)', () => {
  const dictionary = { あ: 0, う: 1, mouthFunnel: 2 };
  const talking = poutFrame(dictionary, 1);
  assert.ok(talking[2] > 0.6, `the funnel morph stays (${talking[2].toFixed(2)})`);
  assert.ok(talking[1] < 0.05, 'う is left to the flap');
});

test('T-258 C03 naming edge: a model whose only mouth morph is spelled aa still gets its mouth (the vowel table knows it)', () => {
  assert.ok(UnboundMouth.forMesh({ morphTargetDictionary: { aa: 0 }, morphTargetInfluences: [0] }), 'forMesh found あ by the universal aliases, not only the old companion names');
  assert.equal(UnboundMouth.forMesh({ morphTargetDictionary: { eyes: 0 }, morphTargetInfluences: [0] }), null, 'no vowel at all: no mouth');
});
