// Codex T-241 (2026-11-12): electron/mood/mood.ts chatContext had no words for the 'fright' context, so a turn after a scare
// read "话题情境undefined". Every MoodContext must have its words; the host's line never contains "undefined".
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MoodHost } from '../electron/mood/mood';
import { MOOD_CONTEXTS } from '../shared/foundation/mood';

async function withMood(run: (mood: MoodHost) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-mood-fright-'));
  const mood = new MoodHost(directory, () => {}, () => 1_000_000);
  try { await mood.load(); mood.activate('gene'); mood.setExpressions(true); await run(mood); }
  finally { await mood.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

test('after a scare the chat context names it (受到惊吓) and never says undefined', async () => {
  await withMood(async mood => {
    assert.ok(mood.lift({ id: 'scare', delta: { N: 6, C: 5, E: -4 }, reason: '被吓了一跳', context: 'fright' }), 'the lift is taken');
    const line = mood.chatContext();
    assert.ok(line.length > 0, 'expressions are on, so there is a line');
    assert.doesNotMatch(line, /undefined/);
    assert.match(line, /受到惊吓/);
  });
});

test('every mood context has its words in the chat context', async () => {
  for (const context of MOOD_CONTEXTS) {
    await withMood(async mood => {
      mood.lift({ id: `c-${context}`, delta: { O: 2 }, reason: '测试', context });
      assert.doesNotMatch(mood.chatContext(), /undefined/, context);
    });
  }
});
