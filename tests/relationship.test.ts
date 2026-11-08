import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MEME_CONTEXT_NOTE, NEUTRAL_TENDENCIES, NICKNAME_ASK_INSTRUCTION, RELATIONSHIP_LIMITS, RELATIONSHIP_STAGES, STAGE_LABELS,
  classifyNicknameReply, cleanNickname, dayNumber, effectiveDays, emptyRelationship, milestoneFor, relationshipOpeningText, relationshipSessionTag,
  sanitizeRelationshipDiagnostic, stageAtLeast, stageFor, stageProgress, stageThresholds, warmUpPace, withBackfill, withQuality, withRound, withTouch,
  type RelationshipData, type RelationshipDiagnostic,
} from '../shared/relationship';
import { RelationshipHost, type RelationshipCard } from '../electron/relationship/host';
import { RelationshipStore, relationshipFileName, validateRelationship } from '../electron/relationship/store';
import { localDateKey } from '../electron/diary/diary-dates';
import { MemoryStore } from '../electron/memory';
import { formatRelationshipLine } from '../src/ui/MoodPanel';

const at = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour).getTime();
const key = (month: number, day: number) => localDateKey(at(month, day));
const scope = (characterId = 'gene', providerScope = 'model-a') => ({ characterId, providerScope });
const nothing = () => ({ first: null, rounds: new Map<string, number>() });

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-relationship-'));
  try { await run(directory); }
  finally {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('soft-relationship-'));
    await rm(directory, { recursive: true, force: true });
  }
}
interface Harness { host: RelationshipHost; clock: { now: number }; card: { value: RelationshipCard | null }; dev: { on: boolean }; lines: string[] }
function harness(directory: string, now = at(10, 1)): Harness {
  const clock = { now }, card: Harness['card'] = { value: null }, dev = { on: false }, lines: string[] = [];
  const host = new RelationshipHost({ directory, now: () => clock.now, developerMode: () => dev.on,
    diagnosticsWrite: async (_file, line) => { lines.push(line); } });
  host.setCardSource(() => card.value);
  return { host, clock, card, dev, lines };
}
const slow = (tendencies = NEUTRAL_TENDENCIES): RelationshipCard => ({ slowWarmUp: true, tendencies: { ...tendencies } });
/** `count` counted days ending on `last`, one per day, through the host's own counting (3 rounds each). */
async function liveDays(h: Harness, firstDay: number, count: number, month = 10) {
  for (let i = 0; i < count; i++) {
    h.clock.now = at(month, firstDay + i);
    for (let round = 0; round < RELATIONSHIP_LIMITS.roundsForDay; round++) await h.host.noteRound('gene');
  }
}

// ---- thresholds and stages ----

test('stage thresholds: 3 / 10 / 30 / 90 days for a neutral card, scaled by the card tendencies', () => {
  assert.deepEqual(stageThresholds(), [3, 10, 30, 90]);
  assert.deepEqual(stageThresholds(NEUTRAL_TENDENCIES), [3, 10, 30, 90]);
  assert.equal(warmUpPace(NEUTRAL_TENDENCIES), 1);
  const cautious = stageThresholds({ ...NEUTRAL_TENDENCIES, cautious: 1.5 });
  const closer = stageThresholds({ ...NEUTRAL_TENDENCIES, close: 1.5 });
  const playful = stageThresholds({ ...NEUTRAL_TENDENCIES, playful: 2, comfortable: 2 });
  cautious.forEach((value, index) => assert.ok(value > [3, 10, 30, 90][index], `cautious ${index}`));
  closer.forEach((value, index) => assert.ok(value < [3, 10, 30, 90][index] || index === 0, `close ${index}`));
  assert.ok(closer[3] < 90 && playful[3] < 90, 'a close or playful card warms up sooner');
  assert.ok(cautious[3] > 90, 'a cautious card takes longer');
  // Always whole, increasing, bounded to between half and twice the base.
  for (const tendencies of [{ playful: 0, close: 0, comfortable: 0, cautious: 4 }, { playful: 4, close: 4, comfortable: 4, cautious: 0 },
    { playful: 1, close: 0.1, comfortable: 1, cautious: 3 }, { playful: 0.5, close: 0.5, comfortable: 0.5, cautious: 0.5 }]) {
    const values = stageThresholds(tendencies);
    assert.equal(values.length, 4);
    values.forEach((value, index) => { assert.ok(Number.isInteger(value) && value >= 1); if (index) assert.ok(value > values[index - 1]); });
    assert.ok(values[3] <= 180 && values[3] >= 45);
  }
});

