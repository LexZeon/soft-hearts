// I-209 第 2 步：每一轮自己带着
// "是谁"，从开始一直带到归档。一个人时一切照旧（tests/i209-turn-owner-pins.test.ts 和原有测试照过）；这里测台上不止一位时：
//  - B 的一轮只进 B 的记忆、B 的心情、B 的记录，A 一点不动；
//  - 换桌面陪伴（控制窗口换角色卡）不会打断台上 B 正在说的话；
//  - 两位的轮次同时在跑，各自只归档一次、进各自的记忆；
//  - B 下台：她的一轮停下、对话封存；B 被换成桌面陪伴：她正在说的那一轮接着说完。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService, memoryProviderScope, type CompanionTurn } from '../electron/brain/companion';
import { TurnOwners, companionChangeStops, ownerSpeechScope, switchStops } from '../electron/brain/turn-owner';
import { StageMoods } from '../electron/mood/stage-moods';
import { WatchFactsTurn } from '../electron/senses/watch-continuity/facts-turn';
import { SpeechBeatsHost } from '../electron/brain/speech-beats/host';
import { SpeechBeatArchive } from '../electron/brain/speech-beats/archive';
import { CloseCutNotice } from '../electron/unbound/close-cut';
import type { ProviderConfig } from '../shared/foundation/settings';
import type { JournalSink } from '../electron/memory';

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'https://owner.example/v1', model: 'a' };
const other: ProviderConfig = { kind: 'claude', baseUrl: 'https://owner-other.example/v1', model: 'b' };

