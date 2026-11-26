// 切换锁（docs/claude/2026-11-23-switch-lock.md）。 （开发版）：同一时刻 activate_character（新 Gene）、
// use_bundled_model、bind_current_model_to_character 三个调用之后，角色页再也换不了角色：
// "Error invoking remote method 'desk:switchCharacter': Error: 角色或对话正在切换，请稍后再试。"
// 这里用真的 CompanionService（临时目录）把这些调用在对话这一层做出来：每次切换开始就让旧的作废（世代号 +1），
// 不管切换做完、出错还是提前返回，都要落定；落定前来的旧回复照样进不来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/brain/companion';
import { ContextLock } from '../electron/brain/context-lock';
import { activateCardCommitted } from '../electron/cards/character-switch';
import { CharacterCardStore } from '../electron/cards/character-cards';
import { CharacterResponseService, CharacterResponseStore } from '../electron/cards/character-response';
import { settledScope } from '../electron/foundation/settled-scope';
import type { ProviderConfig } from '../shared/foundation/settings';
import { defaultCharacterMoodTemplate } from '../shared/cards/character-cards';

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://127.0.0.1:11434/v1', model: '' };
const SWITCHING = /角色或对话正在切换/;

interface Rig { service: CompanionService; failSeals(count: number): void; readScopeOnPublish(on: boolean): void; publishes: () => number }
async function withService(run: (rig: Rig) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-switch-lock-'));
  let readScope = false, publishes = 0, sealFailures = 0;
  // Like the app's mood publish (ambient comments, the cue chain): a listener that reads her scope on every new view.
  const service: CompanionService = new CompanionService(directory, () => { if (readScope) { service.currentScope(); publishes++; } });
  const seal = service.memory.seal.bind(service.memory);
  service.memory.seal = scope => sealFailures-- > 0 ? Promise.reject(new Error('封存聊天失败（测试）')) : seal(scope);
  try {
    await service.load();
    await service.context('gene', provider, '角色名称：Gene');
    await run({ service, failSeals: count => { sealFailures = count; }, readScopeOnPublish: on => { readScope = on; }, publishes: () => publishes });
  } finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
const characterNow = (service: CompanionService) => service.currentScope().characterId;
/** After anything: the lock is free and an ordinary switch (the 角色页's 换成她) goes through. */
async function normalSwitchWorks(service: CompanionService, to = 'normal-after'): Promise<void> {
  assert.doesNotThrow(() => service.currentScope(), '锁已经放开');
  await service.context(to, provider, `角色名称：${to}`);
  assert.equal(characterNow(service), to);
  assert.doesNotThrow(() => service.recentChat());
}

test('切换中途出错（封存失败）：锁照样落定，停在原来的角色上；再换一次能换过去', async () => {
  await withService(async ({ service, failSeals }) => {
    failSeals(1);
    await assert.rejects(service.context('aoi', provider, '角色名称：小葵'), /封存聊天失败/);
    assert.equal(characterNow(service), 'gene', '没换成：还在 Gene，不是"正在切换"');
    await service.context('aoi', provider, '角色名称：小葵');
    assert.equal(characterNow(service), 'aoi', '同一个请求再来一次会重新做，不当成已经做完');
    await normalSwitchWorks(service);
  });
});

test('三个调用同时到（新 Gene、换回预装模型、关联模型）：全部结束后锁放开，之后正常换角色', async () => {
  for (const firstSealFails of [false, true]) {
    await withService(async ({ service, failSeals, readScopeOnPublish }) => {
      if (firstSealFails) failSeals(1);
      readScopeOnPublish(true); // the app's mood publish reads the scope while it switches
      const NEW_GENE = '角色名称：Gene（新）', GENE = '角色名称：Gene';
      const mood = defaultCharacterMoodTemplate().parameters;
      const calls = [
        service.context('gene-new', provider, NEW_GENE, mood), // activate_character(new Gene): syncCharacter → context
        service.context('gene', provider, GENE),                 // use_bundled_model: the bundled model picks the preset Gene card
        service.context('gene', provider, GENE, mood),           // bind_current_model_to_character: the same context again
        service.newConversation(),                               // a window's 新对话 / a deleted record in between
      ];
      const settled = await Promise.allSettled(calls);
      assert.ok(settled.slice(1).every(result => result.status === 'fulfilled'), settled.map(r => r.status === 'rejected' ? String(r.reason) : r.status).join(' | '));
      assert.equal(settled[0].status, firstSealFails ? 'rejected' : 'fulfilled');
      assert.equal(characterNow(service), 'gene', '最后请求的那个');
      await normalSwitchWorks(service);
    });
  }
});

test('同样三个调用按主进程的顺序一个个来（mutate 排队）：每一步之后都不卡', async () => {
  await withService(async ({ service, readScopeOnPublish }) => {
    readScopeOnPublish(true);
    await service.context('gene-new', provider, '角色名称：Gene（新）');
    assert.equal(characterNow(service), 'gene-new');
    await service.context('gene', provider, '角色名称：Gene');
    await service.context('gene', provider, '角色名称：Gene');
    assert.equal(characterNow(service), 'gene');
    await normalSwitchWorks(service);
  });
});

test('心情发布里有人在切换中读角色（一起听、主动开口那一串）：切换照样完成，落定后窗口拿到新的心情', async () => {
  await withService(async ({ service, readScopeOnPublish, publishes }) => {
    readScopeOnPublish(true);
    const before = publishes();
    await service.context('aoi', provider, '角色名称：小葵');
    assert.equal(characterNow(service), 'aoi', '没被卡在"正在切换"');
    assert.ok(publishes() > before, '落定以后至少发布一次，读得到新角色');
    await normalSwitchWorks(service);
  });
});

test('切换失败后排在后面的"新对话"：不会因为角色对不上就永远不落定', async () => {
  await withService(async ({ service, failSeals }) => {
    failSeals(1);
    const failed = service.context('aoi', provider, '角色名称：小葵');
    const fresh = service.newConversation(); // captured the requested scope (aoi), which never became current
    await assert.rejects(failed, /封存聊天失败/);
    await fresh;
    assert.equal(characterNow(service), 'gene');
    await normalSwitchWorks(service);
  });
});

test('连续快速切换（夹着失败和新对话）：最后锁放开，之后正常换', async () => {
  await withService(async ({ service, failSeals, readScopeOnPublish }) => {
    readScopeOnPublish(true);
    const ids = ['gene', 'aoi', 'gene-new'];
    const calls: Promise<unknown>[] = [];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let index = 0; index < 30; index++) {
      if (index % 7 === 3) failSeals(1);
      const roll = next();
      if (roll < 0.2) calls.push(service.newConversation());
      else { const id = ids[Math.floor(next() * ids.length)]; calls.push(service.context(id, provider, `角色名称：${id}${roll < 0.5 ? '' : '·新'}`)); }
    }
    await Promise.allSettled(calls);
    await normalSwitchWorks(service);
    await normalSwitchWorks(service, 'aoi');
  });
});

