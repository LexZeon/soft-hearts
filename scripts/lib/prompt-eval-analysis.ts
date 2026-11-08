// R28 prompt evaluation: pure analysis of recorded turns. A turn is recorded as
// the raw text deltas Claude Code streamed (with arrival times) plus this turn's
// nonce; replay() runs them through the app's own reply protocol again, so a
// protocol-layer change can be measured on recorded output without new model calls.
import { MoodReplyProtocol, type MoodAppraisal } from '../../electron/mood-chat';
import { openingMarker, type OpeningMode } from '../../electron/reply-opening';
import { asksForEnglish, chatLooksChinese, speakersFromPersona, type DraftDrop } from '../../electron/reply-draft-guard';
import { parseChatSettingProposal } from '../../electron/chat-settings';
import { settingViews } from '../../electron/agent-channel/app-tools';
import { IncrementalReplySegments } from '../../shared/incremental-reply-segments';
import { splitReplySegments } from '../../shared/reply-segments';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { ACTION_CLAIM, type TurnExpectation } from './prompt-eval-scenarios';

export interface TurnUsage {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
  costUsd: number | null; apiMs: number | null;
}

/** Everything recorded about one real (or fake) turn. Synthetic text only. */
export interface TurnRecord {
  label: string;
  model: string;
  repeat: number;
  scenario: string;
  title: string;
  turn: number;
  user: string;
  expect?: SerializedExpectation;
  /** Session transport as reported by PersistentClaudeChat's timing hooks. */
  process: 'cold' | 'prewarmed' | 'warm' | 'per-message' | null;
  sessionTurn: number | null;
  /** Model named in Claude Code's init event (the model actually serving the turn). */
  initModel: string | null;
  /** This turn's state-tail nonce (hex) and whether a settings proposal was offered. */
  nonce: string;
  settingOffered: boolean;
  /** Milliseconds from the chat.stream() call. */
  dispatchMs: number | null;
  endMs: number | null;
  /** Raw deltas from Claude Code: [ms since stream(), text]. */
  chunks: Array<[number, string]>;
  /** What the live companion turn showed (must equal the replayed visible text). */
  liveVisible: string;
  /** Stdin prompt actually written for this turn (synthetic content only). */
  prompt: string | null;
  usage: TurnUsage | null;
  error: string | null;
  /** Content blocks Claude Code streamed, in order ("0:thinking", "1:text"…). Recorded since the leaked-draft study; absent in older files. */
  blocks?: string[];
  /** I-046: the turn asked for an opening marker (only what follows it is shown): `true`/'turn' this turn's code, 'fixed' the one marker. Absent in older files and with it off. */
  opening?: boolean | OpeningMode;
  /** The turn carried the memorial proposal's private instruction. Absent in older files and without it. */
  memorial?: boolean;
  /** Thinking text streamed before/between the reply (bounded, synthetic content only), when the model sent any. */
  thinking?: string;
  /** Scalar fields of Claude Code's init event (version, model, output style…): what the process was actually running. */
  initInfo?: Record<string, string | number | boolean>;
}

export interface SerializedExpectation {
  contexts?: string[]; avoidGestures?: string[]; mentions?: string[]; firstSentence?: string[];
  noActionClaim?: boolean; settingCard?: { id: string; below?: number; above?: number };
}
export function serializeExpectation(expect?: TurnExpectation): SerializedExpectation | undefined {
  if (!expect) return undefined;
  return {
    ...(expect.contexts ? { contexts: [...expect.contexts] } : {}),
    ...(expect.avoidGestures ? { avoidGestures: [...expect.avoidGestures] } : {}),
    ...(expect.mentions ? { mentions: expect.mentions.map(pattern => pattern.source) } : {}),
    ...(expect.firstSentence ? { firstSentence: expect.firstSentence.map(pattern => pattern.source) } : {}),
    ...(expect.noActionClaim ? { noActionClaim: true } : {}),
    ...(expect.settingCard ? { settingCard: { ...expect.settingCard } } : {}),
  };
}

