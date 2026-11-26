// 边说边演「跨句子」：
// 表情、看向、眼神的拍子挂到同一条通道的下一拍接手，或这条回复说完，或保险上限，再按平常的缓动落下去；身体的词不挂；只演不说的不挂。
// 假时钟。三个舞台（旧舞台、Unbound、Unbound 窗口舞台）和窗口那边的判断（SpeechSpan、SpeechBeatsView）都在这里。
// 记录 docs/claude/2026-11-20-speech-beats-span.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechSpan } from '../shared/behaviors/speech-beats/span';
import { SPEECH_BEAT_TIMING } from '../shared/behaviors/speech-beats/knobs';
import { SpeechBeatsView } from '../src/brain/speech-beats-view';
import type { LifeActivity } from '../src/stage/procedural-life';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { WindowBeats } from '../src/unbound/window-mode/window-beats';
import { REST_TARGETS, type MotionRequest, type PoseTargets } from '../src/unbound/motion/generator';
import type { StreamEvent } from '../shared/brain/stream-event';
import type { UnboundBubble } from '../shared/unbound/scene';
import { laptopLens } from './helpers/unbound-peek';

const GRACE = SPEECH_BEAT_TIMING.spanGraceMs, CAP = SPEECH_BEAT_TIMING.holdCapMs;

// ---------------------------------------------------------------- the judgment: when is her speaking over (pure)

test('SpeechSpan, read-aloud off: over when the stream is done and the bubble showed it all, plus the grace; never twice', () => {
  const span = new SpeechSpan();
  span.begin('r1', 'shown', 0);
  assert.equal(span.hold('r1'), true);
  span.text('r1', '一二三四。'); span.shown('r1', 2, 100);
  assert.equal(span.ended(5000), false, 'not done yet');
  span.done('r1', 5, 200);
  assert.equal(span.ended(10_000), false, 'done, but the bubble has not shown it all');
  span.shown('r1', 5, 1000);
  assert.equal(span.ended(1000 + GRACE - 1), false);
  assert.equal(span.endsAt(), 1000 + GRACE);
  assert.equal(span.ended(1000 + GRACE), true);
  assert.equal(span.ended(99_999), false, 'once per reply');
  assert.equal(span.hold('r1'), false);
});

test('SpeechSpan, read-aloud on: over when the last segment has been read (estimated), plus the grace; a later segment moves it', () => {
  const span = new SpeechSpan();
  span.begin('r1', 'voice', 0);
  span.text('r1', '今天起得好早。昨晚睡得好吗？'); span.shown('r1', 14, 50); span.done('r1', 14, 60);
  span.voiced('r1', '今天起得好早。', 100);
  const first = 100 + 7 * SPEECH_BEAT_TIMING.voiceMsPerChar;
  assert.ok((span.endsAt() ?? 0) >= first + SPEECH_BEAT_TIMING.voiceGraceMs - 1, 'the text is not all read yet: it waits for the next segment');
  span.voiced('r1', '昨晚睡得好吗？', first);
  const last = first + 7 * SPEECH_BEAT_TIMING.voiceMsPerChar;
  assert.equal(span.endsAt(), last + GRACE);
  assert.equal(span.ended(last + GRACE - 1), false);
  assert.equal(span.ended(last + GRACE), true);
});

test('SpeechSpan: a performance-only reply never holds and never reports an end; cancel ends it for good; another reply is not this one', () => {
  const span = new SpeechSpan();
  span.begin('r1', 'shown', 0); span.performanceOnly('r1'); span.done('r1', 0, 10);
  assert.equal(span.hold('r1'), false);
  assert.equal(span.ended(1e9), false);
  span.begin('r2', 'shown', 0); span.text('r2', 'abc'); span.shown('r2', 1, 0);
  span.done('r1', 3, 1); span.shown('r1', 3, 1);
  assert.equal(span.ended(1e9), false, 'r1 events do not move r2');
  span.cancel('r2');
  assert.equal(span.hold('r2'), false);
  assert.equal(span.ended(1e9), false);
});

// ---------------------------------------------------------------- the old stage (overlay)

const BASE: LifeActivity = Object.freeze({ gazeX: 0.01, gazeY: -0.02, pointerFollow: 1, saccade: 1, lookAtUser: 1, headX: 0.003, headY: 0, headZ: 0,
  sway: 1, bodyZ: 0, blinkInterval: 1, lidSoft: 0, smileEyes: 0.1, mouthSmile: 0.05, lookUp: 0 });
