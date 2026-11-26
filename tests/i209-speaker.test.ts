// I-209 第 2 步， 每一条存进聊天历史的话都带着是谁说的。
// 存进去的"说话的人"读出来不变（重新载入也一样）；旧记录没有这个字段，照常读成"用户 / 她自己"；读不懂的说话人当作没有。
// 第 4 步（互相听见）接这里：别人说的话带着她的 by 存进每位听者的历史，交给 Claude 时写成"Gene：……"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../electron/memory/memory';
import { historyLabel, lineSpeaker, speakerName, validSpeaker, SPEAKER_WORDS_EN } from '../shared/memory/speaker';
import type { MemoryScope } from '../shared/memory/memory';

const scope: MemoryScope = { characterId: 'gene', providerScope: 'claude' };
const names: Record<string, string> = { gene: 'Gene', one: 'One' };

async function withDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i209-speaker-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function store(directory: string, speakers = true): Promise<MemoryStore> {
  const memory = new MemoryStore(directory);
  if (speakers) memory.setSpeakerSource(id => names[id] ? { characterId: id, name: names[id] } : undefined);
  await memory.load();
  return memory;
}
async function say(memory: MemoryStore, id: string, user: string, reply: string, extra: Parameters<MemoryStore['beginTurn']>[1] extends infer T ? Partial<T> : never = {}) {
  const handle = await memory.beginTurn(scope, { id, userText: user, at: Date.now(), conversationId: 'c1', ...extra });
  await memory.appendAssistant(scope, id, reply, Date.now());
  await memory.finishTurn(scope, id, 'complete', Date.now());
  return handle;
}

test('存进去的说话人读出来不变，重新载入也一样；主动说的话也带着', async () => {
  await withDir(async directory => {
    const memory = await store(directory);
    const turn = await say(memory, 't1', '你好', '你好呀');
    await memory.appendInitiative(scope, { id: 'init-1', text: '我在想你', at: 1_700_000_000_000, origin: { kind: 'proactive', id: 'init-1', at: 1_700_000_000_000, sources: ['greeting'], labels: ['问候'] } });
    // Step 4's seam: a line another character said, archived into Gene's history with One's name.
    const heard = await say(memory, 't2', '你们好', 'One 在这儿', { by: { characterId: 'one', name: 'One' } });
    await memory.flush();
    const read = (m: MemoryStore) => ({
      own: m.read(scope, turn.recordId)!.messages.filter(x => x.turnId === 't1').map(x => [x.role, x.by ?? null]),
      heard: m.read(scope, heard.recordId)!.messages.find(x => x.role === 'assistant' && x.turnId === 't2')!.by,
      initiative: m.read(scope, m.findInitiative(scope, 'init-1')!.recordId)!.messages[0].by,
    });
    const before = read(memory);
    assert.deepEqual(before.own, [['user', null], ['assistant', { characterId: 'gene', name: 'Gene' }]], '用户的话不带 by（就是用户），她的话带着她');
    assert.deepEqual(before.heard, { characterId: 'one', name: 'One' });
    assert.deepEqual(before.initiative, { characterId: 'gene', name: 'Gene' });
    const again = await store(directory, false);
    assert.deepEqual(read(again), before, '从磁盘重新载入，说话人不变');
  });
});

test('旧记录（没有说话人）照常读：用户的是用户，她的是她自己', async () => {
  await withDir(async directory => {
    const old = await store(directory, false); // like every archive before this step
    const turn = await say(old, 'old-1', '早', '早呀');
    await say(old, 'old-2', '谁在', '有人在', { speaker: 'visitor' });
    await old.flush();
    const memory = await store(directory);
    const messages = memory.read(scope, turn.recordId)!.messages.filter(message => message.turnId === 'old-1');
    assert.ok(messages.every(message => message.by === undefined));
    assert.deepEqual(messages.map(message => lineSpeaker(message, 'gene')), [{ kind: 'user' }, { kind: 'self', name: '' }]);
    assert.deepEqual(messages.map(message => historyLabel(message, 'gene')), ['你（用户）', '你自己']);
    assert.equal(speakerName({ role: 'user', speaker: 'visitor' }, 'gene'), '来访的另一个人');
    assert.ok(memory.read(scope, turn.recordId)!.messages.some(message => message.turnId === 'old-2'), '旧记录都在');
  });
});

test('读不懂的说话人当作没有：不会因此读坏，也不会冒充别人', async () => {
  await withDir(async directory => {
    const memory = await store(directory);
    const bad = { characterId: '../evil', name: 'x' } as never;
    const turn = await say(memory, 'bad-1', '嗨', '嗨', { by: bad });
    const line = memory.read(scope, turn.recordId)!.messages[1];
    assert.equal(line.by, undefined, '给错了就不存（不冒充别人）');
    assert.deepEqual(lineSpeaker(line, 'gene'), { kind: 'self', name: '' }, '读成她自己');
    assert.equal(validSpeaker({ characterId: 'gene', name: 'G', extra: 1 }), undefined);
    assert.equal(validSpeaker({ characterId: 'gene', name: 'x\0' }), undefined);
    assert.deepEqual(validSpeaker({ characterId: 'gene', name: `  ${'长'.repeat(60)}  ` }), { characterId: 'gene', name: '长'.repeat(40) });
  });
});

test('交给 Claude 的历史能写成"Gene：……""One：……""你（用户）：……"；记录页能显示是谁', () => {
  const lines = [
    { role: 'user' as const },
    { role: 'assistant' as const, by: { characterId: 'gene', name: 'Gene' } },
    { role: 'assistant' as const, by: { characterId: 'one', name: 'One' } },
    { role: 'assistant' as const, by: { characterId: 'ann', name: '' } },
  ];
  assert.deepEqual(lines.map(line => historyLabel(line, 'gene')), ['你（用户）', '你自己', 'One', '另一位角色']);
  assert.deepEqual(lines.map(line => historyLabel(line, 'one')), ['你（用户）', 'Gene', '你自己', '另一位角色'], '同一段话在 One 的历史里，Gene 是别人');
  assert.deepEqual(lines.map(line => speakerName(line, 'gene')), ['你（用户）', 'Gene', 'One', '另一位角色']);
  assert.equal(historyLabel({ role: 'user' }, 'gene', SPEAKER_WORDS_EN), 'You (the user)');
});
