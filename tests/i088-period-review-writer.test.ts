// I-088 第 1 条 她的"这阵子"回顾, part 2: the writer with a fake model and the real profile store, the profile panel's data, the diary's opening
// path, recall through the chat archive, the journal line and the conversion carry. Synthetic data only; no network, no real Claude.
// Flaky under the full suite's load (11-17): fixed 20 ms / 100 ms sleeps were assumed long enough for the writer's disk work and the fake call;
// now every wait is on the event itself (f.until the call was made / the lines arrived, f.settle the writer idle), bounded at 30 s only as a stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserProfileStore, userProfileScopeId, type UserProfileScope } from '../electron/memory/user-profile';
import { UserProfileManagement } from '../electron/memory/user-profile-management';
import { MemoryStore } from '../electron/memory/memory';
import { CharacterCardStore } from '../electron/cards/character-cards';
import { localDateKey, localDayRange, shiftDate } from '../electron/memory/diary/diary-dates';
import { REVIEW_LIMITS, withWritten, type ReviewEntry } from '../electron/memory/period-review/data';
import { finishedWeeks, monthOf, readyMonth, shiftMonth } from '../electron/memory/period-review/period';
import { REVIEW_OPENING_NOTE } from '../electron/memory/period-review/recall';
import { ReviewStore } from '../electron/memory/period-review/store';
import { PeriodReviewWriter, type ReviewWriterEvent, type PeriodReviewWriterOptions } from '../electron/memory/period-review/writer';
import { createPeriodReviewWriter, reviewJournalEntry, reviewRecallSource } from '../electron/memory/period-review/wiring';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { ENGLISH_JOURNAL_UI_COPY } from '../shared/foundation/ui-copy.journal.en';
import { conversionItems } from '../electron/cards/character-convert/build';
import { readSourceSnapshot } from '../electron/cards/character-convert/snapshot';
import { memoryPrompt, memorySystemPrompt, readMemoryValue } from '../electron/cards/character-convert/translate';
import { conversionCopiedLines } from '../shared/cards/character-convert';
import { ALL_KEPT, FIXTURE_TERMS, filesOf, makeFixture, makeTranslator, providerScope, withDirectory } from './helpers/convert-fixture';
import { MEMORY_NOTES_FILE } from '../electron/memory/memory-notes/store';

const scope: UserProfileScope = { characterId: 'character-a', providerScope: 'provider-a' };
const otherCharacter: UserProfileScope = { characterId: 'character-b', providerScope: 'provider-a' };
const at = (day: string, hour = 12, minute = 0) => localDayRange(day).start + (hour * 60 + minute) * 60_000;
/** Monday: last week is Nov 2 to Nov 8, the week before is Oct 26 to Nov 1 (which holds the United States' daylight-saving end). */
const TODAY = '2026-11-09', LAST_WEEK = '2026-11-02', WEEK_BEFORE = '2026-10-26';
const scopeId = userProfileScopeId(scope);
const weekAnswer = (prompt: string) => JSON.stringify({ review: `这一周我们一起过了，${/(\d\d-\d\d) 到/.exec(prompt)?.[1]} 那几天你说想学冲浪。`, carry: '想学冲浪', words: ['冲浪'] });
const monthAnswer = () => JSON.stringify({ review: '这个月你搬了新家，我们聊了很多装修的事。', words: ['新家', '装修'] });
const answer = (prompt: string) => prompt.includes('【回顾这个月】') ? monthAnswer() : weekAnswer(prompt);

interface F {
  directory: string; profilesDir: string; clock: { now: number };
  profiles: UserProfileStore; review: ReviewStore; rolls: { next: () => number };
  calls: { prompt: string; model: string }[]; events: ReviewWriterEvent[];
  respond: { fn: (prompt: string) => string | Promise<string> };
  notes: { at: number; title: string; summary: string }[]; busy: { diary: boolean };
  writer(options?: Partial<PeriodReviewWriterOptions>): PeriodReviewWriter;
  diary(...days: string[]): Promise<void>;
  settle(writer: PeriodReviewWriter): Promise<void>;
  until(condition: () => boolean, what: string): Promise<void>;
  items(): Promise<string[]>;
  seed(...entries: ReviewEntry[]): Promise<void>;
}

