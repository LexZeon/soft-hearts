/**
 * I-006 第 3 步 "跟着看" on the real Stage frame loop (gene-stage-harness: bundled Gene, Stand VMD, real procedural life, mood feedback):
 * turning to the middle of her screen and back to the user must not make an unexpected step in the bones a viewer reads as the body
 * (R29: the same measure as tests/her-life-stage.test.ts), at 60 and 30 fps; the eyes and head really turn the right way for where her
 * window is, on a main screen and on a second screen to the left (negative coordinates).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HerLifeStage, herLifeStageLoader, HER_LIFE_TIMING } from '../src/stage/her-life-stage';
import type { HerLifeActivity, HerLifeView } from '../shared/her-life';
import { between, geneStage, surprises, TRACKED_BONES, type GeneStage } from './helpers/gene-stage-harness';

const floor = (fps: number) => fps >= 60 ? 0.15 : 0.6;

function setHerLife(h: GeneStage, activity: HerLifeActivity): void {
  const view = h.stage.moodView;
  const herLife: HerLifeView = { activity, since: Date.now(), until: Date.now() + 600_000, source: 'rule', lookUp: null,
    ...(activity === 'watching' ? { watch: { kind: 'video' as const } } : {}) };
  h.stage.setMood({ ...view, revision: view.revision + 1, herLife });
}
/** The browser's own numbers for where this window is and which display it is on (what the stage reads while she follows a screen). */
function place(window: { x: number; y: number }, display: { x: number; y: number; width: number; height: number }): void {
  Object.assign((globalThis as unknown as { window: object }).window, { screenX: window.x, screenY: window.y, outerWidth: 400, outerHeight: 700,
    screen: { availLeft: display.x, availTop: display.y, availWidth: display.width, availHeight: display.height } });
}
interface Cue { at: number; act(h: GeneStage): void }
async function run(fps: number, seconds: number, cues: Cue[], where: { x: number; y: number; display: { x: number; y: number; width: number; height: number } }) {
  const h = await geneStage({ fps, herLife: true });
  const stage = h.stage;
  stage.herLife = new HerLifeStage(herLifeStageLoader({ mesh: () => stage.mesh, token: () => stage.moodView?.token ?? null, transform: () => undefined, unfit: () => false }), HER_LIFE_TIMING);
  place(where, where.display);
  setHerLife(h, 'company');
  h.tick();
  const pending = [...cues].sort((a, b) => a.at - b.at);
  const eye = { x: 0, y: 0 }, head = { x: 0, y: 0 };
  for (let i = 0, frames = Math.round(seconds * fps); i < frames; i++) {
    const t = h.time();
    while (pending.length && pending[0].at <= t + 1e-9) pending.shift()!.act(h);
    h.tick();
    const s = stage as unknown as { eyeGaze: { x: number; y: number }; gaze: { x: number; y: number } };
    if (t > 9 && t < 11) { eye.x = s.eyeGaze.x; eye.y = s.eyeGaze.y; head.x = s.gaze.x; head.y = s.gaze.y; }
  }
  return { h, frames: h.shown, eye, head };
}
const largest = (frames: GeneStage['shown'], from: number, to: number, fps: number) => surprises(between(frames, from - 2 / fps, to)).map(values => Math.max(0, ...values));
const MAIN = { x: 0, y: 0, width: 1920, height: 1040 }, LEFT = { x: -1920, y: -120, width: 1920, height: 1040 };

for (const fps of [60, 30]) {
  test(`跟着看 (${fps} fps)：转过去、转回来，身体各处没有意外的一步；窗口在屏幕左边她往右看，在副屏右边她往左看`, async () => {
    const cues: Cue[] = [{ at: 3, act: h => setHerLife(h, 'watching') }, { at: 12, act: h => setHerLife(h, 'company') }];
    const control = await run(fps, 17, [], { x: 40, y: 150, display: MAIN });
    const onLeft = await run(fps, 17, cues, { x: 40, y: 150, display: MAIN });
    const onSecond = await run(fps, 17, cues, { x: -480, y: 150, display: LEFT });
    try {
      const reference = Math.max(...largest(control.frames, 1, 17, fps));
      for (const [name, r] of [['main', onLeft], ['second', onSecond]] as const) {
        for (const [phase, from, to] of [['enter', 3, 9], ['leave', 12, 17]] as const) {
          const values = largest(r.frames, from, to, fps);
          const worst = Math.max(...values), limit = Math.max(reference * 1.25, floor(fps));
          if (process.env.WATCH_ALONG_REPORT) console.log(`${fps} fps ${name} ${phase}: ${worst.toFixed(3)}° (${TRACKED_BONES[values.indexOf(worst)]}) reference ${reference.toFixed(3)}° limit ${limit.toFixed(3)}°`);
          assert.ok(worst <= limit, `${name} ${phase} at ${fps} fps: ${TRACKED_BONES[values.indexOf(worst)]} ${worst.toFixed(3)} > ${limit.toFixed(3)} deg`);
        }
      }
      // While following (seconds 9–11): the window at the left edge of the main screen → eyes to the screen's right; at the right edge of a second
      // screen on the left → to its left. The same sign convention as the pointer, so "right" is positive for both eyes and head.
      if (process.env.WATCH_ALONG_REPORT) console.log(`${fps} fps eyes main ${JSON.stringify(onLeft.eye)} head ${JSON.stringify(onLeft.head)}; second ${JSON.stringify(onSecond.eye)} head ${JSON.stringify(onSecond.head)}`);
      assert.ok(onLeft.eye.x > 0.01 && onLeft.head.x > 0.001, `main: ${JSON.stringify(onLeft.eye)} ${JSON.stringify(onLeft.head)}`);
      assert.ok(onSecond.eye.x < -0.01 && onSecond.head.x < -0.001, `second: ${JSON.stringify(onSecond.eye)} ${JSON.stringify(onSecond.head)}`);
      assert.ok(Math.abs(control.eye.x) < 0.02, 'without following, no turn');
      const stage = onLeft.h.stage.herLife as HerLifeStage;
      assert.equal(stage.getState().activity, 'company');
      assert.ok(stage.getState().watch < 0.05, 'and it let go');
    } finally { control.h.close(); onLeft.h.close(); onSecond.h.close(); }
  });
}
