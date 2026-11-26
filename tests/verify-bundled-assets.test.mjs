// `pnpm build` (and so the first install) starts with scripts/verify-bundled-assets.mjs; a bundled file it does not know stops the
// build. The unit suite did not run it, so the two preinstalled models passed every test and failed the candidate (2026-11-25).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every bundled file is reviewed: the build\'s first step passes on this tree', { skip: !existsSync(path.join(root, 'assets', 'bundled')) && 'no bundled assets here' }, () => {
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-bundled-assets.mjs')], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-1200));
  assert.match(run.stdout, /Bundled assets verified/);
});
