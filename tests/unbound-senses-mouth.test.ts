// Unbound v1 step 2: the light follows the senses in use, her mouth follows the voice, and a companion window hidden only because she is
// out counts as shown for the things that ask (the internal channel's set_perception).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_SENSES, anySense, litSenses, parseSenses, sameSenses, senseLines, sensesFrom } from '../shared/unbound/senses';
import { STUCK_S, UnboundMouth, mouthTarget } from '../src/unbound/mouth';
import { seenWhileHeld } from '../electron/unbound/held-window';
import type { AgentWindow } from '../electron/safety/agent-channel/bridge';

test('the light: what is really in use, from the runtime state and the system sound', () => {
  assert.deepEqual(sensesFrom({}, false), NO_SENSES);
  assert.deepEqual(sensesFrom({ voiceInput: true }, false), { camera: false, microphone: true, screen: false, audio: false });
  assert.deepEqual(sensesFrom({ screenSharing: true }, false), { camera: false, microphone: false, screen: true, audio: false });
  assert.deepEqual(sensesFrom({}, true), { camera: false, microphone: false, screen: false, audio: true });
  assert.equal(sensesFrom({ cameraSharing: true }, false).camera, true, 'the old single camera switch');
  assert.equal(sensesFrom({ cameraSharing: true, cameraLocal: true, cameraImages: false }, false).camera, true, 'pose sensing reads the camera');
  assert.equal(sensesFrom({ cameraSharing: true, cameraLocal: false, cameraImages: true, cameraHeld: false }, false).camera, true, 'pictures with each message');
  assert.equal(sensesFrom({ cameraSharing: true, cameraLocal: false, cameraImages: true, cameraHeld: true }, false).camera, false, '「别看」: no frame is taken, so no light');
  assert.equal(sensesFrom({ cameraSharing: true, cameraLocal: true, cameraImages: true, cameraHeld: true }, false).camera, true, 'but pose sensing still runs');
  assert.equal(sensesFrom({ cameraSharing: false, cameraLocal: true }, false).camera, false, 'sharing off wins');
  const all = sensesFrom({ voiceInput: true, screenSharing: true, cameraSharing: true }, true);
  assert.deepEqual(litSenses(all), ['camera', 'microphone', 'screen', 'audio']);
  assert.deepEqual(litSenses(NO_SENSES), []);
  assert.equal(anySense(NO_SENSES), false); assert.equal(anySense(all), true); assert.equal(anySense(null), false);
});

test('the hover text names exactly the senses that are on, and says how to turn them off', () => {
  assert.deepEqual(senseLines(NO_SENSES), []);
  assert.deepEqual(senseLines({ camera: true, microphone: false, screen: true, audio: false }), ['摄像头开着', '屏幕开着', '她在外面时它们一直开着；想关，先回小窗。']);
  assert.deepEqual(senseLines({ camera: false, microphone: true, screen: false, audio: true }), ['麦克风开着', '电脑的声音开着', '她在外面时它们一直开着；想关，先回小窗。']);
});

test('senses are compared and parsed strictly', () => {
  assert.equal(sameSenses(null, NO_SENSES), true);
  assert.equal(sameSenses({ ...NO_SENSES, screen: true }, NO_SENSES), false);
  assert.deepEqual(parseSenses({ camera: true, microphone: false, screen: false, audio: true }), { camera: true, microphone: false, screen: false, audio: true });
  for (const bad of [null, 'x', [], {}, { camera: 1, microphone: false, screen: false, audio: false }, { camera: true, microphone: false, screen: false }]) assert.equal(parseSenses(bad), null);
});

// ---- her mouth ------------------------------------------------------------------------------------------------------------------

function mouthSetup(motion = 0) {
  const influences = [0, 0, motion];
  return { influences, mouth: new UnboundMouth(influences, 2) };
}
const frames = (mouth: UnboundMouth, seconds: number, hz = 60) => { const peaks: number[] = []; for (let i = 0; i < seconds * hz; i++) { mouth.restore(); mouth.apply(1 / hz); peaks.push(mouth.open); } return peaks; };

test('the mouth is the pet\'s flap: nothing while silent, 0.23 to 0.68 of the open-mouth morph while the voice sounds', () => {
  assert.equal(mouthTarget({ mouth: false, flap: 1 }, 0.4), 0);
  assert.ok(Math.abs(mouthTarget({ mouth: true, flap: 1 }, 0) - 0.23) < 1e-9);
  assert.ok(mouthTarget({ mouth: true, flap: 1 }, Math.PI / 24) > 0.67, 'the open peak of |sin(12 t)|');
  assert.equal(mouthTarget({ mouth: true, flap: 0 }, 1), 0, 'the last syllable has eased shut');
  const { mouth, influences } = mouthSetup();
  assert.deepEqual(frames(mouth, 0.5).every(v => v === 0), true);
  mouth.speaking(true);
  const talking = frames(mouth, 1);
  assert.ok(Math.max(...talking) > 0.5 && Math.max(...talking) <= 0.69, `opens: ${Math.max(...talking)}`);
  assert.ok(Math.min(...talking.slice(30)) < Math.max(...talking) - 0.1, 'and flaps');
  assert.ok(influences[2] >= 0, 'writes the open-mouth morph only');
  assert.equal(influences[0] + influences[1], 0);
});