test('the stage follows the effective days and tells how far the next one is', () => {
  const thresholds = [3, 10, 30, 90];
  const cases: Array<[number, string]> = [[0, 'new'], [2.5, 'new'], [3, 'warming'], [9.5, 'warming'], [10, 'familiar'], [29, 'familiar'], [30, 'close'], [89, 'close'], [90, 'old'], [400, 'old']];
  for (const [days, stage] of cases) assert.equal(stageFor(days, thresholds), stage, String(days));
  assert.deepEqual(stageProgress(0, thresholds), { stage: 'new', next: 'warming', daysToNext: 3 });
  assert.deepEqual(stageProgress(2.5, thresholds), { stage: 'new', next: 'warming', daysToNext: 1 });
  assert.deepEqual(stageProgress(12, thresholds), { stage: 'familiar', next: 'close', daysToNext: 18 });
  assert.deepEqual(stageProgress(120, thresholds), { stage: 'old', next: null, daysToNext: null });
  assert.deepEqual(STAGE_LABELS, { new: '初识', warming: '熟起来', familiar: '熟悉', close: '亲近', old: '老朋友' });
  assert.ok(stageAtLeast('close', 'familiar') && stageAtLeast('familiar', 'familiar') && !stageAtLeast('warming', 'familiar'));
});

// ---- counting days ----

test('a day counts once however much happens; three rounds, or one round with a touch', () => {
  let data = emptyRelationship('2026-10-01');
  data = withRound(data, '2026-10-01'); data = withRound(data, '2026-10-01');
  assert.deepEqual(data.days, [], 'two rounds are not a day');
  data = withRound(data, '2026-10-01');
  assert.deepEqual(data.days, ['2026-10-01']);
  for (let i = 0; i < 50; i++) { data = withRound(data, '2026-10-01'); data = withTouch(data, '2026-10-01'); }
  assert.deepEqual(data.days, ['2026-10-01'], 'spamming the same day never adds another');
  // A touch alone is nothing; a touch plus one round is a day, in either order.
  let touched = withTouch(emptyRelationship('2026-10-02'), '2026-10-02');
  assert.deepEqual(touched.days, []);
  touched = withRound(touched, '2026-10-02');
  assert.deepEqual(touched.days, ['2026-10-02']);
  let chatFirst = withRound(emptyRelationship('2026-10-03'), '2026-10-03');
  assert.deepEqual(chatFirst.days, []);
  chatFirst = withTouch(chatFirst, '2026-10-03');
  assert.deepEqual(chatFirst.days, ['2026-10-03']);
  // A new day starts its own tally; yesterday's rounds do not carry over.
  let split = withRound(withRound(emptyRelationship('2026-10-04'), '2026-10-04'), '2026-10-04');
  split = withRound(split, '2026-10-05');
  assert.deepEqual(split.days, []);
  assert.equal(split.today.rounds, 1);
});

test('days only ever go up: no decay, no punishment, a long silence changes nothing', () => {
  let data = emptyRelationship('2026-01-01');
  let previous = 0, previousStage = 0;
  const thresholds = stageThresholds();
  let state = 12345;
  const random = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let step = 0; step < 600; step++) {
    const day = new Date(Date.UTC(2026, 0, 1 + Math.floor(step / 3))).toISOString().slice(0, 10);
    const roll = random();
    data = roll < 0.6 ? withRound(data, day) : roll < 0.8 ? withTouch(data, day) : withQuality(data, day);
    const days = effectiveDays(data);
    assert.ok(days >= previous, `step ${step}`);
    const stage = RELATIONSHIP_STAGES.indexOf(stageFor(days, thresholds));
    assert.ok(stage >= previousStage);
    previous = days; previousStage = stage;
  }
  assert.deepEqual(withBackfill(data, 'again', null, new Map()).days, data.days, 'a scan that finds nothing changes nothing');
  assert.ok(effectiveDays(withBackfill(data, 'older', '2025-01-01', new Map([['2025-02-02', 1]]))) >= effectiveDays(data));
});

test('quality moments add a little, only on days that counted, and the bonus is capped', () => {
  let data = emptyRelationship('2026-10-01');
  data = withQuality(data, '2026-10-01');
  assert.equal(effectiveDays(data), 0, 'a quality moment on a day that did not count is nothing');
  for (let i = 1; i <= 40; i++) {
    const date = `2026-${i <= 30 ? '10' : '11'}-${String(i <= 30 ? i : i - 30).padStart(2, '0')}`;
    data = withQuality(withRound(withRound(withRound(data, date), date), date), date);
  }
  assert.equal(data.days.length, 40);
  assert.equal(effectiveDays(data), 40 + RELATIONSHIP_LIMITS.qualityCap, 'forty quality days cannot add more than the cap');
  const once = withQuality(withQuality(data, '2026-10-02'), '2026-10-02');
  assert.equal(once.qualityDays.length, data.qualityDays.length, 'one day is one quality day');
});

