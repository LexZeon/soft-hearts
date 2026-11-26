// 2026-11-25 (16:26 "抱抱不行"; docs/claude/2026-11-25-close-moments-1626.md) on the public Gene in the real frame loop (tests/helpers/unbound-arrival.ts),
// 60 and 30 fps: her hug she wrote now walks up while her own hand reach is letting go. The
// arms are still held by the hand for the first part of her walk (the page's armsFree is false until the reach is back); the hug's arms then
// come in through their own gate — every beat as in the plain hug, and no jolt beyond the plain hug's (R29d's unexpected step).
// CLOSE_1626_GENE_REPORT=1 prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boneSurprises, max, pointSurprises, runArrival } from './helpers/unbound-arrival';

const REPORT = process.env.CLOSE_1626_GENE_REPORT === '1';
/** The hand reach is back about this long after the hug starts walking (the stage brings the arm down over ~0.6 s; the run starts at frame 30). */
const HAND_BACK_S = 0.5 + 0.6;

async function hug(fps: number, handOut: boolean) {
  const run = await runArrival('Gene', fps, 'hug', handOut ? { armsFree: t => t >= HAND_BACK_S } : {});
  const upper = run.boneNames.flatMap((n, i) => /足|ひざ/.test(n) ? [] : [i]);
  const arms = run.boneNames.flatMap((n, i) => /腕|ひじ|手/.test(n) ? [i] : []);
  return { holdS: +run.holdS.toFixed(3), phases: [...new Set(run.frames.map(f => f.phase).filter(Boolean))],
    headCm: +max(pointSurprises(run.frames.map(f => f.head))).toFixed(3), upperDeg: +max(boneSurprises(run.frames, upper)).toFixed(3),
    armDeg: arms.length ? +max(boneSurprises(run.frames, arms)).toFixed(3) : 0 };
}

for (const fps of [60, 30]) {
  test(`Gene ${fps} fps: the hug walks up while her hand reach lets go: every beat as in the plain hug, the arms come in through their gate, no jolt`, async () => {
    const plain = await hug(fps, false), yielded = await hug(fps, true);
    const k = 60 / fps;
    if (REPORT) console.log(`[close-1626 gene ${fps}]`, JSON.stringify({ plain, yielded }));
    assert.deepEqual(yielded.phases, plain.phases, 'walk, lean, hold, back, settle: nothing cut, nothing skipped');
    assert.ok(Math.abs(yielded.holdS - plain.holdS) <= 2 / fps, `the same hold (${yielded.holdS} s; plain ${plain.holdS} s)`);
    assert.ok(yielded.headCm < 0.4 * k * k && yielded.upperDeg < 1.5 * k * k, `no jolt (head ${yielded.headCm} cm, upper ${yielded.upperDeg}°; plain ${plain.headCm} cm, ${plain.upperDeg}°)`);
    assert.ok(yielded.armDeg <= Math.max(plain.armDeg * 1.25, 0.2 * k * k), `the arms: ${yielded.armDeg}° (plain ${plain.armDeg}°)`);
  });
}
