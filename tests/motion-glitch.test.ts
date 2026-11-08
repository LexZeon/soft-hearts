/**
 * 动作跳变记录 (on her own model; tests never use it). The pet window's stage reports a guard catch
 * or a physics kick (src/stage/motion-glitch.ts); the host journals it while 体验记录 is on, through the journal's whitelist
 * (shared/journal.ts `motion`). These tests hold: what a line carries (and nothing else), the rate limit, the physics kick rule,
 * and the real stage reporting a real catch with what she was doing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, Quaternion, Vector3 } from 'three';
import { buildJournalEntry, describeJournalEntry } from '../shared/journal';
import { MOTION_GLITCH_REPEAT_MS, MotionGlitchWatch, PHYSICS_KICK_DEG, type MotionGlitchReport } from '../src/stage/motion-glitch';
import { AppJournal } from '../electron/journal/app-journal';
import { geneStage } from './helpers/gene-stage-harness';

const state = (jumps: number, property: string, size: number, resets = 0) => ({ active: 1, maxAngleDeg: 0, maxPosition: 0, maxMorph: 0, jumps, lastJump: { property, size },
  resets, lastReset: 'x', baseTrusted: true, properties: 10 });

test('a line: the bone or morph, how far, what she was doing, the frame; refused if anything is outside the whitelist', () => {
  const at = Date.UTC(2026, 10, 3, 20, 0, 0);
  const entry = buildJournalEntry({ type: 'motion', characterId: 'mira_1', kind: 'physics', part: 'bone', name: '左胸', size: 14.8392, activities: ['chat-gesture', 'speaking'],
    fps: 60, frameMs: 16.71, text: '秘密', message: '我今天很难过' }, at)!;
  assert.deepEqual({ ...entry, time: undefined }, { v: 1, at, time: undefined, type: 'motion', characterId: 'mira_1', kind: 'physics', part: 'bone', name: '左胸', size: 14.84,
    activities: ['chat-gesture', 'speaking'], fps: 60, frameMs: 16.7, reason: '物理骨骼一帧里跳了一下' });
  assert.ok(!JSON.stringify(entry).includes('秘密') && !JSON.stringify(entry).includes('难过'), 'unknown fields never reach the line');
  assert.equal(describeJournalEntry(entry, (s, ...v) => s.replace(/\{(\d)\}/g, (_, i) => String(v[Number(i)]))).slice(6), '物理骨骼一帧里跳了一下：左胸 14.8°（说话手势、说话）');
  for (const bad of [{ name: 'C:\\Users\\x\\model.pmx' }, { name: '../secret' }, { name: 'x'.repeat(41) }, { activities: ['chat'] }, { kind: 'teleport' }, { size: -1 }, { part: 'mesh' }])
    assert.equal(buildJournalEntry({ type: 'motion', characterId: 'mira_1', kind: 'guard', part: 'bone', name: '右手首', size: 3, activities: [], fps: 60, frameMs: 16, ...bad }, at), null, JSON.stringify(bad));
});

test('the host passes on only the report fields, while the switch is on', () => {
  const lines: unknown[] = [];
  const journal = Object.create(AppJournal.prototype) as AppJournal;
  (journal as unknown as { writer: { record(input: unknown): unknown } }).writer = { record: input => { lines.push(input); return buildJournalEntry(input, 1); } };
  assert.equal(journal.motionGlitch({ kind: 'guard', part: 'bone', name: '右手首', size: 3.1, activities: ['idle'], fps: 30, frameMs: 33, chat: '你好' }, 'gene'), true);
  assert.equal(journal.motionGlitch({ kind: 'guard', part: 'bone', name: '右手首', size: 3.1, activities: ['idle'], fps: 30, frameMs: 33 }, null), false, 'no character, no line');
  assert.ok(!JSON.stringify(lines).includes('你好'));
});

test('the watch: one line per new guard catch, per bone at most every couple of seconds; a morph by its name', () => {
  let now = 0;
  const lines: MotionGlitchReport[] = [], watch = new MotionGlitchWatch(line => lines.push(line), () => now);
  const mesh = { morphTargetDictionary: { 笑い: 89 } } as never, idle = () => ['idle' as const];
  watch.guard(mesh, state(0, '.bones[右手首].quaternion', 0), idle, 60, 16.7);
  watch.guard(mesh, state(1, '.bones[右手首].quaternion', 3.15), idle, 60, 16.7);
  now = 100; watch.guard(mesh, state(2, '.bones[右手首].quaternion', 4.6), idle, 60, 16.7);
  now = 200; watch.guard(mesh, state(3, '.morphTargetInfluences[89]', 0.24), idle, 60, 16.7);
  now = MOTION_GLITCH_REPEAT_MS + 150; watch.guard(mesh, state(4, '.bones[右手首].quaternion', 2.3), idle, 60, 16.7);
  watch.guard(mesh, state(0, '.bones[右手首].quaternion', 9, 1), idle, 60, 16.7); // a reset guard starts over: not a catch
  assert.deepEqual(lines.map(l => [l.kind, l.part, l.name, l.size]), [['guard', 'bone', '右手首', 3.15], ['guard', 'morph', '笑い', 0.24], ['guard', 'bone', '右手首', 2.3]]);
});

test('the watch: a physics bone that kicks within one frame is a line; one that swings smoothly is not', () => {
  const lines: MotionGlitchReport[] = [], watch = new MotionGlitchWatch(line => lines.push(line), () => 0);
  const root = new Bone(), chest = new Bone(); chest.name = '左胸'; root.add(chest);
  const mesh = { skeleton: { bones: [root, chest] } } as never, idle = () => ['chat-gesture' as const];
  const axis = new Vector3(1, 0, 0);
  for (let i = 0; i < 120; i++) { chest.quaternion.setFromAxisAngle(axis, 0.3 * Math.sin(i / 10)); root.updateMatrixWorld(true); watch.physics(mesh, [1], idle, 60, 16.7); }
  assert.equal(lines.length, 0, 'a smooth swing');
  chest.quaternion.multiply(new Quaternion().setFromAxisAngle(axis, (PHYSICS_KICK_DEG + 5) / 180 * Math.PI)); root.updateMatrixWorld(true);
  watch.physics(mesh, [1], idle, 60, 16.7);
  assert.equal(lines.length, 1); assert.equal(lines[0].kind, 'physics'); assert.equal(lines[0].name, '左胸'); assert.ok(lines[0].size >= PHYSICS_KICK_DEG);
  assert.deepEqual(lines[0].activities, ['chat-gesture']);
});

test('the real stage reports a real catch with the bone and what she was doing (a layer that snaps the elbow once)', async () => {
  const h = await geneStage({ fps: 60, refreshHz: 60 });
  try {
    const lines: MotionGlitchReport[] = [];
    h.stage.options.onMotionGlitch = (line: MotionGlitchReport) => lines.push(line);
    h.run(1);
    const elbow = h.mesh.skeleton.bones.find((bone: Bone) => bone.name === '右ひじ')!, show = h.stage.frameExpressionShow;
    let snap = false;
    h.stage.frameExpressionShow = function (this: unknown, time: number) { show.call(this, time); if (snap) { h.stage.rememberBone(elbow); elbow.rotateZ(0.35); } };
    snap = true; h.run(0.5); snap = false; h.run(0.5);
    assert.ok(lines.some(line => line.kind === 'guard' && line.name === '右ひじ' && line.activities.includes('idle')), JSON.stringify(lines));
    assert.ok(lines.every(line => line.fps === 60 && line.frameMs !== null));
  } finally { h.close(); }
});
