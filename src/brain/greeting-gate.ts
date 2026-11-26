import type { RecentChat } from '../../shared/memory';

/**
 * 2026-11-25 (docs/claude/2026-11-25-greeting-on-switch.md). Her card's greeting is for a character who never opened with the user.
 * On a switch, a start or a refill the window asks the host (RecentChat.opened: an ordinary chat of hers, or her greeting shown before,
 * under any connection) and shows the greeting only when she has not opened, the answer is for the character the request was made for,
 * she is still the active one, and this window has not greeted her already this run (the guard when the archive is off and the host
 * cannot say). A failed call is no answer and shows nothing. The explicit "new conversation" is the user's own act and does not go
 * through here.
 */
export function mayShowOpeningGreeting(recent: RecentChat | null | undefined, requestedFor: string | null, activeNow: string | null, greetedThisRun: ReadonlySet<string>): boolean {
  if (!recent || !requestedFor || recent.characterId !== requestedFor || activeNow !== requestedFor) return false;
  if (recent.opened === true) return false;
  if (Array.isArray(recent.messages) && recent.messages.length) return false;
  return !greetedThisRun.has(requestedFor);
}
