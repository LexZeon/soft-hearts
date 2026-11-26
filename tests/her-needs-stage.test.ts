/**
 * 她也会需要你 on the real Stage frame loop (gene-stage-harness: bundled Gene, Stand VMD, real procedural life, mood feedback,
 * chat-gesture player). docs/claude/2026-11-03-she-needs-you.md.
 *
 * R29 measure ("unexpected step", tests/helpers/gene-stage-harness.ts surprises): how far one frame's world-space step of a tracked
 * bone departs from repeating the previous step. A small feeling coming, being soothed halfway, turning into the glow, fading away,
 * and the user's chat or pat arriving in the middle of it may not exceed max(1.25 × the reference run's own largest value, floor);
 * floor 0.15° at 60 fps, 0.6° at 30 fps (the same angular acceleration, R29d). Reference: the same seconds with no need.
 * The "naive" run makes every transition instant (HerLifeTiming) to show what the smoothing prevents.
 * HER_NEED_REPORT=1 prints the numbers in docs/claude/2026-11-03-she-needs-you.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HerLifeStage, type HerLifeTiming } from '../src/stage/her-life-stage';
import { HER_LIFE_NEUTRAL_PRESENTATION, type HerLifeActivity, type HerLifeView } from '../shared/stage/her-life';
import { HER_NEED_GLOW, HER_NEED_TABLE, type HerNeedId, type HerNeedView } from '../shared/mood/her-needs';
import { TRACKED_BONES } from './helpers/frame-stats';

const NAIVE: HerLifeTiming = { yieldS: 1e-3, returnS: 1e-3, crossfadeS: 1e-3, lookUp: { rise: 1e-3, hold: 1, fall: 1e-3 }, poseAccel: { enter: Infinity, yield: Infinity } };
const floor = (fps: number) => fps >= 60 ? 0.15 : 0.6;
const report = process.env.HER_NEED_REPORT;
const needView = (id: HerNeedId, mode: 'need' | 'glow' | 'low', strength = 1): HerNeedView => ({ id, mode, since: Date.now(), strength, usedToday: 1 });
const lifeView = (activity: HerLifeActivity): HerLifeView => ({ activity, since: Date.now(), until: Date.now() + 600_000, source: 'rule', lookUp: null });
interface Verdict { worst: number; bone: string; reference: number; limit: number }
function verdict(event: number[], reference: number[], fps: number): Verdict {
  let worst = -1, index = 0;
  event.forEach((value, i) => { if (value > worst) { worst = value; index = i; } });
  const ref = Math.max(...reference);
  return { worst, bone: TRACKED_BONES[index], reference: ref, limit: Math.max(ref * 1.25, floor(fps)) };
}
const fmt = (value: number) => value.toFixed(3);
function note(label: string, smooth: Verdict, naive?: Verdict): void {
  if (report) console.log(`${label}: ${fmt(smooth.worst)}° (${smooth.bone}) reference ${fmt(smooth.reference)}° limit ${fmt(smooth.limit)}°${naive ? ` | instant ${fmt(naive.worst)}° (${naive.bone})` : ''}`);
}

// ---------------------------------------------------------------- the stage's own rules (no model)

const gates = { expressive: true, engaged: false, bodyOwned: false, asleep: false, posture: 50 };
const view = (activity: HerLifeActivity): HerLifeView => ({ activity, since: 0, until: 1, source: 'rule', lookUp: null });
const need = (id: HerNeedId, mode: 'need' | 'glow' | 'low', strength = 1): HerNeedView => ({ id, mode, since: 0, strength, usedToday: 1 });

test('her needs stage: it replaces what she is doing while it lasts, scaled by its strength, and her own activity returns after', () => {
  const herLife = new HerLifeStage(null), owner = {};
  const frames = (seconds: number, input: Partial<Parameters<HerLifeStage['frame']>[1]>) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) herLife.frame(1 / 60, { owner, view: view('daydream'), gates, nowMs: 0, ...input });
    return herLife.getState();
  };
  frames(4, {});
  const daydreamGaze = herLife.life.gazeX;
  assert.ok(daydreamGaze > 0.1, 'daydreaming');
  assert.equal(frames(4, { need: need('lonely', 'need') }).need, 'need:lonely');
  const spec = HER_NEED_TABLE.lonely.presentation;
  assert.ok(Math.abs(herLife.life.gazeX - spec.gazeX) < 0.002 && Math.abs(herLife.life.gazeY - spec.gazeY) < 0.002, 'her small feeling, not the daydream');
  assert.ok(Math.abs(herLife.life.headX - spec.headX) < 1e-4 && Math.abs(herLife.life.lidSoft - spec.lidSoft) < 1e-4);
  // Half as strong: halfway between nothing and the table (after the stage has followed it).
  frames(10, { need: need('lonely', 'need', 0.5) });
  assert.ok(Math.abs(herLife.life.lidSoft - spec.lidSoft * 0.5) < 2e-3 && Math.abs(herLife.life.headZ - spec.headZ * 0.5) < 2e-3, 'half strength is half the offset');
  // 低落 after a need nobody answered: quiet (eyes lower, slower blinks, little swaying), scaled by how much has piled up, the same for every kind.
  assert.equal(frames(6, { need: need('lonely', 'low', 0.8) }).need, 'low');
  assert.ok(herLife.life.gazeY < -0.04 && herLife.life.lidSoft > 0.08 && herLife.life.sway < 0.7 && herLife.life.smileEyes === 0 && herLife.life.mouthSmile === 0);
  frames(8, { need: need('chatty', 'low', 0.4) });
  assert.ok(herLife.life.gazeY > -0.04 && herLife.life.gazeY < -0.02, 'less piled up, less of it');
  // The glow is the same whatever soothed her.
  assert.equal(frames(4, { need: need('chatty', 'glow') }).need, 'glow');
  assert.ok(Math.abs(herLife.life.smileEyes - HER_NEED_GLOW.presentation.smileEyes) < 1e-3 && herLife.life.mouthSmile > 0.25);
  assert.equal(frames(4, { need: need('lowEnergy', 'glow') }).need, 'glow', 'a different need, the same glow');
  // It ends: her own activity comes back.
  assert.equal(frames(4, { need: null }).need, null);
  assert.ok(Math.abs(herLife.life.gazeX - daydreamGaze) < 0.002, 'back to daydreaming');
});

test('her needs stage: a corrupted or unknown view is ignored; the fixed neutral presentation never changes', () => {
  const herLife = new HerLifeStage(null), owner = {};
  const before = { ...HER_LIFE_NEUTRAL_PRESENTATION };
  for (const bad of [{ id: 'nope', mode: 'need', since: 0, strength: 1, usedToday: 1 }, { id: 'lonely', mode: 'weird', since: 0, strength: 1, usedToday: 1 }, { id: 'lonely', mode: 'need', since: 0, strength: 0, usedToday: 1 }]) {
    for (let i = 0; i < 120; i++) herLife.frame(1 / 60, { owner, view: view('company'), gates, nowMs: 0, need: bad as unknown as HerNeedView });
    assert.equal(herLife.getState().need, null, JSON.stringify(bad));
    assert.equal(herLife.life.lidSoft, 0);
  }
  assert.deepEqual(HER_LIFE_NEUTRAL_PRESENTATION, before);
});
