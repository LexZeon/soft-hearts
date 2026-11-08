import test from 'node:test';
import assert from 'node:assert/strict';
import { mannWhitney, median, percentile, readUserField, report } from '../scripts/lib/user-state-eval';
import type { TurnRecord } from '../scripts/lib/prompt-eval-analysis';

test('the A/B statistics: median, percentile, exact and approximate Mann–Whitney', () => {
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([]), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  // Fully separated 3 v 3: 2 of the 20 splits are this extreme.
  const separated = mannWhitney([1, 2, 3], [4, 5, 6]);
  assert.equal(separated.exact, true); assert.ok(Math.abs(separated.p - 0.1) < 1e-9);
  const same = mannWhitney([1, 2, 3, 4], [1, 2, 3, 4]);
  assert.equal(same.p, 1);
  const large = mannWhitney(Array.from({ length: 15 }, (_, i) => i), Array.from({ length: 15 }, (_, i) => i + 100));
  assert.equal(large.exact, false); assert.ok(large.p < 0.001);
  assert.ok(Number.isNaN(mannWhitney([], [1]).p));
});

function record(tail: string, over: Partial<TurnRecord> = {}): TurnRecord {
  const nonce = 'a'.repeat(32);
  const text = `好的。\n<sh-state-${nonce}>${tail}</sh-state-${nonce}>`;
  return { label: 'x-with', model: '', repeat: 1, scenario: 'multi', title: '', turn: 2, user: '今天好累', process: 'warm', sessionTurn: 2, initModel: null, nonce,
    settingOffered: false, dispatchMs: 1, endMs: 100, chunks: [[500, text.slice(0, 20)], [900, text.slice(20)]], liveVisible: '好的。', prompt: null, usage: null, error: null, ...over };
}

test('the report reads the tail field the way the app does: what the model wrote, and what the app accepted', () => {
  const ok = readUserField(record('{"context":"support","delta":{},"confidence":0.9,"user":{"state":"tired","confidence":0.9,"reason":"加班"}}'));
  assert.deepEqual(ok.rawField, { present: true, raw: { state: 'tired', confidence: 0.9, reason: '加班' } });
  assert.equal(ok.accepted?.state, 'tired');
  const unconfident = readUserField(record('{"context":"support","delta":{},"confidence":0.9,"user":{"state":"tired","confidence":0.5}}'));
  assert.equal(unconfident.rawField.present, true); assert.equal(unconfident.accepted, null); assert.ok(unconfident.appraisal);
  const absent = readUserField(record('{"context":"support","delta":{},"confidence":0.9}'));
  assert.equal(absent.rawField.present, false); assert.equal(absent.accepted, null);
});

test('the report flags a reply that reads the judgment out like an instrument, not a natural "我感觉你很累"', () => {
  const tail = '{"context":"support","delta":{},"confidence":0.9,"user":{"state":"low","confidence":0.9}}';
  const text = report([
    record(tail, { liveVisible: '我检测到你情绪低落，需要聊聊吗？' }),
    record(tail, { liveVisible: '我感觉你今天很累，先歇一会儿吧。', turn: 3 }),
  ]);
  assert.match(text, /回复里像在播报判断的 1 轮/);
  assert.match(text, /疑似播报的回复全文/);
  const flagged = text.split('疑似播报的回复全文')[1];
  assert.ok(flagged.includes('我检测到你情绪低落') && !flagged.includes('我感觉你今天很累'));
});
