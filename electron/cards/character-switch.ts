// C2 "换成她": while she is talking (a chat turn in progress, or her reply being read aloud), the switch waits for
// that line to finish instead of cutting her off; then it goes through the normal activation. The latest request
// wins; an older one that is overtaken resolves to null. A turn that never ends cannot hold the switch forever:
// after `maxWaitMs` it goes ahead (the activation then stops the turn, as switching always did).

export interface CharacterSwitchPorts<T> {
  /** She is talking: a chat turn is running or her reply is being spoken. */
  busy(): boolean;
  /** The activation itself (electron/main.ts activateCharacterCard's steps). */
  activate(id: string): Promise<T>;
  /** Tells the windows a switch is waiting (id) or no longer waiting (null). */
  waiting?(id: string | null): void;
  wait?(ms: number): Promise<void>;
  now?(): number;
  /** Default 30 s. */
  maxWaitMs?: number;
  /** Default 120 ms. */
  pollMs?: number;
}

export class CharacterSwitchGate<T> {
  private generation = 0;
  private target: string | null = null;
  constructor(private readonly ports: CharacterSwitchPorts<T>) {}

  /** The card a switch is waiting to bring in, or null. */
  get pending(): string | null { return this.target; }

  async request(id: string): Promise<T | null> {
    const ticket = ++this.generation;
    const now = this.ports.now ?? Date.now, started = now();
    const wait = this.ports.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const maxWait = this.ports.maxWaitMs ?? 30_000, poll = this.ports.pollMs ?? 120;
    if (this.ports.busy()) {
      this.target = id; this.ports.waiting?.(id);
      while (this.ports.busy() && now() - started < maxWait) {
        await wait(poll);
        if (ticket !== this.generation) return null; // A newer choice took over.
      }
    }
    if (ticket !== this.generation) return null;
    if (this.target !== null) { this.target = null; this.ports.waiting?.(null); }
    return this.ports.activate(id);
  }

  /** The control window closed or the app is quitting: a waiting switch is dropped. */
  cancel(): void {
    this.generation++;
    if (this.target !== null) { this.target = null; this.ports.waiting?.(null); }
  }
}

/**
 * Switching to a card (the 角色页's 换成她, 启用此角色, the internal channel's activate_character; docs/claude/2026-11-23-switch-lock.md).
 * The card store moves first, because every part catches up by reading its active card. When that catch-up fails and her
 * conversation did not move to the card, the card store goes back to the character the conversation is still with: the 角色页
 * never shows 「正在陪着你」 for a switch that did not happen (user evidence 2026-11-23: the page showed one card while the
 * conversation was held by another).
 */
export interface CardActivationPorts<T> {
  /** The card store's active card (CharacterCardStore.activate). */
  activate(id: string): Promise<unknown>;
  /** Every part catches up with the active card (cards-wiring syncCharacter). */
  catchUp(): Promise<T>;
  /** The character her conversation is with now; null while it is switching or not ready. */
  conversationCharacter(): string | null;
  /** After a failed switch: the card store, and every part with it, back on `id`. Best effort: the original failure is what the caller sees. */
  restore(id: string): Promise<unknown>;
}

export async function activateCardCommitted<T>(previousId: string, targetId: string, ports: CardActivationPorts<T>): Promise<T> {
  await ports.activate(targetId);
  try {
    return await ports.catchUp();
  } catch (error) {
    const withNow = ports.conversationCharacter();
    if (withNow !== targetId) {
      try { await ports.restore(withNow ?? previousId); } catch { /* the switch's own failure is what the caller sees */ }
    }
    throw error;
  }
}
