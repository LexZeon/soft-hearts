/**
 * Model lab (scripts/model-lab/, docs/claude/2026-11-02-model-lab.md).
 * - Parity: the lab's Node path (three's MMDParser + the MMDLoader-equivalent
 *   lean mesh) gives the stage adapters the same input, profile, collision proxy
 *   and retarget rig/plan as a mesh built by three's real MMDLoader, on Gene and
 *   on a synthetic PMX with every skinning/physics/morph feature the profile reads.
 * - Edge models from bytes: T pose, English names, missing bones, no IK, a
 *   proxy body with hair/skirt, unloadable files, a large model's timing.
 * - Privacy: report folders inside the repository, a git repository or
 *   OneDrive (also through a junction) are refused; nothing is written then.
 * - End to end on Gene through the CLI into a temporary folder (deleted after).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Texture, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import bundled from '../shared/bundled-assets.json';
import { buildModelProfile } from '../shared/model-profile';
import { StageModelProfile, modelProfileInput } from '../src/stage/model-profile';
import { StageMotionRetarget, meshMorphNames, meshRigBones, rigKey } from '../src/stage/motion-retarget';
import { analyzeModel, catalogMotionFiles, type LabMotion, type ModelReport } from '../scripts/model-lab/analyze';
import { loadBundledMotions, runModelLab } from '../scripts/model-lab/cli';
import {
  LabError, REPO_ROOT, assertPrivateReportDir, blockNetwork, isInside, parseLabConfig, privatePathProblem, validModelId, type PathContext,
} from '../scripts/model-lab/guard';
import { labMesh, parsePmx, type PmxData } from '../scripts/model-lab/pmx-mesh';
import { renderModelMarkdown, renderSummaryMarkdown, buildSummary } from '../scripts/model-lab/report';
import { bodyModel } from './helpers/body-fixtures';
import { JAPANESE_MORPHS, toyModel, type ModelData } from './helpers/model-fixtures';
import { pmxFromModelData, writePmx, type PmxWriteModel } from './helpers/pmx-write';

const GENE_PATH = path.join(REPO_ROOT, 'assets/bundled', bundled.root, bundled.model.relativePath);
const geneBytes = () => new Uint8Array(readFileSync(GENE_PATH));
let library: LabMotion[] | null = null;
const motions = () => library ??= loadBundledMotions();

/** The app's mesh: three's real MMDLoader geometry/skeleton builder on the parsed data (materials inert, as the other stage fixtures do). */
function loaderMesh(bytes: Uint8Array): SkinnedMesh {
  const loader = new MMDLoader() as unknown as { meshBuilder: { materialBuilder: { _loadTexture: () => Texture }; build(data: PmxData, path: string): SkinnedMesh } };
  loader.meshBuilder.materialBuilder._loadTexture = () => Object.assign(new Texture(), { readyCallbacks: [] });
  return loader.meshBuilder.build(parsePmx(bytes), '');
}

