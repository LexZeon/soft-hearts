// Codex T-207 round 8 (bridge X-273, docs/claude/2026-11-04-reply-guard-x273.md), on the stable line 0dd6246 and still on
// main 0072b13: in a Chinese chat the head filter (electron/reply-draft-guard.ts) let an English plan line through, or kept it
// out, depending only on where the stream was cut:
//   * L12: a 294-character plan line whose second kind of cue comes after character 240: a first chunk of 240 characters
//     dropped it, one of 241 showed, archived and read it;
//   * B03/B05/B07: a 599/600-character plan line whose line break (LF, or CR and LF) arrived split from the next line: the
//     break itself was counted against the 600-character hold and the plan and the tone line went out;
//   * C03: the user asked in Chinese for an English story, and a story paragraph with "should" and "reply" in it was cut
//     whole (an emptied reply); asked in English (C04) it was kept.
// Every text below is synthetic: Codex's own invented sentences (its report's repro), or invented here. None is a recorded reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReplyDraftGuard, asksForEnglish, type DraftDrop } from '../electron/reply-draft-guard';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { CompanionService } from '../electron/companion';

const CHINESE = '……我给你留了盏灯。想说的时候，我就在这儿。';
const TONE = 'Voice for the reply: gentle and unhurried.';
const EARLY = 'The user set an empty mug beside the blue lamp. She should pause before bringing up the train. ';
const FILLER = 'The pale blue lamp is still lit beside the cup and there is a narrow stripe of gold on the floor. ';
const LATE = 'She should pause before bringing up the train.';
/** A plan line of exactly `n` characters: the user and a reminder in its first sentence, then plain description. */
const plan = (n: number): string => EARLY + FILLER.repeat(8).slice(0, n - EARLY.length - 1) + '.';
/** 294 characters; its first 241 name the user but hold no second kind of cue ("should" comes at the end). */
const LATE_PLAN = 'The user set an empty mug beside the blue lamp. ' + FILLER.repeat(3).slice(0, 198) + '. ' + LATE;
/** The plan line, a line about the reply's tone, the Chinese reply. */
const withReply = (line: string, end = '\n'): string => line + end + TONE + end + CHINESE;
const STORY = 'Nera watched the ferryman count the lanterns one by one. She should reply to the letter before the next ferry left, she thought. The ink had dried beside the blue lamp hours ago, and the wind still lifted the curled edge of the envelope whenever someone opened the door.';
/** The story's first two sentences: under the 240-character hold. */
const SHORT_STORY = 'Nera watched the ferryman count the lanterns one by one. She should reply to the letter before the next ferry left, she thought.';
const STORY_ASKED_IN_CHINESE ='用英文第三人称写一段 Nera 等渡船的故事。';
const STORY_ASKED_IN_ENGLISH = 'Write a third-person scene of Nera waiting for a ferry.';
const TRAM = 'The little tram comes around the corner just before dusk. Its brass bell rings twice, then the car rolls past the row of shuttered shops. Across the square, lights begin to glow behind the tall windows, and the wet pavement turns silver under the moon.';

interface Options { chinese?: boolean; englishAsked?: boolean; speakers?: string[] }
function guardRun(chunks: string[], options: Options = {}): { shown: string; drops: DraftDrop[]; pushed: string[] } {
  const guard = new ReplyDraftGuard(options.speakers ?? ['Nera'], { chinese: options.chinese ?? true, englishAsked: options.englishAsked === true });
  const pushed = chunks.map(chunk => guard.push(chunk));
  const shown = pushed.join('') + guard.finish();
  return { shown, drops: guard.dropped.map(drop => ({ ...drop })), pushed };
}
const at = (text: string, cuts: number[]): string[] => [0, ...cuts, text.length].slice(1).map((end, i, ends) => text.slice(i ? ends[i - 1] : 0, end)).filter(Boolean);

test('the synthetic texts have the lengths of the report', () => {
  assert.equal(LATE_PLAN.length, 294);
  assert.equal(plan(599).length, 599);
  assert.equal(plan(600).length, 600);
  assert.equal(STORY.length, 270);
});

// ------------------------------------------------------------------ L10–L12: the cue after character 240

test('L10–L12: a 294-character plan line is dropped whether the first chunk ends at 240, at 241, or the line comes whole', () => {
  const text = withReply(LATE_PLAN);
  for (const [name, chunks] of [['L10 whole', [text]], ['L11 cut at 240', at(text, [240])], ['L12 cut at 241', at(text, [241])]] as const) {
    const { shown, pushed } = guardRun([...chunks]);
    assert.equal(shown, CHINESE, name);
    assert.equal(pushed[0], '', `${name}: nothing of the plan goes out with the first chunk`);
  }
});

