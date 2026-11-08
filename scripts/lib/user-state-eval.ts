// "读懂你的情绪" evaluation helpers (docs/claude/2026-11-02-user-state.md). Does not touch
// scripts/prompt-eval.ts: it launches it for the first-character A/B and reads the JSON it writes.
//
//   node node_modules/tsx/dist/cli.mjs scripts/lib/user-state-eval.ts ab --label name [--scenarios multi] [--turns 4] [--repeat 2] [--cap 60] [--models default]
//        interleaved A/B of the per-turn sentence USER_STATE_INSTRUCTION (without, then with, in one time window)
//   node node_modules/tsx/dist/cli.mjs scripts/lib/user-state-eval.ts report a.json [b.json ...] [--out report.md]
//        first-character / first-sentence numbers per label, and per turn: the user's message, the judgment in the tail, the first sentence of the reply
//
// Real calls are counted by the same ledger as the R28 harness (.local/prompt-eval/ledger.json); pass --cap to bound them.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MoodReplyProtocol } from '../../electron/mood-chat';
import { analyzeTurn, type TurnRecord } from './prompt-eval-analysis';
import { USER_STATE_INSTRUCTION } from '../../shared/user-state';

const root = path.resolve(import.meta.dirname, '..', '..');

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Mann–Whitney U, two-sided: exact by enumeration for small samples, normal approximation (tie-corrected) otherwise. */
export function mannWhitney(a: readonly number[], b: readonly number[]): { u: number; p: number; exact: boolean } {
  const n = a.length, m = b.length;
  if (!n || !m) return { u: NaN, p: NaN, exact: false };
  const all = [...a.map(value => ({ value, group: 0 })), ...b.map(value => ({ value, group: 1 }))].sort((x, y) => x.value - y.value);
  const ranks = new Array<number>(all.length);
  const ties: number[] = [];
  for (let i = 0; i < all.length;) {
    let j = i; while (j + 1 < all.length && all[j + 1].value === all[i].value) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    if (j > i) ties.push(j - i + 1);
    i = j + 1;
  }
  const r1 = all.reduce((sum, item, index) => sum + (item.group === 0 ? ranks[index] : 0), 0);
  const u1 = r1 - n * (n + 1) / 2, mean = n * m / 2;
  if (n + m <= 20) {
    // Exact: how many splits of the pooled ranks give a rank sum at least as far from the mean as observed.
    const total = n + m; let extreme = 0, count = 0;
    const walk = (start: number, picked: number, sum: number) => {
      if (picked === n) { count++; if (Math.abs(sum - n * (n + 1) / 2 - mean) >= Math.abs(u1 - mean) - 1e-9) extreme++; return; }
      for (let i = start; i <= total - (n - picked); i++) walk(i + 1, picked + 1, sum + ranks[i]);
    };
    walk(0, 0, 0);
    return { u: u1, p: extreme / count, exact: true };
  }
  const tieTerm = ties.reduce((sum, t) => sum + (t ** 3 - t), 0);
  const variance = n * m / 12 * ((n + m + 1) - tieTerm / ((n + m) * (n + m - 1)));
  const z = (Math.abs(u1 - mean) - 0.5) / Math.sqrt(variance);
  const erfc = (x: number) => { const t = 1 / (1 + 0.3275911 * x); return t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x); };
  return { u: u1, p: Math.min(1, erfc(z / Math.SQRT2)), exact: false };
}

export interface RawUserField { present: boolean; raw: unknown }
/** The tail's `user` field as the model wrote it (even when the app would drop it), plus what the app accepts. */
export function readUserField(record: Pick<TurnRecord, 'chunks' | 'nonce' | 'settingOffered' | 'error'>) {
  const protocol = new MoodReplyProtocol(() => {}, { settingProposal: { instruction: record.settingOffered ? (start, end) => `${start}${end}` : null } });
  const fresh = /^<sh-state-([a-f0-9]{32})>$/u.exec(protocol.start)![1];
  const joined = record.chunks.map(([, text]) => text).join('').split(record.nonce).join(fresh);
  protocol.push(joined);
  const appraisal = protocol.finish(!record.error);
  const start = protocol.start, end = protocol.end;
  const at = joined.indexOf(start), close = at < 0 ? -1 : joined.indexOf(end, at);
  let rawField: RawUserField = { present: false, raw: undefined };
  if (at >= 0 && close > at) {
    try { const tail = JSON.parse(joined.slice(at + start.length, close)); if (tail && typeof tail === 'object' && 'user' in tail) rawField = { present: true, raw: tail.user }; } catch { /* Not JSON. */ }
  }
  return { appraisal, accepted: protocol.userState(), rawField };
}

