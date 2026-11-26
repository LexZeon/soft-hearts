/**
 * Unbound v1 step 1: 「让她出来 / 回到小窗」 in the control window's top bar, next to 「一键恢复桌宠」, in every mode (the
 * developer panel's 「Unbound（试验）」 keeps its own switch and knobs). The button only asks the host: the permission page is
 * the host's own dialog (electron/unbound/entry.ts), so nothing here can say yes for the user. Text via textContent only.
 */
import type { UnboundControlView, UnboundState } from '../../shared/unbound/scene';
import { uiText } from '../foundation/ui-language';

export interface UnboundEntryApi {
  getUnbound(): Promise<UnboundControlView>;
  onUnbound(callback: (view: UnboundControlView) => void): () => void;
  toggleUnbound(): Promise<'back' | 'cancelled' | 'entering' | 'busy' | 'unavailable'>;
  /** I-159 D: clears the saved 「以后直接进，不再问」; true when one was saved. */
  askUnboundAgain?(): Promise<boolean>;
}

export function unboundEntryLabel(state: UnboundState): { text: string; title: string } {
  return state === 'normal'
    ? { text: uiText('让她出来'), title: uiText('让她离开小窗，在你的电脑上生活（Ctrl+Alt+U）。进去前会先列出要打开的权限，你确认了才开。') }
    : { text: uiText('回到小窗'), title: uiText('让她回到桌宠小窗（Ctrl+Alt+U），权限恢复成你原来的设置。') };
}

export class UnboundEntryButton {
  readonly button: HTMLButtonElement;
  private askButton: HTMLButtonElement | null = null;
  private state: UnboundState = 'normal';
  private busy = false;
  private entryAllowed = true;
  private readonly unsubscribe: () => void;

  constructor(anchor: HTMLElement, private readonly api: UnboundEntryApi) {
    const doc = anchor.ownerDocument;
    this.button = doc.createElement('button');
    this.button.type = 'button'; this.button.id = 'unbound-entry'; this.button.className = 'pet-recovery-button';
    anchor.insertAdjacentElement('afterend', this.button);
    this.button.addEventListener('click', () => void this.toggle());
    if (api.askUnboundAgain) this.askButton = this.addAskAgain(doc, api.askUnboundAgain.bind(api));
    this.unsubscribe = api.onUnbound(view => this.show(view.state, view.entryAllowed !== false));
    this.show('normal');
    void api.getUnbound().then(view => this.show(view.state, view.entryAllowed !== false), () => undefined);
  }

  /** I-159 D: 「下次进来时再问我」 beside the entry button. It only clears the saved tick; the page itself is still the host's dialog. */
  private addAskAgain(doc: Document, askAgain: () => Promise<boolean>): HTMLButtonElement {
    const button = doc.createElement('button');
    const label = uiText('下次进来时再问我');
    button.type = 'button'; button.id = 'unbound-ask-again'; button.className = 'pet-recovery-button';
    button.textContent = label; button.title = uiText('让她出来时重新显示权限说明页（取消「以后直接进，不再问」）。');
    this.button.insertAdjacentElement('afterend', button);
    button.addEventListener('click', () => {
      void askAgain().then(had => { button.textContent = uiText(had ? '好，下次会再问。' : '本来就会再问。'); }, () => undefined)
        .finally(() => { setTimeout(() => { button.textContent = label; }, 3_000); });
    });
    return button;
  }

  /** The way in is off (stable's default until the user switches it on in settings): neither button shows while she is in the small window. Coming back always shows. */
  private show(state: UnboundState, entryAllowed: boolean | undefined = this.entryAllowed): void {
    this.state = state; this.entryAllowed = entryAllowed !== false;
    const hidden = state === 'normal' && !this.entryAllowed;
    this.button.hidden = hidden;
    if (this.askButton) this.askButton.hidden = hidden;
    const { text, title } = unboundEntryLabel(state);
    this.button.textContent = text; this.button.title = title;
    this.button.setAttribute('aria-pressed', String(state !== 'normal'));
    this.button.disabled = this.busy;
  }

  private async toggle(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.button.disabled = true;
    try { await this.api.toggleUnbound(); } catch { /* the host shows its own notices */ }
    finally { this.busy = false; this.show(this.state); }
  }

  dispose(): void { this.unsubscribe(); this.button.remove(); this.askButton?.remove(); }
}