// ------------------------------------------------------------------ B01–B07: a line break at the 600-character hold

const BOUNDARY: Array<{ name: string; chunks: string[] }> = [
  { name: 'B01 599 + LF, then the tone line', chunks: [plan(599) + '\n', TONE, '\n' + CHINESE] },
  { name: 'B02 599 CRLF whole', chunks: [withReply(plan(599), '\r\n')] },
  { name: 'B03 599 + CR | LF | tone', chunks: [plan(599) + '\r', '\n', TONE, '\r\n' + CHINESE] },
  { name: 'B04 600 LF whole', chunks: [withReply(plan(600))] },
  { name: 'B05 600 + LF | tone', chunks: [plan(600) + '\n', TONE, '\n' + CHINESE] },
  { name: 'B06 600 | LF + the rest', chunks: [plan(600), '\n' + TONE + '\n' + CHINESE] },
  { name: 'B07 600 + CR | LF | tone', chunks: [plan(600) + '\r', '\n', TONE, '\r\n' + CHINESE] },
  { name: '600 | CR | LF + tone, a chunk of one CR', chunks: [plan(600), '\r', '\n' + TONE + '\r\n' + CHINESE] },
  { name: '600 + CRLF | tone + CR | LF + reply', chunks: [plan(600) + '\r\n', TONE + '\r', '\n' + CHINESE] },
];
for (const { name, chunks } of BOUNDARY) {
  test(`${name}: only the Chinese reply goes out`, () => {
    const { shown, pushed } = guardRun(chunks);
    assert.equal(shown, CHINESE);
    assert.ok(pushed.slice(0, -1).every(out => out === ''), 'nothing goes out before the reply arrives');
  });
}

test('a plan line longer than the 600-character hold is let go the same way however it is cut (B09/B10)', () => {
  const text = withReply(plan(601));
  const whole = guardRun([text]).shown;
  assert.equal(guardRun(at(text, [601])).shown, whole);
  assert.equal(guardRun(at(text, [300])).shown, whole);
});

// ------------------------------------------------------------------ C03/C04: an English story the user asked for

test('asksForEnglish: a Chinese message that asks for English', () => {
  assert.equal(asksForEnglish(STORY_ASKED_IN_CHINESE), true);
  assert.equal(asksForEnglish('请用英语回答我。'), true);
  assert.equal(asksForEnglish('帮我把这句话翻译成 English。'), true);
  assert.equal(asksForEnglish(STORY_ASKED_IN_ENGLISH), false, 'an English message is an English chat already');
  assert.equal(asksForEnglish('今天能陪我坐一会儿吗？'), false);
  assert.equal(asksForEnglish(''), false);
});

test('C03: the story the user asked for in Chinese is kept whole, whole or cut anywhere', () => {
  const options = { englishAsked: asksForEnglish(STORY_ASKED_IN_CHINESE) };
  assert.equal(guardRun([STORY], options).shown, STORY);
  assert.deepEqual(guardRun([STORY], options).drops, []);
  for (const cuts of [[3], [80], [241], [4], [3, 80, 241]]) assert.equal(guardRun(at(STORY, cuts), options).shown, STORY, `cut at ${cuts}`);
  // Followed by a second paragraph and by Chinese.
  assert.equal(guardRun([STORY + '\n\n' + TRAM], options).shown, STORY + '\n\n' + TRAM);
  // Shorter than the 240-character hold, so it is judged whole, not let go by its length: still the story.
  assert.ok(SHORT_STORY.length < 240);
  assert.equal(guardRun([SHORT_STORY], options).shown, SHORT_STORY);
  assert.equal(guardRun([SHORT_STORY], { englishAsked: false }).shown, '', 'a Chinese chat that did not ask for English still reads it as a note');
});

test('C04: asked in English, the same story is kept (unchanged)', () => {
  assert.equal(guardRun([STORY], { chinese: false }).shown, STORY);
});

