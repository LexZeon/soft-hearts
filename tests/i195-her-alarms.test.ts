/**
 * I-195 her own alarms: the marker (parse, never leaks), the store (limits, expiry, once), the host (switch, chat turn, grey line,
 * words that cancel), and the moments path (a time alarm and an event alarm wake through the same gates, once). Made-up lines only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALARM_MARK_CLOSE, ALARM_MARK_OPEN, isAlarmEvent, ALARM_EVENTS, ALARM_GREY_LINE } from '../shared/behaviors/alarms/interface';
import { ALARM_KNOBS } from '../shared/behaviors/alarms/knobs';
import { parseAlarmMarker } from '../shared/behaviors/alarms/parse';
import { alarmListLine, alarmSentence, alarmWokeLine, parseAlarmCancel, USER_SLEEP } from '../shared/behaviors/alarms/prompt';
import { momentPromptLine } from '../shared/behaviors/moments/prompt';
import { SpeechBeatFilter, filterSpeechBeats } from '../shared/behaviors/speech-beats/choose';
import { SpeechBeatTurn } from '../electron/brain/speech-beats/turn';
import { AlarmStore } from '../electron/initiative/moments/alarm-store';
import { AlarmSwitch } from '../electron/initiative/moments/alarm-switch';
import { HerAlarms } from '../electron/initiative/moments/alarms';
import { MomentHost, type MomentHostPorts, type MomentJournalRow } from '../electron/initiative/moments/host';
import { MomentStateStore } from '../electron/initiative/moments/state-store';
import { eveningNightKey } from '../shared/behaviors/moments/bedtime';
import type { PresenceView } from '../shared/senses';

const temps: string[] = [];
test.after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'sh-i195-')); temps.push(dir); return dir; };
const local = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m, d, h, mi).getTime();
const minuteOf = (ms: number) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
const MIN = 60_000;
/** Sunday 2026-11-22 14:00 (local). */
const NOW = local(2026, 10, 22, 14, 0);
/** Wednesday 2026-11-25 10:00. */
const WED = local(2026, 10, 25, 10, 0);

function set(body: string, now = NOW) {
  const marker = parseAlarmMarker(body, now);
  assert.equal(marker?.kind, 'set', body);
  return (marker as { kind: 'set'; spec: { at: number | null; on: string | null; talk: string | null; note: string } }).spec;
}

// ---------------------------------------------------------------- the marker

test('marker: times (in N, a clock time, a date, a weekday), events, a word, combinations', () => {
  assert.deepEqual(set('alarm|in=20m|note=看看汤'), { at: NOW + 20 * MIN, on: null, talk: null, note: '看看汤' });
  assert.equal(set('alarm|in=2h|note=x').at, NOW + 120 * MIN);
  assert.equal(set('alarm|in=3d|note=x').at, NOW + 3 * 24 * 60 * MIN);
  assert.equal(set('alarm|at=21:30|note=x').at, local(2026, 10, 22, 21, 30), 'later today');
  assert.equal(set('alarm|at=09:00|note=x').at, local(2026, 10, 23, 9, 0), 'a clock time already past rolls to tomorrow');
  assert.equal(set('alarm|day=tomorrow|at=08:15|note=x').at, local(2026, 10, 23, 8, 15));
  assert.equal(set('alarm|day=tomorrow|note=x').at, local(2026, 10, 23, ALARM_KNOBS.defaultHour, 0), 'a day alone: the default hour');
  assert.equal(set('alarm|day=2026-12-01|at=18:00|note=x').at, local(2026, 11, 1, 18, 0), 'an absolute date');
  assert.equal(set('alarm|day=12-05|note=x').at, local(2026, 11, 5, 9, 0), 'month-day: this year');
  // Weekdays: from Wednesday 11-25, "fri" is the coming Friday, "next-fri" next week's, "mon" and "next-mon" both the coming Monday.
  assert.equal(set('alarm|day=fri|at=10:00|note=x', WED).at, local(2026, 10, 27, 10, 0));
  assert.equal(set('alarm|day=next-fri|at=10:00|note=x', WED).at, local(2026, 11, 4, 10, 0));
  assert.equal(set('alarm|day=mon|at=10:00|note=x', WED).at, local(2026, 10, 30, 10, 0));
  assert.equal(set('alarm|day=next-mon|at=10:00|note=x', WED).at, local(2026, 10, 30, 10, 0));
  assert.equal(set('alarm|day=wed|at=10:00|note=x', WED).at, local(2026, 11, 2, 10, 0), 'the same weekday means next week');
  // Events and a word: the time (if any) only opens the window.
  assert.deepEqual(set('alarm|on=back|note=问问今天怎么样'), { at: null, on: 'back', talk: null, note: '问问今天怎么样' });
  assert.deepEqual(set('alarm|talk=考试|note=问结果'), { at: null, on: null, talk: '考试', note: '问结果' });
  assert.equal(set('alarm|at=21:00|on=back|note=x').at, local(2026, 10, 22, 21, 0), 'a time with an event: "after nine, when he is back"');
  assert.equal(set('alarm|at=09:00|on=back|note=x').at, local(2026, 10, 22, 9, 0), 'with an event a time already past is an open window, not tomorrow');
  assert.equal(set('alarm|day=next-mon|talk=面试|note=x', WED).at, local(2026, 10, 30, 0, 0), 'a day for an event: from the start of that day');
  for (const word of ALARM_EVENTS) assert.equal(set(`alarm|on=${word}|note=x`).on, word, word);
  // Case and spaces are forgiven; the note is cleaned and cut.
  assert.equal(set(' ALARM | In=20M | Note = 好  的 ').note, '好 的');
  assert.equal(set(`alarm|in=20m|note=${'字'.repeat(200)}`).note.length, ALARM_KNOBS.noteChars);
  assert.equal(set('alarm|in=20m|note=a⟦kiss⟧b<tag>c').note, 'a kiss b tag c'.replace('tag', 'tag'), 'brackets of any marker or tag are blanked');
});

