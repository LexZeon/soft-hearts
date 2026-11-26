// 边说边演第 5 步的量法里的纯部分（scripts/dev/speech-beats-measure.ts 用；tests/speech-beats-measure.test.ts 测）：
// 一场场合成的对话、每条回复算出的事实（漏出、拍子、只演不说、大动作、心情尾注）、汇总的数字。不调用模型，不碰时钟。
// 用户的台词、人设、对话全是合成的；不读任何真实配置、聊天或模型。
import { SpeechBeatFilter } from '../../shared/behaviors/speech-beats/choose';
import { SPEECH_BEAT_WORDS, type SpeechBeat } from '../../shared/behaviors/speech-beats/interface';

/** 台词的种类：小聊、夸、逗（可能只演不说）、难过或严肃、直接要答案的问题（要用话答）、要步骤。 */
export type LineKind = 'small' | 'compliment' | 'tease' | 'sad' | 'direct' | 'steps';
export interface PlannedLine { readonly id: string; readonly kind: LineKind; readonly text: string }
export interface PlannedConversation { readonly name: string; readonly on: boolean; readonly lines: readonly PlannedLine[] }

const L = (id: string, kind: LineKind, text: string): PlannedLine => ({ id, kind, text });
const SMALL = L('small', 'small', '我刚下班回家，外面天都黑了。');
const COMPLIMENT = L('compliment', 'compliment', '说真的，你今天说话特别可爱。');
const TEASE = L('tease', 'tease', '你是不是又偷偷想我了？嘿嘿，我看出来了。');
const SAD1 = L('sad1', 'sad', '我今天被领导当着大家的面批评了，心里特别难受。');
const DIRECT1 = L('direct1', 'direct', '你知道从北京坐高铁到上海大概要几个小时吗？');
const STEPS = L('steps', 'steps', '能一步一步告诉我怎么在手机上设置每天早上七点的闹钟吗？');

/**
 * 20 条：14 条开关开着、6 条关着（关着的 6 条是开着的里面 6 条同样的台词：小聊、夸、逗、难过、直接问、要步骤，用来比首字和用量）。
 * 顺序交错（开、关、开、关、开、开），免得一段时间里的快慢全落在一边。每场对话里台词连着说，她的历史（带标记的话）会被带到下一句。
 */
export const MEASURE_PLAN: readonly PlannedConversation[] = Object.freeze([
  { name: 'A-on', on: true, lines: [SMALL, L('small2', 'small', '今天路上看到一只特别胖的猫，趴在车上睡觉。'), COMPLIMENT, TEASE] },
  { name: 'E-off', on: false, lines: [SMALL, COMPLIMENT, DIRECT1] },
  { name: 'B-on', on: true, lines: [SAD1, L('sad2', 'sad', '我有点怀疑自己是不是真的不适合这份工作。'), DIRECT1, STEPS] },
  { name: 'F-off', on: false, lines: [SAD1, TEASE, STEPS] },
  { name: 'C-on', on: true, lines: [L('compliment2', 'compliment', '你知道吗，有你陪着我觉得很安心。'), L('tease2', 'tease', '哼，你刚才是不是在偷懒没理我？'), L('small3', 'small', '我准备去阳台浇花了，你要不要一起看看？')] },
  { name: 'D-on', on: true, lines: [L('direct2', 'direct', '“谢谢”用英语怎么说？还有“不客气”呢？'), L('sad3', 'sad', '我奶奶住院了，我有点害怕。'), L('small4', 'small', '晚上好呀，今天过得怎么样？')] },
]);
export const plannedRequests = (plan: readonly PlannedConversation[] = MEASURE_PLAN): number => plan.reduce((sum, conversation) => sum + conversation.lines.length, 0);