/** Both meshes feed the stage adapters identically: input (every morph's offsets), profile, proxy, rig and retarget plan. */
function assertSamePath(bytes: Uint8Array, label: string) {
  const lab = labMesh(parsePmx(bytes)), app = loaderMesh(bytes);
  const a = modelProfileInput(lab.mesh), b = modelProfileInput(app);
  assert.deepStrictEqual(a.positions, b.positions, `${label}: positions`);
  assert.deepStrictEqual(a.skinBone, b.skinBone, `${label}: dominant skin bone`);
  assert.deepStrictEqual(a.skinWeights, b.skinWeights, `${label}: full skin weights`);
  assert.deepStrictEqual(a.bones, b.bones, `${label}: bones (rest positions, IK, physics, grants)`);
  assert.deepStrictEqual(a.morphs.map(morph => morph.name), b.morphs.map(morph => morph.name), `${label}: morph names`);
  a.morphs.forEach((morph, index) => assert.deepStrictEqual(morph.offsets(), b.morphs[index].offsets(), `${label}: offsets of morph ${index} (${morph.name})`));
  const profileA = buildModelProfile(a), profileB = buildModelProfile(b);
  assert.deepStrictEqual(profileA, profileB, `${label}: profile`);
  const stageA = new StageModelProfile(lab.mesh, { reviewed: false }), stageB = new StageModelProfile(app, { reviewed: false });
  assert.deepStrictEqual(stageA.profile, stageB.profile, `${label}: stage profile`);
  assert.deepStrictEqual(stageA.summary, stageB.summary, `${label}: stage summary`);
  assert.deepStrictEqual(stageA.indices, stageB.indices); assert.deepStrictEqual([...stageA.scales], [...stageB.scales]);
  assert.deepStrictEqual(meshRigBones(lab.mesh), meshRigBones(app), `${label}: rig bones`);
  assert.deepStrictEqual(meshMorphNames(lab.mesh), meshMorphNames(app), `${label}: rig morph names`);
  assert.equal(rigKey(meshRigBones(lab.mesh), meshMorphNames(lab.mesh)), rigKey(meshRigBones(app), meshMorphNames(app)));
  const retargetA = new StageMotionRetarget(lab.mesh, stageA.profile, { reviewed: false }), retargetB = new StageMotionRetarget(app, stageB.profile, { reviewed: false });
  assert.deepStrictEqual(retargetA.rig, retargetB.rig, `${label}: retarget rig`);
  assert.deepStrictEqual(retargetA.plan, retargetB.plan, `${label}: retarget plan`);
  lab.dispose(); app.geometry.dispose();
  return { profile: profileA, plan: retargetA.plan! };
}

// ---------------------------------------------------------------- parity

test('Gene: the lab path and the MMDLoader path give the same profile input, profile, proxy, rig and plan', () => {
  const { profile, plan } = assertSamePath(geneBytes(), 'gene');
  assert.equal(profile.collision?.capsules.length, 15);
  assert.equal(profile.counts.vertices, 28_646); assert.equal(profile.counts.bones, 224); assert.equal(profile.counts.morphs, 184);
  assert.equal(plan.identity, true, 'Gene as an unreviewed model still plans as identity');
});

/** A synthetic PMX with what Gene lacks: SDEF, BDEF4 with unused (-1) slots, duplicate/empty/group morph names, a joint that retypes a body, grants. */
function featureModel(): PmxWriteModel {
  const body = bodyModel({ dBones: true, skirt: 'bones', hair: 'physics-only' });
  const model = pmxFromModelData(body);
  model.skin = model.skin.map((skin, vertex) => {
    if (skin.deform === 1 && vertex % 3 === 0) return { ...skin, deform: 3 };
    if (skin.deform === 2 && vertex % 2 === 0) return { deform: 2, bones: [...skin.bones.slice(0, 3), -1], weights: [skin.weights[0] + skin.weights[3], skin.weights[1], skin.weights[2], 0] };
    return skin;
  });
  const head = body.bones.findIndex(bone => bone.name === '頭');
  const face = [...Array(body.positions.length / 3).keys()].filter(vertex => body.skinBone[vertex] === head && body.positions[vertex * 3 + 2] > 0.6);
  const mouth = face.filter(vertex => body.positions[vertex * 3 + 1] < 17.5), eyes = face.filter(vertex => body.positions[vertex * 3 + 1] > 17.8 && body.positions[vertex * 3 + 1] < 18.2);
  const vertexMorph = (name: string, indices: number[], dy: number) => ({ name, type: 1 as const, indices: [...indices, indices[0]], deltas: [...indices.flatMap(() => [0, dy, 0.01]), 0, dy / 3, 0] });
  model.morphs = [
    vertexMorph('あ', mouth, -0.3), vertexMorph('あ', eyes, -0.1), vertexMorph('', mouth, -0.2), vertexMorph('い', mouth, -0.05),
    { name: 'お', type: 0, group: [[0, 0.5], [3, 1], [2, 0.25]] }, { name: 'group of group', type: 0, group: [[4, 1]] },
    vertexMorph('まばたき', eyes, -0.12), vertexMorph('5', eyes, 0.02),
  ];
  // Hair bodies are type 2 chains: the joint from the first to the second link makes the loader retype the child to 1.
  const hair = (model.rigidBodies ?? []).map((body, index) => ({ ...body, index })).filter(body => body.type === 2);
  model.joints = [{ a: hair[0].index, b: hair[1].index }];
  return model;
}