const KEYS = ['gazeX', 'gazeY', 'headX', 'headY', 'headZ', 'lookUp', 'smileEyes', 'mouthSmile', 'lidSoft', 'blinkInterval'] as const;
const smile = (frame: LifeActivity) => frame.mouthSmile;
const smoothEnough = (frames: LifeActivity[], fps: number, label: string) => {
  for (const key of KEYS) {
    const values = frames.map(frame => frame[key]);
    const steps = values.slice(1).map((value, i) => Math.abs(value - values[i]));
    const range = Math.max(1e-6, Math.max(...values) - Math.min(...values));
    assert.ok(Math.max(...steps) <= range * (fps === 60 ? 0.06 : 0.12) + 1e-9, `${label} ${fps} fps ${key}: step ${Math.max(...steps).toFixed(5)} of ${range.toFixed(5)}`);
  }
};

// ---------------------------------------------------------------- the window's judgment feeding the stage (SpeechBeatsView)

function world(pacing: 'voice' | 'shown' = 'shown') {
  let now = 0, next = 1;
  const timers: { at: number; run: () => void; id: number }[] = [];
  const log: string[] = [];
  const view = new SpeechBeatsView({
    now: () => now,
    setTimer: (run, ms) => { const id = next++; timers.push({ at: now + ms, run, id }); return id; },
    clearTimer: id => { const i = timers.findIndex(timer => timer.id === id); if (i >= 0) timers.splice(i, 1); },
    perform: (word, span) => { log.push(`${now}:${word}:${span ? 'span' : 'timed'}`); },
    release: () => { log.push(`${now}:release`); },
    pacing: () => pacing,
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (let guard = 0; ; guard++) {
      assert.ok(guard < 1000, 'the timer keeps firing without moving on (a due time that never clears)');
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > until) break;
      timers.shift(); now = due.at; due.run();
    }
    now = until;
  };
  const beats = (id: string, list: { word: string; at: number }[]): StreamEvent => ({ id, kind: 'chat', type: 'beats', text: '', speechBeats: { beats: list as never } });
  const final = (id: string): StreamEvent => ({ id, kind: 'chat', type: 'beats', text: '', speechBeats: { final: { performanceOnly: true, line: '（笑）', history: null } } });
  return { view, advance, beats, final, log, now: () => now };
}
const releases = (log: string[]) => log.filter(line => line.endsWith(':release'));

test('view, read-aloud off: a smile at sentence 1 stays through sentences 2 and 3, and is released after the last sentence is shown plus the grace', () => {
  const w = world('shown'), text = '今天起得好早。昨晚睡得好吗？我也还行。';
  w.view.begin('r1');
  w.log.length = 0;
  w.view.receive(w.beats('r1', [{ word: 'smile-warm', at: 0 }]));
  w.view.shown('r1', '今', text);
  assert.deepEqual(w.log, ['0:smile-warm:span']);
  for (const cut of [7, 14, text.length]) { w.advance(1500); w.view.shown('r1', text.slice(0, cut), text); }
  w.view.done('r1', text.length);
  assert.deepEqual(releases(w.log), [], 'sentence 3 is up, still held');
  const done = w.now();
  w.advance(GRACE - 1);
  assert.deepEqual(releases(w.log), []);
  w.advance(2);
  assert.deepEqual(releases(w.log), [`${done + GRACE}:release`], 'the timer fired at the end of the grace');
  w.advance(60_000);
  assert.equal(releases(w.log).length, 1, 'once');
});

test('view: a stop or an error releases at once; a new reply releases the old one; nothing is replayed', () => {
  const w = world('shown');
  w.view.begin('r1');
  w.view.receive(w.beats('r1', [{ word: 'shy', at: 0 }]));
  w.view.shown('r1', '你', '你好');
  w.advance(3000);
  w.log.length = 0;
  w.view.cancel();
  assert.deepEqual(releases(w.log), ['3000:release']);
  w.log.length = 0;
  w.view.begin('r2');
  w.view.receive(w.beats('r2', [{ word: 'laugh', at: 0 }]));
  w.view.shown('r2', '哈', '哈哈');
  w.advance(2000);
  w.view.begin('r3');
  assert.ok(releases(w.log).includes(`${w.now()}:release`), 'the new reply let the old smile go');
  assert.deepEqual(w.log.filter(line => line.includes(':laugh:')), ['3000:laugh:span'], 'laugh was played once');
  w.advance(60_000);
  assert.deepEqual(w.log.filter(line => line.includes(':laugh:')).length, 1);
});