async function fixture(run: (f: F) => Promise<void>, options: { recording?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-review-w-'));
  const profilesDir = path.join(directory, 'user-profiles');
  const clock = { now: at(TODAY, 9) };
  const rolls = { next: () => 0 };
  const calls: F['calls'] = [], events: ReviewWriterEvent[] = [], notes: F['notes'] = [], busy = { diary: false };
  const respond: F['respond'] = { fn: answer };
  let profiles!: UserProfileStore;
  const recording = () => { try { return profiles.view().enabled; } catch { return false; } };
  const review = new ReviewStore(profilesDir, { recording, now: () => clock.now, random: () => rolls.next() });
  profiles = new UserProfileStore(profilesDir, { now: () => clock.now, reviews: review });
  await profiles.activate(scope);
  if (options.recording !== false) profiles.setEnabled(true);
  const writers: PeriodReviewWriter[] = [];
  try {
    await run({ directory, profilesDir, clock, profiles, review, rolls, calls, events, respond, notes, busy,
      writer: (extra = {}) => {
        const writer = new PeriodReviewWriter({ profiles, store: review, scope: () => scope, notes: (_scope, start, end) => notes.filter(note => note.at >= start && note.at < end),
          character: target => target.characterId === scope.characterId ? { persona: '角色名称：小测', language: '', english: false } : null,
          model: () => 'sonnet', generate: async request => { calls.push(request); return respond.fn(request.prompt); },
          diaryBusy: () => busy.diary, now: () => clock.now, retryDelayMs: 60_000, report: event => events.push(event), ...extra });
        writers.push(writer); return writer;
      },
      diary: async (...days) => { for (const day of days) assert.equal(await profiles.saveDiary(profiles.diaryTicket()!, day, `${day} 和你一起过的一天。`), true); },
      until: async (condition, what) => { const stop = Date.now() + 30_000; while (!condition() && Date.now() < stop) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(condition(), what); },
      settle: async writer => { const until = Date.now() + 10_000; while (writer.busy && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(writer.busy, false); await review.settled(); },
      items: async () => (await review.ensure(scopeId))!.items.map(item => `${item.kind}:${item.key}`),
      seed: async (...entries) => { for (const item of entries) assert.equal(await review.change(scopeId, state => withWritten(state, item)), true); },
    });
  } finally {
    for (const writer of writers) writer.dispose();
    profiles.dispose();
    await review.settled();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}
const week = (key: string, text = '这一周我们去了海边。', extra: Partial<ReviewEntry> = {}): ReviewEntry => ({ kind: 'week', key, text, words: [], writtenAt: 1_000, ...extra });

test('Monday: one call per finished week with enough in it, oldest first; a second tick, a second writer and a restart add no call', async () => fixture(async f => {
  await f.diary('2026-10-28', '2026-10-30', '2026-11-03', '2026-11-05');
  const writer = f.writer();
  writer.tick(); await f.settle(writer);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0]!.prompt, /10-26 到 11-01 这一周/u); assert.match(f.calls[1]!.prompt, /11-02 到 11-08 这一周/u);
  assert.match(f.calls[1]!.prompt, /11-03 周二 她的日记：2026-11-03 和你一起过的一天。/u);
  assert.equal(f.calls[0]!.model, 'sonnet');
  assert.deepEqual(await f.items(), [`week:${WEEK_BEFORE}`, `week:${LAST_WEEK}`]);
  assert.deepEqual(f.events.map(event => `${event.type}:${event.kind}`), ['call:week', 'written:week', 'call:week', 'written:week', 'skipped:month']);
  assert.deepEqual(f.events.at(-1), { type: 'skipped', kind: 'month', key: '2026-10', why: 'thin' }, 'October has one weekly look-back and two diary days');
  const saved = (await f.review.ensure(scopeId))!.items.find(item => item.key === LAST_WEEK)!;
  assert.equal(saved.writtenAt, f.clock.now); assert.equal(saved.carry, '想学冲浪'); assert.deepEqual(saved.words, ['冲浪']);
  f.clock.now += 1_000; writer.tick(); await f.settle(writer);
  const other = f.writer(); other.tick(); await f.settle(other);
  f.clock.now += 3_600_000; other.tick(); await f.settle(other);
  assert.equal(f.calls.length, 2, 'nothing is written twice');
  assert.deepEqual(await f.items(), [`week:${WEEK_BEFORE}`, `week:${LAST_WEEK}`]);
  f.clock.now = at('2026-11-10', 9); other.tick(); await f.settle(other);
  assert.equal(f.calls.length, 2, 'the next day, the same');
  assert.equal(f.events.filter(event => event.type === 'skipped' && event.kind === 'month').length, 2, 'a thin month is said once per writer, however often it is looked at');
}));

test('the files and the view: they land beside the profile in a file of their own that a previous build never reads; recording does not change the profile\'s revision', async () => fixture(async f => {
  await f.diary('2026-11-03', '2026-11-05');
  const revision = f.profiles.view().revision;
  const writer = f.writer(); writer.tick(); await f.settle(writer);
  assert.deepEqual((await readdir(f.profilesDir)).filter(name => name.startsWith('review-')), [`review-${scopeId}.json`]);
  const profile = JSON.parse(await readFile(path.join(f.profilesDir, `profile-${scopeId}.json`), 'utf8'));
  assert.equal(JSON.stringify(profile).includes('这一周'), false, 'the profile file is not touched');
  assert.equal(f.profiles.view().revision, revision);
  const view = f.profiles.view();
  assert.deepEqual(view.reviews!.map(item => `${item.kind}:${item.key}`), [`week:${LAST_WEEK}`]);
  assert.equal(view.reviews![0]!.text.includes('11-02'), true);
}));

test('not enough yet: no call, said once; chat notes can make a week enough, and the look-back is written when they come', async () => fixture(async f => {
  await f.diary('2026-11-03');
  f.notes.push({ at: at('2026-11-04'), title: '书店', summary: '说最喜欢下雨天去书店。' }, { at: at('2026-11-05'), title: '面试', summary: '周五面试。' });
  const writer = f.writer(); writer.tick(); await f.settle(writer);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.events.filter(event => event.type === 'skipped' && event.kind === 'week').map(event => event.key).sort(), [WEEK_BEFORE, LAST_WEEK].sort());
  // Next day: a third note has come in (the notebook is slow); the same week is enough now.
  f.notes.push({ at: at('2026-11-06'), title: '看电影', summary: '一起看了猫咪视频。' });
  f.clock.now = at('2026-11-10', 9); writer.tick(); await f.settle(writer);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.prompt, /11-04 聊到：书店——说最喜欢下雨天去书店。/u); assert.match(f.calls[0]!.prompt, /11-05 聊到：面试——周五面试。/u);
  assert.deepEqual(await f.items(), [`week:${LAST_WEEK}`]);
  assert.equal(f.events.filter(event => event.type === 'skipped' && event.key === LAST_WEEK).length, 1, 'said once');
}));

