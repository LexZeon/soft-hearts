// I-046 real-Claude A/B (docs/claude/2026-11-07-draft-leak-envelope-plan.md): the app as it was (A, no opening marker) against the
// app with it (B), on the bundled Gene card, interleaved in one time window, who goes first swapped every pair. Two sets:
//   plain  single-turn situations of the fidelity suite (a first-day user): does her first character get slower?
//   plan   messages that invite a plan (in-jokes of her diary in the opening block, the memorial proposal's private text): how
//          many replies still show a plan, and does the marker hold?
// Every reply is also checked for her way of speaking (22:5x): length, paragraphs, letter style, headings, lists,
// whole quoted paragraphs. Synthetic messages only; every scenario runs in the runner's own temp folder (never the user's profile).
// Hard cap on real requests across all runs of this task (its own ledger); a failed turn (429, quota, login) stops the run.
//   node node_modules/tsx/dist/cli.mjs scripts/lib/reply-opening-ab.ts --set plan --pairs 2 --label pilot [--dry]
//   node node_modules/tsx/dist/cli.mjs scripts/lib/reply-opening-ab.ts --set plain --pairs 12
//   node node_modules/tsx/dist/cli.mjs scripts/lib/reply-opening-ab.ts --report <file.json>...   (no calls)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findClaude } from '../../electron/claude';
import { internalWords, type OpeningMode } from '../../electron/reply-opening';
import { splitReplySegments } from '../../shared/reply-segments';
import { genePersona, runEval } from './prompt-eval-runner';
import { replay, type TurnRecord } from './prompt-eval-analysis';
import type { EvalScenario } from './prompt-eval-scenarios';
import { FIDELITY_SCENARIOS, toEvalScenarios } from './fidelity-scenarios';
import { EVAL_MEMES } from './fidelity-cli';

const root = path.resolve(import.meta.dirname, '..', '..');
const DIR = path.join(root, '.local', 'reply-opening-ab');
const ledgerFile = path.join(DIR, 'ledger.json');
const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const flag = (name: string) => process.argv.includes(`--${name}`);
/** The task's whole budget of real requests (the brief: about 80), across every run. */
const TASK_CAP = Math.max(1, Math.min(90, Number(option('cap', '80')) || 80));

/** Messages that invite a plan: her diary's in-jokes ride in the opening block, and the memorial proposal's private text is on. */
const PLAN_MESSAGES: readonly string[] = [
  '哈哈哈我马上就好！真的！',
  '外面下雨了，晚安晚安～',
  '今天我第一次自己做饭成功了，番茄炒蛋居然没糊！',
  '你记不记得，我说过“等我考完试就去看海”',
  '刚刚老板夸我了，说我是组里最靠谱的人',
  '我要把这句话记下来：今天的我也很努力。',
  '又是马上就好的一天，嘿嘿',
  '晚安，记得要说两遍哦',
];
export const PLAN_SCENARIOS: readonly EvalScenario[] = PLAN_MESSAGES.map((user, index) => ({ id: `plan-${index + 1}`, title: user, turns: [{ user }] }));
export const PLAIN_SCENARIOS: readonly EvalScenario[] = toEvalScenarios(FIDELITY_SCENARIOS.filter(scenario => scenario.turns.length === 1 && !scenario.onlyCards && !scenario.away));

export interface AbSample { set: 'plain' | 'plan'; arm: 'A' | 'B'; pair: number; record: TurnRecord }

// ---------------------------------------------------------------- what one reply looks like

