// C2 预试用问题 2（2026-11-03）：换到一个角色时，聊天窗口显示她最近的那段对话（读现有的聊天记忆，不新建存储）；
// 全新的角色才是空的；每个角色的记忆互不串；你点过"新对话"的，换走再换回来也还是新对话。
// 真实的 CompanionService 和聊天记忆（临时目录）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService, type CompanionTurn } from '../electron/companion';
import type { ProviderConfig } from '../shared/contracts';
import { restoredChatHistory } from '../src/ui/chat-continuity';

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://127.0.0.1:11434/v1', model: '' };
const GENE = '角色名称：Gene', AOI = '角色名称：小葵';

async function withService(run: (service: CompanionService, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-c2-switch-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', provider, GENE); await run(service, directory); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
function tail(turn: CompanionTurn, body: string): string {
  const opening = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  assert.ok(opening);
  return `${body}\n${opening}${JSON.stringify({ context: 'positive', delta: { O: 1 }, confidence: 0.8, reason: '聊天' })}${opening.replace('<', '</')}`;
}
async function say(service: CompanionService, id: string, text: string, reply: string, persona: string): Promise<void> {
  const turn = await service.begin(id, text, persona, () => {});
  turn.push('delta', tail(turn, reply));
  await turn.finish('complete');
}
const window = (service: CompanionService, id: string) => restoredChatHistory(service.recentChat(), id, id).map(m => `${m.role}:${m.content}`);

test('换走再换回来：聊天窗口是她最近的那段对话，接着聊还是同一段', async () => {
  await withService(async (service, directory) => {
    const files = async () => (await readdir(directory)).sort();
    await say(service, 'g1', '这句话是换角色之前说的', '嗯嗯。', GENE);
    const before = await files();

    await service.context('aoi', provider, AOI);
    assert.deepEqual(window(service, 'aoi'), [], '小葵是全新的角色：空的');
    await say(service, 'a1', '小葵你好', '你好呀。', AOI);

    await service.context('gene', provider, GENE);
    assert.deepEqual(window(service, 'gene'), ['user:这句话是换角色之前说的', 'assistant:嗯嗯。'], '换回 Gene：她最近的那段对话');
    await say(service, 'g2', '我回来啦', '欢迎回来。', GENE);
    assert.deepEqual(window(service, 'gene'), ['user:这句话是换角色之前说的', 'assistant:嗯嗯。', 'user:我回来啦', 'assistant:欢迎回来。'],
      '换回来以后接着聊，还是同一段对话');

    await service.context('aoi', provider, AOI);
    assert.deepEqual(window(service, 'aoi'), ['user:小葵你好', 'assistant:你好呀。'], '小葵的只有她自己的');
    assert.deepEqual(await files(), before, '没有新建任何存储文件');
  });
});

test('你点过"新对话"：换走再换回来也还是新对话', async () => {
  await withService(async service => {
    await say(service, 'g1', '旧话题', '好。', GENE);
    await service.newConversation();
    assert.deepEqual(window(service, 'gene'), []);
    await service.context('aoi', provider, AOI);
    await service.context('gene', provider, GENE);
    assert.deepEqual(window(service, 'gene'), [], '用户自己开的新对话不被旧的盖回来');
    await say(service, 'g2', '新话题', '嗯。', GENE);
    await service.context('aoi', provider, AOI);
    await service.context('gene', provider, GENE);
    assert.deepEqual(window(service, 'gene'), ['user:新话题', 'assistant:嗯。'], '换回来是新对话里的话');
  });
});

test('换连接（聊天模型）不算换角色：照旧是新对话', async () => {
  await withService(async service => {
    await say(service, 'g1', '用旧连接说的', '好。', GENE);
    await service.context('gene', { ...provider, model: 'sonnet' }, GENE);
    assert.deepEqual(window(service, 'gene'), []);
  });
});

test('出错和还没说完的回复不进聊天窗口；主动观察不算这段对话', async () => {
  await withService(async service => {
    await say(service, 'g1', '第一句', '第一句的回复。', GENE);
    const failed = await service.begin('g2', '这一轮出错了', GENE, () => {});
    await failed.finish('error');
    const stopped = await service.begin('g3', '被打断的一轮', GENE, () => {});
    stopped.push('delta', '说到一半');
    await stopped.finish('stopped');
    const at = Date.now() + 1;
    await service.memory.appendInitiative(service.currentScope(), { id: 'host-cue-1', text: '屏幕上的观察', at,
      origin: { kind: 'proactive', id: 'host-cue-1', at, sources: ['screen'], labels: ['已开启的屏幕共享'] } });
    await service.context('aoi', provider, AOI);
    await service.context('gene', provider, GENE);
    assert.deepEqual(window(service, 'gene'), ['user:第一句', 'assistant:第一句的回复。', 'user:被打断的一轮', 'assistant:说到一半']);
  });
});