test('"允许记录" off: no call and nothing new; what is written stays listed and manageable; turning it on writes the same day', async () => fixture(async f => {
  await f.diary('2026-11-03', '2026-11-05');
  await f.seed(week(WEEK_BEFORE));
  f.profiles.setEnabled(false);
  const writer = f.writer(); writer.tick(); await f.settle(writer);
  assert.equal(f.calls.length, 0); assert.equal(writer.busy, false);
  assert.deepEqual(await f.items(), [`week:${WEEK_BEFORE}`]);
  // Still manageable with recording off.
  const management = new UserProfileManagement(f.profiles, () => {}, () => scope);
  await management.activate(scope);
  const expected = () => { const view = management.get()!; return { scopeId: view.scopeId, generation: view.generation, revision: view.revision }; };
  assert.equal(management.get()!.reviews!.length, 1);
  const edited = await management.editReview({ ...expected(), kind: 'week', key: WEEK_BEFORE, text: '我自己改的话' });
  assert.equal(edited.reviews![0]!.text, '我自己改的话'); assert.ok(edited.reviews![0]!.editedAt);
  f.profiles.setEnabled(true);
  writer.tick(); await f.settle(writer);
  assert.equal(f.calls.length, 1, 'one call: the edited week is not written again, the other one is');
  assert.deepEqual(await f.items(), [`week:${WEEK_BEFORE}`, `week:${LAST_WEEK}`]);
  assert.equal((await f.review.ensure(scopeId))!.items[0]!.text, '我自己改的话', 'an edited look-back is never overwritten');
  f.profiles.setEnabled(false);
  await management.deleteReview({ ...expected(), kind: 'week', key: LAST_WEEK });
  assert.deepEqual(await f.items(), [`week:${WEEK_BEFORE}`]);
  management.dispose();
}));

test('a deleted look-back is never written again, an edited one never overwritten; the panel\'s actions check scope and revision', async () => fixture(async f => {
  await f.diary('2026-11-03', '2026-11-05', '2026-10-28', '2026-10-30');
  const writer = f.writer(); writer.tick(); await f.settle(writer);
  assert.equal(f.calls.length, 2);
  const revision = f.profiles.view().revision;
  await assert.rejects(() => f.profiles.deleteReview('week', LAST_WEEK, revision + 1));
  await assert.rejects(() => f.profiles.editReview('week', LAST_WEEK, '一段新的话', revision + 1));
  assert.equal((await f.review.ensure(scopeId))!.items.find(item => item.key === LAST_WEEK)!.editedAt, undefined, 'a stale edit changed nothing');
  assert.throws(() => f.profiles.deleteReview('week', '2026-11-03', revision), /回顾日期/u);
  assert.throws(() => f.profiles.editReview('week', LAST_WEEK, '   ', revision), /回顾内容/u);
  assert.throws(() => f.profiles.editReview('week', LAST_WEEK, 'x'.repeat(REVIEW_LIMITS.editedChars + 1), revision), /回顾内容/u);
  await assert.rejects(() => f.profiles.deleteReview('month', '2026-10', revision), /已不存在/u);
  const view = await f.profiles.deleteReview('week', LAST_WEEK, revision);
  assert.deepEqual(view.reviews!.map(item => item.key), [WEEK_BEFORE]);
  await f.profiles.editReview('week', WEEK_BEFORE, '改过的', revision);
  f.clock.now = at('2026-11-10', 9); writer.tick(); await f.settle(writer);
  const fresh = f.writer(); f.clock.now = at('2026-11-12', 9); fresh.tick(); await f.settle(fresh);
  assert.equal(f.calls.length, 2, 'neither the deleted week nor the edited one is asked again');
  assert.deepEqual(await f.items(), [`week:${WEEK_BEFORE}`]);
  assert.equal((await f.review.ensure(scopeId))!.items[0]!.text, '改过的');
}));

test('a failed call (offline, signed out) is not counted and is asked again later, once per period', async () => fixture(async f => {
  await f.diary('2026-11-03', '2026-11-05', '2026-10-28', '2026-10-30');
  let fail = true;
  f.respond.fn = prompt => { if (fail) throw new Error('claude is not signed in'); return answer(prompt); };
  const writer = f.writer(); writer.tick(); await f.settle(writer);
  assert.equal(f.calls.length, 1, 'the first week failed; the rest waits (it would fail the same way)');
  assert.deepEqual(f.events.map(event => event.type), ['call', 'failed']);
  assert.deepEqual(await f.items(), []);
  f.clock.now += 30_000; writer.tick(); await f.settle(writer);
  assert.equal(f.calls.length, 1, 'not again before the delay');
  for (let round = 0; round < 5; round++) { f.clock.now += 61_000; writer.tick(); await f.settle(writer); }
  assert.equal(f.calls.length, 6, 'tried again each time, and it is not counted against the period');
  assert.equal((await f.review.ensure(scopeId))!.tries.length, 0);
  fail = false; f.clock.now += 61_000; writer.tick(); await f.settle(writer);
  assert.deepEqual(await f.items(), [`week:${WEEK_BEFORE}`, `week:${LAST_WEEK}`]);
  assert.equal(f.calls.length, 8, 'one call per week once it works');
}));

test('an answer that cannot be used writes nothing; a period gets three of them, even across a restart', async () => fixture(async f => {
  await f.diary('2026-11-03', '2026-11-05');
  f.respond.fn = () => '这周我们去了海边。';
  const writer = f.writer(); writer.tick(); await f.settle(writer);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.events.map(event => event.type), ['skipped', 'call', 'invalid'], 'the week before had nothing to write about');
  assert.deepEqual(await f.items(), []);
  for (let round = 0; round < 6; round++) { f.clock.now += 61_000; writer.tick(); await f.settle(writer); }
  assert.equal(f.calls.length, REVIEW_LIMITS.attemptsPerPeriod);
  assert.deepEqual((await f.review.ensure(scopeId))!.tries, [{ id: `week:${LAST_WEEK}`, count: REVIEW_LIMITS.attemptsPerPeriod }]);
  const restarted = f.writer(); f.clock.now = at('2026-11-10', 9); restarted.tick(); await f.settle(restarted);
  assert.equal(f.calls.length, REVIEW_LIMITS.attemptsPerPeriod, 'a restart does not give it more');
  assert.deepEqual(await f.items(), []);
}));

test('turning recording off while a call runs: the late answer is never written; switching characters stops it too', async () => fixture(async f => {
  await f.diary('2026-11-03', '2026-11-05');
  let release!: (text: string) => void;
  f.respond.fn = () => new Promise<string>(resolve => { release = resolve; });
  const writer = f.writer(); writer.tick();
  await f.until(() => f.calls.length === 1, 'the call was made');
  assert.equal(f.calls.length, 1); assert.equal(writer.busy, true);
  f.profiles.setEnabled(false); writer.tick();
  release(weekAnswer('11-02 到 11-08 这一周'));
  await f.settle(writer);
  assert.deepEqual(await f.items(), [], 'nothing written');
  assert.equal(f.events.some(event => event.type === 'written'), false);
  f.profiles.setEnabled(true);
  const again = f.writer({ scope: () => otherCharacter }); again.tick(); await f.settle(again);
  assert.equal(f.calls.length, 1, 'a scope that is not the shown one is never written for');
}));

