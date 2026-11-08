import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { FatigueHost, SYSTEM_FATIGUE_CLOCK } from '../electron/fatigue-host';

const channels = { D: 50, O: 50, E: 50, N: 50, C: 50 };
const activity = { chat: false, tts: false, manualMotion: false };
async function removeOwnedTemp(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith('soft-hearts-fatigue-'));
  await rm(resolved, { recursive: true, force: true });
}
const clockFixture = () => {
  let mono = 0, wall = 1_790_000_000_000;
  return { clock: { monotonicMs: () => mono, wallMs: () => wall, localMinute: () => 900 },
    step: (ms: number) => { mono += ms; wall += ms; }, wall: () => wall, setWall: (value: number) => { wall = value; } };
};
async function seeded(directory: string, wallMs: number, W = 0, phase = 'asleep') {
  await writeFile(path.join(directory, 'fatigue-state.json'), JSON.stringify({ version: 1,
    profiles: [{ characterId: 'gene', A: .95, F: .85, W, phase, wallMs }] }));
}

test('sidecar rebases a fresh process clock and counts one bounded offline interval as rest (I-022), without a visible phase change', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'soft-hearts-fatigue-rebase-')), c = clockFixture();
  try {
    await seeded(dir, c.wall() - 24 * 3_600_000, .5);
    const host = new FatigueHost(dir, c.clock); await host.load();
    const first = host.activate('gene', channels, channels);
    assert.ok(first.A < .1, `a day off screen is rest (A ${first.A})`); assert.ok(first.F < .5); assert.ok(first.W < .001); assert.equal(first.sleeping, true);
    assert.equal(first.sleepEntryReady, false); assert.equal(first.sleepEntryBlocked, true);
    assert.equal(await host.flush(), true);
    const saved = JSON.parse(await readFile(path.join(dir, 'fatigue-state.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved.profiles[0]).sort(), ['A', 'F', 'W', 'characterId', 'phase', 'wallMs'].sort());
    assert.equal(saved.profiles[0].wallMs, c.wall());
    const again = new FatigueHost(dir, c.clock); await again.load();
    assert.equal(again.activate('gene', channels, channels).A, first.A, 'no time passed: nothing more is rested');
  } finally { await removeOwnedTemp(dir); }
});

test('accepted physical/direct events retain sleep pressure, deduplicate and isolate character state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'soft-hearts-fatigue-events-')), c = clockFixture();
  try {
    await seeded(dir, c.wall()); const host = new FatigueHost(dir, c.clock); await host.load(); host.setBlockers(activity);
    host.activate('gene', channels, channels);
    const touch = host.accept('gene', 'physical', 'contact-1')!;
    assert.equal(touch.A, .95); assert.equal(touch.F, .85); assert.equal(touch.phase, 'micro-awake'); assert.equal(touch.gazeAllowed, false);
    c.step(1500); const duplicate = host.accept('gene', 'physical', 'contact-1')!; assert.ok(duplicate.W < touch.W);
    const beforeChat = host.view()!.W, chat = host.accept('gene', 'direct-chat', 'user-1')!; assert.ok(chat.W > beforeChat);
    const other = host.activate('other', channels, channels); assert.equal(other.A, .25); assert.equal(other.W, 0);
    const returned = host.activate('gene', channels, channels); assert.ok(returned.A > .94); assert.ok(returned.W > 0);
    assert.equal(host.accept('other', 'physical', 'late-other'), undefined);
  } finally { await removeOwnedTemp(dir); }
});

test('corrupt existing fatigue data is preserved and never overwritten by an in-memory fallback', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'soft-hearts-fatigue-corrupt-')), c = clockFixture();
  try {
    const file = path.join(dir, 'fatigue-state.json'), raw = '{"version":1,"profiles":[{"characterId":"gene","A":999}]}';
    await writeFile(file, raw); const host = new FatigueHost(dir, c.clock); await host.load();
    assert.match(host.activate('gene', channels, channels).storageError!, /原 fatigue-state.json 已保留/);
    assert.equal(await host.flush(), false); assert.equal(await readFile(file, 'utf8'), raw);
  } finally { await removeOwnedTemp(dir); }
});

test('wall rollback keeps the persisted high-water mark instead of reusing an offline interval', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'soft-hearts-fatigue-clock-')), c = clockFixture();
  try {
    const highWater = c.wall() + 3_600_000; await seeded(dir, highWater);
    const host = new FatigueHost(dir, c.clock); await host.load(); host.activate('gene', channels, channels);
    c.setWall(c.wall() - 3_600_000); c.step(1000); host.update('gene', channels, channels); await host.flush();
    const stored = JSON.parse(await readFile(path.join(dir, 'fatigue-state.json'), 'utf8'));
    assert.equal(stored.profiles[0].wallMs, highWater);
  } finally { await removeOwnedTemp(dir); }
});

