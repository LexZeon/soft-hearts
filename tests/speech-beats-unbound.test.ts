// 边说边演第 3 步，Unbound 模式（src/unbound/speech-beat-player.ts）：所有的词都经展示的演员出第 2 层意图；有更优先的事时不开始；
// 演完交回；真实身体（公开的 Gene，Unbound figure）在 60 和 30 fps 下不跳。SPEECH_BEATS_REPORT=1 打印数字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from 'three';
import { UnboundSpeechBeats, speechBeatShowcase, UNBOUND_SPEECH_BEATS } from '../src/unbound/speech-beat-player';
import { ProceduralGenerator } from '../src/unbound/motion/procedural';
import { REST_TARGETS, type MotionRequest, type PoseTargets } from '../src/unbound/motion/generator';
import { validateBeats } from '../shared/unbound/showcase';
import { SPEECH_BEAT_WORDS } from '../shared/behaviors/speech-beats/interface';
import type { UnboundBubble } from '../shared/unbound/scene';
import { laptopLens } from './helpers/unbound-peek';
import { geneFigure, TRACKED } from './helpers/unbound-gene';

const HOME = { x: 0, z: -0.85 };
const beatsEvent = (id: string, beats: { word: string; at: number }[], final?: { performanceOnly: boolean }): UnboundBubble =>
  ({ id, type: 'beats', text: '', speechBeats: { beats: beats as never, ...(final ? { final: { ...final, line: '', history: null } } : {}) } });

function fakeBody() {
  const requests: MotionRequest[] = [], targets: PoseTargets[] = [];
  const generator = { generate: (request: MotionRequest) => { requests.push(request); return { ...REST_TARGETS }; }, reset() {} };
  const body = { sense: {} as never, setPoseTargets: (value: PoseTargets) => { targets.push(value); } };
  return { generator, body, requests, targets };
}

test('every word becomes a valid showcase beat (the Unbound engine plays them all)', () => {
  const beats = SPEECH_BEAT_WORDS.map((word, i) => ({ ...speechBeatShowcase(word), at: i }));
  const { beats: kept } = validateBeats(beats as never, { from: 0, to: 60 }) as unknown as { beats: unknown[] };
  assert.equal(kept.length, SPEECH_BEAT_WORDS.length);
});

test('beats follow the words as her bubble lets them out; all words, body ones too; she hands back after them', () => {
  const f = fakeBody(), player = new UnboundSpeechBeats(f.generator as never), lens = laptopLens();
  player.receive(beatsEvent('r1', [{ word: 'smile-warm', at: 0 }, { word: 'hand-cheek', at: 0 }, { word: 'tilt', at: 4 }]));
  player.frame(1 / 60, lens, HOME, f.body, true);
  assert.equal(player.active, false, 'nothing shown yet');
  player.receive({ id: 'r1', type: 'delta', text: '今天', rev: 1 });
  player.frame(1 / 60, lens, HOME, f.body, true);
  assert.deepEqual(player.played, ['smile-warm', 'hand-cheek']);
  assert.equal(f.requests.at(-1)?.intent.kind, 'showcase');
  player.receive({ id: 'r1', type: 'delta', text: '好开心。', rev: 2 });
  player.frame(1 / 60, lens, HOME, f.body, true);
  assert.deepEqual(player.played, ['smile-warm', 'hand-cheek', 'tilt']);
  player.receive({ id: 'r1', type: 'done', text: '', rev: 3 }); // her words are all out: the held smile rides them, then falls
  for (let i = 0; i < 60 * 6; i++) player.frame(1 / 60, lens, HOME, f.body, true);
  assert.equal(player.active, false, 'done and handed back');
  assert.deepEqual(f.targets.at(-1), { ...REST_TARGETS });
});

test('something with priority (a pull, a peek, an act, the opening beat): no beat starts over it; one that came due waits a moment (2026-11-23) and is dropped only past that; a playing one hands over', () => {
  const f = fakeBody(), player = new UnboundSpeechBeats(f.generator as never), lens = laptopLens();
  player.receive(beatsEvent('r1', [{ word: 'v', at: 0 }]));
  player.receive({ id: 'r1', type: 'delta', text: '耶', rev: 1 });
  player.frame(1 / 60, lens, HOME, f.body, false);
  assert.deepEqual(player.played, [], 'nothing starts over it');
  for (let i = 0; i < 60; i++) player.frame(1 / 60, lens, HOME, f.body, true);
  assert.deepEqual(player.played, ['v'], 'played once she is free (never dropped for a moment of priority)');
  const late = new UnboundSpeechBeats(f.generator as never);
  late.receive(beatsEvent('r9', [{ word: 'v', at: 0 }]));
  late.receive({ id: 'r9', type: 'delta', text: '耶', rev: 1 });
  for (let i = 0; i < 60 * 4; i++) late.frame(1 / 60, lens, HOME, f.body, false);
  late.frame(1 / 60, lens, HOME, f.body, true);
  assert.deepEqual(late.played, [], 'past the wait: dropped, not played out of its moment');
  player.receive(beatsEvent('r2', [{ word: 'laugh', at: 0 }]));
  player.receive({ id: 'r2', type: 'delta', text: '哈', rev: 2 });
  player.frame(1 / 60, lens, HOME, f.body, true);
  assert.equal(player.active, true);
  const before = f.targets.length;
  player.frame(1 / 60, lens, HOME, f.body, false);
  assert.equal(player.active, false);
  assert.equal(f.targets.length, before, 'the owner with priority writes from now on');
});