test('等着同一个请求的调用：那个请求失败时它也失败，不当成换好了；之后再请求能换', async () => {
  await withService(async ({ service, failSeals }) => {
    failSeals(1);
    const first = service.context('aoi', provider, '角色名称：小葵');
    const same = service.context('aoi', provider, '角色名称：小葵'); // queued while the first is pending: waits for it
    await assert.rejects(first, /封存聊天失败/);
    await assert.rejects(same, /切换没有完成/);
    await service.context('aoi', provider, '角色名称：小葵');
    assert.equal(characterNow(service), 'aoi');
  });
});

test('安全底线不变：切换失败时，旧角色那轮回复晚到也进不来', async () => {
  await withService(async ({ service, failSeals }) => {
    const turn = await service.begin('g-late', '你好', '角色名称：Gene', () => {});
    failSeals(1);
    const switching = service.context('aoi', provider, '角色名称：小葵');
    assert.throws(() => service.currentScope(), SWITCHING, '切换开始的那一刻就作废');
    await assert.rejects(switching, /封存聊天失败/);
    turn.push('delta', '迟到的旧回复');
    await turn.finish('complete');
    assert.equal(turn.speechMood(), null, '迟到的一轮不算数');
    const shown = service.recentChat().messages.map(message => message.content).join('\n');
    assert.ok(!shown.includes('迟到的旧回复'), shown);
  });
});