test('view, performance-only: each beat plays in turn with its usual time (not held) and no speaking-end release', () => {
  const w = world('shown');
  w.view.begin('r1');
  w.view.receive(w.beats('r1', [{ word: 'smile-small', at: 0 }, { word: 'pout', at: 0 }]));
  w.view.receive(w.final('r1'));
  w.view.done('r1', 0);
  w.advance(10_000);
  assert.deepEqual(w.log.filter(line => !line.endsWith(':release')), [`0:smile-small:timed`, `${SPEECH_BEAT_TIMING.performanceGapMs}:pout:timed`]);
  assert.deepEqual(releases(w.log).filter(line => !line.startsWith('0:')), []);
});

test('view, read-aloud on: held through the reading, released after the last segment has been read plus the grace', () => {
  const w = world('voice');
  w.view.begin('r1');
  w.log.length = 0;
  const text = '今天起得好早。昨晚睡得好吗？';
  w.view.receive(w.beats('r1', [{ word: 'smile-warm', at: 0 }]));
  w.view.shown('r1', text, text);
  w.view.done('r1', text.length);
  w.view.voiced({ kind: 'start', key: 'r1#0', text: '今天起得好早。', voiced: true });
  w.advance(1540);
  w.view.voiced({ kind: 'start', key: 'r1#1', text: '昨晚睡得好吗？', voiced: true });
  const start = w.now();
  w.advance(7 * SPEECH_BEAT_TIMING.voiceMsPerChar + GRACE - 1);
  assert.deepEqual(releases(w.log), [], 'her voice is still on the second sentence');
  w.advance(2);
  assert.deepEqual(releases(w.log), [`${start + 7 * SPEECH_BEAT_TIMING.voiceMsPerChar + GRACE}:release`]);
  assert.deepEqual(w.log.filter(line => line.includes('smile-warm')), ['0:smile-warm:span']);
});

// ---------------------------------------------------------------- Unbound mode (the showcase performer)

const HOME = { x: 0, z: -0.85 };
const beatsEvent = (id: string, beats: { word: string; at: number }[], final?: { performanceOnly: boolean }): UnboundBubble =>
  ({ id, type: 'beats', text: '', speechBeats: { beats: beats as never, ...(final ? { final: { ...final, line: '', history: null } } : {}) } });

function body() {
  const requests: MotionRequest[] = [];
  const generator = { generate: (request: MotionRequest) => { requests.push(request); return { ...REST_TARGETS }; }, reset() {} };
  const target = { sense: {} as never, setPoseTargets: (_value: PoseTargets) => {} };
  return { generator, target, requests };
}
const warmOf = (request: MotionRequest | undefined) => { const intent = request?.intent as unknown as { face?: { warm: number; pout: number; laugh: number } } | undefined; return intent?.face?.warm ?? 0; };
const poutOf = (request: MotionRequest | undefined) => { const intent = request?.intent as unknown as { face?: { warm: number; pout: number } } | undefined; return intent?.face?.pout ?? 0; };

/** Frames (60 fps) of the player; `each` runs before each frame with the time in seconds. Returns the warm smile per frame. */
function runPlayer(player: UnboundSpeechBeats, f: ReturnType<typeof body>, fps: number, seconds: number, each: (t: number) => void) {
  const lens = laptopLens(), warm: number[] = [], pout: number[] = [];
  for (let k = 0; k <= seconds * fps; k++) { each(k / fps); player.frame(1 / fps, lens, HOME, f.target, true); warm.push(warmOf(f.requests.at(-1))); pout.push(poutOf(f.requests.at(-1))); }
  return { warm, pout };
}
const maxStep = (values: number[]) => Math.max(0, ...values.slice(1).map((value, i) => Math.abs(value - values[i])));

