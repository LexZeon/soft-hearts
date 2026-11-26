/**
 * The experience journal's 'stream-gaps' row (2026-11-24, electron/brain/stream-gaps.ts, docs/claude/2026-11-24-voice-gaps.md): per reply,
 * the largest gap between the raw chunks the host got from the model and the largest gap between the deltas that left the host, and
 * where each fell. Numbers (ms, a character index, a chunk count) and one closed word; never a character of the reply. Pure.
 */
import { count, has, ms, type JournalTranslate } from '../foundation/journal-fields';

/** What was pending when the raw gap began: an open bracket tag, a trailing emphasis mark, text the protocol held back, or nothing. */
export const STREAM_PENDING_WORDS = ['none', 'open-tag', 'emphasis', 'held'] as const;
export type StreamPending = (typeof STREAM_PENDING_WORDS)[number];
const PENDING_LABEL: Readonly<Record<StreamPending, string>> = Object.freeze({
  none: '当时没有在等什么', 'open-tag': '当时有一个括号标记没写完', emphasis: '当时停在强调符号上', held: '当时有一段字在协议里等着放行' });

export interface StreamGaps {
  /** Raw chunks received from the model. */
  chunks: number;
  /** The largest gap between two raw chunks (ms), the characters that had arrived when it fell, what was pending; null/absent with fewer than two chunks. */
  rawGapMs: number | null; rawGapAt?: number; rawPending?: StreamPending;
  /** The largest gap between two deltas that left the host, and where it fell. */
  shownGapMs: number | null; shownGapAt?: number;
}

/** The checked fields, or null when the chunk count is missing. */
export function streamGapsFrom(v: Record<string, unknown>): StreamGaps | null {
  const chunks = count(v.chunks, 10_000_000);
  if (chunks === undefined) return null;
  const rawGapMs = ms(v.rawGapMs), shownGapMs = ms(v.shownGapMs), rawGapAt = count(v.rawGapAt, 10_000_000), shownGapAt = count(v.shownGapAt, 10_000_000);
  return { chunks, rawGapMs, ...(rawGapMs !== null && rawGapAt !== undefined ? { rawGapAt } : {}), ...(rawGapMs !== null && has(STREAM_PENDING_WORDS, v.rawPending) ? { rawPending: v.rawPending } : {}),
    shownGapMs, ...(shownGapMs !== null && shownGapAt !== undefined ? { shownGapAt } : {}) };
}

const seconds = (value: number) => (value / 1000).toFixed(2);

/** "模型文字最长一次隔了 24.10 秒（到第 812 个字；当时…），送到气泡的最长隔了 24.12 秒（到第 790 个字）；共 85 段". */
export function streamGapsWords(g: StreamGaps, tr: JournalTranslate): string {
  const raw = g.rawGapMs === null ? tr('模型的字没有隔开过') : tr('模型的字最长一次隔了 {0} 秒（到第 {1} 个字；{2}）', seconds(g.rawGapMs), String(g.rawGapAt ?? 0), tr(PENDING_LABEL[g.rawPending ?? 'none']));
  const shown = g.shownGapMs === null ? '' : tr('，送出给气泡的字最长隔了 {0} 秒（到第 {1} 个字）', seconds(g.shownGapMs), String(g.shownGapAt ?? 0));
  return raw + shown + tr('；共收到 {0} 段', String(g.chunks));
}