test('marker: malformed ones are dropped (null), never half-read', () => {
  const bad = [
    'alarm', 'alarm|', 'alarm|note=x', 'alarm|in=20m', 'alarm|in=20m|note=', 'alarm|in=5m|note=x', 'alarm|in=31d|note=x', 'alarm|in=20|note=x', 'alarm|in=20m|at=21:00|note=x',
    'alarm|at=25:00|note=x', 'alarm|at=9|note=x', 'alarm|day=2026-02-30|note=x', 'alarm|day=someday|note=x', 'alarm|day=2027-01-01|note=x', 'alarm|on=bogus|note=x',
    'alarm|on=back|talk=x|note=x', 'alarm|talk=|note=x', 'alarm|on=back|on=hug|note=x', 'alarm|on=back|colour=red|note=x', 'alarm|done=0', 'alarm|done=x', 'alarm|done=1|note=x',
    'alarmx|in=20m|note=x', '', 'in=20m|note=x', 'alarm|in=20m|note=x|what',
  ];
  for (const body of bad) assert.equal(parseAlarmMarker(body, NOW), null, JSON.stringify(body));
  assert.equal(parseAlarmMarker(undefined, NOW), null);
  assert.equal(parseAlarmMarker('alarm|in=20m|note=x', NaN), null);
  assert.deepEqual(parseAlarmMarker('alarm|done=2', NOW), { kind: 'drop', which: 2 });
  assert.deepEqual(parseAlarmMarker('alarm|done=ALL', NOW), { kind: 'drop', which: 'all' });
});

// ---------------------------------------------------------------- never leaks

const MARKER = `${ALARM_MARK_OPEN}alarm|in=20m|note=看看汤${ALARM_MARK_CLOSE}`;

