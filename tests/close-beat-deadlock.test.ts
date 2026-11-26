// 2026-11-23: her words waited for a beat, and the beat
// waited for reading progress that could not come while those words waited for it (the line break before the beat was never spoken; at character 0
// there was nothing to read). Only the 40 s / 62 s caps broke it, and the order came out reversed.
// I-203 frames (2026-11-24): a kiss / hug itself no longer holds her words; only the frames she places do (⟦hug-held⟧, ⟦pause⟧). The same deadlock
// must not come back for them: the whole chain runs without any cap: the reply's stream (SpeechBeatTurn with the gate), the page's bubble (shown at
// once, or following the reading, which stops at the last spoken character), the page's player (the asks), the host's sequence (the answers).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CloseBeatSequence, CLOSE_SEQUENCE_CAPS } from '../electron/unbound/close-sequence';
import { SpeechBeatTurn } from '../electron/brain/speech-beats/turn';
import { SpeechBeatSchedule } from '../shared/behaviors/speech-beats/schedule';
import { SpeechBeatPlacer } from '../shared/behaviors/speech-beats/place';
import type { SpeechBeatsEvent } from '../shared/behaviors/speech-beats/interface';
import { pauseSeconds } from '../shared/unbound/close-moments';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { REST_TARGETS, type MotionRequest } from '../src/unbound/motion/generator';
import type { UnboundBubble } from '../shared/unbound/scene';
import { laptopLens } from './helpers/unbound-peek';

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
/** The user's 19:40 reply: sentences, a line break, then the hug and her words on the way, then the frame and the words after it. */
const BEFORE = '我先凑近一点，看着你的眼睛，慢慢地把脸靠过去，呼吸都放轻了，然后轻轻闭眼。\n';
const WAY = '走过来的路上，我一直在想你。\n';
const AFTER = '好了，抱到了，脸有点烫。';

function clock() {
  let now = 0, seq = 0; const timers = new Map<number, { at: number; run: () => void }>();
  return {
    ports: { setTimer: (run: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, run }); return id; }, clearTimer: (id: unknown) => { timers.delete(id as number); } },
    advance(ms: number) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.run(); } },
  };
}

/**
 * The chain. `follow`: the page's bubble shows only up to the last spoken character of what was pushed (the reading stops there: a line break is
 * not spoken); otherwise it shows everything pushed at once (read-aloud off). The page's asks go to the sequence as the peek host relays them.
 */
function chain(follow: boolean) {
  const c = clock(), caps: string[] = [], seq = new CloseBeatSequence({ ...c.ports, capped: (kind, phase) => caps.push(`${kind}:${phase}`) });
  const pushed: string[] = [], events: SpeechBeatsEvent[] = [];
  const turn = new SpeechBeatTurn(true, event => { events.push(event); toPage({ id: 'r1', type: 'beats', speechBeats: event } as unknown as UnboundBubble); }, null, seq);
  const requests: MotionRequest[] = [], asked: string[] = [];
  const gen = { id: 'fake', generate: (r: MotionRequest) => { requests.push(r); return { ...REST_TARGETS }; }, reset() {} } as never;
  const player = new UnboundSpeechBeats(gen, () => {}, word => { asked.push(word); seq.asked(word, 'play'); return Promise.resolve('play'); }, null,
    { ask: ask => { asked.push(ask.frameBeat); if (ask.frameBeat === 'pause') seq.reached('pause', pauseSeconds(ask.long === true)); }, quiet: () => true });
  let rev = 0, sentToPage = 0;
  function toPage(bubble: UnboundBubble) { player.receive(bubble); }
  const sendText = () => {
    const all = pushed.join(''), visible = follow ? all.trimEnd() : all;
    if (visible.length > sentToPage) { toPage({ id: 'r1', type: 'delta', text: visible.slice(sentToPage), rev: ++rev } as UnboundBubble); sentToPage = visible.length; }
  };
  const push = (type: 'delta', text: string) => { turn.shown(text); pushed.push(text); sendText(); };
  const input = turn.input(push);
  const lens = laptopLens(), home = { x: 0, z: -0.85 }, body = { sense: {} as never, setPoseTargets() {} }, gates = { shown: true, asleep: false, armsHeld: false };
  const frames = (n: number) => { for (let i = 0; i < n; i++) player.frame(1 / 60, lens, home, body, true, gates); };
  return { c, caps, seq, turn, pushed, events, asked, player, input, push, frames, shown: () => pushed.join(''),
    /** The reply streams: BEFORE, the hug, her words on the way, the frame, then AFTER; then the stream ends. */
    run(frame = '⟦hug-held⟧') { input('delta', BEFORE); input('delta', '⟦hug⟧'); input('delta', WAY); input('delta', frame); input('delta', AFTER); return turn.end(push); } };
}

