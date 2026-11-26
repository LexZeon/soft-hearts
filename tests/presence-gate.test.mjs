// I-030 "我在用电脑": Claude's heavy work follows the user's tray check box (scripts/dev/presence.mjs). These pin the rules the
// user agreed to: "在" (checked, the default, and whenever the tray is gone) caps heavy work; "不在" lifts the cap; and the heavy
// entry points cannot quietly bypass it.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { affinityMask, legacyPresenceDir, liveSlots, mayStart, occupancyDeadline, otherOccupancy, presenceDir, PRESENT_LIMITS, readPresence, registerHeavyOccupancy, takeSlot, waitForOthers } from '../scripts/dev/presence.mjs';

const root = path.resolve(import.meta.dirname, '..');
function withDir(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-presence-test-'));
  try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const write = (dir, state) => writeFileSync(path.join(dir, 'presence.json'), JSON.stringify(state));
const now = Date.parse('2026-11-04T20:00:00Z');

test('"在" unless the tray says "不在" and is still alive: no tray, a bad file, an old heartbeat all count as "在"', () => withDir(dir => {
  assert.deepEqual(readPresence({ dir, now }), { present: true, reason: 'no-tray' });
  writeFileSync(path.join(dir, 'presence.json'), '{not json');
  assert.equal(readPresence({ dir, now }).reason, 'unreadable');
  write(dir, { version: 1, present: false, heartbeatAt: new Date(now - 10_000).toISOString() });
  assert.deepEqual(readPresence({ dir, now }), { present: false, reason: 'away' });
  write(dir, { version: 1, present: false, heartbeatAt: new Date(now - 3 * 60_000).toISOString() });
  assert.deepEqual(readPresence({ dir, now }), { present: true, reason: 'tray-stale' }, 'the tray stopped: back to the cap');
  write(dir, { version: 1, present: true, heartbeatAt: new Date(now).toISOString() });
  assert.equal(readPresence({ dir, now }).present, true);
  writeFileSync(path.join(dir, 'presence.json'), '﻿' + JSON.stringify({ present: false, heartbeatAt: new Date(now).toISOString() }));
  assert.equal(readPresence({ dir, now }).present, false, 'a BOM written by Windows tools is fine');
}));

// 2026-11-12: the Claude desktop app is a Windows package and sees a private copy of AppData,
// so the tray's file under %LOCALAPPDATA% and the one Claude read were two files; Claude read a copy from 11-05. The shared folder
// is now in the user folder (not virtualized), and an older tray's folder is still read while it is fresh.
// (tools/presence-tray/PresenceTray.cs and install.ps1 name the same folder; they are not in the frozen validation copy, so
// this test does not read them.)
test('the tray and Claude share a folder outside AppData', () => {
  const env = { USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  assert.equal(presenceDir(env), path.join('C:\\Users\\me', '.claude-presence'));
  assert.ok(!presenceDir(env).includes('AppData'), 'never under AppData');
  assert.equal(legacyPresenceDir(env), path.join('C:\\Users\\me\\AppData\\Local', 'claude-presence'));
  assert.equal(presenceDir({ ...env, CLAUDE_PRESENCE_DIR: 'D:\\x' }), 'D:\\x');
  assert.equal(legacyPresenceDir({ ...env, CLAUDE_PRESENCE_DIR: 'D:\\x' }), null, 'a folder given explicitly is the only one read');
});

test('an older tray\'s fresh answer is used while the shared folder has none; the shared folder wins when it is fresh', () => withDir(main => withDir(old => {
  const beat = (present, ago = 10_000) => ({ version: 1, present, heartbeatAt: new Date(now - ago).toISOString() });
  assert.deepEqual(readPresence({ dir: main, legacy: old, now }), { present: true, reason: 'no-tray' });
  write(old, beat(false));
  assert.deepEqual(readPresence({ dir: main, legacy: old, now }), { present: false, reason: 'away' }, 'the older tray says 不在');
  write(main, beat(true, 3 * 60_000));
  assert.deepEqual(readPresence({ dir: main, legacy: old, now }), { present: false, reason: 'away' }, 'a stale shared file does not hide a fresh older one');
  write(main, beat(true));
  assert.deepEqual(readPresence({ dir: main, legacy: old, now }), { present: true, reason: 'present' }, 'the shared folder wins when fresh');
  write(main, beat(false, 3 * 60_000)); write(old, beat(false, 3 * 60_000));
  assert.equal(readPresence({ dir: main, legacy: old, now }).reason, 'tray-stale', 'both stale: "在"');
  assert.deepEqual(readPresence({ dir: main, now }), { present: true, reason: 'tray-stale' }, 'an explicit folder alone ignores the older one');
})));

test('"在": one heavy job at a time; "不在": no cap', () => {
  assert.equal(PRESENT_LIMITS.maxHeavy, 1);
  assert.equal(mayStart({ present: true }, 0), true);
  assert.equal(mayStart({ present: true }, 1), false, 'the second one waits');
  assert.equal(mayStart({ present: false }, 5), true);
});

test('"在" gives half the cores (10 of 20); "不在" all of them', () => {
  assert.equal(PRESENT_LIMITS.cores, 10);
  assert.equal(affinityMask(true, 20), 0b1111111111);
  assert.equal(affinityMask(false, 20), 2 ** 20 - 1);
  assert.equal(affinityMask(true, 4), 0b1111, 'a smaller machine keeps all it has');
});

test('slots: a running heavy job is counted, a finished one is swept, our own is left out', () => withDir(dir => {
  const release = takeSlot('full test suite', { dir, pid: 111 });
  takeSlot('pretrial', { dir, pid: 222 });
  mkdirSync(path.join(dir, 'slots'), { recursive: true });
  const isAlive = pid => pid !== 222;
  assert.deepEqual(liveSlots({ dir, isAlive }), [{ pid: 111, label: 'full test suite' }]);
  assert.deepEqual(liveSlots({ dir, isAlive, except: 111 }), []);
  release();
  assert.deepEqual(liveSlots({ dir, isAlive }), []);
}));

test('the heavy entry points gate themselves, so a direct call cannot bypass the cap', () => {
  const update = readFileSync(path.join(root, 'scripts', 'update-desktop.mjs'), 'utf8');
  assert.match(update, /if \(mode === '--prepare' \|\| mode === '--install'\) await gateHeavy\(/u, 'prepare and install');
  // The pre-trial runner is the maintainer's own tooling and is not in the public snapshot; check it only where it exists.
  const pretrialFile = path.join(root, 'scripts', 'pretrial', 'run.mjs');
  if (existsSync(pretrialFile)) assert.match(readFileSync(pretrialFile, 'utf8'), /await gateHeavy\(/u, 'pretrial');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/dev/test-all.mjs', 'the full suite runs through the gate');
  assert.match(readFileSync(path.join(root, 'scripts', 'dev', 'test-all.mjs'), 'utf8'), /await gateHeavy\(/u);
});

test('a heavy job puts one line on the occupancy sign while it runs and takes exactly that line off (Codex X-403)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'occupancy-'));
  try {
    const file = path.join(dir, 'sign.md');
    const before = '# 真机占用\r\n\r\n## 当前登记\r\n\r\n- Codex 某任务｜开始｜结束｜用途\r\n';
    writeFileSync(file, before, 'utf8');
    const helpers = {
      formatOccupancyLine: ({ who, start, end, purpose }) => `${who}｜${start}｜${end}｜${purpose}`,
      addOccupancy: (text, line) => `${text}${line}\r\n`,
      removeOccupancy: (text, line) => text.split('\r\n').filter(value => value !== line).join('\r\n'),
    };
    const remove = await registerHeavyOccupancy('full test suite | with a bar\nand a newline', { helpers, file, pid: 4242, now: new Date(2026, 10, 11, 5, 30) });
    const during = readFileSync(file, 'utf8');
    const added = during.split('\r\n').filter(line => line.includes('pid 4242'));
    assert.equal(added.length, 1);
    assert.match(added[0], /2026-11-11 05:30/u);
    assert.match(added[0], /full test suite with a bar and a newline/u, 'the label is cleaned of separators');
    assert.ok(during.includes('Codex 某任务'), 'other lines stay');
    remove(); remove();
    assert.equal(readFileSync(file, 'utf8').includes('pid 4242'), false);
    assert.ok(readFileSync(file, 'utf8').includes('Codex 某任务'));
    // No sign (another computer) or no maintainer tooling: nothing is written and the remover is harmless.
    const missing = path.join(dir, 'missing.md');
    const noop = await registerHeavyOccupancy('x', { helpers, file: missing });
    noop();
    assert.equal(existsSync(missing), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('before a heavy job starts it waits, bounded, while another worker has a line on the occupancy sign (Codex, C-211 reply)', async () => {
  const sign = others => `# 真机占用\r\n\r\n## 当前登记\r\n\r\n${others.join('\r\n')}\r\n`;
  assert.deepEqual(otherOccupancy(sign(['- Main 01a1 / T113 job｜开始｜截止｜用途', 'Claude 重活 pid 1（scripts/dev/presence.mjs）｜a｜b｜c', '- Claude 预试用 abc｜a｜b｜c'])), ['- Main 01a1 / T113 job｜开始｜截止｜用途']);
  assert.deepEqual(otherOccupancy('# 真机占用\n\n## 当前登记\n\n\n\n'), []);
  assert.deepEqual(otherOccupancy('no section at all'), []);
  // Free at once.
  assert.equal(await waitForOthers(() => sign([]), { wait: async () => {} }), 'free');
  // Another worker's line goes away after two polls: we waited.
  let polls = 0;
  const logs = [];
  assert.equal(await waitForOthers(() => sign(polls < 2 ? ['- Main T113 cargo｜a｜b｜c'] : []), { wait: async () => { polls++; }, log: line => logs.push(line), label: 'full test suite' }), 'waited');
  assert.equal(polls, 2);
  assert.match(logs[0], /等它做完/u);
  // A line with a deadline is waited for past any fixed time, until its own deadline (+5 min grace) has passed.
  const base = Date.parse('2026-11-11T05:00:00-08:00');
  let now = base;
  const live = '- Main T113 job｜预留待启动，最迟 2026-11-11 05:02:13 -08:00｜绝对截止 2026-11-11 06:30:00 -08:00｜用途';
  assert.equal(occupancyDeadline(live), Date.parse('2026-11-11T06:30:00-08:00'));
  assert.equal(occupancyDeadline('- Main job｜no deadline here'), null);
  assert.equal(await waitForOthers(() => sign([live]), { pollMs: 60_000, wait: async ms => { now += ms; }, clock: () => now }), 'stale');
  assert.ok(now >= Date.parse('2026-11-11T06:35:00-08:00') && now < Date.parse('2026-11-11T06:37:00-08:00'), 'waited 95 minutes, until the deadline plus grace');
  // A line that states no deadline at all is waited for at most an hour.
  now = base;
  assert.equal(await waitForOthers(() => sign(['- Main stale｜a｜b｜c']), { pollMs: 60_000, wait: async ms => { now += ms; }, clock: () => now }), 'stale');
  assert.equal(now - base, 60 * 60_000);
  // No sign: nothing to wait for.
  assert.equal(await waitForOthers(() => null, { wait: async () => {} }), 'free');
});
