

/** What the presenter needs from its window (src/wiring/greeting-wiring.ts builds it from the real ones; tests give fakes). */
export interface GreetingPorts {
  /** The active card: its id and its greeting text ('' for none), or null. */
  card(): { id: string; greeting: string } | null;
  /** The companion window shows her as a bubble (its id is the reply id of the line); the chat page draws a row. */
  companionBubble: ((text: string, id: string, expectsSpeech: boolean) => void) | null;
  row(text: string): void;
  /** Read-aloud is on and she can be heard now. */
  mayVoice(): boolean;
  stopSpeech(): void;
  speak(text: string, id: string): Promise<unknown>;
  ended(id: string): void;
  /** The host archives the card's own greeting and writes one journal row (no text; it knows why). */
  remember(): void;
  newId(): string;
}

/**
 * 2026-11-25: her card's greeting shown in one window. In the companion window it is her bubble, read aloud in her voice like any line she
 * says when read-aloud is on (before this it was silent); in the chat page it is a row. Returns the text shown, or null without a greeting.
 * Whether to show it at all is src/brain/greeting-gate.ts, decided before this is called.
 */
export function presentGreetingLine(ports: GreetingPorts, greeted: Set<string>): string | null {
  const card = ports.card();
  const greeting = card?.greeting.trim();
  if (!card || !greeting) return null;
  greeted.add(card.id);
  if (ports.companionBubble) {
    const id = ports.newId(), voiced = ports.mayVoice();
    ports.companionBubble(greeting, id, voiced);
    if (voiced) {
      ports.stopSpeech();
      const ended = () => ports.ended(id);
      void ports.speak(greeting, id).then(ended, ended);
    }
  } else ports.row(greeting);
  ports.remember();
  return greeting;
}