test('the day number and the milestone days (7, 30, 100, 365, then every anniversary)', () => {
  assert.equal(dayNumber('2026-10-01', '2026-10-01'), 1);
  assert.equal(dayNumber('2026-10-01', '2026-10-07'), 7);
  assert.equal(dayNumber('2026-10-01', '2027-10-01'), 366);
  assert.equal(dayNumber('2026-10-01', '2026-09-01'), 1, 'never below 1');
  assert.equal(milestoneFor('2026-10-01', '2026-10-01'), null);
  assert.equal(milestoneFor('2026-10-01', '2026-10-06'), null);
  assert.equal(milestoneFor('2026-10-01', '2026-10-07')?.text, '今天是你们认识的第 7 天');
  assert.equal(milestoneFor('2026-10-01', '2026-10-30')?.key, 'day-30');
  assert.equal(milestoneFor('2026-10-01', '2027-01-08')?.key, 'day-100');
  assert.equal(milestoneFor('2026-10-01', '2027-09-30')?.key, 'day-365');
  assert.equal(milestoneFor('2026-10-01', '2027-10-01')?.key, 'year-1');
  assert.equal(milestoneFor('2026-10-01', '2028-10-01')?.text, '今天是你们认识的纪念日（满 2 年）');
  assert.equal(milestoneFor('2026-10-01', '2027-04-01'), null);
});

test('backfill takes the earliest chat as the day they met and counts the days with enough rounds, once per chat scope', () => {
  const base = emptyRelationship('2026-11-02');
  const rounds = new Map([['2026-09-10', 4], ['2026-09-11', 1], ['2026-09-12', 3], ['2026-11-02', 2]]);
  const filled = withBackfill(base, 'scope-a', '2026-09-10', rounds);
  assert.equal(filled.metDate, '2026-09-10');
  assert.deepEqual(filled.days, ['2026-09-10', '2026-09-12']);
  assert.equal(filled.today.rounds, 2, 'rounds already chatted today carry into the live tally');
  assert.deepEqual(filled.backfilled, ['scope-a']);
  assert.strictEqual(withBackfill(filled, 'scope-a', '2020-01-01', new Map([['2020-01-01', 9]])), filled, 'the same scope is never counted twice');
  const other = withBackfill(filled, 'scope-b', '2026-09-20', new Map([['2026-09-20', 5]]));
  assert.equal(other.metDate, '2026-09-10', 'a later chat never moves the meeting day forward');
  assert.deepEqual(other.days, ['2026-09-10', '2026-09-12', '2026-09-20']);
});

// ---- nickname words ----

test('nicknames: short plain text only', () => {
  assert.equal(cleanNickname('  小糖 '), '小糖');
  assert.equal(cleanNickname('阿棠'), '阿棠');
  for (const bad of ['', '   ', '九个字的称呼太长了啊', 'a<b', '"引号"', 'x/y', 'C:\\Users', 'a@b', '{x}', '\u0000x', '\u202Eabc', 7, null, undefined, {}]) assert.equal(cleanNickname(bad), null, String(bad));
});

test('only a short plain yes saves a nickname; a no, a longer answer or a new subject saves nothing', () => {
  for (const yes of ['好', '好的', '好呀', '好啊！', '可以', '可以呀~', '行', '当然可以', '嗯嗯', ' 好 ', '好。', 'OK', 'ok', '好的，', '同意']) assert.equal(classifyNicknameReply(yes), 'affirm', yes);
  for (const no of ['不', '不要', '不用了', '算了', '不行', '不想', '还是不要了', '别', 'no']) assert.equal(classifyNicknameReply(no), 'refuse', no);
  for (const other of ['', '好累啊今天', '你吃饭了吗', '好，不过我想想', '随便', '叫我老王吧', '哈哈', '嗯？', '好好好好好好好好好好好好好好好好好好好好好好好好好', '好\n不好', 5, null, undefined])
    assert.equal(classifyNicknameReply(other), 'unknown', String(other));
});

// ---- wording ----

