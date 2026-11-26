// I-209 第 4 步（docs/claude/2026-11-24-i209-step4.md）。 台上两位、三位时：一句话（你的、她们的、自己开口的）每一位都听见，各自只记一次、带着是谁说的；交给 Claude 的历史写出名字。
// 只有一位时什么都不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../electron/memory/memory';
import { StageHearing, heardId, type HeardEvent } from '../electron/brain/stage-chat/hearing';
import type { StageLine } from '../electron/brain/stage-chat/facts';
import { longChatMessages } from '../electron/brain/long-chat/host';
import { buildLongChatWindow } from '../electron/brain/long-chat/window';
import { LONG_CHAT_KNOBS } from '../shared/behaviors/long-chat/knobs';
import type { MemoryScope } from '../shared/memory/memory';

const names: Record<string, string> = { gene: 'Gene', one: 'One', two: 'Two' };
const scopeOf = (id: string): MemoryScope => ({ characterId: id, providerScope: 'claude' });
const KNOBS = { ...LONG_CHAT_KNOBS, enabled: true };

async function withDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i209-hearing-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function store(directory: string): Promise<MemoryStore> {
  const memory = new MemoryStore(directory);
  memory.setSpeakerSource(id => names[id] ? { characterId: id, name: names[id] } : undefined);
  await memory.load();
  return memory;
}
const settle = async (memory: MemoryStore) => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); await memory.flush(); };

/** The stage as the wiring builds it: the memory tells, the hearing writes into each listener's archive. */
function stage(memory: MemoryStore, present: string[], heard: StageLine[] = [], began: number[] = []) {
  const hearing = new StageHearing({
    present: () => present, scopeOf, speaker: id => ({ characterId: id, name: names[id] ?? '' }),
    append: (scope, line) => memory.appendStageLine(scope, line), heard: line => { heard.push(line); }, userSpoke: at => { began.push(at); },
  });
  memory.onStageLine(event => hearing.event(event as HeardEvent));
  return hearing;
}
async function turn(memory: MemoryStore, who: string, id: string, user: string, reply: string, at = Date.now()) {
  await memory.beginTurn(scopeOf(who), { id, userText: user, at, conversationId: 'c1' });
  await memory.appendAssistant(scopeOf(who), id, reply, at + 10);
  await memory.finishTurn(scopeOf(who), id, 'complete', at + 20);
}
const stageLines = (memory: MemoryStore, who: string) => memory.chatWindowSource(scopeOf(who)).filter(line => line.stage);

for (const present of [['gene', 'one'], ['gene', 'one', 'two']]) {
  test(`${present.length} on stage: your line to Gene and her reply reach every other one once each, with who said it (and to whom you said it)`, async () => {
    await withDir(async directory => {
      const memory = await store(directory), heard: StageLine[] = [], began: number[] = [];
      const hearing = stage(memory, present, heard, began);
      await turn(memory, 'gene', 't1', '今天好冷', '我给你倒杯热水');
      await settle(memory);
      for (const listener of present.filter(id => id !== 'gene')) {
        const lines = stageLines(memory, listener);
        assert.deepEqual(lines.map(line => [line.role, line.content, line.by?.name ?? null, line.to?.name ?? null]),
          [['user', '今天好冷', null, 'Gene'], ['assistant', '我给你倒杯热水', 'Gene', null]], `${listener} heard both, with the speaker and the addressee`);
      }
      assert.deepEqual(stageLines(memory, 'gene'), [], 'Gene keeps her own turn only (one archive per reply)');
      assert.equal(began.length, 1, 'the user began a turn: told once');
      assert.deepEqual(heard.map(line => [line.speaker, line.text]), [[null, '今天好冷'], ['gene', '我给你倒杯热水']]);
      // The same said line again (a retry, a second listener call): still one record per listener.
      hearing.event({ kind: 'said', scope: scopeOf('gene'), turnId: 't1', at: Date.now(), text: '我给你倒杯热水', user: { text: '今天好冷', at: Date.now() } });
      await settle(memory);
      for (const listener of present.filter(id => id !== 'gene')) assert.equal(stageLines(memory, listener).length, 2, 'never a second copy');
      // Reloaded: the speakers stay.
      const again = await store(directory);
      for (const listener of present.filter(id => id !== 'gene'))
        assert.deepEqual(stageLines(again, listener).map(line => [line.by?.characterId ?? null, line.to?.characterId ?? null]), [[null, 'gene'], ['gene', null]]);
    });
  });
}

test('a line of her own (an initiative) and a chime-in on stage are heard by the others; what one only heard is never passed on again', async () => {
  await withDir(async directory => {
    const memory = await store(directory), heard: StageLine[] = [];
    stage(memory, ['gene', 'one', 'two'], heard);
    const at = 1_700_000_000_000;
    await memory.appendInitiative(scopeOf('gene'), { id: 'init-1', text: '我有点困了', at, origin: { kind: 'proactive', id: 'init-1', at, sources: ['inner'], labels: ['困了'] } });
    await settle(memory);
    await memory.appendStageLine(scopeOf('one'), { id: 'sense-chime-1', text: '那就睡一会儿嘛', at: at + 1000, role: 'assistant' });
    await settle(memory);
    assert.deepEqual(stageLines(memory, 'two').map(line => [line.by?.name, line.content]), [['Gene', '我有点困了'], ['One', '那就睡一会儿嘛']]);
    assert.deepEqual(stageLines(memory, 'one').map(line => [line.by?.name, line.content]), [['Gene', '我有点困了'], ['One', '那就睡一会儿嘛']], 'One: what she heard and her own line');
    assert.deepEqual(stageLines(memory, 'gene').map(line => [line.by?.name, line.content]), [['One', '那就睡一会儿嘛']]);
    assert.deepEqual(heard.map(line => line.speaker), ['gene', 'one'], 'two lines said, two told: a heard copy never echoes');
  });
});

