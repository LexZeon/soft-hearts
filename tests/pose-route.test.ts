import test from 'node:test';
import assert from 'node:assert/strict';
import { DegradeLadder, LADDER, SlowGpuWatch, budgetMs, chooseRoute } from '../electron/pose/route';

test('start-up choice: the faster working route, on the first ladder step its p90 fits', () => {
  assert.deepEqual(chooseRoute({ dml: 15, cpu: 45, dmlDetect: 6, cpuDetect: 12 }), { route: 'dml', index: 0 });
  assert.deepEqual(chooseRoute({ dml: null, cpu: 45, dmlDetect: null, cpuDetect: 12 }), { route: 'cpu', index: 0 }, 'DirectML failed: CPU');
  assert.deepEqual(chooseRoute({ dml: 400, cpu: 90, dmlDetect: 200, cpuDetect: 30 }), { route: 'cpu', index: 0 }, 'a slow GPU loses to a fast CPU');
  assert.deepEqual(chooseRoute({ dml: null, cpu: 180, dmlDetect: null, cpuDetect: 40 }), { route: 'cpu', index: 1 }, '5 fps does not fit: 2 fps');
  assert.deepEqual(chooseRoute({ dml: null, cpu: 450, dmlDetect: null, cpuDetect: 60 }), { route: 'cpu', index: 2 });
  assert.deepEqual(chooseRoute({ dml: null, cpu: 900, dmlDetect: null, cpuDetect: 120 }), { route: 'cpu', index: 3 }, 'only presence fits');
  assert.equal(LADDER[3].pose, false);
  assert.equal(chooseRoute({ dml: null, cpu: 3000, dmlDetect: null, cpuDetect: 900 }), null, 'nothing fits: sensing pauses');
  assert.equal(chooseRoute({ dml: null, cpu: null, dmlDetect: null, cpuDetect: null }), null);
  assert.equal(budgetMs(5), 100);
});

test('ladder: lower frame rate, then presence only, then pause; back up only after holding comfortably', () => {
  let t = 0;
  const ladder = new DegradeLadder(0, t);
  for (let i = 0; i < 9; i++) assert.equal(ladder.record(150, t += 200), false, 'needs 10 samples');
  assert.equal(ladder.record(150, t += 200), true);
  assert.equal(ladder.step.level, 'reduced');
  for (let i = 0; i < 10; i++) ladder.record(300, t += 500);
  assert.equal(ladder.step.level, 'minimal');
  for (let i = 0; i < 10; i++) ladder.record(600, t += 1000);
  assert.equal(ladder.step.level, 'presence-only');
  for (let i = 0; i < 10; i++) ladder.record(900, t += 1000);
  assert.equal(ladder.paused, true);
  assert.equal(ladder.record(1, t += 1000), false, 'paused stays paused');

  const recover = new DegradeLadder(1, (t = 0));
  for (let i = 0; i < 19; i++) assert.equal(recover.record(30, t += 500), false, 'not before 10 s');
  let up = false;
  for (let i = 0; i < 10 && !up; i++) up = recover.record(30, t += 500);
  assert.equal(up, true);
  assert.equal(recover.step.level, 'normal');
  for (let i = 0; i < 10; i++) recover.record(150, t += 200);
  assert.equal(recover.step.level, 'reduced', 'the step up did not hold');
  for (let i = 0; i < 38; i++) recover.record(30, t += 500);
  assert.equal(recover.step.level, 'reduced', 'the next try waits longer');
});

test('battery pressure takes one step down from the top and blocks stepping up', () => {
  let t = 0;
  const ladder = new DegradeLadder(0, t);
  assert.equal(ladder.record(20, t += 200, true), true);
  assert.equal(ladder.step.level, 'reduced');
  for (let i = 0; i < 100; i++) ladder.record(20, t += 500, true);
  assert.equal(ladder.step.level, 'reduced');
});

test('DirectML that crawls far over budget three frames running is abandoned', () => {
  const watch = new SlowGpuWatch();
  assert.equal(watch.record(400, 100), false);
  assert.equal(watch.record(400, 100), false);
  assert.equal(watch.record(50, 100), false, 'one good frame resets');
  assert.equal(watch.record(400, 100), false);
  assert.equal(watch.record(400, 100), false);
  assert.equal(watch.record(400, 100), true);
});
