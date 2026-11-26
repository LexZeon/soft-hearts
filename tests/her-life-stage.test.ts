/**
 * 她自己的生活 on the real Stage frame loop (gene-stage-harness: bundled Gene, Stand VMD, real procedural life,
 * mood feedback, chat-gesture player and the stage's own VMD loader reading the pinned Gene thinking / sleepy bytes).
 *
 * R29 measure ("unexpected step", tests/helpers/gene-stage-harness.ts surprises): how far one frame's world-space
 * step of a tracked bone departs from repeating the previous step. Entering and leaving every state, and being
 * interrupted by a chat or a head pat while she holds a pose, may not exceed max(1.25 × the reference run's own
 * largest value, floor); floor 0.15° at 60 fps, 0.6° at 30 fps (the same angular acceleration, R29d).
 * Reference: the same seconds without her activity (company), with the same chat or pat.
 * The "naive" run is the same scenario with every transition made instant (HerLifeTiming), to show what the
 * smoothing prevents. HER_LIFE_REPORT=1 prints the numbers in docs/claude/2026-11-02-her-life.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HerLifeStage, type HerLifeTiming } from '../src/stage/her-life-stage';
import type { HerLifeActivity, HerLifeView } from '../shared/stage/her-life';
import { TRACKED_BONES } from './helpers/frame-stats';

const NAIVE: HerLifeTiming = { yieldS: 1e-3, returnS: 1e-3, crossfadeS: 1e-3, lookUp: { rise: 1e-3, hold: 1, fall: 1e-3 }, poseAccel: { enter: Infinity, yield: Infinity } };
const floor = (fps: number) => fps >= 60 ? 0.15 : 0.6;

let lookUps = 0;
interface Verdict { worst: number; bone: string; reference: number; limit: number }
function verdict(event: number[], reference: number[], fps: number): Verdict {
  let worst = -1, index = 0;
  event.forEach((value, i) => { if (value > worst) { worst = value; index = i; } });
  const ref = Math.max(...reference);
  return { worst, bone: TRACKED_BONES[index], reference: ref, limit: Math.max(ref * 1.25, floor(fps)) };
}
const fmt = (v: number) => v.toFixed(3);
function report(label: string, smooth: Verdict, naive?: Verdict): void {
  if (process.env.HER_LIFE_REPORT) console.log(`${label}: ${fmt(smooth.worst)}° (${smooth.bone}) reference ${fmt(smooth.reference)}° limit ${fmt(smooth.limit)}°${naive ? ` | instant ${fmt(naive.worst)}° (${naive.bone})` : ''}`);
}

test('her life stage: the look-up runs once per host id and only while fresh; her own activity gives way in 0.3 s and returns gently', () => {
  const herLife = new HerLifeStage(null);
  const owner = {};
  const gates = { expressive: true, engaged: false, bodyOwned: false, asleep: false, posture: 50 };
  const view = (activity: HerLifeActivity, lookUp: HerLifeView['lookUp'] = null): HerLifeView => ({ activity, since: 0, until: 1, source: 'rule', lookUp });
  const frames = (seconds: number, input: Parameters<HerLifeStage['frame']>[1]) => { for (let i = 0; i < Math.round(seconds * 60); i++) herLife.frame(1 / 60, input); return herLife.getState(); };
  frames(3, { owner, view: view('daydream'), gates, nowMs: 0 });
  assert.equal(herLife.getState().presence, 1); assert.ok(herLife.life.gazeX > 0.1 && herLife.life.pointerFollow < 0.4, 'she looks into the distance');
  assert.equal(frames(0.3, { owner, view: view('daydream'), gates: { ...gates, engaged: true }, nowMs: 0 }).presence, 0, 'gives way within 0.3 s');
  assert.equal(herLife.life.gazeX, 0); assert.equal(herLife.life.pointerFollow, 1);
  const back = frames(0.75, { owner, view: view('daydream'), gates, nowMs: 0 });
  assert.ok(back.presence > 0.45 && back.presence < 0.55, 'and comes back over 1.5 s');
  // A look-up: once per id, while fresh (a few seconds), even while her own activity gives way to the user.
  const look = { id: 'a', at: 10_000 };
  frames(0.5, { owner, view: view('company', look), gates: { ...gates, engaged: true }, nowMs: 10_200 });
  assert.ok(herLife.life.lookUp > 0.9, 'eyes to the user');
  frames(2, { owner, view: view('company', look), gates: { ...gates, engaged: true }, nowMs: 12_000 });
  assert.equal(herLife.life.lookUp, 0, 'the same id does not start again');
  frames(0.5, { owner, view: view('company', { id: 'b', at: 0 }), gates, nowMs: 60_000 });
  assert.equal(herLife.life.lookUp, 0, 'a stale look-up is not shown');
  frames(0.5, { owner, view: view('company', { id: 'c', at: 60_000 }), gates: { ...gates, expressive: false }, nowMs: 60_100 });
  assert.equal(herLife.life.lookUp, 0, '"自动表现" off: no look-up');
});
