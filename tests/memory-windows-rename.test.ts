import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

// mood-smoke on Windows: deleting a memory failed with
// "EPERM: operation not permitted, rename 'memories.jsonl.<id>.tmp' -> 'memories.jsonl'". A short sharing lock
// (OneDrive, antivirus, indexer) on the journal makes the replacing rename fail for a moment; the project's
// atomic writer (electron/atomic-file.ts) waits that out on win32, the memory journal's compaction did not.
// The production MemoryStore and atomic writer run unchanged; only node:fs/promises' rename is the fixture.
async function storeWithLockedRenames(locks: number) {
  const key = 'memoryRenameFixture' + randomUUID().replaceAll('-', '');
  const state = { locks, attempts: 0 };
  (globalThis as any)[key] = {
    ...fs,
    rename: async (from: string, to: string) => {
      state.attempts++;
      if (path.basename(to) === 'memories.jsonl' && state.locks > 0) {
        state.locks--;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
      }
      return fs.rename(from, to);
    },
  };
  const names = Object.keys(fs).filter(name => /^[a-zA-Z]\w*$/.test(name) && name !== 'default');
  const compiled = await build({ entryPoints: ['electron/memory.ts'], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22',
    plugins: [{ name: 'fs-promises-fixture', setup(b) {
      b.onResolve({ filter: /^(?:node:)?fs\/promises$/ }, () => ({ path: 'fs-promises', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `const f=globalThis[${JSON.stringify(key)}];${names.map(name => `export const ${name}=f.${name};`).join('')}` }));
    } }] });
  const { MemoryStore } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  return { MemoryStore, state, dispose: () => { delete (globalThis as any)[key]; } };
}

test('deleting a memory survives a short Windows sharing lock on the journal', { skip: process.platform !== 'win32' && 'the sharing-lock retry is Windows-only by design' }, async () => {
  const fixture = await storeWithLockedRenames(0);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-memory-rename-'));
  try {
    const scope = { characterId: 'gene', providerScope: 'claude:haiku' };
    const store = new fixture.MemoryStore(directory);
    await store.load();
    const handle = await store.beginTurn(scope, { id: 'turn', userText: '一起听原创音乐', at: 1_800_000_000_000 });
    await store.appendAssistant(scope, 'turn', '好呀', 1_800_000_000_001);
    await store.finishTurn(scope, 'turn', 'complete', 1_800_000_000_002);
    fixture.state.locks = 2; // two failed attempts, then the lock is gone
    assert.equal(await store.delete(scope, handle.recordId), true);
    assert.equal(fixture.state.locks, 0);
    assert.doesNotMatch(await fs.readFile(path.join(directory, 'memories.jsonl'), 'utf8'), /一起听原创音乐/, 'the deleted original is gone from the journal');
    assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), [], 'no temporary journal is left behind');
    await store.flush();
  } finally {
    fixture.dispose();
    assert.ok(path.basename(directory).startsWith('soft-memory-rename-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
