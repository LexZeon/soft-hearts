// 边说边演第 5 步：用大约 20 次真实回复量一量效果（docs/claude/2026-11-20-speech-beats-measure.md；方案 docs/claude/2026-11-19-per-reply-choreo-plan.md）。
// 应用自己的 PersistentClaudeChat 和系统提示词、真实的回复说明（含边说边演那一句、心情尾注）、合成的人设和台词；不读任何真实配置、聊天或模型。
//
//   node node_modules/tsx/dist/cli.mjs scripts/dev/speech-beats-measure.ts --fake          假的 Claude（tests/helpers/fake-claude-beats.ts）：只花本机算力
//   node node_modules/tsx/dist/cli.mjs scripts/dev/speech-beats-measure.ts --real          用户自己的 Claude Code：用他的 Claude 用量，只在他同意的次数内
//     --cap N (默认 20)   请求数硬上限，整个账本里数（真实跑时跨多次运行）；第 N+1 条请求永远发不出去（tee 在 stdin 一侧挡住）
//     --gap-ms N (默认 2500)  两句话之间停多久     --model NAME (默认 Claude Code 自己的)
//     --ledger FILE   --raw-dir DIR (真实跑按 --raw-dir、$SOFT_HEARTS_PRIVATE_DIR、.local/private-dir.txt（一行绝对路径）、~/.soft-hearts-raw 的顺序找，再加 /speech-beats-measure，开跑前会打印，原文只存在那里)   --out FILE (数字存成 JSON)
// 只打印数字和每条回复的一行摘要；原文不打印。遇到 429 或额度错误就停，不重试。
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaude } from '../../electron/brain/claude';
import { fakeClaudeBeats } from '../../tests/helpers/fake-claude-beats';
import { describePrivateDir, resolveRawFolder } from '../lib/private-dir';
import { MEASURE_PLAN, plannedRequests } from '../lib/speech-beats-measure';
import { runMeasure } from '../lib/speech-beats-measure-run';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const real = args.includes('--real');
if (!real && !args.includes('--fake')) { console.error('say --fake or --real (--real uses the Claude quota)'); process.exit(2); }
const cap = Number(option('--cap', '20')), gapMs = Number(option('--gap-ms', real ? '2500' : '50')), model = option('--model', '');
if (!Number.isInteger(cap) || cap < 1 || plannedRequests() > cap) { console.error(`the plan has ${plannedRequests()} requests; --cap ${option('--cap', '20')} is too small`); process.exit(2); }
const rawChoice = resolveRawFolder('speech-beats-measure', { flag: option('--raw-dir', ''), root: path.resolve(import.meta.dirname, '../..') });
const privateDir = rawChoice.dir;
if (real) console.log(describePrivateDir(rawChoice)); // before anything is written
const fake = real ? null : await fakeClaudeBeats();
try {
  const rawDir = real ? privateDir : option('--raw-dir', '');
  const ledger = option('--ledger', real ? path.join(privateDir, 'ledger.jsonl') : path.join(fake!.root, 'ledger.jsonl'));
  mkdirSync(path.dirname(ledger), { recursive: true });
  const command = real ? await findClaude() : process.execPath;
  const result = await runMeasure({ command, ...(fake ? { commandArgs: [fake.script] } : {}), ledger, cap, model, gapMs, plan: MEASURE_PLAN, ...(rawDir ? { rawDir } : {}), real, log: line => console.log(line) });
  console.log(JSON.stringify({ mode: real ? 'real' : 'fake', model: model || 'default', requestsMade: result.requestsMade, cap, stoppedBy: result.stoppedBy, rawFile: result.rawFile, summary: result.summary }, null, 1));
  const out = option('--out', '');
  if (out) writeFileSync(out, JSON.stringify({ mode: real ? 'real' : 'fake', requestsMade: result.requestsMade, cap, stoppedBy: result.stoppedBy, rows: result.rows, summary: result.summary }, null, 1));
} finally { await fake?.cleanup(); }