test('actual MoodHost accepts one contact pulse, excludes assistant appraisal and preserves legacy stored shapes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'soft-hearts-fatigue-mood-')), c = clockFixture();
  const base = new URL('../electron/mood.ts', import.meta.url);
  const requireBase = createRequire(base), source = await readFile(base, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', output)((name: string) => name === './fatigue-host' ? { FatigueHost, SYSTEM_FATIGUE_CLOCK } : requireBase(name), module, module.exports);
  const MoodHost = module.exports.MoodHost;
  let mood: any;
  try {
    await seeded(dir, c.wall()); mood = new MoodHost(dir, () => {}, c.wall, { fatigueClock: c.clock }); await mood.load(); mood.activate('gene');
    mood.setFatigueActivity(activity); assert.equal(mood.get().fatigue.sleepEntryReady, true);
    const token = mood.get().token;
    mood.interaction({ token, sessionId: 'contact_01', type: 'phase', phase: 'rua' });
    const touched = mood.get().fatigue; assert.equal(touched.phase, 'micro-awake'); assert.equal(touched.W, .08);
    c.step(1500); mood.interaction({ token, sessionId: 'contact_01', type: 'rua', id: 'movement_01', activeMs: 200 });
    assert.ok(mood.get().fatigue.W < touched.W, 'The same contact reward must not create a second wake pulse.');
    c.step(1500); mood.event({ type: 'chat', id: 'direct_01' }); const afterChat = mood.get().fatigue.W;
    mood.event({ type: 'appraisal', id: 'assistant_01', responseTo: 'direct_01', delta: { D: 1 } });
    assert.equal(mood.get().fatigue.W, afterChat, 'An assistant appraisal is not direct user input.');
    assert.match(mood.chatContext(), /当前疲倦感受：睡眠中轻微醒转/);
    const asleep = mood.get().fatigue;
    assert.throws(() => mood.interaction({ token: 'old_token', sessionId: 'wake_01', type: 'wake', id: 'wake_01' }));
    assert.throws(() => mood.interaction({ token, sessionId: 'wake_01', type: 'wake', id: 'wake_01', A: 0 }));
    mood.interaction({ token, sessionId: 'wake_01', type: 'wake', id: 'wake_01' });
    assert.equal(mood.get().fatigue.phase, 'awake'); assert.equal(mood.get().fatigue.A, asleep.A); assert.equal(mood.get().fatigue.F, asleep.F);
    const wokeW = mood.get().fatigue.W;
    mood.interaction({ token, sessionId: 'wake_01', type: 'wake', id: 'wake_01' }); assert.equal(mood.get().fatigue.W, wokeW);
    assert.deepEqual(Object.keys(mood.get().snapshot.values).sort(), ['C', 'D', 'E', 'N', 'O']);
    await mood.flush(); const old = JSON.parse(await readFile(path.join(dir, 'mood-state.json'), 'utf8'));
    assert.equal(old.version, 1); assert.equal(Object.hasOwn(old.profiles[0], 'fatigue'), false);
    assert.equal(Object.hasOwn(old.profiles[0].state.values, 'A'), false);
  } finally { if (mood) await mood.flush(); await removeOwnedTemp(dir); }
});

test('host activity blocker cancels falling-asleep at zero elapsed without repaying pressure', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'soft-hearts-fatigue-priority-')), c = clockFixture();
  try {
    await seeded(dir, c.wall(), 0, 'falling-asleep'); const host = new FatigueHost(dir, c.clock); await host.load(); host.setBlockers(activity);
    const entering = host.activate('gene', channels, channels); assert.equal(entering.phase, 'falling-asleep');
    host.setBlockers({ ...activity, tts: true }); const blocked = host.update('gene', channels, channels)!;
    assert.equal(blocked.phase, 'drowsy'); assert.equal(blocked.A, entering.A); assert.equal(blocked.F, entering.F); assert.equal(blocked.W, 0);
  } finally { await removeOwnedTemp(dir); }
});

test('"测试：睡着了" looks asleep (eyes and pose follow sleeping, no gaze) without touching the model; a pat ends it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'soft-hearts-fatigue-test-asleep-')), c = clockFixture();
  try {
    await seeded(dir, c.wall(), 0, 'awake'); const host = new FatigueHost(dir, c.clock); await host.load(); host.setBlockers(activity);
    const before = host.activate('gene', channels, channels);
    assert.equal(host.setTestPhase('gene', 'asleep'), true);
    const look = host.view()!;
    assert.deepEqual([look.phase, look.sleeping, look.gazeAllowed], ['asleep', true, false]);
    assert.equal(await host.flush(), true);
    const saved = JSON.parse(await readFile(path.join(dir, 'fatigue-state.json'), 'utf8'));
    assert.equal(saved.profiles[0].phase, before.phase, 'the saved sleep model is untouched');
    const woke = host.accept('gene', 'physical', 'pat-1')!;
    assert.equal(woke.sleeping === true && woke.phase === 'asleep', false, 'a pat wakes the test sleep');
    assert.equal(host.view()!.gazeAllowed, true);
    assert.equal(host.setTestPhase('gene', 'drowsy'), true);
    host.accept('gene', 'physical', 'pat-2');
    assert.equal(host.view()!.phase, 'drowsy', 'the sleepy looks are not ended by a pat');
  } finally { await removeOwnedTemp(dir); }
});
