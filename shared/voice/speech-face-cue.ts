/**
 * I-073 part 3: what the voice output (or, with reading aloud off, the bubble) tells the stage, in either window. Facts
 * only, all relative to "now" when sent, so no clock has to be shared between windows (BroadcastChannel relay):
 *  - start: this reply segment's text is being heard from now on (voiced), or was just shown (voice off);
 *  - levels: loudness of this segment's PCM, the first value `aheadMs` from now, one per `stepMs` (cloud voices only);
 *  - stop: reading was interrupted (stopped, cut, a new reply). What has not happened is dropped, nothing replays later.
 * `key` is `${replyId}#${segmentIndex}`; the part before '#' is the turn.
 *
 * Moved here from src/voice/speech-face/cues.ts (which re-exports it) on 2026-11-21 (docs/claude/2026-11-21-unbound-full-ACH.md, batch A):
 * the host checks a cue with the same rule before it relays one to her full-screen Unbound window.
 */
export type SpeechFaceCue =
  | { kind: 'start'; key: string; text: string; voiced: boolean }
  | { kind: 'levels'; key: string; aheadMs: number; stepMs: number; levels: number[] }
  | { kind: 'stop' };

const MAX_TEXT = 4000, MAX_LEVELS = 4096;

/** A cue from the other window or a caller: well-formed copy, or null. */
export function sanitizeSpeechFaceCue(value: unknown): SpeechFaceCue | null {
  if (!value || typeof value !== 'object') return null;
  const cue = value as Record<string, unknown>;
  if (cue.kind === 'stop') return { kind: 'stop' };
  const key = typeof cue.key === 'string' && cue.key.length > 0 && cue.key.length <= 200 ? cue.key : null;
  if (!key) return null;
  if (cue.kind === 'start') {
    if (typeof cue.text !== 'string' || typeof cue.voiced !== 'boolean') return null;
    return { kind: 'start', key, text: cue.text.slice(0, MAX_TEXT), voiced: cue.voiced };
  }
  if (cue.kind === 'levels') {
    const aheadMs = Number(cue.aheadMs), stepMs = Number(cue.stepMs);
    if (!Number.isFinite(aheadMs) || aheadMs < -1000 || aheadMs > 60_000 || !(stepMs >= 5 && stepMs <= 500) || !Array.isArray(cue.levels) || cue.levels.length > MAX_LEVELS) return null;
    return { kind: 'levels', key, aheadMs, stepMs, levels: cue.levels.map(x => typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0) };
  }
  return null;
}

export const turnOf = (key: string): string => { const at = key.lastIndexOf('#'); return at < 0 ? key : key.slice(0, at); };