test('switching to another character while a call runs: the late answer is written for neither (recording stays on)', async () => fixture(async f => {
  await f.diary('2026-11-03', '2026-11-05');
  let release!: (text: string) => void;
  f.respond.fn = () => new Promise<string>(resolve => { release = resolve; });
  const writer = f.writer(); writer.tick();
  await f.until(() => f.calls.length === 1, 'the call was made');
  assert.equal(writer.busy, true);
  await f.profiles.activate(otherCharacter); f.profiles.setEnabled(true); writer.tick();
  release(weekAnswer('11-02 到 11-08 这一周'));
  await f.settle(writer);
  assert.deepEqual(await f.items(), [], 'not written for the character it was asked for');
  assert.deepEqual((await f.review.ensure(userProfileScopeId(otherCharacter)))!.items, [], 'nor for the one now shown');
  assert.equal(f.events.some(event => event.type === 'written'), false);
}));

test('two writers at once cannot write a period twice; the save checks again inside the store\'s queue', async () => fixture(async f => {
  await f.diary('2026-11-03', '2026-11-05');
  const a = f.writer(), b = f.writer();
  a.tick(); b.tick();
  await f.settle(a); await f.settle(b);
  assert.equal(f.calls.length, 2, 'each asked once');
  assert.deepEqual(await f.items(), [`week:${LAST_WEEK}`]);
  const [item] = (await f.review.ensure(scopeId))!.items;
  assert.equal(JSON.parse(await readFile(path.join(f.profilesDir, `review-${scopeId}.json`), 'utf8')).data.items.length, 1);
  assert.ok(item);
}));

test('the diary writer goes first: while it is running the look-back waits; a character that is not the shown card gets nothing', async () => fixture(async f => {
  await f.diary('2026-11-03', '2026-11-05');
  f.busy.diary = true;
  const writer = f.writer(); writer.tick(); await f.settle(writer);
  assert.equal(f.calls.length, 0);
  f.busy.diary = false; writer.tick(); await f.settle(writer);
  assert.equal(f.calls.length, 1);
  const stranger = f.writer({ character: () => null }); f.clock.now = at('2026-11-17', 9);
  stranger.tick(); await f.settle(stranger);
  assert.equal(f.calls.length, 1, 'no persona, no call');
}));

test('the month: written after its last week is over, from the weekly look-backs and their kept lines; or from enough diary days; not before', async () => fixture(async f => {
  await f.seed(week('2026-10-05', '十月第一周搬了家。', { carry: '搬家累坏了' }), week('2026-10-12', '第二周在收拾新家。'), week('2026-10-19', '第三周买了一盏灯。'));
  await f.diary('2026-10-28', '2026-10-30', '2026-11-03', '2026-11-05');
  // Sunday Nov 1: still October's last week.
  f.clock.now = at('2026-11-01', 9);
  const early = f.writer(); early.tick(); await f.settle(early);
  assert.equal(f.calls.some(call => call.prompt.includes('【回顾这个月】')), false);
  f.clock.now = at(TODAY, 9);
  const writer = f.writer(); writer.tick(); await f.settle(writer);
  const monthCall = f.calls.find(call => call.prompt.includes('【回顾这个月】'))!;
  assert.ok(monthCall, 'the month is asked after the weeks');
  assert.equal(f.calls.indexOf(monthCall), f.calls.length - 1, 'weeks first, so the month sees them');
  assert.match(monthCall.prompt, /2026 年 10 月/u); assert.match(monthCall.prompt, /10-05 起的一周：十月第一周搬了家。（那周留给这个月的话：搬家累坏了）/u);
  assert.match(monthCall.prompt, /10-26 起的一周：这一周我们一起过了/u, 'the week written just before is in it');
  assert.equal((await f.items()).includes('month:2026-10'), true);
  const month = (await f.review.ensure(scopeId))!.items.find(item => item.kind === 'month')!;
  assert.equal(month.carry, undefined); assert.deepEqual(month.words, ['新家', '装修']);
  writer.tick(); await f.settle(writer);
  assert.equal(f.calls.filter(call => call.prompt.includes('【回顾这个月】')).length, 1, 'once');
}));

test('the month from diary alone needs six days; fewer is skipped, said once', async () => fixture(async f => {
  await f.seed(week('2026-10-05', '十月第一周。'));
  await f.diary('2026-10-02', '2026-10-03', '2026-10-04', '2026-10-06', '2026-10-07');
  const writer = f.writer(); writer.tick(); await f.settle(writer);
  assert.equal(f.calls.some(call => call.prompt.includes('【回顾这个月】')), false);
  assert.ok(f.events.some(event => event.type === 'skipped' && event.kind === 'month'));
  await f.diary('2026-10-08');
  f.clock.now = at('2026-11-10', 9); writer.tick(); await f.settle(writer);
  const call = f.calls.find(item => item.prompt.includes('【回顾这个月】'))!;
  assert.ok(call); assert.match(call.prompt, /10-02 她的日记：/u);
}));

test('English card: an English look-back longer than the Chinese cap is accepted (the cap follows the card\'s language)', async () => fixture(async f => {
  await f.diary('2026-11-03', '2026-11-05');
  f.respond.fn = () => JSON.stringify({ review: 'We went to the sea this week and you said you would learn to surf. '.repeat(8), carry: 'learn to surf', words: ['surf'] });
  const writer = f.writer({ character: () => ({ persona: 'p', language: '', english: true }) }); writer.tick(); await f.settle(writer);
  assert.deepEqual(await f.items(), [`week:${LAST_WEEK}`]);
  assert.ok(Array.from((await f.review.ensure(scopeId))!.items[0]!.text).length > 320);
}));

