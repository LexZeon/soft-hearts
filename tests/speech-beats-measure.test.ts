// 边说边演第 5 步的量法（scripts/dev/speech-beats-measure.ts，docs/claude/2026-11-20-speech-beats-measure.md）：
// 纯的统计、请求数硬上限（tee）、整条链用假 Claude 跑一遍（20 条请求，开着 14、关着 6，漏出 0）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fakeClaudeBeats } from './helpers/fake-claude-beats';
import { MEASURE_PLAN, analyseReply, ledgerRequests, looksLikeQuota, parseLedger, plannedRequests, quantiles, summarise, type MeasureRow } from '../scripts/lib/speech-beats-measure';
import { TEE_PATH, runMeasure } from '../scripts/lib/speech-beats-measure-run';

test('the plan is 20 requests: 14 with the switch on, 6 off, and the six off lines are six of the on lines', () => {
  assert.equal(plannedRequests(), 20);
  const on = MEASURE_PLAN.filter(c => c.on).flatMap(c => c.lines), off = MEASURE_PLAN.filter(c => !c.on).flatMap(c => c.lines);
  assert.equal(on.length, 14); assert.equal(off.length, 6);
  for (const line of off) assert.ok(on.some(other => other.id === line.id && other.text === line.text), line.id);
  const kinds = new Set(on.map(line => line.kind));
  for (const kind of ['small', 'compliment', 'tease', 'sad', 'direct', 'steps']) assert.ok(kinds.has(kind as never), kind);
});

test('analyseReply: leaks, bad markers, performance only and big moves on the raw text and what was shown', () => {
  const clean = analyseReply('<sh-open>⟦shy⟧⟦hand-cheek⟧', '');
  assert.equal(clean.performanceOnly, true); assert.equal(clean.leaked, false); assert.equal(clean.markersParse, true); assert.deepEqual(clean.bigMoves, ['hand-cheek']);
  const spoken = analyseReply('⟦smile-warm⟧好呀。⟦frown⟧⟦sm', '好呀。');
  assert.equal(spoken.performanceOnly, false); assert.equal(spoken.dropped, 2); assert.equal(spoken.markersParse, false); assert.equal(spoken.rawMarkers, 3);
  assert.equal(analyseReply('好呀', '好呀 ⟦tilt⟧').leaked, true);
  assert.equal(analyseReply('好呀', '好呀 [shy]').leaked, true);
  assert.equal(analyseReply('好呀', '好呀 【laugh】').leaked, true);
  assert.equal(analyseReply('好呀', '我在听 [ok] 呢').leaked, false);
  assert.equal(analyseReply('⟦v⟧好', '好').markersParse, true);
  assert.equal(analyseReply('好', '好').rawMarkers, 0);
});

test('quantiles and the summary count what the task asks for', () => {
  assert.deepEqual(quantiles([]).median, null);
  assert.equal(quantiles([10, 20, 30, 40]).median, 25);
  const facts = (over: Partial<ReturnType<typeof analyseReply>> = {}) => ({ ...analyseReply('⟦tilt⟧好', '好'), ...over });
  const row = (over: Partial<MeasureRow>): MeasureRow => ({ conversation: 'c', on: true, turn: 2, lineId: 'x', kind: 'small', first: false, ok: true, firstVisibleMs: 100, firstRawMs: 90, facts: facts(), moodTail: true,
    outputTokens: 100, inputTokens: 10, cacheRead: 1000, cacheCreation: 0, model: 'm', ...over });
  const summary = summarise([
    row({}),
    row({ kind: 'direct', facts: facts({ performanceOnly: true }) }),
    row({ kind: 'sad', facts: facts({ bigMoves: ['v'] }) }),
    row({ lineId: 'x', on: false, facts: analyseReply('好', '好'), outputTokens: 80, firstVisibleMs: 50 }),
    row({ ok: false, facts: null }),
  ]);
  assert.equal(summary.requests, 5); assert.equal(summary.failed, 1); assert.equal(summary.on, 3); assert.equal(summary.off, 1);
  assert.equal(summary.performanceOnly, 1); assert.equal(summary.performanceOnlyOnDirect, 1);
  assert.deepEqual(summary.bigMovesOnSad, { replies: 1, withBig: 1, moves: ['v'] });
  assert.equal(summary.outputTokens.matchedMeanDiff, 20);
  assert.equal(summary.firstVisibleMs.off.median, 50);
  assert.deepEqual(summary.markersParse, { hit: 3, of: 3 });
  assert.equal(summary.wordsUsed.tilt, 3);
});

test('the quota check and the ledger reader', () => {
  assert.equal(looksLikeQuota('HTTP 429 too many requests'), true);
  assert.equal(looksLikeQuota('Claude usage limit reached'), true);
  assert.equal(looksLikeQuota('套餐额度已用完'), true);
  assert.equal(looksLikeQuota('network down'), false);
  const rows = parseLedger('{"kind":"request","pid":1,"at":1}\nbroken\n{"kind":"result","pid":1,"at":2}\n');
  assert.equal(rows.length, 2); assert.equal(ledgerRequests(rows), 1);
});

