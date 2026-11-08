// 体验记录 (E2): electron/journal/writer.ts appends one line per moment into <profile>/journal/<local date>.jsonl, never rotates
// or deletes, stops a full day with one `truncated` line, writes nothing while off, and a failing disk never reaches the caller.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { JournalWriter, nodeJournalFs, type JournalFs } from '../electron/journal/writer';
import { readJournalLine, type JournalInput } from '../shared/journal';

async function folder(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sh-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, 'journal');
}
const label = (characterId = 'gene'): JournalInput => ({ type: 'mood-label', characterId, from: 'calm', to: 'content' });
const lines = async (file: string) => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));

test('lines go into one file per local day and are only appended', async t => {
  const directory = await folder(t), clock = { now: new Date(2026, 10, 3, 23, 59, 50).getTime() };
  const writer = new JournalWriter({ directory: () => directory, enabled: () => true, clock: () => clock.now });
  writer.record(label());
  clock.now += 20_000; // past local midnight
  writer.record({ type: 'boredom', characterId: 'gene', level: 'look', value: 30 });
  writer.record(label('momo'));
  await writer.flush();
  assert.deepEqual((await readdir(directory)).sort(), ['2026-11-03.jsonl', '2026-11-04.jsonl']);
  assert.equal((await lines(path.join(directory, '2026-11-03.jsonl'))).length, 1);
  const second = await lines(path.join(directory, '2026-11-04.jsonl'));
  assert.deepEqual(second.map(entry => [entry.type, entry.characterId]), [['boredom', 'gene'], ['mood-label', 'momo']]);
  // A second writer (an app restart) adds to the same day's file, never replaces it.
  const again = new JournalWriter({ directory: () => directory, enabled: () => true, clock: () => clock.now });
  again.record(label());
  await again.flush();
  assert.equal((await lines(path.join(directory, '2026-11-04.jsonl'))).length, 3);
  assert.deepEqual(writer.recent('momo').map(entry => entry.characterId), ['momo']);
  assert.equal(writer.recent().length, 3);
});

test('off: nothing is written, kept or shown; on again writes from then', async t => {
  const directory = await folder(t), state = { on: false };
  const writer = new JournalWriter({ directory: () => directory, enabled: () => state.on });
  assert.equal(writer.record(label()), null);
  await writer.flush();
  await assert.rejects(readdir(directory), /ENOENT/);
  assert.deepEqual(writer.recent(), []);
  state.on = true;
  assert.ok(writer.record(label()));
  await writer.flush();
  assert.equal((await readdir(directory)).length, 1);
  state.on = false;
  assert.deepEqual(writer.recent(), [], 'the panel shows nothing while the switch is off');
  assert.equal((await readdir(directory)).length, 1, 'turning it off deletes nothing');
});

test('a full day gets one truncated line, keeps every earlier line and writes nothing more that day', async t => {
  const directory = await folder(t), clock = { now: new Date(2026, 10, 3, 12).getTime() };
  const writer = new JournalWriter({ directory: () => directory, enabled: () => true, clock: () => clock.now, dayLimitBytes: 2048 });
  for (let i = 0; i < 40; i++) writer.record(label());
  await writer.flush();
  const file = path.join(directory, '2026-11-03.jsonl');
  const written = await lines(file);
  assert.equal(written.at(-1).type, 'truncated');
  assert.equal(written.filter(entry => entry.type === 'truncated').length, 1);
  assert.ok(written.length > 3 && written.length < 40);
  assert.ok(written.slice(0, -1).every(entry => entry.type === 'mood-label'));
  assert.equal(writer.status().truncatedToday, true);
  // A restart finds the marker and still writes nothing more today; the next day starts fresh.
  const again = new JournalWriter({ directory: () => directory, enabled: () => true, clock: () => clock.now, dayLimitBytes: 2048 });
  again.record(label());
  await again.flush();
  assert.equal((await lines(file)).length, written.length);
  clock.now += 24 * 3_600_000;
  again.record(label());
  await again.flush();
  assert.equal((await lines(path.join(directory, '2026-11-04.jsonl'))).length, 1);
});

test('a failing disk never throws to the caller; the next good write clears the failure', async t => {
  const directory = await folder(t);
  let broken = true;
  const fs: JournalFs = { ...nodeJournalFs, append: async (file, text) => { if (broken) throw Object.assign(new Error('disk full: ' + file), { code: 'ENOSPC' }); return nodeJournalFs.append(file, text); } };
  const writer = new JournalWriter({ directory: () => directory, enabled: () => true, fs });
  assert.doesNotThrow(() => writer.record(label()));
  await writer.flush();
  assert.equal(writer.status().failure, 'ENOSPC', 'only the code, never the path');
  assert.equal(writer.recent().length, 1, 'still shown from memory');
  broken = false;
  writer.record(label());
  await writer.flush();
  assert.equal(writer.status().failure, null);
  assert.equal((await lines(path.join(directory, (await readdir(directory))[0]))).length, 1);
  // A directory or clock that throws is the same: nothing reaches the caller.
  const worse = new JournalWriter({ directory: () => { throw new Error('x'); }, enabled: () => { throw new Error('y'); }, clock: () => { throw new Error('z'); } });
  assert.equal(worse.record(label()), null);
  await worse.flush();
});

test('after a restart the panel gets the newest lines back through the same whitelist', async t => {
  const directory = await folder(t), clock = { now: new Date(2026, 10, 3, 12).getTime() };
  const first = new JournalWriter({ directory: () => directory, enabled: () => true, clock: () => clock.now });
  for (let i = 0; i < 60; i++) { clock.now += 1_000; first.record({ type: 'boredom', characterId: 'gene', level: 'look', value: i }); }
  await first.flush();
  const file = path.join(directory, '2026-11-03.jsonl');
  await writeFile(file, (await readFile(file, 'utf8')) + '{"v":1,"at":1,"type":"mood-label","characterId":"gene","from":"calm","to":"我的秘密"}\nnot json\n', { flag: 'w' });
  const second = new JournalWriter({ directory: () => directory, enabled: () => true, clock: () => clock.now });
  await second.loadRecent();
  const recent = second.recent();
  assert.equal(recent.length, 50);
  assert.equal((recent.at(-1) as { value: number }).value, 59);
  assert.ok(!JSON.stringify(recent).includes('我的秘密'));
});

test('the writer source never renames, truncates or deletes a file', async () => {
  const source = await readFile(new URL('../electron/journal/writer.ts', import.meta.url), 'utf8');
  const code = source.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**')).join('\n');
  for (const call of ['unlink', 'rm', 'rmdir', 'rename', 'truncate', 'ftruncate', 'writeFile', 'copyFile', 'cp'])
    assert.ok(!new RegExp(`\\b${call}\\s*\\(`).test(code), call);
  assert.ok(/appendFile\(/.test(code));
  // And a written line is the whitelisted entry, read back the same.
  assert.equal(readJournalLine('{"v":1,"at":5,"type":"journal","characterId":null,"event":"on"}')?.reason, '体验记录开启');
});
