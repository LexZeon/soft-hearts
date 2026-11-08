/**
 * I-038 part 4 (docs/claude/2026-11-07-i038-face-effects.md): what is painted on the face — the procedural blush and the
 * tears — finds the cheeks and the eyes by general rules, not by Gene's names.
 *
 * The class of problem seen on a user-supplied model (details only in the private folder), rebuilt here from Gene and
 * synthetic geometry:
 *   - the face material carries no name the probe knows, so the eyes drawn on it were never measured and the eye bones
 *     (deep inside the head) became the reference: the blush slid up onto the lower eyelids, the tears stayed off;
 *   - an eye reference deeper than the mouth tilted the face's "up" axis, and every cheek sample slid toward the eyes.
 * The reviewed Gene keeps exactly the anchors it had (pinned below, taken on the code before this change).
 * R29_REPORT=1 prints the numbers for the record.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Bone, BufferGeometry, Float32BufferAttribute, ShaderMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, UniformsUtils, Vector3 } from 'three';
import { MMDToonShader } from 'three/examples/jsm/shaders/MMDToonShader.js';
import { probeBlushAnchors, type BlushAnchors } from '../src/stage/procedural-blush';
import { ProceduralTears, tearsSupport } from '../src/stage/procedural-tears';
import { StageModelProfile } from '../src/stage/model-profile';
import { drowsyFaceGapNote } from '../src/stage/drowsy-expression';
import { applyMoodEvent, createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodSnapshot } from '../shared/mood';
import { geneStage } from './helpers/gene-stage-harness';
import { loadPublicGeneForTargets } from './public-gene-fixture';

const REPORT = !!process.env.R29_REPORT;
const v = (p: readonly number[]) => new Vector3(p[0], p[1], p[2]);

/**
 * Where the blush belongs: the probe's own rule, 56% of the way from the eye line down to the mouth, measured straight up the
 * head (these heads stand upright, so head-local +y), not along the probe's own axis (which is what goes wrong when it tilts).
 */
function cheekDrop(a: BlushAnchors) {
  const up = new Vector3(0, 1, 0), eyes = v(a.leftEye).add(v(a.rightEye)).multiplyScalar(0.5);
  const height = (p: Vector3) => p.clone().sub(eyes).dot(up) / a.eyeDistance;
  const wanted = height(v(a.mouth)) * 0.56;
  return { left: height(v(a.leftCheek)) - wanted, right: height(v(a.rightCheek)) - wanted, wanted };
}

/** A face sheet (z ~ 1) with the eye bones deep behind it (z = 0.25) and the mouth measured on its surface (a profile mouth). */
function deepEyeFace() {
  const geometry = new BufferGeometry(), positions: number[] = [], normals: number[] = [], indices: number[] = [], weights: number[] = [];
  for (let row = 0; row < 40; row++) for (let column = 0; column < 42; column++) {
    const x = column / 41 * 2.5 - 1.25, y = row / 39 * 2.2 - 0.6;
    positions.push(x, y, 1 - x * x * 0.08 - (y - 0.5) ** 2 * 0.03);
    normals.push(...new Vector3(x * 0.16, (y - 0.5) * 0.06, 1).normalize().toArray()); indices.push(0, 0, 0, 0); weights.push(1, 0, 0, 0);
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4)); geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  geometry.addGroup(0, positions.length / 3, 0);
  const material = new ShaderMaterial({ vertexShader: MMDToonShader.vertexShader, fragmentShader: MMDToonShader.fragmentShader, uniforms: UniformsUtils.clone(MMDToonShader.uniforms) });
  material.name = 'material-0';
  const mesh = new SkinnedMesh(geometry, material), head = new Bone(), left = new Bone(), right = new Bone();
  left.position.set(-0.5, 1, 0.25); right.position.set(0.5, 1, 0.25); head.add(left, right); mesh.add(head);
  mesh.bind(new Skeleton([head, left, right])); mesh.updateWorldMatrix(true, true);
  return { mesh, head, eyes: [left, right], mouth: new Vector3(0, 0.1, 0.97) };
}

