/**
 * I-086 她也照顾你, companion window (docs/claude/2026-11-11-i086-give-and-keep.md): the host's offer starts the stage (her arm reaching
 * toward you, or the cushion pushed over); a soft round target sits on what she holds out, and a click on it is "you took it". Her
 * words are not here: her line already came through the ordinary bubble and voice before the stage started. A pat, a snack or the
 * window hiding mid-offer: she takes it back (interrupted). On a special moment the stage renders one frame of her (never the camera
 * or the screen) and hands it to the host; her picture card comes back here with her line and a "存下来" button.
 */
import { registerUiMessages } from '../../shared/foundation/ui-language';
import type { GiveAnswer, GiveEvent, GiveOfferEvent } from '../../shared/behaviors/give/interface';
import type { GiveStageCue, GiveStageOutcome } from './give-performance';
import { uiText } from '../foundation/ui-language';

registerUiMessages({
  en: { '接住': 'Take it', '她给你的图': 'A picture she left you', '存下来': 'Save', '收好了': 'Saved', '关上': 'Close' },
  'zh-CN': {},
});

export interface GiveOverlayAPI {
  onGive(callback: (event: GiveEvent) => void): () => void;
  giveAnswer(answer: GiveAnswer): Promise<boolean>;
  givePicture(input: { id: string; png: string }): Promise<boolean>;
  saveGivePicture(input: { id: string }): Promise<boolean>;
}
export interface GiveOverlayStage {
  startGive(cue: GiveStageCue, onOutcome?: (id: string, outcome: GiveStageOutcome) => void): void;
  takeGive(): boolean;
  withdrawGive(outcome?: 'not-taken' | 'interrupted'): void;
  giveAnchor(): { x: number; y: number; r: number } | null;
  captureGivePicture(maxChars?: number): string | null;
}
interface Doc { createElement(tag: string): HTMLElement }

/** How long into the hold (ms) her picture is taken, so her arm and the snack are settled in it. */
export const GIVE_CAPTURE_AFTER_MS = 700;
/** Her picture card stays this long unless closed or saved (ms). */
export const GIVE_CARD_MS = 90_000;

