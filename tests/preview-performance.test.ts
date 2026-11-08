import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Euler, Quaternion, type Bone } from 'three';
import { EyelidCompositor } from '../src/stage/channel-compositors';
import { PERFORMANCE_LIMITS, PREVIEW_PERFORMANCE_MS, emptyPerformance, previewPerformance } from '../src/stage/preview-performance';
import { surpriseSample } from '../src/stage/surprise-preview-overlay';
import { ProceduralLife, lifeRig, type LifeGates, type LifeInput, type LifePort, type LifeRig } from '../src/stage/procedural-life';
import { StageModelProfile } from '../src/stage/model-profile';
import { SHY_CLIP_ID, SURPRISE_CLIP_ID } from '../shared/surprise-preview';
import { readPmxLite } from './helpers/pmx-lite';
import { toThreeMesh, toyModel } from './helpers/model-fixtures';

const DT = 1 / 60;
const frames = Math.ceil(PREVIEW_PERFORMANCE_MS / (DT * 1000));
const trace = (clip: string, hasEyes = true) => Array.from({ length: frames }, (_, i) => ({ ...previewPerformance(clip, i * DT * 1000, hasEyes) }));
const peak = (rows: ReturnType<typeof trace>, key: keyof ReturnType<typeof emptyPerformance>) => rows.reduce((max, row) => Math.abs(row[key]) > Math.abs(max) ? row[key] : max, 0);

test('shy: lowered gaze and lids, chin down and turned away, blush rising, a small closed smile; bounded, smooth, back to zero', () => {
  const shy = trace(SHY_CLIP_ID);
  assert.ok(peak(shy, 'headX') > 0.06, 'head pitches down'); assert.ok(peak(shy, 'headY') > 0.07, 'and turns away, toward the side the frozen curve tilts');
  assert.ok(surpriseSample(900, SHY_CLIP_ID)!.head_z_degrees < 0 && peak(shy, 'eyeYaw') > 0, 'eyes follow the turn');
  assert.ok(peak(shy, 'eyePitch') > 0.08, 'eyes drop'); assert.ok(peak(shy, 'lidSoft') > 0.25, 'half-lowered lid request');
  assert.ok(peak(shy, 'blush') > 0.5, 'blush rises'); assert.ok(peak(shy, 'mouthSmile') > 0.3, 'closed smile');
  assert.equal(peak(shy, 'mouthOpen'), 0, 'the mouth stays closed');
  for (const key of Object.keys(PERFORMANCE_LIMITS) as (keyof typeof PERFORMANCE_LIMITS)[]) {
    for (const row of shy) assert.ok(Math.abs(row[key]) <= PERFORMANCE_LIMITS[key], key);
    assert.equal(shy[0][key], 0, `${key} starts at rest`);
    assert.ok(Math.abs(previewPerformance(SHY_CLIP_ID, 1765, true)[key]) < 1e-9, `${key} back at rest before the clip ends`);
    for (let i = 1; i < shy.length; i++) assert.ok(Math.abs(shy[i][key] - shy[i - 1][key]) < 0.035, `${key} is smooth at 60 fps`);
  }
  // The new tracks come after the frozen startle: the eyes widen first, then drop and lower.
  const wide = (ms: number) => surpriseSample(ms, SHY_CLIP_ID)!.eye_wide;
  assert.ok(wide(280) > 0.04 && previewPerformance(SHY_CLIP_ID, 280, true).lidSoft === 0, 'startle first');
  assert.ok(previewPerformance(SHY_CLIP_ID, 900, true).lidSoft > 0.25, 'then lowered lids');
  // Without eye bones the lowered gaze becomes a deeper lid request.
  const noEyes = trace(SHY_CLIP_ID, false);
  assert.equal(peak(noEyes, 'eyePitch'), 0); assert.ok(peak(noEyes, 'lidSoft') >= peak(shy, 'lidSoft'));
});

test('surprise: the chin lifts and the mouth opens a small "o"; unknown clips and times give nothing', () => {
  const surprise = trace(SURPRISE_CLIP_ID);
  assert.ok(peak(surprise, 'headX') < -0.03, 'chin up'); assert.ok(peak(surprise, 'mouthOpen') > 0.15, 'small o');
  assert.equal(peak(surprise, 'blush'), 0); assert.equal(peak(surprise, 'lidSoft'), 0);
  for (const [clip, ms] of [['other', 500], [SHY_CLIP_ID, -1], [SHY_CLIP_ID, 1800], [SHY_CLIP_ID, Number.NaN], [null, 500]] as const)
    assert.deepEqual(previewPerformance(clip, ms, true), emptyPerformance());
});

