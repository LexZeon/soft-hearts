// How much the call's semantic look slows her first words (docs/claude/2026-11-20-call-look-first-char.md; library scripts/lib/call-look-first-char.ts).
// Three conversations (semantic look off / on with the reaction judge carrying it / on with its own haiku call) through the real voice host; her
// Claude is the app's own PersistentClaudeChat with the app's flags; the router's haiku is the app's own tool-less haiku call (senseAskWithClaude).
// Synthetic persona, synthetic lines, synthetic screen frames; no microphone, camera, screen or app profile.
//
//   node node_modules/tsx/dist/cli.mjs scripts/dev/call-look-first-char.ts --fake     fakes for both: local cost only
//   node node_modules/tsx/dist/cli.mjs scripts/dev/call-look-first-char.ts --real     the user's Claude Code: uses their quota (the user asked for this measurement)
//     --claude-cap N (default 24)   hard cap on her reply requests: the tee in front of her process refuses the N+1st (scripts/lib/speech-beats-measure-tee.mjs)
//     --haiku-cap N (default 12)    hard cap on haiku requests: counted in this script before each is started
//     --gap-ms N (default 3000)  --judge-delay-ms N (default 1200, the fake reaction judge)  --model NAME (her model; default: Claude Code's own)
//     --out-dir DIR (real: --out-dir, else $SOFT_HEARTS_PRIVATE_DIR, else .local/private-dir.txt (one absolute folder), else ~/.soft-hearts-raw; then /call-look-first-char: raw timings and replies live only there)
// Prints numbers. A 429 or quota error stops the run, no retry.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { findClaude } from '../../electron/brain/claude';
import { streamClaude } from '../../electron/brain';
import { PersistentClaudeChat } from '../../electron/brain/claude-session';
import { senseAskWithClaude } from '../../electron/senses/sense-router/model';
import { fakeClaudeStream } from '../../tests/helpers/fake-claude-stream';
import { ledgerRequests, looksLikeQuota, parseLedger } from './../lib/speech-beats-measure';
import { describePrivateDir, resolveRawFolder } from '../lib/private-dir';
import { TEE_PATH } from '../lib/speech-beats-measure-run';
import { GROUPS, MEASURE_LINES, runGroup, summarise, type GroupResult } from '../lib/call-look-first-char';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const real = args.includes('--real');
if (!real && !args.includes('--fake')) { console.error('say --fake or --real (--real uses the Claude quota)'); process.exit(2); }
const claudeCap = Number(option('--claude-cap', '24')), haikuCap = Number(option('--haiku-cap', '12'));
const gapMs = Number(option('--gap-ms', real ? '3000' : '250')), judgeDelayMs = Number(option('--judge-delay-ms', real ? '1200' : '30')), model = option('--model', '');
const rawChoice = resolveRawFolder('call-look-first-char', { flag: option('--out-dir', ''), root: path.resolve(import.meta.dirname, '../..') });
const outDir = real ? rawChoice.dir : option('--out-dir', path.join(os.tmpdir(), 'call-look-first-char-fake'));
console.log(real ? describePrivateDir(rawChoice) : `fake run: files go to ${outDir}`); // before anything is written

// The plan must fit the caps before anything is sent: her replies, and the haiku calls it can make (own judgment per segment, plus one look per
// look-line in the 'carry' and 'own' groups).
const looks = MEASURE_LINES.filter(line => line.look).length;
const plannedClaude = MEASURE_LINES.length * GROUPS.length, plannedHaiku = MEASURE_LINES.length + looks * 2;
if (plannedClaude > claudeCap || plannedHaiku > haikuCap) { console.error(`planned ${plannedClaude} Claude and ${plannedHaiku} haiku requests; caps are ${claudeCap} and ${haikuCap}`); process.exit(2); }

