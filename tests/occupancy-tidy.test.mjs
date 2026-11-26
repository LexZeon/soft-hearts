// Our stale lines on the bridge's 真机占用.md are cleared by presence.mjs (2026-11-16). Temp files and a fake process lookup only;
// the real bridge file is never touched here.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isOurCommand, tidyOccupancy } from '../scripts/dev/occupancy-tidy.mjs';
import { registerHeavyOccupancy, tidyOccupancyFile } from '../scripts/dev/presence.mjs';

const now = Date.parse('2026-11-16T12:00:00-08:00');
const heavy = (pid, start = '2026-11-16 11:30 -08:00') => `Claude 重活 pid ${pid}（scripts/dev/presence.mjs）｜${start}｜跑完自动删掉这一行｜full test suite`;
const CODEX = '- Codex 某任务｜2026-11-16 01:00 -08:00｜约 02:00｜用途';
const sign = (lines, eol = '\r\n') => ['# 真机占用', '', '## 当前登记', '', ...lines, ''].join(eol);
const ours = 'node C:\\repo\\scripts\\dev\\test-all.mjs';
const lookupOf = table => pids => new Map(pids.filter(pid => pid in table).map(pid => [pid, table[pid]]));

test('a dead pid is removed', () => {
  const result = tidyOccupancy(sign([heavy(1)]), { now, lookup: lookupOf({}) });
  assert.deepEqual(result.removed, [heavy(1)]);
  assert.equal(result.text, sign([]));
});

test('a live process that is not ours (pid reused) is removed', () => {
  const result = tidyOccupancy(sign([heavy(2)]), { now, lookup: lookupOf({ 2: 'node C:\\other\\server.js' }) });
  assert.deepEqual(result.removed, [heavy(2)]);
});

test('a live process that is ours is kept; one whose command line cannot be read is kept too', () => {
  const text = sign([heavy(3), heavy(4)]);
  const result = tidyOccupancy(text, { now, lookup: lookupOf({ 3: ours, 4: null }) });
  assert.deepEqual(result.removed, []);
  assert.equal(result.text, text);
});

test('Codex and anyone else\'s lines are kept, even when they look like ours', () => {
  const lines = [CODEX, '- Main 01a1 job｜a｜b｜c', 'Claude 预试用 abc1234｜2026-11-01 01:00 -08:00｜约 02:00｜x', 'Claude 重活 pid 5（别处）｜2026-11-01 01:00 -08:00｜b｜c'];
  const result = tidyOccupancy(sign(lines), { now, lookup: lookupOf({}) });
  assert.deepEqual(result.removed, []);
  assert.equal(result.text, sign(lines));
});

test('a line older than 12 hours is removed whatever its process says', () => {
  const old = heavy(6, '2026-11-15 23:00 -08:00');
  const fresh = heavy(7, '2026-11-16 00:30 -08:00');
  const result = tidyOccupancy(sign([old, fresh]), { now, lookup: lookupOf({ 6: ours, 7: ours }) });
  assert.deepEqual(result.removed, [old]);
  assert.equal(result.text, sign([fresh]));
});

test('the header and blank lines stay; mixed lines keep their order', () => {
  const text = sign([CODEX, heavy(8), '', heavy(9), '- Main x｜a｜b｜c']);
  const result = tidyOccupancy(text, { now, lookup: lookupOf({ 9: ours }) });
  assert.equal(result.text, sign([CODEX, '', heavy(9), '- Main x｜a｜b｜c']));
});

test('line endings stay as the file had them (CRLF, LF, mixed)', () => {
  for (const eol of ['\r\n', '\n']) {
    const result = tidyOccupancy(sign([CODEX, heavy(10), heavy(11)], eol), { now, lookup: lookupOf({ 11: ours }) });
    assert.equal(result.text, sign([CODEX, heavy(11)], eol));
  }
  const mixed = `# h\r\n## 当前登记\n${heavy(12)}\r\n${CODEX}\n`;
  assert.equal(tidyOccupancy(mixed, { now, lookup: lookupOf({}) }).text, `# h\r\n## 当前登记\n${CODEX}\n`);
});

test('when the process lookup fails, only the age rule applies', () => {
  const old = heavy(13, '2026-11-10 01:00 -08:00');
  const result = tidyOccupancy(sign([old, heavy(14)]), { now, lookup: () => { throw new Error('no powershell'); } });
  assert.deepEqual(result.removed, [old]);
});

test('what counts as ours: this repo\'s path or presence / heavy / test-all', () => {
  assert.ok(isOurCommand('node C:\\x\\scripts\\dev\\heavy.mjs --label a', 'C:\\y'));
  assert.ok(isOurCommand('node D:/r/anything.js', 'D:\\R'));
  assert.equal(isOurCommand('node C:\\other\\server.js', 'C:\\y'), false);
  assert.equal(isOurCommand(null, 'C:\\y'), false);
});

test('registering and removing tidy the file; --tidy does the same alone and reports', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'occupancy-tidy-'));
  try {
    const file = path.join(dir, '真机占用.md');
    const helpers = {
      formatOccupancyLine: ({ who, start, end, purpose }) => `${who}｜${start}｜${end}｜${purpose}`,
      addOccupancy: (text, line) => `${text}${line}\r\n`,
      removeOccupancy: (text, line) => text.split('\r\n').filter(value => value !== line).join('\r\n'),
    };
    const lookup = lookupOf({ 4242: ours });
    writeFileSync(file, sign([CODEX, heavy(1), heavy(2)]));
    const remove = await registerHeavyOccupancy('suite', { helpers, file, pid: 4242, lookup, now: new Date(2026, 10, 16, 11, 0) });
    let text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('pid 1（') && !text.includes('pid 2（'), 'stale lines cleared when registering');
    assert.ok(text.includes('pid 4242') && text.includes('Codex 某任务'));
    writeFileSync(file, text.replace('\r\n\r\n## 当前登记', `\r\n${heavy(3)}\r\n\r\n## 当前登记`));
    remove();
    text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('pid 4242') && !text.includes('pid 3（'), 'stale line cleared when removing');
    assert.ok(text.includes('Codex 某任务'));

    writeFileSync(file, sign([CODEX, heavy(20)]));
    const logs = [];
    const removed = await tidyOccupancyFile({ file, lookup: lookupOf({}), now, log: line => logs.push(line) });
    assert.deepEqual(removed, [heavy(20)]);
    assert.equal(readFileSync(file, 'utf8'), sign([CODEX]));
    assert.match(logs[0], /清掉 1 条/u);
    assert.ok(logs[0].includes('pid 20'));
    logs.length = 0;
    assert.deepEqual(await tidyOccupancyFile({ file, lookup: lookupOf({}), now, log: line => logs.push(line) }), []);
    assert.match(logs[0], /没有过期/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
