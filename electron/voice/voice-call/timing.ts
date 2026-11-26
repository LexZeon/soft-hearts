/**
 * I-091: for every Claude turn during a call, whether its process was warm (reused), prewarmed or cold, and how long until its
 * first delta. Wraps the existing timing observer (electron/brain/reply-latency.ts) without changing what it sees. Numbers only.
 */
import type { ClaudeTimingInfo, ClaudeTimingObserver } from '../../brain';

export interface CallTimingSink {
  /** A call is on now. */
  on(): boolean;
  record(process: ClaudeTimingInfo['process'], firstDeltaMs: number | null): void;
}

export function teeCallTiming(base: ClaudeTimingObserver | undefined, call: CallTimingSink, now: () => number = () => performance.now()): ClaudeTimingObserver {
  const pending = new Map<string, { process: ClaudeTimingInfo['process']; at: number }>();
  return {
    dispatched: (replyId, info) => {
      try { base?.dispatched(replyId, info); } finally {
        try {
          if (call.on()) {
            pending.set(replyId, { process: info.process, at: now() });
            while (pending.size > 32) pending.delete(pending.keys().next().value!);
          }
        } catch { /* timing only */ }
      }
    },
    firstDelta: (replyId, model) => {
      try { base?.firstDelta(replyId, model); } finally { // The reported model (diagnostic) passes through: it once stopped here, so the journal never got it (2026-11-26).
        const turn = pending.get(replyId);
        if (turn) { pending.delete(replyId); try { call.record(turn.process, Math.max(0, Math.round(now() - turn.at))); } catch { /* timing only */ } }
      }
    },
  };
}
