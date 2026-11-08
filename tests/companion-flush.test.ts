/**
 * CompanionService.flush() is what the quit path awaits (electron/main.ts before-quit) and what tests await before
 * deleting a profile folder. It must cover every writer the service owns: text memory and mood, and also 熟悉度
 * (relationship), her own life (her-life.json, saved on a 1 s timer) and her needs (her-needs.json, same). Found from
 * ENOTEMPTY cleanups under a full parallel suite (docs/claude/2026-11-03-codex-t112-fixes.md, item 4): those three were
 * still writing after flush(), so on quit up to a second of her-life / her-needs state could be lost.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/companion';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';

const provider = { kind: 'claude' as const, baseUrl: 'https://flush.invalid/v1', model: 'fixture' };
const exists = (file: string) => access(file).then(() => true, () => false);

test('flush waits for every writer the companion owns (memory, mood, relationship, her life, her needs)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-companion-flush-'));
  const service = new CompanionService(directory, () => {});
  try {
    await service.load(); await service.context('gene', provider, 'Gene');
    // Nothing changed yet: flush writes no her-life / her-needs file of its own.
    await service.flush();
    assert.equal(await exists(path.join(directory, 'her-life.json')), false, 'unchanged state writes nothing');
    assert.equal(await exists(path.join(directory, 'her-needs.json')), false);
    // Her life starts a state and would save it on its 1 s timer; a relationship write is started and not awaited
    // (as the interaction observer does). flush must leave both on disk.
    assert.equal(service.herLife.startNow('gene', 'daydream', { parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), mood: 'calm', localMinute: 14 * 60 }), 'daydream');
    void service.relationship.noteTouch('gene');
    await service.flush();
    assert.equal(await exists(path.join(directory, 'her-life.json')), true, 'her-life.json is on disk when flush resolves');
    assert.ok((await readdir(path.join(directory, 'relationship')).catch(() => [])).length > 0, 'the relationship write finished inside flush');
  } finally {
    service.herLife.dispose(); service.herNeeds.dispose();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