export class GiveOverlay {
  private readonly target: HTMLButtonElement;
  private readonly cardEl: HTMLElement;
  private readonly cardImage: HTMLImageElement;
  private readonly cardLine: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private unsubscribe: (() => void) | null = null;
  private offer: GiveOfferEvent | null = null;
  private heldSince: number | null = null;
  private captured = false;
  private raf = 0;
  private cardId: string | null = null;
  private cardTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement, private readonly api: GiveOverlayAPI, private readonly stage: GiveOverlayStage, private readonly options: {
    /** A pat, a snack, a drag or a hidden window right now: an offer does not start (and one on the stage goes back). */
    blocked?: () => boolean;
    now?: () => number;
    frame?: (callback: () => void) => number;
    cancelFrame?: (handle: number) => void;
    document?: Doc;
  } = {}) {
    const doc = options.document ?? document;
    const el = <T extends HTMLElement>(tag: string, className: string) => { const node = doc.createElement(tag) as T; node.className = className; return node; };
    this.target = el<HTMLButtonElement>('button', 'give-target');
    this.target.type = 'button'; this.target.hidden = true;
    this.target.style.outline = 'none'; // no focus ring (2026-11-21): the dashed target already shows where to click
    this.target.setAttribute('aria-label', uiText('接住')); // no title: an invisible target must not pop a lone tooltip (2026-11-22, the same as 牵手)
    // A companion control area: pointer events here are this button, never a pat or a pinch (MoodCompanion isPetControlPoint).
    this.target.dataset.moodUi = 'true';
    this.target.onclick = () => { if (this.offer) this.stage.takeGive(); };
    this.cardEl = el('div', 'give-card'); this.cardEl.hidden = true; this.cardEl.dataset.moodUi = 'true';
    this.cardEl.setAttribute('role', 'group'); this.cardEl.setAttribute('aria-label', uiText('她给你的图'));
    this.cardImage = el<HTMLImageElement>('img', 'give-card-image'); this.cardImage.alt = uiText('她给你的图');
    this.cardLine = el('div', 'give-card-line');
    const actions = el('div', 'give-card-actions');
    this.saveButton = el<HTMLButtonElement>('button', 'give-card-save'); this.saveButton.type = 'button'; this.saveButton.textContent = uiText('存下来');
    this.saveButton.onclick = () => { const id = this.cardId; if (id) void this.api.saveGivePicture({ id }).then(saved => { if (saved) this.saveButton.textContent = uiText('收好了'); }).catch(() => {}); };
    const close = el<HTMLButtonElement>('button', 'give-card-close'); close.type = 'button'; close.textContent = '×';
    close.setAttribute('aria-label', uiText('关上')); close.onclick = () => this.hideCard();
    actions.append(this.saveButton, close);
    this.cardEl.append(this.cardImage, this.cardLine, actions);
    parent.append(this.target, this.cardEl);
  }

  init(): void {
    if (this.unsubscribe) return;
    const stop = this.api.onGive(event => this.receive(event));
    // The window hid mid-offer: she takes it back (she does not hold it out to nobody).
    const hidden = () => { if (typeof document !== 'undefined' && document.hidden) this.interrupt(); };
    const watch = !this.options.document && typeof document !== 'undefined' && typeof document.addEventListener === 'function';
    if (watch) document.addEventListener('visibilitychange', hidden);
    this.unsubscribe = () => { stop(); if (watch) document.removeEventListener('visibilitychange', hidden); };
  }

  /** The host's events (desk:give). */
  receive(event: GiveEvent): void {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'offer') this.start(event);
    else if (event.type === 'cancel') { if (this.offer?.id === event.id) this.stage.withdrawGive('interrupted'); }
    else if (event.type === 'card') this.showCard(event.id, event.line, event.picture);
  }

  /** A pat, a snack, a drag or the window hiding started: what she holds out goes back. */
  interrupt(): void { if (this.offer) this.stage.withdrawGive('interrupted'); }

  private start(offer: GiveOfferEvent): void {
    if (this.offer) this.stage.withdrawGive('interrupted');
    if (this.options.blocked?.() === true) { void this.api.giveAnswer({ id: offer.id, outcome: 'interrupted' }).catch(() => {}); return; }
    this.offer = offer; this.heldSince = null; this.captured = false;
    this.stage.startGive({ id: offer.id, stage: offer.stage, prop: offer.prop, playful: offer.playful, picture: offer.picture, waitMs: offer.waitMs },
      (id, outcome) => this.ended(id, outcome));
    this.loop();
  }

  private ended(id: string, outcome: GiveStageOutcome): void {
    if (this.offer?.id === id) { this.offer = null; this.target.hidden = true; }
    void this.api.giveAnswer({ id, outcome }).catch(() => {});
  }

  private now(): number { return (this.options.now ?? (() => performance.now()))(); }

  /** Each frame while an offer is out: the click target follows what she holds out; on a special moment her picture is taken once. */
  private loop(): void {
    const frame = this.options.frame ?? (callback => requestAnimationFrame(callback));
    const step = () => {
      this.raf = 0;
      const offer = this.offer;
      if (!offer) { this.target.hidden = true; return; }
      const anchor = this.stage.giveAnchor();
      if (anchor) {
        const size = Math.round(anchor.r * 2);
        this.target.style.left = `${Math.round(anchor.x - anchor.r)}px`; this.target.style.top = `${Math.round(anchor.y - anchor.r)}px`;
        this.target.style.width = this.target.style.height = `${size}px`;
        this.target.hidden = false;
        this.heldSince ??= this.now();
        if (offer.capture && !this.captured && this.now() - this.heldSince >= GIVE_CAPTURE_AFTER_MS) {
          this.captured = true;
          let png: string | null = null;
          try { png = this.stage.captureGivePicture(); } catch { png = null; }
          if (png) void this.api.givePicture({ id: offer.id, png }).catch(() => {});
        }
      } else this.target.hidden = true;
      this.raf = frame(step);
    };
    if (!this.raf) this.raf = frame(step);
  }

  private showCard(id: string, line: string, picture: string): void {
    if (typeof picture !== 'string' || !picture.startsWith('data:image/png;base64,')) return;
    this.cardId = id;
    this.cardImage.src = picture;
    this.cardLine.textContent = typeof line === 'string' ? line : '';
    this.saveButton.textContent = uiText('存下来');
    this.cardEl.hidden = false;
    if (this.cardTimer) clearTimeout(this.cardTimer);
    this.cardTimer = setTimeout(() => this.hideCard(), GIVE_CARD_MS);
  }

  private hideCard(): void {
    this.cardEl.hidden = true; this.cardId = null;
    if (this.cardTimer) { clearTimeout(this.cardTimer); this.cardTimer = null; }
  }

  dispose(): void {
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.raf) (this.options.cancelFrame ?? (handle => cancelAnimationFrame(handle)))(this.raf);
    this.raf = 0;
    this.hideCard();
  }
}