/** 严肃话题上不该出现的大身体动作（任务单：v、手放脸边、凑近、笑出声）。 */
export const BIG_BODY_MOVES: readonly string[] = ['v', 'hand-cheek', 'lean-in', 'laugh'];
const SPOKEN = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
const LEAK_SHAPES = /[⟦⟧【】〖〗]|\[\s*(?:look-|smile-|laugh|shy|pout|surprise|sly|content|tilt|hand-cheek|v\b|lean-|blink-)/iu;

export interface ReplyFacts {
  /** 显示出来的字里有没有标记（⟦⟧、或括号里的词表词）、再过一遍过滤器还有没有拍子。 */
  readonly leaked: boolean;
  /** 她原文里 ⟦ 的个数（她写了几个标记，不管写得对不对）。 */
  readonly rawMarkers: number;
  readonly beats: readonly SpeechBeat[];
  /** 标记被丢掉的个数（词表外、写坏的、超过上限的）。 */
  readonly dropped: number;
  /** 她写了标记，而且每个都读得出来（没有被丢掉的）。 */
  readonly markersParse: boolean;
  /** 整条只演不说：有拍子，显示的字里没有文字、数字、表情符号。 */
  readonly performanceOnly: boolean;
  readonly bigMoves: readonly string[];
  readonly shownChars: number;
}

/** `raw`：Claude 的原文（含标记、开头标记和尾注）；`shown`：回复协议显示出来的字（应用里气泡、朗读、存档看到的）。 */
export function analyseReply(raw: string, shown: string): ReplyFacts {
  const filter = new SpeechBeatFilter();
  filter.push(raw); filter.end();
  const rawSummary = filter.summary();
  const again = new SpeechBeatFilter();
  again.push(shown); again.end();
  const leaked = LEAK_SHAPES.test(shown) || again.summary().beats.length > 0 || again.summary().dropped > 0;
  const rawMarkers = Array.from(raw).filter(char => char === '⟦').length;
  const beats = rawSummary.beats;
  return { leaked, rawMarkers, beats, dropped: rawSummary.dropped, markersParse: rawMarkers > 0 && rawSummary.dropped === 0,
    performanceOnly: beats.length > 0 && !SPOKEN.test(shown), bigMoves: [...new Set(beats.map(beat => beat.word).filter(word => BIG_BODY_MOVES.includes(word)))], shownChars: Array.from(shown).length };
}

export interface Quantiles { readonly n: number; readonly median: number | null; readonly p25: number | null; readonly p75: number | null; readonly min: number | null; readonly max: number | null; readonly mean: number | null }
export function quantiles(values: readonly number[]): Quantiles {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, median: null, p25: null, p75: null, min: null, max: null, mean: null };
  const at = (p: number) => { const index = p * (sorted.length - 1), low = Math.floor(index), high = Math.ceil(index); return sorted[low] + (sorted[high] - sorted[low]) * (index - low); };
  const round = (value: number) => Math.round(value * 10) / 10;
  return { n: sorted.length, median: round(at(0.5)), p25: round(at(0.25)), p75: round(at(0.75)), min: sorted[0], max: sorted.at(-1)!, mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) };
}

/** 一次请求量到的东西（原文另存，这里只有数字和词表的词）。 */
export interface MeasureRow {
  readonly conversation: string;
  readonly on: boolean;
  readonly turn: number;
  readonly lineId: string;
  readonly kind: LineKind;
  /** 这条请求是不是对话里的第一条（开新进程，首字不算进统计）。 */
  readonly first: boolean;
  readonly ok: boolean;
  readonly error?: string;
  /** 从发出到第一个看得见的字（毫秒）；整条只演不说、没有字时是 null。 */
  readonly firstVisibleMs: number | null;
  readonly firstRawMs: number | null;
  readonly facts: ReplyFacts | null;
  /** 心情尾注读得出来吗（回复协议的 finish）。 */
  readonly moodTail: boolean;
  readonly outputTokens: number | null;
  readonly inputTokens: number | null;
  readonly cacheRead: number | null;
  readonly cacheCreation: number | null;
  readonly model: string;
}

const rate = (hit: number, of: number) => ({ hit, of });
export interface MeasureSummary {
  readonly requests: number;
  readonly on: number;
  readonly off: number;
  readonly failed: number;
  readonly leaks: number;
  readonly markersWritten: ReturnType<typeof rate>;
  readonly markersParse: ReturnType<typeof rate>;
  readonly droppedMarkers: number;
  readonly beatsPerReply: Quantiles;
  readonly beatsPerReplyAll: number[];
  readonly performanceOnly: number;
  readonly performanceOnlyOnDirect: number;
  readonly performanceOnlyByKind: Record<string, number>;
  readonly bigMovesOnSad: { readonly replies: number; readonly withBig: number; readonly moves: string[] };
  readonly moodTail: { readonly on: ReturnType<typeof rate>; readonly off: ReturnType<typeof rate> };
  readonly firstVisibleMs: { readonly on: Quantiles; readonly off: Quantiles; readonly onExcludingFirst: Quantiles; readonly offExcludingFirst: Quantiles };
  readonly outputTokens: { readonly on: Quantiles; readonly off: Quantiles; readonly matchedPairs: { id: string; on: number | null; off: number | null; diff: number | null }[]; readonly matchedMeanDiff: number | null };
  readonly inputTokens: { readonly on: Quantiles; readonly off: Quantiles };
  readonly wordsUsed: Record<string, number>;
}