test('default opening: day number, no stage, familiar from day one; warm-up adds the stage and its manner', () => {
  const off = relationshipOpeningText({ dayNumber: 1, slowWarmUp: false });
  assert.match(off, /你们认识第 1 天/);
  assert.match(off, /从一开始就和用户很熟，不客气、不装生/);
  assert.doesNotMatch(off, /现在的关系|初识|熟起来|关系阶段/);
  // An off card never shows a stage even if one is passed.
  assert.equal(relationshipOpeningText({ dayNumber: 40, slowWarmUp: false, stage: 'new' }).includes('初识'), false);
  const stages = RELATIONSHIP_STAGES.map(stage => relationshipOpeningText({ dayNumber: 5, slowWarmUp: true, stage }));
  assert.equal(new Set(stages).size, 5, 'each stage has its own manner');
  stages.forEach((text, index) => {
    assert.ok(text.includes(`现在的关系：${STAGE_LABELS[RELATIONSHIP_STAGES[index]]}`));
    assert.match(text, /按你自己的性格自然体现/);
    assert.doesNotMatch(text, /从一开始就和用户很熟/);
  });
  assert.match(stages[0], /不装熟/);
  assert.match(stages[2], /逗用户/);
  // Nickname and milestone are independent of the switch.
  for (const slowWarmUp of [false, true]) {
    const text = relationshipOpeningText({ dayNumber: 30, slowWarmUp, ...(slowWarmUp ? { stage: 'close' as const } : {}), nickname: '小糖', milestone: milestoneFor('2026-10-01', '2026-10-30') });
    assert.match(text, /用户同意你这样称呼用户：“小糖”/);
    assert.match(text, /今天是你们认识的第 30 天，可以自然地提一句，不强求/);
  }
  // Never "他/她" for the user.
  for (const text of [off, ...stages, NICKNAME_ASK_INSTRUCTION, MEME_CONTEXT_NOTE]) assert.doesNotMatch(text, /[他她]/u, text.slice(0, 20));
});

test('the session tag changes with the switch, the stage and the nickname, never with the day number', () => {
  const base = { slowWarmUp: false, nickname: null };
  assert.equal(relationshipSessionTag(base), relationshipSessionTag({ ...base, stage: 'close' }), 'an off card has no stage');
  assert.notEqual(relationshipSessionTag(base), relationshipSessionTag({ slowWarmUp: true, stage: 'new', nickname: null }));
  assert.notEqual(relationshipSessionTag({ slowWarmUp: true, stage: 'new', nickname: null }), relationshipSessionTag({ slowWarmUp: true, stage: 'warming', nickname: null }));
  assert.notEqual(relationshipSessionTag(base), relationshipSessionTag({ ...base, nickname: '小糖' }));
  assert.equal(relationshipSessionTag({ slowWarmUp: false, nickname: null }), 'off|');
});

// ---- the file ----

test('the file store: one file per character, survives a restart, ignores nothing it cannot read', async () => {
  await withDirectory(async directory => {
    const today = '2026-10-01';
    const store = new RelationshipStore(directory, { today: () => today });
    assert.equal(store.peek('gene'), null);
    await store.update('gene', data => withRound(withRound(withRound(data, today), today), today));
    const file = path.join(directory, 'relationship', 'gene.json');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).days, [today]);
    const again = new RelationshipStore(directory, { today: () => '2026-12-01' });
    const loaded = await again.load('gene');
    assert.deepEqual(loaded.days, [today]);
    assert.equal(loaded.metDate, today);
    // A character id that is not a plain token still gets a safe file name.
    assert.match(relationshipFileName('../../evil name'), /^[a-f0-9]{64}\.json$/);
    assert.equal(relationshipFileName('abc-123_X'), 'abc-123_X.json');
    assert.throws(() => relationshipFileName(''));
    // A damaged file is never overwritten.
    await mkdir(path.join(directory, 'relationship'), { recursive: true });
    const broken = path.join(directory, 'relationship', 'broken.json');
    await writeFile(broken, '{"version":1,"oops":true}');
    const third = new RelationshipStore(directory, { today: () => today });
    await third.update('broken', data => withRound(data, today));
    assert.equal(await readFile(broken, 'utf8'), '{"version":1,"oops":true}');
    assert.equal(third.peek('broken')?.today.rounds, 1, 'it keeps counting in memory');
    assert.throws(() => validateRelationship({ ...emptyRelationship(today), extra: 1 }));
    assert.throws(() => validateRelationship({ ...emptyRelationship(today), metDate: '2026-13-40' }));
  });
});

test('a character nobody has chatted with starts counting on the day of the first chat, however long the app was open before', async () => {
  await withDirectory(async directory => {
    const h = harness(directory, at(10, 1));
    await h.host.ensure('gene'); // The app opened on the 1st with this character active ...
    assert.equal(h.host.view('gene')?.dayNumber, 1);
    h.clock.now = at(10, 5); // ... and the first chat is only on the 5th.
    await h.host.prepare(scope(), nothing);
    assert.equal(h.host.view('gene')?.dayNumber, 1, 'day 1 is the day of the first chat');
    await liveDays(h, 5, 1);
    h.clock.now = at(10, 6);
    assert.equal(h.host.view('gene')?.dayNumber, 2);
    // A character that already has history keeps its meeting day.
    const old = harness(directory + '-old', at(9, 1));
    await old.host.prepare(scope('old'), nothing);
    await liveDays(old, 1, 1, 9);
    old.clock.now = at(10, 1);
    await old.host.prepare(scope('old', 'model-b'), nothing);
    assert.equal(old.host.view('old')?.dayNumber, 31);
    await rm(directory + '-old', { recursive: true, force: true });
  });
});