test('synthetic PMX (SDEF, BDEF4 with -1 slots, duplicate/empty/group morphs, joints, grants): the lab path equals the MMDLoader path', () => {
  const bytes = writePmx(featureModel());
  const data = parsePmx(bytes);
  assert.ok(data.vertices.some(vertex => vertex.skinIndices.includes(-1)), 'fixture has an unused -1 slot');
  assert.ok(data.bones.some(bone => bone.grant), 'fixture has grants');
  const { profile } = assertSamePath(bytes, 'feature model');
  assert.equal(profile.morphs.a.name, 'あ');
  assert.ok(profile.collision && profile.collision.excluded.bones > 0);
  // The constraint rule: the second hair body is now 1 on both paths.
  const lab = labMesh(parsePmx(bytes)), app = loaderMesh(bytes);
  const types = (mesh: SkinnedMesh) => (mesh.geometry.userData.MMD.rigidBodies as { type: number }[]).map(body => body.type);
  assert.deepEqual(types(lab.mesh), types(app));
  assert.ok(types(lab.mesh).includes(1) && types(lab.mesh).includes(2));
  lab.dispose(); app.geometry.dispose();
});

// ---------------------------------------------------------------- edge models from bytes

const analyze = (id: string, data: ModelData | PmxWriteModel) =>
  analyzeModel({ id, file: `${id}.pmx`, path: `synthetic/${id}.pmx`, bytes: writePmx('skin' in data ? data : pmxFromModelData(data, { name: id })) }, motions());
function assertComplete(report: ModelReport) {
  assert.equal(report.ok, true, report.error ?? '');
  assert.equal(report.motions.length, catalogMotionFiles().length);
  assert.equal(report.totals.ok + report.totals.adjusted + report.totals.hidden, report.motions.length);
  for (const motion of report.motions) {
    assert.ok(['ok', 'adjusted', 'hidden'].includes(motion.status));
    if (motion.status === 'hidden') assert.ok(motion.issues.length > 0, `${motion.key} hidden with a reason`);
  }
  assert.ok(report.timings.totalMs > 0 && report.timings.motionsMs >= 0);
  return report;
}

test('T pose with English bone and morph names: mapped, arms aligned to Gene, all slots found, feet baked without IK', () => {
  const report = assertComplete(analyze('toy-en-T', toyModel({ names: 'english', pose: 'T' })));
  const profile = report.profile!;
  assert.equal(profile.bones.mapped.armLeft, 'Arm_L'); assert.equal(profile.bones.mapped.kneeRight, 'Knee_R');
  assert.equal(profile.restPose.pose, 'T'); assert.equal(profile.restPose.armDeg, 0);
  assert.ok(profile.restPose.alignedToGeneDeg.armLeft! > 25, 'the T arms are rotated onto Gene\'s A pose');
  assert.deepEqual(profile.summary.missing, ['mouthPucker'], 'aa/ih/ou/ee/oh, Blink... all validated (the toy has no pucker)');
  assert.equal(profile.morphs.a.name, 'aa');
  assert.equal(profile.bones.features.legIk, false); assert.equal(report.retarget!.bakeLegIk, true);
  assert.equal(report.retarget!.identity, false);
  assert.equal(report.totals.hidden, 0);
});

test('a model with leg IK keeps its own IK (nothing baked); groove and twist bones map', () => {
  const report = assertComplete(analyze('toy-ik', toyModel({ ik: true, twist: true, groove: true })));
  assert.equal(report.profile!.bones.features.legIk, true);
  assert.equal(report.retarget!.bakeLegIk, false);
  assert.equal(report.profile!.bones.mapped.groove, 'グルーブ');
});

test('missing bones are listed, motions fold or drop them, and the whole library is still checked', () => {
  const data = toyModel();
  const rename: Record<string, string> = { 首: 'kubi_x', 左手首: 'lw_x', 右手首: 'rw_x', 下半身: 'lb_x' };
  data.bones = data.bones.map(bone => ({ ...bone, name: rename[bone.name] ?? bone.name }));
  const report = assertComplete(analyze('toy-missing', data));
  const missing = report.profile!.bones.missingCore;
  for (const bone of ['neck', 'wristLeft', 'wristRight'] as const) assert.ok(missing.includes(bone), bone);
  assert.ok(report.profile!.bones.missing.includes('lowerBody'));
  assert.ok(report.retarget!.folded.some(entry => entry.startsWith('neck → head')), report.retarget!.folded.join('; '));
  assert.ok(report.retarget!.dropped.some(entry => entry.startsWith('wristLeft')), report.retarget!.dropped.join('; '));
});

