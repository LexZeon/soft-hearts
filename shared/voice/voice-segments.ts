/** Host-issued identities. These values never identify a task/RPC permission. */
export interface VoiceCaptureBinding { captureSessionId: string; epoch: string; }
export interface FinalVoiceSegment {
  groupId: string; segmentId: string; seq: number; epoch: string; text: string;
}
export interface VoiceGroupSeal {
  groupId: string; epoch: string; lastSeq: number;
  reason: "host-endpoint" | "finish-speaking";
}
export type VoiceCancelReason = "voice-off" | "scope-change" | "hide" | "stop-generation" | "teardown";
/**
 * openVoiceCapture's refusal while her reply is still being written. The microphone switch stays on and the window
 * opens the capture once the reply is done (turning voice input on mid-chat must not stop her or itself).
 */
export const VOICE_OPEN_AFTER_REPLY = "上一轮回复尚未结束，请稍后开启语音输入。";
/** How long a window keeps waiting for that reply before it gives up (and says so). */
export const VOICE_OPEN_WAIT_MS = 180_000;
export interface VoicePcmSubmission { captureSessionId: string; captureSeq: number; wav: ArrayBuffer; }
export type VoicePcmReceipt =
  | { state: "queued" | "duplicate"; groupId: string; segmentId: string; captureSeq: number }
  | { state: "rejected"; reason: "wrong-scope" | "gap" | "conflict" | "stale" | "overflow" | "invalid-audio" | "unavailable" };