test('the same relationship file is used across chat models: switching the model never starts over', async () => {
  await withDirectory(async directory => {
    const h = harness(directory);
    await h.host.prepare(scope('gene', 'model-a'), nothing);
    await liveDays(h, 1, 4);
    assert.equal(h.host.view('gene')?.togetherDays, 4);
    await h.host.prepare(scope('gene', 'model-b'), nothing);
    assert.equal(h.host.view('gene')?.togetherDays, 4, 'a second chat model does not reset the numbers');
    assert.equal(h.host.view('gene')?.dayNumber, 4);
    const restarted = harness(directory, at(10, 4));
    await restarted.host.prepare(scope('gene', 'model-c'), nothing);
    assert.equal(restarted.host.view('gene')?.togetherDays, 4);
    assert.deepEqual((await readdir(path.join(directory, 'relationship'))).sort(), ['gene.json']);
  });
});

test('older chats are counted once, from the earliest message of that character', async () => {
  await withDirectory(async directory => {
    const memory = new MemoryStore(directory);
    await memory.load();
    const s = scope('gene', 'model-a');
    const chat = async (id: string, when: number) => {
      await memory.beginTurn(s, { id, userText: `你好 ${id}`, at: when, conversationId: `c-${id}` });
      await memory.appendAssistant(s, id, '你好呀', when + 1000);
      await memory.finishTurn(s, id, 'complete', when + 2000);
    };
    // Three chat days: 40 days ago (4 rounds), 39 days ago (1 round), 30 days ago (3 rounds).
    const dayOne = at(9, 22, 10);
    for (let i = 0; i < 4; i++) await chat(`a${i}`, dayOne + i * 60_000);
    await chat('b0', dayOne + 86_400_000);
    for (let i = 0; i < 3; i++) await chat(`c${i}`, dayOne + 10 * 86_400_000 + i * 60_000);
    const activity = memory.chatActivity(s, ms => localDateKey(ms));
    assert.equal(activity.first, dayOne);
    assert.equal([...activity.rounds.values()].reduce((a, b) => a + b, 0), 8);
    assert.equal(memory.chatActivity(scope('gene', 'model-b'), ms => localDateKey(ms)).first, null, 'another chat model has its own archive');
    const h = harness(directory, at(11, 2));
    await h.host.prepare(s, dayOf => memory.chatActivity(s, dayOf));
    const view = h.host.view('gene')!;
    assert.equal(view.dayNumber, dayNumber(localDateKey(dayOne), key(11, 2)));
    assert.equal(view.togetherDays, 2, 'only the two days with three or more rounds');
    await h.host.prepare(s, dayOf => memory.chatActivity(s, dayOf));
    assert.equal(h.host.view('gene')?.togetherDays, 2, 'a second scan of the same scope adds nothing');
  });
});

// ---- the host ----

test('default (switch off, or an older card without the field): no stage line, familiar from the first day', async () => {
  await withDirectory(async directory => {
    for (const card of [null, { slowWarmUp: false, tendencies: { ...NEUTRAL_TENDENCIES } }]) {
      const h = harness(directory + (card ? '-b' : '-a'));
      h.card.value = card;
      await h.host.prepare(scope(), nothing);
      const opening = h.host.opening('gene', { firstTurn: true })!;
      assert.match(opening.text, /你们认识第 1 天/);
      assert.doesNotMatch(opening.text, /现在的关系|初识|熟起来|熟悉|亲近|老朋友/);
      assert.equal(h.host.stage('gene'), null);
      assert.equal(h.host.memesAllowed('gene'), true, 'memes from the first day');
      assert.equal(h.host.view('gene')?.stage, undefined);
      assert.equal(opening.tag, 'off|');
      // The nickname question is possible from the start (after two rounds on the first day).
      assert.equal(h.host.nicknameAsk('gene', { conversationId: 'c1', userState: null }), false, 'not in the first exchange');
      await h.host.noteRound('gene'); await h.host.noteRound('gene');
      assert.equal(h.host.nicknameAsk('gene', { conversationId: 'c1', userState: null }), true);
    }
    await rm(directory + '-a', { recursive: true, force: true }); await rm(directory + '-b', { recursive: true, force: true });
  });
});

test('switching it on works out the stage from the days already together; switching off is immediate', async () => {
  await withDirectory(async directory => {
    const h = harness(directory);
    await h.host.prepare(scope(), nothing);
    await liveDays(h, 1, 12);
    assert.equal(h.host.stage('gene'), null, 'off: no stage');
    h.card.value = slow();
    assert.equal(h.host.stage('gene'), 'familiar', '12 days is already 熟悉, not 初识');
    const on = h.host.opening('gene', { firstTurn: false })!;
    assert.match(on.text, /现在的关系：熟悉/);
    assert.equal(on.memes, true);
    assert.notEqual(on.tag, 'off|');
    h.card.value = { slowWarmUp: false, tendencies: { ...NEUTRAL_TENDENCIES } };
    const off = h.host.opening('gene', { firstTurn: false })!;
    assert.doesNotMatch(off.text, /现在的关系|熟悉/);
    assert.equal(off.tag, 'off|');
    // A cautious card is still at an earlier stage with the same twelve days.
    h.card.value = slow({ playful: 1, close: 1, comfortable: 1, cautious: 1.8 });
    assert.equal(h.host.stage('gene'), 'warming');
  });
});

