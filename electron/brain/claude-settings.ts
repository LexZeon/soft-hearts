// The one `--settings` value every Claude Code process this app starts carries (docs/claude/2026-11-25-peer-messages-refused.md;
// docs/claude/brain-interface.md lists it). Claude Code 2.1.224+ (2.1.234+ on native Windows) binds an inbox for every session,
// `claude -p` included, so each of our processes showed up as a peer of the user's other Claude Code sessions, and a peer's message
// "arrives as plain text" in its context. Only the user's own words count (CLAUDE.md), so every process refuses them:
//   crossSessionInbound "refuse": Claude Code drops each inbound peer message without delivering it; a `--settings` value wins over
//     the user's own settings (https://code.claude.com/docs/en/cross-session-messaging.md, "Turn off cross-session messaging").
//   permissions.deny SendMessage, ListAgents: the bare tool names that send and list (the same page); our processes start with no
//     such tool anyway (init with any unexpected tool stops the turn), this is the second lock.
// `--bare` would hide the process from the list too, but it breaks the subscription login, so it is not used.
// Every argv builder takes its `--settings` from claudeSettingsArguments (tests/claude-peer-refuse.test.ts finds every builder).

export const PEER_DENIED_TOOLS: readonly string[] = Object.freeze(['SendMessage', 'ListAgents']);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * A builder's own settings with the peer lockdown merged in: `crossSessionInbound` is always "refuse" (a caller's value never wins),
 * `permissions.deny` keeps the caller's rules and adds the two peer tools once; every other key is kept as given.
 */
export function lockedClaudeSettings(own: Record<string, unknown> = {}): Record<string, unknown> {
  const permissions = isRecord(own.permissions) ? own.permissions : {};
  const deny = Array.isArray(permissions.deny) ? permissions.deny.filter((rule): rule is string => typeof rule === 'string') : [];
  return {
    ...own,
    permissions: { ...permissions, deny: [...new Set([...deny, ...PEER_DENIED_TOOLS])] },
    crossSessionInbound: 'refuse',
  };
}

/** `['--settings', <json>]`: the only way a builder passes settings. One argv element, spawned without a shell. */
export function claudeSettingsArguments(own: Record<string, unknown> = {}): string[] {
  return ['--settings', JSON.stringify(lockedClaudeSettings(own))];
}
