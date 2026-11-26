/**
 * I-209 step 2: every brain turn
 * belongs to one character, from where it starts to where it is archived. This file keeps, per character, the one number that says
 * whether her turns are still current, and the seats of the characters on the full-screen stage besides the one the desktop companion
 * talks with (step 1's presence, electron/unbound/company/host.ts).
 *
 *  - A character's generation moves when HER context changes (she is switched away from, her conversation is new, a chat of hers was
 *    deleted, the connection changed). A turn compares the generation it started under; another character's change never touches it.
 *    So switching the desktop companion stops the outgoing one's turn exactly as before, and never the turn of someone else on stage.
 *  - A seat is an on-stage character's own conversation (the one she talked in last on this connection, or a new one) and the opening
 *    she was last given. She leaves the stage: her generation moves and her seat goes; the companion's are kept in CompanionService.
 * Pure (no I/O): CompanionService calls it; tests/i209-turn-owner.test.ts drives it directly too.
 */

/** An on-stage character's own context besides the companion's (her scope's providerScope is the companion's). */
export interface OwnerSeat {
  readonly characterId: string;
  readonly providerScope: string;
  conversationId: string;
  /** The conversation the relationship opening was last given in (CompanionService's relationshipOpened, per seat). */
  opened: string;
}

/** Which characters' turns a context change stops. 'all': every turn (the first context, or another connection). */
export type OwnersStopped = 'all' | readonly string[];

/**
 * The companion's context changes from `from` to `to` (CompanionService.context): whose turns stop now. The same character (her persona
 * changed in place): hers. Another connection: everyone's (every scope changes). Another character: only the outgoing one's.
 */
export function switchStops(from: { characterId: string; providerScope: string } | null, to: { characterId: string; providerScope: string }): OwnersStopped {
  if (!from || from.providerScope !== to.providerScope) return 'all';
  return [from.characterId];
}

export class TurnOwners {
  private readonly generations = new Map<string, number>();
  private readonly seatMap = new Map<string, OwnerSeat>();
  private all = 0;

  /** The generation her turns start under; a turn is current while it is unchanged. */
  generation(characterId: string): number { return this.all * 1_000_003 + (this.generations.get(characterId) ?? 0); }

  /** Her turns (or everyone's) are no longer current: synchronous, before any await of the change that caused it. */
  bump(stopped: OwnersStopped): void {
    if (stopped === 'all') { this.all++; return; }
    for (const id of stopped) this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }

  /** Whether a turn of `characterId` that started under `generation` is still hers to finish. */
  current(characterId: string, generation: number): boolean { return this.generation(characterId) === generation; }

  /** The seat of an on-stage character besides the companion, or null. */
  seat(characterId: string): OwnerSeat | null { return this.seatMap.get(characterId) ?? null; }

  /** The characters on stage besides the companion, in the order they came. */
  ids(): string[] { return [...this.seatMap.keys()]; }

  /**
   * The stage now holds `ids` besides `companionId` (step 1's presence) under `providerScope`. A newcomer gets a seat in
   * `conversationFor(id)`; one who left loses hers and her turns stop (her generation moves). A seat kept from another connection is
   * new (left and joined). Returns who joined and who left, so the caller seals the leavers' conversations.
   */
  present(ids: readonly string[], companionId: string | null, providerScope: string, conversationFor: (characterId: string) => string): { joined: string[]; left: OwnerSeat[] } {
    const wanted = [...new Set(ids)].filter(id => id && id !== companionId);
    const left: OwnerSeat[] = [];
    for (const seat of [...this.seatMap.values()]) {
      if (wanted.includes(seat.characterId) && seat.providerScope === providerScope) continue;
      // Becoming the desktop companion (a switch still committing): her seat waits for take(), so a turn of hers is not cut.
      if (seat.characterId === companionId && seat.providerScope === providerScope) continue;
      this.seatMap.delete(seat.characterId);
      this.bump([seat.characterId]);
      left.push(seat);
    }
    const joined: string[] = [];
    for (const id of wanted) {
      if (this.seatMap.has(id)) continue;
      this.seatMap.set(id, { characterId: id, providerScope, conversationId: conversationFor(id), opened: '' });
      joined.push(id);
    }
    return { joined, left };
  }

  /**
   * The desktop companion becomes `characterId`: if she had a seat, it is handed over (her conversation and opening carry on, her
   * generation does not move, so a turn of hers in flight stays current). Null when she was not on stage.
   */
  take(characterId: string): OwnerSeat | null {
    const seat = this.seatMap.get(characterId) ?? null;
    if (seat) this.seatMap.delete(characterId);
    return seat;
  }
}

/**
 * A change of the desktop companion's context (electron/wiring/cards-wiring.ts syncCharacter: another card, her persona, her model; or her
 * card deleted) aborts a chat task only when the task is hers: `outgoing` is the card she was. A task without an owner (before I-209) is
 * aborted as always. Another one on stage keeps talking.
 */
export function companionChangeStops(taskOwner: string | undefined, outgoing: string): boolean {
  return !taskOwner || taskOwner === outgoing;
}

/** What a turn-owner reader needs of CompanionService. */
export interface OwnerReader {
  currentScope(): { characterId: string; providerScope: string };
  speechScopeOf(characterId?: string): string;
}

/**
 * What a turn of `owner` is accepted under, as the chat wiring and the session pool both read it: the desktop companion's is the voice
 * part's speechScope (it has her 3D model in it, as before); someone else on stage: her own (CompanionService.speechScopeOf). Throws while
 * switching, or when she is not on stage.
 */
export function ownerSpeechScope(companion: OwnerReader, owner: string | undefined, companionSpeechScope: () => string): string {
  return !owner || owner === companion.currentScope().characterId ? companionSpeechScope() : companion.speechScopeOf(owner);
}
