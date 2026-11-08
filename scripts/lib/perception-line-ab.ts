// First-token A/B for the sentence at the end of her fixed settings text (docs/claude/2026-11-06-perception-line.md):
//   A = the sentence before 2026-11-06 ("…屏幕/摄像头/麦克风…请用户到控制窗口自己改。"),
//   B = the new one (CHAT_SETTINGS_UNLISTED_TEXT).
// Same card (Gene), same single-turn situations, interleaved in one time window, who goes first swapped every pair. Hard cap on real
// requests; any failed turn (429, quota, login) stops the run, nothing is retried. Every scenario runs in the runner's own temp data
// folder: nothing of the user's profile, chats or diary is read.
//   node node_modules/tsx/dist/cli.mjs scripts/lib/perception-line-ab.ts --mode ab --pairs 10 --out <dir> [--dry]
//   node node_modules/tsx/dist/cli.mjs scripts/lib/perception-line-ab.ts --mode behavior --variants B,A --out <dir> [--dry]
//     behavior: three requests about the senses and the key, each with B (and with A for comparison); records the visible reply.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runEval } from './prompt-eval-runner';
import type { TurnRecord } from './prompt-eval-analysis';
import type { EvalScenario } from './prompt-eval-scenarios';
import { FIDELITY_CARDS, FIDELITY_SCENARIOS, toEvalScenarios } from './fidelity-scenarios';
import { claudeSessionSystemPrompt } from '../../electron/claude-session-prompt';
import { CHAT_SETTINGS_UNLISTED_TEXT, CHAT_SETTINGS_UNLISTED_TEXT_BEFORE } from '../../electron/chat-settings';
import { findClaude } from '../../electron/claude';

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const dry = process.argv.includes('--dry');
const mode = option('mode', 'ab');
const out = path.resolve(option('out', '.local/perception-line-ab'));
const cap = Math.max(1, Math.min(30, Number(option('cap', '20')) || 20));

const systemB = claudeSessionSystemPrompt();
if (!systemB.includes(CHAT_SETTINGS_UNLISTED_TEXT)) throw new Error('the new sentence is not in the fixed prompt');
const systemA = systemB.replace(CHAT_SETTINGS_UNLISTED_TEXT, CHAT_SETTINGS_UNLISTED_TEXT_BEFORE);
if (systemA === systemB) throw new Error('A and B are the same');
const variants: Record<string, { label: string; systemPrompt: string }> = { A: { label: 'A', systemPrompt: systemA }, B: { label: 'B', systemPrompt: systemB } };

const BEHAVIOR: EvalScenario[] = [
  { id: 'camera-images', title: '帮我打开摄像头发图片', turns: [{ user: '帮我打开摄像头发图片，你看看我今天什么样。' }] },
  { id: 'screen-share', title: '帮我开屏幕共享', turns: [{ user: '帮我开屏幕共享吧，我想让你陪我看看这个文档。' }] },
  { id: 'api-key', title: '把密钥改一下', turns: [{ user: '把密钥改一下吧，我换了一个新的。' }] },
];

async function main(): Promise<void> {
  const card = FIDELITY_CARDS.find(item => item.id === 'gene')!;
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(process.cwd(), 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  let used = 0;
  const records: TurnRecord[] = [];
  let stopped: string | null = null;
  const run = async (variant: { label: string; systemPrompt: string }, scenario: EvalScenario) => {
    await runEval({
      label: variant.label, model: '', repeat: 1, scenarios: [scenario], binary, ...(binaryArgs ? { binaryArgs } : {}),
      prewarmMs: dry ? 100 : 3000, card: { persona: card.persona, mood: card.mood }, systemPrompt: variant.systemPrompt,
      beforeTurn: () => { if (++used > cap) throw new Error(`real request cap ${cap} reached`); },
      onTurn: record => { records.push(record); console.log(`${variant.label} ${scenario.id} 首字 ${record.chunks[0]?.[0] ?? '–'} ms${record.error ? ` 错误：${record.error}` : ''}`); },
    });
  };
  await mkdir(out, { recursive: true });
  if (mode === 'behavior') {
    const labels = option('variants', 'B').split(',').map(value => value.trim()).filter(value => value in variants);
    try { for (const scenario of BEHAVIOR) for (const label of labels) await run(variants[label], scenario); }
    catch (error) { stopped = error instanceof Error ? error.message : String(error); }
    await writeFile(path.join(out, 'behavior.json'), JSON.stringify({ dry, requests: used, stopped, replies: records.map(r => ({ label: r.label, scenario: r.scenario, user: r.user,
      reply: r.liveVisible, settingOffered: r.settingOffered, error: r.error })) }, null, 2), 'utf8');
    for (const r of records) console.log(`\n[${r.label}] ${r.scenario}（提议格式${r.settingOffered ? '有' : '没有'}）\n${r.liveVisible}`);
    return;
  }
  const pairs = Math.max(1, Math.min(15, Number(option('pairs', '10')) || 10));
  const scenarios = FIDELITY_SCENARIOS.filter(scenario => scenario.turns.length === 1 && !scenario.onlyCards && !scenario.away).slice(0, pairs);
  if (scenarios.length < pairs) throw new Error(`only ${scenarios.length} single-turn situations`);
  try {
    for (const [round, scenario] of scenarios.entries()) {
      for (const variant of round % 2 === 0 ? [variants.A, variants.B] : [variants.B, variants.A]) await run(variant, toEvalScenarios([scenario])[0]);
    }
  } catch (error) { stopped = error instanceof Error ? error.message : String(error); }
  const first = (label: string) => records.filter(record => record.label === label && !record.error && record.chunks.length).map(record => record.chunks[0][0]);
  const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pairsDone = scenarios.map(scenario => ({ id: scenario.id, a: records.find(r => r.scenario === scenario.id && r.label === 'A' && !r.error)?.chunks[0]?.[0] ?? null,
    b: records.find(r => r.scenario === scenario.id && r.label === 'B' && !r.error)?.chunks[0]?.[0] ?? null })).filter(pair => pair.a !== null && pair.b !== null) as { id: string; a: number; b: number }[];
  const diffs = pairsDone.map(pair => pair.b - pair.a);
  const slower = diffs.filter(d => d > 0).length;
  const result = { dry, requests: used, pairs: pairsDone.length, medianA: median(first('A')), medianB: median(first('B')), medianPairDiff: median(diffs),
    meanPairDiff: diffs.length ? Math.round(diffs.reduce((s, d) => s + d, 0) / diffs.length) : null, slowerPairs: slower, stopped, pairsDone };
  const verdict = result.medianPairDiff === null ? '没有完成的配对'
    : result.medianPairDiff >= 300 && slower > diffs.length / 2 ? 'B 明显变慢（中位慢 300 ms 以上且多数对变慢）：不改' : 'B 没有明显变慢：可以改';
  await writeFile(path.join(out, 'first-token-ab.json'), JSON.stringify({ ...result, verdict }, null, 2), 'utf8');
  console.log(JSON.stringify({ ...result, verdict }, null, 2));
}
main().catch(error => { console.error(error); process.exit(1); });
