// Unbound v1 step 4, afternoon additions C and D: the interaction history the chat Claude is told (facts she sensed, never an instruction,
// no digits, "好像" for a maybe, the senses named), its five steps (moment, speak roll, tell, journal; haiku only for the day's account),
// and her name in the middle of a sentence (haiku asked with that one sentence only, unless the camera is sure you face her).
import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTION_WORDS, dayAccount, durationWords, noticedSpeakChance, noticedTurnLine, type Noticed } from '../shared/unbound/life/history';
import { HISTORY_TIMING, UnboundHistory, usableCondensed, type HistoryPorts, type NoticedJournalRow } from '../electron/unbound/history-host';
import { NEUTRAL_MOOD } from '../shared/unbound/director';
import { callsHer, wakeFilter } from '../electron/senses/voiceprint/gate';
import { namePlace, parseNameCall } from '../electron/senses/voiceprint/name-call';
import { buildJournalEntry } from '../shared/memory/journal';

/** Words that would make a fact line an instruction (the brief's list and a few more, as tests/perception-off-no-screen.test.ts scans). */
const FORBIDDEN = [...INSTRUCTION_WORDS, '你需要', '不要说', '别忘', '主动', '问问他', '问问用户', '关心一下'];
const scan = (line: string) => {
  for (const word of FORBIDDEN) assert.ok(!line.includes(word), `"${word}" in: ${line}`);
  assert.ok(!/[0-9０-９]/.test(line), `a digit in: ${line}`);
};

test('the words: facts she sensed, the senses named, "好像" for a maybe, durations in rounded words, never an instruction or a digit', t => {
  const at = 0, n = (kind: Noticed['kind'], band: Noticed['band'] = 'sure', awayMs?: number): Noticed => ({ kind, band, at, ...(awayMs ? { awayMs } : {}) });
  const examples = [
    noticedTurnLine([n('came-back', 'sure', 23 * 60_000)], ''),
    noticedTurnLine([n('wave')], ''),
    noticedTurnLine([n('wave', 'maybe')], ''),
    noticedTurnLine([n('facing')], ''),
    noticedTurnLine([n('stretch', 'maybe'), n('leaned-back')], ''),
    noticedTurnLine([n('talked')], ''),
    noticedTurnLine([n('answered')], ''),
    noticedTurnLine([n('came-back', 'sure', 70 * 60_000)], dayAccount([n('left'), n('left'), n('wave'), n('facing'), n('facing'), n('facing'), n('facing'), n('answered')])),
    noticedTurnLine([], dayAccount([n('talked'), n('stretch'), n('left')])),
  ];
  for (const line of examples) { t.diagnostic(line); scan(line); assert.ok(line.length > 0); }
  assert.match(examples[0], /摄像头（姿势识别）开着/);
  assert.match(examples[0], /二十来分钟/);
  assert.match(examples[2], /好像朝你挥了挥手/);
  assert.match(examples[5], /麦克风开着/);
  assert.match(examples[5], /没听内容/);
  assert.doesNotMatch(examples[1], /麦克风/, 'only the senses that noticed it');
  for (const ms of [0, 5 * 60_000, 12 * 60_000, 40 * 60_000, 3 * 3_600_000, 9 * 3_600_000]) scan(durationWords(ms));
  assert.equal(dayAccount([n('wave')]), '', 'one kind of thing is not a day worth telling');
  assert.equal(noticedTurnLine([], ''), '');
});

function history(options: { random?: number; asleep?: boolean; claim?: boolean; condense?: (account: string) => Promise<string> } = {}) {
  const state = { now: 1_000_000, day: 'd1', moments: [] as string[], asked: 0, journal: [] as NoticedJournalRow[], sent: [] as string[] };
  let host: UnboundHistory;
  const ports: HistoryPorts = {
    clock: () => state.now, random: () => options.random ?? 0, day: () => state.day, characterId: () => 'c1', mood: () => ({ ...NEUTRAL_MOOD, O: 80 }), asleep: () => options.asleep ?? false,
    moment: kind => { state.moments.push(kind); return true; },
    attention: () => { state.asked++; if (options.claim !== false) host.claims({ kind: 'speech' }); return true; },
    journal: row => state.journal.push(row),
    ...(options.condense ? { condense: (account: string) => { state.sent.push(account); return options.condense!(account); } } : {}),
  };
  host = new UnboundHistory(ports);
  return { state, host };
}

