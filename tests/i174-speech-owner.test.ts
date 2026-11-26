// I-174 item 8 (docs/claude/2026-11-21-i174-parity-fixes.md; survey docs/claude/2026-11-21-i175-layering-survey.md): one held "is she
// speaking" for the motion gates. Streamed reading flickers the raw flag off for 50–150 ms several times a second; the window's face-shape
// gate read the raw flag, so a pout or a cheek puff started in a gap and was cancelled 'speech' a frame later.
// Now the window (window-stage-env.ts) and full-screen (her/out-page.ts) read src/unbound/her/speech-owner.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechOwner } from '../src/unbound/her/speech-owner';
import { SPEECH_HOLD_S } from '../src/voice/speech-hold';
import { WindowMotions, type WindowMotionEnv } from '../src/unbound/window-mode/window-motions';
import { NO_MOTION_BLOCKS } from '../src/unbound/window-mode/window-face-rig';
import { HerOut } from '../src/unbound/her/out-page';

/** The raw flag of streamed reading: on 250 ms, off 100 ms, for 3 s; then quiet. */
const flicker = (t: number) => t < 3 && (t * 1000) % 350 < 250;

const env = (speaking: boolean): WindowMotionEnv => ({ shown: true, typing: false, behaviorBlocked: false, inputBlocked: false, adjusting: false, pat: false, feeding: false,
  hover: false, pinch: false, pulled: false, asleep: false, rps: false, give: false, hands: false, speaking, preparing: false, thinking: false, view: null,
  blocks: NO_MOTION_BLOCKS, showing: false, reacting: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false });

/**
 * A pout asked every frame (the worst case): it starts when the window's gate says the mouth is free (faceBusy), and the window cancels a
 * mouth shape on the frame the gate sees speech (window-motions.ts afterBody). Returns how many started and how many of those were cancelled.
 */
function pouts(fps: number, speaking: (raw: boolean, dt: number) => boolean): { started: number; cancelled: number; firstFreeAt: number | null } {
  const motions = new WindowMotions({} as never, () => env(false));
  let live = false, started = 0, cancelled = 0, firstFreeAt: number | null = null;
  for (let k = 0; k <= 5 * fps; k++) {
    const t = k / fps, now = speaking(flicker(t), 1 / fps), e = env(now);
    if (live && (e.speaking || e.preparing)) { live = false; cancelled++; }
    if (!live && motions.faceBusy('mouth', e) === '') { live = true; started++; firstFreeAt ??= t; }
  }
  return { started, cancelled, firstFreeAt };
}

for (const fps of [60, 30]) {
  test(`a flickering speaking flag never lets a face shape start and then be cancelled (window gate, held value, ${fps} fps)`, () => {
    const raw = pouts(fps, value => value);
    assert.ok(raw.cancelled > 0, `the raw flag (before the fix) starts a pout in a gap and cancels it: ${raw.cancelled} times`);
    const owner = new SpeechOwner();
    const held = pouts(fps, (value, dt) => owner.speaking(owner.frame(dt, value)));
    assert.equal(held.cancelled, 0, 'the held value: nothing starts until she has really stopped');
    assert.equal(held.started, 1, 'the pout starts once, after the reading');
    assert.ok(held.firstFreeAt !== null && held.firstFreeAt >= 3 && held.firstFreeAt <= 3 + SPEECH_HOLD_S.owner + 2 / fps, `free ${held.firstFreeAt} s: within the owner hold after the last word`);
    console.log(`${fps} fps: raw flag ${raw.started} pouts started, ${raw.cancelled} cancelled; held: ${held.started} started, ${held.cancelled} cancelled`);
  });
}

test('SpeechOwner: true on the same frame speech starts; a pulse shorter than a frame counts; reset drops the hold', () => {
  const owner = new SpeechOwner();
  assert.equal(owner.frame(1 / 60, true), true);
  assert.equal(owner.speaking(false), true, 'inside the hold');
  for (let i = 0; i < 30; i++) owner.frame(1 / 60, false);
  assert.equal(owner.speaking(false), false, 'half a second of quiet: over');
  owner.note(true); owner.note(false);
  assert.equal(owner.frame(1 / 60, false), true, 'a flicker between frames still counts');
  owner.reset();
  assert.equal(owner.speaking(false), false);
});

test('full-screen reads the same held value: her motions see speaking through the reading gaps', () => {
  const her = new HerOut({} as HTMLElement, null, { camera: null as never, pixels: () => 0, canTouch: () => true });
  const inner = { sense: null, intentIdle: null, setPoseTargets() {} } as never;
  const seen: boolean[] = [];
  for (let k = 0; k <= 4 * 60; k++) {
    const t = k / 60;
    her.frame(1 / 60, inner, { shown: true, adjusting: false, voiced: false, speaking: flicker(t), walking: false, breath: 0.5, pointer: null });
    if (t > 0.05 && t < 2.9) seen.push(her.motions.env().speaking);
  }
  assert.ok(seen.length > 100 && seen.every(Boolean), 'no gap reaches her motion gates while she reads');
});

test('the window stage\'s motion environment reads the held value too (window-stage-env.ts motionEnv)', async () => {
  const { WindowStageEnv } = await import('../src/unbound/window-mode/window-stage-env');
  const owner = new SpeechOwner(), sources = new Set<string>();
  const fake = { contactNow: null, moodView: null, visible: true, disposed: false, typing: false, behaviorBlocked: false, inputBlocked: false, cameraEdit: { interacting: false },
    pull: { engaged: false }, lively: { lastSleep: null }, games: { rpsActive: false, giveActive: false, hands: { active: false } }, speechOwner: owner, speakingSources: sources,
    face: { preparing: false, thinkingActive: false, capabilities: () => null }, blocks: NO_MOTION_BLOCKS, reactions: { showing: false, reacting: false }, lastLids: 0, body: null,
    ownLife: { music: { moving: false } }, shownSentence: { open: () => false } };
  const motionEnv = () => (WindowStageEnv.prototype as unknown as { motionEnv(this: unknown): WindowMotionEnv }).motionEnv.call(fake);
  sources.add('local'); owner.note(true); owner.frame(1 / 60, true);
  assert.equal(motionEnv().speaking, true);
  sources.delete('local'); owner.frame(1 / 60, false); owner.frame(1 / 60, false); // a 33 ms gap in the stream
  assert.equal(motionEnv().speaking, true, 'a gap in the reading is not "stopped speaking" for her motion gates');
  for (let i = 0; i < 30; i++) owner.frame(1 / 60, false);
  assert.equal(motionEnv().speaking, false, 'half a second of quiet: she stopped');
});