test('an alarm marker never leaks into text: whole, split at every point, among beat markers, malformed, unclosed or over-long', () => {
  const reply = `好呀，等一下。${MARKER}⟦smile-warm⟧我记着了${MARKER}。`;
  for (let cut = 0; cut <= reply.length; cut++) {
    const filter = new SpeechBeatFilter();
    const text = filter.push(reply.slice(0, cut)).text + filter.push(reply.slice(cut)).text + filter.end().text;
    assert.equal(text, '好呀，等一下。我记着了。', `split at ${cut}`);
    assert.deepEqual(filter.summary().alarms, ['alarm|in=20m|note=看看汤', 'alarm|in=20m|note=看看汤']);
    assert.equal(filter.summary().beats.length, 1, 'the beat marker still works');
  }
  // Char by char.
  const slow = new SpeechBeatFilter();
  let out = '';
  for (const char of Array.from(reply)) out += slow.push(char).text;
  out += slow.end().text;
  assert.equal(out, '好呀，等一下。我记着了。');
  // Malformed contents are still never text (the parser then drops them).
  const junk = filterSpeechBeats(`甲${ALARM_MARK_OPEN}this is not an alarm${ALARM_MARK_CLOSE}乙${ALARM_MARK_OPEN}${ALARM_MARK_CLOSE}丙`);
  assert.equal(junk.text, '甲乙丙');
  assert.equal(parseAlarmMarker(junk.alarms![0]!, NOW), null);
  // Never closed: all of it goes, at the end of the reply.
  const open = new SpeechBeatFilter();
  const unclosed = open.push(`好的${ALARM_MARK_OPEN}alarm|in=20m|note=没写完`).text + open.end().text;
  assert.equal(unclosed, '好的');
  assert.deepEqual(open.summary().alarms, []);
  // Over-long: dropped, and what follows it up to its close with it; then the text goes on.
  const long = filterSpeechBeats(`前${ALARM_MARK_OPEN}alarm|in=20m|note=${'长'.repeat(450)}尾${ALARM_MARK_CLOSE}后`);
  assert.equal(long.text, '前后');
  assert.equal(long.alarms!.length, 0);
  // At most a few are kept; the rest are dropped, never shown.
  const many = filterSpeechBeats(MARKER.repeat(12));
  assert.equal(many.text, '');
  assert.ok(many.alarms!.length <= 8);
  assert.ok(!/alarm|⟪|⟫/u.test(many.text));
});

test('an alarm marker never leaks through the reply turn (what the bubble, voice, archive and memory see)', () => {
  const pushed: string[] = [];
  const turn = new SpeechBeatTurn(true, () => {});
  const push = turn.input<'delta'>((_type, text) => { pushed.push(text); });
  for (const piece of [`好。${ALARM_MARK_OPEN}ala`, 'rm|at=21:30|note=提醒他睡觉', `${ALARM_MARK_CLOSE}晚点见`]) push('delta', piece);
  turn.end(push);
  assert.equal(pushed.join(''), '好。晚点见');
  assert.deepEqual(turn.alarmMarkers(), ['alarm|at=21:30|note=提醒他睡觉']);
  // With the beat switch off too: the filter still takes it out.
  const off = new SpeechBeatTurn(false, () => {});
  const seen: string[] = [];
  const pushOff = off.input<'delta'>((_t, text) => { seen.push(text); });
  pushOff('delta', `嗯${MARKER}`); off.end(pushOff);
  assert.equal(seen.join(''), '嗯');
  assert.equal(ALARM_MARK_OPEN, '⟪'); assert.equal(ALARM_MARK_CLOSE, '⟫');
});

// ---------------------------------------------------------------- the words around it

test('the user\'s words that take her alarms away; going to sleep; the prompt pieces', () => {
  assert.deepEqual(parseAlarmCancel('取消她的闹钟'), { which: 'any' });
  assert.deepEqual(parseAlarmCancel('把她的闹钟都取消吧'), { which: 'all' });
  assert.deepEqual(parseAlarmCancel('她给自己留的心不要了'), { which: 'any' });
  assert.deepEqual(parseAlarmCancel('取消第二个闹钟'), { which: 2 });
  assert.deepEqual(parseAlarmCancel('取消她的提醒'), { which: 'any' });
  assert.equal(parseAlarmCancel('不用提醒了'), null, 'that one is the user\'s own reminder');
  assert.equal(parseAlarmCancel('今天的闹钟好吵'), null);
  assert.equal(parseAlarmCancel(undefined), null);
  for (const line of ['晚安', '我先睡了', '要睡了', '去睡觉了', 'good night', 'going to bed']) assert.ok(USER_SLEEP.test(line), line);
  assert.ok(!USER_SLEEP.test('睡眠质量怎么样'));
  assert.ok(isAlarmEvent('back') && !isAlarmEvent('bogus'));
  const list = alarmListLine([{ id: 'a', at: NOW + 20 * MIN, on: null, talk: null, note: '看看汤', createdAt: NOW }, { id: 'b', at: null, on: 'back', talk: null, note: '问今天', createdAt: NOW },
    { id: 'c', at: null, on: null, talk: '考试', note: '问结果', createdAt: NOW }], NOW);
  assert.match(list, /1）今天14:20「看看汤」/u); assert.match(list, /2）他回到座位时「问今天」/u); assert.match(list, /3）他说到「考试」时「问结果」/u);
  assert.equal(alarmListLine([], NOW), '');
  assert.match(alarmWokeLine('看看汤', 'time', 3), /你自己写的备注：「看看汤」.*到点了/u);
  assert.match(alarmWokeLine('问今天', 'back'), /他回到座位时已经到了/u);
  assert.match(alarmWokeLine('x', 'time', 30), /约 30 分钟/u);
});

