import { uiText } from './ui-language';

/**
 * 屏幕只读大概 (I-015):
 * when she asks "要我凑近看看吗" with screen sharing on (the host hears it in her reply, electron/look-turns.ts noteOffer), the pet shows
 * a small prompt in its chat area, styled like her other cards there: "让她看清楚屏幕吗？" with 看吧 / 不用.
 *  - 看吧: the same as "给她看看屏幕" — what is typed, or "看吧。", goes with the screen taken right then (src/main.ts `look`).
 *  - 不用: like answering "不用" in words — the offer closes without a frame (preload `declineLookOffer`).
 *  - Answering in words ("嗯", "看吧", "不用") still works; any message closes it, and so do the offer's time running out, a new
 *    conversation, and sharing turned off (the host's `desk:look-offer` with null).
 * Registered in src/ui/pet-popups.ts (I-028) as part of the conversation: folding the toolbar does not answer it for the user.
 * Text from the host is never markup: the prompt's words are fixed here.
 */
export const LOOK_OFFER_QUESTION = '让她看清楚屏幕吗？';
export const LOOK_OFFER_YES = '看吧';
export const LOOK_OFFER_NO = '不用';
/** What "看吧" sends when the box is empty (her question's answer, in the user's words). */
export const LOOK_OFFER_MESSAGE = '看吧。';
/** The longest a prompt stays up, whatever the host says (the host's own offer lasts 10 minutes). */
const MAX_TTL_MS = 10 * 60_000;

export interface LookOfferView { id: string; ttlMs: number }

/** The host's event, read strictly: an offer to show, null to close, undefined for anything malformed (ignored). */
export function readLookOffer(value: unknown): LookOfferView | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const view = value as Record<string, unknown>;
  if (Object.keys(view).some(key => key !== 'id' && key !== 'ttlMs')) return undefined;
  if (typeof view.id !== 'string' || !/^[0-9a-f-]{8,64}$/iu.test(view.id) || typeof view.ttlMs !== 'number'
    || !Number.isFinite(view.ttlMs) || view.ttlMs <= 0) return undefined;
  return { id: view.id, ttlMs: Math.min(view.ttlMs, MAX_TTL_MS) };
}

/** The text "看吧" sends: what the user typed, or the default answer. */
export function lookOfferContent(value: string): string {
  return value.trim() || uiText(LOOK_OFFER_MESSAGE);
}

export interface LookOfferPromptPorts {
  /** Where the prompt goes: the pet's chat area. */
  container(): HTMLElement | null;
  /** 看吧: send like "给她看看屏幕". */
  look(): void;
  /** 不用: tell the host (preload declineLookOffer). */
  decline(id: string): void;
  /** Test seam: the timer that takes the prompt down when the offer runs out. */
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

type Doc = Pick<Document, 'createElement'>;
const defaultTimers = { set: (callback: () => void, ms: number) => setTimeout(callback, ms), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export class LookOfferPrompt {
  private shown: { id: string; root: HTMLElement; timer: unknown } | null = null;
  private disposed = false;
  private readonly timers: NonNullable<LookOfferPromptPorts['timers']>;
  constructor(private readonly ports: LookOfferPromptPorts, private readonly doc: Doc = document) { this.timers = ports.timers ?? defaultTimers; }

  /** The prompt is on screen now. */
  get isOpen(): boolean { return this.shown !== null; }
  /** The offer it answers (tests). */
  get offerId(): string | null { return this.shown?.id ?? null; }

  /** The host's `desk:look-offer`: show this offer (replacing an older one) or take the prompt down. */
  present(raw: unknown): void {
    if (this.disposed) return;
    const view = readLookOffer(raw);
    if (view === undefined) return;
    this.close();
    if (!view) return;
    const container = this.ports.container();
    if (!container) return;
    const root = this.render(view.id);
    container.prepend(root);
    this.shown = { id: view.id, root, timer: this.timers.set(() => { if (this.shown?.id === view.id) this.close(); }, view.ttlMs) };
  }

  /** Takes the prompt down without answering (the offer stays open in words). */
  close(): void {
    const shown = this.shown;
    if (!shown) return;
    this.shown = null;
    this.timers.clear(shown.timer);
    shown.root.remove();
  }

  dispose(): void {
    this.close();
    this.disposed = true;
  }

  private render(id: string): HTMLElement {
    const root = this.doc.createElement('section');
    root.className = 'look-offer-card';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', uiText(LOOK_OFFER_QUESTION));
    root.dataset.lookOffer = id;
    const question = this.doc.createElement('p');
    question.className = 'look-offer-card__question';
    question.textContent = uiText(LOOK_OFFER_QUESTION);
    const actions = this.doc.createElement('div');
    actions.className = 'look-offer-card__actions';
    const button = (label: string, primary: boolean, answer: () => void) => {
      const item = this.doc.createElement('button');
      item.type = 'button';
      item.className = primary ? 'look-offer-card__choice is-proposed' : 'look-offer-card__choice';
      item.textContent = uiText(label);
      item.onclick = () => {
        if (this.disposed || this.shown?.id !== id) return;
        this.close();
        answer();
      };
      return item;
    };
    actions.append(button(LOOK_OFFER_YES, true, () => this.ports.look()), button(LOOK_OFFER_NO, false, () => this.ports.decline(id)));
    root.append(question, actions);
    return root;
  }
}