test('the five steps: a mood moment only for a sure facing or wave; a speak roll that asks the inner loop; told once; a journal row of closed words', () => {
  const { state, host } = history();
  host.note({ kind: 'facing', band: 'sure' }); host.note({ kind: 'wave', band: 'sure' }); host.note({ kind: 'wave', band: 'maybe' });
  host.note({ kind: 'came-back', band: 'sure', awayMs: 30 * 60_000 }); host.note({ kind: 'talked', band: 'sure' }); host.note({ kind: 'left', band: 'sure' });
  host.note({ kind: 'wave', band: 'unsure' }); host.note({ kind: 'dance', band: 'sure' });
  assert.deepEqual(state.moments, ['eye-contact', 'waved'], 'coming back is I-066\'s own moment; talking to others, leaving and a maybe write nothing');
  assert.ok(state.asked >= 1, 'she asked to speak at least once (random 0: every roll with a chance)');
  assert.equal(state.journal.length, 6, 'unsure and unknown kinds are not even recorded');
  for (const row of state.journal) {
    assert.deepEqual(Object.keys(row).sort(), ['band', 'characterId', 'kind', 'spoke']);
    assert.ok(buildJournalEntry({ type: 'noticed', ...row }, 1), JSON.stringify(row));
  }
  const extra = buildJournalEntry({ type: 'noticed', characterId: 'c1', kind: 'wave', band: 'sure', spoke: 'quiet', words: '你好', awayMs: 5 }, 1);
  assert.equal(extra?.type, 'noticed');
  assert.ok(!JSON.stringify(extra).includes('你好') && !JSON.stringify(extra).includes('awayMs'), 'nothing else reaches the line');
  assert.equal(buildJournalEntry({ type: 'noticed', characterId: 'c1', kind: 'unsure-thing', band: 'sure', spoke: 'quiet' }, 1), null);
  const prompt = host.promptLine('c1');
  assert.ok(prompt.startsWith('你在外面的时候') && prompt.includes('用户刚才'), prompt);
  const line = host.turnLine();
  scan(line);
  assert.match(line, /今天你们之间/);
  assert.equal(host.turnLine().includes('用户刚才'), false, 'told once');
  const asleep = history({ asleep: true });
  asleep.host.note({ kind: 'came-back', band: 'sure' });
  assert.equal(asleep.state.asked, 0);
  assert.equal(asleep.state.journal[0].spoke, 'asleep');
  state.day = 'd2';
  assert.equal(host.turnLine(), '', 'a new day: yesterday is not told');
});

test('the speak roll reads her mood: livelier → more; sleepy → less; a maybe → half; asleep or a kind she does not answer → never', () => {
  const at = (mood: Partial<typeof NEUTRAL_MOOD>, band: 'sure' | 'maybe' = 'sure', kind: Noticed['kind'] = 'came-back') => noticedSpeakChance({ kind, band, mood: { ...NEUTRAL_MOOD, ...mood } });
  assert.ok(at({ O: 90 }) > at({}) && at({ A: 0.8 }) < at({}) && at('maybe' as never) <= at({}));
  assert.ok(at({}, 'maybe') < at({}, 'sure'));
  assert.equal(at({}, 'sure', 'talked'), 0);
  assert.equal(noticedSpeakChance({ kind: 'wave', band: 'sure', mood: NEUTRAL_MOOD, asleep: true }), 0);
  assert.ok(noticedSpeakChance({ kind: 'wave', band: 'sure', mood: NEUTRAL_MOOD, sinceSpokeMs: 1_000 }) < noticedSpeakChance({ kind: 'wave', band: 'sure', mood: NEUTRAL_MOOD }));
});

