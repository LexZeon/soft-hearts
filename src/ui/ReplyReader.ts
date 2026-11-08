import { uiText, uiTemplate } from './ui-language';
/** A local, plain-text reader. It never sends content or grants a host capability. */
export class ReplyReader {
  private text = '';
  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly body: HTMLElement,
    private readonly trigger: HTMLButtonElement,
    private readonly closeButton: HTMLButtonElement,
    private readonly status: HTMLElement,
    private readonly changed: () => void = () => {},
  ) {
    trigger.onclick = () => this.open();
    closeButton.onclick = () => dialog.close();
    trigger.disabled = true;
    dialog.addEventListener('close', this.closed);
  }
  get opened(): boolean { return this.dialog.open; }
  private readonly closed = () => this.changed();
  update(text: string, streaming: boolean): void {
    this.text = text;
    this.trigger.disabled = !text.trim();
    this.status.textContent = streaming ? uiText('正在生成 · 可向上滚动阅读') : uiText('可滚动阅读或选中文字复制');
    // Preserve the reader's position while later sentences arrive.
    if (this.dialog.open) {
      const top = this.body.scrollTop;
      this.body.textContent = text;
      this.body.scrollTop = top;
    }
  }
  open(): void {
    if (!this.text.trim() || this.dialog.open) return;
    this.body.textContent = this.text;
    this.dialog.showModal();
    this.changed();
    this.body.scrollTop = 0;
    this.body.focus();
  }
  /** Hiding or changing the active reply must not leave a private text overlay. */
  clear(): void {
    if (this.dialog.open) this.dialog.close();
    this.text = '';
    this.body.textContent = '';
    this.trigger.disabled = true;
    this.status.textContent = '';
  }
  dispose(): void { this.clear(); this.dialog.removeEventListener('close', this.closed); this.trigger.onclick = this.closeButton.onclick = null; }
}
