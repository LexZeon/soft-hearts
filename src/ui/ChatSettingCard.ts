// Chat settings card (R41 extension). The host sends plain data for one proposal; this
// module turns it into DOM with textContent only (no markup from the model or the host),
// sends back exactly one tap, and shows the host's receipt. Only the newest card is live.
import { uiText, uiTemplate } from './ui-language';
import { CHAT_SETTING_CANCEL, type ChatSettingCardState, type ChatSettingCardView, type ChatSettingChoiceRequest } from '../../shared/chat-settings';

const STATES: readonly ChatSettingCardState[] = ['open', 'busy', 'applied', 'unchanged', 'cancelled', 'denied', 'expired', 'failed'];
const settled = (state: ChatSettingCardState) => state !== 'open' && state !== 'busy';
/**
 * R46: a settled card folds into its one-line
 * result (chat-setting-card.css); where it is removed later (the pet) it first fades
 * out for this long. Keep equal to the fade in chat-setting-card.css.
 */
export const CHAT_SETTING_LEAVE_MS = 600;
const text = (value: unknown, max: number) => typeof value === 'string' ? [...value].slice(0, max).join('') : null;

/** Strict shape check of host data before any DOM work; anything else is ignored. */
export function readChatSettingCard(value: unknown): ChatSettingCardView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const ids = [v.proposalId, v.replyId, v.settingId].map(item => text(item, 120));
  const fields = [v.label, v.current, v.proposed].map(item => text(item, 60));
  const reason = text(v.reason, 80), message = v.message === undefined ? undefined : text(v.message, 200);
  const detail = v.detail === undefined ? undefined : text(v.detail, 240);
  if (v.kind !== 'chat-setting-card' || v.version !== 1 || ids.some(item => !item) || fields.some(item => item === null)
    || reason === null || message === null || detail === null || typeof v.confirm !== 'boolean' || !STATES.includes(v.state as ChatSettingCardState)
    || !Array.isArray(v.choices) || v.choices.length < 1 || v.choices.length > 4) return null;
  const choices: ChatSettingCardView['choices'] = [];
  for (const raw of v.choices) {
    const choice = raw as Record<string, unknown> | null;
    const choiceId = text(choice?.choiceId, 20), label = text(choice?.label, 40);
    if (!choiceId || choiceId === CHAT_SETTING_CANCEL || !label || typeof choice?.proposed !== 'boolean' || typeof choice?.current !== 'boolean') return null;
    choices.push({ choiceId, label, proposed: choice.proposed, current: choice.current });
  }
  return {
    kind: 'chat-setting-card', version: 1, proposalId: ids[0]!, replyId: ids[1]!, settingId: ids[2] as ChatSettingCardView['settingId'],
    label: fields[0]!, current: fields[1]!, proposed: fields[2]!, reason, confirm: v.confirm, choices, state: v.state as ChatSettingCardState,
    ...(message !== undefined ? { message } : {}), ...(detail ? { detail } : {}),
  };
}

type Doc = Pick<Document, 'createElement'>;
const node = <K extends keyof HTMLElementTagNameMap>(doc: Doc, tag: K, className: string, value = '') => {
  const element = doc.createElement(tag);
  element.className = className;
  if (value) element.textContent = value;
  return element;
};

/** The card as DOM. `onChoose` receives a host choice id or 「取消」's id. */
export function renderChatSettingCard(view: ChatSettingCardView, doc: Doc, onChoose: (choiceId: string) => void, busy = false): HTMLElement {
  const root = node(doc, 'section', 'chat-setting-card');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', uiText('设置提议'));
  root.dataset.state = view.state;
  // R46: everything but the result line folds away (animated) once the card has settled.
  const fold = node(doc, 'div', 'chat-setting-card__fold'), body = node(doc, 'div', 'chat-setting-card__body');
  fold.append(body);
  if (settled(view.state)) fold.setAttribute('aria-hidden', 'true');
  root.append(fold);
  body.append(node(doc, 'p', 'chat-setting-card__title', uiTemplate`Claude 建议调整「${view.label}」`));
  body.append(node(doc, 'p', 'chat-setting-card__change', uiTemplate`现在：${view.current} → 建议：${view.proposed}`));
  if (view.detail) body.append(node(doc, 'p', 'chat-setting-card__detail', view.detail)); // I-025: how much, from where, what it turns on
  if (view.reason) body.append(node(doc, 'p', 'chat-setting-card__reason', view.reason));
  const live = view.state === 'open' && !busy;
  if (view.confirm && live) body.append(node(doc, 'p', 'chat-setting-card__note', uiText('点选后还会弹出确认框。')));
  const actions = node(doc, 'div', 'chat-setting-card__actions');
  const button = (choiceId: string, label: string, primary: boolean) => {
    const item = node(doc, 'button', primary ? 'chat-setting-card__choice is-proposed' : 'chat-setting-card__choice', label);
    item.type = 'button';
    item.disabled = !live;
    item.onclick = () => { if (!item.disabled) onChoose(choiceId); };
    return item;
  };
  for (const choice of view.choices) {
    const suffix = choice.proposed ? uiText('（建议）') : choice.current ? uiText('（现在）') : '';
    actions.append(button(choice.choiceId, choice.label + suffix, choice.proposed));
  }
  actions.append(button(CHAT_SETTING_CANCEL, uiText('取消'), false));
  body.append(actions);
  if (view.message) {
    const result = node(doc, 'p', 'chat-setting-card__result', view.message);
    result.setAttribute('role', 'status');
    root.append(result);
  }
  return root;
}

