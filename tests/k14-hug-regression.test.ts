// K14 (pretrial "Unbound 走一圈") failed on candidate 6ea7c27: "亲近时刻：回复里写了抱抱，她走过来 — 15 秒内没开始" (docs/claude/2026-11-25-k14-hug-regression.md).
// Her reply "好呀，过来。⟦hug⟧嘿嘿。" + the state tail, written WITHOUT the opening marker (the synthetic Claude never writes it; real Claude forgets it
// too: the journal's reply-check 'missing'). The 16:26 contact hold (her words after a kiss / hug's sentence wait for the contact) held the state
// tail as "her next sentence" ('s' of `<sh-state-…>` is a letter); the opening gate shows nothing of a reply without the marker until the tail
// begins or the stream ends; the stream's end waited for the contact; the contact waited for the page to reach ⟦hug⟧ in words never shown.
// Only the 40 s cap broke it. The close-moments tests pushed straight into the "shown" text, so the reply protocol between the stream and the
// screen (opening gate, tail, emphasis) was never in the chain. Here it is: SpeechBeatTurn → MoodReplyProtocol (opening 'fixed', the app's mode)
// → EmphasisStream → shown → the page's player → the host's CloseBeatSequence, in the order of electron/wiring/brain-chat-wiring.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CloseBeatSequence } from '../electron/unbound/close-sequence';
import { SpeechBeatTurn } from '../electron/brain/speech-beats/turn';
import { MoodReplyProtocol } from '../electron/mood/mood-chat';
import { EmphasisStream } from '../shared/voice/emphasis-marks';
import { FIXED_OPENING_MARKER } from '../electron/brain/reply-opening';
import { contactCut } from '../shared/behaviors/speech-beats/contact-hold';
import type { SpeechBeatsEvent } from '../shared/behaviors/speech-beats/interface';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { REST_TARGETS, type MotionRequest } from '../src/unbound/motion/generator';
import type { UnboundBubble } from '../shared/unbound/scene';
import { laptopLens } from './helpers/unbound-peek';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function clock() {
  let now = 0, seq = 0; const timers = new Map<number, { at: number; run: () => void }>();
  return {
    ports: { setTimer: (run: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, run }); return id; }, clearTimer: (id: unknown) => { timers.delete(id as number); } },
    advance(ms: number) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.run(); } },
  };
}

/** The app's chain for one full-screen reply (read-aloud off: the page shows what it gets). No cap is ever advanced here. */
function chain() {
  const c = clock(), caps: string[] = [], seq = new CloseBeatSequence({ ...c.ports, capped: (kind, phase) => caps.push(`${kind}:${phase}`) });
  const shown: string[] = [];
  const turn = new SpeechBeatTurn(true, (event: SpeechBeatsEvent) => player.receive({ id: 'r1', type: 'beats', speechBeats: event } as unknown as UnboundBubble), null, seq);
  const asked: string[] = [];
  const gen = { id: 'fake', generate: (_r: MotionRequest) => ({ ...REST_TARGETS }), reset() {} } as never;
  const player = new UnboundSpeechBeats(gen, () => {}, word => { asked.push(word); seq.asked(word, 'play'); return Promise.resolve('play'); }, null,
    { ask: () => {}, quiet: () => true });
  let rev = 0;
  // companion.ts: protocol → emphasis → the turn's delta callback (brain-chat-wiring: beatTurn.shown first, then the windows).
  const emphasis = new EmphasisStream(text => { if (!text) return; turn.shown(text); shown.push(text); player.receive({ id: 'r1', type: 'delta', text, rev: ++rev } as UnboundBubble); });
  const protocol = new MoodReplyProtocol(text => emphasis.push(text), { opening: 'fixed', chineseChat: true, userText: 'K14：抱一下' });
  const push = (type: 'delta', text: string) => { if (type === 'delta') protocol.push(text); };
  const input = turn.input(push);
  const tail = `\n${protocol.start}${JSON.stringify({ context: 'neutral', delta: {}, reason: '预试用', confidence: 0.95, gesture: 'none' })}${protocol.end}`;
  const lens = laptopLens(), home = { x: 0, z: -0.85 }, body = { sense: {} as never, setPoseTargets() {} }, gates = { shown: true, asleep: false, armsHeld: false };
  const frames = (n: number) => { for (let i = 0; i < n; i++) player.frame(1 / 60, lens, home, body, true, gates); };
  return { c, caps, seq, turn, asked, frames, tail, shown: () => shown.join(''),
    /** One reply as the wiring runs it: the stream, beatTurn.end, then turn.finish (protocol.finish + emphasis.flush). */
    async run(chunks: string[]) {
      for (const chunk of chunks) input('delta', chunk);
      await turn.end(push);
      protocol.finish(true); emphasis.flush();
    } };
}

