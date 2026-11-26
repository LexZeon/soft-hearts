// I-174 item 5 (docs/claude/2026-11-21-i174-parity-fixes.md): a speech beat's hand word (a V, a hand at her cheek) does not start while
// her arms are held (猜拳, an offer, her reach, a held hand). The window had this rule (window-beats.ts); full-screen played the V in the
// middle of rock-paper-scissors. Both now ask src/unbound/speech-beat-player.ts speechBeatMayStart with the same gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEECH_BEAT_HAND_WORDS, UnboundSpeechBeats, speechBeatGatesOf, speechBeatMayStart, type SpeechBeatGates } from '../src/unbound/speech-beat-player';
import { WindowBeats } from '../src/unbound/window-mode/window-beats';
import { REST_TARGETS, type MotionRequest, type PoseTargets } from '../src/unbound/motion/generator';
import type { UnboundBubble } from '../shared/unbound/scene';
import { HerOut } from '../src/unbound/her/out-page';
import { laptopLens } from './helpers/unbound-peek';

const WORDS = ['v', 'hand-cheek', 'tilt', 'smile-warm', 'look-away-left', 'nonsense'];
const GATES: SpeechBeatGates[] = [
  { shown: true, asleep: false, armsHeld: false }, { shown: true, asleep: false, armsHeld: true },
  { shown: true, asleep: true, armsHeld: false }, { shown: false, asleep: false, armsHeld: false },
];

test('speechBeatMayStart: a hand word waits while her arms are held; asleep or not shown: nothing; other words go on', () => {
  assert.deepEqual([...SPEECH_BEAT_HAND_WORDS].sort(), ['hand-cheek', 'v']);
  assert.equal(speechBeatMayStart('v', GATES[1]), false);
  assert.equal(speechBeatMayStart('tilt', GATES[1]), true);
  assert.equal(speechBeatMayStart('tilt', GATES[2]), false);
  assert.equal(speechBeatMayStart('tilt', GATES[3]), false);
  assert.equal(speechBeatMayStart('nonsense', GATES[0]), false);
  assert.deepEqual(speechBeatGatesOf({ fatigue: { sleeping: true } }, true, false), { shown: true, asleep: true, armsHeld: false });
});

test('the window and full-screen play the same words under the same gates (the window plays at once; full-screen drops a refused word when it is due)', () => {
  const lens = laptopLens(), HOME = { x: 0, z: -0.85 };
  for (const gates of GATES) {
    for (const word of WORDS) {
      const win = new WindowBeats(), windowPlayed = win.play(word, gates);
      const requests: MotionRequest[] = [];
      const full = new UnboundSpeechBeats({ generate: (request: MotionRequest) => { requests.push(request); return { ...REST_TARGETS }; }, reset() {} } as never);
      const body = { sense: {} as never, setPoseTargets: (_value: PoseTargets) => {} };
      full.receive({ id: 'r1', type: 'beats', speechBeats: { beats: [{ word, at: 0 }] } } as unknown as UnboundBubble);
      full.receive({ id: 'r1', type: 'delta', text: '你好呀，今天也一起吧。', rev: 1 } as UnboundBubble);
      for (let k = 0; k < 30; k++) full.frame(1 / 60, lens, HOME, body, true, gates);
      assert.equal(full.played.includes(word), windowPlayed, `${word} with ${JSON.stringify(gates)}`);
    }
  }
});

test('full-screen: while 猜拳 holds her arm, a V in her reply is dropped (before: it played over the game); the free words still play', () => {
  const her = new HerOut({} as HTMLElement, null, { camera: null as never, pixels: () => 0, canTouch: () => true });
  (her as unknown as { figure: unknown }).figure = {}; // shown (a model is attached)
  assert.equal(her.beatGates().armsHeld, false);
  Object.defineProperty(her.games.games, 'busy', { value: true, configurable: true }); // a game holds her arms (WindowGames.armsHeld)
  const gates = her.beatGates();
  assert.equal(gates.armsHeld, true);
  const full = new UnboundSpeechBeats({ generate: () => ({ ...REST_TARGETS }), reset() {} } as never);
  full.receive({ id: 'r1', type: 'beats', speechBeats: { beats: [{ word: 'v', at: 0 }, { word: 'tilt', at: 0 }] } } as unknown as UnboundBubble);
  full.receive({ id: 'r1', type: 'delta', text: '石头剪刀布！', rev: 1 } as UnboundBubble);
  for (let k = 0; k < 30; k++) full.frame(1 / 60, laptopLens(), { x: 0, z: -0.85 }, { sense: {} as never, setPoseTargets() {} }, true, gates);
  assert.deepEqual(full.played, ['tilt']);
});
