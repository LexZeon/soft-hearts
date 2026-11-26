// 2026-11-24: for now the small window
// has no kiss and no hug. She is not offered them there, a ⟦kiss⟧ / ⟦hug⟧ (and the frames) she writes anyway plays nothing and is not told back to her
// as something she did, and full-screen Unbound keeps all of it. One knob (SPEECH_BEAT_WINDOW.windowCloseMoments) brings the window's back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { speechBeatSentence } from '../shared/behaviors/speech-beats/choose';
import { SPEECH_BEAT_CLOSE_WORDS, SPEECH_BEAT_FRAME_WORDS, SPEECH_BEAT_GO_WORDS, SPEECH_BEAT_WORDS, type SpeechBeatsEvent } from '../shared/behaviors/speech-beats/interface';
import { speechBeatAvailabilityLine, type SpeechBeatSituation } from '../shared/behaviors/speech-beats/availability';
import { SPEECH_BEAT_WINDOW } from '../shared/behaviors/speech-beats/knobs';
import { offeredBeatWords, windowCloseMomentsOn, withoutCloseBeats } from '../shared/behaviors/speech-beats/window-close';
import { SpeechBeatTurn } from '../electron/brain/speech-beats/turn';
import { WindowBeats } from '../src/unbound/window-mode/window-beats';
import { chatWorld, settle } from './helpers/chat-world';

const WINDOW: SpeechBeatSituation = { surface: 'window', shown: true, asleep: false, armsHeld: false, inCall: false, model: { arms: true } };
const FULL: SpeechBeatSituation = { ...WINDOW, surface: 'full' };
const GATES = { shown: true, asleep: false, armsHeld: false };
const CLOSE_WORDS: readonly string[] = SPEECH_BEAT_CLOSE_WORDS;
const mentionsClose = (text: string) => /\bkiss\b|\bhug\b|hug-held|let-go|亲你|抱你|亲了|抱了|抱住/u.test(text);

/** One reply through a turn (the stream in the given pieces); the events it sent and what it gave out. */
function runTurn(situation: SpeechBeatSituation | null, stream: string[], windowClose?: boolean) {
  const events: SpeechBeatsEvent[] = [], pushed: string[] = [];
  const turn = new SpeechBeatTurn(true, event => events.push(event), situation, null, null, ...(windowClose === undefined ? [] : [windowClose]));
  const push = turn.input<'delta'>((_type, text) => pushed.push(text));
  for (const piece of stream) push('delta', piece);
  turn.end((_type, text) => pushed.push(text));
  const text = pushed.join('');
  turn.shown(text);
  const outcome = turn.complete(text);
  return { events, text, outcome, beatWords: events.flatMap(event => event.beats ?? []).map(beat => beat.word) };
}

test('the knob: off by default, and its one reader says what it is', () => {
  assert.equal(SPEECH_BEAT_WINDOW.windowCloseMoments, false, 'off since 2026-11-24');
  assert.equal(windowCloseMomentsOn(), false);
  assert.equal(windowCloseMomentsOn({ windowCloseMoments: true }), true);
  assert.deepEqual(offeredBeatWords('window', false).filter(word => CLOSE_WORDS.includes(word)), [], 'the window, knob off: no kiss, no hug');
  assert.deepEqual(offeredBeatWords('window'), offeredBeatWords('window', false), 'the default is the knob');
  assert.deepEqual(offeredBeatWords('window', true), SPEECH_BEAT_WORDS, 'the knob on: the whole list');
  assert.deepEqual(offeredBeatWords('full', false), SPEECH_BEAT_WORDS, 'full-screen never reads the knob');
  assert.deepEqual(offeredBeatWords(undefined, false), SPEECH_BEAT_WORDS, 'an unknown surface is left as it was');
});

