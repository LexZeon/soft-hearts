// I-188 #13: reminders read locally from the user's message (made-up lines only).
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReminderRequest, zhNumber } from '../shared/behaviors/moments/reminder-parse';

const NOW = new Date(2026, 10, 22, 14, 7).getTime(); // Sunday 14:07 local
const at = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m, d, h, mi).getTime();
const set = (text: string) => {
  const r = parseReminderRequest(text, NOW);
  assert.ok(r && r.kind === 'set', `${text} → ${JSON.stringify(r)}`);
  return r as Extract<typeof r, { kind: 'set' }>;
};

test('Chinese numbers', () => {
  assert.equal(zhNumber('十'), 10); assert.equal(zhNumber('十二'), 12); assert.equal(zhNumber('二十五'), 25); assert.equal(zhNumber('两'), 2); assert.equal(zhNumber('8'), 8);
  assert.ok(Number.isNaN(zhNumber('十十')));
});

test('relative Chinese times', () => {
  assert.equal(set('十分钟后叫我').dueAt, at(2026, 10, 22, 14, 17));
  assert.equal(set('一个小时后提醒我关火').dueAt, at(2026, 10, 22, 15, 7));
  assert.equal(set('一个小时后提醒我关火').what, '关火');
  assert.equal(set('半小时后提醒我').dueAt, at(2026, 10, 22, 14, 37));
  assert.equal(set('过两个半小时叫我').dueAt, at(2026, 10, 22, 16, 37));
  const soon = set('等下叫我吃饭');
  assert.equal(soon.dueAt, at(2026, 10, 22, 14, 27)); assert.equal(soon.guessed, true); assert.equal(soon.what, '吃饭');
});

test('clock times with day and period words', () => {
  const morning = set('明天早上八点提醒我交报告');
  assert.equal(morning.dueAt, at(2026, 10, 23, 8)); assert.equal(morning.guessed, false); assert.equal(morning.what, '交报告');
  assert.equal(set('下午五点提醒我去取快递吧').dueAt, at(2026, 10, 22, 17));
  assert.equal(set('下午五点提醒我去取快递吧').what, '取快递');
  assert.equal(set('晚上十点叫我睡觉').dueAt, at(2026, 10, 22, 22));
  assert.equal(set('20:30提醒我看比赛').dueAt, at(2026, 10, 22, 20, 30));
  assert.equal(set('提醒我明天交作业哦').what, '交作业');
  assert.equal(set('提醒我明天交作业哦').guessed, true); // a day without a clock: 09:00, she confirms
});

test('am/pm unknown takes the next one and is a guess', () => {
  const half = set('三点半提醒我开会');
  assert.equal(half.dueAt, at(2026, 10, 22, 15, 30)); assert.equal(half.guessed, true);
  const nine = set('9点叫我');
  assert.equal(nine.dueAt, at(2026, 10, 22, 21)); assert.equal(nine.guessed, true);
  assert.equal(set('今晚提醒我洗衣服').dueAt, at(2026, 10, 22, 21));
});

test('no time: unclear (she asks when); cancel words; nothing else', () => {
  assert.deepEqual(parseReminderRequest('提醒我喝水', NOW), { kind: 'unclear', what: '喝水' });
  for (const text of ['不用提醒了', '别提醒我了', '取消提醒', '提醒就算了', "don't remind me", 'cancel the reminder']) assert.deepEqual(parseReminderRequest(text, NOW), { kind: 'cancel' }, text);
  for (const text of ['今天好累', '我三点要开会', 'remember that movie?', '', '   ']) assert.equal(parseReminderRequest(text, NOW), null, text);
});

test('English forms', () => {
  const stretch = set('remind me in 20 minutes to stretch');
  assert.equal(stretch.dueAt, at(2026, 10, 22, 14, 27)); assert.equal(stretch.what, 'stretch');
  assert.equal(set('remind me at 9pm to call mom').dueAt, at(2026, 10, 22, 21));
  assert.equal(set('remind me at 9pm to call mom').what, 'call mom');
  const milk = set('remind me tomorrow to buy milk');
  assert.equal(milk.dueAt, at(2026, 10, 23, 9)); assert.equal(milk.guessed, true); assert.equal(milk.what, 'buy milk');
});

test('a time in the past or far away is unclear; the words are capped', () => {
  assert.equal(parseReminderRequest('20:30提醒我' + '看'.repeat(80), NOW, 40)?.kind, 'set');
  const long = parseReminderRequest('20:30提醒我' + '看'.repeat(80), NOW, 40) as { what: string };
  assert.equal(Array.from(long.what).length, 40);
  assert.equal(parseReminderRequest('99:99提醒我', NOW)?.kind, 'unclear');
});
