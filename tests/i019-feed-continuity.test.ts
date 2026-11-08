/**
 * I-019 喂食认图: while the picture is being recognized she keeps eating exactly as before (B06), and her line comes after the
 * eating, through the ordinary speaking path. Recognition never touches the stage, so the measure here is the whole bite as the
 * user sees it with the new timing: the snack at her mouth, the bite and the chew, the seconds of "thinking" that recognition
 * takes (nothing new happens on the stage), then her line spoken. Held on the real Stage frame loop (public Gene, the reviewed
 * Stand VMD) at 60 and 30 fps, also with a frame arriving late at every view, as tests/rps-continuity.test.ts does: the
 * display guard (R29) must have nothing to catch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_CONTACT } from '../src/stage/mood-feedback';
import { FEED_LINE_AFTER_MS } from '../electron/feed-recognition/host';
import { geneStage } from './helpers/gene-stage-harness';

async function bite(fps: number, late: number, recognizeSeconds: number) {
  const h = await geneStage({ fps, refreshHz: 60 });
  const tick = h.stage.tick;
  let offset = 0;
  h.stage.tick = (time: number) => tick(time + offset);
  const caught: string[] = [];
  let last = 0;
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      h.tick();
      const state = h.stage.continuity?.getState();
      if (state && state.jumps > last) { caught.push(`${state.lastJump?.property} ${state.lastJump?.size} @${h.time().toFixed(2)}`); last = state.jumps; }
    }
  };
  const phase = (value: string) => {
    const view = h.stage.moodView;
    h.stage.setMood({ ...view, revision: view.revision + 1, snapshot: { ...view.snapshot, phase: value } });
    offset += late;
  };
  try {
    run(3);
    // The snack comes near, waits at her mouth (she opens it), and is accepted: the bite and the chew (B06, unchanged).
    for (let i = 0; i <= 10; i++) { h.stage.setMoodContact({ ...EMPTY_CONTACT, feeding: true, near: i / 10 }); run(0.05); }
    phase('food-wait'); run(0.3);
    h.stage.setMoodContact({ ...EMPTY_CONTACT, feeding: true, prepared: true, near: 1 }); phase('food-ready'); run(0.7);
    h.stage.setMoodContact({ ...EMPTY_CONTACT, feeding: true, prepared: true, accepted: true }); phase('food-eating'); run(0.9);
    h.stage.setMoodContact({ ...EMPTY_CONTACT }); run(0.22);
    phase('idle');
    // Recognition: the small model looks, the chat model words her line. Nothing new reaches the stage meanwhile.
    run(Math.max(recognizeSeconds, FEED_LINE_AFTER_MS / 1000 - 2.12));
    // Her line, read in the ordinary voice.
    h.stage.setSpeaking(true); offset += late; run(2.4);
    h.stage.setSpeaking(false); offset += late; run(3);
    assert.ok(h.stage.continuity?.getState(), 'the display guard is on and measuring');
    return caught;
  } finally { h.close(); }
}

for (const fps of [60, 30]) {
  test(`${fps} fps: the bite, the chew, the seconds of recognition and her line after it leave the guard nothing to catch`, async () => {
    assert.deepEqual(await bite(fps, 0, 4), [], 'on time');
    assert.deepEqual(await bite(fps, 1000 / 30, 4), [], 'a frame late at every view');
    assert.deepEqual(await bite(fps, 0, 0), [], 'the fastest recognition: her line still only after the eating');
  });
}