test('Unbound: a warm smile at sentence 1 is still up at sentence 3; her speaking ending releases it with the performer’s own ease; then she hands back', () => {
  const f = body(), player = new UnboundSpeechBeats(f.generator as never);
  const { warm } = runPlayer(player, f, 60, 14, t => {
    if (Math.abs(t - 0.5) < 1 / 120) { player.receive(beatsEvent('r1', [{ word: 'smile-warm', at: 0 }])); player.receive({ id: 'r1', type: 'delta', text: '你好呀，', rev: 1 }); }
    if (Math.abs(t - 3) < 1 / 120) player.receive({ id: 'r1', type: 'delta', text: '今天也一起吧。', rev: 2 });
    if (Math.abs(t - 6) < 1 / 120) player.receive({ id: 'r1', type: 'delta', text: '我在呢。', rev: 3 });
    if (Math.abs(t - 7) < 1 / 120) player.receive({ id: 'r1', type: 'done', text: '', rev: 4 });
  });
  assert.ok(warm[60 * 6.5] > 0.3, `sentence 3: ${warm[60 * 6.5].toFixed(3)}`);
  assert.ok(warm[60 * 7.5] > 0.2, 'still inside the grace');
  assert.ok(warm[60 * 11] < 0.03, `released after her speaking ended: ${warm[60 * 11].toFixed(3)}`);
  assert.ok(maxStep(warm) < 0.06, `eased: max step ${maxStep(warm).toFixed(4)}`);
  assert.equal(player.active, false, 'handed back after the release');
});

test('Unbound: without the hold a smile is over by sentence 3 (the old fixed time), so the hold is what keeps it', () => {
  const f = body(), player = new UnboundSpeechBeats(f.generator as never);
  const { warm } = runPlayer(player, f, 60, 9, t => {
    if (Math.abs(t - 0.5) < 1 / 120) { player.receive(beatsEvent('r1', [{ word: 'smile-warm', at: 0 }], { performanceOnly: true })); }
  });
  assert.ok(warm[60 * 8] < 0.03, `a performance-only beat holds its usual time then falls: ${warm[60 * 8].toFixed(3)}`);
});

for (const fps of [60, 30]) {
  test(`Unbound ${fps} fps: a new expression replaces the held one with an ease; the cap lets the last one go when nothing else comes`, () => {
    const f = body(), player = new UnboundSpeechBeats(f.generator as never);
    const { warm, pout } = runPlayer(player, f, fps, 30, t => {
      if (Math.abs(t - 0.5) < 0.5 / fps) { player.receive(beatsEvent('r1', [{ word: 'smile-warm', at: 0 }, { word: 'pout', at: 8 }])); player.receive({ id: 'r1', type: 'delta', text: '你好呀，', rev: 1 }); }
      if (Math.abs(t - 4) < 0.5 / fps) player.receive({ id: 'r1', type: 'delta', text: '嗯嗯嗯嗯嗯嗯', rev: 2 });
    });
    assert.ok(warm[Math.round(fps * 3.5)] > 0.3, 'the smile was up');
    assert.ok(warm[Math.round(fps * 7)] < 0.05 && pout[Math.round(fps * 7)] > 0.1, 'the pout took over after the smile fell');
    assert.ok(maxStep(warm) < (fps === 60 ? 0.06 : 0.12) && maxStep(pout) < (fps === 60 ? 0.1 : 0.2), `eased: ${maxStep(warm).toFixed(4)} / ${maxStep(pout).toFixed(4)}`);
    assert.ok(pout[Math.round(fps * 12)] > 0.1, 'the pout is still held (no done yet)');
    assert.ok(pout[Math.round(fps * 20)] < 0.03, 'the cap released it (no replacement, no done)');
    assert.equal(player.active, false);
  });
}

