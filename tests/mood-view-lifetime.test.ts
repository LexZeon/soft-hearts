import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { MoodViewLifetime } from '../src/ui/mood-view-lifetime';
import { FatigueHost, SYSTEM_FATIGUE_CLOCK } from '../electron/fatigue-host';

test('same revision cannot carry a different token/character and old reads cannot resurrect a reset scope', () => {
  const guard = new MoodViewLifetime();
  assert.equal(guard.accept({ characterId: 'a', token: 'token_a', revision: 10 }), true);
  assert.equal(guard.accept({ characterId: 'a', token: 'token_b', revision: 10 }), false);
  assert.equal(guard.accept({ characterId: 'b', token: 'token_a', revision: 10 }), false);
  const oldRead = guard.ticket(); guard.invalidate();
  assert.equal(guard.accept({ characterId: 'a', token: 'token_a', revision: 11 }, oldRead), false);
  assert.equal(guard.accept({ characterId: 'a', token: 'token_a', revision: 10 }), false);
  const newRead = guard.ticket(); assert.equal(guard.accept({ characterId: 'b', token: 'token_b', revision: 12 }, newRead), true);
  assert.equal(guard.accept({ characterId: 'a', token: 'token_a', revision: 11 }), false);
  assert.equal(guard.isCurrent(newRead), false); guard.dispose();
  assert.equal(guard.accept({ characterId: 'b', token: 'token_b', revision: 13 }), false);
});

test('actual host exports a larger revision even when a non-view refresh rotated its token', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url)), target = path.resolve(process.env.FATIGUE_MOOD_TEST_TARGET ?? path.join(root, 'electron/mood.ts'));
  assert.ok([path.join(root, 'electron/mood.ts')].includes(target));
  const text = await readFile(target, 'utf8'), requireBase = createRequire(path.join(root, 'electron/mood.ts'));
  const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled)((name: string) => name === './fatigue-host' ? { FatigueHost, SYSTEM_FATIGUE_CLOCK } : requireBase(name), module, module.exports);
  const dir = await mkdtemp(path.join(tmpdir(), 'soft-hearts-fatigue-revision-')); let wall = 1_790_000_000_000, mono = 0;
  const host = new module.exports.MoodHost(dir, () => {}, () => wall,
    { fatigueClock: { wallMs: () => wall, monotonicMs: () => mono, localMinute: () => 900 } });
  try {
    await host.load(); host.activate('gene'); const before = host.get(); wall += 6000; mono += 6000;
    // This body call refreshes/rotates the stale scope but takes its invalid-token
    // return before publish. The subsequent direct view must still order scopes.
    host.prepareBodyPresentation(before.token, true); const after = host.get();
    assert.notEqual(after.token, before.token); assert.ok(after.revision > before.revision, 'A new token requires a strictly newer exported revision.');
  } finally {
    await host.flush(); const resolved = path.resolve(dir); assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('soft-hearts-fatigue-revision-')); await rm(resolved, { recursive: true, force: true });
  }
});
