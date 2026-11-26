// I-138 restart-drift experiment (docs/claude/2026-11-15-i134-restart-drift-experiment.md; how to run: docs/claude/2026-11-15-i138-tool.md).
// Does she change when a long chat moves to a new process? Per moment: her note, a live warm-up, then four arms from the same point
// (W same process, R rebuilt from the archive, R0 rebuilt without the note, C forked and compacted). Console output carries ids, counts and
// timings only. --fake uses the offline fake Claude (no quota). Real runs need the user's go-ahead: they spend the user's Claude quota.
//
//   --dry-run [--points f | --moments n] [--warmup 12] [--next 5] [--q1-calls n]        prints the planned calls per step, calls nothing
//   --suggest-moments --snapshot <dir> --out <dir> [--need 17] [--limit 10]               writes moments.json (ids and times only)
//   --snapshot <dir> --points <points.json> --card-file <card> --out <dir>                 the run
//       [--warmup 12] [--next 5] [--max-calls 115] [--model opus] [--seed n] [--resume] [--no-review] [--arms W,R,R0,C]
//       [--dump-prompts <dir>] [--claude-home <dir>] [--keep-transcripts] [--character id] [--provider-scope hash] [--slow-warm-up] [--fake]
//   --q1 --snapshot <dir> --points <points.json> --card-file <card> --out <dir> [--window-chars 40000]   characters to tokens
//   --report --out <dir>                    rewrites metrics.md, sheet.html, items.json, key.json from state.json
//   --tally-ranks <ranks.json> --out <dir>  mean rank per arm from the user's reading sheet (key.json in --out)
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { findClaude } from '../electron/brain/claude';
import { loadCardFile, parseCardFileSpec } from './lib/fidelity-card-files';
import { FIDELITY_CARDS } from './lib/fidelity-scenarios';
import { assertNotProfilePath, loadSnapshot, parsePoints } from './lib/i134-replay';
import { fakeReviewAnswer, formatDriftTally, tallyDriftRanks, type DriftKey, type DriftRankFile } from './lib/i138-analysis';
import { DEFAULT_CALL_CAP, DEFAULT_SETTINGS, DRIFT_ARMS, CallCap, assertDriftOut, plannedCalls, suggestMoments, type DriftArm } from './lib/i138-plan';
import { claudeAsk, fakeAsk, type EngineOptions } from './lib/i138-run';
import { loadDriftState, measureTokens, runDrift, writeDriftOutputs } from './lib/i138-driver';

