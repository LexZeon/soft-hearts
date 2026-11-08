/**
 * C2: a list read that reaches the host while a character (or conversation) switch is still committing fails with
 * the host's fixed "角色或对话正在切换" (electron/companion.ts currentScope). That is not a failure the user needs to
 * see after "换成她": the panels read again a moment later instead of showing "操作没有完成".
 * Seen in the 2026-11-03 smoke on the base commit too (switching between cards on two models).
 */
export const TRANSIENT_SWITCH_RETRIES = 6;
export const TRANSIENT_SWITCH_DELAY_MS = 200;

export function isTransientSwitch(error: unknown): boolean {
  return /角色或对话正在切换/u.test(error instanceof Error ? error.message : String(error));
}
