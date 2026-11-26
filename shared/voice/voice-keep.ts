// 保存她念出来的声音（用来比对）: what the control window's developer area and the host say to each other (dev-only internal test tool;
// docs/claude/2026-11-24-voice-keep.md). Data only. The window never names a path or a size; the host decides everything.
export interface VoiceKeepView {
  /** False on a stable or packaged build: the window shows nothing and every call answers with this. */
  available: boolean;
  on: boolean;
  days: number;
  /** Sentences and bytes kept now; `capped`: keeping stopped because the disk cap was reached. */
  sentences: number;
  bytes: number;
  capped: boolean;
  capBytes: number;
}
export type VoiceKeepRequest = { op: 'get' } | { op: 'on' } | { op: 'off' } | { op: 'days'; days: number } | { op: 'clear' } | { op: 'open' };
export const VOICE_KEEP_DAYS_RANGE = { min: 1, max: 30, fallback: 7 } as const;