test('her woken line is information only: no scripted reaction (I-188\'s rule)', () => {
  for (const why of ['time', 'back', 'talk', 'kiss', 'late-night'] as const) {
    const line = momentPromptLine({ kind: 'her-alarm', facts: { alarmNote: '备注', alarmWhy: why } });
    assert.ok(line.length > 0, why);
    assert.doesNotMatch(line, /可以|请|要不要|问一句|安慰|晚安|打哈欠/u, `${why}: "${line}"`);
  }
  assert.equal(momentPromptLine({ kind: 'her-alarm', facts: {} }), '');
});

// ---------------------------------------------------------------- the store

let serial = 0;
const makeStore = (dir = temp()) => new AlarmStore(() => path.join(dir, 'reminders.json'), undefined, undefined, () => `a${++serial}`);
const SPEC = { at: null, on: null, talk: null, note: '备注' } as const;

test('store: at most five waiting per character; each one fires at most once; expiry (time late, event 3 days)', async () => {
  const store = makeStore(); await store.load();
  for (let i = 0; i < ALARM_KNOBS.perCharacter; i++) assert.ok(store.addHer('gene', { ...SPEC, at: NOW + (10 + i) * MIN }, NOW), `#${i}`);
  assert.equal(store.addHer('gene', { ...SPEC, at: NOW + 60 * MIN }, NOW), null, 'the sixth');
  assert.ok(store.addHer('other', { ...SPEC, at: NOW + 60 * MIN }, NOW), 'another character has her own five');
  assert.equal(store.views('gene', NOW).length, 5);
  // A time alarm fires when its time comes, then never again.
  assert.equal(store.dueHer('gene', NOW + 5 * MIN).item, null);
  const first = store.dueHer('gene', NOW + 10 * MIN).item!;
  assert.equal(first.what, '备注');
  assert.equal(store.fired(first.id, NOW + 10 * MIN), true);
  assert.equal(store.fired(first.id, NOW + 11 * MIN), false, 'once');
  assert.equal(store.dueHer('gene', NOW + 10 * MIN).item, null, 'a fired one is not due again');
  // The user's own reminders never see hers (and the other way round).
  assert.equal(store.waiting('gene').length, 0);
  assert.equal(store.due('gene', NOW + 11 * MIN).item, null);
  // Given up: a time alarm lateHours after its time; an event alarm eventExpiryDays after it could start.
  const late = store.dueHer('gene', NOW + 14 * MIN + ALARM_KNOBS.lateHours * 3_600_000 + 1);
  assert.equal(late.item, null); assert.ok(late.gaveUp >= 1);
  const event = makeStore(); await event.load();
  event.addHer('gene', { ...SPEC, on: 'back' }, NOW);
  assert.equal(event.views('gene', NOW + 2.9 * 86_400_000).length, 1);
  assert.equal(event.views('gene', NOW + 3.01 * 86_400_000).length, 0, 'event alarms expire after 3 days');
  const talk = makeStore(); await talk.load();
  talk.addHer('gene', { ...SPEC, talk: '考试' }, NOW);
  assert.equal(talk.views('gene', NOW + 3.01 * 86_400_000).length, 0);
});