test('a body with skirt and hair: 15 capsules used by the check, hair and skirt chains excluded by name', () => {
  const report = assertComplete(analyze('body-T', bodyModel({ pose: 'T', build: 'fat', skirt: 'bones', hair: 'bones', bust: 0.4 })));
  const collision = report.collision!;
  assert.equal(collision.capsules.length, 15); assert.equal(collision.usedByCheck, true);
  assert.ok(collision.excluded.roots.some(root => root.name.startsWith('スカート')) && collision.excluded.roots.some(root => root.name.startsWith('後髪')));
  assert.equal(collision.excluded.roots.reduce((sum, root) => sum + root.bones, 0), collision.excluded.bones);
  assert.equal(report.profile!.restPose.pose, 'T');
});

test('a body too wide for the arms: hidden motions carry reasons and screenshot times; tight ones are listed too', () => {
  const body = bodyModel({ build: 'fat' });
  const torso = new Set(['上半身', '上半身2', '下半身'].map(name => body.bones.findIndex(bone => bone.name === name)));
  for (let vertex = 0; vertex < body.positions.length / 3; vertex++)
    if (torso.has(body.skinBone[vertex])) { body.positions[vertex * 3] *= 1.6; body.positions[vertex * 3 + 2] *= 1.6; }
  const report = assertComplete(analyze('body-wide', body));
  assert.ok(report.totals.hidden > 0 && report.totals.adjusted > 0, JSON.stringify(report.totals));
  const hidden = report.motions.filter(motion => motion.status === 'hidden');
  for (const motion of hidden) {
    const moments = report.watch.filter(entry => entry.motion === motion.key && entry.status === 'hidden');
    assert.equal(moments.length, motion.issues.length);
    for (const moment of moments) assert.ok(moment.seconds.length > 0 && moment.seconds.every(time => time >= 0 && time <= motion.seconds + 0.01), moment.reason);
  }
  assert.ok(report.watch.some(entry => entry.status !== 'hidden' && /clearance/.test(entry.reason)));
  assert.ok(report.tightest.torso!.value < 1, 'something in the library goes inside this body');
  const markdown = renderModelMarkdown(report, 'now');
  assert.match(markdown, /hidden（隐藏）/); assert.match(markdown, /真机截图对照建议时刻/);
});

test('files the app cannot load are reported, not thrown: QDEF, truncated, not a PMX, a bone parent out of range', () => {
  const base = pmxFromModelData(toyModel());
  const qdef = { ...base, skin: base.skin.map((skin, vertex) => vertex === 5 ? { deform: 4 as const, bones: [0, 1, 2, 3], weights: [0.25, 0.25, 0.25, 0.25] } : skin) };
  const broken = { ...base, bones: base.bones.map((bone, index) => index === 3 ? { ...bone, parent: 999 } : bone) };
  const cases: [string, Uint8Array, RegExp][] = [
    ['qdef', writePmx(qdef), /MMDParser.*unsupport bone type 4/],
    ['truncated', writePmx(base).slice(0, 5000), /PMX parse failed/],
    ['not-pmx', new TextEncoder().encode('Vocaloid Motion Data 0002'), /PMX parse failed.*magic/],
    ['bad-parent', writePmx(broken), /parent index 999.*MMDLoader fails/],
  ];
  for (const [id, bytes, reason] of cases) {
    const report = analyzeModel({ id, file: `${id}.pmx`, path: id, bytes }, motions());
    assert.equal(report.ok, false, id); assert.match(report.error ?? '', reason, id);
    assert.equal(report.motions.length, 0);
    assert.match(renderModelMarkdown(report, 'now'), /未完成/);
  }
});

