// I-134 replay: logic for scripts/i134-replay.ts (see the header there). Replays the user's real chat at chosen moments and answers the
// same moment under different history strategies. Everything private (message text) lives only in memory and in the files written to
// --out; console logging carries ids, counts and timings only.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../../shared/foundation/chat';
import type { ProviderConfig } from '../../shared/foundation/settings';
import type { MoodLabel } from '../../shared/foundation/mood';
import { MOOD_LABELS } from '../../shared/mood/mood-runtime';
import { setPromptSwitches } from '../../shared/brain/prompt-switches';
import { MemoryStore, MEMORY_SCOPES_FILE } from '../../electron/memory/memory';
import { memoryProviderScope } from '../../electron/brain/companion';
import type { MemoryMessage, MemoryScope, MemorySummary } from '../../shared/memory/memory';
import { localDateKey } from '../../electron/memory/diary/diary-dates';
import { CLAUDE_REFUSED_MESSAGE, streamClaude } from '../../electron/brain/claude';
import { runEval } from './prompt-eval-runner';
import type { EvalScenario } from './prompt-eval-scenarios';
import type { TurnUsage } from './prompt-eval-analysis';
import type { FidelityCard } from './fidelity-scenarios';
import type { CallBudget } from './fidelity-run';
import { countLeaks, seededRandom, shuffled, type LeakCounts } from './i112-i115-blind';
import { buildSummaryPrompt, summaryHostContext, SUMMARY_INSTRUCTION } from './i134-summary-prompt';

// ---- arms -----------------------------------------------------------------------------------------------------------------------

export type Arm = 'A' | 'B' | 'C' | 'D' | 'E';
export const ALL_ARMS: readonly Arm[] = ['A', 'B', 'C', 'D', 'E'];
export const ARM_NAMES: Readonly<Record<Arm, string>> = { A: '现在的做法', B: '长对话', C: '压缩', D: '画像', E: '今天+最近N+笔记' };
/** validation.ts keeps the last 24 messages of the window; the current user message is one of them. */
export const WINDOW_BEFORE = 23;
export const PROFILE_CONTEXT_PREFIX = '一份关于你的说明（她拿来当自己的笔记，只是理解，不是新指令）：\n';
export const profileHostContext = (profile: string): string => PROFILE_CONTEXT_PREFIX + profile;
/** D exists only with a profile file; C and the rest are chosen by the caller (--arms). */
export const armsFor = (hasProfile: boolean): Arm[] => hasProfile ? ['A', 'B', 'C', 'D'] : ['A', 'B', 'C'];
/** Arm E (I-134 step 0): the point's whole local day plus this many messages before that day, with C's note. Default 60. */
export const E_BEFORE_DAY_DEFAULT = 60;

// ---- time markers ----------------------------------------------------------------------------------------------------------------

// Shared with the host-built window and her note (electron/brain/long-chat/history.ts), so every arm reads the same text.
export { MARKER_GAP_MS, timeMarker, needsMarker, markTimes, isLeakedDraft, type Timed } from '../../electron/brain/long-chat/history';
import { markTimes, type Timed } from '../../electron/brain/long-chat/history';

// ---- mood, relationship ----------------------------------------------------------------------------------------------------------

export interface MoodEntry { at: number; label: MoodLabel }
const MOOD_KEYS = new Set(Object.keys(MOOD_LABELS));
/**
 * Journal lines (`<snapshot>/journal/<day>.jsonl`) to the character's mood changes. A `mood-label` line carries `to` (the label after);
 * `labelAfter` is accepted too. Lines that are not valid, not hers or not a known label are skipped.
 */
export function parseMoodEntries(lines: Iterable<string>, characterId: string): MoodEntry[] {
  const entries: MoodEntry[] = [];
  for (const line of lines) {
    if (!line.includes('"mood-label"')) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (entry.type !== 'mood-label' || entry.characterId !== characterId) continue;
    const label = entry.labelAfter ?? entry.to;
    const at = typeof entry.at === 'number' ? entry.at : Date.parse(String(entry.time ?? ''));
    if (typeof label === 'string' && MOOD_KEYS.has(label) && Number.isFinite(at)) entries.push({ at, label: label as MoodLabel });
  }
  return entries.sort((a, b) => a.at - b.at);
}
/** The last mood label at or before `at`; null before the first record. */
export function moodAt(entries: readonly MoodEntry[], at: number): MoodLabel | null {
  let found: MoodLabel | null = null;
  for (const entry of entries) { if (entry.at <= at) found = entry.label; else break; }
  return found;
}

const dayIndex = (key: string) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y!, m! - 1, d!) / 86_400_000; };
/** Local days from the first message to the point; the first day is 1. */
export const dayNumberAt = (firstAt: number, at: number): number => Math.round(dayIndex(localDateKey(at)) - dayIndex(localDateKey(firstAt))) + 1;
/** Distinct local days (other than the point's own) with a message before the point. */
export function togetherDaysBefore(messages: readonly Timed[], index: number): number {
  const today = localDateKey(messages[index]!.createdAt);
  return new Set(messages.slice(0, index).map(message => localDateKey(message.createdAt)).filter(day => day !== today)).size;
}

// ---- points, arm inputs -----------------------------------------------------------------------------------------------------------

export interface PointSpec { id: string; at: number }
export function parsePoints(raw: string): PointSpec[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('--points 文件不是合法的 JSON。'); }
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('--points：最外层要是非空数组 [{"id":"p01","at":毫秒时间}]。');
  const seen = new Set<string>();
  return parsed.map((item: unknown) => {
    const { id, at } = (item ?? {}) as { id?: unknown; at?: unknown };
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(id)) throw new Error('--points：每个点要有 id（字母数字、下划线、短横线，最长 32）。');
    if (seen.has(id)) throw new Error(`--points：id「${id}」重复。`);
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) throw new Error(`--points：「${id}」的 at 要是毫秒时间（整数）。`);
    seen.add(id);
    return { id, at };
  });
}
/** The index of the user message with exactly this createdAt; throws clearly when there is none. */
export function locatePoint(messages: readonly Timed[], point: PointSpec): number {
  const index = messages.findIndex(message => message.role === 'user' && message.createdAt === point.at);
  if (index < 0) throw new Error(`点 ${point.id}：在聊天里找不到 createdAt=${point.at} 的用户消息。`);
  return index;
}

