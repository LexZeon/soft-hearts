/**
 * I-159 C: the card beside her. A card she offers (a sense, a setting) while she is out in Unbound would
 * otherwise appear only in the control window's chat, where the user is not looking. This shows the same card in a small window next
 * to her head and passes the one tap back to the host's own card path (ChatSettingProposals.chooseMirrored: the same live card, the
 * same consent rules, the same applier). It opens nothing by itself and is not a second route to any permission:
 *  - it shows only while she is out, and only the card the host offered (it never builds one);
 *  - a tap is passed on only for the card that is on screen here, and only while she is out;
 *  - the window takes one input, a tap on that card's button (card-preload-api.ts).
 * Ports, so tests drive it without Electron.
 */
import type { ChatSettingCardView } from '../../shared/brain';
import type { UnboundState } from '../../shared/unbound/scene';
import type { HeadSpot } from '../../shared/unbound/typing';
import { placeInputBox } from '../../shared/unbound/typing';
import type { Rect } from '../../shared/unbound/world';

export const CARD_SIZE = Object.freeze({ width: 340, height: 250 });
/** A settled card stays readable this long (its one-line result), then the window hides. */
export const CARD_SETTLED_MS = 6_000;

export interface CardWindowPort {
  /** Shows the window at the rectangle (without taking the keyboard) and sends it the card. */
  show(rect: Rect, card: ChatSettingCardView): void;
  /** Sends an update to the window already shown. */
  push(card: ChatSettingCardView): void;
  hide(): void;
  destroy(): void;
}
export interface CardSurfacePorts {
  state(): UnboundState;
  window(): Rect | null;
  askHead(): Promise<HeadSpot | null>;
  view: CardWindowPort;
  /** The host's card path for a tap (ChatSettingProposals.chooseMirrored). */
  choose(request: { proposalId: string; choiceId: string }): Promise<unknown>;
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/**
 * The card window answers a tap only from its own window and its top frame (the Electron event, as plain fields so a test can check it).
 * `ownId` is the card window's web contents id, null when there is no live card window.
 */
export function cardRequestAllowed(ownId: number | null, event: { sender: { id: number; mainFrame?: unknown }; senderFrame?: unknown }): boolean {
  return ownId !== null && event.sender.id === ownId && event.senderFrame === event.sender.mainFrame;
}

const settled = (card: ChatSettingCardView) => card.state !== 'open' && card.state !== 'busy';

export class UnboundCardSurface {
  /** The card on screen here (the only one a tap may name). */
  private shownId: string | null = null;
  private hideTimer: unknown = null;
  /** The newest state of that card (an update can arrive while the window is still being placed). */
  private latest: ChatSettingCardView | null = null;
  private ticket = 0;
  private readonly timers: NonNullable<CardSurfacePorts['timers']>;
  constructor(private readonly ports: CardSurfacePorts) {
    this.timers = ports.timers ?? { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  get shownProposal(): string | null { return this.shownId; }

  /** Every card or update the host sends to the owning window; here only while she is out. */
  async offer(card: ChatSettingCardView): Promise<void> {
    if (this.ports.state() !== 'unbound') return;
    if (card.proposalId === this.shownId) { this.latest = card; this.ports.view.push(card); this.afterUpdate(card); return; }
    if (card.state !== 'open') return; // an update for a card this window never showed
    const ticket = ++this.ticket;
    this.clearTimer();
    this.shownId = card.proposalId; this.latest = card; // from now on only this card can be tapped here
    let head: HeadSpot | null = null;
    try { head = await this.ports.askHead(); } catch { head = null; }
    if (ticket !== this.ticket || this.ports.state() !== 'unbound') return;
    const area = this.ports.window();
    if (!area) { this.shownId = null; return; }
    const spot = head ? { x: area.x + head.x, y: area.y + head.y, r: head.r } : null;
    const rect = placeInputBox(spot, area, CARD_SIZE);
    this.ports.view.show({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, this.latest ?? card);
  }

  /** A tap from the card window: only the card shown here, only while she is out; the host's own path does the rest. */
  async choose(request: unknown): Promise<unknown> {
    const raw = request && typeof request === 'object' && !Array.isArray(request) ? request as Record<string, unknown> : {};
    if (this.ports.state() !== 'unbound' || !this.shownId) return null;
    if (typeof raw.proposalId !== 'string' || raw.proposalId !== this.shownId || typeof raw.choiceId !== 'string') return null;
    return this.ports.choose({ proposalId: raw.proposalId, choiceId: raw.choiceId });
  }

  /** The card is gone from here (she went back, or the app is quitting). */
  modeChanged(state: UnboundState): void {
    if (state === 'unbound') return;
    this.clear();
    this.ports.view.destroy();
  }

  quit(): void { this.clear(); this.ports.view.destroy(); }

  private afterUpdate(card: ChatSettingCardView): void {
    if (!settled(card)) return;
    this.clearTimer();
    this.hideTimer = this.timers.set(() => { this.hideTimer = null; this.shownId = null; this.ports.view.hide(); }, CARD_SETTLED_MS);
  }

  private clear(): void { this.ticket++; this.shownId = null; this.clearTimer(); }
  private clearTimer(): void { if (this.hideTimer !== null) this.timers.clear(this.hideTimer); this.hideTimer = null; }
}