/** About 160k vertices, 1056 bones (1000 physics accessory bones), 200 morphs. */
function largeModel(): PmxWriteModel {
  const body = bodyModel({ density: 120, skirt: 'bones', hair: 'bones' });
  const model = pmxFromModelData(body), head = model.bones.findIndex(bone => bone.name === '頭');
  model.rigidBodies = [...(model.rigidBodies ?? [])];
  for (let k = 0; k < 1000; k++) {
    const chain = Math.floor(k / 5), link = k % 5;
    model.bones.push({ name: `髪飾り${chain}_${link}`, parent: link === 0 ? head : model.bones.length - 1, position: [0.1 * (chain % 20), 19 - link * 0.3, -1] });
    model.rigidBodies.push({ boneIndex: model.bones.length - 1, type: 1 });
  }
  const count = body.positions.length / 3;
  for (let m = 0; m < 200; m++) {
    const indices: number[] = [], deltas: number[] = [];
    for (let vertex = m; vertex < count; vertex += 97) { indices.push(vertex); deltas.push(0, 0.001 * (m % 7), 0); }
    model.morphs.push({ name: m < JAPANESE_MORPHS.length ? JAPANESE_MORPHS[m].name : `morph${m}`, type: 1, indices, deltas });
  }
  return model;
}

test('a large model (≈160k vertices, 1056 bones, 200 morphs) completes and reports where the time goes', (t) => {
  const report = assertComplete(analyzeModel({ id: 'large', file: 'large.pmx', path: 'large', bytes: writePmx(largeModel()) }, motions()));
  assert.ok(report.counts!.vertices > 150_000 && report.counts!.bones === 1056 && report.counts!.morphs === 200);
  assert.equal(report.collision!.capsules.length, 15);
  assert.ok(report.collision!.excluded.bones >= 1000, 'accessory chains are excluded');
  const timing = report.timings;
  t.diagnostic(`large model: parse ${timing.parseMs} ms, mesh ${timing.meshMs} ms, profile ${timing.profileMs} ms, 53 motions ${timing.motionsMs} ms, total ${timing.totalMs} ms`);
  assert.ok(timing.totalMs < 60_000, `took ${timing.totalMs} ms`);
});

// ---------------------------------------------------------------- privacy rules

const WIN = (repoRoots: string[], extra: Partial<PathContext> = {}): PathContext =>
  ({ repoRoots, env: {}, platform: 'win32', exists: () => false, realpath: value => value, ...extra });

test('report folders inside the repository, a git repository or OneDrive are refused', () => {
  const context = WIN(['C:\\Users\\me\\Code\\soft-hearts']);
  assert.equal(privatePathProblem('C:\\mmd-test\\reports', context), null);
  assert.equal(privatePathProblem('reports', context)?.kind, 'relative');
  assert.equal(privatePathProblem('C:\\Users\\me\\Code\\soft-hearts\\out', context)?.kind, 'repository');
  assert.equal(privatePathProblem('c:\\users\\ME\\code\\SOFT-HEARTS', context)?.kind, 'repository', 'Windows paths compare case-insensitively');
  assert.equal(privatePathProblem('C:\\Users\\me\\OneDrive\\mmd\\reports', context)?.kind, 'onedrive');
  assert.equal(privatePathProblem('D:\\OneDrive - Contoso\\reports', context)?.kind, 'onedrive');
  assert.equal(privatePathProblem('D:\\Sync\\reports', WIN([], { env: { OneDriveCommercial: 'D:\\Sync' } }))?.kind, 'onedrive');
  // A junction: C:\mmd-test\linked resolves into OneDrive.
  const junction = WIN([], { exists: value => /^C:\\mmd-test(\\linked)?$/i.test(value), realpath: value => value.replace(/^C:\\mmd-test\\linked/i, 'C:\\Users\\me\\OneDrive\\x') });
  assert.equal(privatePathProblem('C:\\mmd-test\\linked\\reports', junction)?.kind, 'onedrive');
  // A git repository anywhere above.
  const git = WIN([], { exists: value => value.toLowerCase() === 'c:\\work\\.git' });
  assert.equal(privatePathProblem('C:\\work\\lab\\reports', git)?.kind, 'git');
  assert.throws(() => assertPrivateReportDir('C:\\Users\\me\\OneDrive\\reports', context), LabError);
  assert.ok(isInside('C:\\a\\b', 'c:\\A', WIN([])) && !isInside('C:\\ab', 'C:\\a', WIN([])));
});

