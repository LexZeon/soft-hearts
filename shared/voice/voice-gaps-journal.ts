/**
 * The experience journal's two additions of 2026-11-24 (dev build, 23:39-23:43; docs/claude/2026-11-24-voice-gaps.md):
 *
 * 1. What a failed paid reading says about itself: the error kind (a closed word), whether the same sentence had been tried a second time,
 *    and which reply and sentence it was (a number that lines the speech row up with that reply's reading-time row).
 * 2. One row per reply of the per-sentence timing: for each spoken sentence how long its synthesis took, how long the silence before it
 *    played was (the synthesis beyond the previous sentence's playback), and the provider.
 *
 * Numbers and closed words only: never a word of the reply, an address, a key or a server message. Pure, no clock.
 */
import { count, finite, has, ms, type JournalTranslate } from '../foundation/journal-fields';

/** Why a paid reading failed, finer than SPEECH_FAILURES: the request never connected, it timed out, it was stopped, the service answered 4xx / 5xx, it sent no audio. */
export const SPEECH_ERROR_KINDS = ['network', 'timeout', 'aborted', 'http-4xx', 'http-5xx', 'no-audio', 'other'] as const;
export type SpeechErrorKind = (typeof SPEECH_ERROR_KINDS)[number];
const SPEECH_ERROR_KIND_LABEL: Readonly<Record<SpeechErrorKind, string>> = Object.freeze({
  network: '连不上服务', timeout: '等太久超时了', aborted: '被停掉了', 'http-4xx': '服务拒绝了这次请求（4xx）', 'http-5xx': '服务那边出错了（5xx）', 'no-audio': '服务没有给出声音', other: '其他原因' });

/** The extra fields of a 'speech' row; each is present only when it applies. */
export interface SpeechFailureDetail { kind?: SpeechErrorKind; /** The same sentence had already been tried twice. */ retried?: true; /** The reply's number in this run (electron/voice/read-notes.ts). */ reply?: number; /** The sentence's place in the reply (0 is the first). */ segment?: number }

export function speechDetailFrom(v: Record<string, unknown>): SpeechFailureDetail {
  const reply = count(v.reply, 1_000_000), segment = count(v.segment, 127);
  return { ...(has(SPEECH_ERROR_KINDS, v.kind) ? { kind: v.kind } : {}), ...(v.retried === true ? { retried: true as const } : {}),
    ...(reply === undefined ? {} : { reply }), ...(segment === undefined ? {} : { segment }) };
}

/** "：连不上服务，重试了一次还是不行，第 3 条回复的第 2 句". Empty when no field is present. */
export function speechDetailWords(detail: SpeechFailureDetail, tr: JournalTranslate): string {
  const parts: string[] = [];
  if (detail.kind) parts.push(tr(SPEECH_ERROR_KIND_LABEL[detail.kind]));
  if (detail.retried) parts.push(tr('重试了一次还是不行'));
  if (detail.reply !== undefined) parts.push(detail.segment === undefined ? tr('第 {0} 条回复', String(detail.reply)) : tr('第 {0} 条回复的第 {1} 句', String(detail.reply), String(detail.segment + 1)));
  return parts.length ? tr('；{0}', parts.join(tr('，'))) : '';
}

/** At most this many sentences are listed in one row (a reply has at most 128 segments; the rest are not counted, never an error). */
export const READING_SEGMENTS_MAX = 64;
export const READING_SEGMENT_PROVIDERS = ['system', 'bailian', 'fish', 'other'] as const;
export const READING_SEGMENT_OUTCOMES = ['ended', 'cancelled', 'error'] as const;
export interface ReadingSegmentTiming {
  /** Synthesis dispatch to the first sound's bytes (ms); null for the system voice or when never measured. */
  synthMs: number | null;
  /** The silence before this sentence played: the previous sentence ended, this one's sound began (ms); null for the first sentence or when not measured. */
  silenceMs: number | null;
  provider: (typeof READING_SEGMENT_PROVIDERS)[number];
  outcome: (typeof READING_SEGMENT_OUTCOMES)[number];
}
export interface ReadingSegmentsFields { /** The reply's number in this run, when known. */ reply?: number; segments: ReadingSegmentTiming[] }

/** The checked segments (up to READING_SEGMENTS_MAX), or null when the list is not one. */
export function readingSegmentsFrom(v: Record<string, unknown>): ReadingSegmentsFields | null {
  if (!Array.isArray(v.segments) || v.segments.length === 0) return null;
  const segments: ReadingSegmentTiming[] = [];
  for (const item of v.segments.slice(0, READING_SEGMENTS_MAX)) {
    const s = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
    if (!s || !has(READING_SEGMENT_PROVIDERS, s.provider) || !has(READING_SEGMENT_OUTCOMES, s.outcome)) return null;
    segments.push({ synthMs: ms(s.synthMs), silenceMs: ms(s.silenceMs), provider: s.provider, outcome: s.outcome });
  }
  const reply = count(v.reply, 1_000_000);
  return { ...(reply === undefined ? {} : { reply }), segments };
}

const PROVIDER_LABEL: Readonly<Record<ReadingSegmentTiming['provider'], string>> = { system: '系统语音', bailian: '百炼', fish: 'Drama 3', other: '其他' };
const OUTCOME_MARK: Readonly<Record<ReadingSegmentTiming['outcome'], string>> = { ended: '', cancelled: '（被取消）', error: '（出错）' };
const seconds = (value: number | null) => value === null ? '—' : (value / 1000).toFixed(2);

/** "第 1 句 Drama 3 合成 0.42 秒；第 2 句 Drama 3 合成 0.55 秒、前面空了 1.30 秒；…". */
export function readingSegmentsWords(fields: ReadingSegmentsFields, tr: JournalTranslate): string {
  const lines = fields.segments.map((s, index) => {
    const parts = [tr('第 {0} 句 {1} 合成 {2} 秒', String(index + 1), tr(PROVIDER_LABEL[s.provider]), seconds(s.synthMs))];
    if (s.silenceMs !== null) parts.push(tr('前面空了 {0} 秒', seconds(s.silenceMs)));
    return parts.join(tr('、')) + tr(OUTCOME_MARK[s.outcome]);
  });
  return (fields.reply === undefined ? '' : tr('第 {0} 条回复：', String(fields.reply))) + lines.join(tr('；'));
}

/** Longest synthesis and longest silence of a row (for the one-line summary and the tests). */
export function readingSegmentsPeaks(fields: ReadingSegmentsFields): { synthMs: number | null; silenceMs: number | null } {
  const peak = (values: (number | null)[]) => { const kept = values.filter((n): n is number => finite(n)); return kept.length ? Math.max(...kept) : null; };
  return { synthMs: peak(fields.segments.map(s => s.synthMs)), silenceMs: peak(fields.segments.map(s => s.silenceMs)) };
}