test('in a turn that asked for English, a plan that names the user is still dropped, and its tone line with it', () => {
  for (const line of [LATE_PLAN, plan(318), plan(600)]) {
    for (const end of ['\n', '\r\n']) {
      const text = withReply(line, end);
      assert.equal(guardRun([text], { englishAsked: true }).shown, CHINESE, `${line.length} whole`);
      assert.equal(guardRun(at(text, [241]), { englishAsked: true }).shown, CHINESE, `${line.length} cut at 241`);
    }
  }
  // An English plan in front of an English story: the plan goes, the story stays (a long one, and one under the hold).
  for (const body of [STORY, SHORT_STORY]) {
    const story = 'The user wants a short story in English, keep it gentle.\n' + body;
    assert.equal(guardRun([story], { englishAsked: true }).shown, body);
  }
});

test('in a turn that asked for English, an English answer followed by a Chinese explanation stays', () => {
  const answer = 'You can say "I miss you so much", or keep it short and simply say "Miss you."\n第二种更随意一点，适合发消息。';
  assert.equal(guardRun([answer], { englishAsked: true }).shown, answer);
  assert.equal(guardRun(at(answer, [20, 77]), { englishAsked: true }).shown, answer);
});

test('in a turn that asked for English, a story under a heading line ("Chapter One: …") stays', () => {
  const story = 'Chapter One: ' + STORY;
  assert.equal(guardRun([story], { englishAsked: true }).shown, story);
  assert.equal(guardRun(at(story, [13, 241]), { englishAsked: true }).shown, story);
});

test('a long run of blank lines between the plan and the reply is judged the same however it is cut', () => {
  const text = plan(318) + '\n'.repeat(70) + CHINESE;
  const whole = guardRun([text]).shown;
  assert.equal(whole, CHINESE);
  for (const cut of [318, 319, 350, 382, 383, 388, 389]) assert.equal(guardRun(at(text, [cut])).shown, whole, `cut at ${cut}`);
  // The wait for what follows the plan is bounded by the text: past 64 blanks the plan is judged without the reply.
  const guard = new ReplyDraftGuard([], { chinese: true });
  assert.equal(guard.push(plan(318) + '\n'.repeat(70)), '');
  assert.deepEqual(guard.dropped.map(drop => drop.kind), ['english-note']);
});

test('ordinary English in a Chinese chat that did not ask for it: the tram (no cue) goes out at once and whole', () => {
  const { shown, pushed } = guardRun(at(TRAM, [241]));
  assert.equal(shown, TRAM);
  assert.equal(pushed[0], TRAM.slice(0, 241), 'released as soon as it is past the 240-character hold');
});

// ------------------------------------------------------------------ every split point gives what the whole block gives

const CASES: Array<{ name: string; text: string; expected: string; options?: Options }> = [
  { name: 'L12 text', text: withReply(LATE_PLAN), expected: CHINESE },
  { name: 'L12 text, CRLF', text: withReply(LATE_PLAN, '\r\n'), expected: CHINESE },
  { name: '318-character plan', text: withReply(plan(318)), expected: CHINESE },
  { name: '599-character plan, CRLF', text: withReply(plan(599), '\r\n'), expected: CHINESE },
  { name: '600-character plan, LF', text: withReply(plan(600)), expected: CHINESE },
  { name: '600-character plan, CRLF', text: withReply(plan(600), '\r\n'), expected: CHINESE },
  { name: '600-character plan, CRLF and a blank line', text: plan(600) + '\r\n\r\n' + TONE + '\r\n\r\n' + CHINESE, expected: CHINESE },
  { name: 'C03 story asked for in Chinese', text: STORY, expected: STORY, options: { englishAsked: true } },
  { name: 'C03 story, a CRLF and a second paragraph', text: STORY + '\r\n' + TRAM, expected: STORY + '\r\n' + TRAM, options: { englishAsked: true } },
  { name: 'English-asked turn, plan before the reply', text: withReply(LATE_PLAN, '\r\n'), expected: CHINESE, options: { englishAsked: true } },
  { name: 'ordinary English (the tram)', text: TRAM + '\n小电车～', expected: TRAM + '\n小电车～' },
];
/** Split points to try in three chunks: every one near a hold or a line break, and a dense sample of the rest. */
function denseSplits(text: string): number[] {
  const points = new Set<number>();
  for (let i = 1; i < text.length; i += 11) points.add(i);
  for (const mark of [240, 241, 599, 600, 601]) for (let d = -2; d <= 2; d++) points.add(mark + d);
  for (let i = 0; i < text.length; i++) if (text[i] === '\r' || text[i] === '\n') for (let d = -1; d <= 2; d++) points.add(i + d);
  return [...points].filter(i => i > 0 && i < text.length).sort((a, b) => a - b);
}