test('the real checkout and the real OneDrive folder are refused on this machine', () => {
  const context: PathContext = { repoRoots: [REPO_ROOT], env: process.env };
  assert.ok(privatePathProblem(path.join(REPO_ROOT, 'lab-reports'), context), 'this checkout');
  if (process.env.OneDrive) assert.equal(privatePathProblem(path.join(process.env.OneDrive, 'lab-reports'), context)?.kind, 'onedrive');
  assert.equal(privatePathProblem(path.join(os.tmpdir(), 'model-lab-check', 'reports'), context), null, 'the system temp folder is private');
});

test('config: paths resolve next to the config, ids name folders safely, mistakes are explained', () => {
  const config = parseLabConfig('\uFEFF{ "reportDir": "reports", "models": [ { "id": "alice", "pmx": "alice\\\\alice.pmx" }, { "id": "bob.v2", "pmx": "D:\\\\m\\\\bob.PMX" } ] }',
    'C:\\mmd-test\\model-lab.json', 'win32');
  assert.equal(config.reportDir, 'C:\\mmd-test\\reports');
  assert.deepEqual(config.models, [{ id: 'alice', pmx: 'C:\\mmd-test\\alice\\alice.pmx' }, { id: 'bob.v2', pmx: 'D:\\m\\bob.PMX' }]);
  const bad = (text: string, pattern: RegExp) => assert.throws(() => parseLabConfig(text, 'C:\\mmd-test\\model-lab.json', 'win32'), (error: Error) => error instanceof LabError && pattern.test(error.message));
  bad('{', /not valid JSON/);
  bad('{ "models": [] }', /reportDir/);
  bad('{ "reportDir": "r", "models": [] }', /1 to 100/);
  bad('{ "reportDir": "r", "models": [ { "id": "../x", "pmx": "a.pmx" } ] }', /id must be/);
  bad('{ "reportDir": "r", "models": [ { "id": "a", "pmx": "a.pmx" }, { "id": "A", "pmx": "b.pmx" } ] }', /duplicate/);
  bad('{ "reportDir": "r", "models": [ { "id": "a", "pmx": "a.pmd" } ] }', /\.pmx/);
  for (const id of ['', '.', '..', 'a/b', 'a\\b', 'CON', 'nul.txt', 'x.', 'a b', 'x'.repeat(65)]) assert.equal(validModelId(id), false, id);
  for (const id of ['gene', 'alice_v2', 'model-1.0', 'ミク']) assert.equal(validModelId(id), true, id);
});

