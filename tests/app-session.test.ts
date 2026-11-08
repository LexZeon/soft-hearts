// I-022 关应用也记 (shared/app-session.ts, electron/app-session/host.ts, the app lines of shared/journal.ts): when the app stopped,
// how it quit, how long it was closed; the stop is written synchronously and never holds up quitting; the next start reads it once
// and her fatigue and the journal's 应用启动 line use that one number. Only times, a run id, a character id and a closed cause.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { APP_SESSION_FILE, APP_STOP_FILE, AppSessionHost, nodeAppSessionFs, type AppSessionFs } from '../electron/app-session/host';
import { closedSpan, lastStopFrom, readAppSessionRecord, readAppStopRecord, type LastStop } from '../shared/app-session';
import { AppJournal } from '../electron/journal/app-journal';
import { buildJournalEntry, describeJournalEntry, readJournalLine, type JournalEntry } from '../shared/journal';
import { FatigueHost } from '../electron/fatigue-host';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 3, 15, 10, 0); // a fixed moment; the panel's clock text uses the machine's time zone, so it is not asserted
const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));

async function profile(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sh-app-session-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await rm(root, { recursive: true, force: true }); });
  return root;
}
/** A host on a temporary profile with a hand-driven clock and heartbeat. */
function session(directory: string, clock: { now: number }, options: { fs?: AppSessionFs; characterId?: string | null } = {}) {
  const beats: Array<() => void> = [];
  const host = new AppSessionHost({ directory: () => directory, characterId: () => options.characterId === undefined ? 'mira' : options.characterId,
    clock: () => clock.now, fs: options.fs, every: (_ms, run) => { beats.push(run); return () => { beats.length = 0; }; } });
  return { host, beat: () => { for (const run of [...beats]) run(); }, beating: () => beats.length > 0 };
}
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('a normal quit: the next start knows exactly when and how, and how long it was closed', async t => {
  const dir = await profile(t), clock = { now: T0 };
  const first = session(dir, clock);
  assert.equal(first.host.begin(), null, 'the very first start has no previous record');
  clock.now += 2 * HOUR; first.host.noteCause('tray');
  assert.equal(first.host.stop(), 'tray');
  const stop = json(path.join(dir, APP_STOP_FILE));
  assert.deepEqual(Object.keys(stop).sort(), ['cause', 'characterId', 'session', 'stoppedAt', 'version']);
  assert.equal(stop.stoppedAt, T0 + 2 * HOUR); assert.equal(stop.cause, 'tray'); assert.equal(stop.characterId, 'mira');

  clock.now += 8 * HOUR + 12 * MINUTE;
  const second = session(dir, clock), last = second.host.begin()!;
  assert.deepEqual(last, { at: T0 + 2 * HOUR, closedMs: 8 * HOUR + 12 * MINUTE, exact: true, cause: 'tray', characterId: 'mira', clockBack: false });
  assert.equal(second.host.lastStop(), last, 'one object: the journal and her fatigue read the same number');
  assert.equal(second.host.begin(), last, 'begin runs once');
  // Only times, a random run id, the character id and the cause are in the two files.
  const record = json(path.join(dir, APP_SESSION_FILE));
  assert.deepEqual(Object.keys(record).sort(), ['aliveAt', 'characterId', 'session', 'startedAt', 'version']);
  assert.notEqual(record.session, stop.session);
});

test('a crash or a forced end (no stop written): 上次没正常退出, estimated from its last sign of life, marked as an estimate', async t => {
  const dir = await profile(t), clock = { now: T0 };
  const first = session(dir, clock);
  first.host.begin();
  for (let i = 0; i < 30; i++) { clock.now += MINUTE; first.beat(); }
  await first.host.settled();
  assert.equal(json(path.join(dir, APP_SESSION_FILE)).aliveAt, T0 + 30 * MINUTE);
  // ... and it is killed: no stop() at all. Three hours later:
  clock.now += 3 * HOUR;
  const last = session(dir, clock).host.begin()!;
  assert.equal(last.exact, false); assert.equal(last.cause, null); assert.equal(last.at, T0 + 30 * MINUTE); assert.equal(last.closedMs, 3 * HOUR);
  // An older run's stop file (a different run id) is not this run's stop.
  const stale = { version: 1, session: 'older-run-0001', stoppedAt: T0 - HOUR, cause: 'tray', characterId: 'mira' };
  await writeFile(path.join(dir, APP_STOP_FILE), JSON.stringify(stale));
  clock.now += HOUR;
  assert.equal(session(dir, clock).host.begin()!.exact, false);
});

