// Where raw chat text from the measurement scripts goes: flag, then SOFT_HEARTS_PRIVATE_DIR, then .local/private-dir.txt, then the default.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describePrivateDir, resolvePrivateDir, resolveRawFolder } from '../scripts/lib/private-dir';

function withRoot(body: (root: string, home: string, abs: (name: string) => string) => void) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'private-dir-test-'));
  try {
    const root = path.join(base, 'repo'), home = path.join(base, 'home');
    mkdirSync(path.join(root, '.local'), { recursive: true });
    body(root, home, name => path.join(base, name));
  } finally { rmSync(base, { recursive: true, force: true }); }
}

test('the order is flag, environment variable, local file, default', () => withRoot((root, home, abs) => {
  writeFileSync(path.join(root, '.local', 'private-dir.txt'), `\n  ${abs('from-file')}  \r\nignored second line\n`);
  const env = { SOFT_HEARTS_PRIVATE_DIR: abs('from-env') };
  assert.deepEqual(resolvePrivateDir({ flag: abs('from-flag'), env, root, home }), { dir: abs('from-flag'), source: 'flag' });
  assert.deepEqual(resolvePrivateDir({ env, root, home }), { dir: abs('from-env'), source: 'env' });
  assert.deepEqual(resolvePrivateDir({ env: {}, root, home }), { dir: abs('from-file'), source: 'local-file' });
  rmSync(path.join(root, '.local', 'private-dir.txt'));
  assert.deepEqual(resolvePrivateDir({ env: {}, root, home }), { dir: path.join(home, '.soft-hearts-raw'), source: 'default' });
}));

test('a blank flag, a blank variable and a relative or empty file are skipped', () => withRoot((root, home) => {
  writeFileSync(path.join(root, '.local', 'private-dir.txt'), 'relative/folder\n');
  assert.equal(resolvePrivateDir({ flag: ' ', env: { SOFT_HEARTS_PRIVATE_DIR: '  ' }, root, home }).source, 'default', 'a relative path is not trusted');
  writeFileSync(path.join(root, '.local', 'private-dir.txt'), '﻿\n\n');
  assert.equal(resolvePrivateDir({ env: {}, root, home }).source, 'default');
}));

test('a script folder is the flag as given, or the base plus its own name; the printed line says where and why', () => withRoot((root, home, abs) => {
  writeFileSync(path.join(root, '.local', 'private-dir.txt'), abs('private'));
  const fromFile = resolveRawFolder('speech-beats-measure', { env: {}, root, home });
  assert.equal(fromFile.dir, path.join(abs('private'), 'speech-beats-measure'));
  assert.match(describePrivateDir(fromFile), /\.local\/private-dir\.txt/u);
  assert.match(describePrivateDir(fromFile), new RegExp(path.join(abs('private'), 'speech-beats-measure').replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&'), 'u'));
  assert.equal(resolveRawFolder('x', { flag: abs('exact'), env: {}, root, home }).dir, abs('exact'), 'the flag is the folder itself');
  assert.match(describePrivateDir(resolveRawFolder('x', { env: {}, root: abs('nothing-here'), home })), /default/u);
}));