test('slowly warming: memes wait for 熟悉, the nickname question waits for 熟起来; the default allows both at once', async () => {
  await withDirectory(async directory => {
    const h = harness(directory);
    h.card.value = slow();
    await h.host.prepare(scope(), nothing);
    await h.host.noteRound('gene'); await h.host.noteRound('gene');
    assert.equal(h.host.stage('gene'), 'new');
    assert.equal(h.host.memesAllowed('gene'), false);
    assert.equal(h.host.nicknameAsk('gene', { conversationId: 'c1', userState: null }), false, 'first met: no nickname question');
    await liveDays(h, 2, 3); // days 2-4: three counted days with day 1 still partial
    h.clock.now = at(10, 4);
    await h.host.noteRound('gene'); await h.host.noteRound('gene');
    assert.equal(h.host.stage('gene'), 'warming');
    assert.equal(h.host.memesAllowed('gene'), false);
    assert.equal(h.host.nicknameAsk('gene', { conversationId: 'c2', userState: null }), true, 'from 熟起来 she may ask');
    await liveDays(h, 5, 8);
    assert.equal(h.host.stage('gene'), 'familiar');
    assert.equal(h.host.memesAllowed('gene'), true);
  });
});

test('milestones: said once on the day, in the first conversation of that day only', async () => {
  await withDirectory(async directory => {
    const h = harness(directory, at(10, 1));
    await h.host.prepare(scope(), nothing);
    h.clock.now = at(10, 6);
    assert.doesNotMatch(h.host.opening('gene', { firstTurn: true })!.text, /认识的第/);
    h.clock.now = at(10, 7);
    assert.doesNotMatch(h.host.opening('gene', { firstTurn: false })!.text, /今天是你们认识的第 7 天/, 'not on a later turn of a conversation');
    const first = h.host.opening('gene', { firstTurn: true })!;
    assert.match(first.text, /你们认识第 7 天/);
    assert.match(first.text, /今天是你们认识的第 7 天，可以自然地提一句，不强求/);
    await h.host.flush();
    assert.doesNotMatch(h.host.opening('gene', { firstTurn: true })!.text, /今天是你们认识的第 7 天/, 'already mentioned today, even in a new conversation');
    // It survives a restart (the file remembers), and the next milestone is a different day.
    const restarted = harness(directory, at(10, 7));
    await restarted.host.prepare(scope(), nothing);
    assert.doesNotMatch(restarted.host.opening('gene', { firstTurn: true })!.text, /今天是你们认识的第 7 天/);
    restarted.clock.now = at(10, 30);
    assert.match(restarted.host.opening('gene', { firstTurn: true })!.text, /今天是你们认识的第 30 天/);
    restarted.clock.now = at(10, 8);
    assert.doesNotMatch(restarted.host.opening('gene', { firstTurn: true })!.text, /认识的第 \d+ 天，可以自然/);
    // Milestones do not depend on the warm-up switch.
    restarted.card.value = slow();
    restarted.clock.now = at(12, 9); // day 70... not a milestone
    assert.doesNotMatch(restarted.host.opening('gene', { firstTurn: true })!.text, /可以自然地提一句/);
  });
});

