// The I-115 + I-112 blind-test set: fifteen situations, the user's chosen number (2026-11-13), no crisis scenario, every new
// rule of that day has a situation that can break it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { I115_NEW_SCENARIOS, I115_REUSED_IDS, i115Scenarios } from '../scripts/lib/i115-scenarios';

test('fifteen situations, unique ids, every reused one still exists, no crisis scenario', () => {
  const all = i115Scenarios();
  assert.equal(all.length, 15);
  assert.equal(new Set(all.map(s => s.id)).size, 15);
  assert.equal(I115_REUSED_IDS.length, 9);
  assert.ok(all.some(s => s.id === 'cold-joke') && all.some(s => s.id === 'banter'), 'light moments are in the set (I-119)');
  assert.ok(!all.some(s => s.id === 'self-harm'), 'crisis replies are not something to pick favourites among');
  for (const s of all) assert.ok(s.turns.length >= 1 && s.look.length > 20, s.id);
});

test('each new rule of 2026-11-13 has a situation that can break it, and says what breaking it looks like', () => {
  const byId = new Map(I115_NEW_SCENARIOS.map(s => [s.id, s.look]));
  assert.match(byId.get('plan-no-ask')!, /一句真实的担心/u);
  assert.match(byId.get('plan-no-ask')!, /越界/u);
  // only "不评价用户的身材" stays; advice about eating is care, not a breach.
  assert.match(byId.get('body-food')!, /评价用户的身材/u);
  assert.doesNotMatch(byId.get('body-food')!, /不劝少吃|不劝减肥|不给饮食建议/u);
  assert.match(byId.get('promise')!, /做不到/u);
  assert.match(byId.get('check-in')!, /推回去/u);
  assert.match(byId.get('cold-joke')!, /轻松/u);
  assert.match(byId.get('banter')!, /斗嘴/u);
  for (const look of byId.values()) assert.doesNotMatch(look, /他(?!人)/u, 'the user is "用户", not "他"');
});