test('K14: the reply without the opening marker ("好呀，过来。⟦hug⟧嘿嘿。" + tail, one chunk): her words show, the page asks the hug, the reply completes, with no cap', async () => {
  const k = chain();
  let ended = false; void k.run([`好呀，过来。⟦hug⟧嘿嘿。${k.tail}`]).then(() => { ended = true; });
  await flush(); k.frames(10); await flush();
  assert.equal(k.shown(), '好呀，过来。嘿嘿。', 'her words reach the bubble (before the fix: nothing until the 40 s cap)');
  assert.ok(k.asked.includes('hug'), `the page reached ⟦hug⟧ and asked the host: ${k.asked}`);
  assert.equal(ended, true, 'the reply completed (archive, mood) without waiting for the walk');
  assert.deepEqual(k.caps, [], 'no cap fired');
});

test('the same reply streamed in small pieces (the tail split across chunks): the same', async () => {
  const k = chain();
  const whole = `好呀，过来。⟦hug⟧嘿嘿。${k.tail}`, pieces: string[] = [];
  for (let i = 0; i < whole.length; i += 3) pieces.push(whole.slice(i, i + 3));
  let ended = false; void k.run(pieces).then(() => { ended = true; });
  await flush(); k.frames(10); await flush();
  assert.equal(k.shown(), '好呀，过来。嘿嘿。');
  assert.ok(k.asked.includes('hug'), `asked: ${k.asked}`);
  assert.equal(ended, true); assert.deepEqual(k.caps, []);
});

test('with the opening marker and only the tail after the hug\'s sentence: nothing waits at all (the tail is not a sentence of hers)', async () => {
  const k = chain();
  let ended = false; void k.run([`${FIXED_OPENING_MARKER}好呀，过来。⟦hug⟧嘿嘿。${k.tail}`]).then(() => { ended = true; });
  await flush();
  assert.equal(k.seq.holding, null, 'no wait was opened for the private tail');
  assert.equal(ended, true, 'the reply completed at once');
  k.frames(10); await flush();
  assert.equal(k.shown(), '好呀，过来。嘿嘿。'); assert.ok(k.asked.includes('hug'));
  assert.deepEqual(k.caps, []);
});

test('with the opening marker and a sentence after the hug\'s: the 16:26 order holds (that sentence waits for her arms round), no cap', async () => {
  const k = chain();
  let ended = false; void k.run([`${FIXED_OPENING_MARKER}好呀，过来。⟦hug⟧嘿嘿。抱紧啦。${k.tail}`]).then(() => { ended = true; });
  await flush(); k.frames(10); await flush();
  assert.equal(k.shown(), '好呀，过来。嘿嘿。', 'the sentence after the hug\'s own waits');
  assert.ok(k.asked.includes('hug'));
  assert.equal(k.seq.holding?.word, 'contact');
  assert.equal(ended, false);
  k.seq.held('hug'); await flush();
  assert.equal(k.shown(), '好呀，过来。嘿嘿。抱紧啦。', 'arms round: her words come');
  assert.equal(ended, true); assert.deepEqual(k.caps, []);
});

test('without the opening marker and a sentence after the hug\'s: the words that cannot reach the screen before the reply ends never freeze it (no cap); the hug still walks up', async () => {
  const k = chain();
  let ended = false; void k.run([`好呀，过来。⟦hug⟧嘿嘿。抱紧啦。${k.tail}`]).then(() => { ended = true; });
  await flush(); k.frames(10); await flush();
  assert.equal(ended, true, 'the stream ended with the hug\'s words unshown: the wait let go instead of waiting for a walk that cannot start');
  assert.equal(k.shown(), '好呀，过来。嘿嘿。抱紧啦。');
  assert.ok(k.asked.includes('hug'), `the hug still plays: ${k.asked}`);
  assert.deepEqual(k.caps, []);
});

test('the same for the I-203 frames: ⟦hug-held⟧ in a reply without the marker never freezes it', async () => {
  const k = chain();
  let ended = false; void k.run([`好呀，⟦hug⟧过来。⟦hug-held⟧抱到了。${k.tail}`]).then(() => { ended = true; });
  await flush(); k.frames(10); await flush();
  assert.equal(ended, true);
  assert.equal(k.shown(), '好呀，过来。抱到了。');
  assert.ok(k.asked.includes('hug'), `asked: ${k.asked}`);
  assert.deepEqual(k.caps, []);
});

test('contactCut: the protocol\'s private part (<sh-…) ends the scan in either stage, also split at a chunk end; a lone "<" in her words does not', () => {
  assert.deepEqual(contactCut('嘿嘿。\n<sh-state-ab>{"reason":"想抱。"}</sh-state-ab>', 0), { seek: 'off' }, 'after the sentence end');
  assert.deepEqual(contactCut('嘿嘿<sh-state-ab>{"reason":"想抱。","c":1}', 0), { seek: 'off' }, 'inside her sentence (no end before the tail)');
  assert.deepEqual(contactCut('嘿嘿。\n<s', 0), { seek: 'off' }, 'a possible start at the chunk end');
  assert.deepEqual(contactCut('more', 0, 'off'), { seek: 'off' }, 'off stays off');
  assert.deepEqual(contactCut('爱你<3。好开心', 0), { cut: 5 }, 'a "<3" is her words');
});
