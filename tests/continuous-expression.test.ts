import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { Bone } from 'three';
import { EyelidCompositor, composeBrows, composeMouthExpression } from '../src/stage/channel-compositors';
import { ContinuousExpression, EXPRESSION_FALL, EXPRESSION_LIMITS, EXPRESSION_RISE, emptyExpression, expressionTargets } from '../src/stage/continuous-expression';
import { ProceduralLife, lifeRig, type LifeGates, type LifeInput, type LifeMood, type LifePort, type LifeRig } from '../src/stage/procedural-life';
import { StageModelProfile } from '../src/stage/model-profile';
import { readPmxLite } from './helpers/pmx-lite';
import { JAPANESE_MORPHS, toThreeMesh, toyModel } from './helpers/model-fixtures';

const DT = 1 / 60;
const still = { smile: 0, brow: 0, lid: 0, blush: 0 };
const blinkPulse = (t: number) => t < 0 || t > 0.16 ? 0 : Math.sin(t / 0.16 * Math.PI) ** 2;

test('eyelid compositor: a soft closure never suppresses the natural blink; lid shapes yield to it and cap it', () => {
  // Contact closure at 0.3 suppresses the blink (unchanged R29 rule)...
  const held = new EyelidCompositor();
  let heldPeak = 0;
  for (let t = 0; t < 0.2; t += DT) heldPeak = Math.max(heldPeak, held.frame(DT, { contact: 0.3, cheek: 0, fatigue: 0, naturalBlink: blinkPulse(t) }).blink);
  assert.equal(heldPeak, 0.3);
  // ...a soft (expression) closure of the same size lets the full blink ride on top: natural blink priority.
  const soft = new EyelidCompositor();
  let softPeak = 0, softHeld = 0;
  for (let t = 0; t < 0.2; t += DT) { const f = soft.frame(DT, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: blinkPulse(t), soft: 0.3 }); softPeak = Math.max(softPeak, f.blink); softHeld = Math.max(softHeld, f.held); }
  assert.ok(softPeak > 0.97, `blink still closes (${softPeak})`); assert.equal(softHeld, 0, 'a soft closure is not held and never postpones a blink');
  assert.equal(new EyelidCompositor().frame(DT, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 0, soft: 0.3 }).blink, 0.3, 'shown on the blink morph');
  // Lid shapes: shown while open, gone at the blink's peak, and they cap the blink morph so the sum never over-closes.
  const shapes = new EyelidCompositor();
  const open = shapes.frame(DT, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 0, smileEyes: 0.2, jitome: 0.1 });
  assert.equal(open.smileEyes, 0.2); assert.equal(open.jitome, 0.1); assert.equal(open.blink, 0);
  const half = shapes.frame(DT, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 0.5, smileEyes: 0.2, jitome: 0.1 });
  assert.equal(half.smileEyes, 0.1); assert.ok(half.blink <= 1 - half.smileEyes);
  const closed = shapes.frame(DT, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 1, smileEyes: 0.2, jitome: 0.1 });
  assert.deepEqual([closed.blink, closed.smileEyes, closed.jitome], [1, 0, 0], 'the blink alone carries a full closure');
  // Old callers see exactly the old result.
  const legacy = new EyelidCompositor().frame(DT, { contact: 0.1, cheek: 0, fatigue: 0, naturalBlink: 0.5, sharedClosure: 0.2 });
  assert.deepEqual(legacy, { blink: 0.1 + 0.9 * 0.5 * (1 - 0.1 / 0.15), closure: 0.1 + 0.9 * 0.5 * (1 - 0.1 / 0.15), held: 0.1, smileEyes: 0, jitome: 0 });
});