// ---- the journal ----

test('the experience journal gets one closed line when a look-back is written or skipped; never a word of one', async () => fixture(async f => {
  const lines: unknown[] = [];
  const writer = createPeriodReviewWriter({ profiles: f.profiles, store: f.review, scope: () => scope, notes: () => [], character: () => ({ persona: 'p', language: '', english: false }), model: () => 'sonnet',
    generate: async request => { f.calls.push(request); return answer(request.prompt); }, diaryBusy: () => false, changed: () => {}, journal: entry => lines.push(entry),
    now: () => f.clock.now }); // the fixture's Monday: without it the finished weeks follow today's date (failed on Monday 2026-11-16)
  await f.diary('2026-11-03', '2026-11-05');
  writer.tick(); await f.until(() => lines.filter(Boolean).length >= 3, 'three journal lines'); await f.review.settled();
  assert.deepEqual(lines.filter(Boolean), [
    { type: 'period-review', characterId: 'character-a', kind: 'week', event: 'skipped' },
    { type: 'period-review', characterId: 'character-a', kind: 'week', event: 'written' },
    { type: 'period-review', characterId: 'character-a', kind: 'month', event: 'skipped' },
  ]);
  assert.ok(lines.includes(null), 'the call itself is no journal line (the host drops it)');
  writer.dispose();
  assert.equal(reviewJournalEntry({ type: 'call', kind: 'week', key: LAST_WEEK }, 'a'), null);
  for (const event of ['written', 'skipped', 'failed', 'invalid'] as const) for (const kind of ['week', 'month'] as const) {
    const entry = buildJournalEntry({ type: 'period-review', characterId: 'gene', kind, event }, 1_000)!;
    assert.ok(entry, `${event} ${kind}`); assert.match(entry.reason, /回顾/u);
    assert.ok(describeJournalEntry(entry, text => text).endsWith(entry.reason));
    assert.ok(ENGLISH_JOURNAL_UI_COPY[entry.reason], `English for ${entry.reason}`);
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'characterId', 'event', 'kind', 'reason', 'time', 'type', 'v']);
  }
  assert.equal(buildJournalEntry({ type: 'period-review', characterId: 'gene', kind: 'day', event: 'written' }, 1), null);
  assert.equal(buildJournalEntry({ type: 'period-review', characterId: 'gene', kind: 'week', event: 'written', text: '这周去了海边' }, 1)!.hasOwnProperty('text'), false);
}));

// ---- the opening of a new week's first conversation ----

const body = (profiles: UserProfileStore, ticket: string | null) => ticket ? profiles.readContext(ticket) : null;

test('a new week\'s first conversation may carry one sentence of last week through the diary\'s opening path; once a week, never otherwise', async () => fixture(async f => {
  await f.seed(week(LAST_WEEK, '这周我们去了海边冲浪。你还说起想养一只猫。'));
  f.rolls.next = () => 0;
  assert.equal(body(f.profiles, f.profiles.createContext([], { diary: false })), null, 'a turn that is not an opening never carries it (and does not use up the week\'s decision)');
  const first = body(f.profiles, f.profiles.createContext([], { diary: true }));
  assert.ok(first, 'the opening block exists even with no diary and no profile'); assert.ok(first.includes(REVIEW_OPENING_NOTE)); assert.match(first, /上一周（11-02 起）：这周我们去了海边冲浪。|你还说起想养一只猫。/u);
  assert.equal(body(f.profiles, f.profiles.createContext([], { diary: true })), null, 'the same week: decided already');
  assert.equal(body(f.profiles, f.profiles.createContext([], { diary: false })), null, 'a turn that is not an opening never carries it');
  // The diary's own block rides in the same place and cap; the look-back is one more short section.
  await f.diary('2026-11-08');
  f.clock.now = at('2026-11-16', 9);
  await f.seed(week(TODAY, '这周我们去看了电影。'));
  const next = body(f.profiles, f.profiles.createContext([], { diary: true, memes: true }))!;
  assert.ok(next.includes(REVIEW_OPENING_NOTE)); assert.ok(next.includes('去看了电影'));
  assert.ok(Array.from(next).length < 600, 'a short block');
  await f.review.settled();
  const restarted = new ReviewStore(f.profilesDir, { recording: () => true, random: () => 0 });
  await restarted.load(scopeId);
  assert.equal(restarted.openingLine(scopeId, at('2026-11-17', 9)), '', 'the decision was kept in the file');
}));

test('the mention is not every time: a week decided "no" gives nothing, and recording off gives nothing', async () => fixture(async f => {
  await f.seed(week(LAST_WEEK, '这周我们去了海边冲浪。'));
  f.rolls.next = () => 0.99;
  assert.equal(body(f.profiles, f.profiles.createContext([], { diary: true })), null, 'decided no (the draw is over the chance)');
  f.rolls.next = () => 0;
  assert.equal(body(f.profiles, f.profiles.createContext([], { diary: true })), null, 'and not asked again that week');
  f.clock.now = at('2026-11-16', 9);
  await f.seed(week(TODAY, '这周我们去看了电影。'));
  f.profiles.setEnabled(false);
  assert.equal(f.profiles.createContext([], { diary: true }), null, 'recording off: no context at all');
}));

// ---- recall through the chat archive ----

async function memoryFixture(run: (f: F & { memory: MemoryStore; chat(day: string, user: string, reply: string, target?: UserProfileScope): Promise<void> }) => Promise<void>) {
  await fixture(async f => {
    const memory = new MemoryStore(f.directory); await memory.load();
    let turn = 0;
    try {
      await run({ ...f, memory, chat: async (day, user, reply, target = scope) => {
        const id = `turn-${++turn}`;
        await memory.beginTurn(target, { id, userText: user, at: at(day, 20), newTopic: true });
        await memory.appendAssistant(target, id, reply, at(day, 20, 1));
        await memory.finishTurn(target, id, 'complete', at(day, 20, 1));
      } });
    } finally { await memory.flush(); }
  });
}
const NOW = at(TODAY, 15);

