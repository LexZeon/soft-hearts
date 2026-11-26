/**
 * I-078 (docs/claude/2026-11-11-i078-sleep-step1.md): her rare silent "zzz…" while she sleeps, in the companion's ordinary answer
 * bubble — the same show call 猜拳 and her other unprompted lines use (rps-speech.ts petSayPorts) — never spoken, never added
 * to the chat history. Shown only when she is free (no reply running, nothing typed, the companion shown); otherwise dropped (never
 * queued, never shown late). The stage decides when (src/stage/sleep-body.ts, low frequency, varied words).
 */
import type { RpsSayPorts } from '../initiative';

export function showSleepMurmur(say: Pick<RpsSayPorts, 'free' | 'show'>, murmur: { id: string; text: string }): boolean {
  let free = false;
  try { free = say.free(); } catch { free = false; }
  if (!free || typeof murmur?.text !== 'string' || !murmur.text) return false;
  try { say.show(murmur.id, murmur.text, false); return true; } catch { return false; }
}