test('alone on stage (or at home) nothing is copied and nothing is told', async () => {
  await withDir(async directory => {
    const memory = await store(directory), heard: StageLine[] = [], began: number[] = [];
    stage(memory, [], heard, began);
    await turn(memory, 'gene', 't1', '你好', '你好呀');
    await settle(memory);
    assert.deepEqual([stageLines(memory, 'gene'), stageLines(memory, 'one'), heard, began], [[], [], [], []]);
  });
});

test('a speaker the hearing could not name still goes with her id (a line is never archived without its speaker)', async () => {
  await withDir(async directory => {
    const memory = await store(directory);
    const hearing = new StageHearing({ present: () => ['gene', 'one'], scopeOf, speaker: () => undefined, append: (scope, line) => memory.appendStageLine(scope, line) });
    hearing.event({ kind: 'said', scope: scopeOf('gene'), turnId: 't9', at: Date.now(), text: '在呢' });
    await settle(memory);
    assert.equal(stageLines(memory, 'one')[0]?.by?.characterId, 'gene');
  });
});

test('the history handed to Claude names the speakers once someone else spoke on stage; a window without that is exactly as before', async () => {
  await withDir(async directory => {
    const memory = await store(directory);
    await turn(memory, 'one', 'own-1', '早', '早呀', 1_700_000_000_000);
    const before = longChatMessages({ knobs: KNOBS, archives: [memory], scope: scopeOf('one'), current: { content: '在吗', createdAt: 1_700_000_100_000 }, now: 1_700_000_200_000 });
    const plain = buildLongChatWindow({ messages: memory.chatWindowSource(scopeOf('one')), now: 1_700_000_200_000, knobs: KNOBS, current: { content: '在吗', createdAt: 1_700_000_100_000 } });
    assert.deepEqual(before, [...plain.history, plain.current], 'no stage line: the same window as without a speaker label');
    stage(memory, ['gene', 'one']);
    await turn(memory, 'gene', 't1', '今天好冷', '我给你倒杯热水', 1_700_000_050_000);
    await settle(memory);
    const after = longChatMessages({ knobs: KNOBS, archives: [memory], scope: scopeOf('one'), current: { content: '在吗', createdAt: 1_700_000_100_000 }, now: 1_700_000_200_000 })!;
    assert.deepEqual(after.map(message => [message.role, message.content]), [
      ['user', '你（用户）：早'], ['assistant', '早呀'], ['user', '你（用户）（对Gene说）：今天好冷'], ['user', 'Gene：我给你倒杯热水'], ['user', '你（用户）：在吗'],
    ]);
    // An English card's words.
    const en = longChatMessages({ knobs: KNOBS, archives: [memory], scope: scopeOf('one'), language: 'en', current: { content: 'hi', createdAt: 1_700_000_100_000 }, now: 1_700_000_200_000 })!;
    assert.equal(en[2]!.content, 'You (the user) (to Gene)：今天好冷');
  });
});

test('stage records: the same id twice keeps one; a bad id is refused; an addressee that does not read is dropped', async () => {
  await withDir(async directory => {
    const memory = await store(directory);
    const line = { id: 'x1', text: '嗯', at: 1_700_000_000_000, role: 'user' as const, to: { characterId: 'gene', name: 'Gene' } };
    const first = await memory.appendStageLine(scopeOf('one'), line), second = await memory.appendStageLine(scopeOf('one'), line);
    assert.equal(first.recordId, second.recordId);
    assert.throws(() => memory.appendStageLine(scopeOf('one'), { ...line, id: 'bad id' }), /编号/);
    await memory.appendStageLine(scopeOf('one'), { id: 'x2', text: '好', at: 1_700_000_000_001, role: 'user', to: { characterId: 'bad id!', name: 'X' } });
    await memory.flush();
    assert.equal(stageLines(memory, 'one').find(entry => entry.content === '好')?.to, undefined, 'an addressee that does not read is not kept');
    assert.match(heardId('t1', 'u'), /^heard-[0-9a-f]{24}-u$/);
    assert.equal(heardId('t1', 'u'), heardId('t1', 'u'));
  });
});

test('no echo: the store never tells a copy she only heard, and the hearing never passes on a heard copy (even one that lost its speaker)', async () => {
  await withDir(async directory => {
    const memory = await store(directory), told: string[] = [];
    memory.onStageLine(event => { if (event.kind === 'said') told.push(event.turnId); });
    await memory.appendStageLine(scopeOf('one'), { id: heardId('t1', 'a'), text: '我给你倒杯热水', at: 1_700_000_000_000, role: 'assistant', by: { characterId: 'gene', name: 'Gene' } });
    await memory.appendStageLine(scopeOf('one'), { id: heardId('t1', 'u'), text: '今天好冷', at: 1_700_000_000_000, role: 'user', to: { characterId: 'gene', name: 'Gene' } });
    await memory.appendStageLine(scopeOf('one'), { id: 'sense-chime-2', text: '我也要', at: 1_700_000_000_001, role: 'assistant' });
    assert.deepEqual(told, ['sense-chime-2'], 'only her own line is told');
    const written: string[] = [];
    const hearing = new StageHearing({ present: () => ['gene', 'one', 'two'], scopeOf, speaker: id => ({ characterId: id, name: names[id] ?? '' }), append: async (_scope, line) => { written.push(line.id); } });
    hearing.event({ kind: 'said', scope: scopeOf('one'), turnId: heardId('t1', 'a'), at: 1, text: '我给你倒杯热水' });
    assert.deepEqual(written, [], 'a heard copy is never copied again');
  });
});
