// A reply keeps the voice it started in (changing the voice, rate or provider while she is reading must not cut her off;
// it applies from her next reply). The first sentence of a reply decides its reading voice; later sentences of the same reply get the same
// one, whatever the settings say by then. Pure: the memo of a few recent replies.

export class FrozenReadingVoices<T> {
  private readonly voices = new Map<string, T>();
  constructor(private readonly keep = 16) {}

  /** The reading voice of this reply: made on its first sentence, the same afterwards. */
  of(replyId: string, make: () => T): T {
    if (this.voices.has(replyId)) return this.voices.get(replyId)!;
    const voice = make();
    this.voices.set(replyId, voice);
    while (this.voices.size > this.keep) this.voices.delete(this.voices.keys().next().value as string);
    return voice;
  }

  clear(): void { this.voices.clear(); }
}
