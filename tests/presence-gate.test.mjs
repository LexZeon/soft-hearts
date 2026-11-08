// I-030 "我在用电脑": Claude's heavy work follows the user's tray check box (scripts/dev/presence.mjs). These pin the rules the
// user agreed to: "在" (checked, the default, and whenever the tray is gone) caps heavy work; "不在" lifts the cap; and the heavy
// entry points cannot quietly bypass it.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { affinityMask, liveSlots, mayStart, PRESENT_LIMITS, readPresence, takeSlot } from '../scripts/dev/presence.mjs';

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