test('recall: a period word or a name brings her look-back as a memory through retrieve; with none, retrieve is exactly what it was', async () => memoryFixture(async f => {
  await f.chat('2026-10-20', '我们一起看电影吧，我喜欢电影', '好呀，看电影。');
  await f.chat('2026-10-21', '周末我想看电影', '好呀，看电影。');
  await f.chat('2026-10-22', '电影院的爆米花真好吃', '是呀，看电影。');
  await f.seed(week(LAST_WEEK, '这周我们去了海边冲浪，你还说起想养一只猫。', { words: ['海边', '冲浪', '养一只猫'] }), { kind: 'month', key: '2026-10', text: '十月里你搬了新家。', words: ['新家'], writtenAt: 1 });
  const baseline = f.memory.retrieve(scope, '我们看电影', {}, NOW), baselineLast = f.memory.retrieve(scope, '上周看的电影', {}, NOW);
  assert.equal(baseline.length, 3);
  f.memory.setReviewRecall(reviewRecallSource(f.review));
  assert.deepEqual(f.memory.retrieve(scope, '我们看电影', {}, NOW), baseline, 'nothing pointed at a look-back: the same records, order and excerpts');
  assert.deepEqual(f.memory.retrieve(scope, '你好', {}, NOW), []);
  const recalled = f.memory.retrieve(scope, '上周看的电影', {}, NOW);
  assert.equal(recalled.length, 3, 'the look-back takes one record\'s place: the same count');
  assert.equal(recalled[0]!.id, `review:week:${LAST_WEEK}`); assert.equal(recalled[0]!.excerpt, '这周我们去了海边冲浪，你还说起想养一只猫。');
  assert.match(recalled[0]!.title, /一周回顾/u);
  assert.deepEqual(recalled.slice(1).map(item => item.id), baselineLast.slice(0, 2).map(item => item.id), 'the best two chat records stay');
  assert.equal(f.memory.retrieve(scope, '还记得想养一只猫吗', {}, NOW)[0]!.id, `review:week:${LAST_WEEK}`);
  assert.equal(f.memory.retrieve(scope, '上个月怎么样', {}, NOW)[0]!.id, 'review:month:2026-10');
  // The character budget is shared: a small budget cuts the look-back, and it is not given more than it.
  const small = f.memory.retrieve(scope, '上周看的电影', { maxChars: 12 }, NOW);
  assert.ok(small.reduce((sum, item) => sum + Array.from(item.excerpt).length, 0) <= 12);
  assert.deepEqual(f.memory.retrieve(scope, '上周', { maxRecords: 0 }, NOW), []);
  assert.equal(f.memory.retrieve(scope, '上周看的电影', { maxRecords: 1 }, NOW).length, 1);
  // Another character and another connection read none; recording off reads none; a deleted one is gone.
  assert.equal(f.memory.retrieve(otherCharacter, '上周怎么样', {}, NOW).some(item => item.id.startsWith('review:')), false);
  assert.equal(f.memory.retrieve({ ...scope, providerScope: 'provider-b' }, '上周怎么样', {}, NOW).some(item => item.id.startsWith('review:')), false);
  const before = f.memory.recallRevision();
  await f.profiles.deleteReview('week', LAST_WEEK, f.profiles.view().revision);
  assert.notEqual(f.memory.recallRevision(), before, 'a recall made before the deletion is stale (the late check drops it)');
  assert.equal(f.memory.retrieve(scope, '上周看的电影', {}, NOW).some(item => item.id.startsWith('review:')), false);
  assert.deepEqual(f.memory.retrieve(scope, '我们看电影', {}, NOW), baseline);
  f.profiles.setEnabled(false);
  assert.equal(f.memory.retrieve(scope, '上个月怎么样', {}, NOW).some(item => item.id.startsWith('review:')), false);
  f.memory.setReviewRecall(null);
  assert.deepEqual(f.memory.retrieve(scope, '我们看电影', {}, NOW), baseline);
}));

test('recall does not disturb the chat notes: a note\'s own recall still finds its chat, and a look-back adds no write to the archive', async () => memoryFixture(async f => {
  await f.chat('2026-10-20', '我们一起看电影吧', '好呀。');
  await f.seed(week(LAST_WEEK, '这周我们去了海边冲浪。', { words: ['海边冲浪'] }));
  f.memory.setReviewRecall(reviewRecallSource(f.review));
  const before = await readFile(path.join(f.directory, 'memories.jsonl'), 'utf8').catch(() => '');
  const first = f.memory.retrieve(scope, '上周怎么样，海边冲浪', {}, NOW);
  assert.equal(first[0]!.id.startsWith('review:'), true);
  assert.equal(await readFile(path.join(f.directory, 'memories.jsonl'), 'utf8').catch(() => ''), before, 'the archive is only read');
  await f.memory.noteUserRecall(scope, '上周怎么样', { eventId: 'e1', at: NOW });
  assert.equal(f.memory.retrieve(scope, '我们一起看电影吧', {}, NOW)[0]!.id.startsWith('review:'), false);
}));

// ---- conversion ----

const PETS: [string, string][] = [...FIXTURE_TERMS, ['小团子', 'Xiao Tuan Zi'], ['团子', 'wifey'], ['阿龙', 'A Long'], ['澄澄', 'Cheng Cheng'], ['小糯米', 'Mochi']];

async function sourceReviews(directory: string, characterId: string, items: ReviewEntry[]) {
  const store = new ReviewStore(path.join(directory, 'user-profiles'), { recording: () => true });
  for (const item of items) assert.equal(await store.change(userProfileScopeId({ characterId, providerScope }), state => withWritten(state, item)), true);
  return path.join(directory, 'user-profiles', `review-${userProfileScopeId({ characterId, providerScope })}.json`);
}
const hanOf = (text: string) => /\p{Script=Han}/u.test(text);