for (const { name, text, expected, options } of CASES) {
  test(`chunk boundaries do not matter: ${name}`, () => {
    const whole = guardRun([text], options);
    assert.equal(whole.shown, expected, 'whole block');
    for (let i = 1; i < text.length; i++) {
      const split = guardRun(at(text, [i]), options);
      assert.equal(split.shown, whole.shown, `cut at ${i}`);
      assert.deepEqual(split.drops, whole.drops, `drops, cut at ${i}`);
    }
    const points = denseSplits(text);
    for (const i of points) for (const j of points) {
      if (j > i) assert.equal(guardRun(at(text, [i, j]), options).shown, whole.shown, `cut at ${i} and ${j}`);
    }
    // One character at a time.
    assert.equal(guardRun([...text], options).shown, whole.shown, 'one character at a time');
  });
}

// ------------------------------------------------------------------ the real reply protocol: shown text and the emptied flag

function play(chunks: (protocol: MoodReplyProtocol) => string[], options: Options = {}) {
  const shown: string[] = [];
  const protocol = new MoodReplyProtocol(text => { shown.push(text); }, { chineseChat: options.chinese ?? true, englishAsked: options.englishAsked === true, speakers: ['Nera'] });
  for (const chunk of chunks(protocol)) protocol.push(chunk);
  const appraisal = protocol.finish();
  return { shown: shown.join(''), emptied: protocol.emptiedByFilter(), context: appraisal?.context ?? null };
}
const tail = (p: MoodReplyProtocol): string => `\n${p.start}{"context":"positive","delta":{"O":1},"reason":"测试","confidence":0.9,"gesture":"none"}${p.end}`;

for (const { name, text, expected, options } of CASES) {
  test(`protocol, every split point: ${name}`, () => {
    const whole = play(p => [text + tail(p)], options);
    assert.deepEqual(whole, { shown: expected, emptied: false, context: 'positive' });
    for (let i = 1; i < text.length; i++) assert.deepEqual(play(p => at(text + tail(p), [i]), options), whole, `cut at ${i}`);
  });
}

// ------------------------------------------------------------------ the host: what is shown, archived, and how the turn ends

async function withService(run: (service: CompanionService) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-chunk-boundaries-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('nera', { kind: 'claude', baseUrl: 'https://chunk-boundaries.invalid/v1', model: 'fixture' }, '角色名称：Nera'); await run(service); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
async function chat(service: CompanionService, id: string, user: string, chunks: string[]) {
  const shown: string[] = [];
  const turn = await service.begin(id, user, '角色名称：Nera', (type, text) => { if (type === 'delta') shown.push(text); });
  const start = turn.persona.match(/<sh-state-[a-f0-9]+>/)![0];
  for (const chunk of chunks) turn.push('delta', chunk);
  turn.push('delta', `\n${start}{"context":"positive","delta":{"O":2},"confidence":0.9}${start.replace('<', '</')}`);
  await turn.finish('complete');
  const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
  const assistant = record.messages.find(message => message.role === 'assistant' && message.turnId === id)!;
  return { shown: shown.join(''), archive: [assistant.content, assistant.status], empty: turn.emptyReply?.() };
}

test('host: L12, B03, B05, B07 show and archive only the Chinese reply', async () => {
  await withService(async service => {
    const user = '今天能陪我坐一会儿吗？';
    const cases: Array<[string, string[]]> = [
      ['l12', at(withReply(LATE_PLAN), [241])],
      ['b03', [plan(599) + '\r', '\n', TONE, '\r\n' + CHINESE]],
      ['b05', [plan(600) + '\n', TONE, '\n' + CHINESE]],
      ['b07', [plan(600) + '\r', '\n', TONE, '\r\n' + CHINESE]],
    ];
    for (const [id, chunks] of cases) {
      const result = await chat(service, id, user, chunks);
      assert.deepEqual(result, { shown: CHINESE, archive: [CHINESE, 'complete'], empty: false }, id);
    }
  });
});

test('host: C03 the story asked for in Chinese is shown and archived whole; C04 the same in English', async () => {
  await withService(async service => {
    for (const [id, user] of [['c03', STORY_ASKED_IN_CHINESE], ['c04', STORY_ASKED_IN_ENGLISH]]) {
      const result = await chat(service, id, user, [STORY]);
      assert.deepEqual(result, { shown: STORY, archive: [STORY, 'complete'], empty: false }, id);
    }
  });
});
