// C3 预试用问题 1（2026-11-03）：原地更新角色卡（同一个角色编号、人设变了）不能结束当前这段对话。
// 用真实的 CompanionService 和聊天记忆（临时目录）：更新前说的话，更新后这段对话里还在，下一轮起用新人设；
// 换成另一个角色才照旧分开。聊天窗口用主进程给的"她现在这段对话"重新填上（src/ui/chat-continuity.ts）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService, type CompanionTurn } from '../electron/companion';
import type { ProviderConfig } from '../shared/contracts';
import { restoredChatHistory } from '../src/ui/chat-continuity';
import { outgoingChatMessages } from '../src/ui/reply-history';

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://127.0.0.1:11434/v1', model: '' };

async function withService(run: (service: CompanionService) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-c3-keep-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', provider, '角色名称：Gene\n\n性格：\n温和'); await run(service); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
function tail(turn: CompanionTurn, body: string): string {
  const opening = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  assert.ok(opening);
  return `${body}\n${opening}${JSON.stringify({ context: 'positive', delta: { O: 1 }, confidence: 0.8, reason: '聊天' })}${opening.replace('<', '</')}`;
}
async function say(service: CompanionService, id: string, text: string, reply: string, persona: string): Promise<CompanionTurn> {
  const turn = await service.begin(id, text, persona, () => {});
  turn.push('delta', tail(turn, reply));
  await turn.finish('complete');
  return turn;
}

test('原地更新角色卡（同一个编号）：当前这段对话不结束，上一句还在，下一轮用新人设', async () => {
  await withService(async service => {
    const first = await say(service, 't1', '我最喜欢下雨天，记住哦', '记住啦。', '角色名称：Gene');
    const before = service.memory.read(first.scope, first.recordId)!;
    assert.equal(before.sealed, false);

    await service.context('gene', provider, '角色名称：Gene\n\n性格：\n温柔、有点黏人（新版）');
    // The record the conversation was in is still open: the update did not seal it.
    assert.equal(service.memory.read(first.scope, first.recordId)!.sealed, false, '原地更新不应该封存当前对话');
    const recent = service.recentChat();
    assert.equal(recent.characterId, 'gene');
    assert.deepEqual(recent.messages.map(m => [m.role, m.content]), [['user', '我最喜欢下雨天，记住哦'], ['assistant', '记住啦。']]);

    const persona = '角色名称：Gene\n\n性格：\n温柔、有点黏人（新版）';
    const second = await service.begin('t2', '还记得我喜欢什么吗', persona, () => {});
    assert.equal(second.recordId, first.recordId, '更新后的下一轮接在同一段对话里');
    assert.ok(second.persona.startsWith(persona), '下一轮起用新人设');
    second.push('delta', tail(second, '下雨天呀。'));
    await second.finish('complete');

    // What the chat window is refilled with, and what the next message carries to Claude.
    const window = restoredChatHistory(service.recentChat(), 'gene', 'gene');
    const sent = outgoingChatMessages(window, { role: 'user', content: '对吧' });
    assert.ok(sent.some(m => m.role === 'user' && m.content === '我最喜欢下雨天，记住哦'), '下一条消息带着更新前的那句话');
    assert.equal(sent.at(-1)!.content, '对吧');
  });
});

test('换成另一个角色：照旧分开（另一个角色看不到这段对话）', async () => {
  await withService(async service => {
    await say(service, 't1', '这句话只属于 Gene', '嗯。', '角色名称：Gene');
    await service.context('aoi', provider, '角色名称：小葵');
    const recent = service.recentChat();
    assert.equal(recent.characterId, 'aoi');
    assert.deepEqual(recent.messages, [], '小葵这边是空的');
    const turn = await service.begin('t2', '你好', '角色名称：小葵', () => {});
    assert.ok(!service.memory.read(turn.scope, turn.recordId)!.messages.some(m => m.content.includes('只属于 Gene')));
    await turn.finish('stopped');
  });
});

test('换角色的结果只用于当时那个角色（结果晚到、角色已变时不填）', () => {
  const recent = { characterId: 'gene', messages: [{ role: 'user' as const, content: 'a' }, { role: 'assistant' as const, content: 'b' }] };
  assert.deepEqual(restoredChatHistory(recent, 'gene', 'gene').map(m => m.content), ['a', 'b']);
  assert.deepEqual(restoredChatHistory(recent, 'gene', 'aoi'), [], '请求时是 Gene、现在是小葵：不填');
  assert.deepEqual(restoredChatHistory({ ...recent, characterId: 'aoi' }, 'gene', 'gene'), [], '主进程回的是别的角色：不填');
  // The chat window's own bound (24, starting at a user message once something was cut).
  const many = { characterId: 'gene', messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: String(i) })) };
  const kept = restoredChatHistory(many, 'gene', 'gene');
  assert.equal(kept.length, 24);
  assert.equal(kept[0].role, 'user');
  assert.equal(kept.at(-1)!.content, '39');
});