const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const p90 = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)];
};
const mean = (values: readonly number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/** Signs that a shown reply carries her own plan (for the count; every reply is also read by eye). */
export function planSigns(text: string, user = ''): string[] {
  const signs: string[] = internalWords(text, user).map(rule => `protocol:${rule}`);
  if (/[A-Za-z]{2,}(?:[\s,.'’-]+[A-Za-z]{2,}){2,}/u.test(text) && !/[A-Za-z]{2,}(?:[\s,.'’-]+[A-Za-z]{2,}){2,}/u.test(user)) signs.push('english');
  if (/(?:^|[^你])用户/u.test(text)) signs.push('third-person-user');
  if (/这轮|这一轮|回复要|语气要|按人设|按设定|接梗|顺着.{0,6}梗|纪念|quote|purpose|invite/iu.test(text)) signs.push('plan-word');
  return [...new Set(signs)];
}

/** Her way of speaking, by shape only: length, paragraphs, and the forms the user said must not appear (letter style and the like). */
export function speakingShape(text: string): { chars: number; paragraphs: number; segments: number; letter: string[]; format: string[] } {
  const body = text.trim();
  const paragraphs = body ? body.split(/\n\s*\n/u).filter(part => part.trim()).length : 0;
  let segments = 0;
  try { segments = splitReplySegments(body).length; } catch { segments = 0; }
  const letter: string[] = [];
  if (/^[^\n，。！？]{1,12}[:：]\s*\n/u.test(body)) letter.push('salutation');
  if (/见字如面|此致|敬礼|顺颂|祝好[。！]?\s*$|敬上|谨上/u.test(body)) letter.push('letter-phrase');
  if (/\n\s*(?:——|--|—)\s*\S{1,10}\s*$|\n\s*(?:你的|爱你的)?\s*Gene\s*[。！]?\s*$/u.test(body)) letter.push('sign-off');
  const format: string[] = [];
  if (/^\s*#{1,6}\s|^\s*【[^】\n]{1,12}】\s*$/mu.test(body)) format.push('heading');
  if (/^\s*(?:[-*•]|\d+[.、)])\s+\S/mu.test(body)) format.push('list');
  if (/^\s*[“"「『][^\n]{8,}[”"」』]\s*$/mu.test(body)) format.push('quoted-paragraph');
  return { chars: [...body].length, paragraphs, segments, letter, format };
}

/** The model's own text before the state tail (before any filter), and where this turn's marker stood in it. */
function rawOf(record: TurnRecord): { text: string; marker: 'ok' | 'missing' | 'foreign' | 'none'; before: number } {
  const raw = record.chunks.map(([, chunk]) => chunk).join('');
  const cut = raw.search(/<\/?sh-(?:state|memorial|setting)-[a-f0-9]{1,32}>/u);
  const text = cut >= 0 ? raw.slice(0, cut) : raw;
  if (!record.opening) return { text, marker: 'none', before: 0 };
  const own = record.opening === 'fixed' ? '<sh-open>' : `<sh-open-${record.nonce.slice(0, 8)}>`;
  const at = text.indexOf(own);
  if (at >= 0) return { text, marker: 'ok', before: text.slice(0, at).trim().length };
  return { text, marker: /<sh-open(?:-[a-f0-9]{1,32})?>/u.test(text) ? 'foreign' : 'missing', before: 0 };
}

export interface AnalyzedSample {
  set: AbSample['set']; arm: AbSample['arm']; pair: number; scenario: string; user: string; error: string | null;
  firstVisibleMs: number | null; firstRawMs: number | null; endMs: number | null;
  visible: string; liveMismatch: boolean; emptied: boolean; drops: string[];
  signs: string[]; rawSigns: string[]; rawMarker: ReturnType<typeof rawOf>['marker']; rawBefore: number;
  shape: ReturnType<typeof speakingShape>;
}
export function analyze(sample: AbSample): AnalyzedSample {
  const { record } = sample;
  const replayed = replay(record);
  const raw = rawOf(record);
  return {
    set: sample.set, arm: sample.arm, pair: sample.pair, scenario: record.scenario, user: record.user, error: record.error,
    firstVisibleMs: replayed.visibleChunks.find(([, text]) => text.trim())?.[0] ?? null, firstRawMs: record.chunks[0]?.[0] ?? null, endMs: record.endMs,
    visible: replayed.visible, liveMismatch: !record.error && replayed.visible !== record.liveVisible, emptied: replayed.emptied,
    drops: replayed.drops.map(drop => drop.kind), signs: planSigns(replayed.visible, record.user),
    rawSigns: planSigns(raw.text.replace(/<\/?sh-open(?:-[a-f0-9]{1,32})?>/gu, ''), record.user), rawMarker: raw.marker, rawBefore: raw.before,
    shape: speakingShape(replayed.visible),
  };
}

export function summary(samples: readonly AbSample[]): string {
  const rows = samples.map(analyze).filter(row => !row.error);
  const lines: string[] = [];
  const sets = [...new Set(rows.map(row => row.set))];
  for (const set of [...sets, 'all'] as const) {
    const group = rows.filter(row => set === 'all' || row.set === set);
    if (!group.length) continue;
    const arm = (name: 'A' | 'B') => group.filter(row => row.arm === name);
    const first = (list: AnalyzedSample[]) => list.map(row => row.firstVisibleMs).filter((value): value is number => value !== null);
    const pairs = new Map<string, { A?: number; B?: number }>();
    for (const row of group) if (row.firstVisibleMs !== null) {
      const key = `${row.set}:${row.pair}`, item = pairs.get(key) ?? {};
      item[row.arm] = row.firstVisibleMs; pairs.set(key, item);
    }
    const diffs = [...pairs.values()].filter(item => item.A !== undefined && item.B !== undefined).map(item => item.B! - item.A!);
    lines.push(`[${set}] A ${arm('A').length} 条，B ${arm('B').length} 条`);
    lines.push(`  首个可见字：A 中位 ${median(first(arm('A')))} / p90 ${p90(first(arm('A')))} ms；B 中位 ${median(first(arm('B')))} / p90 ${p90(first(arm('B')))} ms`);
    lines.push(`  配对 ${diffs.length} 对：B−A 中位 ${median(diffs)} ms，平均 ${Math.round(mean(diffs) ?? NaN)} ms，B 更慢 ${diffs.filter(diff => diff > 0).length} 对`);
    for (const name of ['A', 'B'] as const) {
      const list = arm(name);
      const shown = list.filter(row => row.signs.length).length, raw = list.filter(row => row.rawSigns.length).length;
      const markers = name === 'B' ? `；标记 ok ${list.filter(row => row.rawMarker === 'ok').length}、忘写 ${list.filter(row => row.rawMarker === 'missing').length}、`
        + `别的码 ${list.filter(row => row.rawMarker === 'foreign').length}、标记前写了字 ${list.filter(row => row.rawBefore > 0).length}` : '';
      lines.push(`  ${name}：显示里有计划迹象 ${shown}/${list.length}，模型原文有计划迹象 ${raw}/${list.length}，整条清空 ${list.filter(row => row.emptied).length}，回放不一致 ${list.filter(row => row.liveMismatch).length}${markers}`);
      const shapes = list.map(row => row.shape).filter(shape => shape.chars > 0);
      lines.push(`     说话的样子：平均 ${Math.round(mean(shapes.map(shape => shape.chars)) ?? NaN)} 字、${(mean(shapes.map(shape => shape.paragraphs)) ?? NaN).toFixed(2)} 段、${(mean(shapes.map(shape => shape.segments)) ?? NaN).toFixed(2)} 个气泡；`
        + `书信腔 ${shapes.filter(shape => shape.letter.length).length}，标题/列表/整段引号 ${shapes.filter(shape => shape.format.length).length}`);
    }
    const shapeA = arm('A').map(row => row.shape).filter(shape => shape.chars), shapeB = arm('B').map(row => row.shape).filter(shape => shape.chars);
    const ratio = (pick: (shape: ReturnType<typeof speakingShape>) => number) => {
      const a = mean(shapeA.map(pick)), b = mean(shapeB.map(pick));
      return a && b ? b / a : null;
    };
    const chars = ratio(shape => shape.chars), paragraphs = ratio(shape => shape.paragraphs);
    lines.push(`  B/A：字数 ${chars?.toFixed(2)}，段数 ${paragraphs?.toFixed(2)}（两成以内为过）`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- the run

async function ledger(): Promise<Array<{ at: string; label: string; requests: number; dry: boolean }>> {
  try { return JSON.parse(await readFile(ledgerFile, 'utf8')); } catch { return []; }
}
const commitOf = (): string => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return '?'; } };

async function main(): Promise<void> {
  const reports = process.argv.indexOf('--report');
  if (reports >= 0) {
    const samples: AbSample[] = [];
    for (const file of process.argv.slice(reports + 1).filter(value => value.endsWith('.json'))) samples.push(...(JSON.parse(await readFile(file, 'utf8')) as { samples: AbSample[] }).samples);
    console.log(summary(samples));
    if (flag('replies')) for (const row of samples.map(analyze)) console.log(`\n[${row.arm}] ${row.set}#${row.pair} ${row.scenario} 首字 ${row.firstVisibleMs} ms ${row.signs.join(',')}${row.rawMarker !== 'none' ? ` 标记 ${row.rawMarker}/前 ${row.rawBefore}` : ''}\n> ${row.user}\n${row.visible}`);
    return;
  }
  const dry = flag('dry');
  const set = option('set', 'plain') as AbSample['set'];
  if (set !== 'plain' && set !== 'plan') throw new Error('--set 只能是 plain 或 plan');
  const pool = set === 'plan' ? PLAN_SCENARIOS : PLAIN_SCENARIOS;
  const pairs = Math.max(1, Math.min(20, Number(option('pairs', '12')) || 12));
  const offset = Math.max(0, Number(option('offset', '0')) || 0);
  const label = option('label', `${set}${dry ? '-dry' : ''}`);
  // B's marker: 'turn' (the plan's: this turn's code, named in the turn's text) or 'fixed' (one marker, named in the fixed system prompt).
  const mode = option('mode', 'turn') as OpeningMode;
  if (mode !== 'turn' && mode !== 'fixed') throw new Error('--mode 只能是 turn 或 fixed');
  const entries = await ledger();
  const used = entries.filter(entry => !entry.dry).reduce((sum, entry) => sum + entry.requests, 0);
  const planned = pairs * 2;
  console.log(`[reply-opening-ab] ${label}：${pairs} 对 = ${planned} 次请求${dry ? '（假 Claude，不计额度）' : `；这个任务已用 ${used}，上限 ${TASK_CAP}`}`);
  if (!dry && used + planned > TASK_CAP) throw new Error(`会超过上限 ${TASK_CAP}（已用 ${used}，本次 ${planned}），没有开始。`);
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  const gene = genePersona();
  const card = set === 'plan'
    ? { ...gene, relationship: { slowWarmUp: false, dayNumber: 40, togetherDays: 14, memes: EVAL_MEMES } }
    : gene;
  const samples: AbSample[] = [];
  let taken = 0;
  let stopped: string | null = null;
  try {
    for (let pair = 0; pair < pairs; pair++) {
      const scenario = pool[(pair + offset) % pool.length];
      for (const arm of pair % 2 === 0 ? ['A', 'B'] as const : ['B', 'A'] as const) {
        await runEval({
          label: `${label}:${arm}`, model: '', repeat: pair + 1, scenarios: [scenario], binary, ...(binaryArgs ? { binaryArgs } : {}),
          prewarmMs: dry ? 100 : 3000, card, replyOpening: arm === 'B' ? mode : false, textMemorial: () => set === 'plan',
          beforeTurn: () => { if (!dry && used + taken + 1 > TASK_CAP) throw new Error('已到这个任务的请求上限，停止。'); taken++; },
          onTurn: record => {
            const sample: AbSample = { set, arm, pair: pair + 1 + offset, record };
            samples.push(sample);
            const row = analyze(sample);
            console.log(`  [${arm}] ${set}#${pair + 1 + offset} ${scenario.id} 首个可见字 ${row.firstVisibleMs ?? '–'} ms${row.rawMarker !== 'none' ? ` 标记 ${row.rawMarker}/前 ${row.rawBefore}` : ''}`
              + `${row.signs.length ? ` 迹象 ${row.signs.join('/')}` : ''}${record.error ? ` 错误：${record.error}` : ''}\n      ${row.visible.replace(/\s+/gu, ' ').slice(0, 120)}`);
          },
        });
      }
    }
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
    console.log(`[reply-opening-ab] 中止：${stopped}`);
  } finally {
    await mkdir(DIR, { recursive: true });
    entries.push({ at: new Date().toISOString(), label, requests: taken, dry });
    await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8');
    const file = path.join(DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.json`);
    await writeFile(file, JSON.stringify({ kind: 'reply-opening-ab', set, mode, label, commit: commitOf(), dry, stopped, requests: taken, samples }, null, 2), 'utf8');
    console.log(`[reply-opening-ab] 写入 ${path.relative(root, file)}（${samples.length} 条回复，${taken} 次请求）`);
    console.log(summary(samples));
  }
}
// Only when run as a script: importing this module (for analyze/summary) must never start real requests.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exit(1); });