for (const follow of [false, true]) {
  const mode = follow ? 'read-aloud on (the bubble follows the reading: the line break is never shown)' : 'read-aloud off (everything shown at once)';

  test(`the 19:40 reply as frames, ${mode}: the hug is asked when the words before it are out, her words on the way flow, the words after ⟦hug-held⟧ come once she holds, with no cap`, async () => {
    const k = chain(follow);
    let ended = false; void k.run().then(() => { ended = true; });
    assert.equal(k.shown(), BEFORE + WAY, 'the words before and on her way are out: nothing waits for the hug itself');
    assert.equal(k.seq.holding?.word, 'hug-held', 'only the frame holds the words after it');
    k.frames(10); await flush();
    assert.ok(k.player.played.includes('hug') && k.player.played.includes('hug-held'), `both reached: ${k.player.played}`);
    assert.deepEqual(k.asked, ['hug']);
    assert.equal(k.seq.holding?.phase, 'action', 'the host took it: the words wait for her hold (not for a cap)');
    assert.deepEqual(k.caps, [], 'no cap fired');
    k.seq.held('hug'); await flush();
    assert.equal(k.shown(), BEFORE + WAY + AFTER, 'she holds: her words come, in order');
    assert.equal(ended, true);
  });

  test(`⟦pause⟧ after a line break, ${mode}: reached when the words before it are said, her words go on after its length, with no cap`, async () => {
    const k = chain(follow);
    let ended = false; void k.run('⟦pause⟧').then(() => { ended = true; });
    k.frames(10); await flush();
    assert.ok(k.asked.includes('pause'), `the page told the host it reached the pause: ${k.asked}`);
    assert.equal(k.seq.holding?.phase, 'pause');
    k.c.advance(pauseSeconds(false) * 1000); await flush();
    // 2026-11-25 (16:26): the pause is over; the next sentence after the hug's own waits for her arms round (docs/claude/2026-11-25-close-moments-1626.md).
    assert.equal(k.shown(), BEFORE + WAY); assert.deepEqual(k.seq.holding, { word: 'contact', phase: 'action' });
    k.seq.held('hug'); await flush();
    assert.equal(k.shown(), BEFORE + WAY + AFTER); assert.equal(ended, true); assert.deepEqual(k.caps, []);
  });

  test(`the hug at character 0 (hug + look-you first), ${mode}: asked at once; her words never wait for it`, async () => {
    const k = chain(follow);
    k.input('delta', '⟦look-you⟧'); k.input('delta', '⟦hug⟧');
    let ended = false; k.input('delta', '好呀，过来，我抱抱你。'); void k.turn.end(k.push).then(() => { ended = true; });
    await flush();
    assert.equal(k.shown(), '好呀，过来，我抱抱你。', 'all out');
    k.frames(10); await flush();
    assert.ok(k.player.played.includes('hug'), `asked: ${k.player.played}`);
    assert.equal(ended, true);
    assert.deepEqual(k.caps, []);
  });
}

test('the beat is placed right after the last spoken character: a line break, spaces or several blank lines before it never move it past that (kiss, hug and the frames)', () => {
  const place = (shown: string[], at: number, word: 'kiss' | 'hug' | 'hug-held' | 'pause' | 'let-go' = 'kiss') => {
    const p = new SpeechBeatPlacer(); p.input({ text: shown.join(''), beats: [{ word, at }] });
    return shown.flatMap(piece => p.shown(piece)).concat(p.reach(Number.MAX_SAFE_INTEGER)).map(b => b.at);
  };
  assert.deepEqual(place(['好的闭眼。\n'], 6), [5], 'a line break before it');
  assert.deepEqual(place(['好的闭眼。', ' \n \n'], 9), [5], 'spaces and blank lines');
  assert.deepEqual(place(['好的闭眼。'], 5), [5], 'no blank: unchanged');
  assert.deepEqual(place(['\n'], 1), [0], 'only blank before it: at the start');
  for (const frame of ['hug-held', 'pause', 'let-go'] as const) assert.deepEqual(place(['好的闭眼。\n'], 6, frame), [5], `${frame} the same`);
  const other = new SpeechBeatPlacer(); other.input({ text: '好的。\n', beats: [{ word: 'smile-warm', at: 4 }] });
  assert.deepEqual(other.shown('好的。\n').concat(other.finish()).map(b => b.at), [4], 'only the kiss / hug / frame words move; other beats are as before');
});

