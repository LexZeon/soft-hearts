// I-112 + I-115 blind test, round 2, command line (details in scripts/lib/i112-i115-blind.ts and docs/claude/2026-11-14-i112-i115-prompts.md).
//   --print-scenarios            print the 15 situations' ids and user lines (no calls, no --out needed)
//   --fake                       offline fake Claude and fake judge, no quota (the only mode the build session ran)
//   --card-file <path>           the character card (a private read-only copy); with --fake the built-in Gene card is used when it is left out
//   --out <folder>               every output goes here (required; never inside OneDrive or the repository)
//   --model <alias>              Claude Code model alias for the replies of a real run (default opus)
//   --samples <n>                replies per situation and version (default 2)
//   --max-requests <n>           ceiling for the replies (default 120 = 15 situations x 4 versions x 2 samples); more planned than this: nothing starts
//   --judge <model>              after the replies, a blind Claude judge picks the most her-like reply on every page (e.g. sonnet); writes judge-picks.json
//   --judge-only                 skip the replies: judge the pages already in --out (sheet-items.json)
//   --max-judge <n>              ceiling for the judge calls (default 30 = one per page); more planned: nothing starts
//   --extra-replies <file.json>  a fifth version, "外部": another conversation's answers as text, {"label":"external","replies":{"<id>":["…","…"?]}}; no calls
//   --seed <n>                   shuffle seed (default: random, written into key.json)
//   --resume                     a stopped run in --out: keep its good replies and seed, ask only the missing ones (empty or under 10 characters count as missing)
//   --tally <picks.json>         no calls: the user's picks (and judge-picks.json in --out, when present) per rater, version and kind
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { findClaude } from '../electron/brain/claude';
import { assertPrivateRoot } from './lib/private-root.mjs';
import { loadCardFile, parseCardFileSpec } from './lib/fidelity-card-files';
import { FIDELITY_CARDS } from './lib/fidelity-scenarios';
import { CallBudget } from './lib/fidelity-run';
import {
  BLIND_VERSIONS, externalReplies, formatReport, keepOnResume, parseExtraReplies, readPicks, replyKey, runBlind, tallyPicks, versionStats, writeBlindOutputs,
  type BlindKey, type BlindReply, type SheetItem,
} from './lib/i112-i115-blind';
import { runJudge, writeJudgeFile, type JudgeFile } from './lib/i112-i115-judge';
import { i115Scenarios } from './lib/i115-scenarios';

const root = path.resolve(import.meta.dirname, '..');
const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const exists = (file: string) => readFile(file).then(() => true, () => false);

