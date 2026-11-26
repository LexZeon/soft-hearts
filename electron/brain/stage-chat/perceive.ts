/**
 * I-209 step 4 (adopted when the user did not answer: perceive once, everyone gets
 * the facts, each reacts her own way). What the senses saw is taken once (the screen description: one haiku per interval for the desktop
 * companion's watch session; the camera look: shared-senses.ts; the song: one detection) and every character on stage reads the same facts in
 * her turn. No sense opens because a second character came out: these only read what is already there.
 */

/** The watch session as this needs it (electron/senses/watch-notes/session.ts sight): keyed by the character being watched. */
export interface SightSource<T> { sight(characterId: string | null): T | null }

/**
 * The screen as she reads it in her turn: her own when she is the one being watched (the desktop companion); someone else on stage reads
 * the same description the watched one has (one description for everyone). Off stage: nothing (as before).
 */
export function sharedSight<T>(source: SightSource<T> | null | undefined, owner: string | null | undefined, watched: string | null | undefined, onStage: readonly string[]): T | null {
  if (!source || !owner) return null;
  const own = source.sight(owner);
  if (own || !watched || owner === watched || !onStage.includes(owner)) return own;
  return source.sight(watched);
}