test('time going backwards is no closed time; unreadable or foreign records are no record', async t => {
  const dir = await profile(t), clock = { now: T0 };
  const first = session(dir, clock); first.host.begin(); clock.now += HOUR; first.host.stop('controls');
  clock.now -= 5 * HOUR; // the system clock was set back
  const back = session(dir, clock).host.begin()!;
  assert.equal(back.closedMs, 0); assert.equal(back.clockBack, true); assert.equal(back.exact, true);
  assert.deepEqual(closedSpan(10, 5), { ms: 0, clockBack: true }); assert.deepEqual(closedSpan(5, 10.7), { ms: 5, clockBack: false });
  assert.deepEqual(closedSpan(NaN, 10), { ms: 0, clockBack: false });
  for (const bad of [null, [], { version: 2 }, { version: 1, session: 'x', startedAt: T0, aliveAt: T0, characterId: null },
    { version: 1, session: 'run-00000001', startedAt: 5, aliveAt: 6, characterId: null }, { version: 1, session: 'run-00000001', startedAt: T0, aliveAt: T0 - 1, characterId: null },
    { version: 1, session: 'run-00000001', startedAt: T0, aliveAt: T0, characterId: '../x' }]) assert.equal(readAppSessionRecord(bad), null, JSON.stringify(bad));
  assert.equal(readAppStopRecord({ version: 1, session: 'run-00000001', stoppedAt: T0, cause: 'reboot-now', characterId: null }), null);
  assert.equal(lastStopFrom(null, null, T0), null);
  await writeFile(path.join(dir, APP_SESSION_FILE), '{not json'); await writeFile(path.join(dir, APP_STOP_FILE), 'x'.repeat(10_000));
  assert.equal(session(dir, clock).host.begin(), null);
});

test('stopping never holds up quitting: a failed write is swallowed, a hanging heartbeat is not waited for', async t => {
  const dir = await profile(t), clock = { now: T0 };
  let hanging = 0;
  const failing: AppSessionFs = { readNow: nodeAppSessionFs.readNow, writeNow: () => { throw new Error('EPERM'); },
    write: () => { hanging++; return new Promise<void>(() => {}); } };
  const host = session(dir, clock, { fs: failing });
  host.host.begin(); host.beat();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hanging, 1, 'a heartbeat is in flight and never finishes');
  const started = performance.now();
  assert.equal(host.host.stop('session-end'), 'session-end');
  assert.ok(performance.now() - started < 50, 'stop() returns at once');
  assert.equal(host.host.failure, 'stop');
  assert.equal(host.beating(), false, 'the heartbeat is stopped');
  host.beat(); assert.equal(hanging, 1, 'no heartbeat after the stop');
  // The real file system: one small synchronous write.
  const real = session(dir, clock); real.host.begin();
  const at = performance.now(); real.host.stop(); assert.ok(performance.now() - at < 200);
  assert.equal(json(path.join(dir, APP_STOP_FILE)).cause, 'other', 'no cause noted → other');
});

test('the first stop wins; before begin() nothing is written but the cause still reaches the journal line', async t => {
  const dir = await profile(t), clock = { now: T0 };
  const early = session(dir, clock);
  early.host.noteCause('quit-request');
  assert.equal(early.host.stop(), 'quit-request');
  assert.deepEqual(await readdir(dir), [], 'nothing written: this process never began a run (the second instance that only hands over)');
  const host = session(dir, clock); host.host.begin();
  host.host.noteCause('controls'); assert.equal(host.host.stop(), 'controls');
  host.host.noteCause('tray'); assert.equal(host.host.stop('session-end'), 'controls', 'a later quit path does not rewrite the first');
  assert.equal(json(path.join(dir, APP_STOP_FILE)).cause, 'controls');
});

