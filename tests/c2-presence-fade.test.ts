/**
 * C2 换成她 on the real Stage frame loop (gene-stage-harness, bundled Gene with its Stand motion) at 60 and 30 fps:
 * the model on stage fades out (MmdStage.fadeOutModel) and the next one fades in (revealModel), R29: no jump, no
 * one-frame cut, never frozen.
 * - Her motion during the fade is exactly the motion without it (frame by frame): the fade only changes opacity.
 * - The opacity moves a small, smooth step per frame (smoothstep: zero speed at both ends), never a cut; the
 *   comparison is an instant switch (a step of 1 in one frame).
 * R29_REPORT=1 prints the numbers recorded in docs/claude/2026-11-03-character-model.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PRESENCE_FADE_IN_MS, PRESENCE_FADE_OUT_MS, PresenceFade } from '../src/stage/presence-fade';
import { geneStage, type GeneStage } from './helpers/gene-stage-harness';

const REPORT = !!process.env.R29_REPORT;
const shownOpacity = (h: GeneStage) => Number(h.stage.renderer.domElement.dataset.presence ?? '1');

function opacityShape(values: number[]) {
  const steps = values.slice(1).map((value, index) => value - values[index]);
  const accel = steps.slice(1).map((value, index) => value - steps[index]);
  return { maxStep: Math.max(...steps.map(Math.abs)), maxAccel: Math.max(...accel.map(Math.abs)), first: Math.abs(steps.find(step => step !== 0) ?? 0) };
}

for (const fps of [60, 30]) {
  test(`C2 fade at ${fps} fps: she keeps moving exactly as before while fading out, and fades in without a cut`, async () => {
    const control = await geneStage({ fps }), event = await geneStage({ fps }), twin = await geneStage({ fps });
    try {
      for (const h of [control, event, twin]) h.run(2);
      const start = event.shown.length;
      // Fade out through the stage's own method (a model change starts it), frames keep running.
      const out = event.stage.fadeOutModel() as Promise<void>;
      const fadeOut: number[] = [shownOpacity(event)];
      const frames = Math.round((PRESENCE_FADE_OUT_MS / 1000 + 0.2) * fps);
      for (let i = 0; i < frames; i++) { control.tick(); twin.tick(); event.tick(); fadeOut.push(shownOpacity(event)); }
      await out;
      assert.equal(fadeOut.at(-1), 0, 'fully faded out');
      assert.ok(fadeOut.every((value, index) => index === 0 || value <= fadeOut[index - 1] + 1e-9), 'never comes back while fading out');
      // Her displayed motion during the fade is the undisturbed run's, frame for frame.
      const during = event.shown.slice(start), reference = control.shown.slice(start);
      assert.equal(during.length, reference.length);
      // Two runs without any fade already differ a hair (wall-clock inputs of the body scheduler); the fade adds nothing beyond that.
      const twinShown = twin.shown.slice(start);
      let largestGap = 0, noise = 0, travel = 0;
      for (let i = 0; i < during.length; i++) for (let bone = 0; bone < during[i].world.length; bone++) {
        largestGap = Math.max(largestGap, during[i].world[bone].angleTo(reference[i].world[bone]));
        noise = Math.max(noise, twinShown[i].world[bone].angleTo(reference[i].world[bone]));
        if (i) travel += during[i].world[bone].angleTo(during[i - 1].world[bone]);
      }
      assert.ok(largestGap <= Math.max(noise * 2, 1e-5), `the fade never changes her pose (gap ${largestGap} rad, two plain runs ${noise} rad)`);
      assert.ok(travel > 0, 'she keeps moving while fading out (not frozen)');
      // Fade in.
      (event.stage as { revealModel(): void }).revealModel();
      const fadeIn: number[] = [shownOpacity(event)];
      for (let i = 0; i < Math.round((PRESENCE_FADE_IN_MS / 1000 + 0.2) * fps); i++) { event.tick(); fadeIn.push(shownOpacity(event)); }
      assert.equal(fadeIn.at(-1), 1, 'fully there again');
      assert.ok(fadeIn.every((value, index) => index === 0 || value >= fadeIn[index - 1] - 1e-9));
      const outShape = opacityShape(fadeOut), inShape = opacityShape(fadeIn);
      // Smoothstep over the fade: largest step 1.5 / frames, first step tiny (starts at zero speed).
      const outFrames = PRESENCE_FADE_OUT_MS / 1000 * fps, inFrames = PRESENCE_FADE_IN_MS / 1000 * fps;
      assert.ok(outShape.maxStep <= 1.5 / outFrames + 0.01, `fade-out step ${outShape.maxStep}`);
      assert.ok(inShape.maxStep <= 1.5 / inFrames + 0.01, `fade-in step ${inShape.maxStep}`);
      assert.ok(outShape.first <= 3 / outFrames ** 2 + 0.005 && inShape.first <= 3 / inFrames ** 2 + 0.005, 'both start at (almost) zero speed');
      assert.ok(outShape.maxAccel <= 6 / outFrames ** 2 + 0.005 && inShape.maxAccel <= 6 / inFrames ** 2 + 0.005, 'speed changes smoothly');
      if (REPORT) console.log(`[C2 ${fps} fps] fade-out max step ${outShape.maxStep.toFixed(4)} first ${outShape.first.toFixed(4)} accel ${outShape.maxAccel.toFixed(4)}; `
        + `fade-in max step ${inShape.maxStep.toFixed(4)} first ${inShape.first.toFixed(4)} accel ${inShape.maxAccel.toFixed(4)}; pose gap ${largestGap.toExponential(1)} rad (plain runs ${noise.toExponential(1)}); instant switch step 1`);
    } finally { control.close(); event.close(); twin.close(); }
  });
}

test('C2 fade: a fade that turns around starts from what is shown; a hidden window arrives at once; waiters resolve', async () => {
  const fade = new PresenceFade();
  assert.equal(fade.value, 1);
  fade.fadeTo(0, 300);
  for (let i = 0; i < 9; i++) fade.frame(1 / 60);
  const mid = fade.value;
  assert.ok(mid > 0 && mid < 1);
  fade.fadeTo(1, 300);
  assert.equal(fade.value, mid, 'turning around never jumps');
  fade.frame(1 / 60);
  assert.ok(fade.value >= mid && fade.value - mid < 0.01);
  const done = fade.whenDone();
  fade.settle();
  await done;
  assert.equal(fade.value, 1);
  fade.set(0);
  assert.equal(fade.value, 0);
});
