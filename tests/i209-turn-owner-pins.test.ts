// I-209 第 2 步之前先钉住（docs/claude/2026-11-24-i209-step2.md）：今天"一个人"时的轮次边界，每一轮改成自己带着"是谁"以后照样成立。
//  - 换人会停掉进行中的那一轮，并封存上一段对话；
//  - 一次回复只归档一次；
//  - 取消、迟到、换了上下文的结果不会回来，也不会盖掉新的状态；
//  - 切换锁一定落定（更多见 tests/switch-lock.test.ts）。
// 退出后等旧进程（tests/quit-wait*.test.ts）、预热（tests/claude-session-pool.test.ts、tests/prewarm-free.test.ts）和启动门
// （tests/claude-launch-up-gate.test.ts、tests/claude-start-gate.test.ts）已经各有钉子，这一步不改它们，照旧要过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService, type CompanionTurn } from '../electron/brain/companion';
import type { ProviderConfig } from '../shared/foundation/settings';

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'https://pins.example/v1', model: 'a' };

async function withService(run: (service: CompanionService) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i209-pins-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', provider, '角色名称：Gene'); await run(service); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
function tail(turn: CompanionTurn, body: string): string {
  const opening = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  assert.ok(opening, 'the protocol marker is in the persona');
  return `${body}\n${opening}${JSON.stringify({ context: 'support', delta: { O: 4 }, confidence: 0.9, reason: '受到关心' })}${opening.replace('<', '</')}`;
}
const assistantOf = (service: CompanionService, turn: CompanionTurn) => service.memory.read(turn.scope, turn.recordId)!.messages.find(m => m.role === 'assistant' && m.turnId === turn.id)!;

test('钉子：换人停掉进行中的那一轮（存成 stopped），封存上一段对话；新角色的心情不被旧回复改动', async () => {
  await withService(async service => {
    const shown: string[] = [];
    const turn = await service.begin('pin-switch', '你好', 'Gene', (type, text) => { if (type === 'delta') shown.push(text); });
    turn.push('delta', '说到一半');
    await service.context('aoi', provider, '角色名称：小葵');
    turn.push('delta', tail(turn, '迟到的后半句'));
    await turn.finish('complete');
    assert.equal(shown.join(''), '说到一半', '换人以后一个字都不再显示');
    const reply = assistantOf(service, turn);
    assert.equal(reply.status, 'stopped');
    assert.equal(reply.content, '说到一半');
    assert.equal(service.memory.read(turn.scope, turn.recordId)!.sealed, true, '上一段对话封存了');
    assert.equal(turn.speechMood(), null, '迟到的结果不给声音和表情');
    assert.equal(service.mood.get().characterId, 'aoi');
    assert.equal(service.mood.get().snapshot.values.O, 50, '新角色的心情没被旧回复的尾巴改动');
  });
});

test('钉子：一次回复只归档一次（finish 重复调用、完成后再推字都不会再写）', async () => {
  await withService(async service => {
    const turn = await service.begin('pin-once', '早', 'Gene', () => {});
    turn.push('delta', tail(turn, '早呀。'));
    const first = turn.finish('complete');
    assert.equal(turn.finish('complete'), first);
    assert.equal(turn.finish('stopped'), first);
    await first;
    turn.push('delta', '迟到');
    await service.flush();
    const record = service.memory.read(turn.scope, turn.recordId)!;
    assert.deepEqual(record.messages.map(m => [m.role, m.content, m.status]), [['user', '早', 'complete'], ['assistant', '早呀。', 'complete']]);
    assert.equal(service.memory.list(turn.scope).total, 1);
  });
});

test('钉子：取消的一轮不会回来；同一个编号不能再开一次', async () => {
  await withService(async service => {
    const turn = await service.begin('pin-cancel', '在吗', 'Gene', () => {});
    turn.push('delta', '在');
    await turn.finish('stopped');
    turn.push('delta', tail(turn, '还在说'));
    await turn.finish('complete');
    assert.equal(assistantOf(service, turn).status, 'stopped');
    assert.equal(turn.speechMood(), null);
    await assert.rejects(service.begin('pin-cancel', '在吗', 'Gene', () => {}), /已经结束|正在进行/);
  });
});

test('钉子：新对话以后，旧一轮迟到的结果不盖掉新对话，也不改心情', async () => {
  await withService(async service => {
    const turn = await service.begin('pin-late', '一', 'Gene', () => {});
    await service.newConversation();
    turn.push('delta', tail(turn, '迟到'));
    await turn.finish('complete');
    assert.equal(assistantOf(service, turn).status, 'stopped');
    assert.equal(service.mood.get().snapshot.values.O, 50);
    const next = await service.begin('pin-late-next', '二', 'Gene', () => {});
    assert.notEqual(next.recordId, turn.recordId);
    next.push('delta', tail(next, '新的。'));
    await next.finish('complete');
    assert.equal(assistantOf(service, next).content, '新的。');
  });
});

test('钉子：切换锁落定——切换中开新一轮被拒，落定后照常', async () => {
  await withService(async service => {
    const switching = service.context('aoi', provider, '角色名称：小葵');
    assert.throws(() => service.currentScope(), /正在切换/);
    await switching;
    const turn = await service.begin('pin-lock', '嗨', '小葵', () => {});
    assert.equal(turn.scope.characterId, 'aoi');
    await turn.finish('stopped');
  });
});
