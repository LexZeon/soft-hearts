/**
 * P-001 step 1: the user's time words -> the moment she may ask (shared/behaviors/upcoming/due.ts). Fake times only (local calendar);
 * each case names what the user would feel: a plan said late on Wednesday night, across midnight, a week and a month.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { hasTimeWord, resolveDue } from '../shared/behaviors/upcoming/due';
import { UPCOMING_KNOBS } from '../shared/behaviors/upcoming/knobs';

const at = (month: number, day: number, hour = 0, minute = 0, year = 2026) => new Date(year, month - 1, day, hour, minute).getTime();
const show = (ms: number | null) => ms === null ? null : (() => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; })();

test('the test calendar is what the cases below assume (2026-11-11 is a Wednesday)', () => {
  assert.equal(new Date(2026, 10, 11).getDay(), 3);
});

test('Wednesday 23:50 "明天下午面试" is due Thursday 18:00, not Wednesday', () => {
  assert.equal(show(resolveDue('明天下午', at(11, 11, 23, 50))), '2026-11-12 18:00');
});

test('a day only is 18:00, 上午 is 12:00, 下午 is 18:00, 晚上 is the next morning', () => {
  const now = at(11, 11, 10, 0);
  assert.equal(show(resolveDue('明天', now)), '2026-11-12 18:00');
  assert.equal(show(resolveDue('明天上午', now)), '2026-11-12 12:00');
  assert.equal(show(resolveDue('明天早上', now)), '2026-11-12 12:00');
  assert.equal(show(resolveDue('明天中午', now)), '2026-11-12 14:00');
  assert.equal(show(resolveDue('明天下午', now)), '2026-11-12 18:00');
  assert.equal(show(resolveDue('明天晚上', now)), '2026-11-13 08:00');
  assert.equal(show(resolveDue('今晚', now)), '2026-11-12 08:00');
  assert.equal(show(resolveDue('明晚', now)), '2026-11-13 08:00');
  assert.equal(show(resolveDue('后天', now)), '2026-11-13 18:00');
  assert.equal(show(resolveDue('大后天', now)), '2026-11-14 18:00');
  assert.equal(show(resolveDue('今天', now)), '2026-11-11 18:00');
});

test('a clock time is two hours after it, with 上午 / 下午 / 晚上 and a bare small hour read as afternoon', () => {
  const now = at(11, 11, 10, 0);
  assert.equal(show(resolveDue('明天下午3点', now)), '2026-11-12 17:00');
  assert.equal(show(resolveDue('明天上午10点', now)), '2026-11-12 12:00');
  assert.equal(show(resolveDue('今晚8点', now)), '2026-11-11 22:00');
  assert.equal(show(resolveDue('后天15:30', now)), '2026-11-13 17:30');
  assert.equal(show(resolveDue('明天三点半', now)), '2026-11-12 17:30');
  assert.equal(show(resolveDue('3点', now)), '2026-11-11 17:00', 'today, later than now');
  assert.equal(show(resolveDue('11点', now)), '2026-11-11 13:00', 'bare 11 is morning: 11:00 + 2 h');
});

test('a clock time that already passed today means tomorrow', () => {
  assert.equal(show(resolveDue('3点', at(11, 11, 23, 50))), '2026-11-12 17:00');
  assert.equal(show(resolveDue('下午', at(11, 11, 19, 0))), '2026-11-12 18:00');
});

test('weekdays: the next one (never today), 下周 is next week, 这周 is this week and not in the past', () => {
  const wednesday = at(11, 11, 12, 0);
  assert.equal(show(resolveDue('周五', wednesday)), '2026-11-13 18:00');
  assert.equal(show(resolveDue('星期五下午', wednesday)), '2026-11-13 18:00');
  assert.equal(show(resolveDue('周三', wednesday)), '2026-11-18 18:00', 'the same weekday is a week later');
  assert.equal(show(resolveDue('周一', wednesday)), '2026-11-16 18:00');
  assert.equal(show(resolveDue('下周三', wednesday)), '2026-11-18 18:00');
  assert.equal(show(resolveDue('下周一', wednesday)), '2026-11-16 18:00');
  assert.equal(show(resolveDue('下周日', wednesday)), '2026-11-22 18:00');
  assert.equal(show(resolveDue('这周五', wednesday)), '2026-11-13 18:00');
  assert.equal(resolveDue('这周一', wednesday), null, 'this Monday is already behind us');
  assert.equal(show(resolveDue('周六下午3点', wednesday)), '2026-11-14 17:00');
});

test('across the week: Sunday night "明天" is Monday, "周一" and "下周一" are the same Monday', () => {
  const sunday = at(11, 15, 23, 30);
  assert.equal(new Date(sunday).getDay(), 0);
  assert.equal(show(resolveDue('明天下午', sunday)), '2026-11-16 18:00');
  assert.equal(show(resolveDue('周一', sunday)), '2026-11-16 18:00');
  assert.equal(show(resolveDue('下周一', sunday)), '2026-11-16 18:00');
  assert.equal(show(resolveDue('下周二', sunday)), '2026-11-17 18:00');
});

test('across the month and the year', () => {
  assert.equal(show(resolveDue('明天', at(11, 30, 23, 55))), '2026-12-01 18:00');
  assert.equal(show(resolveDue('后天', at(11, 30, 23, 55))), '2026-12-02 18:00');
  assert.equal(show(resolveDue('明天上午', at(12, 31, 22, 0))), '2027-01-01 12:00');
  assert.equal(show(resolveDue('明天', at(2, 28, 12, 0))), '2026-03-01 18:00', 'a short February');
  assert.equal(show(resolveDue('明天', at(2, 28, 12, 0, 2028))), '2028-02-29 18:00', 'a leap year');
});

test('a day of the month: this month when it is still ahead (or today), otherwise next; months without it are skipped', () => {
  const now = at(11, 20, 9, 0);
  assert.equal(show(resolveDue('25号', now)), '2026-11-25 18:00');
  assert.equal(show(resolveDue('20号', now)), '2026-11-20 18:00', 'today counts');
  assert.equal(show(resolveDue('15号', now)), '2026-12-15 18:00');
  assert.equal(show(resolveDue('十五号下午', now)), '2026-12-15 18:00');
  assert.equal(show(resolveDue('31号', now)), '2026-12-31 18:00', 'November has no 31st');
  assert.equal(show(resolveDue('下个月5号', now)), '2026-12-05 18:00');
  assert.equal(show(resolveDue('11月5日', now)), '2027-11-05 18:00', 'already past this year');
  assert.equal(show(resolveDue('12月24日晚上', now)), '2026-12-25 08:00');
  assert.equal(show(resolveDue('3天后', now)), '2026-11-23 18:00');
});

test('words that name no moment, or a moment in the past, give nothing', () => {
  const now = at(11, 11, 10, 0);
  for (const words of ['过阵子', '以后', '改天', '有空的时候', '', '   ', '最近', '一直', '昨天下午', '上周五', '前天', '刚才', '坐5号线', '周末']) {
    assert.equal(resolveDue(words, now), null, JSON.stringify(words));
  }
  assert.equal(resolveDue(undefined as never, now), null);
  assert.equal(resolveDue('明天', Number.NaN), null);
});

test('the hours are knobs, not constants', () => {
  const knobs = { ...UPCOMING_KNOBS, due: { ...UPCOMING_KNOBS.due, dayOnlyHour: 9, clockDelayMinutes: 30 } };
  const now = at(11, 11, 10, 0);
  assert.equal(show(resolveDue('明天', now, knobs)), '2026-11-12 09:00');
  assert.equal(show(resolveDue('明天下午3点', now, knobs)), '2026-11-12 15:30');
});

test('hasTimeWord: a day or a clock time counts; a greeting or "a bit" does not', () => {
  for (const text of ['我明天下午有个面试', '周五去爬山', '3点开会', '今晚吃火锅', '下周三交报告', '15号搬家']) assert.equal(hasTimeWord(text, at(11, 11)), true, text);
  for (const text of ['晚上好', '我有点累', '一点点而已', '坐5号线回家', '你好呀', '']) assert.equal(hasTimeWord(text, at(11, 11)), false, text);
});
