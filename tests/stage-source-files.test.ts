import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('both smokes take their stage file list from the helper', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of ['scripts/crying-smoke.mjs', 'scripts/body-motion-qa-smoke.mjs']) {
    const text = await readFile(path.join(root, name), 'utf8');
    assert.match(text, /stageSourceFiles\(/, `${name} uses stageSourceFiles`);
  }
});