test('an eye reference deeper than the mouth no longer slides the blush up toward the eyes', () => {
  const f = deepEyeFace(), probe = probeBlushAnchors(f.mesh, f.head, f.eyes, undefined, {}, f.mouth);
  assert.equal(probe.supported, true, probe.reason); assert.ok(probe.anchors);
  const drop = cheekDrop(probe.anchors);
  if (REPORT) console.log(`deep eyes: cheek height off by ${drop.left.toFixed(3)} / ${drop.right.toFixed(3)} eye distances`);
  assert.ok(Math.abs(drop.left) < 0.05 && Math.abs(drop.right) < 0.05, `cheeks off their place by ${drop.left} / ${drop.right} eye distances`);
  // "up" lies in the face plane: no depth component along the head's forward axis.
  assert.ok(Math.abs(v(probe.anchors.up).z) < 1e-9, `up ${probe.anchors.up}`);
});

async function gene(rename: Record<string, string> = {}) {
  const g = await loadPublicGeneForTargets(), mesh = g.mesh as SkinnedMesh, materials = mesh.material as ShaderMaterial[];
  for (const material of materials) if (Object.hasOwn(rename, material.name)) material.name = rename[material.name];
  const bone = (name: string) => mesh.skeleton.bones.find(value => value.name === name)!;
  mesh.updateWorldMatrix(true, true);
  return { g, mesh, materials, head: bone('頭'), eyes: [bone('左目'), bone('右目')] };
}
const ANCHOR_KEYS = ['leftEye', 'rightEye', 'mouth', 'leftCheek', 'rightCheek', 'leftNormal', 'rightNormal', 'forward', 'up', 'right'] as const;
const anchorsHash = (a: BlushAnchors) => createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0, 16);

test('reviewed Gene: the blush and tear anchors are exactly the ones it had (pinned before this change)', async () => {
  const { g, mesh, head, eyes } = await gene();
  try {
    const probe = probeBlushAnchors(mesh, head, eyes);
    assert.ok(probe.anchors, probe.reason);
    assert.equal(anchorsHash(probe.anchors), '1d64ec51504ea572', JSON.stringify(probe.anchors));
    assert.equal(probe.reason, '主眼几何校准；偏移单位仍为原眼骨距；嘴点按下脸表面比例估算，可校准；已确认脸部材质，使用局部双颊贴色；实际遮挡与大角度表现仍需模型实测');
  } finally { g.close(); }
});

test('a face material with no known name: the eyes drawn on it are measured, the blush lands where named Gene puts it, tears can be placed', async () => {
  const named = await gene(), reference = probeBlushAnchors(named.mesh, named.head, named.eyes).anchors!;
  named.g.close();
  const { g, mesh, materials, head, eyes } = await gene({ '顔': 'material-03' });
  try {
    const probe = probeBlushAnchors(mesh, head, eyes);
    assert.equal(probe.supported, true, probe.reason); assert.ok(probe.anchors);
    const a = probe.anchors;
    if (REPORT) console.log(`renamed face: reference ${a.eyeReference}, surface ${a.surfaceSource}, eye distance ${a.eyeDistance.toFixed(3)} (named ${reference.eyeDistance.toFixed(3)}), `
      + `cheek offset ${Math.max(...ANCHOR_KEYS.slice(3, 5).map(key => v(a[key]).distanceTo(v(reference[key])) / reference.eyeDistance)).toFixed(3)} eye distances`);
    assert.equal(a.eyeReference, 'main-eye-geometry', 'the eyes drawn on the face are measured');
    assert.deepEqual(a.materialIndices.map(index => materials[index].name), ['material-03']);
    for (const key of ['leftEye', 'rightEye', 'leftCheek', 'rightCheek'] as const)
      assert.ok(v(a[key]).distanceTo(v(reference[key])) < reference.eyeDistance * 0.02, `${key} ${a[key]} vs ${reference[key]}`);
    // Another model (not the reviewed Gene) whose card has 能流泪 on: the tears may be placed, on the face only (no Gene cover).
    assert.equal(tearsSupport(a, false, true).supported, true, tearsSupport(a, false, true).reason);
    assert.equal(tearsSupport(a, false, false).supported, false, 'still only with the card');
    const tears = new ProceduralTears(head, a, mesh, false, true);
    assert.equal(tears.getState().supported, true, tears.getState().reason);
    assert.deepEqual(tears.getState().materialIndices, a.materialIndices);
    tears.dispose();
  } finally { g.close(); }
});