test('mouth and brow rules: an expression yields to lip-sync and feeding; brow shapes never stack', () => {
  assert.equal(composeMouthExpression(0.3, 0, 0), 0.3);
  assert.equal(composeMouthExpression(0.3, 1, 0), 0); assert.equal(composeMouthExpression(0.3, 0, 1), 0);
  assert.ok(composeMouthExpression(0.3, 0.5, 0) > 0 && composeMouthExpression(0.3, 0.5, 0) < 0.3, 'cross-faded');
  assert.equal(composeMouthExpression(Number.NaN, Number.NaN, 0), 0);
  const out = { sad: 0, angry: 0 };
  assert.deepEqual(composeBrows(0.2, 0, out), { sad: 0.2, angry: 0 }, 'one request passes unchanged');
  composeBrows(0.2, 0.2, out); assert.ok(Math.abs(out.sad + out.angry - 0.2) < 1e-12, 'two equal requests share one amount');
  composeBrows(0.3, 0.05, out); assert.ok(out.sad > 0.25 && out.angry < 0.01, 'the stronger brow dominates');
  let previous = composeBrows(0.2, 0, { sad: 0, angry: 0 }).sad;
  for (let a = 0.001; a <= 0.2; a += 0.001) { const next = composeBrows(0.2, a, out).sad; assert.ok(Math.abs(next - previous) < 0.002, 'continuous'); previous = next; }
});

test('targets: moods differ, card intensity scales, drowsy shows jitome and a chin-down pitch, blush follows the card switch', () => {
  const happy = expressionTargets({ primary: 'happy' }, 1, 0, 1, still), sad = expressionTargets({ primary: 'sad' }, 1, 0, 1, still);
  assert.ok(happy.smileEyes > 0.1 && happy.mouthSmile > 0.2 && happy.sad === 0 && happy.headX < 0, 'happy: smile, chin slightly up');
  assert.ok(sad.sad > 0.15 && sad.smileEyes === 0 && sad.mouthSmile === 0 && sad.headX > 0, 'sad: troubled brows, chin down');
  const close = expressionTargets({ primary: 'close' }, 1, 0, 1, still);
  assert.ok(close.blush > 0.1, 'close: a warm blush');
  assert.equal(expressionTargets({ primary: 'close' }, 1, 0, 0, still).blush, 0, 'blush off on the card: none');
  const loud = expressionTargets({ primary: 'happy' }, 1.5, 0, 1, still);
  assert.ok(Math.abs(loud.mouthSmile - 1.5 * happy.mouthSmile) < 1e-12, 'intensity.expression scales the face');
  const none = expressionTargets({ primary: 'happy' }, 0, 0, 1, still);
  assert.deepEqual(none, { ...emptyExpression(), headX: 0 });
  const drowsy = expressionTargets({ primary: 'calm' }, 1, 1, 1, still);
  assert.ok(drowsy.jitome > 0.2 && drowsy.headX > 0.015 && drowsy.sad > 0, 'drowsy: half lids, chin down');
  assert.equal(expressionTargets({ primary: 'calm' }, 1, 0, 1, still).jitome, 0, 'awake: no jitome');
  for (const primary of ['calm', 'close', 'content', 'happy', 'excited', 'relieved', 'concerned', 'tense-expectation', 'disappointed', 'upset', 'longing', 'sad', '??'])
    for (const face of [0, 1, 2, 9]) for (const drowsiness of [0, 1]) {
      const t = expressionTargets({ primary, values: { D: 100, O: 100, E: 100, N: 100, C: 100 }, companion: 'wistful' }, face, drowsiness, 5, { smile: 1, brow: 1, lid: 1, blush: 1 });
      for (const key of ['smileEyes', 'mouthSmile', 'sad', 'angry', 'jitome', 'blush'] as const) assert.ok(t[key] >= 0 && t[key] <= EXPRESSION_LIMITS[key], `${primary} ${key}`);
      assert.ok(Math.abs(t.headX) <= 0.025, `${primary} |headX| <= 0.025`);
    }
});

