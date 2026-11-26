/**
 * I-188 她认出的时刻:
 * the local recognisers (fake clocks and readings), the one gate (typing, call, asleep, hidden, away), caps and cooldowns, the journal
 * lines, the reminder store (parse → fire once → survives a restart → cancel), the opening choice's moment branch (budget, presence) and
 * the inner loop's focus 'moment' (the proactive speech gate, quiet hours, the rest reminder's night). Made-up lines only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clockWords, eveningMinute, eveningNightKey, lateNight, noteNightActivity, usualBedtime } from '../shared/behaviors/moments/bedtime';
import { momentGate, SCREEN_EVENTS, type MomentKind } from '../shared/behaviors/moments/interface';
import { MOMENT_KNOBS } from '../shared/behaviors/moments/knobs';
import { momentPromptLine } from '../shared/behaviors/moments/prompt';
import { backAtSeat, firstToday, FullscreenTracker, momentDayKey, screenMoment } from '../shared/behaviors/moments/recognise';
import { WATCH_FRAME_EVENTS, parseFrameReply, WATCH_FRAME_SYSTEM_PROMPT } from '../shared/behaviors/watch-timeline/prompts';
import { MomentHost, type MomentHostPorts, type MomentJournalRow } from '../electron/initiative/moments/host';
import { MomentStateStore } from '../electron/initiative/moments/state-store';
import { ReminderStore } from '../electron/initiative/moments/reminder-store';
import { ProactiveSpeechGate } from '../electron/initiative/proactive-speech-gate';
import { InnerLoop, type InnerLoopDependencies, type InnerLoopMessage } from '../electron/initiative/inner-loop/inner-loop';
import { OpeningHost } from '../electron/brain/opening-host';
import { FixedOpeningChoice } from '../shared/behaviors/opening-choice/fake';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot, type MoodCue } from '../shared/foundation/mood';
import { buildInnerLoopPrompt, type InnerLoopQuiet } from '../shared/initiative/inner-loop';
import type { MoodView } from '../shared/mood/mood-runtime';
import { buildJournalEntry } from '../shared/memory/journal';
import type { PresenceView } from '../shared/senses';

const temps: string[] = [];
test.after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'sh-i188-')); temps.push(dir); return dir; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const local = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m, d, h, mi).getTime();
const minuteOf = (ms: number) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };

// ---------------------------------------------------------------- pure recognisers

test('#4 bedtime: the median of earlier nights (tonight never counts), clamped; the fallback with too few nights', () => {
  assert.deepEqual(usualBedtime({}, '2026-11-22'), { minute: MOMENT_KNOBS.lateNight.fallbackBedMinute, nights: 0 });
  // 23:30, 00:00, 00:30, 01:00, 05:00 (one all-nighter) → median 00:30
  const nights = { '2026-11-15': eveningMinute(23 * 60 + 30), '2026-11-16': eveningMinute(0), '2026-11-17': eveningMinute(30), '2026-11-18': eveningMinute(60),
    '2026-11-19': eveningMinute(300), '2026-11-22': eveningMinute(240) };
  assert.deepEqual(usualBedtime(nights, '2026-11-22'), { minute: 30, nights: 5 });
  const early = { '2026-11-15': eveningMinute(20 * 60), '2026-11-16': eveningMinute(20 * 60 + 10), '2026-11-17': eveningMinute(20 * 60 + 20) };
  assert.equal(usualBedtime(early, '2026-11-22').minute, MOMENT_KNOBS.lateNight.earliestBedMinute, 'clamped to 21:30');
  assert.equal(clockWords(-150), '21:30');
});

test('#4 nightly activity: only night minutes, the latest wins, old nights drop out', () => {
  let nights = noteNightActivity({}, '2026-11-21', 23 * 60);
  nights = noteNightActivity(nights, '2026-11-21', 22 * 60);
  assert.equal(nights['2026-11-21'], eveningMinute(23 * 60));
  assert.equal(noteNightActivity(nights, '2026-11-21', 15 * 60), nights, 'an afternoon minute is not a night');
  for (let d = 1; d <= 30; d++) nights = noteNightActivity(nights, `2026-10-${String(d).padStart(2, '0')}`, 23 * 60);
  assert.equal(Object.keys(nights).length, MOMENT_KNOBS.lateNight.keepNights);
  // The night key: noon to noon.
  assert.equal(eveningNightKey(local(2026, 10, 23, 1, 30), 90), '2026-11-22');
  assert.equal(eveningNightKey(local(2026, 10, 22, 23, 0), 23 * 60), '2026-11-22');
});

test('#4 late night: only active, at least the margin past the usual bedtime, never after the last minute', () => {
  const bed = { minute: 30, nights: 5 };
  assert.equal(lateNight({ localMinute: 60, active: true, bed }), null, '00:30 + 30 min < margin');
  assert.deepEqual(lateNight({ localMinute: 90, active: true, bed }), { bedMinute: 30, nowMinute: 90, nights: 5 });
  assert.equal(lateNight({ localMinute: 90, active: false, bed }), null, 'not at the computer');
  assert.equal(lateNight({ localMinute: 6 * 60, active: true, bed }), null, 'morning');
  assert.equal(lateNight({ localMinute: 23 * 60 + 30, active: true, bed: { minute: -90, nights: 3 } })?.nowMinute, -30, 'an early sleeper: 23:30 is late');
});

test('#9 screen: closed events while young; loading only becomes "stuck" when it stays the newest frame', () => {
  assert.deepEqual([...SCREEN_EVENTS], [...WATCH_FRAME_EVENTS], 'the describer and the moments use the same closed list');
  assert.deepEqual(screenMoment({ event: 'error', at: 1000, describedAt: 1000 }, 50_000), { event: 'error', at: 1000 });
  assert.equal(screenMoment({ event: 'error', at: 1000, describedAt: 1000 }, 1000 + 91_000), null, 'too old');
  assert.equal(screenMoment({ event: 'loading', at: 1000, describedAt: 1000 }, 30_000), null, 'not long enough');
  assert.deepEqual(screenMoment({ event: 'loading', at: 1000, describedAt: 1000 }, 1000 + 95_000), { event: 'stuck', at: 1000 });
  assert.equal(screenMoment({ event: 'loading', at: 1000, describedAt: 40_000 }, 1000 + 95_000), null, 'the screen moved on');
  const reply = parseFrameReply('{"description":"一个窗口","keywords":[],"event":"error"}');
  assert.equal(reply?.event, 'error');
  assert.equal(parseFrameReply('{"description":"x","keywords":[],"event":"explode"}')?.event, null, 'an unknown word is not an event');
  assert.match(WATCH_FRAME_SYSTEM_PROMPT, /event 字段/u);
});

test('#18 full screen: ends after the minimum → minutes; short or outside Unbound → nothing', () => {
  const t = new FullscreenTracker();
  assert.equal(t.update({ unbound: true, fullscreen: true }, 0), null);
  assert.equal(t.update({ unbound: true, fullscreen: false }, 60_000), null, 'one minute is too short');
  t.update({ unbound: true, fullscreen: true }, 100_000);
  assert.equal(Math.round(t.update({ unbound: true, fullscreen: false }, 100_000 + 5 * 60_000)!), 5);
  t.update({ unbound: true, fullscreen: true }, 1_000_000);
  assert.equal(t.update(null, 2_000_000), null, 'leaving Unbound forgets it');
  assert.equal(t.update({ unbound: true, fullscreen: false }, 2_100_000), null);
});

test('#2 first today and #3 back at the seat', () => {
  const base = { active: true, lastInteractionAt: null, now: 0, weekday: 6, lastNight: '2026-11-21', nights: { '2026-11-21': eveningMinute(180) }, bedMinute: 30 };
  assert.deepEqual(firstToday({ ...base, back: 9 * 60 }), { awayMinutes: 540, weekend: true, lateLastNight: true });
  assert.equal(firstToday({ ...base, back: 30, active: false }), null, 'back after 30 minutes is not a new day');
  assert.equal(momentDayKey(local(2026, 10, 23, 3, 0), 180), '2026-11-22', '03:00 still belongs to yesterday');
  assert.equal(backAtSeat(4), false); assert.equal(backAtSeat(12), true); assert.equal(backAtSeat(45), false); assert.equal(backAtSeat(null), false);
});

test('the moment lines are information only: facts, no prescribed reaction', () => {
  const lines: [MomentKind, string][] = [
    ['late-night', momentPromptLine({ kind: 'late-night', facts: { bedMinute: 30, nowMinute: 95, nights: 6 } })],
    ['screen', momentPromptLine({ kind: 'screen', facts: { screen: 'error' } })],
    ['reminder', momentPromptLine({ kind: 'reminder', facts: { what: '交报告', dueAt: local(2026, 10, 23, 8), lateMinutes: 0, guessed: true } })],
    ['fullscreen-back', momentPromptLine({ kind: 'fullscreen-back', facts: { fullscreenMinutes: 42, screen: 'win' } })],
    ['first-today', momentPromptLine({ kind: 'first-today', facts: { awayMinutes: 600, weekend: true } })],
    ['back', momentPromptLine({ kind: 'back', facts: { awayMinutes: 25 } })],
    ['goodnight', momentPromptLine({ kind: 'goodnight', facts: {} })],
  ];
  for (const [kind, line] of lines) {
    assert.ok(line.length > 0, kind);
    assert.doesNotMatch(line, /可以|请选|提醒早点睡|要不要|问一句|安慰|高兴|晚安|打哈欠/u, `${kind}: no scripted reaction in "${line}"`);
  }
  assert.match(lines[0][1], /01:35/u); assert.match(lines[0][1], /00:30/u);
  assert.match(lines[2][1], /交报告/u); assert.match(lines[2][1], /08:00/u);
  assert.equal(momentPromptLine({ kind: 'reminder', facts: { what: '' } }), '');
});

test('the one gate: switch, typing, call, asleep, hidden, away', () => {
  const open = { enabled: true, typing: false, call: false, away: false, asleep: false, visible: true };
  assert.equal(momentGate(open), null);
  assert.equal(momentGate({ ...open, typing: true }), 'typing');
  assert.equal(momentGate({ ...open, call: true }), 'call');
  assert.equal(momentGate({ ...open, asleep: true }), 'asleep');
  assert.equal(momentGate({ ...open, visible: false }), 'hidden');
  assert.equal(momentGate({ ...open, away: true }), 'away');
  assert.equal(momentGate({ ...open, enabled: false }), 'switch');
});

// ---------------------------------------------------------------- the host

interface Rig {
  host: MomentHost; ports: MomentHostPorts; state: { now: number; typing: boolean; call: boolean; asleep: boolean; visible: boolean; idle: number | null;
    presence: PresenceView | null; watching: boolean; screenReads: number; screen: { event: 'error' | 'loading'; at: number; describedAt: number } | null;
    unbound: { unbound: boolean; fullscreen: boolean } | null; drowsy: boolean; restUsed: boolean; outcome: 'inner' | 'quiet' | 'budget' | 'held'; random: number };
  asks: string[]; journal: MomentJournalRow[]; cues: string[];
}
function rig(dir = temp(), now = local(2026, 10, 22, 14, 0), store?: ReminderStore): Rig {
  const state: Rig['state'] = { now, typing: false, call: false, asleep: false, visible: true, idle: 5, presence: null, watching: false, screenReads: 0, screen: null,
    unbound: null, drowsy: false, restUsed: false, outcome: 'inner', random: 0 };
  const asks: string[] = [], journal: MomentJournalRow[] = [], cues: string[] = [];
  let serial = 0;
  const moments = new MomentStateStore(() => path.join(dir, 'moments-state.json'));
  const reminders = store ?? new ReminderStore(() => path.join(dir, 'reminders.json'), undefined, undefined, () => `r${++serial}`);
  const ports: MomentHostPorts = {
    clock: () => state.now, random: () => state.random, createId: () => `m${++serial}`,
    characterId: () => 'gene', localMinute: minuteOf, enabled: () => true, typing: () => state.typing, call: () => state.call, asleep: () => state.asleep,
    visible: () => state.visible, presence: () => state.presence, idleSeconds: () => state.idle, lastInteractionAt: () => state.now - 60 * 60_000,
    nightKey: n => eveningNightKey(n, minuteOf(n)), restUsed: () => state.restUsed, state: moments, reminders,
    // The mood clock makes a cue at once and the opening choice claims it within the same call (as electron/mood/mood.ts does).
    askSpeech: mode => { asks.push(mode); const cue = { id: `cue${asks.length}`, kind: 'speech' }; const claim = host.claims(cue); if (claim) { cues.push(cue.id); claim.put(state.outcome); } return true; },
    watching: () => state.watching, screen: () => { state.screenReads++; return state.screen; }, unbound: () => state.unbound, drowsy: () => state.drowsy,
    journal: row => { journal.push(row); },
  };
  const host = new MomentHost(ports);
  return { host, ports, state, asks, journal, cues };
}
async function ready(r: Rig) { await r.ports.state.load(); await r.ports.reminders!.load(); }

test('host #4: past the usual bedtime → one speech opportunity a night; done → one journal line; never twice the same night', async () => {
  const r = rig(undefined, local(2026, 10, 23, 1, 40));
  await ready(r);
  r.host.tick();
  assert.deepEqual(r.asks, ['capped'], 'the welcome rules (interval, hourly cap)');
  assert.equal(r.host.view()?.kind, 'late-night');
  assert.deepEqual(r.host.current('gene'), { kind: 'late-night', quietOk: true, night: '2026-11-22' });
  assert.match(r.host.promptLine('gene'), /^现在 01:40/u);
  r.host.done('cue1', true);
  assert.deepEqual(r.journal.at(-1), { characterId: 'gene', kind: 'late-night', outcome: 'spoke' });
  r.state.now += 30 * 60_000;
  r.host.tick();
  assert.equal(r.asks.length, 1, 'once a night');
  // A new rig on the same profile: the night is remembered across a restart.
  await r.ports.state.flush();
  const again = rig(path.dirname((r.ports.state as unknown as { file: () => string }).file()), r.state.now);
  await ready(again); again.host.tick();
  assert.equal(again.asks.length, 0, 'restart: still once a night');
});

test('host #4: the old rest reminder already spent tonight → no late-night moment', async () => {
  const r = rig(undefined, local(2026, 10, 23, 1, 40));
  await ready(r); r.state.restUsed = true; r.host.tick();
  assert.equal(r.asks.length, 0);
});

test('host: never asks while typing, in a call, asleep or hidden; the moment expires with why', async () => {
  for (const block of ['typing', 'call', 'asleep', 'visible'] as const) {
    const r = rig(undefined, local(2026, 10, 23, 1, 40));
    await ready(r);
    if (block === 'visible') r.state.visible = false; else r.state[block] = true;
    for (let i = 0; i < 20; i++) { r.host.tick(); r.state.now += 15_000; }
    assert.equal(r.asks.length, 0, `${block}: never asked`);
    assert.equal(r.journal.at(-1)?.outcome, 'expired');
    assert.equal(r.journal.at(-1)?.why, block === 'visible' ? 'hidden' : block);
  }
  const meeting = rig(undefined, local(2026, 10, 23, 1, 40));
  await ready(meeting);
  meeting.state.presence = { presence: 'meeting', interrupt: 'no', source: 'input' } as PresenceView;
  meeting.host.tick();
  assert.equal(meeting.asks.length, 0, 'a call on the computer (meeting) counts as a call');
});

test('host: the budget says no → quiet, not retried; refused → retried later', async () => {
  const r = rig(undefined, local(2026, 10, 23, 1, 40));
  await ready(r); r.state.outcome = 'budget'; r.host.tick();
  assert.deepEqual(r.journal.at(-1), { characterId: 'gene', kind: 'late-night', outcome: 'quiet', why: 'budget' });
  const s = rig(undefined, local(2026, 10, 23, 1, 40));
  await ready(s); s.state.outcome = 'quiet'; s.host.tick();
  assert.equal(s.host.view()?.why, 'refused');
  s.state.outcome = 'inner'; s.state.now += 16_000; s.host.tick();
  assert.equal(s.asks.length, 2); assert.equal(s.host.view()?.phase, 'offered');
});

test('host #9: screen events only while watching together (never read otherwise); cooldown and daily cap', async () => {
  const r = rig();
  await ready(r);
  r.state.screen = { event: 'error', at: r.state.now - 5_000, describedAt: r.state.now - 5_000 };
  r.host.tick();
  assert.equal(r.state.screenReads, 0, 'not watching: the screen is not read at all');
  assert.equal(r.asks.length, 0);
  r.state.watching = true; r.host.tick();
  assert.equal(r.host.view()?.kind, 'screen');
  assert.match(r.host.promptLine('gene'), /报错/u);
  r.host.done('cue1', true);
  r.state.now += 60_000; r.state.screen = { event: 'error', at: r.state.now - 1_000, describedAt: r.state.now - 1_000 };
  r.host.tick();
  assert.deepEqual(r.journal.at(-1), { characterId: 'gene', kind: 'screen', outcome: 'skipped', why: 'cooldown', screen: 'error' });
  r.host.tick();
  assert.equal(r.asks.length, 1, 'the same event is not counted again');
});

test('host #18: out of full screen in Unbound → one opportunity, with what was seen only while watching together', async () => {
  const r = rig();
  await ready(r);
  r.state.unbound = { unbound: true, fullscreen: true }; r.host.tick();
  r.state.now += 10 * 60_000; r.state.unbound = { unbound: true, fullscreen: false }; r.host.tick();
  assert.equal(r.host.view()?.kind, 'fullscreen-back');
  assert.match(r.host.promptLine('gene'), /约 10 分钟/u);
  assert.doesNotMatch(r.host.promptLine('gene'), /屏幕上/u, 'not watching: nothing about the screen');
});

test('host #13: a reminder set in chat fires at its time once (promise rules), survives a restart, and can be cancelled', async () => {
  const dir = temp();
  const r = rig(dir);
  await ready(r);
  assert.match(r.host.chatTurn('十分钟后提醒我关火'), /14:10 提醒用户「关火」/u);
  assert.deepEqual(r.journal.at(-1), { characterId: 'gene', kind: 'reminder', outcome: 'set' });
  r.host.tick(); assert.equal(r.asks.length, 0, 'not yet');
  r.state.now += 10 * 60_000; r.host.tick();
  assert.deepEqual(r.asks, ['promise'], 'a promise: only the hard state, no interval or budget');
  assert.match(r.host.promptLine('gene'), /关火/u);
  r.host.done('cue1', true);
  await r.ports.reminders!.flush();
  r.state.now += 60_000; r.host.tick();
  assert.equal(r.asks.length, 1, 'never twice');
  const restarted = rig(dir, r.state.now);
  await ready(restarted); restarted.host.tick();
  assert.equal(restarted.asks.length, 0, 'a restart does not bring it back');
  // Cancel: "不用提醒了" cancels the newest waiting one.
  assert.match(restarted.host.chatTurn('明天早上八点提醒我交报告'), /提醒用户「交报告」/u);
  assert.match(restarted.host.chatTurn('不用提醒了'), /取消了「交报告」/u);
  assert.equal(restarted.ports.reminders!.waiting('gene').length, 0);
  assert.match(restarted.host.chatTurn('不用提醒了'), /没有等着的提醒/u);
  assert.match(restarted.host.chatTurn('提醒我喝水'), /没听出是什么时候/u);
  assert.equal(restarted.host.chatTurn('今天天气不错'), '');
});

test('host #13: a reminder waits while you are away and tries again when not said; after the tries it is missed', async () => {
  const r = rig();
  await ready(r);
  r.host.chatTurn('十分钟后提醒我关火');
  r.state.now += 10 * 60_000;
  r.state.presence = { presence: 'away', interrupt: 'no', source: 'input' } as PresenceView;
  for (let i = 0; i < 50; i++) { r.host.tick(); r.state.now += 15_000; }
  assert.equal(r.asks.length, 0, 'away: waits');
  r.state.presence = null; r.host.tick();
  assert.equal(r.asks.length, 1, 'back: now');
  assert.match(r.host.promptLine('gene'), /已经过了约 1\d 分钟/u);
  r.host.done('cue1', false);
  r.state.now += 4 * 60_000; r.host.tick(); assert.equal(r.asks.length, 1, 'retry waits retryMinutes');
  r.state.now += 2 * 60_000; r.host.tick(); assert.equal(r.asks.length, 2);
  r.host.done('cue2', false);
  r.state.now += 6 * 60_000; r.host.tick(); r.host.done('cue3', false);
  assert.deepEqual(r.journal.at(-1), { characterId: 'gene', kind: 'reminder', outcome: 'quiet', why: 'not-said' });
  r.state.now += 6 * 60_000; r.host.tick();
  assert.equal(r.asks.length, 3, 'missed after three tries');
});

test('host #13: away past lateHours → the reminder is missed once (one journal line), never told late', async () => {
  const r = rig();
  await ready(r);
  r.host.chatTurn('十分钟后提醒我关火');
  r.state.now += 10 * 60_000;
  r.state.presence = { presence: 'away', interrupt: 'no', source: 'input' } as PresenceView;
  r.host.tick();
  r.state.now += 13 * 3_600_000; r.host.tick();
  assert.deepEqual(r.journal.at(-1), { characterId: 'gene', kind: 'reminder', outcome: 'expired', why: 'late' });
  r.state.idle = null; // 03:10: keep the late-night moment out of this test
  r.state.presence = null; r.host.tick(); r.state.now += 60_000; r.host.tick();
  assert.equal(r.asks.length, 0);
  assert.equal(r.journal.filter(row => row.outcome === 'expired').length, 1, 'one line, not two');
});

test('reminder store: never fires twice, unreadable file blocks (fail closed), ended ones kept two days then dropped', async () => {
  const dir = temp(), file = path.join(dir, 'reminders.json');
  const store = new ReminderStore(() => file, undefined, undefined, () => 'r1');
  await store.load();
  const item = store.add('gene', { dueAt: 2_000, what: '关火', guessed: false }, 1_000)!;
  assert.equal(store.due('gene', 2_500).item?.id, item.id);
  assert.equal(store.fired(item.id, 2_600), true);
  assert.equal(store.fired(item.id, 2_700), false, 'a second fire is refused');
  assert.equal(store.due('gene', 3_000).item, null);
  assert.equal(store.forgetCharacter('gene'), 1);
  // 数据地图: the reminders of the deleted character go, the other's stay (one shared file, read back from disk).
  const two = new ReminderStore(() => path.join(dir, 'two.json'), undefined, undefined, (() => { let n = 0; return () => `t${++n}`; })());
  await two.load();
  two.add('doomed', { dueAt: 9_000, what: '甲', guessed: false }, 1_000); two.add('kept', { dueAt: 9_000, what: '乙', guessed: false }, 1_000);
  assert.equal(two.forgetCharacter('doomed', 2_000), 1);
  await two.flush();
  const back = new ReminderStore(() => path.join(dir, 'two.json')); await back.load();
  assert.deepEqual([back.waiting('doomed').length, back.waiting('kept').length], [0, 1]);
  writeFileSync(path.join(dir, 'bad.json'), '{broken');
  const bad = new ReminderStore(() => path.join(dir, 'bad.json'));
  await bad.load();
  assert.equal(bad.add('gene', { dueAt: 5_000, what: 'x', guessed: false }, 1_000), null, 'unreadable: nothing added');
});

test('host #2 / #3 / #11: first meeting of the day once; back at the seat by chance and spacing; goodnight once a night', async () => {
  const r = rig(undefined, local(2026, 10, 22, 9, 0));
  await ready(r);
  r.state.presence = { presence: 'back', interrupt: 'yes', source: 'input', awayMinutes: 600 } as PresenceView;
  r.host.tick();
  assert.equal(r.host.view()?.kind, 'first-today');
  r.host.done('cue1', true);
  r.state.presence = null; r.host.tick();
  r.state.now += 60 * 60_000; r.state.presence = { presence: 'back', interrupt: 'yes', source: 'input', awayMinutes: 600 } as PresenceView; r.host.tick();
  assert.equal(r.asks.length, 1, 'first today only once');
  r.state.presence = null; r.host.tick();
  r.state.presence = { presence: 'back', interrupt: 'yes', source: 'input', awayMinutes: 12 } as PresenceView; r.host.tick();
  assert.equal(r.host.view()?.kind, 'back');
  assert.match(r.host.promptLine('gene'), /离开电脑约 12 分钟/u);
  r.host.done('cue2', false);
  r.state.presence = null; r.host.tick(); r.state.now += 5 * 60_000;
  r.state.presence = { presence: 'back', interrupt: 'yes', source: 'input', awayMinutes: 12 } as PresenceView; r.host.tick();
  assert.deepEqual(r.journal.at(-1), { characterId: 'gene', kind: 'back', outcome: 'skipped', why: 'cooldown' });
  const night = rig(undefined, local(2026, 10, 22, 22, 30));
  await ready(night); night.state.drowsy = true; night.host.tick();
  assert.equal(night.host.view()?.kind, 'goodnight');
  assert.deepEqual(night.host.current('gene'), { kind: 'goodnight', quietOk: true });
});

test('journal: the moment line is closed words only', () => {
  const ok = buildJournalEntry({ type: 'moment', characterId: 'gene', kind: 'screen', outcome: 'skipped', why: 'cooldown', screen: 'error' }, 1_000);
  assert.equal(ok?.reason, '她认出的时刻：一起看时屏幕上出了事');
  assert.equal(buildJournalEntry({ type: 'moment', characterId: 'gene', kind: 'screen', outcome: 'spoke', why: '用户说的话' } as never, 1_000), null);
  assert.equal(buildJournalEntry({ type: 'moment', characterId: 'gene', kind: 'reminder', outcome: 'spoke', what: '关火' } as never, 1_000)?.hasOwnProperty('what'), false);
});

// ---------------------------------------------------------------- the opening choice and the inner loop

const REST = getMoodSnapshot(createMoodState(1_000), 1_000);
const VIEW = { characterId: 'gene', snapshot: REST, parameters: DEFAULT_MOOD_PARAMETERS } as Pick<MoodView, 'characterId' | 'snapshot' | 'parameters'>;
const awake: InnerLoopQuiet = { asleep: false, drowsy: false, night: false, quiet: false };
function fakeLoop(take = true) {
  const calls: string[] = [];
  return { calls, offerOpportunity: (cue: unknown, focus?: string) => { calls.push(`${(cue as MoodCue).id}:${focus ?? '-'}`); return take; },
    canTake: () => true, claims: () => false, asleep: () => false, silence: () => true, restReminderDue: () => false, quietNow: () => ({ ...awake }) };
}
let serial = 0;
const speech = (): MoodCue => ({ id: `mcue-${++serial}`, kind: 'speech', at: 10_000, until: 13_000 } as MoodCue);

test('opening choice: a moment cue goes to the inner loop with focus moment; budget rolled unless a promise; held while you cannot be spoken to', () => {
  const released: string[] = [], spent: string[] = [], puts: string[] = [];
  const budget = { room: () => ({ factor: 0, words: '用完了' }), spend: (_c: string, id: string) => { spent.push(id); }, refund: () => {} };
  const loop = fakeLoop();
  const host = new OpeningHost({ loop, chooser: new FixedOpeningChoice(['mood']), innerOn: () => true, developerMode: () => false, clock: () => 10_500,
    releaseSpeech: cue => { released.push(cue.id); }, budget, random: () => 0.5 });
  const moment = (b: boolean) => ({ moment: () => ({ budget: b, put: (o: string) => { puts.push(o); } }) });
  assert.equal(host.claim(speech(), moment(true), VIEW), 'quiet', 'no room in the budget');
  assert.deepEqual(puts, ['budget']); assert.equal(released.length, 1); assert.equal(loop.calls.length, 0);
  const promise = speech();
  assert.equal(host.claim(promise, moment(false), VIEW), 'inner', 'a promised reminder skips the budget roll');
  assert.deepEqual(loop.calls, [`${promise.id}:moment`]); assert.deepEqual(puts, ['budget', 'inner']); assert.deepEqual(spent, []);
  const held = new OpeningHost({ loop, chooser: new FixedOpeningChoice(['mood']), innerOn: () => true, developerMode: () => false, clock: () => 10_500, releaseSpeech: () => {},
    presence: { view: () => ({ presence: 'meeting', interrupt: 'no', source: 'input' } as PresenceView) } });
  assert.equal(held.claim(speech(), moment(false), VIEW), 'quiet');
  assert.equal(puts.at(-1), 'held', 'in a meeting: the moment waits itself, nothing is held as an intent');
  assert.equal(held.held.peek(10_500), null);
  assert.equal(host.claim(speech(), { moment: () => null }, VIEW), 'quiet', 'not a moment cue: the ordinary choice and its own budget roll');
  assert.equal(loop.calls.length, 1, 'the ordinary path never offers focus moment');
});

function loopRig(answer: string, moment: InnerLoopDependencies['moment'] | undefined, quiet = awake, restUsed = false) {
  const state = { now: 1_000_000 };
  const gate = new ProactiveSpeechGate(() => state.now); gate.setScope('scope');
  const log = { offered: [] as InnerLoopMessage[], prompts: [] as string[], remembered: [] as string[] };
  const loop = new InnerLoop({
    gate, clock: () => state.now, enabled: () => true, canStart: () => true, current: () => true,
    scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS, quiet: () => quiet,
    prompt: (_c, allow, q, _l, _p, focus) => { log.prompts.push(`${focus}:${allow}:${q.quiet}`); return 'prompt'; },
    decide: async () => ({ text: answer }), realize: () => {}, releaseSpeech: () => {},
    offer: message => { log.offered.push(message); }, present: async () => true, presentationCurrent: () => true, archive: async () => {},
    restReminder: { lastInteractionAt: () => null, nightKey: () => '2026-11-22', used: () => restUsed, remember: night => { log.remembered.push(night); } },
    ...(moment ? { moment } : {}),
  });
  const cue = (id: string): MoodCue => ({ id, kind: 'speech', at: state.now, until: state.now + 3_000 } as MoodCue);
  return { loop, gate, log, cue, state };
}

test('inner loop, focus moment: refused without the host; through the one speech gate; quiet hours only when quietOk; the night is spent on delivery', async () => {
  assert.equal(loopRig('{"action":"none"}', undefined).loop.offerOpportunity(loopRig('', undefined).cue('a'), 'moment'), false, 'no moment host');
  const done: [string, boolean][] = [];
  const night: InnerLoopQuiet = { asleep: false, drowsy: false, night: true, quiet: true };
  const plain = loopRig('{"action":"speak","text":"还没睡呀"}', { current: () => ({ quietOk: false }), done: (id, d) => { done.push([id, d]); } }, night);
  assert.equal(plain.loop.offerOpportunity(plain.cue('b'), 'moment'), false, 'quiet hours and not quietOk: refused');
  const late = loopRig('{"action":"speak","text":"还没睡呀"}', { current: () => ({ quietOk: true, night: '2026-11-22' }), done: (id, d) => { done.push([id, d]); } }, night);
  assert.equal(late.loop.offerOpportunity(late.cue('c'), 'moment'), true);
  await flush();
  assert.deepEqual(late.log.prompts, ['moment:true:false'], 'her prompt treats it as a moment she may speak on');
  assert.equal(await late.loop.ack('c'), true);
  assert.deepEqual(done, [['c', true]]);
  assert.deepEqual(late.log.remembered, ['2026-11-22'], 'the night\'s one rest reminder is spent');
  const spent = loopRig('{"action":"speak","text":"x"}', { current: () => ({ quietOk: true, night: '2026-11-22' }), done: () => {} }, night, true);
  assert.equal(spent.loop.offerOpportunity(spent.cue('d'), 'moment'), false, 'the night was already spent by the old reminder');
  // The one proactive speech gate: busy → no moment line either.
  const busy = loopRig('{"action":"speak","text":"x"}', { current: () => ({ quietOk: false }), done: () => {} });
  busy.gate.tryAcquire({ scope: 'scope', opportunityId: 'other', expiresAt: busy.state.now + 10_000 }, 'vision');
  assert.equal(busy.loop.offerOpportunity(busy.cue('e'), 'moment'), false, 'the speech gate holds a line already: refused');
  const none = loopRig('{"action":"none"}', { current: () => ({ quietOk: false }), done: (id, d) => { done.push([id, d]); } });
  assert.equal(none.loop.offerOpportunity(none.cue('f'), 'moment'), true);
  await flush();
  assert.deepEqual(done.at(-1), ['f', false], 'she chose nothing: not delivered');
});

test('prompt: the moment line rides the 【此刻】 slot with its own rule; absent, the prompt is unchanged', () => {
  const input = { persona: 'P', mood: 'M', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity, localMinute: 600,
    minutesSinceInteraction: 30, cue: 'speech' as const, allowSpeech: true, quiet: awake };
  const without = buildInnerLoopPrompt(input);
  assert.equal(buildInnerLoopPrompt({ ...input, moment: '' }), without, 'an empty moment changes nothing');
  const withMoment = buildInnerLoopPrompt({ ...input, moment: '用户离开电脑约 12 分钟，刚回来。' });
  assert.match(withMoment, /应用注意到了一件事/u); assert.match(withMoment, /离开电脑约 12 分钟/u); assert.match(withMoment, /都由你/u);
});