test('same face with the mouth measured where its open-mouth shape moves (as the stage passes it): the blush stays on the cheeks', async () => {
  const { g, mesh, head, eyes } = await gene({ '顔': 'material-03' });
  try {
    const profile = new StageModelProfile(mesh, { reviewed: false });
    profile.attachHead(head);
    assert.ok(profile.mouthLocal, 'the profile measured a mouth');
    const probe = probeBlushAnchors(mesh, head, eyes, undefined, {}, profile.mouthLocal);
    assert.ok(probe.anchors, probe.reason);
    const drop = cheekDrop(probe.anchors);
    if (REPORT) console.log(`renamed face, measured mouth: up ${probe.anchors.up.map(value => value.toFixed(3))}, cheek height off by ${drop.left.toFixed(3)} / ${drop.right.toFixed(3)}`);
    assert.equal(probe.anchors.eyeReference, 'main-eye-geometry');
    assert.ok(Math.abs(v(probe.anchors.up).dot(v(probe.anchors.forward))) < 1e-9);
    assert.ok(Math.abs(drop.left) < 0.05 && Math.abs(drop.right) < 0.05, `cheeks off their place by ${drop.left} / ${drop.right}`);
  } finally { g.close(); }
});

test('neither face nor eye material recognisable: the stage paints nothing on the face and says why', async () => {
  const h = await geneStage({ fps: 60, notReviewed: true });
  try {
    for (const material of h.mesh.material as ShaderMaterial[]) if (material.name === '顔' || material.name === '目') material.name = `material-${material.name === '顔' ? 3 : 4}`;
    const before = h.mesh.material;
    h.stage.rebuildBlush();
    assert.equal(h.stage.proceduralBlush, null, 'no blush guessed onto an unknown surface');
    assert.equal(h.stage.proceduralTears, null, 'no tears guessed either');
    assert.equal(h.mesh.material, before, 'the materials are untouched');
    const note = h.stage.getMoodDegradation();
    if (REPORT) console.log(`renamed face and eyes: ${note}`);
    assert.match(note, /脸颊/); assert.match(note, /泪/);
    // Tears without measured eyes stay off even where a cheek surface exists (the eye bones alone are not where the eyes are drawn).
    const { g, mesh, head, eyes } = await gene({ '目': 'material-04' });
    try {
      const probe = probeBlushAnchors(mesh, head, eyes);
      assert.ok(probe.anchors, probe.reason); assert.equal(probe.anchors.eyeReference, 'eye-bones');
      const support = tearsSupport(probe.anchors, false, true);
      assert.equal(support.supported, false); assert.match(support.reason, /双眼展示位置/);
    } finally { g.close(); }
  } finally { h.close(); }
});

