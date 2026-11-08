// Offline check for docs/claude/2026-11-03-draft-leak-fix.md: every recorded real reply under .local (the evaluation runs,
// synthetic cards only) is replayed through the reply protocol twice, with the Chinese-chat rules on (decided from the
// recorded user message, as the app does) and off (F4 as it was). Lists every reply whose visible text changes and every
// reply whose first visible character comes later. No model calls.
//   node node_modules/tsx/dist/cli.mjs scripts/lib/draft-leak-corpus.ts <dir-or-file>...
// Before and after a change to the filter (docs/claude/2026-11-03-draft-first-char.md), on the recorded chunk timings:
//   ... --save <baseline.json> <dir-or-file>...      replay with the current code and keep what each reply showed, and when
//   ... --against <baseline.json> <dir-or-file>...   replay again and compare: changed replies, and how much later (or
//                                                     earlier) each first visible character is, with the median, p90 and share
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replay, type TurnRecord } from './prompt-eval-analysis';

type Recorded = Pick<TurnRecord, 'chunks' | 'nonce' | 'settingOffered' | 'error' | 'prompt' | 'user'>;

function collect(value: unknown, out: Recorded[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) collect(item, out); return; }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.chunks) && typeof record.nonce === 'string' && typeof record.user === 'string') { out.push(record as unknown as Recorded); return; }
  for (const child of Object.values(record)) collect(child, out);
}

async function files(target: string): Promise<string[]> {
  if (!(await stat(target)).isDirectory()) return target.endsWith('.json') ? [target] : [];
  const out: string[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...await files(full));
    else if (entry.name.endsWith('.json') && !entry.name.includes('ledger')) out.push(full);
  }
  return out;
}

/** Time of the first chunk that put a visible (non-blank) character on screen. */
export const firstVisible = (chunks: Array<[number, string]>): number | null => chunks.find(([, text]) => /\S/u.test(text))?.[0] ?? null;

/** What one recorded reply showed under some version of the filter. */
export interface ReplayOutcome { visible: string; first: number | null; emptied: boolean }
export type Baseline = Record<string, ReplayOutcome>;

/** Nearest-rank quantile (p in 0..1); NaN for no values. */
export function quantile(values: readonly number[], p: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/**
 * Before/after on the same recorded timings: per reply, how much later its first visible character comes now (negative:
 * earlier), over every reply that showed something both times; and the replies whose visible text changed.
 */
export function compareOutcomes(before: Baseline, after: Baseline): {
  compared: number; missing: number; changed: string[]; delays: number[]; affected: number[];
  median: number; p90: number; affectedMedian: number; affectedP90: number; affectedMax: number;
} {
  const delays: number[] = [], changed: string[] = [];
  let missing = 0;
  for (const [key, now] of Object.entries(after)) {
    const old = before[key];
    if (!old) { missing++; continue; }
    if (old.visible !== now.visible || old.emptied !== now.emptied) changed.push(key);
    if (old.first !== null && now.first !== null) delays.push(now.first - old.first);
  }
  const affected = delays.filter(delay => delay !== 0);
  return { compared: delays.length, missing, changed, delays, affected, median: quantile(delays, 0.5), p90: quantile(delays, 0.9),
    affectedMedian: quantile(affected, 0.5), affectedP90: quantile(affected, 0.9), affectedMax: affected.length ? Math.max(...affected) : 0 };
}

const keyOf = (record: Recorded): string => createHash('sha256').update(JSON.stringify(record.chunks.map(([, text]) => text))).digest('hex').slice(0, 24);

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const save = option('save'), against = option('against');
  const targets = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith('--') && !['--save', '--against'].includes(all[index - 1]));
  const records: Recorded[] = [];
  for (const target of targets) for (const file of await files(target)) {
    try { collect(JSON.parse(await readFile(file, 'utf8')), records); } catch { /* Not a run file. */ }
  }
  // The same recorded reply can sit in several files (a report and its raw run): count it once.
  const seen = new Set<string>();
  const unique = records.filter(record => { const key = record.chunks.map(([, text]) => text).join(''); if (seen.has(key)) return false; seen.add(key); return true; });
  if (save || against) {
    const outcomes: Baseline = {};
    const texts: Record<string, string> = {};
    for (const record of unique) {
      const on = replay(record);
      const key = keyOf(record);
      outcomes[key] = { visible: on.visible, first: firstVisible(on.visibleChunks), emptied: on.emptied };
      texts[key] = record.chunks.map(([, text]) => text).join('');
    }
    if (save) { await writeFile(save, JSON.stringify(outcomes)); console.log(`${unique.length} 条回复已存到 ${save}`); }
    if (against) {
      const before = JSON.parse(await readFile(against, 'utf8')) as Baseline;
      const result = compareOutcomes(before, outcomes);
      for (const key of result.changed) console.log(`CHANGED raw=${JSON.stringify(texts[key].slice(0, 80))}\n   before: ${JSON.stringify(before[key].visible.slice(0, 80))}${before[key].emptied ? ' (emptied)' : ''}\n   now:    ${JSON.stringify(outcomes[key].visible.slice(0, 80))}${outcomes[key].emptied ? ' (emptied)' : ''}`);
      for (const [key, now] of Object.entries(outcomes)) {
        const old = before[key];
        if (old && old.first !== null && now.first !== null && now.first !== old.first) console.log(`FIRST ${now.first - old.first > 0 ? '+' : ''}${now.first - old.first} ms: ${JSON.stringify(now.visible.slice(0, 40))}`);
      }
      console.log(`\n${unique.length} 条回复，${result.compared} 条两次都有可见字（基线里没有的 ${result.missing} 条）；可见文字或"整条被清空"变了 ${result.changed.length} 条`);
      console.log(`首个可见字：中位差 ${result.median} ms，p90 差 ${result.p90} ms；受影响 ${result.affected.length} 条（${(100 * result.affected.length / Math.max(1, result.compared)).toFixed(1)}%），其中中位 ${result.affectedMedian} ms、p90 ${result.affectedP90} ms、最大 ${result.affectedMax} ms`);
    }
    return;
  }
  let chinese = 0, changed = 0, later = 0;
  const delays: number[] = [];
  for (const record of unique) {
    const on = replay(record), off = replay({ ...record, user: undefined });
    if (/[㐀-鿿]/u.test(record.user ?? '')) chinese++;
    const a = firstVisible(off.visibleChunks), b = firstVisible(on.visibleChunks);
    if (on.visible !== off.visible) {
      changed++;
      console.log(`CHANGED (${on.drops.map(drop => drop.kind).join(',')}) user=${JSON.stringify((record.user ?? '').slice(0, 30))}\n   off: ${JSON.stringify(off.visible.slice(0, 140))}\n   on:  ${JSON.stringify(on.visible.slice(0, 140))}`);
    } else if (a !== null && b !== null && b > a) {
      later++; delays.push(b - a);
      console.log(`LATER +${b - a} ms: ${JSON.stringify(on.visible.slice(0, 60))}`);
    }
  }
  console.log(`\n${unique.length} 条不同的真实回复（中文聊天 ${chinese} 条）；可见文字变了 ${changed} 条；文字没变但第一个可见字更晚 ${later} 条${delays.length ? `（${delays.join('、')} ms）` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main().catch(error => { console.error(error); process.exitCode = 1; });
