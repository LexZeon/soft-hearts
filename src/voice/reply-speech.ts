const MAX_EARLY_ENDS = 8;

/**
 * Match chat-only playback to unique host chat IDs, independently of generation.
 * Cross-window end messages can precede begin/expect; retain only eight IDs.
 * Callers validate completion messages and never reuse a completed chat ID.
 * Unrelated edits to inactive character cards must not invalidate playback ends.
 */
export class ReplySpeechState {
  private currentId: string | null = null;
  private expected = false;
  private ended = false;
  private readonly earlyEnded = new Set<string>();

  get pending(): boolean { return this.expected && !this.ended; }
  matches(id: string): boolean { return this.currentId === id; }

  begin(id: string): void {
    if (id === this.currentId) return;
    this.currentId = id;
    this.expected = false;
    this.ended = this.earlyEnded.delete(id);
  }

  /** True only for the first matching expectation; read pending after applying. */
  expect(id: string): boolean {
    if (id !== this.currentId || this.expected) return false;
    this.expected = true;
    return true;
  }

  /** Unknown IDs are cached but return false, so they cannot change the UI. */
  end(id: string): boolean {
    if (id !== this.currentId) {
      this.earlyEnded.add(id);
      if (this.earlyEnded.size > MAX_EARLY_ENDS) this.earlyEnded.delete(this.earlyEnded.values().next().value!);
      return false;
    }
    if (this.ended) return false;
    this.ended = true;
    return true;
  }

  clear(): void {
    this.currentId = null;
    this.expected = this.ended = false;
    this.earlyEnded.clear();
  }
}