/** One accepted reunion after a long absence on the real frame loop, on Gene whose face material has no known name. */
async function reunion(fps: number, tears: boolean) {
  const h = await geneStage({ fps, notReviewed: true });
  try {
    for (const material of h.mesh.material as ShaderMaterial[]) if (material.name === '顔') material.name = 'material-03';
    if (tears) h.stage.rebuildBlush(); // the stage's own probe and card gate (tearsVerifiedGene is false here)
    const surface = tears ? h.stage.proceduralTears : null;
    if (tears) assert.equal(surface?.getState().supported, true, h.stage.tearsReason);
    h.run(1);
    const now = Date.now(), parameters = structuredClone(DEFAULT_MOOD_PARAMETERS), initial = createMoodState(now, parameters);
    initial.lastInteractionAt = now - parameters.longing.graceMs - 86 / parameters.longing.perHour * 3_600_000;
    const state = applyMoodEvent(initial, { type: 'chat', id: 'i038-reunion', context: 'neutral' }, now, parameters);
    const snapshot = getMoodSnapshot(state, now, parameters);
    h.stage.setMood({ characterId: 'gene', token: 'gene_token', revision: 2, developerMode: false, expressions: true, parameters, snapshot });
    const start = h.shown.length - 1, amounts: number[] = [];
    h.run(parameters.longing.cryDurationMs / 1000 + 1, () => { amounts.push(surface?.getState().amount ?? 0); });
    amounts.push(surface?.getState().amount ?? 0);
    const frames = h.shown.slice(start);
    return { amounts, catches: frames.filter((frame, index) => index && frame.guardJumps !== frames[index - 1].guardJumps).map(frame => frame.guardLast) };
  } finally { h.close(); }
}

for (const fps of [60, 30]) {
  test(`R29: tears on a face material with no known name fade in and out on the real frame loop at ${fps} fps, no guard catch`, async () => {
    const { amounts, catches } = await reunion(fps, true), control = await reunion(fps, false);
    const shown = amounts.slice(1), steps = shown.slice(1).map((value, index) => Math.abs(value - shown[index]));
    const firstVisible = shown.find(value => value > 0) ?? 0, lastVisible = [...shown].reverse().find(value => value > 0) ?? 0, maxStep = Math.max(...steps);
    if (REPORT) console.log(`I-038 tears ${fps} fps: frames shown ${shown.filter(value => value > 0).length}, peak ${Math.max(...shown).toFixed(3)}, max step ${maxStep.toFixed(4)}, `
      + `first ${firstVisible.toFixed(4)}, last ${lastVisible.toFixed(4)}, end ${shown.at(-1)}, catches ${JSON.stringify(catches)} (without tears ${JSON.stringify(control.catches)})`);
    assert.ok(Math.max(...shown) > 0.95, 'the cry reaches its peak');
    assert.equal(shown.at(-1), 0);
    assert.ok(firstVisible < 0.05 && lastVisible < 0.05, `no pop (first ${firstVisible}, last ${lastVisible})`);
    assert.ok(maxStep <= 1.5 / (0.65 * fps) + 0.01, `amount step ${maxStep}`);
    assert.deepEqual(catches, control.catches); assert.deepEqual(catches, []);
  });
}

test('困的脸 on a model with only half-lowered lids: it shows that half and the developer note names the missing brow', async () => {
  assert.equal(drowsyFaceGapNote({ brow: 68, eye: 95 }), '');
  assert.equal(drowsyFaceGapNote({ brow: -1, eye: 7 }), '困的脸缺皱眉表情：只做半闭眼');
  assert.equal(drowsyFaceGapNote({ brow: 3, eye: -1 }), '困的脸缺半闭眼表情：只做皱眉');
  const h = await geneStage({ fps: 60, drowsy: true });
  try {
    Object.assign(h.stage, { tearsVerifiedGene: false, sadIndex: -1 }); // another model, no troubled-brow slot
    h.run(2);
    const shown = h.shown.at(-1)!;
    assert.ok(shown.jitome > 0.02, `the half-lowered lids still show (${shown.jitome})`);
    assert.match(h.stage.getMoodDegradation(), /困的脸缺皱眉表情：只做半闭眼/);
    Object.assign(h.stage, { tearsVerifiedGene: true });
    assert.doesNotMatch(h.stage.getMoodDegradation(), /困的脸缺/, 'the reviewed Gene says nothing new');
  } finally { h.close(); }
});
