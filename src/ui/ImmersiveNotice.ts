import { uiText, uiHtml, uiMarkup, uiTemplate } from './ui-language';
/** Presentation only; callers retain ownership of the actual operation and retry. */
export class ImmersiveNotice {
  private developer = false;
  /** Pet window: the user does not want failure notices on the pet in ordinary mode (2026-11-02). */
  private readonly quietOrdinary: boolean;
  private held: { value: string; summary: string } | null = null;
  private lastWasError = false;
  private lastWasAction = false;
  private summary = uiText('操作没有完成，可查看详情。');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly toast: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly close: HTMLButtonElement;
  private readonly openDetails = () => { this.panel.hidden = false; };
  private readonly closeDetails = () => { this.panel.hidden = true; };

  constructor(owner: Document, options: { quietOrdinaryFailures?: boolean } = {}) {
    this.quietOrdinary = options.quietOrdinaryFailures === true;
    const get = <T extends HTMLElement>(id: string): T => { const element=owner.getElementById(id); if (!element) throw Error(uiText('提示界面尚未就绪')); return element as T; };
    this.toast=get('toast'); this.button=get('notice-details'); this.panel=get('notice-detail-panel'); this.detail=get('notice-detail-text'); this.close=get('notice-detail-close');
    this.button.addEventListener('click',this.openDetails); this.close.addEventListener('click',this.closeDetails);
  }
  setDeveloperMode(enabled: boolean): void {
    this.developer=enabled;
    if (this.quietOrdinary) {
      // Every mood broadcast re-sends the mode; a fixed guidance line (publishAction) is meant for ordinary mode and
      // stays for its 4 s (2026-11-03: the camera-refused line on the pet vanished at the next broadcast).
      if (!enabled) { if (!this.lastWasAction) this.toast.classList.remove('show'); this.button.hidden=true; this.panel.hidden=true; return; }
      const held=this.held; this.held=null;
      if (held) this.publish(held.value,true,held.summary); // The latest quiet failure shows once developer mode is on.
      return;
    }
    if (!enabled && this.toast.classList.contains('show')) {
      if (this.lastWasError) this.toast.textContent=this.summary;
      else if (!this.lastWasAction) this.toast.classList.remove('show');
    }
  }
  /** Routine diagnostic updates stay quiet in ordinary mode. Errors retain an explicit detail entry. */
  publish(message: string, error = false, trustedSummary?: string): void {
    if (!error && !this.developer) return;
    const value=String(message).slice(0, 4000);
    if (error && !this.developer && this.quietOrdinary) {
      this.held={ value, summary: trustedSummary?.slice(0,160) || uiText('操作没有完成，可查看详情。') };
      return;
    }
    this.lastWasError=error;
    this.lastWasAction=false;
    if (error) { this.summary=trustedSummary?.slice(0,160) || uiText('操作没有完成，可查看详情。'); this.detail.textContent=value; this.panel.hidden=true; this.button.hidden=false; }
    this.toast.textContent=error && !this.developer ? this.summary : value;
    this.toast.className=`toast show${error ? ' error' : ''}`;
    clearTimeout(this.timer); this.timer=setTimeout(()=>this.toast.classList.remove('show'),error ? 9000 : 4000);
  }
  /** Only fixed, caller-controlled user guidance is allowed; never pass raw diagnostics. */
  publishAction(trustedSummary: string): void {
    if (typeof trustedSummary !== 'string' || !trustedSummary.trim() || trustedSummary.length > 160) return;
    this.lastWasError=false; this.lastWasAction=true;
    this.toast.textContent=trustedSummary;
    this.toast.className='toast show';
    clearTimeout(this.timer); this.timer=setTimeout(()=>this.toast.classList.remove('show'),4000);
  }
  dispose(): void { this.held=null; clearTimeout(this.timer);this.button.removeEventListener('click',this.openDetails);this.close.removeEventListener('click',this.closeDetails);this.panel.hidden=true;this.button.hidden=true;this.detail.textContent='';this.toast.textContent='';this.toast.classList.remove('show'); }
}
