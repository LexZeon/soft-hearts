import { uiText, uiTemplate } from './ui-language';
import type { CompanionCommandChoiceRequest, CompanionCommandReceipt, CompanionCommandView } from '../../shared/companion-commands';
import './companion-command-choices.css';

/** Display only host-issued text and identities for one user-message node. */
export class CompanionCommandChoices {
  private readonly panel: HTMLElement;
  private view: CompanionCommandView | null = null;
  private revision = -1;
  private generation = 0;
  private busy = false;
  private settled = false;
  private receiptShown = false;
  private disposed = false;
  private cleared = false;

  constructor(
    root: HTMLElement,
    private readonly choose: (request: CompanionCommandChoiceRequest) => Promise<CompanionCommandView | null>,
    private readonly interactive = true,
  ) {
    this.panel = root.ownerDocument.createElement('div');
    this.panel.className = 'companion-command-choices';
    this.panel.setAttribute('aria-label', uiText('操作选择'));
    root.append(this.panel);
    this.panel.hidden = true;
  }

  show(view: CompanionCommandView): void {
    if (this.disposed || this.cleared || !Number.isSafeInteger(view.revision) || view.revision < 0) return;
    if (this.view && (view.requestId !== this.view.requestId || view.owner !== this.view.owner)) return;
    if (view.revision < this.revision) return;
    if (view.revision === this.revision) {
      if (view.receipt && !this.receiptShown) this.applyReceipt(view.receipt);
      return;
    }
    this.generation++;
    this.view = { ...view, choices: view.choices.map(choice => ({ ...choice })) };
    this.revision = view.revision;
    this.busy = false;
    this.settled = false;
    this.receiptShown = false;
    this.renderChoices();
    if (view.receipt) this.applyReceipt(view.receipt);
  }

  applyReceipt(receipt: CompanionCommandReceipt): void {
    if (this.disposed || !this.view || receipt.requestId !== this.view.requestId ||
      !Number.isSafeInteger(receipt.revision) || receipt.revision < this.revision ||
      (this.receiptShown && receipt.revision === this.revision)) return;
    this.generation++;
    this.revision = receipt.revision;
    this.busy = false;
    this.settled = true;
    this.receiptShown = true;
    this.panel.replaceChildren();
    this.panel.hidden = false;
    const result = this.panel.ownerDocument.createElement('span');
    result.className = 'companion-command-choices__result';
    result.setAttribute('role', 'status');
    // The message and status are host receipts, never model HTML or an optimistic claim.
    result.textContent = receipt.message;
    if ((receipt.persistence === 'saved' || receipt.persistence === 'unchanged') && receipt.presentation === 'failed') {
      result.textContent += receipt.persistence === 'saved' ? uiText('（设置已保存，但窗口状态未能确认。）') : uiText('（设置未改变，窗口状态未能确认。）');
    } else if ((receipt.persistence === 'saved' || receipt.persistence === 'unchanged') && receipt.presentation === 'unknown') {
      result.textContent += receipt.persistence === 'saved' ? uiText('（设置已保存，窗口状态尚未确认。）') : uiText('（设置未改变，窗口状态尚未确认。）');
    }
    this.panel.append(result);
  }

  clear(): void {
    this.cleared = true;
    this.generation++;
    this.view = null;
    this.revision = -1;
    this.busy = false;
    this.settled = false;
    this.receiptShown = false;
    this.panel.replaceChildren();
    this.panel.hidden = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.panel.remove();
  }

  private renderChoices(): void {
    if (!this.view) return;
    this.panel.replaceChildren();
    this.panel.hidden = false;
    const prompt = this.panel.ownerDocument.createElement('span');
    prompt.className = 'companion-command-choices__prompt';
    prompt.textContent = this.view.prompt;
    this.panel.append(prompt);
    for (const choice of this.view.choices) {
      const button = this.panel.ownerDocument.createElement('button');
      button.type = 'button';
      button.textContent = choice.label;
      button.disabled = !this.interactive || this.busy || this.settled;
      button.onclick = () => void this.select(choice.choiceId);
      this.panel.append(button);
    }
  }

  private async select(choiceId: string): Promise<void> {
    const view = this.view;
    if (!this.interactive || this.busy || this.settled || !view || this.disposed ||
      !view.choices.some(choice => choice.choiceId === choiceId)) return;
    this.busy = true;
    const generation = this.generation;
    this.renderChoices();
    try {
      const result = await this.choose({ requestId: view.requestId, choiceId });
      if (this.disposed || generation !== this.generation) return;
      if (result) this.show(result);
      else this.showUnconfirmed();
    } catch {
      if (!this.disposed && generation === this.generation) this.showUnconfirmed();
    }
  }

  private showUnconfirmed(): void {
    // The request may already have committed; do not offer the same ticket again.
    this.settled = true;
    this.busy = false;
    this.panel.replaceChildren();
    const note = this.panel.ownerDocument.createElement('span');
    note.className = 'companion-command-choices__result';
    note.setAttribute('role', 'status');
    note.textContent = uiText('结果尚未确认，请重新发起请求。');
    this.panel.append(note);
  }
}