test('Unbound: cancel (stop / error) and a new reply release a held smile at once; body words keep their own short time', () => {
  for (const how of ['cancel', 'error', 'new-reply'] as const) {
    const f = body(), player = new UnboundSpeechBeats(f.generator as never);
    const { warm } = runPlayer(player, f, 60, 9, t => {
      if (Math.abs(t - 0.5) < 1 / 120) { player.receive(beatsEvent('r1', [{ word: 'smile-warm', at: 0 }])); player.receive({ id: 'r1', type: 'delta', text: '你好呀，', rev: 1 }); }
      if (Math.abs(t - 3) < 1 / 120) { if (how === 'cancel') player.cancel(); else if (how === 'error') player.receive({ id: 'r1', type: 'error', text: '', rev: 2 }); else player.receive({ id: 'r2', type: 'delta', text: '另一句', rev: 3 }); }
    });
    assert.ok(warm[60 * 2.9] > 0.3, how);
    assert.ok(warm[60 * 5.5] < 0.03, `${how}: released ${warm[60 * 5.5].toFixed(3)}`);
  }
  const f = body(), player = new UnboundSpeechBeats(f.generator as never), lens = laptopLens();
  player.receive(beatsEvent('r1', [{ word: 'tilt', at: 0 }]));
  player.receive({ id: 'r1', type: 'delta', text: '嗯', rev: 1 });
  const tilts: number[] = [];
  for (let k = 0; k < 60 * 6; k++) { player.frame(1 / 60, lens, HOME, f.target, true); const intent = f.requests.at(-1)?.intent as unknown as { tilt?: number } | undefined; tilts.push(Math.abs(intent?.tilt ?? 0)); }
  assert.ok(tilts[60 * 1] > 0.05, 'the tilt shows');
  assert.ok(tilts[60 * 4] < 0.001, 'and is a short gesture, not held');
});

// ---------------------------------------------------------------- the Unbound window stage (window-beats.ts)

const GATES = { shown: true, asleep: false, armsHeld: false };
const faceLevel = (frame: ReturnType<WindowBeats['frame']>) => Math.max(0, ...Object.values(frame.slots).map(Number), ...Object.values(frame.named).map(Number));

for (const fps of [60, 30]) {
  test(`window stage ${fps} fps: a held smile stays through sentence 3, releases when her speaking ends (eased), and a new expression replaces it`, () => {
    const beats = new WindowBeats(), levels: number[] = [], dt = 1 / fps;
    beats.play('smile-warm', GATES, true);
    for (let k = 0; k <= fps * 16; k++) {
      const t = k * dt;
      if (Math.abs(t - 6) < dt / 2) beats.play('pout', GATES, true);
      if (Math.abs(t - 10) < dt / 2) beats.releaseSpan();
      levels.push(faceLevel(beats.frame(dt, { armsHeld: false })));
    }
    assert.ok(levels[Math.round(fps * 5.5)] > 0.3, 'still up at sentence 3');
    assert.ok(levels[Math.round(fps * 9.5)] > 0.1, 'the pout is held');
    assert.ok(levels[Math.round(fps * 15.5)] < 0.02, 'released');
    assert.ok(maxStep(levels) < (fps === 60 ? 0.1 : 0.2), `eased: ${maxStep(levels).toFixed(4)}`);
    assert.equal(beats.active, false);
  });
}

test('window stage: not held it is gone after its usual time; the cap releases a held one; asleep releases at once; hand words keep their short time', () => {
  const usual = new WindowBeats(), capped = new WindowBeats(), sleepy = new WindowBeats(), v = new WindowBeats();
  usual.play('smile-warm', GATES); capped.play('smile-warm', GATES, true); sleepy.play('smile-warm', GATES, true); v.play('v', GATES, true);
  let a = 0, b = 0, c = 0, handsLeft = true;
  for (let k = 0; k <= 60 * 20; k++) {
    const t = k / 60;
    a = faceLevel(usual.frame(1 / 60, { armsHeld: false }));
    b = faceLevel(capped.frame(1 / 60, { armsHeld: false }));
    c = faceLevel(sleepy.frame(1 / 60, { armsHeld: false, asleep: t > 3 }));
    const hands = v.frame(1 / 60, { armsHeld: false }).hands;
    if (t > 6 && hands && ((hands.left?.weight ?? 0) > 0 || (hands.right?.weight ?? 0) > 0)) handsLeft = false;
    if (Math.abs(t - 6) < 1 / 120) {
      assert.ok(faceLevel(usual.frame(0, { armsHeld: false })) < 0.03 && faceLevel(capped.frame(0, { armsHeld: false })) > 0.3, 'at 6 s only the held one (still awake) shows');
      assert.ok(c < 0.03, `asleep since 3 s: it has fallen by 6 s (${c.toFixed(3)})`);
    }
  }
  assert.ok(a < 0.02 && b < 0.02 && c < 0.02, `${a} ${b} ${c}`);
  assert.equal(handsLeft, true, 'the V hand is down long before');
});