const root = path.resolve(import.meta.dirname, '..');
const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const integer = (name: string, fallback: number) => { const value = Number(option(name, String(fallback))); if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} 要是正整数。`); return value; };

async function main(): Promise<void> {
  const fake = flag('fake');
  const model = option('model', 'opus');
  const warmup = integer('warmup', DEFAULT_SETTINGS.warmup), next = integer('next', DEFAULT_SETTINGS.next), cap = integer('max-calls', DEFAULT_CALL_CAP);
  const review = !flag('no-review');
  const arms = (option('arms') ? option('arms').split(',').map(arm => arm.trim()) : [...DRIFT_ARMS]) as DriftArm[];
  if (!arms.every(arm => (DRIFT_ARMS as readonly string[]).includes(arm)) || new Set(arms).size !== arms.length) throw new Error('--arms 只能是 W,R,R0,C，不能重复。');

  if (flag('dry-run')) {
    const points = option('points') ? parsePoints(await readFile(path.resolve(option('points')), 'utf8')).length : integer('moments', DEFAULT_SETTINGS.moments);
    const plan = plannedCalls({ warmup, next, moments: points, review, q1Calls: Number(option('q1-calls', '0')), arms });
    console.log(`[i138] 演练，不调用任何东西：${points} 个时刻，热身 ${warmup}，每组 ${next}，arms ${arms.join(',')}`);
    for (const step of plan.steps) console.log(`  ${step.step}：${step.calls} 次`);
    console.log(`[i138] 合计 ${plan.total} 次调用（上限 ${cap}${plan.total > cap ? '，超过上限，真跑会拒绝' : ''}）`);
    return;
  }
  if (option('tally-ranks')) {
    const out = await assertDriftOut('--out', option('out') || (() => { throw new Error('需要 --out <文件夹>。'); })());
    const key = JSON.parse(await readFile(path.join(out, 'key.json'), 'utf8')) as DriftKey;
    const ranks = JSON.parse(await readFile(path.resolve(option('tally-ranks')), 'utf8')) as DriftRankFile;
    for (const line of formatDriftTally(tallyDriftRanks({ ranks: ranks.ranks ?? {}, ...(ranks.skipped ? { skipped: ranks.skipped } : {}), ...(ranks.notes ? { notes: ranks.notes } : {}) }, key))) console.log(line);
    return;
  }
  if (flag('report')) {
    const out = await assertDriftOut('--out', option('out') || (() => { throw new Error('需要 --out <文件夹>。'); })());
    const state = await loadDriftState(out);
    if (!state) throw new Error('--out 里没有 state.json。');
    const files = await writeDriftOutputs(out, state);
    console.log(`[i138] 已重写：${files.metrics}、${files.sheet}`);
    return;
  }

  const snapshotDir = option('snapshot');
  if (!snapshotDir) throw new Error('需要 --snapshot <聊天快照文件夹>（只读）。');
  assertNotProfilePath('--snapshot', snapshotDir);
  const outOption = option('out');
  if (!outOption) throw new Error('需要 --out <文件夹>：回复、笔记、审查和选择表只写在这里（在代码仓库之外）。');
  const out = await assertDriftOut('--out', outOption);
  const cardFile = option('card-file');
  if (!cardFile && !fake) throw new Error('真实运行需要 --card-file <角色卡路径>（私人只读副本）。');
  const card = cardFile ? (await loadCardFile(parseCardFileSpec(cardFile))).card : FIDELITY_CARDS[0]!;
  const binary = fake ? process.execPath : process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = fake ? [path.join(root, 'scripts', 'lib', 'i138-fake-claude.mjs')] : undefined;
  const snapshot = await loadSnapshot(path.resolve(snapshotDir), { ...(option('character') ? { characterId: option('character') } : {}), ...(option('provider-scope') ? { providerScope: option('provider-scope') } : {}) });
  try {
    console.log(`[i138] 快照：${snapshot.messages.length} 条消息，${snapshot.cache.length} 条记录，${snapshot.moods.length} 条心情变化`);
    if (flag('suggest-moments')) {
      const found = suggestMoments(snapshot.messages, integer('need', warmup + next), { limit: integer('limit', 10) });
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, 'moments.json'), JSON.stringify(found.map(({ id, at }) => ({ id, at })), null, 2), 'utf8');
      console.log(`[i138] ${found.length} 个候选时刻（各自连续有至少 ${integer('need', warmup + next)} 句用户消息）：${found.map(item => `${item.id}=${item.users}句`).join('，')}`);
      return;
    }
    if (!option('points')) throw new Error('需要 --points <points.json>（[{"id":"m01","at":毫秒}]，可先用 --suggest-moments 生成）。');
    const points = parsePoints(await readFile(path.resolve(option('points')), 'utf8'));
    const used = (await loadDriftState(out))?.callsUsed ?? 0;
    const callCap = new CallCap(cap, flag('resume') ? used : 0);
    const dumpOption = option('dump-prompts');
    const dumpDir = dumpOption ? await assertDriftOut('--dump-prompts', dumpOption) : null;
    if (dumpDir) await mkdir(dumpDir, { recursive: true });
    const engine: EngineOptions = {
      snapshot, card: { ...card, slowWarmUp: flag('slow-warm-up') }, model: fake ? '' : model, binary, ...(binaryArgs ? { binaryArgs } : {}), cap: callCap, log: console.log,
      ...(dumpDir ? { promptDump: (name: string, prompt: string) => writeFile(path.join(dumpDir, `${name}.txt`), prompt, 'utf8') } : {}),
      ...(option('claude-home') ? { claudeHome: path.resolve(option('claude-home')) } : {}),
    };
    console.log(`[i138] 准备开始（${fake ? '假 Claude，不计额度' : `真实 Claude，模型 ${model}，会占用户的 Claude 用量`}），上限 ${cap} 次`);
    if (flag('q1')) {
      const result = await measureTokens(engine, points, integer('window-chars', 40_000), out);
      console.log(`[i138] 问题 1：${result.samples.length} 个样本，每字约 ${result.ratio?.tokensPerChar ?? '-'} 词元（${result.ratio?.min ?? '-'}～${result.ratio?.max ?? '-'}）`);
      if (result.projection) console.log(`[i138] ${result.sessionMaxChars} 字时约 ${result.projection.tokens} 词元，是 1M 窗口的 ${Math.round(result.projection.ofContext * 100)}%，是默认压缩线（约 96.7 万）的 ${Math.round(result.projection.ofAutoCompact * 100)}%`);
      return;
    }
    const seed = option('seed') ? Number(option('seed')) : (await loadDriftState(out))?.seed ?? randomInt(1, 2 ** 31);
    const result = await runDrift({
      engine, points, settings: { warmup, next, review }, arms, seed, out, resume: flag('resume'), fake, cap: callCap, removeTranscripts: !fake && !flag('keep-transcripts'),
      askNote: fake ? fakeAsk(callCap, '笔记', () => '（假笔记）我是她，我记得你喜欢牛肉面。') : claudeAsk(engine, '笔记'),
      askReview: fake ? fakeAsk(callCap, '审查', () => fakeReviewAnswer()) : claudeAsk(engine, '审查'),
    });
    console.log(`[i138] ${result.state.moments.filter(moment => moment.done).length}/${points.length} 个时刻完成，用了 ${callCap.used} 次调用；机器量：${path.join(out, 'metrics.md')}；读的页：${path.join(out, 'sheet.html')}`);
    if (result.stopped) { console.error(`[i138] 中止：${result.stopped}（--resume 可续跑，做完的时刻会保留）`); process.exitCode = 1; }
  } finally { await snapshot.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