test('her mouth closes after the voice stops (by the same hold), and is put back as her motion had it every frame', () => {
  const { mouth, influences } = mouthSetup(0.2);
  mouth.speaking(true); frames(mouth, 0.6);
  mouth.restore(); assert.equal(influences[2], 0.2, 'restored to the motion\'s own value before her next frame');
  mouth.apply(1 / 60); assert.ok(influences[2] >= 0.2, 'on top of the motion, never below it');
  mouth.speaking(false);
  const after = frames(mouth, 1);
  assert.ok(after[after.length - 1] === 0, 'closed');
  assert.ok(after.slice(0, 5).some(v => v > 0.05), 'not shut in one frame: the last syllable eases out');
  mouth.restore(); assert.equal(influences[2], 0.2);
  mouth.apply(1 / 60); mouth.restore();
  assert.equal(influences[2], 0.2, 'silent frames leave the motion alone');
});

test('a voice flag that never comes back ends by itself, a stall is not a pause, and a model without a mouth has none', () => {
  const stuck = mouthSetup();
  stuck.mouth.speaking(true);
  frames(stuck.mouth, STUCK_S + 2, 10);
  assert.equal(stuck.mouth.isSpeaking, false, 'the lost "stopped" report does not leave her mouth flapping on');
  assert.equal(frames(stuck.mouth, 1).at(-1), 0);
  const stall = mouthSetup();
  stall.mouth.speaking(true); frames(stall.mouth, 0.5);
  stall.mouth.speaking(false); const gap = frames(stall.mouth, 0.08);
  stall.mouth.speaking(true);
  assert.ok(gap.every(v => v > 0.05), 'a gap shorter than the hold keeps moving (a stream\'s short stall)');
  assert.equal(UnboundMouth.forMesh({ morphTargetDictionary: { まばたき: 0 }, morphTargetInfluences: [0] }), null, 'no open-mouth morph');
  assert.ok(UnboundMouth.forMesh({ morphTargetDictionary: { まばたき: 0, あ: 1 }, morphTargetInfluences: [0, 0] }));
  assert.equal(UnboundMouth.forMesh({ morphTargetDictionary: { あ: 0 } }), null);
  const reset = mouthSetup(0.3); reset.mouth.speaking(true); frames(reset.mouth, 0.3); reset.mouth.reset();
  assert.equal(reset.influences[2], 0.3); assert.equal(reset.mouth.open, 0); assert.equal(reset.mouth.isSpeaking, false);
});

// ---- the companion window hidden only because she is out ---------------------------------------------------------------------------------

function fakeWindow(visible: boolean, minimized = false, destroyed = false) {
  const win = { visible, minimized, destroyed, isDestroyed: () => win.destroyed, isVisible: () => win.visible, isMinimized: () => win.minimized, webContents: { id: 1, isDestroyed: () => false, send: (_c: string, _v: unknown) => {} } };
  return win as typeof win & AgentWindow;
}

test('held out in Unbound: a hidden pet window counts as shown (the internal channel\'s set_perception asks); otherwise it is the window as it is', () => {
  const win = fakeWindow(false);
  let held = false;
  const seen = seenWhileHeld(win, () => held)!;
  assert.deepEqual([seen.isVisible(), seen.isMinimized()], [false, false], 'in the small window and hidden: hidden');
  held = true;
  assert.deepEqual([seen.isVisible(), seen.isMinimized()], [true, false], 'out in Unbound: on the screen');
  win.minimized = true;
  assert.equal(seen.isMinimized(), false, 'minimised only because she is out');
  held = false;
  assert.equal(seen.isMinimized(), true, 'back in the small window: the truth again');
  const shown = fakeWindow(true); assert.deepEqual([seenWhileHeld(shown, () => false)!.isVisible(), seenWhileHeld(shown, () => false)!.isMinimized()], [true, false]);
  const gone = fakeWindow(false, false, true);
  assert.equal(seenWhileHeld(gone, () => true)!.isVisible(), false, 'a destroyed window is never shown');
  assert.equal(seenWhileHeld(gone, () => true)!.isDestroyed(), true);
  assert.equal(seenWhileHeld(null, () => true), null);
  assert.equal(seen.webContents.id, 1);
});
