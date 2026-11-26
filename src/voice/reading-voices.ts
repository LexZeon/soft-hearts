/**
 * I-209 stage voice: this window reads a line of
 * someone else on the full-screen stage in HER card's voice. The host says whose a line is (ChatStarted.speakerId for her reply to you, the
 * held sense line's `voice` for her chime-in); the reading picks the voice by the line it is reading now (the reply queue's reply, the held
 * line). A line nobody named is the desktop companion's, read exactly as before. Ids only, the last 64.
 */
const KEEP = 64;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

export class ReadingVoices {
  private readonly owners = new Map<string, string>();

  /** Line `id` is `characterId`'s (someone else on stage). */
  own(id: unknown, characterId: unknown): void {
    if (typeof id !== 'string' || !ID.test(id) || typeof characterId !== 'string' || !ID.test(characterId)) return;
    this.owners.delete(id);
    this.owners.set(id, characterId);
    if (this.owners.size > KEEP) this.owners.delete(this.owners.keys().next().value!);
  }

  /** Whose voice reads the first of `ids` that is being read (null: the desktop companion's). */
  speaking(...ids: readonly (string | null | undefined)[]): string | null {
    for (const id of ids) if (id) return this.owners.get(id) ?? null;
    return null;
  }
}

export const readingVoices = new ReadingVoices();
