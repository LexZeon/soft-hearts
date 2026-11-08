// I-017 / real-chat finding 2: the same caring question at most once per stretch of conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CARE_STRETCH_GAP_MS, CareAskedTracker, careAskedLine, careKindsAsked, careKindsMentioned } from '../shared/care-asked';
import { CompanionService } from '../electron/companion';

test('her questions and nudges are sorted into kinds, plain mentions are not', () => {
  assert.deepEqual(careKindsAsked('吃饭了吗？'), ['吃饭']);
  assert.deepEqual(careKindsAsked('累不累呀，今天一直在忙。'), ['累不累']);
  assert.deepEqual(careKindsAsked('记得喝水，别太晚睡。'), ['休息睡觉', '喝水']);
  assert.deepEqual(careKindsAsked('今天过得怎么样？心情还好吗'), ['心情', '今天过得怎样']);
  assert.deepEqual(careKindsAsked('胃还疼吗，吃药了没有？'), ['身体']);
  // Statements and stories are not asks.
  assert.deepEqual(careKindsAsked('我刚才吃了一个布丁，很甜。'), []);
  assert.deepEqual(careKindsAsked('昨天看了一部讲睡眠的纪录片。'), []);
  assert.deepEqual(careKindsAsked('哈哈，这只猫好可爱。'), []);
});

test('the user raising a kind themselves is detected by mention', () => {
  assert.deepEqual(careKindsMentioned('我今天没吃饭，好累'), ['吃饭', '累不累']);
  assert.deepEqual(careKindsMentioned('晚上看了会儿剧'), []);
});

test('the line lists each asked kind once, however often she asked', () => {
  const tracker = new CareAskedTracker(() => 1_000);
  assert.equal(tracker.line('c1', '你好'), '', 'nothing before she asked');
  tracker.note('c1', '吃饭了吗？');
  tracker.note('c1', '累不累？吃饭了没有？'); // asked 吃饭 again, and 累不累
  tracker.note('c1', '这个周末有安排吗'); // asks nothing of this kind
  assert.deepEqual(tracker.counts('c1'), { 吃饭: 2, 累不累: 1 });
  const line = tracker.line('c1', '嗯，在忙');
  assert.equal(line, '这段对话里你已经问过：吃饭、累不累。问过的不再问，除非用户自己又提起。');
  assert.equal(line.split('吃饭').length, 2, 'listed once');
  assert.equal(tracker.line('other', '嗯'), '', 'another conversation knows nothing of it');
});

test('a kind the user raises in this very message is left out of that turn only', () => {
  const tracker = new CareAskedTracker(() => 1_000);
  tracker.note('c1', '吃饭了吗？累不累？');
  assert.equal(tracker.line('c1', '我还没吃饭呢'), careAskedLine(['累不累']));
  assert.equal(tracker.line('c1', '好无聊'), careAskedLine(['吃饭', '累不累']), 'next turn it is back');
});

test('a long gap or a new conversation starts a fresh stretch', () => {
  let now = 0;
  const tracker = new CareAskedTracker(() => now);
  tracker.note('c1', '吃饭了吗？');
  now += CARE_STRETCH_GAP_MS - 1;
  assert.ok(tracker.line('c1', '嗯'), 'still the same stretch just inside the gap');
  tracker.note('c1', '喝水了吗？'); // refreshes the stretch
  now += CARE_STRETCH_GAP_MS - 1;
  assert.deepEqual(tracker.counts('c1'), { 吃饭: 1, 喝水: 1 });
  now += 2;
  assert.equal(tracker.line('c1', '嗯'), '', 'after the gap it is forgotten');
  tracker.note('c1', '吃饭了吗？');
  assert.deepEqual(tracker.counts('c1'), { 吃饭: 1 }, 'and she may ask again, as a new stretch');
});

// ---- through the host: the line is in the next turn's private context

async function withService(run: (service: CompanionService) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-care-asked-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://care.invalid/v1', model: 'fixture' }, '角色名称：Gene'); await run(service); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
const marker = (persona: string) => persona.match(/<sh-state-[a-f0-9]+>/)![0];
async function say(service: CompanionService, id: string, user: string, reply: string) {
  const turn = await service.begin(id, user, '角色名称：Gene', () => {});
  const start = marker(turn.persona);
  turn.push('delta', `${reply}\n${start}{"context":"neutral","delta":{},"confidence":0.8}${start.replace('<', '</')}`);
  await turn.finish('complete');
  return turn;
}
const LINE = '这段对话里你已经问过';

test('multi-turn: the line appears once she asked, lists kinds once, and is not there before', async () => {
  await withService(async service => {
    const first = await say(service, 'care-1', '你好呀', '你好～今天吃饭了吗？');
    assert.ok(!first.persona.includes(LINE), 'nothing to say in the first turn');
    const second = await say(service, 'care-2', '还没呢，在忙', '那也要记得吃饭，累不累？');
    assert.ok(second.persona.includes('这段对话里你已经问过：吃饭。'), '吃饭 told');
    const third = await say(service, 'care-3', '嗯，有点', '早点休息，好不好？');
    assert.ok(third.persona.includes('这段对话里你已经问过：吃饭、累不累。'), 'her second ask counts, 吃饭 once');
    assert.equal(third.persona.split('吃饭、累不累').length, 2);
    const fourth = await say(service, 'care-4', '我今天又没吃饭', '哎呀。');
    assert.ok(fourth.persona.includes('这段对话里你已经问过：休息睡觉、累不累。'), '吃饭 left out: the user raised it');
    assert.ok(!fourth.persona.includes('问过：吃饭'));
  });
});

test('a new chat forgets what she asked', async () => {
  await withService(async service => {
    await say(service, 'new-1', '你好', '吃饭了吗？');
    const before = await say(service, 'new-2', '嗯', '好。');
    assert.ok(before.persona.includes(LINE));
    await service.newConversation?.();
    const after = await say(service, 'new-3', '我回来了', '欢迎回来。');
    assert.ok(!after.persona.includes(LINE), 'a new conversation starts a new stretch');
  });
});