/** History and current message for one arm (marked text). A, C and D see the last 23 before the point; B sees everything before it. */
export function armInputs(arm: Arm, marked: readonly Timed[], index: number, eBeforeDay = E_BEFORE_DAY_DEFAULT): { history: ChatMessage[]; user: string } {
  if (arm === 'E') {
    const dayStart = dayStartMs(localDateKey(marked[index]!.createdAt));
    let first = index;
    while (first > 0 && marked[first - 1]!.createdAt >= dayStart) first--;
    const from = Math.max(0, first - Math.max(0, eBeforeDay));
    return { history: marked.slice(from, index).map(message => ({ role: message.role, content: message.content })), user: marked[index]!.content };
  }
  const from = arm === 'B' ? 0 : Math.max(0, index - WINDOW_BEFORE);
  return { history: marked.slice(from, index).map(message => ({ role: message.role, content: message.content })), user: marked[index]!.content };
}
/** The next real user message after the point (for the latency turn), marked; null when there is none. */
export function nextUserMessage(marked: readonly Timed[], index: number): string | null {
  for (let i = index + 1; i < marked.length; i++) if (marked[i]!.role === 'user') return marked[i]!.content;
  return null;
}
export interface SheetContextItem { role: 'user' | 'assistant'; text: string }
const clip = (text: string, max: number) => { const chars = Array.from(text); return chars.length > max ? chars.slice(0, max).join('') + '…' : text; };
/** The last 4 messages before the point for the sheet, at most 200 characters each. */
export const sheetContext = (marked: readonly Timed[], index: number): SheetContextItem[] =>
  marked.slice(Math.max(0, index - 4), index).map(message => ({ role: message.role, text: clip(message.content, 200) }));

// ---- seeding the temp archive (arms A, C, D) --------------------------------------------------------------------------------------

/** Same hash as electron/memory/memory.ts scopeKey (not exported there). */
export const scopeKeyOf = (scope: MemoryScope): string => createHash('sha256').update(JSON.stringify([scope.characterId, scope.providerScope])).digest('hex');

export interface CachedRecord { summary: MemorySummary; messages: MemoryMessage[] }
/**
 * Every record of the scope with its complete messages (read one message at a time so long texts are paged whole).
 * Weights come later, per point, from `store.list(..., now = point)`.
 */
export function loadCachedRecords(store: MemoryStore, scope: MemoryScope): CachedRecord[] {
  const summaries: MemorySummary[] = [];
  for (let offset = 0; ; offset += 50) {
    const page = store.list(scope, { offset, limit: 50 });
    summaries.push(...page.records);
    if (offset + 50 >= page.total) break;
  }
  return summaries.map(summary => {
    const messages: MemoryMessage[] = [];
    for (let index = 0; index < summary.messageCount; index++) {
      let content = '', offset = 0, meta: MemoryMessage | null = null;
      for (let guard = 0; guard < 1000; guard++) {
        const message = store.read(scope, summary.id, { messageOffset: index, messageLimit: 1, textOffset: offset, textLimit: 4000 })?.messages[0];
        if (!message) break;
        const { contentOffset: _a, totalCharacters: _b, nextTextOffset, ...rest } = message;
        meta = rest; content += message.content;
        if (nextTextOffset === undefined) break;
        offset = nextTextOffset;
      }
      if (meta) messages.push({ ...meta, content });
    }
    return { summary, messages };
  });
}

/** Weights of every record as they stand at `at` (decayed to the point's time). */
export function weightsAt(store: MemoryStore, scope: MemoryScope, at: number): Map<string, number> {
  const weights = new Map<string, number>();
  for (let offset = 0; ; offset += 50) {
    const page = store.list(scope, { offset, limit: 50 }, at);
    for (const record of page.records) weights.set(record.id, record.weight);
    if (offset + 50 >= page.total) break;
  }
  return weights;
}

/**
 * The archive as it stood just before `at`: records created before it, with only the messages created strictly before it (a record cut in
 * the middle keeps its earlier turns), shaped for MemoryStore.restoreRecords under the target scope. Weights are the decayed weights at `at`;
 * mentions are not carried (the summary API does not expose them), so reinforcement history is lost rather than leaked. Records come back
 * sealed (restoreRecords seals them), in one conversation id.
 */
export function buildSeedRecords(cache: readonly CachedRecord[], weights: ReadonlyMap<string, number>, at: number, targetScopeKey: string): unknown[] {
  const out: unknown[] = [];
  for (const { summary, messages } of cache) {
    if (summary.createdAt >= at) continue;
    const kept = messages.filter(message => message.createdAt < at);
    if (!kept.length) continue;
    const updatedAt = summary.origin ? summary.updatedAt : Math.min(at, Math.max(...kept.map(message => message.updatedAt)));
    out.push({
      id: summary.id, scopeKey: targetScopeKey, conversationId: 'default', title: summary.title, tags: [...summary.tags], category: summary.category,
      manual: { title: false, tags: false, category: false }, createdAt: summary.createdAt, updatedAt, lastFinishedAt: updatedAt,
      weight: weights.get(summary.id) ?? summary.weight, weightAt: at, mentions: [], messages: kept.map(message => ({ ...message })), sealed: true,
      ...(summary.continuationOf ? { continuationOf: summary.continuationOf } : {}), ...(summary.origin ? { origin: summary.origin } : {}),
    });
  }
  return out;
}

// ---- snapshot ------------------------------------------------------------------------------------------------------------------

export interface Snapshot {
  store: MemoryStore;
  scope: MemoryScope;
  /** Every ordinary chat message, oldest first. */
  messages: Timed[];
  moods: MoodEntry[];
  cache: CachedRecord[];
  /** How many replies --drop-messages removed. */
  dropped: number;
  close(): Promise<void>;
}

