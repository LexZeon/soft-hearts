/**
 * Why a reading aloud (Bailian TTS) or a recognition (voice input) did not work, as a closed category.
 * Only these words reach the experience journal (shared/journal.ts) — never the reply, the user's words,
 * an address, a key or a server's own message. A failed
 * Bailian reading is not replaced by the system voice, not retried and not shown; it is only noted here.
 */
export const SPEECH_FAILURES = ['network', 'auth', 'quota', 'service', 'timeout', 'other'] as const;
export type SpeechFailure = (typeof SPEECH_FAILURES)[number];

/** HTTP status → category (401/403 auth, 402/429 quota, anything else the service's own error). */
export function httpFailure(status: number): SpeechFailure {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'quota';
  return 'service';
}

/** A Bailian SSE error code (e.g. InvalidApiKey, Arrearage, Throttling.RateQuota) → category. The code itself is not kept. */
export function bailianCodeFailure(code: string): SpeechFailure {
  if (/InvalidApiKey|AccessDenied|Unauthori[sz]ed|Forbidden/i.test(code)) return 'auth';
  if (/Arrearage|Throttling|Quota|RateLimit|Overdue/i.test(code)) return 'quota';
  return 'service';
}

/** Voice input could not hear the user (shared by the local recognizer and the compatible address). */
/**
 * 'no-sound' and 'empty' are notes, not switch-offs: the microphone delivered only silence /
 * speech was heard but the recognizer returned no words. Voice input stays on and says so.
 */
export const VOICE_INPUT_FAILURES = ['needs-component', 'preparing', 'local-failed', 'unreachable', 'service', 'timeout', 'other', 'no-sound', 'empty'] as const;
export type VoiceInputFailure = (typeof VOICE_INPUT_FAILURES)[number];
