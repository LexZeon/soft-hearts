// The user's words (userWords) on the internal channel, at their edges (docs/claude/2026-11-17-app-tools-split.md, mutation list
// scripts/dev/mutations/safety.json S25-S29). The golden (tests/app-tools-golden.test.ts) drives every tool with one ordinary
// sentence; these are the words the app must refuse: none, only spaces, not text, longer than the channel takes, and longer than the
// dialog can show in full. Real tool definitions on the golden's fake app; nothing may happen and no dialog may open when refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_DIALOG_WORDS_LIMIT, AGENT_USER_WORDS_LIMIT, AgentToolRegistry } from '../electron/safety/agent-channel/registry';
import { createAppTools } from '../electron/safety/agent-channel/app-tools';
import { A, B, makeWorld } from './helpers/app-tools-world';

function channel(interconnect = true) {
  const world = makeWorld();
  world.state.interconnect = interconnect;
  const dialogs: string[] = [];
  const registry = new AgentToolRegistry(createAppTools(world.bridge, world.options), {
    enabled: () => true, interconnect: () => interconnect, confirm: async request => { dialogs.push(request.detail); return true; },
  });
  return { world, registry, dialogs };
}

// bind_current_model_to_character: needs the words, no dialog (ordinary); delete_memories: needs the words and the dialog (sensitive).
const DIRECT = { name: 'bind_current_model_to_character', args: { id: B } };
const SENSITIVE = { name: 'delete_memories', args: { id: A, parts: ['chat'] } };

for (const item of [DIRECT, SENSITIVE]) {
  for (const [label, words] of [['missing', undefined], ['empty', ''], ['only spaces', '   \n\t '], ['only invisible characters', '​​']] as const) {
    test(`${item.name}: words ${label} → needs_user_words, nothing happens, no dialog`, async () => {
      const f = channel();
      const result = await f.registry.call(item.name, words === undefined ? item.args : { ...item.args, userWords: words });
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.error.code, 'needs_user_words');
      assert.deepEqual(f.world.ops, []);
      assert.deepEqual(f.dialogs, []);
    });
  }

  test(`${item.name}: words that are not text, or longer than ${AGENT_USER_WORDS_LIMIT} characters, are refused before anything`, async () => {
    for (const words of [42, null, ['好'], { text: '好' }, '好'.repeat(AGENT_USER_WORDS_LIMIT + 1)]) {
      const f = channel();
      const result = await f.registry.call(item.name, { ...item.args, userWords: words });
      assert.equal(!result.ok && result.error.code, 'invalid_input', JSON.stringify(words).slice(0, 40));
      assert.deepEqual(f.world.ops, []);
      assert.deepEqual(f.dialogs, []);
    }
  });
}

test(`ordinary consent: words of exactly ${AGENT_USER_WORDS_LIMIT} characters are taken`, async () => {
  const f = channel();
  const result = await f.registry.call(DIRECT.name, { ...DIRECT.args, userWords: '好'.repeat(AGENT_USER_WORDS_LIMIT) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(f.world.ops.some(op => (op as { op: string }).op === 'bindCurrentModel'));
});

test(`sensitive: words longer than the dialog shows (${AGENT_DIALOG_WORDS_LIMIT}) are refused without a dialog; exactly that many are shown in full`, async () => {
  const long = channel();
  const refused = await long.registry.call(SENSITIVE.name, { ...SENSITIVE.args, userWords: '好'.repeat(AGENT_DIALOG_WORDS_LIMIT + 1) });
  assert.equal(!refused.ok && refused.error.code, 'invalid_input');
  assert.deepEqual(long.dialogs, []);
  assert.deepEqual(long.world.ops, []);
  const fits = channel();
  const words = '好'.repeat(AGENT_DIALOG_WORDS_LIMIT);
  const allowed = await fits.registry.call(SENSITIVE.name, { ...SENSITIVE.args, userWords: words });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(fits.dialogs.length, 1);
  assert.ok(fits.dialogs[0].includes(`「${words}」`), 'the whole sentence is in the dialog');
});

test('words around spaces are trimmed; the length counted is the trimmed sentence', async () => {
  const f = channel();
  const result = await f.registry.call(DIRECT.name, { ...DIRECT.args, userWords: '  好的  ' });
  assert.equal(result.ok, true);
});