test('smoothing: rises with a 0.35 s and falls with a 0.5 s time constant, one step at most 0.25 s', () => {
  const smooth = new ContinuousExpression(), target = { ...emptyExpression(), mouthSmile: 0.3 };
  let t = 0;
  while (t < EXPRESSION_RISE - 1e-9) { smooth.frame(DT, target); t += DT; }
  assert.ok(Math.abs(smooth.value.mouthSmile - 0.3 * (1 - Math.exp(-1))) < 0.01, `63% at 0.35 s (${smooth.value.mouthSmile})`);
  for (let i = 0; i < 240; i++) smooth.frame(DT, target);
  const top = smooth.value.mouthSmile; target.mouthSmile = 0; t = 0;
  while (t < EXPRESSION_FALL - 1e-9) { smooth.frame(DT, target); t += DT; }
  assert.ok(Math.abs(smooth.value.mouthSmile - top * Math.exp(-1)) < 0.01, `37% left at 0.5 s (${smooth.value.mouthSmile})`);
  const long = new ContinuousExpression(); long.frame(10, { ...emptyExpression(), sad: 0.2 });
  assert.ok(Math.abs(long.value.sad - 0.2 * (1 - Math.exp(-0.25 / EXPRESSION_RISE))) < 1e-9, 'a stalled frame advances at most 0.25 s');
  for (let i = 0; i < 240; i++) long.frame(DT, emptyExpression());
  assert.equal(long.value.sad, 0, 'settles to an exact zero within a few seconds');
});

// ---------------------------------------------------------------- through procedural life

const gates = (patch: Partial<LifeGates> = {}): LifeGates => ({ expressive: true, contact: false, manualPose: false, manualGesture: false, manualHead: false,
  manualExpression: false, manualMouth: false, chatGesture: false, music: false, bodyMotion: false, headOwned: false, authoredFace: false,
  preview: false, adjusting: false, speaking: false, gazeAllowed: true, ...patch });
const mood = (primary: string): LifeMood => ({ primary, companion: null, values: { D: 50, O: 50, E: 50, N: 50, C: 50 }, intensity: { expression: 50, gaze: 50, posture: 50 } });
const gene = toThreeMesh(readPmxLite(new Uint8Array(readFileSync(new URL('../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model/gene.pmx', import.meta.url)))));
const geneProfile = new StageModelProfile(gene, { reviewed: true });
const geneRig: LifeRig<Bone> = lifeRig(gene, geneProfile);
function input(rig: LifeRig<Bone>, patch: Partial<LifeInput<Bone>> = {}, gatePatch: Partial<LifeGates> = {}): LifeInput<Bone> {
  return { enabled: true, owner: rig.owner, seedKey: 'gene-card', rig, mood: mood('happy'), fatigue: null, pointerX: 0, pointerY: 0, breathStrength: 0.5, hasEyes: true,
    blush: { enabled: true, intensity: 35, size: 50 }, gates: gates(gatePatch), ...patch };
}
/** Plays the stage's per-frame order: life, eyelid compositor (blink + R36 requests), then the face writes. */
function face(life: ProceduralLife<Bone>, seconds: number, make: (t: number) => LifeInput<Bone>, feedOwner = 0) {
  const lids = new EyelidCompositor(), writes = new Map<number, number>(), heads: number[] = [];
  const port: LifePort<Bone> = { rotate() {}, head(x) { heads.push(x); }, morph(index, weight) { writes.set(index, weight); } };
  let frame = { blink: 0, closure: 0, held: 0, smileEyes: 0, jitome: 0 };
  for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
    life.frame(DT, make(i * DT));
    writes.clear(); heads.length = 0;
    const o = life.out;
    frame = lids.frame(DT, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 0, soft: o.lidSoft, smileEyes: o.smileEyes, jitome: o.jitome });
    life.applyFace(port, frame, feedOwner); life.applyBody(port);
  }
  return { writes, lids: frame, state: life.getState(), heads };
}

