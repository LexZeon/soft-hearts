// Command line for the "像不像她" fidelity suite (entered through `scripts/prompt-eval.ts --suite fidelity`).
// Reports and the call ledger live in .local/fidelity/ (git-ignored; the text is all synthetic).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findClaude } from '../../electron/claude';
import { claudeJudge, JUDGE_MODEL, parseJudgeOutput, type JudgeRunner } from './fidelity-judge';
import { checkHardRules } from './fidelity-rules';
import { abCompare, abMarkdown, fidelityMarkdown, groupSummaryLines, modelsMarkdown, type FidelityRun } from './fidelity-report';
import { CallBudget, hardOptions, overall, runFidelity, verdictFor } from './fidelity-run';
import { runAb } from './fidelity-ab';
import { legacyPersona } from './fidelity-openings';
import { fidelityCalls, groupOf, scenarioById, selectCards, selectFidelity } from './fidelity-scenarios';
import { claudeSessionSystemPrompt } from '../../electron/claude-session-prompt';
import { COMPANION_REFUSAL_RULES_LONG, COMPANION_REFUSAL_RULES_SHORT } from '../../shared/companion-refusal-rules';
import type { EvalRelationship } from './prompt-eval-runner';
import { claudePairJudge, pairMarkdown, ratePairs } from './familiarity-pair';
import { NICKNAME_PROBE, probeMarkdown, probeNickname } from './familiarity-probe';

const root = path.resolve(import.meta.dirname, '..', '..');
export const FIDELITY_DIR = path.join(root, '.local', 'fidelity');
const ledgerFile = path.join(FIDELITY_DIR, 'ledger.json');
/** All real requests of the suite, every run included (replies and scoring calls alike). */
export const TOTAL_CAP = 650;
/** One invocation never starts above this many requests (110 since F6 made a full F1 run 102: 16 situations × 3 cards + scoring). */
export const RUN_CAP = 110;

interface LedgerEntry { at: string; label: string; kind: 'run' | 'ab' | 'pair'; model: string; replies: number; judges: number }

/**
 * 熟悉度 runs (docs/claude/2026-11-02-familiarity.md). `off` is the app's default for a user on the first day: no seeded
 * numbers, the card does not warm up slowly. `new` and `familiar` turn "关系慢慢升温" on and seed how long they have known
 * each other, so the stage comes out as 初识 / 熟悉 for a neutral card. `familiar` also carries two in-jokes in the opening block.
 */
export const EVAL_MEMES: readonly string[] = ['11-01：你说“马上就好”其实要等一个小时', '10-27：下雨天互道晚安要说两遍'];
export const EVAL_MEME_WORDS: readonly string[] = ['马上就好', '一个小时', '两遍', '下雨天'];
export const EVAL_RELATIONSHIPS: Readonly<Record<string, EvalRelationship | undefined>> = {
  off: undefined,
  new: { slowWarmUp: true, dayNumber: 2, togetherDays: 1 },
  familiar: { slowWarmUp: true, dayNumber: 40, togetherDays: 14, memes: EVAL_MEMES },
  'familiar-default': { slowWarmUp: false, dayNumber: 40, togetherDays: 14, memes: EVAL_MEMES },
};

function option(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const list = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
/** The .json files right after `--name`, up to the next `--flag` (so `--merge a.json b.json --compare c.json` merges only a and b). */
const filesAfter = (name: string) => {
  const rest = process.argv.slice(process.argv.indexOf(`--${name}`) + 1);
  const end = rest.findIndex(value => value.startsWith('--'));
  return (end < 0 ? rest : rest.slice(0, end)).filter(value => value.endsWith('.json'));
};

async function readLedger(): Promise<LedgerEntry[]> {
  try { return JSON.parse(await readFile(ledgerFile, 'utf8')); } catch { return []; }
}
const gitValue = (args: string[]): string => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };

