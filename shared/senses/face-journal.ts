/**
 * I-135 认出是不是你 (Beta): the experience-journal rows that say how a face check went, so the user's next try shows.
 *
 * What fits: a closed outcome word, the best similarity against the enrolled faces (one number, -1..1, two decimals), which enrolled
 * set was the closest (its number, 1-based), whether the face was clear, and two measurements (how frontal 0..1, how sure the
 * detector was 0..1). And, when checks are expected but none ran, one closed reason word and how many seconds it has been quiet.
 * Never a picture, a crop, an embedding (the 128 numbers) or any other score. Kept apart from the 'face-check' counts rows, whose
 * rule "numbers of times only" stays as it was (tests/face-check-panel.test.ts).
 */
import { finite, has, round, type JournalTranslate } from '../foundation/journal-fields';

export const FACE_SCORE_EVENTS = ['check', 'idle'] as const;
export type FaceScoreEvent = (typeof FACE_SCORE_EVENTS)[number];

/** How one check ended (electron/senses/face/decision.ts CheckClass, minus 'skipped': a check that could not run is an idle row instead). */
export const FACE_SCORE_OUTCOMES = ['match', 'clear-not', 'weak-not', 'unsure', 'no-face'] as const;
export type FaceScoreOutcome = (typeof FACE_SCORE_OUTCOMES)[number];
export const FACE_SCORE_OUTCOME_WORDS: Readonly<Record<FaceScoreOutcome, string>> = Object.freeze({
  match: '认出是你', 'clear-not': '清楚的脸，明显不是你', 'weak-not': '清楚的脸，分数在不确定的一段，偏低', unsure: '拿不准，当成你', 'no-face': '画面里没有脸',
});

/** Why no check ran for a minute although the switch and the camera are on and a face is enrolled. */
export const FACE_IDLE_WHYS = ['models-missing', 'not-started', 'worker-failed', 'no-frames', 'no-result'] as const;
export type FaceIdleWhy = (typeof FACE_IDLE_WHYS)[number];
export const FACE_IDLE_WORDS: Readonly<Record<FaceIdleWhy, string>> = Object.freeze({
  'models-missing': '识别组件没装好', 'not-started': '检查没有启动', 'worker-failed': '识别进程没能正常运行', 'no-frames': '摄像头没有给出画面', 'no-result': '画面给了，识别没有结果',
});

export type FaceScoreInput =
  | { type: 'face-score'; characterId: string | null; event: 'check'; outcome: FaceScoreOutcome; similarity: number | null; which: number | null; clear: boolean; frontal: number; det: number }
  | { type: 'face-score'; characterId: string | null; event: 'idle'; why: FaceIdleWhy; seconds: number };

const unit2 = (value: unknown): number | null => finite(value) ? round(Math.min(1, Math.max(0, value)), 2) : null;

/** The row from a raw input, field by field from closed sets; null when anything does not fit. */
export function buildFaceScoreEntry(v: Record<string, unknown>, characterId: string | null): FaceScoreInput | null {
  if (!has(FACE_SCORE_EVENTS, v.event)) return null;
  if (v.event === 'idle') {
    if (!has(FACE_IDLE_WHYS, v.why) || !finite(v.seconds) || v.seconds < 0 || v.seconds > 86_400) return null;
    return { type: 'face-score', characterId, event: 'idle', why: v.why, seconds: Math.round(v.seconds) };
  }
  if (!has(FACE_SCORE_OUTCOMES, v.outcome) || typeof v.clear !== 'boolean') return null;
  const frontal = unit2(v.frontal), det = unit2(v.det);
  if (frontal === null || det === null) return null;
  let similarity: number | null = null;
  if (v.similarity != null) {
    if (!finite(v.similarity) || v.similarity < -1 || v.similarity > 1) return null;
    similarity = round(v.similarity, 2);
  }
  let which: number | null = null;
  if (v.which != null) {
    if (!Number.isInteger(v.which) || (v.which as number) < 1 || (v.which as number) > 64) return null;
    which = v.which as number;
  }
  return { type: 'face-score', characterId, event: 'check', outcome: v.outcome, similarity, which, clear: v.clear, frontal, det };
}

export function faceScoreReason(entry: FaceScoreInput): string {
  return entry.event === 'idle' ? '她该看看是不是你，但这一分钟没有检查' : '她看了一眼是不是你，这是这一眼的分数';
}

export function describeFaceScore(entry: FaceScoreInput, reason: string, tr: JournalTranslate): string {
  if (entry.event === 'idle') return tr('{0}（{1}，已经 {2} 秒）', reason, tr(FACE_IDLE_WORDS[entry.why]), String(entry.seconds));
  return tr('{0}（{1}；相似度 {2}{3}；{4}；正面程度 {5}，检测把握 {6}）', reason, tr(FACE_SCORE_OUTCOME_WORDS[entry.outcome]),
    entry.similarity === null ? tr('没有') : entry.similarity.toFixed(2), entry.which !== null ? tr('，最像登记的第 {0} 组', String(entry.which)) : '',
    entry.clear ? tr('脸够清楚') : tr('脸不够清楚'), entry.frontal.toFixed(2), entry.det.toFixed(2));
}
