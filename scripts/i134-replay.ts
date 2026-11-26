// I-134 replay experiment (docs/claude/2026-11-14-i134-replay.md): can one character live in ONE long Claude conversation instead of a
// process retired every 12 turns that sees only the last 24 messages? We replay the user's real chat (a private read-only snapshot) at
// chosen moments and answer each moment several ways through the app's real pipeline (scripts/lib/prompt-eval-runner.ts), then the user
// blind-picks on a sheet:
//   A 现在的做法  last 23 messages + the current one, the temp archive seeded with everything before the point (the app's own recall runs)
//   B 长对话      ALL earlier messages + the current one, archive not seeded (no recall)
//   C 压缩        like A plus a per-day "她对你的了解" page (made by --make-summaries) as host context
//   D 画像        like A plus a profile text from --profile-file as host context (only when that file is given)
// Console output carries ids, counts and timings only, never message text. --fake uses the offline fake Claude (no quota).
//
//   --make-summaries --snapshot <dir> --days 2026-11-08,2026-11-11 --out-summaries <file> [--card-file <card>] [--model opus] [--fake]
//   --snapshot <dir>  --points <points.json> --card-file <card> --out <dir>   the run
//       [--summaries <file>] [--profile-file <file>] [--arms A,B,C,D] [--seed n] [--model opus] [--max-calls 80] [--latency-points 3] [--retry-refused] [--dump-prompts <dir>] [--e-before-day 60]
//       [--drop-messages <file>] [--character <id>] [--provider-scope <hash>] [--slow-warm-up] [--resume] [--fake]
//   --tally <picks.json> --out <dir>          wins per arm (key.json in --out)
//   --rank-sheet --out <dir>                  a ranking sheet (rank 1 = best, ties allowed, pages can be skipped) from items.json
//   --tally-ranks <ranks.json> --out <dir>    mean rank, firsts, lasts and pairwise results per arm
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { findClaude } from '../electron/brain/claude';
import { assertPrivateRoot } from './lib/private-root.mjs';
import { loadCardFile, parseCardFileSpec } from './lib/fidelity-card-files';
import { FIDELITY_CARDS } from './lib/fidelity-scenarios';
import { CallBudget } from './lib/fidelity-run';
import {
  ALL_ARMS, armsFor, assertNotProfilePath, claudeSummaryAsk, fakeSummaryAsk, formatTally, keepOnResume, loadSnapshot, makeSummaries, parsePoints, planRuns,
  parseDropList, readPicks, runReplay, summaryMarkdown, tallyPicks, writeReplayOutputs, type Arm, type ReplayKey, type ReplayReply,
  formatRankTally, rankSheetHtml, readRanks, tallyRanks, type SheetItem,
} from './lib/i134-replay';

const root = path.resolve(import.meta.dirname, '..');
const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;

async function privateOut(label: string, target: string): Promise<string> {
  assertNotProfilePath(label, target);
  return assertPrivateRoot(target);
}