// Wording that announces the judgment like an instrument reading. "我感觉到你很累" is natural and is not matched.
const ANNOUNCES = /(?:检测|识别|分析|判断|监测|察觉)(?:到|出)了?(?:你|用户)|根据你的(?:情绪|状态|语气)|你(?:当前|现在)?(?:的)?(?:情绪|状态)(?:是|为|属于)|处于.{0,4}(?:低落|疲惫|疲劳|烦躁)(?:状态|情绪)|用户(?:此刻|当前)?(?:状态|情绪)|把握\s*0\.\d|\bconfidence\b|tired|annoyed|excited\b/iu;

export interface JudgmentRow {
  label: string; scenario: string; turn: number; user: string; firstSentence: string;
  raw: unknown; accepted: string; announces: boolean;
}

function fmtMs(value: number | null): string { return value === null ? '–' : String(Math.round(value)); }

export function report(records: readonly TurnRecord[]): string {
  const lines: string[] = [];
  const labels = [...new Set(records.map(record => record.label))];
  lines.push('## 首字与首句（毫秒）', '', '| 标签 | 轮数 | 首字中位 | 首字 p90 | 首句完成中位 | 首句完成 p90 | 输出 token 中位 | 输入 token 中位 | 尾注状态 |', '|---|---|---|---|---|---|---|---|---|');
  const firstChars = new Map<string, number[]>(), firstSentences = new Map<string, number[]>();
  for (const label of labels) {
    const rows = records.filter(record => record.label === label && !record.error);
    const metrics = rows.map(record => analyzeTurn(record));
    const firsts = rows.map(record => record.chunks[0]?.[0]).filter((value): value is number => typeof value === 'number');
    const sentences = metrics.map(metric => metric.firstSentenceMs).filter((value): value is number => typeof value === 'number');
    firstChars.set(label, firsts); firstSentences.set(label, sentences);
    const out = rows.map(record => record.usage?.outputTokens).filter((value): value is number => typeof value === 'number');
    const input = rows.map(record => record.usage ? record.usage.inputTokens + record.usage.cacheReadTokens + record.usage.cacheCreationTokens : NaN).filter(Number.isFinite);
    const tails = metrics.reduce((acc, metric) => { acc[metric.tail] = (acc[metric.tail] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    lines.push(`| ${label} | ${rows.length} | ${fmtMs(median(firsts))} | ${fmtMs(percentile(firsts, 0.9))} | ${fmtMs(median(sentences))} | ${fmtMs(percentile(sentences, 0.9))} | ${fmtMs(median(out))} | ${fmtMs(median(input))} | ${Object.entries(tails).map(([k, v]) => `${k}×${v}`).join(' ')} |`);
  }
  const without = labels.find(label => label.endsWith('-without')), withLabel = labels.find(label => label.endsWith('-with'));
  if (without && withLabel) {
    for (const [name, data] of [['首字', firstChars], ['首句完成', firstSentences]] as const) {
      const a = data.get(without) ?? [], b = data.get(withLabel) ?? [];
      const ma = median(a), mb = median(b), test = mannWhitney(a, b);
      lines.push('', `**${name}**：不带这句 ${a.length} 轮中位 ${fmtMs(ma)} ms，带这句 ${b.length} 轮中位 ${fmtMs(mb)} ms；差 ${ma !== null && mb !== null ? `${Math.round(mb - ma)} ms（${(((mb - ma) / ma) * 100).toFixed(0)}%）` : '–'}；`
        + `Mann–Whitney 双侧 p=${test.p.toFixed(3)}（${test.exact ? '精确' : '近似'}）。不带：[${a.map(Math.round).sort((x, y) => x - y).join(', ')}]；带：[${b.map(Math.round).sort((x, y) => x - y).join(', ')}]`);
    }
  }
  if (without && withLabel) {
    // New-conversation first turns carry most of the noise (process start), so show them apart from the warm turns.
    const part = (label: string, pick: (turn: number) => boolean) => records.filter(record => record.label === label && !record.error && pick(record.turn))
      .map(record => record.chunks[0]?.[0]).filter((value): value is number => typeof value === 'number');
    lines.push('', '| 首字（毫秒） | 不带这句（中位 / 各轮） | 带这句（中位 / 各轮） | 差 |', '|---|---|---|---|');
    for (const [name, pick] of [['第 1 轮（新对话）', (turn: number) => turn === 1], ['第 2 轮及以后（常驻进程）', (turn: number) => turn >= 2]] as const) {
      const a = part(without, pick), b = part(withLabel, pick), ma = median(a), mb = median(b);
      lines.push(`| ${name} | ${fmtMs(ma)} / [${a.map(Math.round).sort((x, y) => x - y).join(', ')}] | ${fmtMs(mb)} / [${b.map(Math.round).sort((x, y) => x - y).join(', ')}] | ${ma !== null && mb !== null ? `${Math.round(mb - ma)}（${(((mb - ma) / ma) * 100).toFixed(0)}%）` : '–'} |`);
    }
  }
  const rows: JudgmentRow[] = [];
  for (const record of records) {
    if (record.error) continue;
    const { rawField, accepted } = readUserField(record);
    const metrics = analyzeTurn(record);
    rows.push({ label: record.label, scenario: record.scenario, turn: record.turn, user: record.user, firstSentence: metrics.firstSentence,
      raw: rawField.present ? rawField.raw : '（没写）', accepted: accepted ? `${accepted.state} ${accepted.confidence}` : '–',
      announces: ANNOUNCES.test(record.liveVisible) });
  }
  const judged = rows.filter(row => row.raw !== '（没写）');
  lines.push('', '## 尾注里的判断', '', `${judged.length}/${rows.length} 轮写了 user 字段；被程序接受 ${rows.filter(row => row.accepted !== '–').length} 轮；回复里像在播报判断的 ${rows.filter(row => row.announces).length} 轮。`, '',
    '| 标签 | 场景#轮 | 用户说 | 模型写的 user | 程序接受 | 首句 | 播报判断 |', '|---|---|---|---|---|---|---|');
  for (const row of rows) lines.push(`| ${row.label} | ${row.scenario}#${row.turn} | ${row.user.slice(0, 40).replace(/\|/g, '/')} | ${typeof row.raw === 'string' ? row.raw : JSON.stringify(row.raw)} | ${row.accepted} | ${row.firstSentence.slice(0, 40).replace(/\|/g, '/')} | ${row.announces ? '是' : '否'} |`);
  const replies = records.filter(record => !record.error && ANNOUNCES.test(record.liveVisible));
  if (replies.length) lines.push('', '## 疑似播报的回复全文', '', ...replies.map(record => `- ${record.label} ${record.scenario}#${record.turn}：${record.liveVisible.replace(/\n/g, ' ')}`));
  return lines.join('\n');
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name: string, fallback = '') => { const index = rest.indexOf(`--${name}`); return index >= 0 ? rest[index + 1] ?? fallback : fallback; };
  if (command === 'ab') {
    const args = [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'scripts', 'prompt-eval.ts'),
      '--models', option('models', 'default'), '--label', option('label', 'user-state-ab'), '--scenarios', option('scenarios', 'multi'),
      '--turns', option('turns', '4'), '--repeat', option('repeat', '2'), '--cap', option('cap', '60'), '--ab-strip', USER_STATE_INSTRUCTION];
    if (rest.includes('--dry')) args.push('--dry');
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
    return;
  }
  if (command === 'report') {
    const files = rest.filter(value => value.endsWith('.json'));
    const records: TurnRecord[] = [];
    for (const file of files) records.push(...(JSON.parse(await readFile(file, 'utf8')).records as TurnRecord[]));
    const text = report(records);
    console.log(text);
    const out = option('out');
    if (out) await writeFile(out, text + '\n', 'utf8');
    return;
  }
  console.error('usage: user-state-eval.ts ab|report ...');
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
