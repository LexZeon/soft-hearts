// Stream-json event kinds the chat reader does not know, journaled so the next stray line in her bubble can be traced
// (docs/claude/2026-11-25-peer-messages-refused.md; docs/claude/brain-interface.md lists it). Only the event's `type` and, for
// `system`, its `subtype` leave this module, and only when they look like Claude Code's own identifiers (lowercase letters,
// digits and underscores, at most 40): anything else is the word "odd". Never a field's text.
// One row per new kind per process (the caller's `seen` set: one per one-shot call, one per long-lived process), and at most
// RUN_CAP rows per kind in one app run, so a kind every call carries cannot fill the journal.
import { streamKindName } from '../../shared/brain/stream-kind';

/** What the reader handles, plus kinds Claude Code sends in every stream that carry no text for her bubble. */
const KNOWN_KINDS: ReadonlySet<string> = new Set([
  'system/init', 'system/api_retry', 'stream_event', 'assistant', 'result',
  'control_response', // the long-lived process's interrupt answers (claude-process.ts)
  'rate_limit_event', // seen in 2.1.x streams (docs/claude/2026-11-02-R33-continuous-voice.md); no text for her bubble
]);
const PER_PROCESS_CAP = 32;
const RUN_CAP = 20;

export interface ClaudeStreamKind { event: string; subtype?: string }
export type ClaudeStreamKindObserver = (kind: ClaudeStreamKind) => void;

/** The kind of one parsed stream-json event when the reader does not know it; null for a known one. */
export function unknownStreamKind(event: unknown): ClaudeStreamKind | null {
  if (!event || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;
  const type = streamKindName(record.type);
  const kind: ClaudeStreamKind = type === 'system' ? { event: type, subtype: streamKindName(record.subtype) } : { event: type };
  return KNOWN_KINDS.has(streamKindKey(kind)) ? null : kind;
}

export function streamKindKey(kind: ClaudeStreamKind): string {
  return kind.subtype === undefined ? kind.event : `${kind.event}/${kind.subtype}`;
}

let observer: ClaudeStreamKindObserver | null = null;
const runCounts = new Map<string, number>();

/** The app's journal hook (electron/wiring/brain-wiring.ts); null removes it. */
export function observeClaudeStreamKinds(next: ClaudeStreamKindObserver | null): void { observer = next; }

/** Test seam: forget the run-wide counts. */
export function resetClaudeStreamKindCounts(): void { runCounts.clear(); }

/** Reports `event`'s kind once per `seen` set when it is unknown. Never throws, never affects the stream. */
export function noteStreamKind(seen: Set<string>, event: unknown): void {
  const kind = unknownStreamKind(event);
  if (!kind) return;
  const key = streamKindKey(kind);
  if (seen.has(key) || seen.size >= PER_PROCESS_CAP) return;
  seen.add(key);
  const count = runCounts.get(key) ?? 0;
  if (count >= RUN_CAP) return;
  runCounts.set(key, count + 1);
  try { observer?.(kind); } catch { /* A journal row never affects the stream. */ }
}