export interface Replayed {
  visible: string;
  /** The draft filter removed everything: the host treats this reply as failed instead of showing an empty bubble. */
  emptied: boolean;
  /** What the draft filter cut (shape and length only). */
  drops: DraftDrop[];
  /** Visible deltas: [ms since stream(), text]. */
  visibleChunks: Array<[number, string]>;
  appraisal: MoodAppraisal | null;
  settingRaw: string | null;
}

/**
 * Runs recorded raw deltas through the current MoodReplyProtocol. The recorded
 * nonce is swapped for the fresh protocol's nonce (same length), so chunk
 * boundaries stay exactly where Claude Code put them.
 */
export function replay(record: Pick<TurnRecord, 'chunks' | 'nonce' | 'settingOffered' | 'error'> & { prompt?: string | null; user?: string; opening?: boolean | OpeningMode; memorial?: boolean }): Replayed {
  const visibleChunks: Array<[number, string]> = [];
  let at = 0;
  // Like electron/main.ts: every ordinary chat turn passes a settings option (its
  // instruction is null unless the message mentions settings), so the protocol
  // always runs in family mode and hides any well-formed private marker. The
  // character's name comes from the persona that opened the recorded prompt, as in the app.
  const protocol = new MoodReplyProtocol(text => { if (text) visibleChunks.push([at, text]); },
    { settingProposal: { instruction: record.settingOffered ? (start, end) => `${start}${end}` : null }, speakers: speakersFromPersona(record.prompt ?? ''),
      // As companion.ts: the user's own message decides whether this is a Chinese chat (a record without it replays as before).
      chineseChat: typeof record.user === 'string' && chatLooksChinese(record.user, record.prompt ?? ''),
      englishAsked: typeof record.user === 'string' && asksForEnglish(record.user),
      // I-046: a turn that asked for the opening marker replays with it (its short code is swapped below like the nonce).
      ...(record.opening ? { opening: record.opening, userText: record.user ?? '' } : {}),
      ...(record.memorial ? { textMemorial: { userText: record.user ?? '', persona: 'p', mood: 'm', context: 'c' } } : {}) });
  const fresh = /^<sh-state-([a-f0-9]{32})>$/u.exec(protocol.start)![1];
  let joined = record.chunks.map(([, text]) => text).join('').split(record.nonce).join(fresh);
  // The code inside opening markers (written as asked, again, or closed): `sh-open-<first hex of the nonce>`, same length.
  if (record.opening && record.opening !== 'fixed' && record.nonce) joined = joined.split(openingMarker(record.nonce).slice(1, -1)).join(protocol.open.slice(1, -1));
  let offset = 0;
  for (const [time, text] of record.chunks) {
    at = time;
    protocol.push(joined.slice(offset, offset + text.length));
    offset += text.length;
  }
  at = record.chunks.at(-1)?.[0] ?? 0;
  const appraisal = protocol.finish(!record.error);
  return { visible: visibleChunks.map(([, text]) => text).join(''), visibleChunks, appraisal, settingRaw: protocol.settingProposal(),
    emptied: protocol.emptiedByFilter(), drops: protocol.draftDrops() };
}

export type TailStatus = 'ok' | 'missing' | 'foreign' | 'order' | 'unclosed' | 'json' | 'low-confidence' | 'schema' | 'error';