test('R36 on Gene: a happy mood smiles through the compositors, a sad one troubles the brows, drowsy lowers the lids', () => {
  const slots = geneRig.slots;
  const happy = face(new ProceduralLife<Bone>(), 3, () => input(geneRig));
  assert.ok((happy.writes.get(slots.smileEyes) ?? 0) > 0.08, 'smile eyes (笑い)'); assert.ok((happy.writes.get(slots.mouthSmile) ?? 0) > 0.15, 'mouth smile (にっこり)');
  assert.equal(happy.writes.get(slots.sad), undefined); assert.ok(happy.state.output.blush > 0, 'blush amount for the procedural blush');
  assert.deepEqual(happy.state.primitives.expression.skipped, []);
  const sad = face(new ProceduralLife<Bone>(), 3, () => input(geneRig, { mood: mood('sad') }));
  assert.ok((sad.writes.get(slots.sad) ?? 0) > 0.12, 'troubled brows (困る)'); assert.equal(sad.writes.get(slots.mouthSmile), undefined);
  assert.ok(sad.state.primitives.expression.headX > 0.01 && sad.state.primitives.expression.headX <= 0.025, 'tiny chin-down pitch');
  const drowsy = face(new ProceduralLife<Bone>(), 3, () => input(geneRig, { mood: mood('calm'), fatigue: { phase: 'drowsy', F: 0.9, sleeping: false } }));
  assert.ok((drowsy.writes.get(slots.jitome) ?? 0) > 0.15, 'jitome (じと目) through the compositor');
  const asleep = face(new ProceduralLife<Bone>(), 3, () => input(geneRig, { mood: mood('calm'), fatigue: { phase: 'asleep', F: 1, sleeping: true } }, { gazeAllowed: false }));
  assert.equal(asleep.writes.size, 0, 'asleep: a neutral face'); assert.ok(asleep.state.primitives.expression.yielding.includes('sleep'));
});

test('R36 yields: speech owns the mouth, contact and manual expressions own the face, manual head owns the pitch', () => {
  const slots = geneRig.slots, life = new ProceduralLife<Bone>();
  face(life, 3, () => input(geneRig));
  const talking: number[] = [];
  for (let i = 0; i < 90; i++) talking.push(face(life, DT, () => input(geneRig, {}, { speaking: true })).writes.get(slots.mouthSmile) ?? 0);
  assert.ok(talking.at(-1)! < 0.01, `speech owns the mouth (${talking.at(-1)})`);
  for (let i = 1; i < talking.length; i++) assert.ok(talking[i] <= talking[i - 1] + 1e-9, 'fades, never pumps against syllables');
  const back = face(life, 2, () => input(geneRig));
  assert.ok((back.writes.get(slots.mouthSmile) ?? 0) > 0.15, 'returns after speech');
  const fed = face(new ProceduralLife<Bone>(), 3, () => input(geneRig), 1);
  assert.equal(fed.writes.get(slots.mouthSmile), undefined, 'a snack at the mouth owns it');
  assert.ok((fed.writes.get(slots.smileEyes) ?? 0) > 0, 'the eyes still smile');
  for (const gate of ['contact', 'manualExpression', 'authoredFace', 'preview'] as const) {
    const l = new ProceduralLife<Bone>(); face(l, 3, () => input(geneRig));
    const values: number[] = [];
    for (let i = 0; i < 90; i++) values.push(face(l, DT, () => input(geneRig, {}, { [gate]: true })).state.output.mouthSmile);
    for (let i = 1; i < values.length; i++) assert.ok(values[i] <= values[i - 1] + 1e-9 && values[i - 1] - values[i] < 0.02, `${gate}: smooth fade`);
    const after = face(l, 3, () => input(geneRig, {}, { [gate]: true }));
    assert.equal(after.writes.size, 0, `${gate}: face fully yields`);
  }
  const mouthOnly = face(new ProceduralLife<Bone>(), 3, () => input(geneRig, {}, { manualMouth: true }));
  assert.equal(mouthOnly.writes.get(slots.mouthSmile), undefined); assert.ok((mouthOnly.writes.get(slots.smileEyes) ?? 0) > 0);
  const sadHead = (patch: Partial<LifeGates>) => face(new ProceduralLife<Bone>(), 3, () => input(geneRig, { mood: mood('sad') }, patch)).state.primitives.expression.headX;
  assert.ok(sadHead({}) > 0.01); assert.equal(sadHead({ manualHead: true }), 0); assert.equal(sadHead({ music: true }), 0);
  const noBlush = face(new ProceduralLife<Bone>(), 3, () => input(geneRig, { mood: mood('close'), blush: { enabled: false, intensity: 35, size: 50 } }));
  assert.equal(noBlush.state.output.blush, 0, 'the card blush switch wins');
});