test('haiku condenses only a long account of the day, at most every half hour; only that account is sent; a bad answer keeps the local one', async () => {
  const { state, host } = history({ random: 1, condense: async () => '用户今天走开过几回，也常朝你看，向你挥过手。' });
  for (const kind of ['left', 'left', 'facing', 'facing', 'facing', 'wave', 'stretch', 'talked', 'answered'] as const) { host.note({ kind, band: 'sure' }); state.now += 2 * 3_600_000; }
  const first = host.turnLine();
  assert.ok(first.includes('今天你们之间：用户') && first.length > HISTORY_TIMING.condenseOver, `the local account until haiku is back: ${first}`);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.sent.length, 1);
  assert.ok(!/用户刚才|摄像头|麦克风/.test(state.sent[0]) && state.sent[0].startsWith('今天你们之间'), 'only the day\'s account (kinds and count words)');
  assert.match(host.turnLine(), /今天你们之间：用户今天走开过几回/);
  host.note({ kind: 'wave', band: 'sure' });
  host.turnLine();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.sent.length, 1, 'not again within half an hour');
  state.now += HISTORY_TIMING.condenseEveryMs;
  host.turnLine();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.sent.length, 2);
  for (const bad of ['你应该问问他今天怎么样', '他挥了3次手', 'x'.repeat(200), '', null]) assert.equal(usableCondensed(bad), null, String(bad));
});

test('her name: alone or at a clause start is a call; in the middle, a sure facing counts, otherwise haiku decides from that one sentence', async () => {
  assert.equal(namePlace('小芙', '小芙')?.place, 'alone');
  assert.equal(namePlace('小芙呀！', '小芙')?.place, 'alone');
  assert.equal(namePlace('小芙，过来一下', '小芙')?.place, 'start');
  assert.equal(namePlace('嗯，喂小芙你看这个', '小芙')?.place, 'start');
  assert.equal(namePlace('我跟你说，今天小芙特别乖。然后呢', '小芙')?.place, 'middle');
  assert.equal(namePlace('我跟你说，今天小芙特别乖。然后呢', '小芙')?.sentence, '我跟你说，今天小芙特别乖', 'only the sentence with her name');
  const asked: string[][] = [];
  const ask = (answer: boolean | Error) => async (name: string, sentence: string) => { asked.push([name, sentence]); if (answer instanceof Error) throw answer; return answer; };
  assert.equal(await callsHer({ askCalling: ask(false) }, '小芙，来', '小芙'), true);
  assert.equal(asked.length, 0, 'no haiku for a plain call');
  assert.equal(await callsHer({ facingSure: () => true, askCalling: ask(false) }, '今天小芙特别乖', '小芙'), true);
  assert.equal(asked.length, 0, 'a sure facing: no haiku');
  assert.equal(await callsHer({ facingSure: () => false, askCalling: ask(false) }, '跟同事说今天小芙特别乖。其他的话不发', '小芙'), false);
  assert.deepEqual(asked.at(-1), ['小芙', '跟同事说今天小芙特别乖'], 'only that one sentence goes');
  assert.equal(await callsHer({ askCalling: ask(true) }, '今天小芙你看', '小芙'), true);
  assert.equal(await callsHer({ askCalling: ask(new Error('offline')) }, '今天小芙你看', '小芙'), false, 'haiku failing: not a call');
  assert.equal(parseNameCall('叫她'), true);
  for (const other of ['说她', '叫她吧，我觉得', '', null]) assert.equal(parseNameCall(other), false);
  // wakeFilter: the words of a sentence that is not a call never go on; you talking not to her is told as a fact (no argument at all).
  let talked: unknown[] | null = null, called = 0;
  const ports = { callOn: () => false, listening: () => true, names: () => ['小芙'], startCall: async () => { called++; return true; },
    talkedNotToHer: (...args: unknown[]) => { talked = args; }, facingSure: () => false, askCalling: async () => false };
  assert.equal(await wakeFilter(ports, 'controls' as never, '今天下午三点开会，记得带电脑'), false);
  assert.deepEqual(talked, [], 'no name: the fact only, never the words');
  talked = null;
  assert.equal(await wakeFilter(ports, 'controls' as never, '我在跟朋友说小芙的事'), false);
  assert.deepEqual(talked, [], 'talking about her: the fact only, never the words');
  assert.equal(called, 0);
  assert.equal(await wakeFilter(ports, 'controls' as never, '小芙，在吗'), true);
  assert.equal(called, 1);
});
