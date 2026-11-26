// Unbound step 6 probe, the pure parts (scripts/unbound/step6-probe-lib.mjs). The app run itself is scripts/unbound/step6-probe.mjs (not run here).
import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateSnapshot, diffSnapshots, flattenReading, longFrameCauses, probeStep, renderProbeMarkdown, summarizeFrames, summarizeKinds, topScripts } from '../scripts/unbound/step6-probe-lib.mjs';

const reading = (mainPrivate, heap, extra = {}) => ({ main: { heapUsedMB: heap, rssMB: 200, resources: { PipeWrap: 4, Timeout: 10 }, windows: 3 },
  metrics: [{ role: 'main', privateMB: mainPrivate }, { role: 'gpu', privateMB: 300 }, { role: 'companion', privateMB: 400 }], pages: { companion: { heapMB: 50, nodes: 900, listeners: 120 } }, handles: 1500, ...extra });

test('a reading flattens to dotted keys; renderer rows of one role add up', () => {
  const flat = flattenReading(reading(100, 20, { metrics: [{ role: 'main', privateMB: 100 }, { role: 'companion', privateMB: 300 }, { role: 'companion', privateMB: 50 }] }));
  assert.equal(flat['main.private'], 100);
  assert.equal(flat['companion.private'], 350);
  assert.equal(flat['main.heap'], 20);
  assert.equal(flat['main.res.PipeWrap'], 4);
  assert.equal(flat['companion.nodes'], 900);
  assert.equal(flat['main.handles'], 1500);
  assert.deepEqual(flattenReading(null), {});
});

test('a step keeps the change of every reading both sides have', () => {
  const row = probeStep({ kind: 'chat', round: 2, before: reading(100, 20), after: reading(104.5, 20.25, { handles: 1510 }), frames: { intervals: [16, 17, 300], loaf: [] }, loop: { maxMs: 42.26 } });
  assert.equal(row.delta['main.private'], 4.5);
  assert.equal(row.delta['main.heap'], 0.25);
  assert.equal(row.delta['main.handles'], 10);
  assert.equal(row.frames.over250, 1);
  assert.equal(row.loopMaxMs, 42.3);
});

test('frames: gaps over the lines, quantiles, and long frames with their biggest scripts', () => {
  const intervals = [...Array(98).fill(16.7), 120, 400];
  const loaf = [{ duration: 380, blocking: 330, page: 'companion', scripts: [{ duration: 20, invoker: 'a' }, { duration: 300, invoker: 'FrameRequestCallback', sourceFunctionName: 'tick', sourceURL: 'file:///x/dist/assets/index.js', sourceCharPosition: 77 }] }, { duration: 60, scripts: [] }];
  const summary = summarizeFrames({ intervals, loaf, hidden: 1 });
  assert.equal(summary.count, 100);
  assert.equal(summary.over100, 2);
  assert.equal(summary.over250, 1);
  assert.equal(summary.max, 400);
  assert.equal(summary.longFrames.length, 1, 'frames under 100 ms are not long frames');
  assert.equal(summary.longFrames[0].top[0].ms, 300);
  assert.match(summary.longFrames[0].top[0].what, /FrameRequestCallback \| tick @ assets\/index\.js:77/);
  assert.deepEqual(topScripts(undefined), []);
});

test('per kind: a reading that grows every round shows a positive median and slope; the first round is left out', () => {
  const steps = [];
  let main = 100;
  for (let round = 1; round <= 6; round++) {
    const before = main; main += round === 1 ? 40 : 3; // the first round loads code once (+40), then +3 every round
    steps.push(probeStep({ kind: 'chat', round, before: reading(before, 20), after: reading(main, 20), frames: { intervals: [16, 17], loaf: [] } }));
    steps.push(probeStep({ kind: 'pat', round, before: reading(main, 20), after: reading(main, 20), frames: { intervals: [16, 300], loaf: [] } }));
  }
  const [chat, pat] = summarizeKinds(steps);
  assert.equal(chat.kind, 'chat');
  assert.equal(chat.steps, 5);
  assert.equal(chat.rows['main.private'].median, 3);
  assert.equal(chat.rows['main.private'].perRound, 3);
  assert.equal(chat.firstRound.delta['main.private'], 40);
  assert.equal(pat.rows['main.private'].median, 0);
  assert.equal(pat.over250, 5);
  assert.equal(pat.stepsWithOver250, 5);
});

test('long frames are grouped by page and their biggest script, most frequent first', () => {
  const frame = what => ({ duration: 200, page: 'companion', top: what ? [{ ms: 150, what }] : [] });
  const steps = [{ kind: 'hide', frames: { longFrames: [frame('x'), frame('x'), frame(null)] } }, { kind: 'chat', frames: { longFrames: [frame('x')] } }];
  const causes = longFrameCauses(steps);
  assert.equal(causes[0].cause, 'companion :: x');
  assert.equal(causes[0].count, 3);
  assert.deepEqual(causes[0].kinds.sort(), ['chat', 'hide']);
  assert.match(causes[1].cause, /no script/);
});

// A tiny heap snapshot in V8's format: node fields [type, name, id, self_size, edge_count], node types [hidden, object, closure, string].
const snapshot = nodes => ({ snapshot: { meta: { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'], node_types: [['hidden', 'object', 'closure', 'string']] } },
  nodes: nodes.flatMap(([type, name, size], i) => [type, name, i, size, 0]), strings: ['(root)', 'ClaudeChatProcess', 'onData', 'some text'] });

test('heap snapshots aggregate by type and name (strings by type only) and diff to what grew', () => {
  const before = aggregateSnapshot(snapshot([[0, 0, 0], [1, 1, 100], [2, 2, 32], [3, 3, 20]]));
  const after = aggregateSnapshot(snapshot([[0, 0, 0], [1, 1, 100], [1, 1, 100], [1, 1, 100], [2, 2, 32], [2, 2, 32], [3, 3, 20], [3, 3, 40]]));
  assert.deepEqual(before['object:ClaudeChatProcess'], { count: 1, bytes: 100 });
  assert.deepEqual(after['string:'], { count: 2, bytes: 60 });
  const diff = diffSnapshots(before, after);
  assert.equal(diff.grew[0].key, 'object:ClaudeChatProcess');
  assert.equal(diff.grew[0].count, 2);
  assert.equal(diff.totalBytes, 200 + 32 + 40);
});

test('the report names every kind and every cause', () => {
  const steps = [1, 2, 3].map(round => probeStep({ kind: 'ub-enter', round, before: reading(100, 20), after: reading(100 + round, 20), frames: { intervals: [16], loaf: [{ duration: 150, page: 'unbound', scripts: [{ duration: 120, invoker: 'X' }] }] } }));
  const text = renderProbeMarkdown({ label: 't', commit: 'abc', engine: 'unbound', rounds: 3, kinds: ['ub-enter'], startedAt: 'now', summary: summarizeKinds(steps), causes: longFrameCauses(steps), snapshots: {} });
  assert.match(text, /### ub-enter: 2 steps/);
  assert.match(text, /\| main\.private \| 2\.5 \|/);
  assert.match(text, /3x, worst 150 ms, during ub-enter: unbound :: X/);
});
