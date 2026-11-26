// I-222 step 4: an empty chat model means Opus (shared/brain/claude-model.ts chatModelArgument). An account that cannot use Opus must
// not leave her mute: when Claude Code refuses
// the implied Opus, the saved choice becomes 跟随 Claude Code 的默认 (followClaudeCodeAfterRefusal, saved by
// electron/wiring/chat-model-fallback-wiring.ts; the memory pin keeps her memory where it is), the failed call is tried once more without
// --model, and the chat page says so once (CHAT_MODEL_FALLBACK_NOTICE). Until that save lands, this run already follows the default.
// Only a real refusal of the model counts (shared/brain/claude-model.ts refusedClaudeModel): a network error, overload or usage limit
// changes nothing. A model the user chose explicitly is never replaced: its refusal stays the error it was.
import { CHAT_MODEL_FALLBACK_NOTICE, CHAT_MODEL_FOLLOW_CLAUDE_CODE, IMPLIED_CHAT_MODEL, impliesChatModel, refusedClaudeModel } from '../../shared/brain/claude-model';
import type { AppSettings } from '../../shared/foundation/settings';

let unavailable = false;
let noticeOwed = false;
let observer: (() => void) | null = null;

/**
 * The implied Opus was refused in this run: an empty chat model starts Claude Code without --model (calls that read "" before the follow
 * choice was saved, and their retry). Cleared when the user picks an Opus-implying value again (noteContextChatModel): then Opus is tried.
 */
export function impliedChatModelUnavailable(): boolean { return unavailable; }

/**
 * The host saved the follow choice (`changed`), or found the chat model no longer implies Opus (a choice made meanwhile, or a late refusal
 * of a call started before the save): nothing changed, nothing to tell.
 */
export function chatModelFallbackSettled(changed: boolean): void { if (!changed) noticeOwed = false; }

/**
 * True when `error` is Claude Code refusing the implied Opus of this saved chat model (from now on this run follows Claude Code's default).
 * False for anything else: a stopped turn, an explicitly chosen model (sonnet, opus, the follow choice...), another failure, or a refusal
 * that names another model (the retry without --model refused too: no loop).
 */
export function noteImpliedModelRefusal(saved: string, error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || !impliesChatModel(saved)) return false;
  const detail = error && typeof error === 'object' ? (error as { detail?: unknown }).detail : undefined;
  const named = refusedClaudeModel(detail) ?? refusedClaudeModel(error instanceof Error ? error.message : undefined);
  if (named === null || (named !== '' && named.toLowerCase() !== IMPLIED_CHAT_MODEL)) return false;
  if (!unavailable) {
    unavailable = true;
    noticeOwed = true;
    try { observer?.(); } catch { /* A log line never changes the chat. */ }
  }
  return true;
}

/**
 * Runs one Claude call; when it failed because the implied Opus was refused, `beforeRetry` (close processes started with --model opus)
 * and the call once more, now without --model. Any other failure, or a second one, is the caller's as before.
 */
export async function withImpliedModelFallback<T>(saved: string, signal: AbortSignal, run: () => Promise<T>, beforeRetry?: () => void): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!noteImpliedModelRefusal(saved, error, signal)) throw error;
    try { beforeRetry?.(); } catch { /* Closing old processes never blocks her answer. */ }
    return await run();
  }
}

/**
 * Her chat turn (electron/brain/claude-session.ts stream): the fallback above, and once it started (in this turn or in an earlier call of
 * this run), the chat page's one notice as a `status` line of this turn, before her reply is done (src/chat/chat-status-notice.ts shows it).
 */
export async function chatModelTurn<T>(saved: string, signal: AbortSignal, emit: (type: 'status', text: string) => void, run: () => Promise<T>,
  beforeRetry: () => void): Promise<T> {
  const outcome = await withImpliedModelFallback(saved, signal, run, beforeRetry);
  if (!signal.aborted && takeChatModelFallbackNotice()) {
    try { emit('status', CHAT_MODEL_FALLBACK_NOTICE); } catch { /* The window may be gone; the reply is not. */ }
  }
  return outcome;
}

/** The chat page's one notice is owed (true once per run, after the fallback started); the chat turn that takes it shows it. */
export function takeChatModelFallbackNotice(): boolean {
  const owed = noticeOwed;
  noticeOwed = false;
  return owed;
}

/**
 * The settings to save after the implied Opus was refused: the chat model becomes the follow choice. null when the saved chat model no
 * longer implies Opus (the user chose one meanwhile, or it was saved already): an explicit choice is never changed by this.
 */
export function followClaudeCodeAfterRefusal(current: AppSettings): AppSettings | null {
  return impliesChatModel(current.provider.model) ? { ...current, provider: { ...current.provider, model: CHAT_MODEL_FOLLOW_CLAUDE_CODE } } : null;
}

/** The host's save of the fallback (electron/wiring/chat-model-fallback-wiring.ts), told once per run when it starts. */
export function observeChatModelFallback(next: (() => void) | null): void { observer = next; }

let contextModel: string | null = null;
/**
 * The chat model her conversation was last given (electron/wiring/brain-wiring.ts savedCompanionContext): true when this one differs from
 * the one noted before (the first note is false). Another chat model is not a context change any more; her process restarts once she is done.
 */
export function noteContextChatModel(model: string): boolean {
  const changed = contextModel !== null && contextModel !== model;
  contextModel = model;
  if (changed && impliesChatModel(model)) unavailable = false; // the user chose Opus（默认） again: it is tried again
  return changed;
}

/** Test seam only: back to a fresh run. */
export function resetChatModelFallback(): void { unavailable = false; noticeOwed = false; observer = null; contextModel = null; }