/** A 320x240 PNG gradient (different per seed); the same synthetic frame kind as scripts/dev/call-glance-first-char.ts. */
function framePng(seed: number): string {
  const width = 320, height = 240, raw = Buffer.alloc((width * 3 + 1) * height);
  let noise = seed * 2654435761 >>> 0;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      noise = (noise * 1664525 + 1013904223) >>> 0;
      const band = Math.abs(((x + seed * 37) % 160) - 80) < 12 ? 90 : 0;
      raw[row + 1 + x * 3] = (x * 255 / width + band) & 255; raw[row + 2 + x * 3] = (y * 255 / height + (noise & 15)) & 255; raw[row + 3 + x * 3] = (seed * 41 + band) & 255;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

mkdirSync(outDir, { recursive: true });
// The ledgers are cumulative across runs in the same folder (a real run: the caps are totals, not per run).
const ledger = path.join(outDir, real ? 'ledger.jsonl' : `ledger-${Date.now()}.jsonl`), haikuLedger = path.join(outDir, real ? 'haiku-ledger.jsonl' : `haiku-ledger-${Date.now()}.jsonl`);
const countLines = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
const fake = real ? null : await fakeClaudeStream();
let halted: string | null = null, haikuRequests = countLines(haikuLedger);
if (ledgerRequests(parseLedger(existsSync(ledger) ? readFileSync(ledger, 'utf8') : '')) + plannedClaude > claudeCap || haikuRequests + plannedHaiku > haikuCap) { console.error('the ledgers already hold requests: this run would go over a cap'); process.exit(2); }
const haikuLog: { at: number; ok: boolean; quota: boolean }[] = [];

/** The counted haiku stream: the request is counted before it is made; over the cap it is not made at all. */
const countedStream: Parameters<typeof senseAskWithClaude>[4] = async (task, signal, emit) => {
  if (halted) throw new Error('stopped: ' + halted);
  if (haikuRequests >= haikuCap) throw new Error('haiku request cap reached');
  haikuRequests++;
  appendFileSync(haikuLedger, JSON.stringify({ at: Date.now() }) + '\n');
  const entry = { at: Date.now(), ok: false, quota: false };
  haikuLog.push(entry);
  try {
    if (!real) { // fake haiku: about a real one's time; names the screen for the look lines
      await new Promise(resolve => setTimeout(resolve, 60));
      const judging = (task.systemPrompt ?? '').includes('感知判定员');
      emit('delta', judging ? JSON.stringify({ senses: MEASURE_LINES.some(line => line.look && task.prompt.includes(line.text)) ? ['screen'] : [] }) : '屏幕上是一个表格软件。');
      entry.ok = true; return null;
    }
    const usage = await streamClaude(task, signal, emit); entry.ok = true; return usage;
  } catch (caught) { if (looksLikeQuota(String((caught as Error)?.message ?? caught))) { entry.quota = true; halted = 'quota or rate limit (haiku)'; } throw caught; }
};

try {
  const command = real ? await findClaude() : process.execPath;
  const results: GroupResult[] = [];
  for (const group of GROUPS) {
    if (halted) break;
    const binaryArgs = [TEE_PATH, '--ledger', ledger, '--cap', String(claudeCap), '--', command, ...(fake ? [fake.script] : [])];
    const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs, provider: () => ({ kind: 'claude', model }), chattedBefore: () => true, log: () => {},
      callMaxTurns: 50, callGlances: { stays: true, cap: 40 } });
    try {
      chat.holdWarm(true);
      await new Promise(resolve => setTimeout(resolve, real ? 4000 : 300)); // the call's spare process starts
      results.push(await runGroup(group, {
        claude: { stream: async (task, signal, emit, control) => {
          const outcome = await chat.stream(task, signal, emit, control);
          if (looksLikeQuota(outcome.output.slice(0, 400)) && real) halted = 'quota or rate limit (her reply)';
          return outcome;
        } },
        ask: (prompt, system, images, signal) => senseAskWithClaude(prompt, system, images, signal, countedStream),
        frame: framePng, gapMs, judgeDelayMs, model, halted: () => halted !== null, log: line => console.log(line),
      }));
    } finally { chat.dispose(); }
  }
  const claudeRequests = existsSync(ledger) ? ledgerRequests(parseLedger(readFileSync(ledger, 'utf8'))) : 0;
  const summary = summarise(results);
  const report = { mode: real ? 'real' : 'fake', model: model || 'default', gapMs, judgeDelayMs, requests: { claude: claudeRequests, claudeCap, haiku: haikuRequests, haikuCap }, halted, summary,
    factsLanded: Object.fromEntries(results.map(r => [r.group, r.factsLanded])) };
  console.log(JSON.stringify(report, null, 1));
  writeFileSync(path.join(outDir, `raw-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`), JSON.stringify({ ...report, results, haikuLog }, null, 1));
  appendFileSync(path.join(outDir, 'runs.log'), JSON.stringify({ at: new Date().toISOString(), mode: report.mode, requests: report.requests, halted }) + '\n');
} finally { await fake?.cleanup(); }
