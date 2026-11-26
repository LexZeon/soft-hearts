// Which inherited variables belong to a parent Claude Code session's connection, not to the user
// (docs/claude/2026-11-25-claude-env-from-session.md). Pure and dependency-free: the main process (electron/brain/claude-env.ts)
// applies it to every Claude Code process the app starts, the journal check (shared/brain/journal-entries.ts) uses it to accept
// names only, and scripts/setup.ps1 keeps the same two lists for the launch (a test compares them).
//
// The rule: when the app's own environment carries a marker that Claude Code sets for the shells and programs it starts, the
// endpoint and credential variables came with that session (the Claude desktop app points ANTHROPIC_BASE_URL at its own local
// proxy, which goes away with the session and is not the user's own sign-in), so they never reach her processes. Without a
// marker they are the user's deliberate global setting and are kept. Only names leave this module, never a value.

/**
 * Set by Claude Code (CLI, desktop app's Code tab, Agent SDK hosts) for the processes it starts. Seen on 2026-11-25 in a desktop
 * session's shell: CLAUDECODE, CLAUDE_CODE_ENTRYPOINT (claude-desktop), CLAUDE_CODE_EXECPATH, CLAUDE_CODE_SESSION_ID,
 * CLAUDE_CODE_HOST_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_DESKTOP_APP_VERSION, CLAUDE_AGENT_SDK_VERSION; IDE sessions
 * add CLAUDE_CODE_SSE_PORT. Any one of them, non-empty, counts.
 */
export const CLAUDE_SESSION_MARKERS: readonly string[] = Object.freeze([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_DESKTOP_APP_VERSION', 'CLAUDE_AGENT_SDK_VERSION',
]);

/**
 * Endpoint and credential plumbing dropped when a marker is present. CLAUDE_CODE_OAUTH_TOKEN is on the list because a session host
 * can hand its own token to the programs it starts; without a marker it is the user's `claude setup-token` and is kept.
 * Any other ANTHROPIC_* name ending in _URL, _TOKEN, _KEY, _HEADERS or _SOCKET counts too (see isSessionPlumbing).
 */
export const CLAUDE_SESSION_PLUMBING: readonly string[] = Object.freeze([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_OAUTH_TOKEN',
]);
const PLUMBING_SHAPE = /^ANTHROPIC_[A-Z0-9_]*(?:_URL|_TOKEN|_KEY|_HEADERS|_SOCKET)$/;
const MARKERS = new Set(CLAUDE_SESSION_MARKERS);
const PLUMBING = new Set(CLAUDE_SESSION_PLUMBING);

/** Whether `name` (any case: Windows variable names are) is endpoint or credential plumbing. */
export function isSessionPlumbing(name: string): boolean {
  const upper = name.toUpperCase();
  return PLUMBING.has(upper) || PLUMBING_SHAPE.test(upper);
}

/** The marker names present (non-empty) in `env`, upper-case, in CLAUDE_SESSION_MARKERS order. Never a value. */
export function claudeSessionMarkers(env: Readonly<Record<string, string | undefined>>): string[] {
  const present = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (MARKERS.has(upper) && typeof value === 'string' && value.trim() !== '') present.add(upper);
  }
  return CLAUDE_SESSION_MARKERS.filter(name => present.has(name));
}

/**
 * The variable names to leave out of a child's environment under the rule: the plumbing names present in `env` when a marker is,
 * none otherwise. Upper-case, sorted, without duplicates.
 */
export function sessionPlumbingToDrop(env: Readonly<Record<string, string | undefined>>): string[] {
  if (!claudeSessionMarkers(env).length) return [];
  const names = new Set<string>();
  for (const key of Object.keys(env)) if (isSessionPlumbing(key)) names.add(key.toUpperCase());
  return [...names].sort();
}

/** A journal-safe name: identifier-shaped and plumbing (the journal check accepts nothing else). */
export function isJournalPlumbingName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) && isSessionPlumbing(value);
}