const LEAKS: Array<[string, RegExp]> = [
  ['marker', /<\/?sh-[a-z]+-/u],
  ['json-field', /"(?:context|delta|confidence|gesture|reason|choices)"\s*:/u],
  ['protocol-word', /尾注|nonce|内部状态|私有上下文|private-[a-z-]+|conversation-data|currentUser|状态标记|设置提议/u],
  ['channel-number', /(?<![A-Za-z])[DOENC]\s*[+＋\-－]\s*\d/u],
  ['tag', /<\/?[a-z][a-z-]*>/u],
  ['fence', /```/u],
  // A note to itself in English inside a Chinese reply (seen once in the baseline: "Gene initial greeting. Short.").
  ['latin-note', /[A-Za-z]{2,}[ ,.]+[A-Za-z]{2,}[ ,.]+[A-Za-z]{2,}/u],
  // The pet's bubbles render plain text (textContent): Markdown emphasis or headings show as raw symbols.
  ['markdown', /\*\*[^*\n]+\*\*|__[^_\n]+__|^#{1,6}\s/mu],
];
export const PERSONA_BREAKS: Array<[string, RegExp]> = [
  ['vendor', /Claude|Anthropic|ChatGPT|OpenAI/iu],
  ['assistant', /编程助手|AI\s*助手|人工智能助手|语言模型|大模型|作为(?:一个)?\s*AI/u],
  ['program', /我(?:只)?是(?:一个)?.{0,6}(?:模型|程序)/u],
];

export interface TurnMetrics {
  tail: TailStatus;
  foreignNonce: boolean;
  /** Text (other than a settings block) after this turn's closing marker. */
  afterTail: number;
  /** The tail came before any reply text. */
  tailFirst: boolean;
  leaks: string[];
  personaBreaks: string[];
  visibleChars: number;
  sentences: number;
  firstSentence: string;
  firstSentenceChars: number;
  firstRawMs: number | null;
  firstVisibleMs: number | null;
  firstSentenceMs: number | null;
  /** Live companion text differs from the replay (harness self-check). */
  liveMismatch: boolean;
  context: string | null;
  gesture: string | null;
  confidence: number | null;
  delta: Record<string, number> | null;
  contextOk: boolean | null;
  gestureOk: boolean | null;
  mentionsOk: boolean | null;
  firstSentenceOk: boolean | null;
  actionClaim: boolean | null;
  settingCardOk: boolean | null;
  settingId: string | null;
}

function tailStatus(raw: string, nonce: string, appraisal: MoodAppraisal | null, error: string | null): TailStatus {
  if (appraisal) return 'ok';
  if (error) return 'error';
  const start = `<sh-state-${nonce}>`, end = `</sh-state-${nonce}>`;
  const at = raw.indexOf(start);
  const foreign = /<\/?sh-(?:state|memorial|setting)-[a-f0-9]+>/u.exec(raw);
  if (foreign && (at < 0 || foreign.index < at) && foreign[0] !== start) return foreign[0].includes(nonce) ? 'order' : 'foreign';
  if (at < 0) return 'missing';
  const close = raw.indexOf(end, at);
  if (close < 0) return 'unclosed';
  try {
    const value = JSON.parse(raw.slice(at + start.length, close));
    if (value && typeof value.confidence === 'number' && value.confidence < 0.75) return 'low-confidence';
  } catch { return 'json'; }
  return 'schema';
}

function rawConfidence(raw: string, nonce: string): number | null {
  const start = `<sh-state-${nonce}>`, end = `</sh-state-${nonce}>`;
  const at = raw.indexOf(start), close = raw.indexOf(end, at + 1);
  if (at < 0 || close < 0) return null;
  try { const value = JSON.parse(raw.slice(at + start.length, close)); return typeof value?.confidence === 'number' ? value.confidence : null; }
  catch { return null; }
}

function firstSentenceOf(chunks: ReadonlyArray<[number, string]>, complete: boolean): { text: string; at: number | null } {
  const parser = new IncrementalReplySegments({ maxReplyChars: 100_000, maxSegments: 100_000 });
  try {
    for (const [at, text] of chunks) {
      const first = parser.push(text)[0];
      if (first) return { text: first.text, at };
    }
    if (complete) {
      const first = parser.finish()[0];
      if (first) return { text: first.text, at: chunks.at(-1)?.[0] ?? null };
    }
  } catch { /* Overflow: no sentence timing. */ }
  return { text: '', at: null };
}

const settingsNow = () => structuredClone(DEFAULT_SETTINGS);

export function analyzeTurn(record: TurnRecord, replayed: Replayed = replay(record)): TurnMetrics {
  const raw = record.chunks.map(([, text]) => text).join('');
  const visible = replayed.visible;
  const start = `<sh-state-${record.nonce}>`, end = `</sh-state-${record.nonce}>`;
  const at = raw.indexOf(start), close = at < 0 ? -1 : raw.indexOf(end, at);
  let after = close < 0 ? '' : raw.slice(close + end.length);
  after = after.replace(/<sh-setting-[a-f0-9]{32}>[\s\S]*?<\/sh-setting-[a-f0-9]{32}>/u, '');
  const foreign = [...raw.matchAll(/<\/?sh-state-([a-f0-9]+)>/gu)].some(match => match[1] !== record.nonce);
  const first = firstSentenceOf(replayed.visibleChunks, !record.error);
  let sentences = 0;
  try { sentences = splitReplySegments(visible.trim()).length; } catch { sentences = 0; }
  const expect = record.expect;
  const appraisal = replayed.appraisal;
  const proposal = replayed.settingRaw ? parseChatSettingProposal(replayed.settingRaw,
    id => settingViews(settingsNow()).find(view => view.id === id)?.value ?? null) : null;
  const card = expect?.settingCard;
  const any = (patterns: string[] | undefined, text: string) => patterns ? patterns.some(pattern => new RegExp(pattern, 'iu').test(text)) : null;
  return {
    tail: tailStatus(raw, record.nonce, appraisal, record.error),
    foreignNonce: foreign,
    afterTail: after.trim().length,
    tailFirst: at >= 0 && !raw.slice(0, at).trim() && !!raw.slice(close + end.length).replace(/<sh-setting-[\s\S]*$/u, '').trim(),
    leaks: LEAKS.filter(([, pattern]) => pattern.test(visible)).map(([name]) => name),
    personaBreaks: PERSONA_BREAKS.filter(([, pattern]) => pattern.test(visible)).map(([name]) => name),
    visibleChars: [...visible.trim()].length,
    sentences,
    firstSentence: first.text.trim(),
    firstSentenceChars: [...first.text.trim()].length,
    firstRawMs: record.chunks[0]?.[0] ?? null,
    firstVisibleMs: replayed.visibleChunks.find(([, text]) => text.trim())?.[0] ?? null,
    firstSentenceMs: first.at,
    liveMismatch: !record.error && record.liveVisible !== visible,
    context: appraisal?.context ?? null,
    gesture: appraisal ? appraisal.gesture ?? 'none' : null,
    confidence: appraisal ? rawConfidence(raw, record.nonce) : rawConfidence(raw, record.nonce),
    delta: appraisal ? { ...appraisal.delta } as Record<string, number> : null,
    contextOk: expect?.contexts && appraisal ? expect.contexts.includes(appraisal.context) : null,
    gestureOk: expect?.avoidGestures && appraisal ? !expect.avoidGestures.includes(appraisal.gesture ?? 'none') : null,
    mentionsOk: any(expect?.mentions, visible),
    firstSentenceOk: any(expect?.firstSentence, first.text),
    actionClaim: expect?.noActionClaim ? ACTION_CLAIM.test(visible) : null,
    settingCardOk: card ? !!proposal && proposal.spec.id === card.id
      && (card.below === undefined || (typeof proposal.value === 'number' && proposal.value < card.below))
      && (card.above === undefined || (typeof proposal.value === 'number' && proposal.value > card.above)) : null,
    settingId: proposal?.spec.id ?? null,
  };
}

// ---------------------------------------------------------------- summaries

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};
const numbers = (values: Array<number | null>) => values.filter((value): value is number => typeof value === 'number');
const rate = (values: Array<boolean | null>) => {
  const known = values.filter((value): value is boolean => value !== null);
  return { pass: known.filter(Boolean).length, of: known.length };
};

export interface GroupSummary {
  label: string;
  model: string;
  turns: number;
  errors: number;
  tail: Record<TailStatus, number>;
  tailMissRate: number;
  foreignNonce: number;
  afterTail: number;
  tailFirst: number;
  leaks: number;
  personaBreaks: number;
  tools: number;
  liveMismatch: number;
  contextOk: { pass: number; of: number };
  gestureOk: { pass: number; of: number };
  mentionsOk: { pass: number; of: number };
  firstSentenceOk: { pass: number; of: number };
  actionClaims: number;
  settingCards: { pass: number; of: number };
  firstRawMs: { median: number | null; p90: number | null };
  firstSentenceMs: { median: number | null; p90: number | null };
  firstSentenceChars: { median: number | null; p90: number | null };
  visibleChars: { median: number | null; p90: number | null };
  endMs: { median: number | null; p90: number | null };
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  initModels: string[];
}

/**
 * Claude Code's result event reports total_cost_usd for the whole process, so a
 * persistent session's turn costs the difference from its previous turn.
 */
export function turnCost(record: TurnRecord, records: readonly TurnRecord[]): number | null {
  const total = record.usage?.costUsd;
  if (typeof total !== 'number') return null;
  const previous = records.find(other => other.label === record.label && other.model === record.model && other.repeat === record.repeat
    && other.scenario === record.scenario && other.turn === record.turn - 1 && record.process === 'warm');
  const before = previous?.usage?.costUsd;
  return typeof before === 'number' ? Math.max(0, total - before) : total;
}

export function summarize(records: readonly TurnRecord[], analyze: (record: TurnRecord) => TurnMetrics = analyzeTurn): GroupSummary[] {
  const groups = new Map<string, TurnRecord[]>();
  for (const record of records) {
    const key = JSON.stringify([record.label, record.model]);
    groups.set(key, [...groups.get(key) ?? [], record]);
  }
  return [...groups.values()].map(group => {
    const metrics = group.map(record => analyze(record));
    const tail = { ok: 0, missing: 0, foreign: 0, order: 0, unclosed: 0, json: 0, 'low-confidence': 0, schema: 0, error: 0 } as Record<TailStatus, number>;
    for (const metric of metrics) tail[metric.tail]++;
    const answered = metrics.filter(metric => metric.tail !== 'error').length;
    const spread = (values: Array<number | null>) => ({ median: median(numbers(values)), p90: quantile(numbers(values), 0.9) });
    const usage = group.map(record => record.usage).filter((value): value is TurnUsage => !!value);
    return {
      label: group[0].label, model: group[0].model || 'default', turns: group.length,
      errors: group.filter(record => record.error).length,
      tail, tailMissRate: answered ? (answered - tail.ok) / answered : 0,
      foreignNonce: metrics.filter(metric => metric.foreignNonce).length,
      afterTail: metrics.filter(metric => metric.afterTail > 0).length,
      tailFirst: metrics.filter(metric => metric.tailFirst).length,
      leaks: metrics.filter(metric => metric.leaks.length).length,
      personaBreaks: metrics.filter(metric => metric.personaBreaks.length).length,
      tools: group.filter(record => /工具/u.test(record.error ?? '')).length,
      liveMismatch: metrics.filter(metric => metric.liveMismatch).length,
      contextOk: rate(metrics.map(metric => metric.contextOk)),
      gestureOk: rate(metrics.map(metric => metric.gestureOk)),
      mentionsOk: rate(metrics.map(metric => metric.mentionsOk)),
      firstSentenceOk: rate(metrics.map(metric => metric.firstSentenceOk)),
      actionClaims: metrics.filter(metric => metric.actionClaim).length,
      settingCards: rate(metrics.map(metric => metric.settingCardOk)),
      firstRawMs: spread(metrics.map(metric => metric.firstRawMs)),
      firstSentenceMs: spread(metrics.map(metric => metric.firstSentenceMs)),
      firstSentenceChars: spread(metrics.map(metric => metric.firstSentence ? metric.firstSentenceChars : null)),
      visibleChars: spread(metrics.map(metric => metric.visibleChars || null)),
      endMs: spread(group.map(record => record.endMs)),
      inputTokens: median(usage.map(value => value.inputTokens + value.cacheReadTokens + value.cacheCreationTokens)),
      outputTokens: median(usage.map(value => value.outputTokens)),
      costUsd: usage.some(value => value.costUsd !== null)
        ? Number(group.reduce((sum, record) => sum + (turnCost(record, group) ?? 0), 0).toFixed(4)) : null,
      initModels: [...new Set(group.map(record => record.initModel).filter((value): value is string => !!value))],
    };
  });
}

const cell = (value: unknown) => String(value ?? '–').replace(/\|/gu, '\\|').replace(/\r?\n/gu, '⏎');
const pct = (value: { pass: number; of: number }) => value.of ? `${value.pass}/${value.of}` : '–';
const ms = (value: { median: number | null; p90: number | null }) => value.median === null ? '–' : `${value.median} / ${value.p90}`;

export function summaryTable(summaries: readonly GroupSummary[]): string {
  const rows = [
    '| 标签 | 模型 | 轮数 | 尾注遗漏 | 尾注状态 | 旧nonce | 泄漏 | 人设破 | 工具 | 情境贴切 | 首句贴切 | 内容 | 越权声称 | 设置卡 | 首字 ms 中位/p90 | 首句完成 ms | 首句字数 | 总字数 | 输入/输出 token 中位 | 花费 USD |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of summaries) {
    const states = Object.entries(s.tail).filter(([key, count]) => key !== 'ok' && count).map(([key, count]) => `${key}×${count}`).join(' ') || '全部合法';
    rows.push(`| ${cell(s.label)} | ${cell(s.model)}${s.initModels.length ? ` (${s.initModels.join(',')})` : ''} | ${s.turns} | ${(s.tailMissRate * 100).toFixed(1)}% | ${states} | ${s.foreignNonce} | ${s.leaks} | ${s.personaBreaks} | ${s.tools} | ${pct(s.contextOk)} | ${pct(s.firstSentenceOk)} | ${pct(s.mentionsOk)} | ${s.actionClaims} | ${pct(s.settingCards)} | ${ms(s.firstRawMs)} | ${ms(s.firstSentenceMs)} | ${ms(s.firstSentenceChars)} | ${ms(s.visibleChars)} | ${s.inputTokens ?? '–'} / ${s.outputTokens ?? '–'} | ${s.costUsd ?? '–'} |`);
  }
  return rows.join('\n');
}

export function markdownReport(title: string, records: readonly TurnRecord[], notes: readonly string[] = []): string {
  const lines = [`# ${title}`, '', ...notes.map(note => `- ${note}`), '', '## 汇总', '', summaryTable(summarize(records)), '', '## 逐轮', '',
    '| 标签 | 模型 | 场景 | 轮 | 进程 | 首字 | 首句完成 | 尾注 | 情境/动作 | 标记 | 首句 |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const record of records) {
    const metric = analyzeTurn(record);
    const flags = [
      metric.foreignNonce && '旧nonce', metric.afterTail && '尾注后有字', metric.tailFirst && '尾注在前',
      ...metric.leaks.map(leak => `泄漏:${leak}`), ...metric.personaBreaks.map(item => `人设:${item}`),
      metric.contextOk === false && '情境不符', metric.gestureOk === false && '动作不符', metric.mentionsOk === false && '内容缺',
      metric.firstSentenceOk === false && '首句不贴', metric.actionClaim && '越权声称', metric.settingCardOk === false && '无设置卡',
      metric.liveMismatch && '回放不一致', record.error && `错误:${record.error.slice(0, 40)}`,
    ].filter(Boolean).join(' ');
    rows(lines, [record.label, record.model || 'default', record.scenario, record.turn, record.process, metric.firstRawMs, metric.firstSentenceMs,
      metric.tail + (metric.confidence !== null ? `(${metric.confidence})` : ''), metric.context ? `${metric.context}/${metric.gesture}` : '', flags, metric.firstSentence.slice(0, 60)]);
  }
  lines.push('', '## 回复全文（合成场景）', '');
  for (const record of records) {
    const visible = replay(record).visible.trim();
    lines.push(`### ${record.label} · ${record.model || 'default'} · ${record.scenario} #${record.turn} (r${record.repeat})`, '', `> 用户：${record.user}`, '', visible || '（无正文）', '');
  }
  return lines.join('\n');
}
function rows(lines: string[], values: unknown[]): void { lines.push(`| ${values.map(cell).join(' | ')} |`); }