type Rig = { service: CompanionService; journal: { characterId?: unknown; type: string }[] };
async function withService(run: (rig: Rig) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i209-owner-'));
  const journal: Rig['journal'] = [];
  const sink = { record: (input: { type: string }) => { journal.push(structuredClone(input) as Rig['journal'][number]); } } as unknown as JournalSink;
  const service = new CompanionService(directory, () => {}, { journal: sink });
  try { await service.load(); await service.context('gene', provider, '角色名称：Gene'); await run({ service, journal }); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
function tail(turn: CompanionTurn, body: string, delta: Record<string, number> = { O: 6 }): string {
  const opening = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  assert.ok(opening, 'the protocol marker is in the persona');
  return `${body}\n${opening}${JSON.stringify({ context: 'support', delta, confidence: 0.9, reason: '受到关心' })}${opening.replace('<', '</')}`;
}
const reply = (service: CompanionService, turn: CompanionTurn) => service.memory.read(turn.scope, turn.recordId)!.messages.find(m => m.role === 'assistant' && m.turnId === turn.id)!;
const O = (service: CompanionService, id: string) => service.mood.liveOf(id)!.snapshot.values.O;

test('TurnOwners：只动该动的人；进出台、换成桌面陪伴时座位交接', () => {
  const owners = new TurnOwners();
  const a = owners.generation('a'), b = owners.generation('b');
  owners.bump(['a']);
  assert.equal(owners.current('a', a), false);
  assert.equal(owners.current('b', b), true, '别人的一轮不受影响');
  owners.bump('all');
  assert.equal(owners.current('b', b), false, '换了连接：每个人的都停');
  let n = 0;
  const first = owners.present(['b', 'c', 'a'], 'a', 'p1', () => `conv-${++n}`);
  assert.deepEqual(first.joined, ['b', 'c']);
  assert.deepEqual(owners.ids(), ['b', 'c'], '桌面陪伴自己不占座位');
  const bGen = owners.generation('b');
  const second = owners.present(['b'], 'a', 'p1', () => 'never');
  assert.deepEqual(second.left.map(seat => seat.characterId), ['c']);
  assert.equal(owners.current('b', bGen), true, 'B 还在台上，她的一轮照旧');
  // a switch committing: the new companion keeps her seat until take()
  owners.present([], 'b', 'p1', () => 'never');
  assert.equal(owners.seat('b')?.conversationId, 'conv-1', '正在变成桌面陪伴的那位，座位留着等交接');
  assert.equal(owners.take('b')?.conversationId, 'conv-1');
  assert.equal(owners.current('b', bGen), true, '交接不算她的上下文变了');
  // another connection: every seat is new
  owners.present(['c'], 'a', 'p1', () => 'c-1');
  const moved = owners.present(['c'], 'a', 'p2', () => 'c-2');
  assert.deepEqual([moved.left.length, moved.joined], [1, ['c']]);
  assert.equal(owners.seat('c')?.conversationId, 'c-2');
  assert.deepEqual(switchStops(null, { characterId: 'a', providerScope: 'p' }), 'all');
  assert.deepEqual(switchStops({ characterId: 'a', providerScope: 'p' }, { characterId: 'c', providerScope: 'p' }), ['a']);
  assert.deepEqual(switchStops({ characterId: 'a', providerScope: 'p' }, { characterId: 'a', providerScope: 'p' }), ['a']);
  assert.deepEqual(switchStops({ characterId: 'a', providerScope: 'p' }, { characterId: 'c', providerScope: 'q' }), 'all');
  assert.equal(companionChangeStops(undefined, 'a'), true, '没有归属的旧任务照旧停');
  assert.equal(companionChangeStops('a', 'a'), true);
  assert.equal(companionChangeStops('b', 'a'), false, '台上另一位的一轮不停');
});

test('B 的一轮只进 B：记忆、心情、记录、熟悉度都是 B 的，A 一点不动', async () => {
  await withService(async ({ service, journal }) => {
    service.stage(['bea']);
    assert.deepEqual(service.onStage(), ['bea']);
    const aBefore = O(service, 'gene'), bBefore = O(service, 'bea');
    const events: string[] = [];
    const original = service.mood.event.bind(service.mood);
    service.mood.event = (event, character, options) => { events.push(`${character}:${event.type}`); original(event, character, options); };
    const shown: string[] = [], familiar: string[] = [];
    for (const key of ['noteQuality', 'noteRound'] as const) { const was = service.relationship[key].bind(service.relationship); service.relationship[key] = (id: string, ...rest: never[]) => { familiar.push(`${key}:${id}`); return was(id, ...rest); }; }
    journal.length = 0;
    const turn = await service.begin('b-1', '你好呀', '角色名称：Bea', (type, text) => { if (type === 'delta') shown.push(text); }, { characterId: 'bea' });
    assert.deepEqual(turn.scope, { characterId: 'bea', providerScope: memoryProviderScope(provider) });
    turn.push('delta', tail(turn, 'Bea 在这儿。'));
    await turn.finish('complete');
    assert.equal(shown.join(''), 'Bea 在这儿。');
    assert.equal(reply(service, turn).content, 'Bea 在这儿。');
    assert.equal(service.memory.list(service.currentScope()).total, 0, 'A（桌面陪伴）的记忆里没有这一轮');
    assert.equal(service.memory.list(turn.scope).total, 1);
    assert.deepEqual(events, ['bea:chat', 'bea:appraisal'], '心情事件只给 B');
    assert.ok(O(service, 'bea') > bBefore, 'B 的心情动了');
    assert.equal(O(service, 'gene'), aBefore, 'A 的心情没动');
    assert.equal(service.mood.get().characterId, 'gene', '桌面陪伴还是 A');
    const owned = journal.filter(row => typeof row.characterId === 'string');
    assert.ok(owned.length > 0, '这一轮写了记录');
    assert.ok(owned.every(row => row.characterId === 'bea'), `记录全是 B 的：${JSON.stringify(owned.map(row => [row.type, row.characterId]))}`);
    assert.ok(turn.speechMood(), 'B 的这一轮算完成');
    assert.deepEqual(familiar.sort(), ['noteQuality:bea', 'noteRound:bea'], '熟悉度只记给 B');
  });
});

test('不在台上的人不能开一轮', async () => {
  await withService(async ({ service }) => {
    assert.throws(() => service.begin('nobody', '你好', 'X', () => {}, { characterId: 'nobody' }), /不在台上/);
  });
});

test('控制窗口换角色卡（换桌面陪伴）时，台上 B 正在说的话不被打断；A 的照旧停', async () => {
  await withService(async ({ service }) => {
    service.stage(['bea']);
    const a = await service.begin('a-1', 'A 你好', 'Gene', () => {});
    const shownB: string[] = [];
    const b = await service.begin('b-1', 'B 你好', 'Bea', (type, text) => { if (type === 'delta') shownB.push(text); }, { characterId: 'bea' });
    a.push('delta', 'A 说到一半');
    b.push('delta', 'B 说到一半，');
    await service.context('cora', provider, '角色名称：Cora');
    service.stage(['bea', 'gene']); // step 1's swap: the one you talked with stays on stage
    b.push('delta', tail(b, '接着说完。'));
    await b.finish('complete');
    await a.finish('complete');
    assert.equal(reply(service, a).status, 'stopped', 'A（换走的那位）停下，和以前一样');
    assert.equal(reply(service, b).status, 'complete', 'B 没被打断');
    assert.equal(shownB.join(''), 'B 说到一半，接着说完。');
    assert.equal(reply(service, b).content, 'B 说到一半，接着说完。');
    assert.ok(b.speechMood());
  });
});

test('两位的轮次同时在跑：各自只归档一次，进各自的记忆', async () => {
  await withService(async ({ service }) => {
    service.stage(['bea']);
    const [a, b] = await Promise.all([
      service.begin('both-a', '两个人一起', 'Gene', () => {}),
      service.begin('both-b', '两个人一起', 'Bea', () => {}, { characterId: 'bea' }),
    ]);
    a.push('delta', tail(a, 'A 的话。'));
    b.push('delta', tail(b, 'B 的话。'));
    await Promise.all([b.finish('complete'), a.finish('complete'), a.finish('complete'), b.finish('stopped')]);
    a.push('delta', '迟到'); b.push('delta', '迟到');
    await service.flush();
    const aRecord = service.memory.read(a.scope, a.recordId)!, bRecord = service.memory.read(b.scope, b.recordId)!;
    assert.deepEqual(aRecord.messages.map(m => [m.role, m.content, m.status]), [['user', '两个人一起', 'complete'], ['assistant', 'A 的话。', 'complete']]);
    assert.deepEqual(bRecord.messages.map(m => [m.role, m.content, m.status]), [['user', '两个人一起', 'complete'], ['assistant', 'B 的话。', 'complete']]);
    assert.equal(service.memory.list(a.scope).total, 1);
    assert.equal(service.memory.list(b.scope).total, 1);
    assert.notEqual(a.scope.characterId, b.scope.characterId);
  });
});

test('B 下台：她的一轮停下，对话封存；A 不受影响', async () => {
  await withService(async ({ service }) => {
    service.stage(['bea']);
    const a = await service.begin('stay-a', 'A', 'Gene', () => {});
    const b = await service.begin('leave-b', 'B', 'Bea', () => {}, { characterId: 'bea' });
    b.push('delta', 'B 的半句');
    service.stage([]);
    b.push('delta', '迟到');
    a.push('delta', tail(a, 'A 照常。'));
    await a.finish('complete');
    await b.finish('complete');
    await service.flush();
    assert.equal(reply(service, b).status, 'stopped');
    assert.equal(reply(service, b).content, 'B 的半句');
    assert.equal(service.memory.read(b.scope, b.recordId)!.sealed, true);
    assert.equal(reply(service, a).status, 'complete');
    assert.throws(() => service.begin('late-b', 'B?', 'Bea', () => {}, { characterId: 'bea' }), /不在台上/);
  });
});

test('B 被换成桌面陪伴：她正在说的那一轮接着说完，对话接着她在台上那一段', async () => {
  await withService(async ({ service }) => {
    service.stage(['bea']);
    const b = await service.begin('swap-b', 'B', 'Bea', () => {}, { characterId: 'bea' });
    const seatConversation = service.conversationOf('bea');
    b.push('delta', '前半，');
    await service.context('bea', provider, '角色名称：Bea');
    assert.equal(service.conversationId, seatConversation, '接着她在台上那一段');
    b.push('delta', tail(b, '后半。'));
    await b.finish('complete');
    assert.equal(reply(service, b).status, 'complete');
    assert.equal(reply(service, b).content, '前半，后半。');
    const next = await service.begin('swap-b-2', '再说', 'Bea', () => {});
    assert.equal(next.scope.characterId, 'bea');
    assert.equal(next.recordId, b.recordId, '同一段对话');
    await next.finish('stopped');
  });
});

test('换了连接：台上每个人的轮次都停（和换角色时一样）', async () => {
  await withService(async ({ service }) => {
    service.stage(['bea']);
    const b = await service.begin('conn-b', 'B', 'Bea', () => {}, { characterId: 'bea' });
    await service.context('gene', other, '角色名称：Gene');
    await b.finish('complete');
    assert.equal(reply(service, b).status, 'stopped');
    assert.deepEqual(service.ownerScope('bea'), { characterId: 'bea', providerScope: memoryProviderScope(other) }, 'B 在新连接下有新座位');
  });
});

test('接受范围：桌面陪伴的照旧是声音那边的 speechScope；B 的是她自己的，换桌面陪伴不变', async () => {
  await withService(async ({ service }) => {
    service.stage(['bea']);
    const voice = () => `voice:${service.currentSpeechScope()}`;
    assert.equal(ownerSpeechScope(service, undefined, voice), voice());
    assert.equal(ownerSpeechScope(service, 'gene', voice), voice());
    const before = ownerSpeechScope(service, 'bea', voice);
    assert.notEqual(before, voice());
    await service.context('cora', provider, '角色名称：Cora');
    service.stage(['bea', 'gene']);
    assert.equal(ownerSpeechScope(service, 'bea', voice), before, '换桌面陪伴不改 B 的接受范围（她的热进程不会被拒）');
    service.stage(['gene']);
    assert.throws(() => ownerSpeechScope(service, 'bea', voice), /不在台上/);
  });
});

test('马上起的一轮（一起看断开）带着是谁：存档进她自己的记忆', async () => {
  const owners: string[] = [];
  const turn: WatchFactsTurn = new WatchFactsTurn({
    chatModel: () => 'opus', character: () => ({ id: 'bea', persona: '她是 Bea', language: '' }), mood: () => '', identity: () => 'i', available: () => true,
    line: async () => '{"text":"刚才断了一下"}', free: () => true,
    publish: message => { queueMicrotask(() => turn.done(true, { id: message.id, shown: true })); return true; },
    speechStyle: () => {}, archive: async (_message, _current, owner) => { owners.push(owner); }, sleep: async () => undefined,
  });
  assert.equal(await turn.say('一起看屏幕在 14:32 断了。', 'bea'), 'said');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(owners, ['bea'], '存档时知道这一轮是 Bea 的');
  // the wiring's archive: into her own scope, never the desktop companion's
  await withService(async ({ service }) => {
    service.stage(['bea']);
    const scope = service.ownerScope('bea');
    await service.memory.appendInitiative(scope, { id: 'watch-1', text: '刚才断了一下', at: 1_700_000_000_000, origin: { kind: 'proactive', id: 'watch-1', at: 1_700_000_000_000, sources: ['greeting'], labels: ['一起看'] } });
    assert.equal(service.memory.list(scope).total, 1);
    assert.equal(service.memory.list(service.currentScope()).total, 0);
    assert.throws(() => service.ownerScope('nobody'), /不在台上/, '不在台上的人的一轮无处可存（不会落进别人的记忆）');
  });
});

test('马上起的一轮（亲抱被打断）带着是谁：只有被打断的那位接这一轮', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i209-cut-'));
  const archive = new SpeechBeatArchive(directory);
  try {
    const beats = new SpeechBeatsHost(directory, archive), notice = new CloseCutNotice();
    const heard: string[] = [];
    beats.heardCut((event, cut, text, owner) => { heard.push(owner); notice.cut(event, cut, text, owner); });
    beats.fileCut({ characterId: 'bea', providerScope: 'p' }, 'turn-1', { cause: 'pulled-away', known: true, saidEnd: 0, sentenceEnd: 6 }, { kind: 'hug', frame: 'walking', cause: 'pulled-away' }, '来，我走过去啦。你等等我');
    assert.deepEqual(heard, ['bea'], '打断的记录带着这一轮的角色');
    assert.equal(notice.take('gene'), null, '别人（桌面陪伴换成了 Gene）不接 Bea 被打断的那一轮');
    assert.ok(notice.take('bea'), 'Bea 自己接');
  } finally { await archive.flush(); await rm(directory, { recursive: true, force: true }); } // the cut record is written in the background: wait for it before removing the folder (ENOTEMPTY flake, 1 in 4)
});

test('台上每一位都有活着的心情：B 按秒走着，她这一轮读到的是她自己的心情', async () => {
  let now = 1_000_000;
  const views: string[] = [];
  const live = new Map<string, { O: number }>();
  const host = {
    activeCharacterId: 'gene', ensured: [] as string[], online: [] as boolean[], source: (_: string) => false,
    liveOf(id: string, advance?: { online: boolean }) { if (advance) this.online.push(advance.online); const v = live.get(id); return v ? { characterId: id, expressions: true, parameters: {} as never, snapshot: { values: v } as never } : null; },
    ensure(id: string) { this.ensured.push(id); live.set(id, { O: 50 }); },
    setStageSource(source: (id: string) => boolean) { this.source = source; },
  };
  const moods = new StageMoods(host, () => now);
  moods.onView(view => views.push(view.characterId));
  moods.set(['bea', 'gene', 'cora']);
  assert.deepEqual(moods.ids(), ['bea', 'cora'], '活跃的那位由 MoodHost 自己管');
  assert.deepEqual(host.ensured, ['bea', 'cora']);
  assert.equal(host.source('bea'), true);
  moods.tick(); now += 1_000; moods.tick(); now += 60_000; moods.tick();
  assert.deepEqual(host.online, [false, false, true, true, false, false], '第一下和隔了很久的一下按离线走，连着的按在线走');
  assert.deepEqual(views, ['bea', 'cora', 'bea', 'cora', 'bea', 'cora']);
  moods.set([]);
  assert.equal(host.source('bea'), false);
  // the real MoodHost: B's chat context reads B, not A
  await withService(async ({ service }) => {
    service.stage(['bea']);
    service.mood.lift({ id: 'make-bea-differ', delta: { O: 15 }, reason: '测试' }, 'bea');
    assert.ok(O(service, 'bea') > O(service, 'gene'));
    service.stageMoods.tick();
    assert.notEqual(service.mood.chatContext({ characterId: 'bea' }), service.mood.chatContext(), 'B 的心情一行是她自己的');
    assert.equal(service.moodOf('gene')?.characterId, 'gene');
    assert.equal(service.moodOf('bea')?.characterId, 'bea');
  });
});
