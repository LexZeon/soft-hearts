// The environment of every Claude Code process the app starts: chat (one-shot, warm, spare, haiku helpers), the Claude assistant,
// the task executor and the `claude mcp add/list/--version` runs (docs/claude/2026-11-25-claude-env-from-session.md). Every spawn
// takes its env from claudeEnvironment (tests/claude-env-from-session.test.ts lists them and fails on a new spawn that does not).
//
// 1. A parent Claude Code session's own wiring never goes through: every CLAUDE* variable except the user's auth and provider
//    choices below, and ELECTRON_RUN_AS_NODE.
// 2. When the app itself was started from inside a Claude Code session (a marker in its environment, shared/brain/claude-session-env.ts),
//    that session's endpoint and credential plumbing (ANTHROPIC_BASE_URL pointing at the desktop app's proxy, auth tokens, custom
//    headers) is dropped too, so her processes use the user's own Claude Code sign-in. Without a marker those are the user's
//    deliberate global setting and are kept.
// 3. When (2) dropped something, the journal gets one row per app run with the names only (electron/wiring/brain-wiring.ts). No value
//    is ever written, logged or returned anywhere but the child's environment.
import { sessionPlumbingToDrop } from '../../shared/brain/claude-session-env';

// Keep the user's own auth/provider choices; drop everything that identifies or connects to a parent Claude Code session (session
// ids, sockets, entrypoints, late MCP servers), so a companion started from inside Claude Code stays isolated.
const KEPT_CLAUDE_VARIABLES = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
]);

export type ClaudeEnvironmentObserver = (names: string[]) => void;
let observer: ClaudeEnvironmentObserver | null = null;
let pending: string[] | null = null;
let reported = false;

/** The app's journal hook (electron/wiring/brain-wiring.ts); a drop seen before it was attached is reported on attach. null removes it. */
export function observeClaudeEnvironment(next: ClaudeEnvironmentObserver | null): void {
  observer = next;
  if (next && pending && !reported) report(pending);
}

/** Test seam: forget that this run already reported. */
export function resetClaudeEnvironmentReport(): void { pending = null; reported = false; }

function report(names: string[]): void {
  if (reported) return;
  if (!observer) { pending = names; return; }
  reported = true;
  pending = null;
  try { observer([...names]); } catch { /* A journal row never affects a spawn. */ }
}

export function claudeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dropped = new Set(sessionPlumbingToDrop(source));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (dropped.has(upper)) continue;
    if (upper.startsWith('CLAUDE') && !KEPT_CLAUDE_VARIABLES.has(upper)) continue;
    if (upper === 'ELECTRON_RUN_AS_NODE') continue;
    env[key] = value;
  }
  env.NO_COLOR = '1';
  // One short-lived process per reply: skip the background update check.
  env.DISABLE_AUTOUPDATER = '1';
  if (dropped.size) report([...dropped]);
  return env;
}