test('what she is told in the window: the sentence and the line name no kiss, no hug, no frame', () => {
  const sentence = new SpeechBeatTurn(true, () => {}, WINDOW).sentence();
  assert.ok(!mentionsClose(sentence), sentence);
  for (const word of CLOSE_WORDS) assert.ok(!sentence.includes(word + (word === 'kiss' ? '亲你' : '抱你')), word);
  assert.ok(sentence.includes('tilt') && sentence.includes('shy'), 'the other words are still there');
  assert.equal(sentence, speechBeatSentence(offeredBeatWords('window', false)), 'one place builds it');
  // the availability line never lists them either: arms held, no arm rig, asleep
  for (const [s, expect] of [
    [{ ...WINDOW, armsHeld: true }, '这一轮用不了：hand-cheek、v。'],
    [{ ...WINDOW, model: { arms: false } }, '这一轮用不了：hand-cheek、v。'],
    [{ ...WINDOW, asleep: true }, '这一轮动作标记都用不了。'],
    [WINDOW, ''],
  ] as const) {
    const line = new SpeechBeatTurn(true, () => {}, s).sentence().split('\n')[1] ?? '';
    assert.equal(line, expect);
    assert.ok(!mentionsClose(line));
  }
  assert.equal(speechBeatAvailabilityLine({ ...WINDOW, armsHeld: true }, offeredBeatWords('window', false)), '这一轮用不了：hand-cheek、v。');
});

test('what she is told in full-screen is as it was: kiss and hug, the go words, the frames', () => {
  const gate = { wait: () => ({ done: Promise.resolve(), cancel() {} }) };
  const sentence = new SpeechBeatTurn(true, () => {}, FULL, gate).sentence();
  for (const word of [...SPEECH_BEAT_WORDS, ...SPEECH_BEAT_GO_WORDS, ...SPEECH_BEAT_FRAME_WORDS]) assert.ok(sentence.includes(word), word);
  assert.ok(sentence.includes('kiss亲你') && sentence.includes('hug抱你'));
  assert.equal(speechBeatAvailabilityLine({ ...FULL, armsHeld: true }), '这一轮用不了：hand-cheek、v、hug。');
  // a turn that does not know its surface (no situation) is left as it was too
  assert.equal(new SpeechBeatTurn(true, () => {}).sentence(), speechBeatSentence());
});

test('the window: her ⟦kiss⟧ / ⟦hug⟧ and frames become no beat, no event, no grey line, no history marker', () => {
  const only = runTurn(WINDOW, ['⟦ki', 'ss⟧⟦hug⟧']);
  assert.equal(only.text, '');
  assert.deepEqual(only.beatWords, []);
  assert.deepEqual(only.outcome.beats, []);
  assert.equal(only.outcome.performanceOnly, true, 'still a reply with no words (it is not an empty error)');
  assert.equal(only.outcome.line, '', 'the grey line never says she kissed or hugged');
  assert.equal(only.outcome.history, null, 'no marker for a thing that did not happen');
  const last = only.events.at(-1)?.final;
  assert.deepEqual(last, { performanceOnly: true, line: '', history: null });
  const mixed = runTurn(WINDOW, ['⟦shy⟧好呀', '⟦hug once⟧过来', '⟦pause⟧⟦hug-held⟧⟦let-go⟧嗯']);
  assert.equal(mixed.text, '好呀过来嗯');
  assert.deepEqual(mixed.beatWords, ['shy'], 'only the face word is performed');
  assert.deepEqual(mixed.outcome.beats.map(beat => beat.word), ['shy']);
  assert.equal(mixed.outcome.history, '⟦shy⟧好呀过来嗯');
  const grey = runTurn(WINDOW, ['⟦kiss⟧⟦shy⟧']);
  assert.equal(grey.outcome.line, '（害羞地笑了）', 'the other beat of the same reply is still told');
  assert.ok(!mentionsClose(grey.outcome.line));
});