async function main(): Promise<void> {
  const scenarios = i115Scenarios();
  if (flag('print-scenarios')) { for (const scenario of scenarios) console.log(`${scenario.id}\t${scenario.turns[0] ?? ''}`); return; }
  const outOption = option('out');
  if (!outOption) throw new Error('需要 --out <文件夹>：回复、选择表和答案钥匙只写在这里。');
  const out = await assertPrivateRoot(outOption);
  if (option('tally')) {
    const key = await readJson<BlindKey>(path.join(out, 'key.json'));
    const replies = (await readJson<{ replies: BlindReply[] }>(path.join(out, 'replies-by-version.json'))).replies;
    const raters: Record<string, ReturnType<typeof tallyPicks>> = { 用户: tallyPicks(await readPicks(path.resolve(option('tally'))), key) };
    const judgeFile = path.join(out, 'judge-picks.json');
    if (await exists(judgeFile)) raters['评审（Claude）'] = tallyPicks((await readJson<JudgeFile>(judgeFile)).picks, key);
    for (const line of formatReport(raters, versionStats(replies))) console.log(line);
    return;
  }
  const fake = flag('fake');
  const samples = Number(option('samples', '2'));
  if (!Number.isInteger(samples) || samples < 1) throw new Error('--samples 要是正整数。');
  const judgeModel = option('judge');
  const judgeOnly = flag('judge-only');
  if (judgeOnly && !judgeModel) throw new Error('--judge-only 要和 --judge <模型> 一起用。');
  const extra = option('extra-replies') ? parseExtraReplies(await readFile(path.resolve(option('extra-replies')), 'utf8')) : null;
  // --resume: keep the good replies of a stopped run in --out (its seed too), ask only the rest; empty or broken ones are asked again.
  const resume = flag('resume');
  const kept: BlindReply[] = resume ? (await readJson<{ replies: BlindReply[] }>(path.join(out, 'replies-by-version.json'))).replies.filter(r => r.version !== 5 && keepOnResume(r)) : [];
  const skip = new Set(kept.map(r => replyKey(r.scenario, r.sample, r.version)));
  const planned = judgeOnly ? 0 : scenarios.length * BLIND_VERSIONS.length * samples - skip.size;
  const cap = Number(option('max-requests', '120'));
  if (planned > cap) throw new Error(`计划 ${planned} 次回复请求，超过 --max-requests ${cap}，没有开始。`);
  const judgePlanned = judgeModel ? scenarios.length * samples : 0;
  const judgeCap = Number(option('max-judge', '30'));
  if (judgePlanned > judgeCap) throw new Error(`计划 ${judgePlanned} 次评审请求，超过 --max-judge ${judgeCap}，没有开始。`);
  const cardFile = option('card-file');
  if (!cardFile && !fake) throw new Error('真实运行需要 --card-file <角色卡路径>（私人只读副本）。');
  const card = cardFile ? (await loadCardFile(parseCardFileSpec(cardFile))).card : FIDELITY_CARDS[0]!;
  const seed = option('seed') ? Number(option('seed')) : resume ? (await readJson<BlindKey>(path.join(out, 'key.json'))).seed : randomInt(1, 2 ** 31);
  const binary = fake ? process.execPath : process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = fake ? [path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  console.log(`[blind] ${planned} 次回复请求${judgePlanned ? `、${judgePlanned} 次评审请求` : ''}${extra ? `、外部回复（${extra.label}）` : ''}（${fake ? '假 Claude，不计额度' : `真实 Claude，回复模型 ${option('model', 'opus')}`}）；输出到 ${out}`);

  let items: readonly SheetItem[];
  let stopped: string | null = null;
  if (judgeOnly) items = await readJson<SheetItem[]>(path.join(out, 'sheet-items.json'));
  else {
    const result = await runBlind({ card, model: fake ? '' : option('model', 'opus'), binary, ...(binaryArgs ? { binaryArgs } : {}), prewarmMs: fake ? 100 : 3000,
      budget: new CallBudget(0, fake ? Infinity : cap, fake ? Infinity : cap, !fake), seed, samples, ...(resume ? { skip } : {}), log: console.log });
    stopped = result.stopped;
    if (resume) console.log(`[blind] 续跑：沿用 ${kept.length} 条，新问 ${result.replies.length} 条`);
    const replies = [...kept, ...result.replies, ...(extra ? externalReplies(extra, scenarios, samples) : [])];
    const written = await writeBlindOutputs(out, replies, seed, { fake, samples, stopped, ...(extra ? { externalLabel: extra.label } : {}) });
    items = written.items;
    console.log(`[blind] ${result.replies.length} 条回复${extra ? '（另有外部回复）' : ''}；选择表 ${written.sheetItems} 页：${written.files.sheet}`);
    for (const line of formatReport({}, written.stats)) console.log(line);
    for (const reply of result.replies.filter(r => r.version === 4)) console.log(`  路由 ${reply.scenario}#${reply.sample}：心情=${reply.route?.mood ?? '?'}，为什么=${reply.route?.why ? '加' : '不加'}`);
  }
  if (judgeModel && !stopped) {
    const judged = await runJudge({ persona: card.persona, items, model: judgeModel, binary, ...(binaryArgs ? { binaryArgs } : {}), budget: new CallBudget(0, fake ? Infinity : judgeCap, fake ? Infinity : judgeCap, !fake), fake, seed, log: console.log });
    console.log(`[blind] 评审：${Object.keys(judged.picks).length} 页 → ${await writeJudgeFile(out, judged)}`);
    if (judged.stopped) stopped = judged.stopped;
  }
  if (stopped) { console.error(`[blind] 中止：${stopped}`); process.exitCode = 1; }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