test('conversion: the newest look-backs are carried once, translated, under the new card\'s scope only; the source file is untouched', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const today = localDateKey(Date.now()), older = finishedWeeks(today, 8).slice(2); // six weeks, not the newest two
  const monthKey = shiftMonth(monthOf(today), -3);
  const items: ReviewEntry[] = [...older.map((key, index): ReviewEntry => week(key, `第${index}周：我们一起去了海边，小雨说想学冲浪。`, { carry: '想学冲浪', words: ['海边', '冲浪'] })),
    { kind: 'month', key: monthKey, text: '这个月小雨搬了新家，我们聊了很多。', words: ['新家'], writtenAt: 5 }];
  const file = await sourceReviews(directory, fixture.sourceId, items);
  const sourceBytes = await readFile(file);
  const before = await filesOf(directory);

  const preview = await fixture.service.preview(fixture.sourceId);
  assert.equal(preview.counts.reviews, 5, 'the newest four weeks and the newest month');
  assert.ok(preview.copied.some(line => /每周、每月回顾：最近的 5 段/u.test(line)));
  assert.equal(conversionCopiedLines({ ...preview.counts, reviews: undefined }, 'en').some(line => /回顾/u.test(line)), false, 'no line when there are none');
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT });
  await fixture.service.idle();
  const done = fixture.service.view()!;
  assert.equal(done.state, 'done', done.error); assert.equal(done.carried?.reviews, 5);
  const newId = done.newCardId!;
  const newFile = path.join(directory, 'user-profiles', `review-${userProfileScopeId({ characterId: newId, providerScope })}.json`);
  const saved = JSON.parse(await readFile(newFile, 'utf8')) as { version: number; scopeId: string; data: { items: ReviewEntry[]; blocked: string[]; tries: { id: string; count: number }[]; opening: unknown } };
  assert.equal(saved.scopeId, userProfileScopeId({ characterId: newId, providerScope }));
  assert.deepEqual(saved.data.items.map(item => `${item.kind}:${item.key}`).sort(), [...older.slice(0, 4).map(key => `week:${key}`), `month:${monthKey}`].sort());
  for (const item of saved.data.items) {
    assert.equal(hanOf(item.text) || hanOf(item.carry ?? '') || item.words.some(hanOf), false, 'no source-language text carried');
    assert.match(item.text, /^EN /u);
    assert.ok(item.words.every(word => item.text.includes(word)), 'a name is kept only when it is in the translated text');
    if (item.kind === 'week') assert.ok(item.carry);
  }
  assert.equal(saved.data.items.find(item => item.kind === 'week')!.text.includes('Rainy'), true, 'the glossary is applied');
  // The new card does not write look-backs of the weeks just before the conversion from the carried memories.
  const newest = finishedWeeks(today, REVIEW_LIMITS.backfillWeeks);
  for (const key of newest) assert.ok(saved.data.tries.some(entry => entry.id === `week:${key}` && entry.count === REVIEW_LIMITS.attemptsPerPeriod), key);
  const month = readyMonth(today);
  if (month) assert.ok(saved.data.tries.some(entry => entry.id === `month:${month}`));
  // The source is exactly what it was; everything else the conversion carries is unchanged by this feature.
  assert.ok((await readFile(file)).equals(sourceBytes));
  const after = await filesOf(directory);
  for (const [name, bytes] of before) if (name.startsWith('user-profiles/') || name === MEMORY_NOTES_FILE) assert.ok(after.get(name)?.equals(bytes), `${name} changed`);
  // The carried look-backs are read by the new scope like any other (the store accepts them as they are).
  const read = new ReviewStore(path.join(directory, 'user-profiles'), { recording: () => true });
  assert.equal((await read.ensure(userProfileScopeId({ characterId: newId, providerScope })))!.items.length, 5);
  // Every call that carried them: one batch, with the item keys rw / rm.
  const batch = fixture.model.calls.find(call => call.prompt.includes('<items>'))!.prompt;
  assert.match(batch, /"k":"rw\d{4}-\d{2}-\d{2}","kind":"review"/u); assert.match(batch, /"k":"rm\d{4}-\d{2}","kind":"review"/u);
}));

test('conversion: with no look-backs nothing changes (no file, no line, the same items)', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const snapshot = await readSourceSnapshot(fixture.sourceId, (fixture.service as any).options.source);
  assert.equal(snapshot.reviews, undefined);
  assert.equal(conversionItems(snapshot).some(item => item.kind === 'review'), false);
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT });
  await fixture.service.idle();
  const done = fixture.service.view()!;
  assert.equal(done.state, 'done', done.error); assert.equal(done.carried?.reviews, undefined);
  assert.deepEqual((await readdir(path.join(directory, 'user-profiles'))).filter(name => name.startsWith('review-')), []);
}));

test('conversion: a name left for later never reaches the model, in a look-back as anywhere; one that will not translate is left out and named', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { model: makeTranslator(PETS) });
  const notes = path.join(directory, MEMORY_NOTES_FILE), data = JSON.parse(await readFile(notes, 'utf8'));
  data.notes[0].body.summary = `用户叫她「小团子」，有时叫她「团子」。${data.notes[0].body.summary}`;
  data.notes[0].body.people.push('小团子');
  data.notes[1].body.summary = `她叫用户「阿龙」。阿龙说周五面试。团子给阿龙打气。${data.notes[1].body.summary}`;
  data.notes[1].body.people.push('阿龙', '团子');
  await writeFile(notes, JSON.stringify(data));
  const today = localDateKey(Date.now()), [first, second] = finishedWeeks(today, 3);
  await sourceReviews(directory, fixture.sourceId, [week(first!, '这周阿龙叫她「小团子」，团子很开心，我们去了海边。用户叫她「小糯米」。', { carry: '团子说想去海边', words: ['海边', '团子'] }), week(second!, '上周阿龙说周五面试，团子给阿龙打气。用户叫她「小糯米」，小糯米听了很开心。', { words: ['面试'] })]);
  const preview = await fixture.service.preview(fixture.sourceId);
  assert.ok(preview.names.some(name => name.text === '小糯米'), 'a name only her look-backs use is found, so it can be left for later');
  const later = preview.names.filter(name => name.id !== 'her-name').map(name => name.id === 'user-nickname' ? { id: name.id, to: 'Rainy' } : { id: name.id, to: '' });
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: [ALL_KEPT[0]!, ...later] });
  await fixture.service.idle();
  const done = fixture.service.view()!;
  assert.equal(done.state, 'done', done.error);
  for (const call of fixture.model.calls) assert.doesNotMatch(call.prompt + call.system, /团子|阿龙|澄澄|糯米/u, 'no left-out name in any prompt');
  const saved = JSON.parse(await readFile(path.join(directory, 'user-profiles', `review-${userProfileScopeId({ characterId: done.newCardId!, providerScope })}.json`), 'utf8'));
  assert.doesNotMatch(JSON.stringify(saved), /Tuan|A Long|Cheng Cheng|wifey|Mochi|团子|阿龙|澄澄|糯米/iu);
  assert.equal(saved.data.items.length, 2);
}));

