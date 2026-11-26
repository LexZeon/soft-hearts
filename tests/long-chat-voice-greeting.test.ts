// I-134 new chat: a voice utterance starts from her archive's window (not the renderer's 24, not cut by the request bound), and
// her greeting, once shown, is archived once as one of her own lines (never a user turn) and only while new chat is on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService, memoryProviderScope } from '../electron/brain/companion';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { encodeWav } from '../src/senses/MediaInput';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { VoiceConversationEvent } from '../shared/voice/voice-conversation';
import type { ChatMessage } from '../shared/foundation/chat';
import type { CompanionClaudeTask } from '../electron/brain/claude-session';
import { GreetingArchive } from '../electron/brain/long-chat/greeting';
import { MemoryStore } from '../electron/memory/memory';

async function voiceTurn(longChatHistory: ((groupId: string) => ChatMessage[] | null) | undefined) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-long-chat-voice-'));
  const companion = new CompanionService(path.join(directory, 'companion'), () => {}); await companion.load();
  const settings = structuredClone(DEFAULT_SETTINGS); settings.persona = '角色名称：Gene'; settings.provider.model = 'synthetic';
  await companion.context('gene', settings.provider, settings.persona);
  const events: VoiceConversationEvent[] = [];
  const tasks: CompanionClaudeTask[] = [];
  const groups: string[] = [];
  const voice = new VoiceChatHost({ broadcast: event => events.push(event), memoryChanged() {}, windowVisible: () => true,
    media: () => ({ voiceInput: true, voiceOwner: 'controls' }), turnOffVoiceInput() {}, speechScope: () => 'voice-scope', settings: () => settings, companion: () => companion, ambient: () => null,
    reserveChat: () => true, releaseChat() {}, userTurn() {}, activityChanged() {}, cancelProactive() {},
    ...(longChatHistory ? { longChatHistory: (groupId: string) => { groups.push(groupId); return longChatHistory(groupId); } } : {}),
    claude: { stream: async (task, _signal, emit) => { tasks.push(task); emit('delta', '嗯嗯'); return { superseded: false, output: '嗯嗯' }; } },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => '刚才说到哪了', stopReading() {}, prepareSpeech() {} });
  // The last ordinary chat window, as electron/main.ts leaves it after a text turn.
  voice.history = { scope: 'voice-scope', providerScope: memoryProviderScope(settings.provider), messages: [{ role: 'user', content: '界面里的上一句' }, { role: 'assistant', content: '界面里的回答' }] };
  const binding = voice.open(5, 'controls');
  voice.pipeline.submit(5, { captureSessionId: binding.captureSessionId, captureSeq: 1, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
  const deadline = Date.now() + 3000;
  while (!events.some(event => event.type === 'terminal') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  voice.dispose(); await voice.drain(); await companion.flush();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return { tasks, groups };
}

test('voice: with new chat on, an utterance starts from her archive window, not cut to 24 messages; the utterance itself is added once', async () => {
  const window: ChatMessage[] = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `存档第${index}条` }));
  const { tasks, groups } = await voiceTurn(() => window);
  assert.equal(tasks.length, 1);
  assert.equal(groups.length, 1, 'asked once, for the new utterance');
  const messages = tasks[0].session!.messages;
  assert.deepEqual(messages.slice(0, -1), window, 'all 40 archive messages, no renderer history');
  assert.deepEqual(messages.at(-1), { role: 'user', content: '刚才说到哪了' });
  assert.ok(tasks[0].prompt.includes('存档第0条'));
});

test('voice: with new chat off (no window), the last ordinary chat window is used exactly as before', async () => {
  for (const longChatHistory of [undefined, () => null]) {
    const { tasks } = await voiceTurn(longChatHistory);
    assert.deepEqual(tasks[0].session!.messages, [{ role: 'user', content: '界面里的上一句' }, { role: 'assistant', content: '界面里的回答' }, { role: 'user', content: '刚才说到哪了' }]);
  }
});

test('greeting: archived once as her own line while it is her newest line, again after other chat, never while new chat is off', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-long-chat-greeting-'));
  const memory = new MemoryStore(directory);
  try {
    await memory.load();
    const scope = { characterId: 'gene', providerScope: 'claude:fixture' };
    let ids = 0, greeting = '你来啦～', identity = 'a';
    const archive = (enabled: boolean) => new GreetingArchive({ enabled, memory: () => memory, scope: () => scope, greeting: () => greeting, identity: () => identity, id: () => `greeting-${++ids}` });
    assert.equal(await archive(false).remember(), false);
    assert.equal(memory.list(scope, { limit: 10 }).total, 0);
    const on = archive(true);
    // Both windows show it at once: one record.
    assert.deepEqual(await Promise.all([on.remember(), on.remember()]), [true, false]);
    assert.equal(await on.remember(), false, '"new conversation" again with nothing said in between');
    await memory.beginTurn(scope, { id: 't1', userText: '嗨', at: Date.now() + 10, conversationId: 'c1' });
    await memory.appendAssistant(scope, 't1', '嗨嗨', Date.now() + 11);
    await memory.finishTurn(scope, 't1', 'complete', Date.now() + 12);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await on.remember(), true, 'after chat, a new greeting is a new line');
    const source = memory.chatWindowSource(scope);
    assert.deepEqual(source.map(message => [message.role, message.content, message.origin?.sources[0] ?? null]),
      [['assistant', '你来啦～', 'greeting'], ['user', '嗨', null], ['assistant', '嗨嗨', null], ['assistant', '你来啦～', 'greeting']]);
    // Never a user turn or a relationship round.
    assert.equal(memory.chatActivity(scope, () => 'day').rounds.get('day'), 1);
    assert.deepEqual(memory.recentConversation(scope, 'c1').map(message => message.content), ['嗨', '嗨嗨']);
    // No greeting on the card: nothing; a context change while writing: refused by the archive, nothing kept.
    greeting = '  ';
    assert.equal(await on.remember(), false);
    greeting = '换了角色';
    const racing = new GreetingArchive({ enabled: true, memory: () => memory, scope: () => scope, greeting: () => greeting, identity: () => { identity += 'x'; return identity; }, id: () => `greeting-${++ids}` });
    assert.equal(await racing.remember(), false);
    assert.equal(memory.chatWindowSource(scope).length, 4);
  } finally { await memory.flush().catch(() => {}); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
