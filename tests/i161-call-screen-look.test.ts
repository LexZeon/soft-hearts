// I-161 / I-040 a sense turned on mid-call is seen by the next segment's look decision (morning: "8：10没按语义读取屏幕
// （前面屏幕共享关了，开了后的第一句"你再看看没看到屏幕"）"). Plus the journal line every voice
// segment that considered a look now writes (closed words; shared/voice/call-look-journal.ts), so a missed look can be told from no look.
// Real: the voice host, her companion service, the media switches, the look decision and tickets, the reaction host, the I-040 router and the
// voice adapter (tests/helpers/call-look-harness.ts). Fake: haiku, the captures, the recognizer and Claude. No real screen, camera or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, SCREEN_FACTS, CAMERA_FACTS, wait } from './helpers/call-look-harness';
import { callLookFromTurn, callLookNotTaken, CALL_LOOK_ANSWERS, CALL_LOOK_JUDGES, CALL_LOOK_RESULTS, CALL_LOOK_SENSES, type CallLookTurnEnd } from '../shared/voice/call-look-journal';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { ENGLISH_UI_COPY } from '../shared/foundation/ui-copy.en';

const lastLine = (h: { journal: readonly unknown[] }) => h.journal.at(-1) as Record<string, unknown>;

test('a call, screen off at first and on later: the next segment that asks takes a clear screen frame once (phrase rules), and the line says so', async () => {
  const h = await harness({ script: [[], [], []] });
  try {
    await h.say('嗯你好');
    await h.until(() => h.journal.length >= 1);
    assert.equal(lastLine(h).screen, false, 'screen off at first');
    h.media.update({ screenSharing: true }, 'controls');
    await h.say('你再看看没看到屏幕');
    assert.equal(h.phraseScreenShots(), 1, 'one look at the screen, by the phrase rules');
    assert.equal(h.sent[1].images.length, 1, 'the frame goes with this very segment');
    assert.equal(lastLine(h).screen, true, 'the journal saw the screen on');
    await h.until(() => h.journal.length >= 2 && h.router.stats.judged >= 2);
    await wait(30);
    assert.deepEqual(h.senseCaptures, [], 'covered: the judgment does not look a second time');
    assert.equal(lastLine(h).rules, 'screen');
    assert.equal(lastLine(h).result, 'looked');
  } finally { await h.dispose(); }
});

test('a call, screen turned on mid-call, words with no look verb: judged on the reaction call, looked at once, the facts reach her next segment, never a second reply', async () => {
  const h = await harness({ script: [[], ['screen'], []] });
  try {
    await h.say('嗯你好');
    h.media.update({ screenSharing: true }, 'controls');
    await h.say('我屏幕上现在是什么');
    assert.equal(h.phraseScreenShots(), 0, 'no phrase rule here');
    await h.until(() => h.router.stats.carried === 1);
    assert.deepEqual(h.senseCaptures, ['screen'], 'the sense turned on mid-call is looked at');
    await h.say('嗯');
    assert.equal(h.sent.slice(1).filter(turn => turn.persona.includes(SCREEN_FACTS)).length, 1, 'what she saw goes into one of her next segments, once');
    assert.equal(h.lines.length, 0, 'never a second reply in a call');
    assert.deepEqual(h.published, []);
    const line = h.journal.find((_, index) => index === 1)!;
    assert.deepEqual({ ...line }, { call: true, rules: 'none', judge: 'reaction', answer: 'screen', camera: false, screen: true, result: 'looked' });
  } finally { await h.dispose(); }
});

test('a call, camera turned on mid-call: "你猜我手里拿着什么" (no phrase rule; "can you see me" is one since 2026-11-21) is judged, looked at once; a segment that does not ask looks at nothing', async () => {
  const h = await harness({ script: [[], ['camera'], []] });
  try {
    await h.say('嗯你好');
    h.media.update({ cameraImages: true }, 'controls');
    h.keepSmall(1);
    await h.say('你猜我手里拿着什么');
    await h.until(() => h.router.stats.carried === 1);
    assert.deepEqual(h.senseCaptures, ['camera']);
    assert.deepEqual({ ...h.journal[1] }, { call: true, rules: 'none', judge: 'reaction', answer: 'camera', camera: true, screen: false, result: 'looked' });
    await h.say('哈哈好的');
    await wait(30);
    assert.deepEqual(h.senseCaptures, ['camera'], 'a segment that does not ask looks at nothing more');
    assert.equal(lastLine(h).result, 'judge-no');
    assert.equal(lastLine(h).answer, 'none');
  } finally { await h.dispose(); }
});