// ---------------------------------------------------------------- through procedural life and the compositors

const gates = (patch: Partial<LifeGates> = {}): LifeGates => ({ expressive: true, contact: false, manualPose: false, manualGesture: false, manualHead: false,
  manualExpression: false, manualMouth: false, chatGesture: false, music: false, bodyMotion: false, headOwned: false, authoredFace: false,
  preview: true, adjusting: false, speaking: false, gazeAllowed: true, ...patch });
const gene = toThreeMesh(readPmxLite(new Uint8Array(readFileSync(new URL('../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model/gene.pmx', import.meta.url)))));
const geneRig: LifeRig<Bone> = lifeRig(gene, new StageModelProfile(gene, { reviewed: true }));
function input(rig: LifeRig<Bone>, clip: string | null, ms: number, patch: Partial<LifeInput<Bone>> = {}, gatePatch: Partial<LifeGates> = {}): LifeInput<Bone> {
  return { enabled: true, owner: rig.owner, seedKey: 'gene-card', rig, mood: { primary: 'calm' }, fatigue: null, pointerX: 0, pointerY: 0, breathStrength: 0.5,
    hasEyes: true, blush: { enabled: true, intensity: 35, size: 50 }, previewClip: clip, previewElapsedMs: ms, previewBlocked: false, gates: gates(gatePatch), ...patch };
}
interface Played { head: number[]; eye: number[]; blink: number[]; blush: number[]; smile: number[]; open: number[]; writes: Map<number, number>[] }
/** The stage's order within one frame: life, eyelid compositor, face writes, then the preview's head and eyes. */
function play(life: ProceduralLife<Bone>, rig: LifeRig<Bone>, clip: string, make: (ms: number) => LifeInput<Bone>, seconds = 2, warm = 1): Played {
  const lids = new EyelidCompositor(), euler = new Euler(), q = new Quaternion();
  const result: Played = { head: [], eye: [], blink: [], blush: [], smile: [], open: [], writes: [] };
  const head = { name: 'head', quaternion: new Quaternion() } as unknown as Bone, eye = { name: 'eye', quaternion: new Quaternion() } as unknown as Bone;
  let writes = new Map<number, number>();
  const port: LifePort<Bone> = { rotate(bone, x, y, z) { bone?.quaternion.multiply(q.setFromEuler(euler.set(x, y, z, 'YXZ'))); }, head() {}, morph(index, weight) { writes.set(index, weight); } };
  for (let i = 0; i < warm * 60; i++) life.frame(DT, { ...make(Number.NaN), previewClip: null });
  for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
    const ms = i * DT * 1000, frame = make(ms);
    life.frame(DT, ms < PREVIEW_PERFORMANCE_MS ? frame : { ...frame, previewClip: null });
    writes = new Map();
    const o = life.out, f = lids.frame(DT, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 0, soft: o.lidSoft, smileEyes: o.smileEyes, jitome: o.jitome });
    life.applyFace(port, f, 0);
    head.quaternion.identity(); eye.quaternion.identity();
    if (ms < PREVIEW_PERFORMANCE_MS) life.applyPreview(port, head, [eye], true, true);
    result.head.push(2 * Math.atan2(head.quaternion.x, head.quaternion.w)); result.eye.push(2 * Math.atan2(eye.quaternion.x, eye.quaternion.w));
    result.blink.push(f.blink); result.blush.push(o.blush);
    result.smile.push(writes.get(rig.slots.mouthSmile) ?? 0); result.open.push(writes.get(rig.slots.mouthOpen) ?? 0); result.writes.push(writes);
  }
  void clip;
  return result;
}
const max = (values: number[]) => Math.max(...values);

test('shy preview on Gene: downward pitch, lowered eyes, an eyelid request through the compositor, blush and a closed smile', () => {
  const life = new ProceduralLife<Bone>();
  const shy = play(life, geneRig, SHY_CLIP_ID, ms => input(geneRig, SHY_CLIP_ID, ms), 2.4);
  assert.ok(max(shy.head) > 0.06, `head pitch down (${max(shy.head)})`);
  assert.ok(max(shy.eye) > 0.08, 'eyes look down');
  assert.ok(max(shy.blink) > 0.25 && max(shy.blink) < 0.35, `half-lowered lids on the blink morph (${max(shy.blink)})`);
  assert.ok(max(shy.blush) > 0.4, 'blush rises'); assert.ok(max(shy.smile) > 0.3, 'closed smile on にっこり');
  assert.equal(max(shy.open), 0);
  assert.equal(shy.blink.at(-1), 0); assert.equal(shy.blush.at(-1), 0); assert.equal(shy.head.at(-1), 0);
  const state = life.getState().primitives;
  assert.equal(state.preview, null, 'the preview record clears after the clip');
  assert.deepEqual(state.expression.yielding, ['preview'], 'continuous expression stands aside during previews');
  // A natural blink still wins over the soft lid request.
  const lids = new EyelidCompositor(), mid = new ProceduralLife<Bone>();
  for (let i = 0; i < 60; i++) mid.frame(DT, input(geneRig, null, 0));
  for (let ms = 0; ms <= 900; ms += DT * 1000) mid.frame(DT, input(geneRig, SHY_CLIP_ID, ms));
  assert.equal(lids.frame(DT, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 1, soft: mid.out.lidSoft }).blink, 1);
});

