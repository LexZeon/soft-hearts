// I-203 frames on the public Gene in the real frame loop (tests/helpers/unbound-arrival.ts), 60 and 30 fps: her ⟦let-go⟧ ends the hug where she wrote it (in the hold: at once; on her way: once she has held the floor), her ⟦pause⟧ keeps her
// holding through it; every way back is the planned one (no jolt: R29d's unexpected step stays where the plain hug has it). I203_GENE_REPORT=1 prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ARRIVAL_KNOBS } from '../shared/unbound/arrival';
import { CLOSE_FRAME_KNOBS } from '../shared/unbound/close-moments';
import { boneSurprises, max, pointSurprises, runArrival } from './helpers/unbound-arrival';

const REPORT = process.env.I203_GENE_REPORT === '1';
/** When the pause comes in the hold (s): near the end of her own length (about 7 s for this mood), so holding through it is longer than she would have. */
const PAUSE_AT = 6;

type Relay = 'none' | 'let-go-hold' | 'let-go-early' | 'pause-long';
async function hug(fps: number, relay: Relay) {
  let holdAt: number | null = null, sent = false;
  const run = await runArrival('Gene', fps, 'hug', {
    relay: frame => {
      if (frame.phase === 'hold' && holdAt === null) holdAt = frame.t;
      if (sent || relay === 'none') return null;
      if (relay === 'let-go-early' && frame.phase === 'lean') { sent = true; return { frame: 'let-go', seconds: 0 }; } // her let-go came while she was still on her way
      if (holdAt === null) return null;
      if (relay === 'let-go-hold' && frame.t >= holdAt + 0.5) { sent = true; return { frame: 'let-go', seconds: 0 }; }
      if (relay === 'pause-long' && frame.t >= holdAt + PAUSE_AT) { sent = true; return { frame: 'pause', seconds: CLOSE_FRAME_KNOBS.pauseLongS }; }
      return null;
    },
  });
  const upper = run.boneNames.flatMap((n, i) => /足|ひざ/.test(n) ? [] : [i]);
  return { holdS: run.holdS, plannedHoldS: (run.plan as { holdS: number }).holdS, phases: [...new Set(run.frames.map(f => f.phase).filter(Boolean))],
    headCm: max(pointSurprises(run.frames.map(f => f.head))), upperDeg: max(boneSurprises(run.frames, upper)) };
}

for (const fps of [60, 30]) {
  test(`Gene ${fps} fps: a let-go in the hold ends it there, one on her way after the floor, a pause long keeps her holding; every way back as smooth as the plain hug's`, async () => {
    const plain = await hug(fps, 'none'), hold = await hug(fps, 'let-go-hold'), early = await hug(fps, 'let-go-early'), paused = await hug(fps, 'pause-long');
    const k = 60 / fps, step = 1 / fps;
    if (REPORT) console.log(`[i203 frames gene ${fps}]`, JSON.stringify({ plain, hold, early, paused }));
    for (const run of [hold, early, paused]) assert.deepEqual(run.phases, plain.phases, 'every beat as in the plain hug (walk, lean, hold, back, settle): nothing cut, nothing skipped');
    assert.ok(Math.abs(hold.holdS - 0.5) <= 2 * step, `let-go in the hold: she lets go there (${hold.holdS} s held; her own length ${plain.holdS} s)`);
    assert.ok(Math.abs(early.holdS - ARRIVAL_KNOBS.closeHoldMinS) <= 2 * step, `let-go on her way: she holds the floor, then lets go (${early.holdS} s)`);
    assert.ok(paused.holdS >= PAUSE_AT + CLOSE_FRAME_KNOBS.pauseLongS - 2 * step, `a pause long near the end of her hold: she holds through it (${paused.holdS} s ≥ ${PAUSE_AT + CLOSE_FRAME_KNOBS.pauseLongS} s)`);
    assert.ok(plain.holdS < paused.holdS, 'longer than her own length would have been');
    // No jolt: the head's and the upper body's unexpected step stays within the plain hug's bounds (the same gates as I-192 / I-203).
    for (const [name, run] of [['let-go in the hold', hold], ['let-go on her way', early], ['pause long', paused]] as const)
      assert.ok(run.headCm < 0.4 * k * k && run.upperDeg < 1.5 * k * k, `${name}: no jolt (head ${run.headCm.toFixed(3)} cm, upper ${run.upperDeg.toFixed(3)}°; plain ${plain.headCm.toFixed(3)} cm, ${plain.upperDeg.toFixed(3)}°)`);
  });
}
