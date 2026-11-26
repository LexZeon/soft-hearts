// The shape of a Claude Code stream-json event kind that may be journaled (docs/claude/2026-11-25-peer-messages-refused.md):
// its `type`, and for `system` its `subtype`, only when they look like Claude Code's own identifiers. Anything else becomes the
// word "odd", so no text a field could carry (a message, a path, a name) ever reaches a journal line.

const IDENTIFIER = /^[a-z][a-z0-9_]{0,39}$/;

/** An identifier-shaped kind name, or "odd". */
export function streamKindName(value: unknown): string {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : 'odd';
}

/** True when `value` is something streamKindName could have returned. */
export function isStreamKindName(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}