test('store: an event arms only its own alarm, only when its window is open; it survives a restart; a word or "going to sleep" wakes in chat once', async () => {
  const dir = temp();
  const store = makeStore(dir); await store.load();
  store.addHer('gene', { ...SPEC, on: 'back' }, NOW);
  store.addHer('gene', { ...SPEC, on: 'hug', at: NOW + 60 * MIN }, NOW);
  store.addHer('gene', { ...SPEC, talk: '考试', note: '问考试' }, NOW);
  store.addHer('gene', { ...SPEC, on: 'user-sleep', note: '说晚安' }, NOW);
  assert.equal(store.event('gene', 'kiss', NOW), 0);
  assert.equal(store.event('gene', 'hug', NOW), 0, 'its time window has not opened');
  assert.equal(store.dueHer('gene', NOW).item, null, 'not armed yet');
  assert.equal(store.event('gene', 'back', NOW), 1);
  assert.equal(store.event('gene', 'back', NOW), 0, 'armed once');
  await store.flush();
  const again = makeStore(dir); await again.load();
  assert.equal(again.dueHer('gene', NOW).item?.on, 'back', 'armed state survives a restart');
  assert.equal(again.event('gene', 'hug', NOW + 61 * MIN), 1, 'after the window opens');
  // Words in chat: they wake in this turn and are fired at once.
  assert.deepEqual(again.textHits('gene', '今天没什么事', NOW), []);
  const hits = again.textHits('gene', '我明天要考试了好紧张', NOW);
  assert.equal(hits.length, 1); assert.equal(hits[0]!.why, 'talk'); assert.equal(hits[0]!.item.what, '问考试');
  assert.deepEqual(again.textHits('gene', '考试考试', NOW), [], 'once');
  assert.equal(again.textHits('gene', '我去睡觉了，晚安', NOW)[0]?.why, 'user-sleep');
  assert.equal(again.textHits('other', '考试', NOW).length, 0, 'never another character\'s');
});

test('store: cancelling one, all, or the only one; "which" out of range or with several waiting takes nothing', async () => {
  const store = makeStore(); await store.load();
  store.addHer('gene', { ...SPEC, at: NOW + 20 * MIN, note: '一' }, NOW);
  assert.equal(store.dropHer('gene', 'any', NOW).dropped.length, 1, 'the only one');
  store.addHer('gene', { ...SPEC, at: NOW + 20 * MIN, note: '一' }, NOW + 1);
  store.addHer('gene', { ...SPEC, at: NOW + 30 * MIN, note: '二' }, NOW + 2);
  const unclear = store.dropHer('gene', 'any', NOW + 3);
  assert.deepEqual([unclear.dropped.length, unclear.ambiguous, unclear.count], [0, true, 2]);
  assert.equal(store.dropHer('gene', 9, NOW + 3).dropped.length, 0);
  assert.equal(store.dropHer('gene', 2, NOW + 3).dropped[0]?.what, '二');
  assert.equal(store.dropHer('gene', 'all', NOW + 3).dropped.length, 1);
  assert.equal(store.views('gene', NOW + 3).length, 0);
  // A cancelled one never wakes.
  assert.equal(store.dueHer('gene', NOW + 60 * MIN).item, null);
});

// ---------------------------------------------------------------- the host: the switch, the turn, the grey line

function alarmsRig(on: { value: boolean }, now = { value: NOW }, rows: MomentJournalRow[] = []) {
  const store = makeStore();
  const alarms = new HerAlarms({ store, characterId: () => 'gene', on: () => on.value, clock: () => now.value, journal: row => { rows.push(row); } });
  return { store, alarms, now, rows };
}

test('switch off = nothing: no sentence, no marker read, no event, nothing fires; what is kept stays dormant and can be cancelled', async () => {
  const on = { value: false };
  const r = alarmsRig(on); await r.store.load();
  assert.equal(r.alarms.chatTurn('取消她的闹钟 考试 晚安'), '', 'not one character added to her prompt');
  assert.equal(r.alarms.takeMarkers(['alarm|in=20m|note=x']), false);
  assert.equal(r.store.views('gene', NOW).length, 0, 'nothing stored');
  // Something kept while it was on:
  on.value = true;
  assert.equal(r.alarms.takeMarkers(['alarm|in=10m|note=x', 'alarm|on=back|note=y']), true);
  on.value = false;
  r.alarms.event('back'); r.alarms.tick(true, NOW + 999 * MIN * 60);
  assert.equal(r.store.dueHer('gene', NOW + 11 * MIN).item?.what, 'x', 'the store itself still knows (dormant)');
  r.now.value = NOW + 11 * MIN;
  assert.equal(r.alarms.due('gene', NOW + 11 * MIN), null, 'switch off: nothing wakes');
  assert.equal(r.alarms.keep('gene', 'a1', NOW + 11 * MIN), null);
  assert.equal(r.alarms.list().on, false); assert.equal(r.alarms.list().items.length, 2, 'the page still lists them');
  assert.equal(r.alarms.cancel('all').items.length, 0, 'and can take them away');
  assert.equal(r.alarms.chatTurn('取消她的闹钟 考试 晚安'), '', 'still nothing in her prompt');
});

