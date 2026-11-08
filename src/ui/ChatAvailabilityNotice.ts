// Control-window "needs attention" panel for when Claude cannot answer chat: the cause in plain words, when it
// should be back if the failure said so, and three fixed buttons (retry, guide, network settings). Everything
// shown is host data set as textContent; a button only asks the host for one of its fixed operations.
import { uiText } from './ui-language';
import { actionLabel, describeOutage, type ChatAvailabilityAction, type ChatAvailabilityView } from '../../shared/chat-availability';

export interface ChatAvailabilityPorts {
  get(): Promise<ChatAvailabilityView>;
  changed(callback: (view: ChatAvailabilityView) => void): () => void;
  retry(): Promise<ChatAvailabilityView>;
  help(): Promise<void>;
  networkSettings(): Promise<void>;
  error?(message: string): void;
  now?: () => number;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** How long the "chat is back" message stays. */
export const RECOVERED_NOTICE_MS = 6000;

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '') => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  return value;
};

export class ChatAvailabilityNotice {
  private readonly title = make('span', 'chat-availability-reason');
  private readonly hint = make('p', 'chat-availability-hint');
  private readonly note = make('p', 'chat-availability-note');
  private readonly actions = make('div', 'chat-availability-actions');
  private view: ChatAvailabilityView | null = null;
  private latest = 0;
  private recoveredUntil = 0;
  private recoveredTimer: unknown = null;
  private retried = false;
  private readonly stop: () => void;
  private readonly timers: NonNullable<ChatAvailabilityPorts['timers']>;

  constructor(private readonly root: HTMLElement, private readonly ports: ChatAvailabilityPorts) {
    this.timers = ports.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    const heading = make('div', 'chat-availability-title');
    const label = make('strong');
    label.textContent = uiText('需要处理');
    heading.append(label, this.title);
    root.setAttribute('role', 'status');
    root.replaceChildren(heading, this.hint, this.note, this.actions);
    root.hidden = true;
    this.stop = ports.changed(view => this.show(view));
    const ticket = ++this.latest;
    void ports.get().then(view => { if (ticket === this.latest) this.show(view, true); }, () => {});
  }

  dispose(): void {
    this.stop();
    if (this.recoveredTimer !== null) this.timers.clear(this.recoveredTimer);
    this.recoveredTimer = null;
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private now(): number { return (this.ports.now ?? Date.now)(); }

  private show(view: ChatAvailabilityView, initial = false): void {
    if (!initial) this.latest++;
    this.view = view;
    if (view.state === 'ok') {
      if (view.recovered) this.showRecovered(view.recovered.line);
      // A plain "ok" after a recovery message must not cut it short.
      else if (this.now() >= this.recoveredUntil) this.hide();
      return;
    }
    this.clearRecovered();
    const description = describeOutage(view, this.now());
    this.root.hidden = false;
    this.root.classList.remove('recovered');
    this.title.textContent = description.reason;
    this.hint.textContent = description.hint;
    this.note.textContent = view.checking ? uiText('正在重试……') : this.retried ? uiText('还是不行，上面是最新的原因。') : '';
    this.note.hidden = !this.note.textContent;
    this.renderActions(description.actions, view);
  }

  private showRecovered(line: string | null): void {
    this.retried = false;
    this.root.hidden = false;
    this.root.classList.add('recovered');
    this.title.textContent = uiText('已经恢复，可以继续聊天了。');
    this.hint.textContent = line ? `「${line}」` : '';
    this.hint.hidden = !line;
    this.note.textContent = '';
    this.note.hidden = true;
    this.actions.replaceChildren();
    this.recoveredUntil = this.now() + RECOVERED_NOTICE_MS;
    if (this.recoveredTimer !== null) this.timers.clear(this.recoveredTimer);
    this.recoveredTimer = this.timers.set(() => { this.recoveredTimer = null; this.recoveredUntil = 0; if (this.view?.state !== 'unavailable') this.hide(); }, RECOVERED_NOTICE_MS);
  }

  private clearRecovered(): void {
    if (this.recoveredTimer !== null) this.timers.clear(this.recoveredTimer);
    this.recoveredTimer = null;
    this.recoveredUntil = 0;
    this.hint.hidden = false;
  }

  private hide(): void {
    this.retried = false;
    this.root.hidden = true;
    this.root.classList.remove('recovered');
    this.actions.replaceChildren();
  }

  private renderActions(actions: readonly ChatAvailabilityAction[], view: ChatAvailabilityView): void {
    const buttons = actions.map(action => {
      const button = make('button');
      button.type = 'button';
      button.dataset.chatAvailability = action;
      button.textContent = action === 'retry' && view.checking ? uiText('正在重试……') : actionLabel(action, view.kind);
      button.disabled = view.checking === true;
      button.onclick = () => void this.run(action);
      return button;
    });
    this.actions.replaceChildren(...buttons);
  }

  private async run(action: ChatAvailabilityAction): Promise<void> {
    try {
      if (action === 'retry') {
        this.retried = true;
        const view = await this.ports.retry();
        this.show(view);
      } else if (action === 'help') await this.ports.help();
      else if (action === 'network-settings') await this.ports.networkSettings();
    } catch (error) {
      this.ports.error?.(String(error instanceof Error ? error.message : error));
    }
  }
}