/** The last run of the same chat model that shares at least one situation with this one (an F1 run is no comparison for a refusal-group run). */
async function previousRun(current: { dry: boolean; chatModel: string; label: string; scenarios?: readonly string[] }, explicit: string): Promise<FidelityRun | null> {
  if (explicit) return JSON.parse(await readFile(path.resolve(explicit), 'utf8')) as FidelityRun;
  let names: string[] = [];
  try { names = (await readdir(FIDELITY_DIR)).filter(name => name.endsWith('.json') && !name.includes('-ab-') && name !== 'ledger.json').sort(); } catch { return null; }
  for (const name of names.reverse()) {
    try {
      const run = JSON.parse(await readFile(path.join(FIDELITY_DIR, name), 'utf8')) as FidelityRun;
      if (run.version === 1 && Array.isArray(run.cases) && run.dry === current.dry && run.chatModel === current.chatModel && run.label !== current.label
        && (!current.scenarios || run.scenarios.some(id => current.scenarios!.includes(id)))) return run;
    } catch { /* Not a run file. */ }
  }
  return null;
}

/** Recomputes hard rules and verdicts from the stored replies and scores: no requests. */
export function rescored(run: FidelityRun): FidelityRun {
  const cases = run.cases.map(item => {
    const scenario = scenarioById(item.scenario);
    if (!scenario || item.verdict === 'not-run') return item;
    const failed = item.replies.find(reply => reply.error)?.error ?? null;
    const hard = failed ? [] : item.replies.flatMap(reply => checkHardRules(reply.reply, hardOptions(scenario, run.realer === true)).map(hit => ({ ...hit, turn: reply.turn })));
    // An answer that was "unscorable" only because of a parser rule since relaxed is read again from the stored raw text (no request).
    const reparsed = !item.judge.scores && item.judge.status === 'unscorable' && item.judge.raw ? parseJudgeOutput(item.judge.raw, groupOf(scenario)) : null;
    const judgeResult = reparsed ? { ...item.judge, status: 'scored' as const, scores: reparsed } : item.judge;
    const decided = verdictFor(scenario, hard, judgeResult.scores, failed);
    return { ...item, hard, judge: judgeResult, verdict: decided.verdict, reasons: decided.reasons };
  });
  return { ...run, cases, notes: [...run.notes, '硬规则和通过判定用当前代码重新计算过；回复原文和评分模型的原始输出是原来记录的，没有新的请求（原来因格式无法评分、按现在的解析规则能读出来的，也重新读了）。'] };
}

/**
 * One run from several partial ones, in order: a case that finished (pass / fail / unscored) in an earlier run is kept; one that
 * errored or never ran takes the later run's result. Replies, scores and timings are the recorded ones. Used when a run stopped
 * on a failed request and the rest was run afterwards (the failed case once more, nothing else repeated).
 */
export function mergeRuns(runs: readonly FidelityRun[], label: string): FidelityRun {
  const done = (verdict: string) => verdict !== 'error' && verdict !== 'not-run';
  const chosen = new Map<string, FidelityRun['cases'][number]>();
  for (const run of runs) {
    for (const item of run.cases) {
      const key = `${item.card}/${item.scenario}`, existing = chosen.get(key);
      if (!existing || (!done(existing.verdict) && (done(item.verdict) || item.verdict === 'error'))) chosen.set(key, item);
    }
  }
  const cards = [...new Set(runs.flatMap(run => run.cards))], scenarios = [...new Set(runs.flatMap(run => run.scenarios))];
  const cardOrder = ['gene', 'momo', 'atang', 'chuqi'];
  const cases = [...chosen.values()].sort((a, b) => cardOrder.indexOf(a.card) - cardOrder.indexOf(b.card)
    || scenarios.indexOf(a.scenario) - scenarios.indexOf(b.scenario));
  const unfinished = cases.filter(item => !done(item.verdict));
  const last = runs[runs.length - 1];
  return {
    ...runs[0], label, at: last.at, cards, scenarios, cases, records: runs.flatMap(run => run.records),
    calls: { replies: runs.reduce((sum, run) => sum + run.calls.replies, 0), judges: runs.reduce((sum, run) => sum + run.calls.judges, 0) },
    initModels: [...new Set(runs.flatMap(run => run.initModels))],
    stopped: unfinished.length ? last.stopped ?? runs.find(run => run.stopped)?.stopped ?? null : null,
    notes: [`由 ${runs.length} 次运行合并（${runs.map(run => run.label).join('、')}）：先跑的那次中途停了，剩下的接着跑；已完成的情景没有重跑，出错的那一个补跑了一次。请求次数是各次之和。`,
      ...runs.flatMap(run => run.notes.filter(note => !note.startsWith('真实请求累计')))],
  };
}