test('switch on: the chat turn adds the sentence always, her list only when she has any, a woken word, and the cancel confirmation', async () => {
  const on = { value: true };
  const r = alarmsRig(on); await r.store.load();
  const bare = r.alarms.chatTurn('你好');
  assert.equal(bare, alarmSentence(), 'nothing waiting: just the one sentence');
  assert.equal(r.alarms.takeMarkers(['alarm|in=20m|note=看汤', 'alarm|talk=考试|note=问结果', 'alarm|on=back|note=三', 'junk']), true, 'two per reply: the third is not kept');
  assert.equal(r.store.views('gene', NOW).length, 2);
  const withList = r.alarms.chatTurn('你好');
  assert.match(withList, /^你给自己留着的心（还没到，备注是你自己写的）：1）今天14:20「看汤」；2）他说到「考试」时「问结果」/u);
  assert.ok(withList.endsWith(alarmSentence()));
  const woken = r.alarms.chatTurn('我下周要考试了');
  assert.match(woken, /你之前给自己留了个心（你自己写的备注：「问结果」），现在用户说到了你等的那个词/u);
  assert.doesNotMatch(r.alarms.chatTurn('考试'), /问结果/u, 'a word wakes once');
  assert.match(r.alarms.chatTurn('取消她的闹钟'), /已经取消了 1 个/u);
  assert.equal(r.store.views('gene', NOW).length, 0);
  assert.match(r.alarms.chatTurn('取消她的闹钟'), /现在没有留着的/u);
  r.alarms.takeMarkers(['alarm|in=20m|note=一']); r.alarms.takeMarkers(['alarm|in=30m|note=二']);
  assert.match(r.alarms.chatTurn('取消她的闹钟'), /留着 2 个，没说是哪一个/u);
  assert.equal(r.store.views('gene', NOW).length, 2, 'unclear: nothing taken');
  assert.match(r.alarms.chatTurn('取消第一个闹钟'), /已经取消了 1 个/u);
  assert.match(r.alarms.chatTurn('把她的闹钟都取消'), /已经取消了 1 个/u);
  assert.equal(r.store.views('gene', NOW).length, 0);
  assert.equal(ALARM_GREY_LINE, '（她记了件事）', 'the grey line never carries the content');
  // Her own "done" marker takes the numbered one away.
  r.alarms.takeMarkers(['alarm|in=20m|note=一', 'alarm|day=next-mon|note=二']);
  r.alarms.takeMarkers(['alarm|done=1']);
  assert.deepEqual(r.store.views('gene', NOW).map(v => v.note), ['二']);
  // The journal keeps closed words only, never her note.
  assert.ok(r.rows.length > 0);
  for (const row of r.rows) assert.doesNotMatch(JSON.stringify(row), /看汤|问结果|备注|考试/u);
});

test('the profile page: list with cancel by id, cancel all; the switch file: default off, only the user\'s click turns it on, the test hook only on', async () => {
  const on = { value: true };
  const r = alarmsRig(on); await r.store.load();
  r.alarms.takeMarkers(['alarm|in=20m|note=一', 'alarm|in=30m|note=二']);
  const ids = r.alarms.list().items.map(item => item.id);
  assert.equal(r.alarms.cancel(ids[0]!).items.length, 1);
  assert.equal(r.alarms.cancel('nope').items.length, 1, 'an unknown id changes nothing');
  assert.equal(r.alarms.cancel('all').items.length, 0);
  const dir = temp(), file = path.join(dir, 'her-alarms.json');
  const writes: string[] = [];
  const hook = { value: false };
  const sw = new AlarmSwitch(() => file, async (_f, text) => { writes.push(text); }, () => hook.value);
  assert.equal(sw.on, false, 'default off');
  assert.equal(await sw.set(true), true);
  assert.equal(sw.on, true);
  assert.deepEqual(JSON.parse(writes[0]!), { version: 1, on: true });
  const fresh = new AlarmSwitch(() => file, undefined, () => hook.value);
  assert.equal(fresh.on, false, 'nothing on disk (the fake writer): off');
  hook.value = true;
  assert.equal(fresh.on, true, 'the throw-away profile\'s flag');
  assert.equal(writes.length, 1, 'the flag writes nothing');
  const real = new AlarmSwitch(() => path.join(dir, 'real.json'));
  await real.set(true);
  assert.equal(new AlarmSwitch(() => path.join(dir, 'real.json')).on, true, 'a saved choice survives a restart');
  assert.equal(new AlarmSwitch(() => path.join(dir, 'missing.json')).on, false);
});