const journalLines = async (directory: string): Promise<JournalEntry[]> => {
  const names = await readdir(path.join(directory, 'journal')).catch(() => []);
  const all = await Promise.all(names.map(name => readFile(path.join(directory, 'journal', name), 'utf8')));
  return all.join('').split('\n').filter(Boolean).map(line => JSON.parse(line));
};

test('the journal: 应用退出 says how, 应用启动 says when the last run stopped and how long it was closed (exact or estimated)', async t => {
  const dir = await profile(t), clock = { now: T0 };
  const journal = new AppJournal({ profileDirectory: () => dir, enabled: () => true, characters: () => null, publish: () => {}, clock: () => clock.now, publishDelayMs: 0 });
  const clean: LastStop = { at: T0 - 8 * HOUR, closedMs: 8 * HOUR + 12 * MINUTE, exact: true, cause: 'tray', characterId: 'mira', clockBack: false };
  const crash: LastStop = { at: T0 - 3 * HOUR, closedMs: 3 * HOUR + 12 * MINUTE, exact: false, cause: null, characterId: 'mira', clockBack: false };
  journal.appStarted('0.1.0', 'b74e371', 'mira', clean);
  journal.appStarted('0.1.0', 'b74e371', 'mira', crash);
  journal.appStarted('0.1.0', 'b74e371', 'mira', null);
  journal.appQuitting('0.1.0', 'b74e371', 'mira', 'session-end'); journal.appQuitting('0.1.0', 'b74e371', 'mira', 'tray');
  await journal.flush();
  const [a, b, c, d, ...rest] = await journalLines(dir) as Array<Extract<JournalEntry, { type: 'app' }>>;
  assert.equal(rest.length, 0, 'quit is written once');
  assert.deepEqual({ ...a, time: undefined }, { v: 1, at: T0, time: undefined, type: 'app', characterId: 'mira', event: 'start', version: '0.1.0', commit: 'b74e371',
    stopped: 'clean', stoppedAt: T0 - 8 * HOUR, closedMs: 8 * HOUR + 12 * MINUTE, cause: 'tray', reason: '应用启动' });
  assert.equal(b.stopped, 'unclean'); assert.equal((b as { estimated?: boolean }).estimated, true); assert.equal((b as { cause?: string }).cause, undefined);
  assert.equal(c.stopped, 'unknown'); assert.equal((c as { closedMs?: number }).closedMs, undefined);
  assert.equal(d.event, 'quit'); assert.equal((d as { cause?: string }).cause, 'session-end');
  assert.match(describeJournalEntry(a, plain), /应用启动（0\.1\.0 · b74e371） · 上次 \d\d:\d\d 退出（托盘退出），关了 8 小时 12 分$/);
  assert.match(describeJournalEntry(b, plain), / · 上次没正常退出，最多关了 3 小时 12 分（估的：按 \d\d:\d\d 最后一次还在算）$/);
  assert.match(describeJournalEntry(c, plain), / · 没有上次退出的记录$/);
  assert.match(describeJournalEntry(d, plain), /应用退出（0\.1\.0 · b74e371） · 关机或注销$/);
  for (const line of [a, b, c, d]) assert.deepEqual(readJournalLine(JSON.stringify(line)), line, 'reads back the same');
  // Nothing else gets in: free text in the new places is dropped, and lines from before I-022 still read back as they were.
  const smuggled = buildJournalEntry({ type: 'app', characterId: 'mira', event: 'start', version: '0.1.0', commit: null, stopped: 'clean', stoppedAt: '昨天', closedMs: 5,
    cause: '我关掉了她', note: 'secret' }, T0)!;
  assert.equal(JSON.stringify(smuggled).includes('昨天') || JSON.stringify(smuggled).includes('secret') || JSON.stringify(smuggled).includes('我关掉了她'), false);
  assert.equal(smuggled.reason, '应用启动'); assert.equal((smuggled as { stopped?: string }).stopped, undefined);
  const old = buildJournalEntry({ type: 'app', characterId: 'gene', event: 'quit', version: '0.1.0', commit: 'b74e371' }, T0)!;
  assert.deepEqual(readJournalLine(JSON.stringify(old)), old);
  assert.equal(describeJournalEntry(old, plain).endsWith('应用退出（0.1.0 · b74e371）'), true);
  assert.match(describeJournalEntry(buildJournalEntry({ type: 'app', characterId: 'gene', event: 'start', version: '0.1.0', commit: null, stopped: 'clean',
    stoppedAt: T0 + HOUR, closedMs: 0, cause: 'tray', clockBack: true }, T0)!, plain), /电脑时间比上次停下时还早/);
});