export function summarise(rows: readonly MeasureRow[]): MeasureSummary {
  const good = rows.filter(row => row.ok && row.facts);
  const on = good.filter(row => row.on), off = good.filter(row => !row.on);
  const words: Record<string, number> = Object.fromEntries(SPEECH_BEAT_WORDS.map(word => [word, 0]));
  for (const row of on) for (const beat of row.facts!.beats) words[beat.word] = (words[beat.word] ?? 0) + 1;
  const sad = on.filter(row => row.kind === 'sad');
  const nums = (list: readonly MeasureRow[], pick: (row: MeasureRow) => number | null) => list.map(pick).filter((value): value is number => value !== null);
  const pairs: { id: string; on: number | null; off: number | null; diff: number | null }[] = [];
  for (const row of off) {
    const mate = on.find(candidate => candidate.lineId === row.lineId);
    if (mate) pairs.push({ id: row.lineId, on: mate.outputTokens, off: row.outputTokens, diff: mate.outputTokens !== null && row.outputTokens !== null ? mate.outputTokens - row.outputTokens : null });
  }
  const diffs = pairs.map(pair => pair.diff).filter((value): value is number => value !== null);
  const written = on.filter(row => row.facts!.rawMarkers > 0);
  const performance = on.filter(row => row.facts!.performanceOnly);
  const byKind: Record<string, number> = {};
  for (const row of performance) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  return {
    requests: rows.length, on: on.length, off: off.length, failed: rows.length - good.length,
    leaks: good.filter(row => row.facts!.leaked).length,
    markersWritten: rate(written.length, on.length), markersParse: rate(written.filter(row => row.facts!.markersParse).length, written.length),
    droppedMarkers: good.reduce((sum, row) => sum + row.facts!.dropped, 0),
    beatsPerReply: quantiles(on.map(row => row.facts!.beats.length)), beatsPerReplyAll: on.map(row => row.facts!.beats.length),
    performanceOnly: performance.length, performanceOnlyOnDirect: performance.filter(row => row.kind === 'direct').length, performanceOnlyByKind: byKind,
    bigMovesOnSad: { replies: sad.length, withBig: sad.filter(row => row.facts!.bigMoves.length > 0).length, moves: sad.flatMap(row => row.facts!.bigMoves) },
    moodTail: { on: rate(on.filter(row => row.moodTail).length, on.length), off: rate(off.filter(row => row.moodTail).length, off.length) },
    firstVisibleMs: {
      on: quantiles(nums(on, row => row.firstVisibleMs)), off: quantiles(nums(off, row => row.firstVisibleMs)),
      onExcludingFirst: quantiles(nums(on.filter(row => !row.first), row => row.firstVisibleMs)), offExcludingFirst: quantiles(nums(off.filter(row => !row.first), row => row.firstVisibleMs)) },
    outputTokens: { on: quantiles(nums(on, row => row.outputTokens)), off: quantiles(nums(off, row => row.outputTokens)), matchedPairs: pairs, matchedMeanDiff: diffs.length ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length * 10) / 10 : null },
    inputTokens: { on: quantiles(nums(on, row => (row.inputTokens ?? 0) + (row.cacheRead ?? 0) + (row.cacheCreation ?? 0))), off: quantiles(nums(off, row => (row.inputTokens ?? 0) + (row.cacheRead ?? 0) + (row.cacheCreation ?? 0))) },
    wordsUsed: words,
  };
}

/** 从账本（tee 写的）读：已发出的请求数、按顺序的 result 行。 */
export interface LedgerRow { kind: 'request' | 'result' | 'refused'; pid: number; at: number; model?: string; error?: boolean; inputTokens?: number | null; outputTokens?: number | null; cacheRead?: number | null; cacheCreation?: number | null }
export const parseLedger = (text: string): LedgerRow[] => text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as LedgerRow]; } catch { return []; } });
export const ledgerRequests = (rows: readonly LedgerRow[]): number => rows.filter(row => row.kind === 'request').length;
/** 额度、限流类的错误：一遇到就停，不重试。 */
export const looksLikeQuota = (message: string): boolean => /429|rate.?limit|quota|usage limit|overloaded|额度|用量|限流/iu.test(message);
