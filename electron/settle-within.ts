// Wait for pending saves on quit, but never longer than a limit (electron/main.ts before-quit: the "允许记录" switch's file write,
// UserProfileStore.settled()). A save that hangs or fails must not hold the quit; docs/claude/2026-11-06-small-gaps.md.
export const QUIT_SETTLE_LIMIT_MS = 1_500;

export async function settleWithin(work: Promise<unknown> | undefined, limitMs = QUIT_SETTLE_LIMIT_MS,
  setTimer: (callback: () => void, ms: number) => { clear: () => void } = (callback, ms) => { const id = setTimeout(callback, ms); return { clear: () => clearTimeout(id) }; }): Promise<'settled' | 'timeout'> {
  if (!work) return 'settled';
  let timer: { clear: () => void } | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimer(() => resolve('timeout'), limitMs); });
  try { return await Promise.race([work.then(() => 'settled' as const, () => 'settled' as const), timeout]); }
  finally { timer?.clear(); }
}