test('the lab blocks network entry points while it runs and imports no network module', () => {
  const restore = blockNetwork();
  try { assert.throws(() => (globalThis.fetch as unknown as () => void)(), /never uses the network/); } finally { restore(); }
  assert.notEqual(String(globalThis.fetch).includes('never uses the network'), true);
  const sources = ['scripts/model-lab.ts', ...readdirSync(path.join(REPO_ROOT, 'scripts/model-lab')).map(file => `scripts/model-lab/${file}`)];
  for (const file of sources) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    assert.doesNotMatch(text, /(?:from|import\()\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process|electron|undici)['"]|env\.APPDATA|env\[['"]APPDATA/i, file);
  }
});

// ---------------------------------------------------------------- end to end

/** A fresh folder in the system temp directory (private by the lab's rules), removed after the test. */
function tempLab(): { dir: string; close(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'model-lab-test-'));
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('end to end on Gene: the CLI writes report.json/.md per model and a summary, only under reportDir', async () => {
  const lab = tempLab();
  try {
    const config = path.join(lab.dir, 'model-lab.json');
    writeFileSync(config, JSON.stringify({ reportDir: 'reports', models: [{ id: 'gene', pmx: GENE_PATH }, { id: 'missing', pmx: 'nowhere.pmx' }] }));
    const out: string[] = [], err: string[] = [];
    const code = await runModelLab(['--config', config], { io: { out: line => out.push(line), err: line => err.push(line) } });
    assert.equal(code, 2, 'one model was missing');
    assert.deepEqual(readdirSync(lab.dir).sort(), ['model-lab.json', 'reports']);
    assert.deepEqual(readdirSync(path.join(lab.dir, 'reports')).sort(), ['gene', 'missing', 'summary.json', 'summary.md']);
    assert.deepEqual(readdirSync(path.join(lab.dir, 'reports', 'gene')).sort(), ['report.json', 'report.md']);
    const report = JSON.parse(readFileSync(path.join(lab.dir, 'reports', 'gene', 'report.json'), 'utf8')) as ModelReport & { generatedAt: string };
    assert.equal(report.ok, true); assert.equal(report.model.bundledGene, true);
    assert.equal(report.motions.length, 76); assert.deepEqual(report.totals, { motions: 76, ok: 76, adjusted: 0, hidden: 0, usable: 76 });
    assert.equal(report.retarget?.identity, true); assert.equal(report.collision?.capsules.length, 15); assert.equal(report.profile?.summary.missing.length, 0);
    assert.equal(report.tightest.torso?.motion, 'gene/frustrated', 'the closest arm-to-body in the reviewed library (docs/claude/2026-11-02-collision-proxy.md)');
    assert.ok(report.tightest.torso!.value > 1 && report.tightest.torso!.value < 1.05);
    const summary = JSON.parse(readFileSync(path.join(lab.dir, 'reports', 'summary.json'), 'utf8'));
    assert.deepEqual(summary.models.map((row: { id: string; ok: boolean }) => [row.id, row.ok]), [['gene', true], ['missing', false]]);
    assert.match(readFileSync(path.join(lab.dir, 'reports', 'summary.md'), 'utf8'), /\| gene（Gene） \| 完成 \|/);
    assert.match(readFileSync(path.join(lab.dir, 'reports', 'missing', 'report.md'), 'utf8'), /PMX not found/);
    assert.ok(out.some(line => /gene: 76\/76 usable/.test(line)), out.join('\n'));
    assert.deepEqual(err, [], 'the bundled Gene inside the repository is not warned about');
  } finally { lab.close(); }
  assert.equal(existsSync(lab.dir), false);
});

test('the CLI refuses a report folder in the repository or OneDrive and writes nothing', async () => {
  const lab = tempLab();
  try {
    const config = path.join(lab.dir, 'model-lab.json');
    const inRepo = path.join(REPO_ROOT, 'model-lab-reports-should-not-exist');
    for (const [reportDir, env, pattern] of [
      [inRepo, {}, /inside (the repository|OneDrive|a git repository)/],
      [path.join(lab.dir, 'OneDrive', 'reports'), {}, /inside OneDrive/],
      [path.join(lab.dir, 'synced'), { OneDrive: lab.dir }, /inside OneDrive \(OneDrive=/],
    ] as const) {
      writeFileSync(config, JSON.stringify({ reportDir, models: [{ id: 'gene', pmx: GENE_PATH }] }));
      const err: string[] = [];
      const code = await runModelLab(['--config', config], { env: { ...env }, io: { out() {}, err: line => err.push(line) } });
      assert.equal(code, 1); assert.match(err.join('\n'), pattern);
      assert.equal(existsSync(reportDir), false, `${reportDir} was not created`);
    }
    assert.deepEqual(readdirSync(lab.dir), ['model-lab.json']);
    // A config inside a repository is refused too (here: a stand-in repository root around the temp folder).
    const err: string[] = [];
    assert.equal(await runModelLab(['--config', config], { io: { out() {}, err: line => err.push(line) }, paths: { repoRoots: [lab.dir], env: {} } }), 1);
    assert.match(err.join('\n'), /Refusing config/);
    assert.equal(await runModelLab(['--help'], { io: { out() {}, err() {} } }), 0);
    assert.equal(await runModelLab(['--bogus'], { io: { out() {}, err() {} } }), 1);
    assert.equal(await runModelLab(['--config', path.join(lab.dir, 'absent.json')], { io: { out() {}, err() {} } }), 1);
  } finally { lab.close(); }
});

test('summary rendering lists every model with its numbers', () => {
  const failed = analyzeModel({ id: 'bad', file: 'bad.pmx', path: 'bad', bytes: new Uint8Array(8) }, []);
  const summary = buildSummary([failed], '2026-11-02T00:00:00.000Z', 53);
  assert.equal(summary.models[0].ok, false);
  assert.match(renderSummaryMarkdown(summary), /\| bad \| 失败：PMX parse failed/);
});
