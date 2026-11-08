/**
 * #5 回复说完以后气泡留多久 (shared/behaviors/reply-linger/): the readable floor, waiting for you, her mood and card, the range,
 * the small randomness, the real "why", one knob, and the contract every host implementation (real and fake) keeps.
 * REPLY_LINGER_REPORT=1 prints the scenes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { REPLY_LINGER_KNOBS, type ReplyLingerKnobs } from '../shared/behaviors/reply-linger/knobs';
import { chooseReplyLinger, lastBubble, readableChars, ReplyLingerDirector, replyLingerMood, replyLingerNow, waitingForYou } from '../shared/behaviors/reply-linger/choose';
import { FakeReplyLingerHost } from '../shared/behaviors/reply-linger/fake';
import { readReplyLingerAnswer, replyLingerLongestMs, safeLingerMs } from '../shared/behaviors/reply-linger/perform';
import type { ReplyLingerBubble, ReplyLingerHost, ReplyLingerMood } from '../shared/behaviors/reply-linger/interface';
import { replyPieces } from '../shared/reply-bubbles';
import { formatReplyBubbles } from '../shared/reply-segments';
import { formatReplyLingerLines } from '../src/ui/MoodPanel';
import { seeded } from './helpers/seeded';

const report = !!process.env.REPLY_LINGER_REPORT;
const [SHORTEST, LONGEST] = REPLY_LINGER_KNOBS.range;
const chat = (text: string): ReplyLingerBubble => ({ text, pieces: replyPieces(text), segmented: false });
const mood = (primary: ReplyLingerMood['mood'], extra: Partial<Parameters<typeof replyLingerMood>[0]> = {}) =>
  replyLingerMood({ snapshot: { primary, companion: null }, personality: null, ...extra });
const CALM = mood('calm');
const at = (bubble: ReplyLingerBubble, m: ReplyLingerMood | null, roll: number, knobs: ReplyLingerKnobs = REPLY_LINGER_KNOBS) =>
  chooseReplyLinger(replyLingerNow(bubble, m, knobs), () => roll, knobs);

test('what counts as a character to read: Han, kana and emoji 1 each, three letters 1, punctuation and spaces 0', () => {
  assert.equal(readableChars('嗯。'), 1);
  assert.equal(readableChars('好呀，那我们明天见！'), 8);
  assert.equal(readableChars('ありがとう'), 5);
  assert.equal(readableChars('👍🏻 ～～ ……'), 1, 'one combined emoji is one');
  assert.equal(readableChars('see you'), 2, '6 letters');
  assert.equal(readableChars('   \n\t'), 0);
});

test('her last bubble: the last R27 piece with words (a trailing emoji piece rides along), a proactive paragraph, or the whole text', () => {
  assert.equal(lastBubble(chat('第一句。第二句很长很长。你今天累不累？')), '你今天累不累？');
  assert.equal(lastBubble(chat('第一句。你今天累不累？\n～')), '你今天累不累？\n～', 'a piece without words joins the sentence before it');
  assert.equal(lastBubble({ text: formatReplyBubbles('我看到你在写代码。要不要休息一下？'), pieces: null, segmented: true }), '要不要休息一下？');
  assert.equal(lastBubble({ text: '一个气泡。里面两句。', pieces: null, segmented: false }), '一个气泡。里面两句。', 'one bubble is read whole');
  assert.equal(lastBubble({ text: '第一句。第二句。', pieces: { mode: 'bubbles', ends: [3, 99] }, segmented: false }), '第一句。第二句。', 'pieces that do not fit the text are ignored');
  assert.equal(lastBubble({ text: '  ', pieces: null, segmented: false }), '');
});

test('waiting for you: she asks, or hands the word to you; the smallest reading, with its known limits', () => {
  for (const text of ['你今天累不累？', '真的吗……', '要不要一起看？😊', '你还好吗～', 'Are you okay?', '你在干嘛呀？(｡･ω･｡)'])
    assert.equal(waitingForYou(text), 'question', text);
  for (const text of ['那你呢～', '跟我说说吧。', '有什么事都可以告诉我。', '说来听听！', '轮到你了', '我等你哦', 'Your turn!'])
    assert.equal(waitingForYou(text), 'handover', text);
  for (const text of ['是吗，那我就放心了。', '我在想你呢。', '走吧。', '你告诉我的那件事我记着呢。', '我等你回来。', '没什么。', ''])
    assert.equal(waitingForYou(text), null, text);
});

test('short and long: a one-word reply leaves soon, a long last bubble stays long enough to read, never shorter than the floor', () => {
  const short = at(chat('好呀。嗯。'), CALM, 0.5), long = at(chat('今天天气很好，我在窗边晒太阳，看着楼下的猫走来走去，想起你说过的那家咖啡店。'), CALM, 0.5);
  if (report) console.log(`嗯 ${short.ms} ms / 34 字 ${long.ms} ms`);
  assert.ok(short.ms >= SHORTEST && short.ms < 3500, `${short.ms}`);
  assert.ok(long.ms > 8000 && long.ms < 9500, `${long.ms}`);
  // The floor: notice + characters at the knob's reading speed, never cut by mood.
  const floor = REPLY_LINGER_KNOBS.readable.noticeMs + 34 / REPLY_LINGER_KNOBS.readable.charsPerSecond * 1000;
  assert.equal(long.readMs, Math.round(floor));
  for (const m of [CALM, mood('excited', { snapshot: { primary: 'excited', companion: 'playful' }, personality: { playful: 4 } }), mood('upset')])
    for (const roll of [0, 0.5, 0.999]) assert.ok(at(chat('今天天气很好，我在窗边晒太阳，看着楼下的猫走来走去，想起你说过的那家咖啡店。'), m, roll).ms >= floor);
  // Too long for one bubble: held to the longest, and the why says where the rest is.
  const essay = at(chat('这是一段很长的话'.repeat(14) + '。'), CALM, 0.5);
  assert.equal(essay.ms, LONGEST); assert.match(essay.why.at(-1)!, /查看完整回复/);
});

test('waiting for you stays longer than the same length said as a statement, for every roll and mood', () => {
  for (const m of [CALM, mood('happy'), mood('longing')]) for (const roll of [0, 0.3, 0.7, 0.999]) {
    const statement = at(chat('今天工作很累的样子。'), m, roll), question = at(chat('今天工作累不累呀？'), m, roll), handover = at(chat('我先说完啦，你呢～'), m, roll);
    assert.ok(question.ms - statement.ms >= 1200, `question ${question.ms} vs ${statement.ms}`);
    assert.ok(handover.ms - statement.ms >= 800, `handover ${handover.ms} vs ${statement.ms}`);
  }
  assert.deepEqual(at(chat('今天工作累不累呀？'), CALM, 0.5).why.slice(0, 1), ['最后一句在问你（多留一会儿）']);
});

test('the same scene twice is not identical, but only the afterglow varies, and by little', () => {
  const random = seeded(5), values = Array.from({ length: 20 }, () => chooseReplyLinger(replyLingerNow(chat('我刚才在想你会不会喜欢那首歌。'), CALM), random).ms);
  const spread = Math.max(...values) - Math.min(...values), [low, high] = REPLY_LINGER_KNOBS.after;
  if (report) console.log('20 回同一句话：', values.join(' '));
  assert.ok(new Set(values).size >= 10, 'not a stopwatch');
  assert.ok(spread <= high - low, `${spread} ms spread`);
  for (const value of values) assert.ok(Math.abs(value - values[0]) < 1000, 'never a jump the user would read as random');
});

test('her mood and card: close or missing you stays longer, excited or playful leaves sooner; only real reasons are written', () => {
  const line = chat('我刚才在想你会不会喜欢那首歌。');
  const calm = at(line, CALM, 0.5), excited = at(line, mood('excited'), 0.5), longing = at(line, mood('longing'), 0.5);
  const clingy = at(line, mood('calm', { personality: { close: 2 } }), 0.5), drowsy = at(line, mood('calm', { fatiguePhase: 'drowsy' }), 0.5);
  assert.ok(excited.ms < calm.ms && calm.ms < longing.ms && calm.ms < clingy.ms && calm.ms < drowsy.ms);
  assert.deepEqual(calm.why, ['14 个字（读完约 3.3 秒）'], 'a calm card average in every trait adds no reason');
  assert.deepEqual(excited.why, ['14 个字（读完约 3.3 秒）', '心情：兴奋（收得早一点）']);
  assert.deepEqual(longing.why, ['14 个字（读完约 3.3 秒）', '心情：想念（多留一会儿）']);
  assert.deepEqual(clingy.why, ['14 个字（读完约 3.3 秒）', '性格：黏人（多留一会儿）']);
  assert.deepEqual(drowsy.why, ['14 个字（读完约 3.3 秒）', '有点困（多留一会儿）']);
  // The example in the task, "最后一句在问你；32 个字；此刻愉快".
  const asked = at(chat('今天天气很好，我在窗边晒太阳，看着楼下的猫走来走去，想起你说过的那家店了吗？'), mood('happy'), 0.5);
  assert.deepEqual(asked.why, ['最后一句在问你（多留一会儿）', '34 个字（读完约 6.7 秒）', '心情：愉快（收得早一点）']);
  // Facts that are not "now" never appear.
  for (const choice of [calm, excited, longing, clingy]) assert.ok(!choice.why.some(reason => /困|在问你|递给你/.test(reason)));
  // No mood at all (no character yet): the same floor and afterglow, no mood words.
  assert.deepEqual(at(line, null, 0.5).why, calm.why); assert.equal(at(line, null, 0.5).ms, calm.ms);
});

test('the range holds for any text, mood and roll; exactly one random number per decision', () => {
  const random = seeded(11), texts = ['', '嗯', '？', '你呢', 'a'.repeat(5000), '字'.repeat(30000), '😊'.repeat(40), '第一句。第二句？'];
  const moods: (ReplyLingerMood | null)[] = [null, CALM, mood('excited'), mood('longing', { snapshot: { primary: 'longing', companion: 'wistful' }, personality: { close: 4, playful: 0 }, fatiguePhase: 'light-drowsy' })];
  for (const text of texts) for (const m of moods) for (let i = 0; i < 10; i++) {
    let draws = 0; const ms = chooseReplyLinger(replyLingerNow(chat(text), m), () => { draws++; return random(); }).ms;
    assert.ok(ms >= SHORTEST && ms <= LONGEST && Number.isInteger(ms), `${ms}`); assert.equal(draws, 1);
  }
  assert.equal(chooseReplyLinger({ chars: NaN, waiting: null, mood: null }, () => NaN).ms >= SHORTEST, true);
});

test('one knob changes one thing: reading speed moves only the floor; the question factor only questions', () => {
  const slow: ReplyLingerKnobs = { ...REPLY_LINGER_KNOBS, readable: { ...REPLY_LINGER_KNOBS.readable, charsPerSecond: 3 } };
  const patient: ReplyLingerKnobs = { ...REPLY_LINGER_KNOBS, waiting: { ...REPLY_LINGER_KNOBS.waiting, question: 3 } };
  const statement = chat('我刚才在想你会不会喜欢那首歌。'), question = chat('今天工作累不累呀？');
  for (const roll of [0, 0.4, 0.9]) {
    const base = at(statement, CALM, roll), slower = at(statement, CALM, roll, slow);
    assert.equal(slower.afterMs, base.afterMs); assert.equal(slower.readMs, Math.round(REPLY_LINGER_KNOBS.readable.noticeMs + 14 / 3 * 1000));
    assert.equal(at(statement, CALM, roll, patient).ms, base.ms, 'a statement does not feel the question knob');
    assert.ok(at(question, CALM, roll, patient).ms > at(question, CALM, roll).ms);
  }
});

test('the host side: the timer is always inside the range, and the pet window reads only a sane answer', () => {
  assert.equal(replyLingerLongestMs(), LONGEST);
  assert.equal(safeLingerMs(7300.4), 7300); assert.equal(safeLingerMs(1), SHORTEST); assert.equal(safeLingerMs(1e9), LONGEST);
  assert.equal(safeLingerMs(NaN), LONGEST, 'a broken decision keeps it readable rather than snapping it away');
  assert.equal(readReplyLingerAnswer({ lingerMs: 7300 }), 7300);
  for (const bad of [undefined, null, 7300, [7300], {}, { lingerMs: '7300' }, { lingerMs: SHORTEST - 1 }, { lingerMs: LONGEST + 1 }, { lingerMs: Infinity }])
    assert.equal(readReplyLingerAnswer(bad), null, JSON.stringify(bad) ?? String(bad));
});

// The contract: what any implementation of ReplyLingerHost keeps (the real director and the fake run the same checks).
for (const [name, make] of [
  ['real', (clock: () => number) => new ReplyLingerDirector({ random: seeded(3), clock })],
  ['fake', (clock: () => number) => new FakeReplyLingerHost(6400, clock)],
] as const) test(`contract (${name}): inside the range, one "why" per decision per character, memory only and copied out`, () => {
  let now = 1_000_000; const host: ReplyLingerHost = make(() => now);
  for (const text of ['嗯。', '你今天累不累？', '这是一段很长的话'.repeat(20)]) {
    const ms = host.decide('gene', chat(text), CALM); now += 60_000;
    assert.ok(ms >= SHORTEST && ms <= LONGEST);
  }
  host.decide('other', chat('别的角色。'), null); host.decide('', chat('没有角色时。'), null);
  const recent = host.recent('gene');
  assert.equal(recent.length, 3); assert.ok(recent[0].at > recent[2].at, 'newest first');
  assert.equal(host.recent('other').length, 1); assert.equal(host.recent('').length, 0, 'nothing is remembered without a character');
  for (const entry of recent) {
    assert.ok(entry.why.length > 0 && entry.why.every(reason => typeof reason === 'string'));
    assert.ok(!entry.why.some(reason => /很长的话|累不累/.test(reason)), 'never her words');
  }
  (recent[0].why as string[]).push('changed outside');
  assert.ok(!host.recent('gene')[0].why.includes('changed outside'));
});

test('the real director never throws into the reply and keeps a bounded memory', () => {
  const host = new ReplyLingerDirector({ random: () => { throw new Error('broken'); } });
  assert.equal(host.decide('gene', chat('回答。'), CALM), LONGEST);
  const director = new ReplyLingerDirector({ random: seeded(1) });
  for (let i = 0; i < 100; i++) director.decide('gene', chat(`第 ${i} 句。`), CALM);
  assert.equal(director.recent('gene').length, 8);
});

test('the developer panel line: time, how long, the real reasons', () => {
  assert.equal(formatReplyLingerLines(undefined), '气泡：暂无');
  const line = formatReplyLingerLines([{ at: new Date(2026, 10, 4, 21, 3, 12).getTime(), ms: 8140, why: ['最后一句在问你（多留一会儿）', '32 个字（读完约 6.3 秒）', '心情：愉快（收得早一点）'] }]);
  assert.match(line, /^气泡：.+ 留 8\.1 秒｜最后一句在问你（多留一会儿）；32 个字（读完约 6\.3 秒）；心情：愉快（收得早一点）$/);
});

test('a tendency left a hair above baseline is not a reason (shared/mood-tendency.ts), a real one still is', () => {
  const none = { playful: 0, close: 0, comfortable: 0, cautious: 0 };
  const faint = replyLingerMood({ snapshot: { primary: 'calm', companion: 'close', tendencies: { ...none, close: 1e-10 } }, personality: null });
  assert.equal(faint.tendency, null, 'a day after a pat she is not "想黏着你"');
  const real = replyLingerMood({ snapshot: { primary: 'calm', companion: 'close', tendencies: { ...none, close: 0.35 } }, personality: null });
  assert.equal(real.tendency, 'close');
  assert.equal(replyLingerMood({ snapshot: { primary: 'calm', companion: 'wistful', tendencies: none }, personality: null }).tendency, 'wistful');
});