test('full-screen: the same reply keeps its kiss and hug, and the grey line tells them', () => {
  const only = runTurn(FULL, ['⟦hu', 'g⟧']);
  assert.deepEqual(only.beatWords, ['hug']);
  assert.deepEqual(only.events.at(-1)?.final, { performanceOnly: true, line: '（抱了抱你）', history: '⟦hug⟧' });
  const both = runTurn(FULL, ['⟦kiss⟧⟦shy⟧']);
  assert.equal(both.outcome.line, '（亲了你一下，害羞地笑了）');
  assert.equal(runTurn(null, ['⟦kiss⟧']).outcome.line, '（亲了你一下）', 'an unknown surface: as it was');
});

test('the knob on: the window keeps and offers them again', () => {
  const on = runTurn(WINDOW, ['⟦kiss⟧⟦hug⟧'], true);
  assert.deepEqual(on.beatWords, ['kiss', 'hug']);
  assert.equal(on.outcome.line, '（亲了你一下，抱了抱你）');
  assert.equal(new SpeechBeatTurn(true, () => {}, WINDOW, null, null, true).sentence(), speechBeatSentence(), 'the whole list, as before');
  assert.equal(new SpeechBeatTurn(true, () => {}, { ...WINDOW, armsHeld: true }, null, null, true).sentence().split('\n')[1], '这一轮用不了：hand-cheek、v、hug。');
});

test('through the real chat: the window turn is told no kiss or hug, and a ⟦hug⟧ marker-only reply leaves no grey line', async () => {
  const w = chatWorld({ stream: ['⟦hu', 'g⟧'], beats: true, passThrough: true });
  w.beatsHost.situate(() => WINDOW);
  w.send('r1');
  await settle(() => w.settled('r1'), 'settles');
  assert.ok(!mentionsClose(String(w.tasks[0].prompt).split('\n').filter(line => line.includes('标记里只能是')).join('\n')), 'the prompt lists no kiss / hug');
  assert.equal(w.shown.join(''), '');
  const events = w.events as { type: string; speechBeats?: { beats?: { word: string }[]; final?: unknown } }[];
  const beats = events.filter(e => e.type === 'beats');
  assert.deepEqual(beats.flatMap(e => e.speechBeats?.beats ?? []).map(beat => beat.word), []);
  assert.deepEqual(beats.at(-1)?.speechBeats?.final, { performanceOnly: true, line: '', history: null });
});

test('the window engine: kiss, hug and their frames play nothing, not even the lighter smile; the knob on plays them again', () => {
  const beats = new WindowBeats();
  for (const word of ['kiss', 'hug', 'hug-held', 'pause', 'let-go']) assert.equal(beats.play(word, GATES, false, { arms: true }), false, word);
  assert.deepEqual(beats.played, [], 'nothing was performed: not the shy smile, not the lean-in');
  assert.equal(beats.active, false);
  for (let i = 0; i < 60; i++) { const frame = beats.frame(1 / 60, { armsHeld: false, speaking: false }); assert.equal(frame.hands, null); assert.deepEqual(frame.slots, {}); }
  assert.equal(beats.play('shy', GATES), true, 'every other word still plays');
  const back = new WindowBeats();
  back.closeMoments = true;
  assert.equal(back.play('kiss', GATES, false, { arms: true }), true);
  assert.deepEqual(back.played, ['kiss']);
  const hug = new WindowBeats();
  hug.closeMoments = true;
  assert.equal(hug.play('hug', GATES, false, { arms: true }), true);
  assert.equal(hug.play('let-go', GATES), true, 'a let-go lets go of a hug in place');
});

test('withoutCloseBeats takes out only the kiss, hug and frames', () => {
  const chunk = { text: 'a', beats: [{ word: 'shy' as const, at: 0 }, { word: 'kiss' as const, at: 0 }, { word: 'pause' as const, at: 1 }, { word: 'go' as const, at: 1 }] };
  const { chunk: rest, dropped } = withoutCloseBeats(chunk);
  assert.deepEqual(rest.beats.map(beat => beat.word), ['shy', 'go']);
  assert.equal(dropped, 2);
  assert.equal(withoutCloseBeats({ text: 'a', beats: [] }).dropped, 0);
});
