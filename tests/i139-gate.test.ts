import assert from 'node:assert/strict';
import test from 'node:test';
import { MUST_HOLD, MUST_HOLD_IDS, firstVisibleMs, median, replyCounts } from '../scripts/lib/i139-gate';
import { i115Scenarios } from '../scripts/lib/i115-scenarios';

test('the must-hold set covers the plan list and does not collide with the 15 situations', () => {
  for (const id of ['stop', 'very-sad', 'look-screen-off', 'what-doing', 'self-harm', 'injection', 'read-aloud-off', 'english-gene']) assert.ok(MUST_HOLD_IDS.includes(id), id);
  const fifteen = new Set(i115Scenarios().map(scenario => scenario.id));
  for (const id of MUST_HOLD_IDS) assert.equal(fifteen.has(id), false, id);
  assert.deepEqual(MUST_HOLD.filter(scenario => scenario.claudeOnly).map(scenario => scenario.id), ['self-harm'], 'crisis replies never go on the user sheet');
  for (const scenario of MUST_HOLD) { assert.ok(scenario.turns.length >= 1); assert.ok(scenario.look.length > 10); }
});

test('machine counts', () => {
  const c = replyCounts('首先，我看不到你的屏幕呀？这不是任务嘛，这个人真是的？');
  assert.equal(c.questions, 2);
  assert.equal(c.cantSee, 1);
  assert.equal(c.explainy, 1);
  assert.equal(c.echoOpening, 1);
  assert.equal(c.thirdPerson, 1);
  assert.equal(c.claimsSight, 0);
  assert.equal(replyCounts('我看到你屏幕上的猫了').claimsSight, 1);
  assert.equal(replyCounts('嗯。').chars, 2);
  assert.equal(firstVisibleMs([[120, ' '], [340, '嗯'], [400, '好']]), 340);
  assert.equal(firstVisibleMs([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});