test('conversion: a look-back whose translation still has source-language text is asked again, then left out and named; the rest carries on', async () => withDirectory(async directory => {
  const today = localDateKey(Date.now()), keys = finishedWeeks(today, 4);
  const target = `rw${keys[0]}`;
  const fixture = await makeFixture(directory, { model: makeTranslator(FIXTURE_TERMS, (value, kind, key) => kind === 'review' && key === target ? { ...value, text: '这里还是中文，没有翻译。' } : value) });
  await sourceReviews(directory, fixture.sourceId, keys.map((key, index) => week(key, `第${index}周：我们一起去了海边。`, { words: ['海边'] })));
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT });
  await fixture.service.idle();
  const done = fixture.service.view()!;
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual(done.leftOut?.map(item => ({ kind: item.kind, title: item.title })), [{ kind: 'review', title: `${keys[0]} 起一周的回顾` }]);
  const saved = JSON.parse(await readFile(path.join(directory, 'user-profiles', `review-${userProfileScopeId({ characterId: done.newCardId!, providerScope })}.json`), 'utf8'));
  assert.equal(saved.data.items.length, 3);
  assert.equal(saved.data.items.some((item: ReviewEntry) => item.key === keys[0]), false);
}));

test('conversion reading: a look-back\'s translation is checked against its input; limits grow for English; names must stay in the text', () => {
  const input = { k: 'rw2026-11-02', kind: 'review' as const, v: { text: '去了海边冲浪。', carry: '想学冲浪', words: ['海边', '冲浪'] } };
  assert.deepEqual(readMemoryValue(input, { text: 'We went to the sea and surfed.', carry: 'wants to learn to surf', words: ['sea', 'surf', 'gone'] }, 'en'),
    { text: 'We went to the sea and surfed.', carry: 'wants to learn to surf', words: ['sea', 'surf'] });
  assert.equal(readMemoryValue(input, { text: '', carry: 'x', words: [] }, 'en'), null);
  assert.equal(readMemoryValue(input, { text: 'ok', words: [] }, 'en'), null, 'the line kept for the month must come back too');
  assert.equal(readMemoryValue(input, { text: 'ok', carry: 'x', words: 'sea' }, 'en'), null);
  assert.equal(readMemoryValue({ k: 'rm2026-10', kind: 'review', v: { text: '一月' } }, { text: 'a month', carry: 'extra' }, 'en')!.hasOwnProperty('carry'), false, 'nothing is added that the source did not have');
  const long = readMemoryValue({ k: 'rm2026-10', kind: 'review', v: { text: '一月' } }, { text: 'x '.repeat(900) }, 'en') as { text: string };
  assert.ok(Array.from(long.text).length <= 1200);
  assert.match(memorySystemPrompt('zh-CN', 'en'), /"review" is her own look-back/u);
  assert.match(memoryPrompt([input], 'en', {}), /review text ≤ 1200, carry ≤ 150, each word ≤ 40/u);
  assert.match(memoryPrompt([input], 'zh-CN', {}, undefined, 'en'), /review text ≤ 480, carry ≤ 60, each word ≤ 16/u);
});

test('exporting a character card never carries her look-backs', async () => fixture(async f => {
  const cards = new CharacterCardStore(f.directory, '旧人设');
  const state = await cards.load();
  const own: UserProfileScope = { characterId: state.activeId, providerScope: 'provider-a' };
  const store = new ReviewStore(f.profilesDir, { recording: () => true });
  assert.equal(await store.change(userProfileScopeId(own), current => withWritten(current, week(LAST_WEEK, '只属于你和我的回顾-SENTINEL', { words: ['回顾'] }))), true);
  assert.ok((await readFile(path.join(f.profilesDir, `review-${userProfileScopeId(own)}.json`), 'utf8')).includes('SENTINEL'));
  const exported = cards.export(state.activeId);
  assert.equal(exported.includes('SENTINEL'), false);
  assert.equal(/回顾|review/u.test(exported), false);
  assert.deepEqual(Object.keys(JSON.parse(exported).card).sort(), ['description', 'examples', 'greeting', 'mood', 'name', 'personality', 'scenario', 'slowWarmUp', 'systemPrompt'].sort());
}));

test('the user profile\'s own files are untouched by the look-backs: an old build reads the profile and the diary as ever; she forgets a character with her profile', async () => fixture(async f => {
  await f.diary('2026-11-03', '2026-11-05');
  await f.seed(week(LAST_WEEK));
  await f.profiles.settled();
  const profileBytes = await readFile(path.join(f.profilesDir, `profile-${scopeId}.json`), 'utf8');
  const parsed = JSON.parse(profileBytes);
  assert.deepEqual(Object.keys(parsed).sort(), ['blocked', 'diary', 'entries', 'revision', 'scopeId', 'version']);
  assert.equal(await f.profiles.forgetScope(scope), true);
  assert.deepEqual((await readdir(f.profilesDir)).filter(name => name.startsWith('review-') || name.startsWith('profile-')), [], 'her look-backs go with her profile');
  await mkdir(f.profilesDir, { recursive: true });
}));