// ---------------------------------------------------------------- the moments path

interface Rig {
  host: MomentHost; alarms: HerAlarms; store: AlarmStore; on: { value: boolean }; asks: string[]; cues: string[]; journal: MomentJournalRow[];
  state: { now: number; typing: boolean; presence: PresenceView | null; outcome: 'inner' | 'quiet' | 'budget' | 'held'; recent: { kind: string }[]; idle: number | null; screen: { event: 'error' | 'loading'; at: number; describedAt: number } | null; watching: boolean };
}
async function momentRig(): Promise<Rig> {
  const dir = temp();
  const state: Rig['state'] = { now: NOW, typing: false, presence: null, outcome: 'inner', recent: [], idle: 5, screen: null, watching: false };
  const asks: string[] = [], cues: string[] = [], journal: MomentJournalRow[] = [];
  const on = { value: true };
  const store = makeStore(dir);
  const alarms = new HerAlarms({ store, characterId: () => 'gene', on: () => on.value, clock: () => state.now, journal: row => { journal.push(row); } });
  const ports: MomentHostPorts = {
    clock: () => state.now, random: () => 0, createId: () => `m${++serial}`, characterId: () => 'gene', localMinute: minuteOf, enabled: () => true, typing: () => state.typing, call: () => false,
    asleep: () => false, visible: () => true, presence: () => state.presence, idleSeconds: () => state.idle, lastInteractionAt: () => state.now - 60 * MIN,
    nightKey: n => eveningNightKey(n, minuteOf(n)), restUsed: () => false, state: new MomentStateStore(() => path.join(dir, 'moments-state.json')), reminders: store, alarms,
    closeMoments: () => state.recent, watching: () => state.watching, screen: () => state.screen,
    askSpeech: mode => { asks.push(mode); const cue = { id: `cue${asks.length}`, kind: 'speech' }; const claim = host.claims(cue); if (claim) { cues.push(cue.id); claim.put(state.outcome); } return true; },
    journal: row => { journal.push(row); },
  };
  const host = new MomentHost(ports);
  await ports.state.load(); await store.load();
  return { host, alarms, store, on, asks, cues, journal, state };
}

test('a time alarm wakes through the moments path at its time, once: the information line, the same gates, fired when delivered', async () => {
  const r = await momentRig();
  r.alarms.takeMarkers(['alarm|in=20m|note=看看汤']);
  r.host.tick(); assert.equal(r.asks.length, 0, 'not yet');
  r.state.now += 20 * MIN; r.state.typing = true;
  for (let i = 0; i < 3; i++) { r.host.tick(); r.state.now += 15_000; }
  assert.equal(r.asks.length, 0, 'typing: the one gate holds it');
  r.state.typing = false; r.host.tick();
  assert.deepEqual(r.asks, ['capped'], 'the welcome rules (not a promise to the user)');
  assert.equal(r.host.view()?.kind, 'her-alarm');
  assert.match(r.host.promptLine('gene'), /你之前给自己留了个心（你自己写的备注：「看看汤」），现在到点了/u);
  r.host.done('cue1', true);
  assert.deepEqual(r.journal.at(-1), { characterId: 'gene', kind: 'her-alarm', outcome: 'spoke' });
  for (let i = 0; i < 10; i++) { r.state.now += 60_000; r.host.tick(); }
  assert.equal(r.asks.length, 1, 'an alarm fires at most once');
  assert.equal(r.store.views('gene', r.state.now).length, 0);
});

