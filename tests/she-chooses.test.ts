/**
 * 她来挑（shared/she-chooses.ts，I-020 最小版）：分量 = 基础 × 此刻理由的倍数 × 最近挑过的调整；最近挑过的降低但不排除；
 * "为什么"只写真正抬高挑中那个的此刻理由和最近的调整；每次正好取一个随机数。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { sheChooses, SHE_CHOOSES_NO_LEAN, type SheChoosesCandidate } from '../shared/she-chooses';

interface Now { happy: boolean }
const candidates: SheChoosesCandidate<'a' | 'b' | 'c', Now>[] = [
  { id: 'a', label: '甲', weigh: now => ({ base: 1, reasons: now.happy ? [{ text: '心情：愉快', factor: 3 }] : [] }) },
  { id: 'b', label: '乙', weigh: () => ({ base: 1, reasons: [{ text: '有点困', factor: 0.5 }] }) },
  { id: 'c', label: '丙', weigh: () => ({ base: 0, reasons: [{ text: '心情：愉快', factor: 9 }] }) },
];
const once = (value: number) => { let calls = 0; return { random: () => { calls++; return value; }, calls: () => calls }; };

test('weights are base × the moment\'s factors × the recent adjustment; a zero base is outside her range now', () => {
  const r = once(0);
  const chose = sheChooses({ candidates, now: { happy: true }, random: r.random, recent: ['b'], recentFactors: [0.2] })!;
  assert.deepEqual(chose.weights.map(w => [w.id, w.weight]), [['a', 3], ['b', 0.1], ['c', 0]]);
  assert.equal(chose.id, 'a');
  assert.equal(r.calls(), 1, 'exactly one random number per choice');
  // The roll walks the weights in order: 3 of 3.1 is "a", the rest (0.1) is "b"; "c" (weight 0) is never picked.
  assert.equal(sheChooses({ candidates, now: { happy: true }, random: () => 0.96, recent: ['b'], recentFactors: [0.2] })!.id, 'a');
  assert.equal(sheChooses({ candidates, now: { happy: true }, random: () => 0.99, recent: ['b'], recentFactors: [0.2] })!.id, 'b');
  assert.equal(sheChooses({ candidates, now: { happy: true }, random: () => 0.999999, recent: [], recentFactors: [] })!.id, 'b');
});

test('the why is the real reasons that raised the chosen one, plus what was done recently; never the weights alone', () => {
  const happy = sheChooses({ candidates, now: { happy: true }, random: () => 0, recent: ['b'], recentFactors: [0.2] })!;
  assert.deepEqual(happy.why, ['心情：愉快', '上次是乙，这次降低它']);
  // Nothing raised it: said so honestly. A reason that lowered it is not offered as a reason for it.
  const plain = sheChooses({ candidates, now: { happy: false }, random: () => 0.99, recent: [], recentFactors: [] })!;
  assert.equal(plain.id, 'b');
  assert.deepEqual(plain.why, [SHE_CHOOSES_NO_LEAN]);
  // Chosen although done last time.
  const again = sheChooses({ candidates, now: { happy: true }, random: () => 0, recent: ['a'], recentFactors: [0.2] })!;
  assert.equal(again.id, 'a');
  assert.deepEqual(again.why, ['心情：愉快', '上次也是甲（降低了，还是挑中了）']);
  const earlier = sheChooses({ candidates, now: { happy: true }, random: () => 0, recent: ['b', 'a'], recentFactors: [0.2, 0.5] })!;
  assert.deepEqual(earlier.why, ['心情：愉快', '最近挑过甲（降低了一些，还是挑中了）', '上次是乙，这次降低它']);
});

test('done recently lowers a candidate but never rules it out, however small the knob', () => {
  const only: SheChoosesCandidate<'x', Now>[] = [{ id: 'x', label: '唯一', weigh: () => ({ base: 1, reasons: [] }) }];
  const chose = sheChooses({ candidates: only, now: { happy: false }, random: () => 0.5, recent: ['x'], recentFactors: [0] })!;
  assert.equal(chose.id, 'x');
  assert.equal(chose.weights[0].weight, 0.05, 'clamped to 0.05, not 0');
  // Over many rolls a two-way choice with "a" done last time still picks "a" sometimes, and less than without it.
  let seed = 1; const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const two = candidates.slice(0, 2).map(c => ({ ...c, weigh: () => ({ base: 1, reasons: [] }) }));
  let withRecent = 0, without = 0;
  for (let i = 0; i < 2000; i++) {
    if (sheChooses({ candidates: two, now: { happy: false }, random, recent: ['a'], recentFactors: [0.2] })!.id === 'a') withRecent++;
    if (sheChooses({ candidates: two, now: { happy: false }, random, recent: [], recentFactors: [] })!.id === 'a') without++;
  }
  assert.ok(withRecent > 100 && withRecent < 0.5 * without, `with recent ${withRecent}, without ${without}`);
});

test('no candidate in range: null, still one random number; a throwing candidate is skipped, bad numbers are inert', () => {
  const r = once(0.3);
  assert.equal(sheChooses({ candidates: [candidates[2]], now: { happy: true }, random: r.random, recent: [], recentFactors: [] }), null);
  assert.equal(r.calls(), 1);
  const broken: SheChoosesCandidate<string, Now>[] = [{ id: 'z', label: '坏', weigh: () => { throw Error('no'); } }, candidates[0]];
  assert.equal(sheChooses({ candidates: broken, now: { happy: false }, random: () => Number.NaN, recent: [], recentFactors: [] })!.id, 'a');
  const odd: SheChoosesCandidate<'n', Now>[] = [{ id: 'n', label: '怪', weigh: () => ({ base: Number.NaN, reasons: [{ text: 'x', factor: Number.POSITIVE_INFINITY }] }) }];
  assert.equal(sheChooses({ candidates: odd, now: { happy: false }, random: () => 0, recent: [], recentFactors: [] }), null);
});