test('the nickname question: asked at most once; only the very next plain yes saves it', async () => {
  await withDirectory(async directory => {
    const ask = async (h: Harness, conversation: string) => {
      await h.host.noteRound('gene'); await h.host.noteRound('gene');
      return h.host.nicknameAsk('gene', { conversationId: conversation, userState: null });
    };
    // A plain yes saves it, and it then shows in the opening lines.
    const yes = harness(directory + '-yes');
    await yes.host.prepare(scope(), nothing);
    assert.equal(await ask(yes, 'c1'), true);
    assert.equal(yes.host.nicknameAsk('gene', { conversationId: 'c1', userState: null }), false, 'at most once per conversation');
    yes.host.captureNicknameAsk('gene', 'c1', '小糖');
    assert.equal(yes.host.nickname('gene'), null, 'asking saves nothing');
    assert.equal(await yes.host.resolveNickname('gene', 'c1', '好呀'), 'saved');
    assert.equal(yes.host.nickname('gene'), '小糖');
    assert.match(yes.host.opening('gene', { firstTurn: false })!.text, /“小糖”/);
    assert.equal(yes.host.nicknameAsk('gene', { conversationId: 'c9', userState: null }), false, 'once saved she does not ask again');
    // Saved to disk.
    assert.equal(JSON.parse(await readFile(path.join(directory + '-yes', 'relationship', 'gene.json'), 'utf8')).nickname, '小糖');

    // A refusal saves nothing and she never asks again, today or in any later conversation.
    const no = harness(directory + '-no');
    await no.host.prepare(scope(), nothing);
    assert.equal(await ask(no, 'c1'), true);
    no.host.captureNicknameAsk('gene', 'c1', '小糖');
    assert.equal(await no.host.resolveNickname('gene', 'c1', '不要'), 'declined');
    assert.equal(no.host.nickname('gene'), null);
    for (const day of [2, 3, 20]) {
      no.clock.now = at(10, day);
      await no.host.noteRound('gene'); await no.host.noteRound('gene');
      assert.equal(no.host.nicknameAsk('gene', { conversationId: `later-${day}`, userState: null }), false);
    }

    // A different subject saves nothing, and a later yes does not count: only the very next message answers the question.
    const topic = harness(directory + '-topic');
    await topic.host.prepare(scope(), nothing);
    await ask(topic, 'c1');
    topic.host.captureNicknameAsk('gene', 'c1', '小糖');
    assert.equal(await topic.host.resolveNickname('gene', 'c1', '今天加班好累'), 'ignored');
    assert.equal(await topic.host.resolveNickname('gene', 'c1', '好'), null, 'the question is already gone');
    assert.equal(topic.host.nickname('gene'), null);

    // Silence: the conversation changed (or another character) before any answer.
    const silent = harness(directory + '-silent');
    await silent.host.prepare(scope(), nothing);
    await ask(silent, 'c1');
    silent.host.captureNicknameAsk('gene', 'c1', '小糖');
    assert.equal(await silent.host.resolveNickname('gene', 'c2', '好'), 'ignored');
    assert.equal(silent.host.nickname('gene'), null);
    const dropped = harness(directory + '-dropped');
    await dropped.host.prepare(scope(), nothing);
    await ask(dropped, 'c1');
    dropped.host.captureNicknameAsk('gene', 'c1', '小糖');
    dropped.host.dropPendingNickname();
    assert.equal(await dropped.host.resolveNickname('gene', 'c1', '好'), null);
    assert.equal(dropped.host.nickname('gene'), null);
    // A nickname that is not plain text is never even proposed.
    const odd = harness(directory + '-odd');
    await odd.host.prepare(scope(), nothing);
    await ask(odd, 'c1');
    odd.host.captureNicknameAsk('gene', 'c1', '<script>');
    assert.equal(await odd.host.resolveNickname('gene', 'c1', '好'), null);
    for (const suffix of ['yes', 'no', 'topic', 'silent', 'dropped', 'odd']) await rm(`${directory}-${suffix}`, { recursive: true, force: true });
  });
});

test('the nickname question is not asked while she reads the user as low, annoyed or tired, or on the first exchange of a day', async () => {
  await withDirectory(async directory => {
    const h = harness(directory);
    await h.host.prepare(scope(), nothing);
    await h.host.noteRound('gene'); await h.host.noteRound('gene');
    for (const state of ['low', 'annoyed', 'tired']) assert.equal(h.host.nicknameAsk('gene', { conversationId: 'c1', userState: state }), false, state);
    assert.equal(h.host.nicknameAsk('gene', { conversationId: 'c1', userState: 'happy' }), true);
  });
});

test('the profile panel can change and delete the nickname; deleting never makes her ask again', async () => {
  await withDirectory(async directory => {
    const h = harness(directory);
    await h.host.prepare(scope(), nothing);
    assert.equal(await h.host.setNickname('gene', '  阿满 '), '阿满');
    assert.equal(h.host.nickname('gene'), '阿满');
    await assert.rejects(() => h.host.setNickname('gene', '这个称呼实在是太长太长了'));
    await assert.rejects(() => h.host.setNickname('gene', 5));
    assert.equal(await h.host.setNickname('gene', null), null);
    assert.equal(h.host.nickname('gene'), null);
    await h.host.noteRound('gene'); await h.host.noteRound('gene');
    assert.equal(h.host.nicknameAsk('gene', { conversationId: 'c1', userState: null }), false);
  });
});

test('quality moments and diary days only count on days that counted; they raise the effective days', async () => {
  await withDirectory(async directory => {
    const h = harness(directory);
    await h.host.prepare(scope(), nothing);
    await liveDays(h, 1, 2);
    await h.host.noteQuality('gene', key(10, 1));
    await h.host.noteQuality('gene', key(10, 1));
    await h.host.noteQuality('gene', key(10, 20)); // a diary for a day that did not count
    const view = h.host.view('gene')!;
    assert.equal(view.togetherDays, 2);
    assert.equal(view.qualityDays, 1);
    assert.equal(view.effectiveDays, 2.5);
  });
});