test('ContextLock：出错、提前返回、被后来的超过，都落定；只有最新的一步结束才放开', async () => {
  const lock = new ContextLock();
  const one = lock.bump();
  await assert.rejects(lock.settle(one, async () => { throw new Error('x'); }));
  assert.equal(lock.switching, false);
  const two = lock.bump(), three = lock.bump();
  assert.equal(lock.current(two), false, '被超过的那一代立刻作废');
  await lock.settle(two, async () => 'early');
  assert.equal(lock.switching, true, '更新的那次还没结束');
  await lock.settle(three, async () => undefined);
  assert.equal(lock.switching, false);
  assert.equal(lock.current(three), true);
});

test('角色页的"正在陪着你"只在对话真的换过去以后：换不过去时角色卡回到对话所在的角色', async () => {
  const log: string[] = [];
  let active = 'gene', conversation: string | null = 'gene';
  const ports = (catchUp: () => Promise<string>) => ({
    activate: async (id: string) => { active = id; log.push(`activate:${id}`); },
    catchUp, conversationCharacter: () => conversation,
    restore: async (id: string) => { active = id; log.push(`restore:${id}`); },
  });
  await assert.rejects(activateCardCommitted('gene', 'aoi', ports(async () => { throw new Error('角色或对话正在切换，请稍后再试。'); })), SWITCHING);
  assert.equal(active, 'gene', '卡回到 Gene，和对话一致');
  conversation = null; active = 'gene';
  await assert.rejects(activateCardCommitted('gene', 'aoi', ports(async () => { throw new Error('x'); })));
  assert.equal(active, 'gene', '对话还没就绪时回到原来那张');
  conversation = 'aoi'; active = 'gene'; log.length = 0;
  await assert.rejects(activateCardCommitted('gene', 'aoi', ports(async () => { throw new Error('后面的步骤出错'); })));
  assert.equal(active, 'aoi', '对话已经换过去：卡也留在她那里');
  assert.deepEqual(log, ['activate:aoi']);
  assert.equal(await activateCardCommitted('gene', 'aoi', ports(async () => 'ok')), 'ok');
});

test('收拾用的读角色（停掉电脑声音、一起听的会话）：切换中得到 null，不抛错', () => {
  assert.equal(settledScope({ currentScope: () => { throw new Error('角色或对话正在切换，请稍后再试。'); } }), null);
  assert.equal(settledScope(null), null);
  assert.deepEqual(settledScope({ currentScope: () => ({ characterId: 'gene' }) }), { characterId: 'gene' });
});

test('导入角色卡不会换角色：导入后正在陪着你的还是原来那位', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-switch-lock-import-'));
  try {
    await mkdir(directory, { recursive: true });
    const cards = new CharacterCardStore(directory, '原来的人设');
    await cards.load();
    const responses = new CharacterResponseStore(directory, () => cards.publicState().cards.map(card => card.id));
    await responses.load();
    const before = cards.publicState().activeId;
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'gene乐天', description: '导入的', personality: '', scenario: '', first_mes: '', mes_example: '' } };
    const result = await new CharacterResponseService(cards, responses).import(JSON.stringify(card));
    assert.notEqual(result.characterId, before);
    assert.equal(cards.publicState().activeId, before, '导入只加一张卡');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
