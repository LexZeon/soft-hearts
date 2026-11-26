/**
 * I-174 item 9b (docs/claude/2026-11-21-i174-parity-fixes.md): with the camera on, a minimize or the control window hiding releases the camera
 * (privacy: kept) and ends the look's context; before, the page then cleared the conversation at once and her reply in progress was stopped.
 * Now the host marks such a clear `afterReply` and the page starts the new conversation once that reply is over. A newer turn of yours that
 * began meanwhile already belongs to the new context: the clear is dropped then (it would cut your new turn). Any other clear: at once.
 *
 * I-221 (2026-11-26, docs/claude/2026-11-26-off-switch-interrupts.md): a sense turned off or moved (「发图片」, 屏幕共享, the camera, her own
 * looking) is not a new conversation. The host drops what she was shown at once and marks the clear `keepConversation`: the page keeps her
 * reply, its voice and the conversation; only what belongs to the look alone (a look line not yet shown) goes (`keep`).
 * Pure (a timer port), so the rule is tested without a page.
 */
export interface ClearAfterReplyPorts {
  /** The reply now in progress, or null. */
  active(): string | null;
  clear(): void;
  /** `keepConversation`: what the page drops instead of clearing (optional). */
  keep?(): void;
  every?(ms: number, run: () => void): () => void;
}
/** How often to look (ms) and how long at most to wait for the reply to end (ms). */
export const CLEAR_AFTER_REPLY = Object.freeze({ checkMs: 250, capMs: 10 * 60_000 });

/** The host's clear payload asks to keep her reply. */
export function clearKeepsReply(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { afterReply?: unknown }).afterReply === true;
}
/** The host's clear payload asks to keep the conversation (a sense went off or moved: nothing of the page is cleared). */
export function clearKeepsConversation(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { keepConversation?: unknown }).keepConversation === true;
}

/** Clears now, or once the reply in progress at this moment is over, or not at all (`keepConversation`). Returns a cancel for a waiting clear. */
export function clearAfterReply(value: unknown, ports: ClearAfterReplyPorts): () => void {
  if (clearKeepsConversation(value)) { ports.keep?.(); return () => {}; }
  const waitFor = clearKeepsReply(value) ? ports.active() : null;
  if (!waitFor) { ports.clear(); return () => {}; }
  const every = ports.every ?? ((ms, run) => { const timer = setInterval(run, ms); return () => clearInterval(timer); });
  const started = Date.now();
  let stop: (() => void) | null = null;
  stop = every(CLEAR_AFTER_REPLY.checkMs, () => {
    const now = ports.active();
    if (now === waitFor && Date.now() - started < CLEAR_AFTER_REPLY.capMs) return;
    stop?.(); stop = null;
    if (now === null || now === waitFor) ports.clear(); // over (or waited too long): the new conversation starts
  });
  return () => { stop?.(); stop = null; };
}