test('R36 on other models: English slots work, missing slots are skipped, no rig writes nothing', () => {
  const english = toThreeMesh(toyModel({ names: 'english' }));
  const sparse = toThreeMesh(toyModel({ morphs: JAPANESE_MORPHS.filter(morph => !['笑い', 'じと目', 'にっこり'].includes(morph.name)) }));
  try {
    const englishRig = lifeRig(english, new StageModelProfile(english, { reviewed: false }));
    const run = face(new ProceduralLife<Bone>(), 3, () => input(englishRig));
    assert.ok((run.writes.get(englishRig.slots.mouthSmile) ?? 0) > 0 && (run.writes.get(englishRig.slots.smileEyes) ?? 0) > 0, 'Eye_Smile / Mouth_Smile');
    const sparseRig = lifeRig(sparse, new StageModelProfile(sparse, { reviewed: false }));
    assert.deepEqual([sparseRig.slots.smileEyes, sparseRig.slots.jitome, sparseRig.slots.mouthSmile], [-1, -1, -1]);
    const drowsy = face(new ProceduralLife<Bone>(), 3, () => input(sparseRig, { mood: mood('happy'), fatigue: { phase: 'drowsy', F: 1, sleeping: false } }));
    assert.deepEqual([...drowsy.writes.keys()], [sparseRig.slots.sad], 'only the slot it has (a drowsy brow)');
    assert.equal(drowsy.lids.smileEyes + drowsy.lids.jitome, 0, 'and nothing reaches the eyelid compositor (no blink cap from a missing shape)');
    assert.deepEqual(drowsy.state.primitives.expression.skipped, ['smileEyes', 'mouthSmile', 'jitome']);
    const sadSparse = face(new ProceduralLife<Bone>(), 3, () => input(sparseRig, { mood: mood('sad') }));
    assert.ok((sadSparse.writes.get(sparseRig.slots.sad) ?? 0) > 0.12, 'the slots it has still work');
    const bare = new ProceduralLife<Bone>(), unrigged = face(bare, 2, () => ({ ...input(geneRig), rig: null }));
    assert.equal(unrigged.writes.size, 0);
  } finally { english.geometry.dispose(); sparse.geometry.dispose(); }
});

test('R36 leaves the drowsy lids and nod to an active fatigue presentation (no double drowsiness)', () => {
  const run = (fatigueFace: boolean) => face(new ProceduralLife<Bone>(), 3,
    () => input(geneRig, { mood: mood('calm'), fatigue: { phase: 'drowsy', F: 0.9, sleeping: false } }, { fatigueFace }));
  const own = run(false), shared = run(true);
  assert.ok((own.writes.get(geneRig.slots.jitome) ?? 0) > 0.15 && own.state.primitives.expression.headX > 0.01, 'without a fatigue face: R36 shows it');
  assert.equal(shared.writes.get(geneRig.slots.jitome), undefined, 'no second half-lid');
  assert.equal(shared.state.primitives.expression.headX, 0);
  assert.ok(shared.state.primitives.tilt.yielding.includes('fatigue'));
});
