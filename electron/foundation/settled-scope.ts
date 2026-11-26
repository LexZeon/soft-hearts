/**
 * The conversation's scope for code that only cleans up or looks (docs/claude/2026-11-23-switch-lock.md): null while a context change
 * is settling or before the conversation is ready, never a throw. The companion's currentScope() throws "角色或对话正在切换" in that
 * window, which is right for anything that would write under a scope; a cleanup step that throws there instead stops the very
 * switch that would end the window (user evidence 2026-11-23: stopping the computer's sound ran before the switch and threw, so no
 * switch could ever reach the conversation again).
 */
export function settledScope<S>(companion: { currentScope(): S } | null | undefined): S | null {
  if (!companion) return null;
  try { return companion.currentScope(); } catch { return null; }
}
