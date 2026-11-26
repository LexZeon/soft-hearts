// I-186 step 0: the brain wiring's side of the per-character chat processes (electron/wiring/brain-wiring.ts): where the pool reads whose
// turn it is and who is on stage, and that a deleted chat reaches the pool (her warm process closes even when she is off stage).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../electron/memory/memory';
import { chatSessionKey, poolIdentity, type PoolIdentitySources } from '../electron/brain/session-pool';
import { callArguments, expression } from './helpers/chat-world';
import { ownerSpeechScope } from '../electron/brain/turn-owner';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('the wiring: the pool reads the turn from the companion and the stage from the active card and the saved connection', () => {
  let switching = false;
  const committed = () => { if (switching) throw new Error('角色或对话正在切换，请稍后再试。'); return { characterId: 'one', providerScope: 'p-one' }; };
  const sources = expression<PoolIdentitySources>(callArguments('poolIdentity')[0], {
    companion: { currentScope: committed, conversationId: 'c7',
      // I-209 step 2: someone else on the full-screen stage ('bea') answers with her own seat; anyone else is not there.
      ownerScope(owner?: string) { if (owner === 'bea') return { characterId: 'bea', providerScope: 'p-one' }; if (owner && owner !== 'one') throw new Error('她不在台上。'); return committed(); },
      conversationOf: (id: string) => (id === 'bea' ? 'c-bea' : id === 'one' ? 'c7' : null), speechScopeOf: (id: string) => `seat-${id}` },
    ownerSpeechScope,
    speechScope: () => 'accepted-key', characterCards: { getActive: () => ({ id: 'gene' }) }, store: { current: { provider: { kind: 'claude', model: 'opus' } } },
    memoryProviderScope: (provider: { model: string }) => `scope-${provider.model}`,
  });
  const { turn, stage } = poolIdentity(sources);
  assert.deepEqual(turn(), { characterId: 'one', providerScope: 'p-one', accepted: 'accepted-key', chat: chatSessionKey('one', 'p-one', 'c7') });
  assert.deepEqual(stage(), { characterId: 'gene', providerScope: 'scope-opus' }, 'the card already active, even while the companion commits');
  assert.deepEqual(turn('one'), turn(), 'the desktop companion named as the owner: the same as before');
  assert.deepEqual(turn('bea'), { characterId: 'bea', providerScope: 'p-one', accepted: 'seat-bea', chat: chatSessionKey('bea', 'p-one', 'c-bea') }, 'I-209 step 2: her own slot and keys');
  assert.equal(turn('nobody'), null, 'not on stage: refused');
  switching = true;
  assert.equal(turn(), null, 'while a context change commits there is no turn to route (it is refused, never sent to a process)');
});

test('the wiring: a deleted chat tells the pool whose it was (null when the archive cannot say)', () => {
  const told: (string | null)[] = [];
  const listener = expression<(scope: string, turns: readonly string[]) => void>(callArguments('companion.memory.onTurnsRemoved')[0], {
    claudeChat: { forgetCharacter: (id: string | null) => { told.push(id); } },
    companion: { memory: { characterOfScope: (key: string) => (key === 'k-gene' ? 'gene' : null) } },
  });
  listener('k-gene', ['t1']);
  listener('k-unknown', ['t2']);
  assert.deepEqual(told, ['gene', null]);
});

test('the chat archive tells every listener about removed turns (the beats and the pool both hear it)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-pool-memory-'));
  try {
    const memory = new MemoryStore(root);
    await memory.load();
    const scope = { characterId: 'gene', providerScope: 'p' };
    const handle = await memory.beginTurn(scope, { id: 'turn-1', userText: '你好', at: Date.now(), conversationId: 'c1' });
    await memory.finishTurn(scope, 'turn-1', 'complete', Date.now());
    assert.ok(handle.recordId);
    const heard: string[] = [];
    memory.onTurnsRemoved((key, ids) => { heard.push(`a:${memory.characterOfScope(key)}:${ids.join(',')}`); });
    memory.onTurnsRemoved(() => { throw new Error('a failing listener'); });
    memory.onTurnsRemoved((_key, ids) => { heard.push(`b:${ids.join(',')}`); });
    const listed = memory.list(scope, { limit: 10 });
    for (const record of listed.records) await memory.delete(scope, record.id);
    assert.deepEqual(heard, ['a:gene:turn-1', 'b:turn-1']);
    memory.onTurnsRemoved(null);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});