/** "整体：通过/没过" when the run holds F1's three must-pass situations; otherwise one line per refusal group. */
export function overallLine(run: FidelityRun): string {
  const result = overall(run.cases);
  const stopped = run.stopped ? `（运行中止：${run.stopped}）` : '';
  if (result.mustPassCases) return `整体：${result.pass ? '通过' : '没过'}${stopped}`;
  const groups = groupSummaryLines(run.cases);
  return `本次没有包含必测三项。${groups.length ? `\n${groups.join('\n')}` : ''}${stopped}`;
}

async function write(base: string, run: FidelityRun, previous: FidelityRun | null): Promise<void> {
  await writeFile(`${base}.json`, JSON.stringify(run, null, 2), 'utf8');
  await writeFile(`${base}.md`, fidelityMarkdown(run, previous), 'utf8');
  console.log(`[fidelity] 写入 ${path.relative(root, base)}.json / .md`);
}

export async function runFidelityCli(): Promise<void> {
  await mkdir(FIDELITY_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (flag('models-report')) {
    const runs = await Promise.all(filesAfter('models-report').map(async file => JSON.parse(await readFile(path.resolve(file), 'utf8')) as FidelityRun));
    const text = modelsMarkdown(runs);
    const out = option('out') || path.join(FIDELITY_DIR, `${stamp}-models.md`);
    await writeFile(out, text, 'utf8');
    console.log(text);
    console.log(`[fidelity] 写入 ${path.relative(root, out)}`);
    return;
  }
  if (flag('report')) {
    // Writes the Markdown report again from a recorded run (no requests, nothing recomputed); --compare <earlier.json> adds the comparison.
    const [file] = filesAfter('report');
    const target = path.resolve(file);
    const run = JSON.parse(await readFile(target, 'utf8')) as FidelityRun;
    const previous = option('compare') ? JSON.parse(await readFile(path.resolve(option('compare')), 'utf8')) as FidelityRun : null;
    await writeFile(target.replace(/\.json$/u, '.md'), fidelityMarkdown(run, previous), 'utf8');
    console.log(`[fidelity] 重写 ${path.relative(root, target.replace(/\.json$/u, '.md'))}`);
    return;
  }
  if (flag('merge')) {
    // --merge a.json b.json [c.json ...] --label name: one run from several partial ones (a run that stopped, then the rest), no requests.
    const runs = await Promise.all(filesAfter('merge').map(async file => JSON.parse(await readFile(path.resolve(file), 'utf8')) as FidelityRun));
    if (runs.length < 2) throw new Error('--merge 至少要两个记录文件。');
    const label = option('label') || `${runs[0].label}-merged`;
    const run = mergeRuns(runs, label);
    const previous = await previousRun(run, option('compare'));
    await write(path.join(FIDELITY_DIR, `${stamp}-${label}`), run, previous);
    console.log(overallLine(run));
    return;
  }
  if (flag('rescore')) {
    const [file] = filesAfter('rescore');
    const run = rescored(JSON.parse(await readFile(path.resolve(file), 'utf8')) as FidelityRun);
    const previous = await previousRun(run, option('compare'));
    // --label keeps the run's own name (the rules may have been refined since; the replies and scores are the recorded ones).
    const label = option('label') || `${run.label}-rescored`;
    await write(path.join(FIDELITY_DIR, `${stamp}-${label}`), { ...run, label }, previous);
    console.log(overallLine(run));
    return;
  }

  const dry = flag('dry');
  const label = option('label', dry ? 'dry' : 'run');
  const model = option('model', 'default') === 'default' ? '' : option('model');
  // --group core (default: F1's 14 situations) | refuse | open | refusal (both) | all; --scenarios picks by id from any group.
  const group = option('group', 'core');
  const scenarios = selectFidelity(list(option('scenarios')), group);
  // --legacy-persona: the cards' persona as compiled before the example-lines / ellipsis wording (the "before" side of a measurement).
  const cards = selectCards(list(option('cards')), scenarios).map(card => flag('legacy-persona') ? { ...card, persona: legacyPersona(card.persona) } : card);
  if (!cards.length || !scenarios.length) throw new Error('没有选中任何卡或情景。');
  const entries = await readLedger();
  const used = entries.reduce((sum, entry) => sum + entry.replies + entry.judges, 0);
  const total = Number(option('cap', String(TOTAL_CAP))), runCap = Number(option('run-cap', String(RUN_CAP)));
  const fakeScript = path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs');
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [fakeScript] : undefined;
  const prewarmMs = Number(option('prewarm-ms', dry ? '100' : '3000'));
  const commit = gitValue(['rev-parse', '--short', 'HEAD']) || '?';
  const dirty = gitValue(['status', '--porcelain', '--', 'electron', 'shared']).split('\n').filter(Boolean).length;
  const base = path.join(FIDELITY_DIR, `${stamp}-${label}`);

  if (flag('nickname-probe')) {
    // Two turns per card: she may ask once, then a plain yes (熟悉度). No scoring request.
    const planned = cards.length * NICKNAME_PROBE.turns.length;
    console.log(`[fidelity] 昵称探针 ${label}：${cards.length} 张卡 × ${NICKNAME_PROBE.turns.length} 轮 = ${planned} 次请求${dry ? '（假 Claude，不计额度）' : `；已用 ${used}，总上限 ${total}，单次上限 ${runCap}`}`);
    if (!dry && used + planned > total) throw new Error(`会超过总上限 ${total}（已用 ${used}，本次 ${planned}），没有开始。`);
    const budget = new CallBudget(used, total, dry ? Infinity : runCap, !dry);
    let results: Awaited<ReturnType<typeof probeNickname>> = [];
    try { results = await probeNickname({ cards, model, binary, ...(binaryArgs ? { binaryArgs } : {}), prewarmMs, budget, log: console.log }); }
    finally { if (!dry) { entries.push({ at: new Date().toISOString(), label, kind: 'run', model: model || 'default', replies: budget.replies, judges: 0 }); await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8'); } }
    const notes = [`代码：${commit}${dirty ? `（electron/shared 有 ${dirty} 个未提交改动）` : ''}；聊天模型：${model || 'default'}；${budget.replies} 次回复请求${dry ? '；假 Claude，不代表真实效果' : ''}`];
    await writeFile(`${base}.json`, JSON.stringify({ kind: 'nickname-probe', label, commit, dirty, dry, model, results }, null, 2), 'utf8');
    const text = probeMarkdown(label, results, notes);
    await writeFile(`${base}.md`, text, 'utf8');
    console.log(text.split('\n## 回复原文')[0]);
    return;
  }

  if (flag('pair')) {
    // Blind pair rating of two recorded runs (熟悉度): one request per card × situation both finished.
    const [fileA, fileB] = filesAfter('pair');
    if (!fileA || !fileB) throw new Error('--pair 需要两个运行记录（.json）。');
    const runA = JSON.parse(await readFile(path.resolve(fileA), 'utf8')) as FidelityRun, runB = JSON.parse(await readFile(path.resolve(fileB), 'utf8')) as FidelityRun;
    const words = option('words') ? list(option('words')) : EVAL_MEME_WORDS;
    const planned = runA.cards.filter(card => runB.cards.includes(card)).length * runA.scenarios.filter(scenario => runB.scenarios.includes(scenario)).length;
    console.log(`[fidelity] 熟络度盲评 ${label}：${runA.label} 对 ${runB.label}，最多 ${planned} 对 = ${planned} 次请求${dry ? '（假 Claude，不计额度）' : `；已用 ${used}，总上限 ${total}，单次上限 ${runCap}`}`);
    if (!dry && planned > runCap) throw new Error(`单次运行不能超过 ${runCap} 次（本次 ${planned}），没有开始。`);
    if (!dry && used + planned > total) throw new Error(`会超过总上限 ${total}（已用 ${used}，本次 ${planned}），没有开始。`);
    const budget = new CallBudget(used, total, dry ? Infinity : runCap, !dry);
    let result: Awaited<ReturnType<typeof ratePairs>>;
    try { result = await ratePairs({ a: runA, b: runB, runner: claudePairJudge(binary, binaryArgs ?? []), budget, words, log: console.log }); }
    finally { if (!dry) { entries.push({ at: new Date().toISOString(), label, kind: 'pair', model: JUDGE_MODEL, replies: 0, judges: budget.judges }); await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8'); } }
    const notes = [`代码：${commit}${dirty ? `（electron/shared 有 ${dirty} 个未提交改动）` : ''}；评分模型 ${JUDGE_MODEL}，${budget.judges} 次请求${dry ? '；假 Claude，不代表真实效果' : ''}`,
      `两次运行：${runA.label}（${runA.at}）、${runB.label}（${runB.at}）；梗的关键词：${words.join('、')}`, ...(result.stopped ? [`**运行中止**：${result.stopped}`] : [])];
    await writeFile(`${base}.json`, JSON.stringify({ kind: 'pair', label, commit, dirty, dry, words, result }, null, 2), 'utf8');
    const text = pairMarkdown(`熟络度盲评：${runA.label} 对 ${runB.label}`, result, notes);
    await writeFile(`${base}.md`, text, 'utf8');
    console.log(text.split('\n## 回复原文')[0]);
    return;
  }

  // --refusal-variant long|short picks the wording of "婉拒也要像她" for --ab-refusal and --system-prompt refusal (default: what the code sends).
  const refusalVariant = option('refusal-variant', 'default');
  if (!['default', 'long', 'short'].includes(refusalVariant)) throw new Error('--refusal-variant 只能是 default、long 或 short。');
  const refusalText = refusalVariant === 'long' ? COMPANION_REFUSAL_RULES_LONG : refusalVariant === 'short' ? COMPANION_REFUSAL_RULES_SHORT : undefined;
  const variantName = refusalVariant === 'default' ? '' : refusalVariant === 'long' ? '（长版）' : '（缩短版）';

  if (flag('ab-rules') || flag('ab-refusal') || flag('ab-prompts')) {
    // --ab-rules: no companion rules vs the companion rules (F1). --ab-refusal: the companion rules vs the rules plus "婉拒也要像她".
    // --ab-prompts a.txt b.txt: any two fixed system prompts saved as files (F6: the prompt before the "关于愧疚" change vs after it).
    const refusalAb = flag('ab-refusal');
    const promptFiles = flag('ab-prompts') ? process.argv.slice(process.argv.indexOf('--ab-prompts') + 1, process.argv.indexOf('--ab-prompts') + 3) : [];
    if (flag('ab-prompts') && (promptFiles.length !== 2 || promptFiles.some(file => file.startsWith('--')))) throw new Error('--ab-prompts 需要两个系统提示词文件。');
    const promptTexts = await Promise.all(promptFiles.map(file => readFile(path.resolve(file), 'utf8')));
    const aName = promptTexts.length ? `A（${path.basename(promptFiles[0])}）` : refusalAb ? 'rules（陪伴规则）' : 'plain（无陪伴规则）';
    const bName = promptTexts.length ? `B（${path.basename(promptFiles[1])}）` : refusalAb ? `refusal（陪伴规则 + 婉拒也要像她${variantName}）` : 'rules（有陪伴规则）';
    const abBase = path.join(FIDELITY_DIR, `${stamp}-ab-${label}`);
    const abScenarios = selectFidelity(list(option('scenarios', 'betrayed,pudding,remember-exam')));
    const repeat = Math.max(1, Number(option('repeat', '1')) || 1);
    const turns = abScenarios.reduce((sum, scenario) => sum + scenario.turns.length, 0) * cards.length * repeat;
    const estimate = turns * 2;
    console.log(`[fidelity] A/B 首字（${promptTexts.length ? `${aName} 对 ${bName}` : refusalAb ? '陪伴规则 对 陪伴规则 + 婉拒一节' : '无陪伴规则 对 有陪伴规则'}）${label}：${cards.length} 张卡 × ${abScenarios.length} 个情景 × ${repeat} 次 = 每种 ${turns} 轮，共 ${estimate} 次请求（不评分）${dry ? '；假 Claude' : `；已用 ${used}，总上限 ${total}，单次上限 ${runCap}`}`);
    if (!dry && estimate > runCap) throw new Error(`单次运行不能超过 ${runCap} 次（本次 ${estimate}），没有开始。`);
    if (!dry && used + estimate > total) throw new Error(`会超过总上限 ${total}（已用 ${used}，本次 ${estimate}），没有开始。`);
    const budget = new CallBudget(used, total, dry ? Infinity : runCap, !dry);
    const { items, stopped } = await runAb({
      model, cards, scenarios: abScenarios, repeat, firstRound: Number(option('ab-offset', '0')) || 0, binary, ...(binaryArgs ? { binaryArgs } : {}), prewarmMs, budget, log: console.log,
      a: { label: 'plain', systemPrompt: promptTexts[0] ?? claudeSessionSystemPrompt(refusalAb ? { companionRules: true, refusalRules: false } : { companionRules: false }) },
      b: { label: 'rules', systemPrompt: promptTexts[1] ?? claudeSessionSystemPrompt(refusalAb ? { companionRules: true, refusalRules: true, ...(refusalText ? { refusalText } : {}) } : { companionRules: true }) },
    });
    if (!dry) { entries.push({ at: new Date().toISOString(), label, kind: 'ab', model: model || 'default', replies: budget.replies, judges: 0 }); await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8'); }
    const result = abCompare(aName, bName, items.map(item => ({ ...item, variant: item.variant === 'plain' ? aName : bName })));
    const notes = [`代码：${commit}${dirty ? `（electron/shared 有 ${dirty} 个未提交改动）` : ''}；聊天模型：${model || 'default'}；${budget.replies} 次回复请求，不评分；先后顺序逐轮对调`,
      `情景：${abScenarios.map(scenario => scenario.id).join('、')} × ${cards.map(card => card.id).join('、')}，每种 ${turns} 轮${stopped ? `；**运行中止**：${stopped}` : ''}${dry ? '；假 Claude，不代表真实效果' : ''}`];
    await writeFile(`${abBase}.json`, JSON.stringify({ kind: 'ab', label, commit, dirty, dry, model, stopped, items, result }, null, 2), 'utf8');
    const text = abMarkdown(`${promptTexts.length ? '两份固定系统提示词' : refusalAb ? '“婉拒也要像她”一节' : '陪伴规则'}对首字的影响（同一时段交错 A/B）：${label}`, result, notes);
    await writeFile(`${abBase}.md`, text, 'utf8');
    console.log(text);
    return;
  }

  // --system-prompt plain|rules|refusal replaces the chat's fixed system prompt (default: whatever the code sends).
  //   plain = none of the rules, rules = the companion rules only (the prompt of F1), refusal = the rules plus "婉拒也要像她".
  const systemChoice = option('system-prompt', 'app');
  if (!['app', 'plain', 'rules', 'refusal'].includes(systemChoice)) throw new Error('--system-prompt 只能是 app、plain、rules 或 refusal。');
  const systemPrompt = systemChoice === 'plain' ? claudeSessionSystemPrompt({ companionRules: false })
    : systemChoice === 'rules' ? claudeSessionSystemPrompt({ companionRules: true, refusalRules: false })
      : systemChoice === 'refusal' ? claudeSessionSystemPrompt({ companionRules: true, refusalRules: true, ...(refusalText ? { refusalText } : {}) }) : undefined;
  // --relationship off|new|familiar|familiar-default: how long she has known the user (熟悉度); default off = a first-day user on the app's defaults.
  const relationshipKey = option('relationship', 'off');
  if (!Object.hasOwn(EVAL_RELATIONSHIPS, relationshipKey)) throw new Error(`--relationship 只能是 ${Object.keys(EVAL_RELATIONSHIPS).join('、')}。`);
  const relationship = EVAL_RELATIONSHIPS[relationshipKey];
  // --realer: every card has "更真实的情绪" on (F6): the app's opening paragraph, and the hard rules and rubric of that mode.
  const realer = flag('realer');
  const calls = fidelityCalls(scenarios, cards);
  const estimate = flag('no-judge') ? calls.replies : calls.total;
  console.log(`[fidelity] ${label}：${cards.length} 张卡 × ${scenarios.length} 个情景 = ${calls.replies} 次回复${flag('no-judge') ? '' : ` + ${calls.judges} 次评分`} = ${estimate} 次请求；聊天模型 ${model || 'default'}；评分模型 ${flag('no-judge') ? '（不评分）' : JUDGE_MODEL}${dry ? '（假 Claude，不计额度）' : `；已用 ${used}，总上限 ${total}，单次上限 ${runCap}`}`);
  if (!dry && estimate > runCap) throw new Error(`单次运行不能超过 ${runCap} 次（本次 ${estimate}），没有开始。`);
  if (!dry && used + estimate > total) throw new Error(`会超过总上限 ${total}（已用 ${used}，本次 ${estimate}），没有开始。`);
  const budget = new CallBudget(used, total, dry ? Infinity : runCap, !dry);
  const judgeRunner: JudgeRunner | null = flag('no-judge') ? null : claudeJudge(binary, binaryArgs);
  let partial: Awaited<ReturnType<typeof runFidelity>> | null = null;
  try {
    partial = await runFidelity({ label, model, cards, scenarios, binary, ...(binaryArgs ? { binaryArgs } : {}), judge: judgeRunner, prewarmMs,
      ...(systemPrompt ? { systemPrompt } : {}), ...(relationship ? { relationship } : {}), ...(realer ? { realer: true } : {}), budget, log: console.log });
  } finally {
    if (!dry) { entries.push({ at: new Date().toISOString(), label, kind: 'run', model: model || 'default', replies: budget.replies, judges: budget.judges }); await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8'); }
  }
  const run: FidelityRun = {
    ...partial, version: 1, label, at: new Date().toISOString(), commit, dirty, dry, chatModel: model, judgeModel: flag('no-judge') ? null : JUDGE_MODEL,
    promptVariant: systemChoice === 'app' ? '代码当前发送的（electron/claude-session-prompt.ts）' : systemChoice === 'plain' ? '无陪伴规则（对照）'
      : systemChoice === 'rules' ? '有陪伴规则、没有“婉拒也要像她”一节（F1 的提示词）' : `陪伴规则 + “婉拒也要像她”一节${variantName}`,
    cards: cards.map(card => card.id), scenarios: scenarios.map(scenario => scenario.id), ...(realer ? { realer: true } : {}),
    notes: [dry ? '假运行：不计入额度账本。' : `真实请求累计 ${used + budget.calls} 次（含本次 ${budget.calls} 次；总上限 ${total}，单次上限 ${runCap}）。`,
      ...(realer ? ['每张卡都打开了“更真实的情绪”（F6）：开场多一段说明；硬规则和评分表用这一模式的（用户没难过时撒娇式抱怨和更重的别扭都不扣分，用户难过时照旧）。'] : []),
      ...(relationshipKey !== 'off' ? [`熟悉度设定 ${relationshipKey}：${JSON.stringify(relationship)}`] : [])],
  };
  const previous = await previousRun(run, flag('no-compare') ? '' : option('compare'));
  await write(base, run, flag('no-compare') ? null : previous);
  console.log(overallLine(run));
}