test('the schedule: a kiss / hug / frame right after the last shown or last read character is due now, in both pacings; the others still wait for the next one', () => {
  const shown = new SpeechBeatSchedule();
  shown.begin('r', 'shown', 0); shown.shown('r', 5, 0);
  shown.add('r', [{ word: 'kiss', at: 5 }, { word: 'pause', at: 5 }, { word: 'smile-warm', at: 5 }], 10);
  assert.deepEqual(shown.due(10).map(p => p.word), ['kiss', 'pause'], 'shown: at the end of the shown words, a smile waits for the next character');
  const empty = new SpeechBeatSchedule();
  empty.begin('r', 'shown', 0); empty.add('r', [{ word: 'hug', at: 0 }], 10);
  assert.deepEqual(empty.due(10).map(p => p.word), ['hug'], 'nothing shown yet, beat at 0');
  const voice = new SpeechBeatSchedule();
  voice.begin('r', 'voice', 0); voice.add('r', [{ word: 'hug', at: 0 }, { word: 'kiss', at: 0 }], 10);
  assert.deepEqual(voice.due(10).map(p => p.word).sort(), ['hug', 'kiss'], 'read-aloud pacing, nothing read yet, beat at 0: due now');
  const read = new SpeechBeatSchedule();
  read.begin('r', 'voice', 0); read.text('r', '好的闭眼。\n好了。'); read.add('r', [{ word: 'hug-held', at: 5 }, { word: 'smile-warm', at: 5 }], 0);
  read.voiced('r', '好的闭眼。', 100);
  assert.deepEqual(read.due(100 + 5 * 400).map(p => p.word), ['hug-held'], 'voice: the frame at the end of the segment is due when the segment ends; the smile waits for the next one');
  const burst = new SpeechBeatSchedule();
  burst.begin('r', 'shown', 0); burst.shown('r', 30, 0);
  burst.add('r', [{ word: 'smile-warm', at: 1 }, { word: 'tilt', at: 3 }, { word: 'let-go', at: 6 }, { word: 'shy', at: 9 }], 10);
  assert.ok(burst.due(10).some(p => p.word === 'let-go'), 'a frame is never moved to a later burst (it is a place in her words, not a face)');
});

test('a hug she cannot play now (asleep) still asks the host, and one that waited past the wait is not dropped: her words after ⟦hug-held⟧ never depend on a cap', async () => {
  const k = chain(false);
  let ended = false; void k.run().then(() => { ended = true; });
  const lens = laptopLens(), home = { x: 0, z: -0.85 }, body = { sense: {} as never, setPoseTargets() {} };
  const asleep = { shown: true, asleep: true, armsHeld: false };
  for (let i = 0; i < 10; i++) k.player.frame(1 / 60, lens, home, body, true, asleep);
  await flush();
  assert.deepEqual(k.asked, ['hug'], 'asleep: the host is still asked (it answers and journals the reason)');
  assert.equal(k.seq.holding?.phase, 'action');
  k.seq.stop(); await flush(); assert.equal(ended, true);
  const late = chain(false);
  void late.run();
  const busy = { shown: true, asleep: false, armsHeld: false };
  for (let i = 0; i < 60 * 2; i++) late.player.frame(1 / 60, lens, home, body, false, busy); // something with priority has her for 2 s
  assert.deepEqual(late.asked, [], 'while she is held by something else it waits (3 s)');
  for (let i = 0; i < 60 * 2; i++) late.player.frame(1 / 60, lens, home, body, false, busy); // and 2 s more
  for (let i = 0; i < 10; i++) late.player.frame(1 / 60, lens, home, body, true, busy);
  assert.deepEqual(late.asked, ['hug'], 'past the wait it is still asked, not dropped');
  assert.deepEqual(late.caps, []);
});

test('the caps stay as the last resort and leave one journal row each time one lets her words go (a pause with no kiss / hug: no kind, no row)', async () => {
  const reach = chain(false); void reach.run();
  reach.c.advance(CLOSE_SEQUENCE_CAPS.reachMs); await flush();
  assert.deepEqual(reach.caps, ['hug:reach'], 'the page never asked: one row');
  assert.equal(reach.shown(), BEFORE + WAY + AFTER);
  const action = chain(false); void action.run();
  action.seq.asked('hug', 'play');
  action.c.advance(CLOSE_SEQUENCE_CAPS.actionMs); await flush();
  assert.deepEqual(action.caps, ['hug:action']);
  const fine = chain(false); void fine.run();
  fine.seq.asked('hug', 'play'); fine.seq.held('hug'); fine.c.advance(CLOSE_SEQUENCE_CAPS.actionMs + CLOSE_SEQUENCE_CAPS.reachMs); await flush();
  assert.deepEqual(fine.caps, [], 'no row when nothing was capped');
  const pause = chain(false); pause.input('delta', '嗯。⟦pause⟧好。'); void pause.turn.end(pause.push);
  pause.c.advance(CLOSE_SEQUENCE_CAPS.reachMs); await flush();
  assert.deepEqual(pause.caps, ['null:reach'], 'the wiring writes a row only with a kind');
  assert.equal(pause.shown(), '嗯。好。');
});
