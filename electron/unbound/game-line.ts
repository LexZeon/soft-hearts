/**
 * Her game lines while she is out in full-screen Unbound. The Unbound page has no voice of
 * its own: her chat replies and her own lines are read aloud by the companion window (held lines, src/brain/held-lines.ts), and what is
 * read must be what her bubble shows (electron/unbound/read-aloud.ts). The game's lines used to be painted by the page alone, so nothing
 * could prove them and nothing read them. Now the host takes each new line of the game's view:
 *   - a chat reply is under way: the line is skipped (the game does not count it as said) and the journal says why;
 *   - the line goes into her bubble as a held line (the read-aloud proof covers it); when her bubble cannot be seen it is skipped too;
 *   - read-aloud is off: nothing is read, the journal says so; otherwise the companion window is asked to read it.
 * Pure: the wiring (electron/wiring/initiative-together-wiring.ts) hands it the ports. A line is taken once, by its id.
 */
import type { RpsUnreadWhy } from '../../shared/initiative';

/** true: the companion window was asked to read it; false: it could not be asked (voice-failed); a word: why it was not read. */
export type ReadAnswer = boolean | RpsUnreadWhy;

export interface GameLinePorts {
  /** A chat reply of hers is running: she does not talk over it. */
  chatBusy(): boolean;
  /** The line is in her Unbound bubble now (a held line with the read-aloud proof); false when her bubble cannot be seen. */
  hold(id: string, text: string): boolean;
  voiceOn(): boolean;
  /** The companion window is asked to read the held line (its proof guard is set); false when it could not be asked. */
  read(id: string, text: string): ReadAnswer | Promise<ReadAnswer>;
  /** The game hears the line was not shown, and why (the host's `skipped` answer, with its reason). */
  skipped(id: string, why: RpsUnreadWhy): void;
  /** The line was shown but is not read aloud, and why. */
  unread(why: RpsUnreadWhy): void;
}

/**
 * The voice's guard for one game line (what is spoken must be what is shown): the companion window may play it only while her Unbound bubble
 * is this line and shows exactly its text, asked again before each piece of audio. `proof` is the host's UnboundBubbleProof.
 */
export function gameLineGuard(proof: { readonly currentId: string | null; isPresentationCurrent(text: string): boolean }, id: string, text: string): (line: string) => boolean {
  return line => line === id && proof.currentId === id && proof.isPresentationCurrent(text);
}

/** What the host needs of the companion window to ask it to read one line. */
export interface GameLineCompanion { readonly id: number; send(channel: 'desk:sense-line', value: { id: string; text: string; held: true; game: true }): void }
export interface ReadGameLinePorts {
  /** The companion window (null: gone). */
  companion(): GameLineCompanion | null;
  /** Her Unbound bubble's display proof (null: not out). */
  proof(): { readonly currentId: string | null; isPresentationCurrent(text: string): boolean; waitForPresentation(text: string): Promise<boolean> } | null;
  /**
   * The line's own reading style, frozen for the window that will read it (wiring: beginInitiativeSpeech). The voice refuses a reading whose style was
   * never begun ("这轮角色语音已结束或尚未就绪"), and it refuses quietly: this is why the full-screen 猜拳 lines were shown and never read (found again on candidate 999e9402): the first fix set only the proof guard.
   */
  begin(owner: number, id: string): void;
  /** The voice's guard for the line (wiring: readStageLine). */
  guard(owner: number, id: string, canSpeak: (id: string) => boolean): void;
}

/**
 * One game line, already sent to her bubble, is handed to the companion window to read once her page has painted it (what is spoken is what is
 * shown: the voice's guard needs the page's paint report, which comes some time after the host sent the line; handing it over earlier made the
 * voice refuse it quietly). Resolves true when the window was asked, false when it could not be, 'bubble-hidden' when the bubble was not painted.
 */
export async function readGameLine(ports: ReadGameLinePorts, id: string, text: string): Promise<ReadAnswer> {
  const win = ports.companion(), proof = ports.proof();
  if (!win || !proof) return false;
  let painted = false;
  try { painted = await proof.waitForPresentation(text); } catch { painted = false; }
  if (!painted || proof.currentId !== id || ports.companion()?.id !== win.id) return 'bubble-hidden'; // replaced by a newer line, hidden, or never reported
  try { ports.begin(win.id, id); } catch { return false; } // a style that could not be set up: nothing is read, and the journal says so
  // before the guard and before the window hears of the line: its first sentence may be asked for at once
  ports.guard(win.id, id, gameLineGuard(proof, id, text));
  win.send('desk:sense-line', { id, text, held: true, game: true }); // read only: never remembered (src/brain/held-lines.ts)
  return true;
}

export class GameLineRelay {
  private last = '';
  constructor(private readonly ports: GameLinePorts) {}

  /** Every view the host sends to her Unbound window: a new `say` is relayed once. */
  view(view: { say?: { id: string; text: string } | null } | null): void {
    const say = view?.say;
    if (!say || !say.id || !say.text || say.id === this.last) return;
    this.last = say.id;
    const ports = this.ports;
    try {
      if (ports.chatBusy()) { ports.skipped(say.id, 'busy'); return; }
      if (!ports.hold(say.id, say.text)) { ports.skipped(say.id, 'bubble-hidden'); return; }
      if (!ports.voiceOn()) { ports.unread('voice-off'); return; }
      const settle = (answer: ReadAnswer) => { if (answer === true) return; ports.unread(answer === false ? 'voice-failed' : answer); };
      const answer = ports.read(say.id, say.text);
      if (typeof (answer as Promise<ReadAnswer>).then === 'function') void (answer as Promise<ReadAnswer>).then(settle, () => settle(false)).catch(() => {});
      else settle(answer as ReadAnswer);
    } catch { /* A line that could not be relayed never holds the game: its hold runs out by itself. */ }
  }
}