test('an alarm fires at most once even when told delivered twice or after a restart', async () => {
  const r = await momentRig();
  r.alarms.takeMarkers(['alarm|in=10m|note=x']);
  r.state.now += 10 * MIN; r.host.tick();
  const id = r.store.views('gene', r.state.now)[0]!.id;
  r.host.done('cue1', true); r.host.done('cue1', true);
  assert.equal(r.store.fired(id, r.state.now), false);
  await r.store.flush();
  const dir = path.dirname((r.store as unknown as { file: () => string }).file());
  const again = new AlarmStore(() => path.join(dir, 'reminders.json')); await again.load();
  assert.equal(again.dueHer('gene', r.state.now + MIN).item, null, 'a restart does not bring it back');
});

test('an event alarm waits for its event: a return arms it, a kiss arms another; not before; with the switch off nothing fires', async () => {
  const r = await momentRig();
  r.alarms.takeMarkers(['alarm|on=back|note=问今天', 'alarm|at=15:00|on=hug|note=抱一下']);
  for (let i = 0; i < 5; i++) { r.state.now += 15_000; r.host.tick(); }
  assert.equal(r.asks.length, 0, 'no event yet');
  r.state.presence = { presence: 'back', awayMinutes: 20, interrupt: 'no', source: 'input' } as PresenceView;
  r.state.now += 15_000; r.host.tick();
  assert.equal(r.host.view()?.kind, 'her-alarm');
  assert.match(r.host.promptLine('gene'), /问今天.*他回到座位时已经到了/u);
  r.host.done('cue1', true);
  // A hug before the window opens (15:00) does not count; after it does. The first look only takes stock of older ones.
  r.state.recent = [{ kind: 'hug' }];
  r.state.now += 15_000; r.host.tick();
  r.state.recent = [...r.state.recent, { kind: 'hug' }];
  r.state.now += 15_000; r.host.tick();
  assert.equal(r.asks.length, 1, 'window (15:00) not open yet');
  r.state.now = local(2026, 10, 22, 15, 5);
  r.state.recent = [...r.state.recent, { kind: 'hug' }];
  r.host.tick();
  assert.equal(r.host.view()?.kind, 'her-alarm');
  assert.match(r.host.promptLine('gene'), /抱一下.*亲亲|抱一下.*抱抱时已经到了/u);
  // Off while waiting: the pending one is dropped with 'switch', nothing more asks.
  r.on.value = false;
  r.state.now += 15_000; r.host.tick();
  assert.equal(r.host.view(), null);
  assert.equal(r.journal.at(-1)?.why, 'switch');
  const asked = r.asks.length;
  r.state.now += 10 * MIN; r.host.tick();
  assert.equal(r.asks.length, asked, 'with the switch off nothing fires');
});

test('"sitting too long" and a screen event are events her alarms can wait for; cancel while one is pending ends it', async () => {
  const r = await momentRig();
  r.alarms.takeMarkers(['alarm|on=sitting|note=歇一歇', 'alarm|on=video-end|note=问视频']);
  r.state.watching = true; r.state.idle = 5;
  for (let t = 0; t < ALARM_KNOBS.sittingMinutes + 2; t++) { r.state.now += MIN; r.host.tick(); }
  assert.equal(r.host.view()?.kind, 'her-alarm');
  assert.match(r.host.promptLine('gene'), /歇一歇.*他坐很久时已经到了/u);
  // Cancel while it waits for an opportunity: it ends, never speaks.
  r.alarms.cancel('all');
  r.state.now += 15_000 * 2; r.host.tick();
  assert.equal(r.host.view()?.kind === 'her-alarm', false);
});

test('a screen event word arms "video-end"', async () => {
  const r = await momentRig();
  r.alarms.takeMarkers(['alarm|on=video-end|note=问视频']);
  r.state.watching = true;
  r.state.screen = { event: 'error', at: r.state.now, describedAt: r.state.now };
  r.host.tick(); // an error is not what she waits for (but is its own moment)
  assert.notEqual(r.store.dueHer('gene', r.state.now).item?.on, 'video-end');
  assert.ok(isAlarmEvent('video-end'));
});

test('prompt size: the per-turn addition is short, and only with the switch on', () => {
  const sentence = alarmSentence();
  assert.ok(Array.from(sentence).length <= 340, `the marker sentence is ${Array.from(sentence).length} characters`);
  const list = alarmListLine([{ id: 'a', at: NOW + 20 * MIN, on: null, talk: null, note: '字'.repeat(60), createdAt: NOW }], NOW);
  assert.ok(Array.from(list).length <= 120, `one listed alarm is ${Array.from(list).length} characters`);
});