export interface ChatSettingCardPorts {
  choose(request: ChatSettingChoiceRequest): Promise<ChatSettingCardView | null>;
  /** Where a new card goes: the end of the chat log, or the pet's chat area. */
  container(): HTMLElement | null;
  error?(message: string): void;
  /** Settled cards stay readable this long, then fade out and are removed (the pet); undefined keeps them as one line (the chat log). */
  settledLifetimeMs?: number;
  /** Insert new cards first (the pet's chat area, above the input) instead of last. */
  prepend?: boolean;
  /** Test seam: timers for the settled lifetime and the fade. */
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

interface Shown { root: HTMLElement; view: ChatSettingCardView; busy: boolean; timer?: unknown }
const defaultTimers = { set: (callback: () => void, ms: number) => setTimeout(callback, ms), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export class ChatSettingCards {
  private readonly cards = new Map<string, Shown>();
  private readonly timers: NonNullable<ChatSettingCardPorts['timers']>;
  constructor(private readonly ports: ChatSettingCardPorts, private readonly doc: Doc = document) { this.timers = ports.timers ?? defaultTimers; }

  /** A new card or a host update of one already shown. Unknown or malformed data is ignored. */
  present(raw: unknown): void {
    const view = readChatSettingCard(raw);
    if (!view) return;
    const shown = this.cards.get(view.proposalId);
    if (!shown) {
      if (view.state !== 'open') return; // An update for a card this window never showed.
      // Only the newest card is live: older open cards turn inert locally too.
      for (const [id, old] of this.cards) if (old.view.state === 'open') this.update(id, { ...old.view, state: 'expired' });
      const container = this.ports.container();
      if (!container) return;
      const entry: Shown = { root: this.render(view, false), view, busy: false };
      this.cards.set(view.proposalId, entry);
      if (this.ports.prepend) container.prepend(entry.root); else container.append(entry.root);
      return;
    }
    this.update(view.proposalId, view);
  }

  /** Chat cleared or window closing: every card goes away. */
  clear(): void {
    for (const shown of this.cards.values()) { if (shown.timer !== undefined) this.timers.clear(shown.timer); shown.root.remove(); }
    this.cards.clear();
  }

  private render(view: ChatSettingCardView, busy: boolean): HTMLElement {
    return renderChatSettingCard(view, this.doc, choiceId => void this.choose(view.proposalId, choiceId), busy);
  }

  private update(id: string, view: ChatSettingCardView, busy = false): void {
    const shown = this.cards.get(id);
    if (!shown) return;
    shown.view = view; shown.busy = busy;
    const next = this.render(view, busy);
    shown.root.replaceWith(next);
    shown.root = next;
    if (settled(view.state) && this.ports.settledLifetimeMs !== undefined && shown.timer === undefined)
      shown.timer = this.timers.set(() => {
        // R46: fade out first (chat-setting-card.css), then go; never cut it out mid-read.
        shown.root.dataset.leaving = 'true';
        shown.timer = this.timers.set(() => { shown.root.remove(); if (this.cards.get(id) === shown) this.cards.delete(id); }, CHAT_SETTING_LEAVE_MS);
      }, this.ports.settledLifetimeMs);
  }

  private async choose(id: string, choiceId: string): Promise<void> {
    const shown = this.cards.get(id);
    if (!shown || shown.busy || shown.view.state !== 'open') return;
    this.update(id, shown.view, true); // One tap only: every button is disabled until the host answers.
    try {
      const result = readChatSettingCard(await this.ports.choose({ proposalId: id, choiceId }));
      if (result && result.proposalId === id) this.update(id, result);
      else this.update(id, { ...shown.view, state: 'expired', message: uiText('这张卡片已过期，设置没有改。') });
    } catch (error) {
      this.update(id, { ...shown.view, state: 'failed', message: uiText('没有改成，请在设置里查看。') });
      this.ports.error?.(String(error instanceof Error ? error.message : error));
    }
  }
}