test('"别看" still wins over a sense turned on mid-call', async () => {
  const h = await harness({ script: [[], ['screen']] });
  try {
    await h.say('嗯你好');
    h.media.update({ screenSharing: true }, 'controls');
    await h.say('别看我屏幕');
    await wait(40);
    assert.deepEqual(h.senseCaptures, []);
    assert.equal(h.phraseScreenShots(), 0);
    assert.equal(lastLine(h).result, 'refused');
    assert.equal(lastLine(h).screen, false, 'a held sense counts as off in the line');
  } finally { await h.dispose(); }
});

test('the judgment names a sense that is off: nothing is looked at and the line says the sense was off', async () => {
  const h = await harness({ script: [['screen']] });
  try {
    await h.say('我屏幕上现在是什么');
    await h.until(() => h.router.stats.carried === 1);
    assert.deepEqual(h.senseCaptures, []);
    assert.deepEqual({ ...h.journal[0] }, { call: true, rules: 'none', judge: 'reaction', answer: 'screen', camera: false, screen: false, result: 'sense-off' });
  } finally { await h.dispose(); }
});

test('no reaction call and nothing on: no judgment is made, and the line says nothing was asked', async () => {
  const h = await harness({ quiet: true, ownJudge: false });
  try {
    await h.say('今天天气不错');
    await wait(30);
    assert.deepEqual({ ...h.journal[0] }, { call: true, rules: 'none', judge: 'none', answer: 'not-asked', camera: false, screen: false, result: 'not-asked' });
  } finally { await h.dispose(); }
});

test('the line is built from closed words only and survives the journal builder and its English panel text', () => {
  const end: CallLookTurnEnd = { outcome: 'carried', judge: 'merged', asked: true, judged: true, answer: ['screen'], on: { camera: false, screen: true }, held: false, seen: 1, off: 0, camera: 'off' };
  const fields = callLookFromTurn({ call: true, rules: [], end });
  assert.deepEqual(fields, { call: true, rules: 'none', judge: 'reaction', answer: 'screen', camera: false, screen: true, result: 'looked' });
  const built = buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'look', ...fields }, 1_000);
  assert.ok(built, 'the journal accepts it');
  assert.equal(buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'look', ...fields, result: '你再看看没看到屏幕' }, 1_000), null, 'a free word never gets in');
  assert.equal(buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'look', ...fields, answer: 'screen!' }, 1_000), null);
  const missing: string[] = [];
  const text = describeJournalEntry(built!, (source, ...values) => { const hit = ENGLISH_UI_COPY[source]; if (hit === undefined) missing.push(source); return (hit ?? source).replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)])); });
  assert.deepEqual(missing, [], 'every word of the line has an English text');
  assert.match(text, /result: looked/u);
  // Every result and answer word is reachable from the two builders (a closed list that grows must grow its words too).
  for (const sense of CALL_LOOK_SENSES) assert.equal(typeof sense, 'string');
  assert.ok(CALL_LOOK_JUDGES.length === 3 && CALL_LOOK_ANSWERS.length === 7 && CALL_LOOK_RESULTS.length === 8);
  assert.equal(callLookNotTaken({ call: false, rules: ['camera'], camera: true, screen: false, held: false }).result, 'looked');
  assert.equal(callLookNotTaken({ call: false, rules: [], camera: true, screen: true, held: true }).result, 'refused');
  const cut = callLookFromTurn({ call: true, rules: [], end: { ...end, outcome: 'superseded', judged: false, answer: null, seen: 0 } });
  assert.deepEqual({ answer: cut.answer, result: cut.result }, { answer: 'unsure', result: 'cut' });
  const timeout = callLookFromTurn({ call: true, rules: [], end: { ...end, outcome: 'nothing', judged: true, answer: null, seen: 0 } });
  assert.equal(timeout.result, 'no-answer');
});