test('performance-only plays in order; an error drops what did not play; a step in brings her back where she stood', () => {
  const f = fakeBody(), player = new UnboundSpeechBeats(f.generator as never), lens = laptopLens();
  player.receive(beatsEvent('r1', [{ word: 'shy', at: 0 }, { word: 'lean-in', at: 0 }], { performanceOnly: true }));
  player.frame(1 / 60, lens, HOME, f.body, true);
  assert.deepEqual(player.played, ['shy']);
  let moved = false;
  for (let i = 0; i < 60 * 8; i++) moved = player.frame(1 / 60, lens, HOME, f.body, true) || moved;
  assert.deepEqual(player.played, ['shy', 'lean-in']);
  assert.equal(moved, true, 'main puts her back at her place');
  player.receive(beatsEvent('r2', [{ word: 'pout', at: 3 }]));
  player.receive({ id: 'r2', type: 'error', text: '', rev: 3 });
  player.receive({ id: 'r2', type: 'delta', text: '才没有呢', rev: 4 });
  for (let i = 0; i < 60; i++) player.frame(1 / 60, lens, HOME, f.body, true);
  assert.deepEqual(player.played, ['shy', 'lean-in']);
});

// ---------------------------------------------------------------- the real figure (public Gene), 60 and 30 fps

const DEG = 180 / Math.PI;
async function run(fps: number, withBeats: boolean) {
  const { fixture, figure } = await geneFigure({ xM: HOME.x, depthM: -HOME.z });
  figure.setGaitLook(false);
  figure.faceToward({ x: 0, z: 0.55 });
  const lens = laptopLens(), player = new UnboundSpeechBeats(new ProceduralGenerator());
  const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(bone => bone.name === name)!);
  const frames: Quaternion[][] = [];
  try {
    for (let frame = 0; frame <= fps * 9; frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      if (withBeats && frame === fps * 2) { player.receive(beatsEvent('r1', [{ word: 'smile-warm', at: 0 }, { word: 'tilt', at: 0 }, { word: 'v', at: 5 }])); player.receive({ id: 'r1', type: 'delta', text: '你好呀，', rev: 1 }); }
      if (withBeats && frame === Math.round(fps * 3.4)) player.receive({ id: 'r1', type: 'delta', text: '今天也一起吧。', rev: 2 });
      const body = { get sense() { return figure.sense; }, setPoseTargets: (value: PoseTargets) => figure.setPoseTargets(value) };
      if (!player.frame(dt, lens, HOME, body, true) && !player.active && t < 0.05) figure.setPoseTargets({ ...REST_TARGETS });
      figure.frame(dt);
      frames.push(bones.map(bone => bone.getWorldQuaternion(new Quaternion())));
    }
    return { frames, played: [...player.played] };
  } finally { figure.dispose(); fixture.close(); }
}
const surprise = (frames: Quaternion[][]) => {
  const step = new Quaternion(), last = new Quaternion(), inv = new Quaternion();
  let worst = 0;
  for (let i = 2; i < frames.length; i++) for (let b = 0; b < frames[i].length; b++) {
    step.copy(frames[i][b]).multiply(inv.copy(frames[i - 1][b]).invert());
    last.copy(frames[i - 1][b]).multiply(inv.copy(frames[i - 2][b]).invert());
    worst = Math.max(worst, step.angleTo(last) * DEG);
  }
  return worst;
};

for (const fps of [60, 30]) {
  test(`on the real Unbound figure at ${fps} fps: beats start, take over and hand back without a jump`, async () => {
    const control = await run(fps, false), event = await run(fps, true);
    const from = Math.round(fps * 1.5);
    const before = surprise(control.frames.slice(from)), after = surprise(event.frames.slice(from));
    if (process.env.SPEECH_BEATS_REPORT) console.log(`Unbound ${fps} fps: worst unexpected step ${after.toFixed(3)}° with beats vs ${before.toFixed(3)}° standing`);
    assert.deepEqual(event.played, ['smile-warm', 'tilt', 'v']);
    // The showcase's own bar for a choreographed move on Gene (tests/unbound-showcase.test.ts): no bone step jumps.
    assert.ok(after <= Math.max(before * 1.25, fps === 60 ? 1.2 : 2.4), `${fps} fps: ${after.toFixed(3)}° vs ${before.toFixed(3)}°`);
    void UNBOUND_SPEECH_BEATS;
  });
}