export interface SnapshotOptions {
  characterId?: string; providerScope?: string;
  /**
   * createdAt values of her replies that leaked a draft or internal tag when they were written (--drop-messages). Only assistant messages
   * with these times go (an assistant message's createdAt is when its first text arrived, so the user's message of the turn stays). They leave the history of every
   * arm, the summaries' input and the seeded records alike; a record left empty is dropped.
   */
  dropAssistantAt?: ReadonlySet<number>;
}
/** The --drop-messages file: a JSON array of createdAt milliseconds. */
export function parseDropList(raw: string): Set<number> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('--drop-messages 文件不是合法的 JSON。'); }
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'number' && Number.isSafeInteger(item) && item > 0)) throw new Error('--drop-messages：要是 createdAt 毫秒数组。');
  return new Set(parsed as number[]);
}
/** Removes the dropped replies from the messages and the cached records; returns how many messages went. */
export function applyDrops(messages: Timed[], cache: CachedRecord[], drop: ReadonlySet<number>): { messages: Timed[]; cache: CachedRecord[]; dropped: number } {
  if (!drop.size) return { messages, cache, dropped: 0 };
  const gone = (message: { role: string; createdAt: number }) => message.role === 'assistant' && drop.has(message.createdAt);
  const kept = messages.filter(message => !gone(message));
  const records = cache.map(record => ({ summary: record.summary, messages: record.messages.filter(message => !gone(message)) })).filter(record => record.messages.length > 0);
  return { messages: kept, cache: records, dropped: messages.length - kept.length };
}
/**
 * Loads a read-only snapshot folder. MemoryStore.load can write (closing interrupted replies, setting aside a bad scopes file), so the
 * two files it needs are copied into a scratch folder first and the snapshot itself is only ever read.
 */
export async function loadSnapshot(directory: string, options: SnapshotOptions = {}): Promise<Snapshot> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-i134-snapshot-'));
  try {
    await copyFile(path.join(directory, 'memories.jsonl'), path.join(scratch, 'memories.jsonl'));
    await copyFile(path.join(directory, MEMORY_SCOPES_FILE), path.join(scratch, MEMORY_SCOPES_FILE)).catch(() => {});
    const store = new MemoryStore(scratch);
    await store.load();
    let scopes: MemoryScope[] = [];
    try {
      const raw = JSON.parse(await readFile(path.join(scratch, MEMORY_SCOPES_FILE), 'utf8')) as { scopes?: MemoryScope[] };
      scopes = (raw.scopes ?? []).filter(item => typeof item?.characterId === 'string' && typeof item?.providerScope === 'string');
    } catch { /* No scopes file: the character and scope must be given. */ }
    if (options.characterId && options.providerScope) scopes = [{ characterId: options.characterId, providerScope: options.providerScope }];
    else scopes = scopes.filter(item => (!options.characterId || item.characterId === options.characterId) && (!options.providerScope || item.providerScope === options.providerScope));
    if (!scopes.length) throw new Error('快照里找不到符合条件的角色/连接（memory-scopes.json 为空或 --character / --provider-scope 对不上）。');
    const counted = scopes.map(scope => ({ scope, messages: store.conversationMessages(scope, 0, Number.MAX_SAFE_INTEGER) }));
    counted.sort((a, b) => b.messages.length - a.messages.length);
    const best = counted[0]!;
    if (!best.messages.length) throw new Error('快照里这个角色没有聊天消息。');
    const lines: string[] = [];
    const journal = path.join(directory, 'journal');
    for (const name of (await readdir(journal).catch(() => [] as string[])).filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(file)).sort())
      lines.push(...(await readFile(path.join(journal, name), 'utf8')).split('\n'));
    const trimmed = applyDrops(best.messages.map(message => ({ role: message.role, content: message.content, createdAt: message.createdAt })), loadCachedRecords(store, best.scope), options.dropAssistantAt ?? new Set());
    return {
      store, scope: best.scope, messages: trimmed.messages, dropped: trimmed.dropped,
      moods: parseMoodEntries(lines, best.scope.characterId), cache: trimmed.cache,
      close: () => rm(scratch, { recursive: true, force: true }).catch(() => {}),
    };
  } catch (error) { await rm(scratch, { recursive: true, force: true }).catch(() => {}); throw error; }
}

// ---- paths ----------------------------------------------------------------------------------------------------------------------

/** A path inside an AppData folder whose name starts with soft-hearts / soft hearts (the app's profile folders), either slash style, any case. */
export function isProfilePath(target: string, appData: string | undefined = process.env.APPDATA): boolean {
  const normal = (value: string) => path.resolve(value).replace(/\\/gu, '/').toLowerCase();
  const full = normal(target);
  if (/\/appdata\/(?:roaming|local|locallow)\/soft[- ]hearts[^/]*(?:\/|$)/u.test(full + '/')) return true;
  if (appData) { const base = normal(appData); if (new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '/soft[- ]hearts[^/]*(?:/|$)', 'u').test(full + '/')) return true; }
  return false;
}
export function assertNotProfilePath(label: string, target: string): void {
  if (isProfilePath(target)) throw new Error(`${label} 不能放在 soft hearts 的配置文件夹里。`);
}

// ---- replies, stats -------------------------------------------------------------------------------------------------------------

export interface ReplayReply {
  point: string; arm: Arm; turn: 1 | 2; text: string; chars: number; leaks: LeakCounts; error: string | null;
  firstCharMs: number | null; endMs: number | null; dispatchMs: number | null; usage: TurnUsage | null; promptChars: number | null;
}
export const replyKey = (point: string, arm: Arm, turn: number) => `${point}#${arm}#${turn}`;
/** Claude refused the turn (stop_reason refusal or the usage-policy notice): an outcome to count, not a broken run. */
export const isRefused = (reply: Pick<ReplayReply, 'error'>) => reply.error === CLAUDE_REFUSED_MESSAGE;
/** A reply worth keeping on --resume: no error and at least a short sentence; a refusal is kept as an outcome unless --retry-refused. */
export const keepOnResume = (reply: ReplayReply, retryRefused = false) => (!reply.error && reply.chars >= 10) || (!retryRefused && isRefused(reply));

