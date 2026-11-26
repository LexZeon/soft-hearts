import type { AmbientMode, AmbientScope } from './ambient-audio';

export type AmbientRuntimeReason = 'off' | 'listening' | 'transcribing' | 'speaking' | 'asr-busy' | 'recognition-error' | 'archive-error';
export interface AmbientRuntimeState {
  active: boolean;
  sessionId: string | null;
  startedAt: number | null;
  mode: AmbientMode | null;
  suspended: boolean;
  reason: AmbientRuntimeReason;
  status: string;
  origin: 'system-audio';
}
export interface AmbientAudioView extends AmbientRuntimeState {
  available: boolean;
  destination: string;
  languageNotice: string;
}
/** Host-only snapshot. Never expose it through renderer IPC. */
export interface AmbientRuntimeSession {
  owner: number;
  sessionId: string;
  startedAt: number;
  /** Host timestamp acknowledged only after the existing loopback capture is ready. */
  captureReadyAt: number | null;
  mode: AmbientMode;
  scope: AmbientScope;
  contextIdentity: string;
}
/** These are the complete renderer inputs. Language and persona belong to the host. */
export interface AmbientRuntimeSubmission {
  sessionId: string;
  sequence: number;
  wav: ArrayBuffer;
  startOffsetMs: number;
  endOffsetMs: number;
}
export interface AmbientSubmissionResult {
  status: 'accepted' | 'empty' | 'paused' | 'cancelled';
  sessionId: string;
  sequence: number;
  recordId?: string;
  inserted?: boolean;
}