test('developer mode: the stage can be set by hand until restart; outside it, never', async () => {
  await withDirectory(async directory => {
    const h = harness(directory);
    h.card.value = slow();
    await h.host.prepare(scope(), nothing);
    assert.throws(() => h.host.setStageOverride('familiar'), /开发者模式/);
    assert.equal(h.host.stage('gene'), 'new');
    h.dev.on = true;
    h.host.setStageOverride('familiar');
    assert.equal(h.host.stage('gene'), 'familiar');
    assert.equal(h.host.memesAllowed('gene'), true);
    assert.equal(h.host.view('gene')?.overridden, true);
    assert.equal(h.host.view('gene')?.stage, 'familiar');
    assert.match(h.host.opening('gene', { firstTurn: false })!.text, /现在的关系：熟悉/);
    assert.throws(() => h.host.setStageOverride('legendary'));
    h.dev.on = false;
    assert.equal(h.host.stage('gene'), 'new', 'leaving developer mode drops it');
    h.dev.on = true;
    h.host.setStageOverride(null);
    assert.equal(h.host.stage('gene'), 'new');
    // A new host (a restart) starts without it.
    h.host.setStageOverride('close');
    const restarted = harness(directory); restarted.dev.on = true; restarted.card.value = slow();
    await restarted.host.prepare(scope(), nothing);
    assert.equal(restarted.host.stage('gene'), 'new');
  });
});

test('diagnostics: developer mode only, and only a time, a kind and numbers', async () => {
  await withDirectory(async directory => {
    const h = harness(directory);
    h.card.value = slow();
    await h.host.prepare(scope(), nothing);
    await liveDays(h, 1, 3);
    assert.deepEqual(h.lines, [], 'nothing is written outside developer mode');
    h.dev.on = true;
    await liveDays(h, 4, 1);
    await h.host.setNickname('gene', '小糖秘密');
    await h.host.noteQuality('gene');
    await h.host.flush();
    assert.ok(h.lines.length >= 3);
    const entries = h.lines.map(line => JSON.parse(line) as RelationshipDiagnostic);
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort().filter(name => name !== 'stage'), ['at', 'dayNumber', 'kind', 'qualityDays', 'togetherDays']);
      assert.ok(Number.isSafeInteger(entry.at) && Number.isSafeInteger(entry.dayNumber));
    }
    assert.ok(entries.some(entry => entry.kind === 'day'), 'a counted day is recorded');
    assert.ok(entries.some(entry => entry.kind === 'nickname-changed'));
    assert.ok(entries.some(entry => entry.stage === 'warming'));
    assert.equal(h.lines.join('').includes('小糖'), false, 'never the nickname');
    assert.equal(h.lines.join('').includes('2026-'), false, 'never a date string either');
    assert.equal(sanitizeRelationshipDiagnostic({ at: 1, kind: 'day', dayNumber: 1, togetherDays: 0, qualityDays: 0, extra: '小糖' })?.hasOwnProperty('extra'), false);
    assert.equal(sanitizeRelationshipDiagnostic({ at: 1, kind: 'oops', dayNumber: 1, togetherDays: 0, qualityDays: 0 }), null);
    assert.equal(sanitizeRelationshipDiagnostic({ at: -1, kind: 'day', dayNumber: 1, togetherDays: 0, qualityDays: 0 }), null);
  });
});

test('the developer panel line: numbers, and a stage only when the card warms up slowly', () => {
  assert.equal(formatRelationshipLine(undefined), '关系：暂无数据');
  const off = formatRelationshipLine({ dayNumber: 12, togetherDays: 9, qualityDays: 2, effectiveDays: 10, slowWarmUp: false, hasNickname: false, nicknameAsked: false });
  assert.equal(off, '关系：认识第 12 天 · 相处 9 天（有质量 2 天，折算 10） · 慢慢升温：关（从第一天起就很熟）');
  const on = formatRelationshipLine({ dayNumber: 12, togetherDays: 9, qualityDays: 2, effectiveDays: 10, slowWarmUp: true, stage: 'familiar', nextStage: 'close', daysToNext: 20,
    thresholds: [3, 10, 30, 90], hasNickname: true, nicknameAsked: true });
  assert.match(on, /慢慢升温：开 · 阶段：熟悉，再过 20 天到亲近/);
  assert.doesNotMatch(on, /小糖/);
  const by = formatRelationshipLine({ dayNumber: 2, togetherDays: 0, qualityDays: 0, effectiveDays: 0, slowWarmUp: true, stage: 'familiar', overridden: true, hasNickname: false, nicknameAsked: false });
  assert.match(by, /阶段：熟悉（手动设置，重启后恢复）/);
});