test('one number: the closed time her fatigue rests is the closed time the journal line shows', async t => {
  const dir = await profile(t), clock = { now: T0 };
  const first = session(dir, clock); first.host.begin(); clock.now += 30 * MINUTE; first.host.stop('tray');
  await writeFile(path.join(dir, 'fatigue-state.json'), JSON.stringify({ version: 1, profiles: [{ characterId: 'mira', A: 0.75, F: 0.69, W: 0, phase: 'awake', wallMs: clock.now }] }));
  clock.now += 7 * HOUR + 3 * MINUTE;
  const last = session(dir, clock).host.begin()!;
  const fatigue = new FatigueHost(dir, { monotonicMs: () => 1_000, wallMs: () => clock.now, localMinute: wall => ((wall / MINUTE) % 1440 + 1440) % 1440 });
  await fatigue.load(); fatigue.setLastStop(last);
  const view = fatigue.activate('mira', { D: 50, O: 50, E: 50, N: 50, C: 50 }, { D: 50, O: 50, E: 50, N: 50, C: 50 });
  const journal = new AppJournal({ profileDirectory: () => dir, enabled: () => true, characters: () => null, publish: () => {}, clock: () => clock.now, publishDelayMs: 0 });
  journal.appStarted('0.1.0', null, 'mira', last); await journal.flush();
  const [line] = await journalLines(dir);
  assert.equal(fatigue.restNote('mira')!.awayMs, (line as { closedMs?: number }).closedMs);
  assert.equal(last.closedMs, 7 * HOUR + 3 * MINUTE);
  assert.ok(view.A < 0.75, 'and she rested');
});

test('main.ts wiring: the stop is written first thing in before-quit and on session-end; the closed time reaches her before she wakes', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const beforeQuit = main.slice(main.indexOf('app.on("before-quit", event => {'));
  assert.match(beforeQuit.split('\n')[1] ?? '', /appJournal\.appQuitting\(.*appSession\.stop\(\)\)/, 'the first line of before-quit writes the stop');
  assert.match(main, /win\.on\('session-end', \(\) => \{ appJournal\.appQuitting\(.*appSession\.stop\('session-end'\)\)/);
  // Startup: the companion loads, the closed time is handed over, then the first character's context (her fatigue wakes there).
  const loaded = main.indexOf('      await companion.load();'), begin = main.indexOf('companion.mood.noteLastStop(appSession.begin())');
  const wake = main.indexOf('await companion.context(', loaded);
  assert.ok(loaded > 0 && begin > loaded && wake > begin, 'begin() after the companion loads and before the first character wakes');
  assert.match(main, /appJournal\.appStarted\(.*appSession\.lastStop\(\)\)/);
  for (const [cause, where] of [['tray', /t\("退出 soft hearts"\), click: \(\) => \{ appSession\.noteCause\('tray'\); app\.quit\(\); \}/],
    ['controls', /host\("quit", \(\) => \{ appSession\.noteCause\('controls'\); app\.quit\(\); \}\)/],
    ['quit-request', /quit: \(\) => \{ appSession\.noteCause\('quit-request'\); app\.quit\(\); \}/]] as const) assert.match(main, where, cause);
});