test('surprise preview on Gene: chin up and a small "o" that yields to speech', () => {
  const surprise = play(new ProceduralLife<Bone>(), geneRig, SURPRISE_CLIP_ID, ms => input(geneRig, SURPRISE_CLIP_ID, ms));
  assert.ok(Math.min(...surprise.head) < -0.03, 'chin up'); assert.ok(max(surprise.open) > 0.15, 'small o on お');
  assert.equal(max(surprise.blush), 0);
  const talking = play(new ProceduralLife<Bone>(), geneRig, SURPRISE_CLIP_ID, ms => input(geneRig, SURPRISE_CLIP_ID, ms, {}, { speaking: true }));
  assert.ok(max(talking.open) < 0.01, 'lip-sync owns the mouth'); assert.ok(Math.min(...talking.head) < -0.03, 'the head still moves');
});

test('preview additions yield: contact, the preview gate, a picked expression, a toggle off; a cut preview fades its face', () => {
  const blocked = play(new ProceduralLife<Bone>(), geneRig, SHY_CLIP_ID, ms => input(geneRig, SHY_CLIP_ID, ms, { previewBlocked: true }));
  assert.equal(max(blocked.blink) + max(blocked.blush) + max(blocked.smile) + max(blocked.head), 0, 'blocked preview adds nothing');
  const touched = play(new ProceduralLife<Bone>(), geneRig, SHY_CLIP_ID, ms => input(geneRig, SHY_CLIP_ID, ms, {}, { contact: true }));
  assert.equal(max(touched.blink) + max(touched.blush) + max(touched.smile), 0);
  const picked = play(new ProceduralLife<Bone>(), geneRig, SHY_CLIP_ID, ms => input(geneRig, SHY_CLIP_ID, ms, {}, { manualExpression: true }));
  assert.equal(max(picked.blink) + max(picked.blush), 0); assert.ok(max(picked.head) > 0.06, 'the head part keeps its own owner gate (stage)');
  const off = play(new ProceduralLife<Bone>(), geneRig, SHY_CLIP_ID, ms => input(geneRig, SHY_CLIP_ID, ms, { enabled: false }));
  assert.equal(max(off.blink) + max(off.blush) + max(off.head) + max(off.smile), 0, 'toggle off: the original preview only');
  // Cut at 900 ms (e.g. a touch cancels the preview): the face fades over ~0.3 s instead of popping.
  const cut = play(new ProceduralLife<Bone>(), geneRig, SHY_CLIP_ID, ms => input(geneRig, ms < 900 ? SHY_CLIP_ID : null, ms));
  const at = Math.round(0.9 / DT);
  assert.ok(cut.blush[at] > 0.3 && cut.blush[at] - cut.blush[at + 1] < 0.08, 'no pop');
  assert.equal(cut.blush[at + Math.ceil(0.3 / DT) + 1], 0, 'gone after the fade'); assert.equal(cut.head[at + 1], 0, 'bones stop with the preview (the guard bridges them)');
});

test('preview additions on another model: profile slots and bones, no eye bones -> deeper lids', () => {
  const toy = toThreeMesh(toyModel({ names: 'english', eyeBones: false }));
  try {
    const rig = lifeRig(toy, new StageModelProfile(toy, { reviewed: false }));
    const shy = play(new ProceduralLife<Bone>(), rig, SHY_CLIP_ID, ms => input(rig, SHY_CLIP_ID, ms, { hasEyes: false }));
    assert.ok(max(shy.blink) >= 0.3, `lids carry the lowered gaze (${max(shy.blink)})`);
    assert.ok(max(shy.smile) > 0.3, 'Mouth_Smile'); assert.ok(max(shy.head) > 0.06);
  } finally { toy.geometry.dispose(); }
});
