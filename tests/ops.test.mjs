// The everyday-operations entry point (scripts/dev/ops.mjs, I-141): safe operations run, careful ones print first and need --go,
// and every script an operation names exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPS, finish, listText, plan } from '../scripts/dev/ops.mjs';
import { shortcutName } from '../scripts/lib/app-identity.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the list shows every operation with its Chinese line, careful ones with what to watch', () => {
  const text = listText();
  for (const [name, op] of Object.entries(OPS)) {
    assert.ok(text.includes(name) && text.includes(op.what), name);
    if (op.kind === 'careful') assert.ok(op.watch && text.includes(op.watch), `${name} says what to watch`);
  }
  assert.deepEqual(plan([]).list, text);
});

test('a safe operation runs with the extra arguments after its own', () => {
  const run = plan(['affected', '--files', 'a.ts']).run;
  assert.deepEqual(run.slice(1), ['scripts/dev/test-affected.mjs', '--files', 'a.ts']);
});

test('a careful operation only prints until --go, and --go is not passed on to the script', () => {
  const first = plan(['quit-dev']);
  assert.equal(first.run, undefined);
  assert.match(first.print, /要小心/);
  assert.match(first.print, /--go/);
  const go = plan(['quit-dev', '--go', '--timeout-seconds', '30']).run;
  assert.deepEqual(go.slice(1), ['scripts/experience/quit-app.mjs', '--channel', 'development', '--timeout-seconds', '30']);
  assert.ok(!go.includes('--go'));
  for (const name of ['deploy-dev', 'quit-stable', 'open-stable', 'stage-stable', 'rollback-stable']) assert.equal(plan([name]).run, undefined, name);
});

test('tidy-occupancy is a safe operation that runs presence.mjs --tidy', () => {
  assert.equal(OPS['tidy-occupancy'].kind, 'run');
  assert.deepEqual(plan(['tidy-occupancy']).run.slice(1), ['scripts/dev/presence.mjs', '--tidy']);
});

test('an unknown name is an error that shows the list', () => {
  assert.match(plan(['nope']).error, /没有叫「nope」/);
  assert.equal(plan(['toString']).error !== undefined, true, 'no prototype names');
});

// The public snapshot leaves out the maintainer's pre-trial, experience, test-env and release tooling (scripts/release/export-public.mjs); the menu still names them.
const MAINTAINER_ONLY = /^scripts\/(?:(?:pretrial|experience|test-env|release)\/|dev\/(?:real-disk|guard-paths-hook|relay-retire-hook|soak|soak-use|soak-unbound|gpu-reset-check|english-ui-audit)\.mjs|unbound\/step6-probe\.mjs)/;
const isSnapshot = !existsSync(path.join(REPO, 'scripts', 'pretrial'));

test('every repository script an operation names exists', () => {
  for (const [name, op] of Object.entries(OPS)) {
    for (const part of op.command([])) {
      if (isSnapshot && MAINTAINER_ONLY.test(part)) continue;
      if (/^(?:scripts|node_modules)\//.test(part)) assert.ok(existsSync(path.join(REPO, part)), `${name}: ${part}`);
    }
  }
});

// 2026-11-18: open-dev passed "…最新开发版.lnk.lnk"; explorer opened nothing and said nothing.
test('open-dev and open-stable hand explorer the shortcut the deploy writes, with one ".lnk"', () => {
  for (const [name, channel] of [['open-dev', 'development'], ['open-stable', 'stable']]) {
    const target = plan([name, '--go']).run.at(-1);
    assert.equal(path.basename(target), shortcutName(channel), name);
    assert.ok(!/\.lnk\.lnk$/i.test(target), name);
  }
});

// 2026-11-19: open-dev exited 1 with no words while she had opened fine; explorer always returns 1 after handing over.
test('explorer returning 1 counts as handed over and says so; other programs keep their exit code', () => {
  const opened = finish(plan(['open-dev', '--go']).run[0], 1);
  assert.equal(opened.code, 0);
  assert.match(opened.note, /explorer/);
  assert.equal(finish(process.execPath, 1).code, 1);
  assert.equal(finish(process.execPath, 0).code, 0);
  assert.equal(finish('C:\\Windows\\explorer.exe', 5).code, 5, 'an odd explorer code is still reported');
});

test('mutate runs under the heavy job slot, except --list and --check which run no tests', () => {
  assert.deepEqual(plan(['mutate', '--part', 'senses']).run.slice(1), ['scripts/dev/heavy.mjs', '--label', 'mutate', '--', process.execPath, 'scripts/dev/mutate.mjs', '--part', 'senses']);
  assert.deepEqual(plan(['mutate', '--check']).run.slice(1), ['scripts/dev/mutate.mjs', '--check']);
  assert.deepEqual(plan(['sizes', '--no-write']).run.slice(1), ['scripts/dev/size-check.mjs', '--no-write']);
});