async function main(): Promise<void> {
  const fake = flag('fake');
  const model = option('model', 'opus');
  const cap = Number(option('max-calls', '80'));
  if (!Number.isInteger(cap) || cap < 1) throw new Error('--max-calls 要是正整数。');
  const binary = fake ? process.execPath : process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = fake ? [path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;

  if (option('tally')) {
    const out = await privateOut('--out', option('out') || (() => { throw new Error('--tally 需要 --out <文件夹>（里面有 key.json）。'); })());
    const key = await readJson<ReplayKey>(path.join(out, 'key.json'));
    for (const line of formatTally(tallyPicks(await readPicks(path.resolve(option('tally'))), key))) console.log(line);
    return;
  }
  // --rank-sheet --out <dir>: a ranking sheet (rank-sheet.html) from the run's items.json; --tally-ranks <ranks.json> --out <dir>: mean rank etc.
  if (flag('rank-sheet') || option('tally-ranks')) {
    const out = await privateOut('--out', option('out') || (() => { throw new Error('需要 --out <文件夹>（里面有 items.json 和 key.json）。'); })());
    if (option('tally-ranks')) {
      const key = await readJson<ReplayKey>(path.join(out, 'key.json'));
      for (const line of formatRankTally(tallyRanks(await readRanks(path.resolve(option('tally-ranks'))), key))) console.log(line);
    } else {
      const file = path.join(out, 'rank-sheet.html');
      await writeFile(file, rankSheetHtml(await readJson<SheetItem[]>(path.join(out, 'items.json'))), 'utf8');
      console.log(`[i134] 排序页：${file}`);
    }
    return;
  }

  const snapshotDir = option('snapshot');
  if (!snapshotDir) throw new Error('需要 --snapshot <聊天快照文件夹>（只读）。');
  assertNotProfilePath('--snapshot', snapshotDir);
  const cardFile = option('card-file');
  if (!cardFile && !fake) throw new Error('真实运行需要 --card-file <角色卡路径>（私人只读副本）。');
  const card = cardFile ? (await loadCardFile(parseCardFileSpec(cardFile))).card : FIDELITY_CARDS[0]!;
  const dropFile = option('drop-messages');
  if (dropFile) assertNotProfilePath('--drop-messages', dropFile);
  const drop = dropFile ? parseDropList(await readFile(path.resolve(dropFile), 'utf8')) : undefined;
  const snapshot = await loadSnapshot(path.resolve(snapshotDir), { ...(drop ? { dropAssistantAt: drop } : {}), ...(option('character') ? { characterId: option('character') } : {}), ...(option('provider-scope') ? { providerScope: option('provider-scope') } : {}) });
  try {
    console.log(`[i134] 快照：${snapshot.messages.length} 条消息，${snapshot.cache.length} 条记录，${snapshot.moods.length} 条心情变化${drop ? `，去掉 ${snapshot.dropped} 条漏稿回复` : ""}`);

    if (flag('make-summaries')) {
      const outFile = option('out-summaries');
      const days = option('days').split(',').map(day => day.trim()).filter(Boolean);
      if (!outFile || !days.length) throw new Error('--make-summaries 需要 --days 2026-11-08,… 和 --out-summaries <文件>。');
      await privateOut('--out-summaries', path.dirname(path.resolve(outFile)));
      assertNotProfilePath('--out-summaries', outFile);
      const budget = new CallBudget(0, fake ? Infinity : cap, fake ? Infinity : cap, !fake);
      const ask = fake ? fakeSummaryAsk : claudeSummaryAsk({ model, binary, ...(binaryArgs ? { binaryArgs } : {}), budget });
      console.log(`[i134] ${days.length} 次摘要请求（${fake ? '假 Claude，不计额度' : `真实 Claude，模型 ${model}`}）`);
      const summaries = await makeSummaries(snapshot.messages, days, ask, cardFile ? card.persona : undefined, console.log);
      await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
      await writeFile(path.resolve(outFile), JSON.stringify(summaries, null, 2), 'utf8');
      console.log(`[i134] 摘要已写入 ${path.resolve(outFile)}`);
      return;
    }

    const outOption = option('out');
    if (!outOption) throw new Error('需要 --out <文件夹>：回复、选择表和答案钥匙只写在这里。');
    const out = await privateOut('--out', outOption);
    if (!option('points')) throw new Error('需要 --points <points.json>。');
    const points = parsePoints(await readFile(path.resolve(option('points')), 'utf8'));
    const profileFile = option('profile-file');
    let profile: string | undefined;
    if (profileFile) { assertNotProfilePath('--profile-file', profileFile); profile = (await readFile(path.resolve(profileFile), 'utf8')).trim(); if (!profile) throw new Error('--profile-file 是空的。'); }
    const wanted = option('arms') ? option('arms').split(',').map(arm => arm.trim().toUpperCase()) : armsFor(!!profile);
    if (!wanted.every(arm => (ALL_ARMS as readonly string[]).includes(arm))) throw new Error('--arms 只能是 A,B,C,D,E。');
    const arms = wanted as Arm[];
    let summaries: Record<string, string> | undefined;
    if (option('summaries')) { assertNotProfilePath('--summaries', option('summaries')); summaries = await readJson<Record<string, string>>(path.resolve(option('summaries'))); }
    const dumpOption = option('dump-prompts');
    const dumpDir = dumpOption ? await privateOut('--dump-prompts', dumpOption) : null;
    if (dumpDir) await mkdir(dumpDir, { recursive: true });
    const promptDump = dumpDir ? (name: string, prompt: string) => writeFile(path.join(dumpDir, `${name}.txt`), prompt, 'utf8') : undefined;
    const latencyPoints = Number(option('latency-points', '3'));
    const resume = flag('resume');
    const kept: ReplayReply[] = resume ? (await readJson<{ replies: ReplayReply[] }>(path.join(out, 'replies.json'))).replies.filter(reply => keepOnResume(reply, flag('retry-refused'))) : [];
    const seed = option('seed') ? Number(option('seed')) : resume ? (await readJson<ReplayKey>(path.join(out, 'key.json'))).seed : randomInt(1, 2 ** 31);
    const planned = planRuns({ snapshot, points, seed, arms, ...(summaries ? { summaries } : {}), ...(profile ? { profile } : {}), latencyPoints, kept, retryRefused: flag('retry-refused') });
    if (planned.calls > cap) throw new Error(`计划 ${planned.calls} 次回复请求，超过 --max-calls ${cap}，没有开始。`);
    console.log(`[i134] ${points.length} 个点，arms ${arms.join('')}，${planned.calls} 次回复请求${resume ? `（续跑，沿用 ${kept.length} 条）` : ''}（${fake ? '假 Claude，不计额度' : `真实 Claude，模型 ${model}`}）；输出到 ${out}`);
    const result = await runReplay({
      snapshot, points, card: { ...card, slowWarmUp: flag('slow-warm-up') }, model: fake ? '' : model, binary, ...(binaryArgs ? { binaryArgs } : {}), prewarmMs: fake ? 100 : 3000,
      budget: new CallBudget(0, fake ? Infinity : cap, fake ? Infinity : cap, !fake), seed, arms, ...(summaries ? { summaries } : {}), ...(profile ? { profile } : {}),
      latencyPoints, kept, retryRefused: flag('retry-refused'), eBeforeDay: Number(option('e-before-day', '60')), ...(promptDump ? { promptDump } : {}), log: console.log,
    });
    const written = await writeReplayOutputs(out, result.replies, result.points, seed, arms, { fake, model: fake ? 'fake' : model, ...(result.stopped ? { stopped: result.stopped } : {}) });
    console.log(`[i134] ${result.replies.length} 条回复；选择表 ${written.items.length} 页：${written.files.sheet}`);
    console.log(summaryMarkdown(result.replies, arms));
    if (result.stopped) { console.error(`[i134] 中止：${result.stopped}`); process.exitCode = 1; }
  } finally { await snapshot.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