export interface ArmStats {
  replies: number; errors: number; refused: number; leakReplies: number; avgChars: number; avgQuestionMarks: number;
  medianFirstCharMs: number | null; p90FirstCharMs: number | null; avgInputTokens: number; avgCacheReadTokens: number; avgCacheCreationTokens: number;
}
const mean = (values: readonly number[]) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : 0;
const percentile = (values: readonly number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
};
const hasLeak = (leaks: LeakCounts) => leaks.labels + leaks.english + leaks.digits + leaks.brackets > 0;
export function armStats(replies: readonly ReplayReply[], arm: Arm, turn: 1 | 2 = 1): ArmStats {
  const mine = replies.filter(reply => reply.arm === arm && reply.turn === turn);
  const good = mine.filter(reply => !reply.error);
  const first = good.map(reply => reply.firstCharMs).filter((value): value is number => value !== null);
  const usage = good.map(reply => reply.usage).filter((value): value is TurnUsage => value !== null);
  return {
    replies: good.length, errors: mine.length - good.length, refused: mine.filter(isRefused).length, leakReplies: good.filter(reply => hasLeak(reply.leaks)).length,
    avgChars: mean(good.map(reply => reply.chars)), avgQuestionMarks: mean(good.map(reply => (reply.text.match(/[？?]/gu) ?? []).length)),
    medianFirstCharMs: percentile(first, 0.5), p90FirstCharMs: percentile(first, 0.9),
    avgInputTokens: mean(usage.map(item => item.inputTokens)), avgCacheReadTokens: mean(usage.map(item => item.cacheReadTokens)),
    avgCacheCreationTokens: mean(usage.map(item => item.cacheCreationTokens)),
  };
}
export function summaryMarkdown(replies: readonly ReplayReply[], arms: readonly Arm[], notes: readonly string[] = []): string {
  const lines = ['# I-134 replay summary', '', ...notes, ''];
  const rows = (turn: 1 | 2) => arms.map(arm => [arm, armStats(replies, arm, turn)] as const).filter(([, s]) => s.replies + s.errors > 0);
  const table = (turn: 1 | 2) => {
    const out = ['| arm | replies | errors | refused | leak replies | avg chars | avg ？ | median first char ms | p90 first char ms | avg input | avg cache read | avg cache creation |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
    for (const [arm, s] of rows(turn)) out.push(`| ${arm} ${ARM_NAMES[arm]} | ${s.replies} | ${s.errors} | ${s.refused} | ${s.leakReplies} | ${s.avgChars} | ${s.avgQuestionMarks} | ${s.medianFirstCharMs ?? '-'} | ${s.p90FirstCharMs ?? '-'} | ${s.avgInputTokens} | ${s.avgCacheReadTokens} | ${s.avgCacheCreationTokens} |`);
    return out;
  };
  lines.push('## Turn 1 (the replayed moment)', '', ...table(1));
  if (rows(2).length) lines.push('', '## Turn 2 (latency turn, next real user message)', '', ...table(2));
  return lines.join('\n') + '\n';
}

// ---- sheet, key, tally ----------------------------------------------------------------------------------------------------------

export interface SheetPoint { id: string; context: SheetContextItem[]; user: string }
export interface SheetItem { page: string; context: SheetContextItem[]; user: string; options: { slot: string; text: string }[] }
export interface ReplayKey { seed: number; pages: { page: string; slots: Record<string, Arm> }[] }
const SLOTS = ['A', 'B', 'C', 'D'];
/** One page per point that has at least two good turn-1 replies: arms in shuffled slots. The sheet never names an arm; the key does. */
export function buildSheet(replies: readonly ReplayReply[], points: readonly SheetPoint[], seed: number): { items: SheetItem[]; key: ReplayKey } {
  const random = seededRandom(seed);
  const items: SheetItem[] = [], key: ReplayKey = { seed, pages: [] };
  for (const point of points) {
    const mine = replies.filter(reply => reply.point === point.id && reply.turn === 1 && !reply.error && reply.text.trim());
    if (mine.length < 2) continue;
    const mixed = shuffled(mine, random);
    items.push({ page: point.id, context: point.context, user: point.user, options: mixed.map((reply, i) => ({ slot: SLOTS[i]!, text: reply.text })) });
    key.pages.push({ page: point.id, slots: Object.fromEntries(mixed.map((reply, i) => [SLOTS[i]!, reply.arm])) });
  }
  return { items, key };
}
export type Picks = Record<string, string>;
export interface Tally { answered: number; pages: number; wins: Record<string, number>; arms: Arm[] }
export function tallyPicks(picks: Picks, key: ReplayKey): Tally {
  const wins: Record<string, number> = {};
  let answered = 0;
  for (const page of key.pages) {
    const arm = page.slots[picks[page.page] ?? ''];
    if (!arm) continue;
    answered++; wins[arm] = (wins[arm] ?? 0) + 1;
  }
  const arms = ALL_ARMS.filter(arm => key.pages.some(page => Object.values(page.slots).includes(arm)));
  return { answered, pages: key.pages.length, wins, arms };
}
export const formatTally = (tally: Tally): string[] => [`共 ${tally.pages} 页，已选 ${tally.answered} 页`,
  ...tally.arms.map(arm => `  ${arm}（${ARM_NAMES[arm]}）：${tally.wins[arm] ?? 0}`)];

export function sheetHtml(items: readonly SheetItem[]): string {
  const data = JSON.stringify(items).replace(/</gu, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>哪一条最像她</title>
<style>:root{--bg:#faf7f5;--fg:#2a2523;--card:#fff;--line:#e3dad5;--accent:#c4577a}@media(prefers-color-scheme:dark){:root{--bg:#1d1a19;--fg:#ece6e3;--card:#292524;--line:#403836;--accent:#e58aa8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}main{max-width:720px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:18px;margin:0 0 4px}.sub{opacity:.7;font-size:14px;margin-bottom:16px}.ctx{font-size:14px;opacity:.75;margin-bottom:10px}.ctx div{margin:2px 0}.you{background:var(--card);border:2px solid var(--accent);border-radius:12px;padding:12px 14px;margin-bottom:14px;white-space:pre-wrap}
.opt{display:block;width:100%;text-align:left;background:var(--card);color:inherit;border:2px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px;font:inherit;cursor:pointer;white-space:pre-wrap}
.opt.on{border-color:var(--accent)}.slot{font-weight:600;color:var(--accent);margin-right:8px}.nav{display:flex;gap:10px;margin-top:14px}button.nav-b{font:inherit;padding:8px 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:inherit;cursor:pointer}
button.nav-b:disabled{opacity:.4}</style></head><body><main><h1>哪一条最像她</h1><div class="sub" id="progress"></div><div class="ctx" id="ctx"></div><div class="you" id="you"></div><div id="opts"></div>
<div class="nav"><button class="nav-b" id="prev">上一页 (←)</button><button class="nav-b" id="next">下一页 (→)</button><button class="nav-b" id="save">下载结果</button></div></main>
<script>const ITEMS=${data};const picks={};let at=0;try{Object.assign(picks,JSON.parse(localStorage.getItem('i134-picks')||'{}'))}catch(e){}
function esc(s){return s.replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function store(){try{localStorage.setItem('i134-picks',JSON.stringify(picks))}catch(e){}}
function pick(slot){const it=ITEMS[at];if(it.options.some(function(o){return o.slot===slot})){picks[it.page]=slot;store();render()}}
function go(d){const n=at+d;if(n>=0&&n<ITEMS.length){at=n;render()}}
function render(){const it=ITEMS[at];document.getElementById('progress').textContent='第 '+(at+1)+' / '+ITEMS.length+' 页，已选 '+Object.keys(picks).length+' 页（键盘：A–D 选，←→ 翻页）';
document.getElementById('ctx').innerHTML=it.context.map(function(c){return '<div>'+(c.role==='user'?'你':'她')+'：'+esc(c.text)+'</div>'}).join('');
document.getElementById('you').innerHTML='你：'+esc(it.user);
document.getElementById('opts').innerHTML=it.options.map(function(o){return '<button class="opt'+(picks[it.page]===o.slot?' on':'')+'" data-slot="'+o.slot+'"><span class="slot">'+o.slot+'</span>'+esc(o.text)+'</button>'}).join('');
document.querySelectorAll('.opt').forEach(function(b){b.onclick=function(){pick(b.dataset.slot)}});
document.getElementById('prev').disabled=at===0;document.getElementById('next').disabled=at===ITEMS.length-1}
document.getElementById('prev').onclick=function(){go(-1)};document.getElementById('next').onclick=function(){go(1)};
document.addEventListener('keydown',function(e){const k=e.key.toUpperCase();if(k==='ARROWLEFT')go(-1);else if(k==='ARROWRIGHT')go(1);else if('ABCD'.indexOf(k)>=0&&k.length===1)pick(k);else if('1234'.indexOf(k)>=0&&k.length===1)pick('ABCD'[Number(k)-1])});
document.getElementById('save').onclick=function(){const blob=new Blob([JSON.stringify({picks:picks},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='picks.json';a.click()};
render();</script></body></html>`;
}

export async function readPicks(file: string): Promise<Picks> {
  return ((JSON.parse(await readFile(file, 'utf8')) as { picks?: Picks }).picks) ?? {};
}

// ---- Ranking sheet (evening: "有些题得选最喜欢的，有些题得选最讨厌的，要不优化一下我来排序，加上并列？") ----
/** Per page: slot → rank (1 = best; equal numbers are ties). Pages the user skipped are listed apart. */
export interface RankFile { ranks: Record<string, Record<string, number>>; skipped?: string[] }
export interface RankTally {
  pages: number; ranked: number; skipped: number; arms: Arm[];
  /** Mean dense rank (1 = best) over the pages the arm appeared on. */
  meanRank: Record<string, number>;
  best: Record<string, number>; worst: Record<string, number>; appeared: Record<string, number>;
  /** pair "X>Y": pages where X ranked better than Y / worse / tied, over pages where both appeared. */
  pairs: Record<string, { better: number; worse: number; tied: number }>;
}
/** A page counts only when every option on it has a rank. Ranks are made dense per page first (1, 3, 3 → 1, 2, 2). */
export function tallyRanks(file: RankFile, key: ReplayKey): RankTally {
  const arms = [...new Set(key.pages.flatMap(page => Object.values(page.slots)))].sort() as Arm[];
  const sum: Record<string, number> = {}, appeared: Record<string, number> = {}, best: Record<string, number> = {}, worst: Record<string, number> = {};
  const pairs: RankTally['pairs'] = {};
  for (const a of arms) { sum[a] = 0; appeared[a] = 0; best[a] = 0; worst[a] = 0; for (const b of arms) if (a < b) pairs[`${a}>${b}`] = { better: 0, worse: 0, tied: 0 }; }
  let ranked = 0;
  for (const page of key.pages) {
    const given = file.ranks[page.page];
    if (!given) continue;
    const slots = Object.keys(page.slots);
    if (!slots.every(slot => Number.isFinite(given[slot]))) continue;
    ranked++;
    const levels = [...new Set(slots.map(slot => given[slot]!))].sort((x, y) => x - y);
    const dense = new Map(slots.map(slot => [page.slots[slot]!, levels.indexOf(given[slot]!) + 1] as const));
    const top = 1, bottom = levels.length;
    for (const [arm, rank] of dense) {
      sum[arm]! += rank; appeared[arm]!++;
      if (rank === top) best[arm]!++;
      if (rank === bottom && levels.length > 1) worst[arm]!++;
    }
    for (const pair of Object.keys(pairs)) {
      const [a, b] = pair.split('>') as [Arm, Arm];
      if (!dense.has(a) || !dense.has(b)) continue;
      const ra = dense.get(a)!, rb = dense.get(b)!;
      if (ra < rb) pairs[pair]!.better++; else if (ra > rb) pairs[pair]!.worse++; else pairs[pair]!.tied++;
    }
  }
  const meanRank: Record<string, number> = {};
  for (const a of arms) meanRank[a] = appeared[a] ? Math.round(sum[a]! / appeared[a]! * 100) / 100 : 0;
  return { pages: key.pages.length, ranked, skipped: file.skipped?.length ?? 0, arms, meanRank, best, worst, appeared, pairs };
}
export function formatRankTally(t: RankTally): string[] {
  const lines = [`共 ${t.pages} 页，排好 ${t.ranked} 页，跳过 ${t.skipped} 页`, '', '| 组 | 出现 | 平均名次（越小越好） | 排第一（含并列） | 排最后 |', '|---|---|---|---|---|'];
  for (const a of t.arms) lines.push(`| ${a} ${ARM_NAMES[a]} | ${t.appeared[a]} | ${t.meanRank[a]} | ${t.best[a]} | ${t.worst[a]} |`);
  lines.push('', '两两比较（同一页里都出现时）：');
  for (const [pair, v] of Object.entries(t.pairs)) { const [a, b] = pair.split('>') as [Arm, Arm]; lines.push(`- ${ARM_NAMES[a]} 对 ${ARM_NAMES[b]}：好 ${v.better}，差 ${v.worse}，一样 ${v.tied}`); }
  return lines;
}
export async function readRanks(file: string): Promise<RankFile> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<RankFile>;
  return { ranks: raw.ranks ?? {}, ...(raw.skipped ? { skipped: raw.skipped } : {}) };
}
/** Same pages as sheetHtml, but every option gets a rank button row (1 = best, equal numbers tie); a page can be skipped. */
export function rankSheetHtml(items: readonly SheetItem[]): string {
  const data = JSON.stringify(items).replace(/</gu, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>给她的回复排个序</title>
<style>:root{--bg:#faf7f5;--fg:#2a2523;--card:#fff;--line:#e3dad5;--accent:#c4577a;--soft:#f3e3e9}@media(prefers-color-scheme:dark){:root{--bg:#1d1a19;--fg:#ece6e3;--card:#292524;--line:#403836;--accent:#e58aa8;--soft:#3a2a30}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}main{max-width:720px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:18px;margin:0 0 4px}.sub{opacity:.7;font-size:14px;margin-bottom:16px}.ctx{font-size:14px;opacity:.75;margin-bottom:10px}.ctx div{margin:2px 0}.you{background:var(--card);border:2px solid var(--accent);border-radius:12px;padding:12px 14px;margin-bottom:14px;white-space:pre-wrap}
.opt{background:var(--card);border:2px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px;white-space:pre-wrap}.opt.done{border-color:var(--accent)}
.ranks{display:flex;gap:8px;margin-top:8px;align-items:center;font-size:14px;opacity:.9}.ranks button{font:inherit;min-width:40px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:inherit;cursor:pointer}
.ranks button.on{background:var(--accent);border-color:var(--accent);color:#fff}.nav{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}button.nav-b{font:inherit;padding:8px 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:inherit;cursor:pointer}
button.nav-b:disabled{opacity:.4}button.nav-b.on{background:var(--soft)}.hint{font-size:13px;opacity:.65;margin-top:6px}</style></head><body><main><h1>给她的回复排个序</h1>
<div class="sub" id="progress"></div><div class="ctx" id="ctx"></div><div class="you" id="you"></div><div id="opts"></div>
<div class="hint">1 是最好。觉得一样好，就点同一个数字（并列）。再点一次可以取消。挑不出来就点"跳过这一页"。</div>
<div class="nav"><button class="nav-b" id="prev">上一页 (←)</button><button class="nav-b" id="next">下一页 (→)</button><button class="nav-b" id="skip">跳过这一页</button><button class="nav-b" id="save">下载结果</button></div></main>
<script>const ITEMS=${data};let state={ranks:{},skipped:[]};let at=0;try{const s=JSON.parse(localStorage.getItem('i134-ranks')||'null');if(s&&s.ranks)state={ranks:s.ranks,skipped:s.skipped||[]}}catch(e){}
function esc(s){return s.replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function store(){try{localStorage.setItem('i134-ranks',JSON.stringify(state))}catch(e){}}
function full(it){const r=state.ranks[it.page]||{};return it.options.every(function(o){return r[o.slot]>0})}
function setRank(slot,n){const it=ITEMS[at];const r=state.ranks[it.page]||(state.ranks[it.page]={});if(r[slot]===n)delete r[slot];else r[slot]=n;state.skipped=state.skipped.filter(function(p){return p!==it.page});store();render()}
function toggleSkip(){const it=ITEMS[at];if(state.skipped.indexOf(it.page)>=0)state.skipped=state.skipped.filter(function(p){return p!==it.page});else{state.skipped.push(it.page);delete state.ranks[it.page]}store();render()}
function go(d){const n=at+d;if(n>=0&&n<ITEMS.length){at=n;render()}}
function render(){const it=ITEMS[at];const done=ITEMS.filter(full).length;document.getElementById('progress').textContent='第 '+(at+1)+' / '+ITEMS.length+' 页，排好 '+done+' 页，跳过 '+state.skipped.length+' 页';
document.getElementById('ctx').innerHTML=it.context.map(function(c){return '<div>'+(c.role==='user'?'你':'她')+'：'+esc(c.text)+'</div>'}).join('');
document.getElementById('you').innerHTML='你：'+esc(it.user);const r=state.ranks[it.page]||{};const n=it.options.length;
document.getElementById('opts').innerHTML=it.options.map(function(o){let b='';for(let i=1;i<=n;i++)b+='<button data-slot="'+o.slot+'" data-n="'+i+'" class="'+(r[o.slot]===i?'on':'')+'">'+i+'</button>';return '<div class="opt'+(r[o.slot]?' done':'')+'">'+esc(o.text)+'<div class="ranks">名次 '+b+'</div></div>'}).join('');
document.querySelectorAll('.ranks button').forEach(function(x){x.onclick=function(){setRank(x.dataset.slot,Number(x.dataset.n))}});
document.getElementById('skip').classList.toggle('on',state.skipped.indexOf(it.page)>=0);document.getElementById('prev').disabled=at===0;document.getElementById('next').disabled=at===ITEMS.length-1}
document.getElementById('prev').onclick=function(){go(-1)};document.getElementById('next').onclick=function(){go(1)};document.getElementById('skip').onclick=toggleSkip;
document.addEventListener('keydown',function(e){if(e.key==='ArrowLeft')go(-1);else if(e.key==='ArrowRight')go(1)});
document.getElementById('save').onclick=function(){const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ranks.json';a.click()};
render();</script></body></html>`;
}

export interface ReplayFiles { replies: string; key: string; sheet: string; items: string; summary: string }
/** Writes the five outputs into `out` (already checked by the caller). */
export async function writeReplayOutputs(out: string, replies: readonly ReplayReply[], points: readonly SheetPoint[], seed: number, arms: readonly Arm[],
  meta: Record<string, unknown> = {}): Promise<{ files: ReplayFiles; items: SheetItem[]; key: ReplayKey }> {
  await mkdir(out, { recursive: true });
  const { items, key } = buildSheet(replies, points, seed);
  const files: ReplayFiles = { replies: path.join(out, 'replies.json'), key: path.join(out, 'key.json'), sheet: path.join(out, 'sheet.html'), items: path.join(out, 'items.json'), summary: path.join(out, 'summary.md') };
  await writeFile(files.replies, JSON.stringify({ seed, arms, points: points.map(point => point.id), ...meta, replies }, null, 2), 'utf8');
  await writeFile(files.key, JSON.stringify(key, null, 2), 'utf8');
  await writeFile(files.sheet, sheetHtml(items), 'utf8');
  await writeFile(files.items, JSON.stringify(items, null, 2), 'utf8');
  await writeFile(files.summary, summaryMarkdown(replies, arms, [`seed ${seed}；${items.length} 页选择表；arms ${arms.join('')}`, ...(typeof meta.stopped === 'string' ? [`中止：${meta.stopped}`] : [])]), 'utf8');
  return { files, items, key };
}

// ---- summaries ------------------------------------------------------------------------------------------------------------------

export const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;
/** 00:00 local of a `YYYY-MM-DD` day. */
export function dayStartMs(day: string): number {
  if (!DAY_KEY.test(day)) throw new Error(`日期「${day}」要写成 YYYY-MM-DD。`);
  const [y, m, d] = day.split('-').map(Number);
  const ms = new Date(y!, m! - 1, d!).getTime();
  if (localDateKey(ms) !== day) throw new Error(`日期「${day}」不存在。`);
  return ms;
}
export interface SummaryAskInput { day: string; history: { role: string; content: string }[]; prompt: string }
export type SummaryAsk = (input: SummaryAskInput) => Promise<string>;
/** Offline stand-in: costs nothing, says nothing private. */
export const fakeSummaryAsk: SummaryAsk = async ({ day, history }) => `（假摘要）截至 ${day} 零点，一共 ${history.length} 条消息。`;
/** The real call, with the chat's own isolation (no tools, no saved session, empty temp folder); a failed or empty answer throws. */
export function claudeSummaryAsk(options: { model: string; binary: string; binaryArgs?: readonly string[]; budget: CallBudget }): SummaryAsk {
  return async ({ prompt }) => {
    options.budget.take('judge');
    let text = '';
    await streamClaude({ kind: 'chat', model: options.model, workingDirectory: os.tmpdir(), writable: false, prompt, systemPrompt: SUMMARY_INSTRUCTION },
      new AbortController().signal, (type, delta) => { if (type === 'delta') text += delta; }, options.binary, options.binaryArgs ?? []);
    if (!text.trim()) throw new Error('摘要调用没有返回文字。');
    return text.trim();
  };
}
/** One summary per day, from every message before that day's 00:00; stops at the first failure (nothing is retried). */
export async function makeSummaries(messages: readonly Timed[], days: readonly string[], ask: SummaryAsk, persona?: string, log?: (line: string) => void): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const marked = markTimes(messages);
  for (const day of days) {
    const start = dayStartMs(day);
    const history = marked.filter(message => message.createdAt < start);
    if (!history.length) throw new Error(`${day} 零点之前没有聊天，写不了摘要。`);
    out[day] = await ask({ day, history, prompt: buildSummaryPrompt(history, persona) });
    log?.(`  摘要 ${day}：${history.length} 条消息 → ${[...out[day]!].length} 字`);
  }
  return out;
}

// ---- the run --------------------------------------------------------------------------------------------------------------------

export interface ReplayOptions {
  snapshot: Snapshot;
  points: readonly PointSpec[];
  card: FidelityCard & { slowWarmUp?: boolean };
  model: string;
  binary: string;
  binaryArgs?: readonly string[];
  prewarmMs: number;
  budget: CallBudget;
  seed: number;
  arms: readonly Arm[];
  /** Per local day `YYYY-MM-DD`, for arm C. */
  summaries?: Readonly<Record<string, string>>;
  /** Text for arm D. */
  profile?: string;
  /** The first N points also run a second turn (the next real user message) for arms A and B. Default 3. */
  latencyPoints?: number;
  /** Kept replies of a stopped run (`replyKey`); a (point, arm) whose turns are all kept is not asked again. */
  kept?: readonly ReplayReply[];
  /** Arm E: messages before the point's local day that ride along with the whole day (--e-before-day, default 60). */
  eBeforeDay?: number;
  /** --retry-refused: ask a refused (point, arm) again on --resume; otherwise a refusal is kept as the outcome. */
  retryRefused?: boolean;
  /** --dump-prompts: receives every turn's full stdin prompt (private chat text) so the caller can check what each arm saw; private folder only. */
  promptDump?: (name: string, prompt: string) => Promise<void>;
  log?: (line: string) => void;
}
interface Planned { point: PointSpec; index: number; arm: Arm; withNext: boolean }

/** Everything the run would ask, in order (arms shuffled per point with the seed), minus what is already kept. Throws before any call on a bad point or a missing summary. */
export function planRuns(options: Pick<ReplayOptions, 'snapshot' | 'points' | 'seed' | 'arms' | 'summaries' | 'profile' | 'latencyPoints' | 'kept' | 'retryRefused'>): { runs: Planned[]; calls: number } {
  const { snapshot } = options;
  if (options.arms.includes('D') && !options.profile) throw new Error('arm D 需要 --profile-file。');
  const random = seededRandom(options.seed ^ 0x134);
  const keptKeys = new Set((options.kept ?? []).filter(reply => keepOnResume(reply, options.retryRefused)).map(reply => replyKey(reply.point, reply.arm, reply.turn)));
  const runs: Planned[] = [];
  const latency = options.latencyPoints ?? 3;
  let calls = 0;
  options.points.forEach((point, order) => {
    const index = locatePoint(snapshot.messages, point);
    const day = localDateKey(point.at);
    if ((options.arms.includes('C') || options.arms.includes('E')) && !options.summaries?.[day]) throw new Error(`点 ${point.id}：缺 ${day} 的摘要（arm C、E 需要 --summaries，先用 --make-summaries --days ${day}）。`);
    const nextUser = nextUserMessage(markTimes(snapshot.messages), index);
    for (const arm of shuffled(options.arms, random)) {
      const withNext = order < latency && (arm === 'A' || arm === 'B' || arm === 'E') && nextUser !== null;
      const needed = [replyKey(point.id, arm, 1), ...(withNext ? [replyKey(point.id, arm, 2)] : [])];
      if (needed.every(key => keptKeys.has(key))) continue;
      runs.push({ point, index, arm, withNext });
      calls += withNext ? 2 : 1;
    }
  });
  return { runs, calls };
}

/** Runs every planned (point, arm); stops at the first failed reply, nothing is retried. */
export async function runReplay(options: ReplayOptions): Promise<{ replies: ReplayReply[]; points: SheetPoint[]; stopped: string | null; calls: number }> {
  const { snapshot } = options;
  const marked = markTimes(snapshot.messages);
  const sheetPoints: SheetPoint[] = options.points.map(point => { const index = locatePoint(snapshot.messages, point); return { id: point.id, context: sheetContext(marked, index), user: marked[index]!.content }; });
  const plan = planRuns(options);
  const replaced = new Set(plan.runs.map(run => `${run.point.id}#${run.arm}`));
  const replies: ReplayReply[] = (options.kept ?? []).filter(reply => keepOnResume(reply, options.retryRefused) && !replaced.has(`${reply.point}#${reply.arm}`));
  let stopped: string | null = null;
  const firstAt = snapshot.messages[0]!.createdAt;
  try {
    for (const run of plan.runs) {
      const { point, index, arm } = run;
      const input = armInputs(arm, marked, index, options.eBeforeDay);
      const next = run.withNext ? nextUserMessage(marked, index) : null;
      const scenario: EvalScenario = { id: `${point.id}-${arm}`, title: point.id, history: input.history, turns: [{ user: input.user }, ...(next ? [{ user: next }] : [])] };
      const mood = moodAt(snapshot.moods, point.at);
      const hostText = arm === 'C' || arm === 'E' ? summaryHostContext(options.summaries![localDateKey(point.at)]!) : arm === 'D' ? profileHostContext(options.profile!) : null;
      setPromptSwitches({ why: false, situation: false });
      try {
        await runEval({
          label: arm, model: options.model, repeat: 1, scenarios: [scenario], binary: options.binary,
          ...(options.binaryArgs ? { binaryArgs: options.binaryArgs } : {}), prewarmMs: options.prewarmMs,
          card: { persona: options.card.persona, mood: options.card.mood,
            relationship: { slowWarmUp: options.card.slowWarmUp ?? false, dayNumber: dayNumberAt(firstAt, point.at), togetherDays: togetherDaysBefore(snapshot.messages, index) } },
          // B has no recall: its temp archive stays empty. A, C and D get the archive as it stood before the point.
          ...(arm === 'B' ? {} : { seed: async ({ directory, characterId, provider }: { directory: string; characterId: string; provider: ProviderConfig }) => {
            const scope = { characterId, providerScope: memoryProviderScope(provider) };
            const records = buildSeedRecords(snapshot.cache, weightsAt(snapshot.store, snapshot.scope, point.at), point.at, scopeKeyOf(scope));
            const target = new MemoryStore(directory);
            await target.load();
            await target.restoreRecords(records, scope);
            await target.flush();
          } }),
          prepareTurn: ({ companion }) => { if (mood) { companion.mood.setDeveloperMode(true); companion.mood.setTestMood(mood); } },
          ...(hostText ? { hostContext: () => hostText } : {}),
          beforeTurn: () => options.budget.take('reply'),
          onTurn: async record => {
            if (options.promptDump && record.prompt) await options.promptDump(`${point.id}-${arm}-${record.turn}`, record.prompt);
            const text = record.liveVisible.trim();
            replies.push({
              point: point.id, arm, turn: record.turn === 2 ? 2 : 1, text, chars: [...text].length, leaks: countLeaks(text), error: record.error,
              firstCharMs: record.chunks[0]?.[0] ?? null, endMs: record.endMs, dispatchMs: record.dispatchMs, usage: record.usage, promptChars: record.prompt?.length ?? null,
            });
            options.log?.(`  ${point.id} ${arm} 第${record.turn}轮 ${[...text].length} 字 首字 ${record.chunks[0]?.[0] ?? '-'}ms${record.error ? ' 出错' : ''}`);
          },
        });
      } catch (error) {
        // A refusal is this arm's outcome at this moment (already recorded by onTurn): count it and go on. Anything else
        // (quota, login, 429, a crash) stops the run as before, nothing is retried.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes(CLAUDE_REFUSED_MESSAGE)) throw error;
        options.log?.(`  ${point.id} ${arm} 被 Claude 拒绝：记为结果，继续下一组`);
      } finally { setPromptSwitches({ why: false, situation: false }); }
    }
  } catch (error) { stopped = error instanceof Error ? error.message : String(error); }
  return { replies, points: sheetPoints, stopped, calls: options.budget.calls };
}
