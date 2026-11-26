// The measurement of the call's semantic look against her first words (scripts/lib/call-look-first-char.ts, scripts/dev/call-look-first-char.ts;
// docs/claude/2026-11-20-call-look-first-char.md). Fakes only: nothing here asks a real Claude. The numbers are checked with known inputs, the
// three groups through the real voice host, and the script's caps (the plan must fit before anything is sent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GROUPS, MEASURE_LINES, medianDifference, runGroup, spread, summarise, type GroupDeps } from '../scripts/lib/call-look-first-char';

const FACTS = '屏幕上是一个表格软件。';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The order is stated, not timed: a look's frame resolves only after the segment it belongs to has been dispatched and its message written
// (the persona read below), so "the facts reach her next segment" is produced the same way under any load. (Before, a 10 ms judge plus an 8 ms
// look raced the dispatch of her reply, and on a loaded machine the look sometimes landed in the same segment.)
function deps(counts: { judge: number; look: number }, overrides: Partial<GroupDeps> = {}): GroupDeps {
  const lookSegments = MEASURE_LINES.map((line, index) => (line.look ? index : -1)).filter(index => index >= 0);
  const dispatched: Array<() => void> = [];
  const written = MEASURE_LINES.map((_line, index) => new Promise<void>(resolve => { dispatched[index] = resolve; }));
  let streams = 0, looks = 0;
  return {
    claude: { stream: async (task, _signal, emit) => {
      void task.session?.persona; // read where the message is written, as the real chat does (this is where a call's carried facts are claimed)
      dispatched[Math.min(streams++, dispatched.length - 1)]();
      await wait(3); emit('delta', '嗯嗯。'); return { superseded: false, output: '嗯嗯。' };
    } },
    ask: async (prompt, system) => {
      await wait(8);
      if (system.includes('感知判定员')) { counts.judge++; return JSON.stringify({ senses: MEASURE_LINES.some(line => line.look && prompt.includes(line.text)) ? ['screen'] : [] }); }
      await written[lookSegments[Math.min(looks++, lookSegments.length - 1)]]; // ready only once its own segment is already on its way
      counts.look++; return FACTS;
    },
    frame: n => `data:image/png;base64,AAAA${n}`, gapMs: 120, judgeDelayMs: 10, ...overrides,
  };
}

test('spread: median and quartiles of known numbers', () => {
  assert.deepEqual(spread([4, 1, 3, 2, 5]), { n: 5, median: 3, p25: 2, p75: 4, min: 1, max: 5 });
  assert.equal(spread([]), null);
});

test('medianDifference: a real shift is found, no shift is spanned by the interval', () => {
  const base = [800, 820, 790, 810, 805, 815, 795];
  const shifted = base.map(v => v + 200);
  const moved = medianDifference(base, shifted)!;
  assert.equal(moved.diff, 200);
  assert.ok(moved.low > 100 && moved.high < 300);
  const same = medianDifference(base, [...base].reverse())!;
  assert.equal(same.diff, 0);
  assert.ok(same.low <= 0 && same.high >= 0);
  assert.equal(medianDifference([], base), null);
});

test('the three groups through the real voice host: who asks haiku, and when the facts reach her words', async () => {
  const results = [];
  const counts = { off: { judge: 0, look: 0 }, carry: { judge: 0, look: 0 }, own: { judge: 0, look: 0 } };
  for (const group of GROUPS) results.push(await runGroup(group, deps(counts[group])));
  const [off, carry, own] = results;
  for (const result of results) assert.equal(result.rows.length, MEASURE_LINES.length, `${result.group}: every line was answered`);
  for (const result of results) for (const row of result.rows) { assert.notEqual(row.firstMs, null, `${result.group} ${row.segment}: her first character was timed`); assert.ok(row.reply.length > 0); }
  // off: the phrase rules only, no router: no haiku at all in the measured path
  assert.deepEqual(counts.off, { judge: 0, look: 0 }, 'semantic look off: no judgment, no look');
  assert.deepEqual(off.factsLanded, { 'segment 3': 'never', 'segment 6': 'never' });
  // carry: the reaction judge carries the question: the router asks no judgment of its own, only the two looks
  assert.deepEqual(counts.carry, { judge: 0, look: 2 }, 'carried: no own judgment call; one look per look line');
  assert.deepEqual(carry.factsLanded, { 'segment 3': 'next', 'segment 6': 'next' }, 'the facts reach her next segment, never a second reply');
  // own: the reaction judge is quiet (hidden): one own judgment per segment, plus the two looks; asked after her first character
  assert.deepEqual(counts.own, { judge: MEASURE_LINES.length, look: 2 }, 'hidden: an own judgment for every segment');
  assert.deepEqual(own.factsLanded, { 'segment 3': 'next', 'segment 6': 'next' });
  for (const ask of own.asks.filter(item => item.kind === 'judge')) {
    const row = own.rows[ask.segment];
    assert.ok(ask.startMs + 1 >= row.firstMs!, `own judgment ${ask.segment + 1} started after her first character (${ask.startMs} vs ${row.firstMs})`);
    assert.ok(ask.durationMs >= 7 && ask.durationMs < 500, 'the judgment is timed from its own start to its own end');
  }
  const summary = summarise(results);
  assert.equal(summary.firstMs.off!.n, MEASURE_LINES.length - 1, 'the warm-up segment is left out');
  assert.equal(summary.judgeMs!.n, MEASURE_LINES.length);
  assert.equal(summary.lookMs!.n, 4, "two looks each in carry and own");
  assert.ok(summary.differences['own - off'] !== null);
});

test('a halt between segments stops the conversation before the next request', async () => {
  let asked = 0, stop = false;
  const result = await runGroup('off', deps({ judge: 0, look: 0 }, { halted: () => stop, claude: { stream: async (_task, _signal, emit) => { asked++; if (asked === 2) stop = true; emit('delta', '嗯。'); return { superseded: false, output: '嗯。' }; } } }));
  assert.equal(asked, 2);
  assert.equal(result.rows.filter(row => row.reply).length, 2);
});

test('the script refuses a plan that does not fit its caps, and a fake run makes exactly the planned requests', async () => {
  const run = (...flags: string[]) => new Promise<{ code: number | null; out: string }>(resolve => {
    execFile(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/dev/call-look-first-char.ts', ...flags], { cwd: process.cwd(), timeout: 120_000, maxBuffer: 10_000_000 },
      (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: unknown }).code ?? 1) : 0, out: stdout + stderr }));
  });
  const small = await run('--fake', '--claude-cap', '20');
  assert.notEqual(small.code, 0); assert.match(small.out, /planned 21 Claude and 11 haiku/u);
  const few = await run('--fake', '--haiku-cap', '10');
  assert.notEqual(few.code, 0);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'call-look-test-'));
  try {
    const done = await run('--fake', '--out-dir', directory, '--gap-ms', '120');
    assert.equal(done.code, 0, done.out.slice(-600));
    const raw = JSON.parse(await readFile(path.join(directory, (await readdir(directory)).find(name => name.startsWith('raw-'))!), 'utf8'));
    assert.deepEqual(raw.requests, { claude: 21, claudeCap: 24, haiku: 11, haikuCap: 12 });
    assert.equal(raw.halted, null);
    // a second run in the same folder would not be allowed to use a fake ledger; fakes keep per-run ledgers, so only the first counts here
  } finally { await rm(directory, { recursive: true, force: true }); }
});