/** The tee in front of the fake claude: sends `messages` user messages, returns its exit code, the ledger and how many replies came back. */
async function runTee(cap: number, messages: number) {
  const fake = await fakeClaudeBeats();
  const ledger = path.join(fake.root, 'ledger.jsonl');
  try {
    const child = spawn(process.execPath, [TEE_PATH, '--ledger', ledger, '--cap', String(cap), '--', process.execPath, fake.script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    let gone = false;
    const exited = new Promise<number | null>(resolve => child.on('exit', code => { gone = true; resolve(code); }));
    child.stdin.on('error', () => { /* the tee may already have ended (the refused message) */ });
    const replies = () => out.split('\n').filter(line => line.includes('"type":"result"')).length;
    // 2026-11-21: wait for each reply (or the end) instead of a fixed 400 ms, so a busy machine cannot make a reply look missing.
    const until = async (done: () => boolean, ms: number) => { const end = Date.now() + ms; while (!done() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20)); };
    for (let i = 0; i < messages; i++) {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `hi ${i}` }] } }) + '\n');
      await until(() => gone || replies() > i, 10_000);
    }
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000))]);
    if (code === null) child.kill();
    return { code, ledger: parseLedger(existsSync(ledger) ? readFileSync(ledger, 'utf8') : ''), replies: out.split('\n').filter(line => line.includes('"type":"result"')).length, err, inputs: (await fake.inputs()).length };
  } finally { await fake.cleanup(); }
}

test('the tee never forwards a request past the cap: the third message is refused and the process ends', async () => {
  const result = await runTee(2, 3);
  assert.equal(ledgerRequests(result.ledger), 2);
  assert.equal(result.ledger.filter(row => row.kind === 'refused').length, 1);
  assert.equal(result.code, 3);
  assert.equal(result.inputs, 2, 'the fake claude saw only two messages');
  assert.equal(result.replies, 2);
  assert.match(result.err, /cap 2/);
});

test('the tee records usage numbers of each result and lets requests under the cap through', async () => {
  const result = await runTee(5, 2);
  assert.equal(result.code, 0);
  assert.equal(ledgerRequests(result.ledger), 2);
  const results = result.ledger.filter(row => row.kind === 'result');
  assert.equal(results.length, 2);
  assert.ok(results.every(row => typeof row.outputTokens === 'number' && row.model === 'fake-model'));
  assert.ok(!JSON.stringify(result.ledger).includes('hi 0'), 'the ledger holds no conversation text');
});

test('the whole chain with the fake Claude: 20 requests, 14 on and 6 off, no marker in any shown text, the mood tail still parses', async () => {
  const fake = await fakeClaudeBeats();
  const ledger = path.join(fake.root, 'ledger.jsonl');
  try {
    const result = await runMeasure({ command: process.execPath, commandArgs: [fake.script], ledger, cap: 20, gapMs: 0, plan: MEASURE_PLAN, real: false });
    assert.equal(result.requestsMade, 20);
    assert.equal(result.stoppedBy, null);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.on, 14); assert.equal(result.summary.off, 6);
    assert.equal(result.summary.leaks, 0);
    assert.equal(result.summary.moodTail.on.hit, 14); assert.equal(result.summary.moodTail.off.hit, 6);
    assert.equal(result.summary.performanceOnlyOnDirect, 0);
    assert.ok(result.summary.performanceOnly >= 1, 'the fake teases with a silent reply');
    assert.equal(result.summary.bigMovesOnSad.withBig, 0);
    assert.ok(result.summary.droppedMarkers > 0, 'the fake writes bad markers; they are counted, never shown');
    const inputs = await fake.inputs();
    assert.equal(inputs.length, 20);
    assert.equal(inputs.filter(input => input.beats).length, 14, 'the markers sentence is in the prompt of the on conversations only');
    // Her earlier replies come back as the app keeps them (markers in the on conversations, clean in the off ones), so the history still lines
    // up with what the process was told and each conversation stays on one Claude process (a mismatch would open a new one every turn).
    let at = 0;
    for (const conversation of MEASURE_PLAN) {
      const pids = new Set(inputs.slice(at, at + conversation.lines.length).map(input => input.pid));
      assert.equal(pids.size, 1, `${conversation.name} stayed on one process`);
      at += conversation.lines.length;
    }
    // A second run on the same ledger is refused before anything is sent: the cap is across runs.
    await assert.rejects(runMeasure({ command: process.execPath, commandArgs: [fake.script], ledger, cap: 20, gapMs: 0, plan: MEASURE_PLAN, real: false }), /refusing to start/);
    assert.equal((await fake.inputs()).length, 20);
  } finally { await fake.cleanup(); }
});
