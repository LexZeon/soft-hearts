/**
 * I-154 step 1 / I-176 step 3: 「个人感」 in the control window's developer panel, inside 「Unbound（试验）」 (control-switch.ts mounts it,
 * so it shows only in developer mode). The slider is Unbound's personal-feel filter on her head, neck, chest, arms and fingers; it writes the
 * stored strength (window-mode/window-style.ts) and the companion window and this window's preview apply it in place (this window hears
 * the change through announceWindowStyle). The switch that chose the engine is gone: Unbound's engine is the only one. Text via textContent only.
 * docs/claude/2026-11-19-unbound-in-window.md, docs/claude/2026-11-23-i176-delete.md.
 */
import { uiText } from '../foundation/ui-language';
import { announceWindowStyle, pageStorage, readWindowStyle, writeWindowStyle, type ChoiceStorage } from './window-mode/window-style';

/** Getters, so the text follows the interface language at the moment it is shown. */
export const WINDOW_STYLE_COPY = Object.freeze({
  get hint() { return uiText('桌宠窗口和这个窗口的预览都由 Unbound 的引擎来画；这里调"个人感"的强度（0 是不加）。不会打开摄像头、麦克风、屏幕或电脑的声音，这些照旧只由你自己开。'); },
  get style() { return uiText('个人感 '); },
  get refused() { return uiText('没存上（这台电脑的页面存储不可用），个人感保持原样。'); },
});

export class WindowStyleSlider {
  readonly root: HTMLDivElement;
  private readonly style: HTMLInputElement;
  private readonly styleOut: HTMLOutputElement;
  private readonly status: HTMLOutputElement;

  constructor(doc: Document, private readonly storage: ChoiceStorage | null = pageStorage()) {
    this.root = doc.createElement('div'); this.root.className = 'unbound-window-engine';
    const hint = doc.createElement('p'); hint.textContent = WINDOW_STYLE_COPY.hint;
    this.style = doc.createElement('input'); this.style.type = 'range'; this.style.id = 'unbound-window-style';
    this.style.min = '0'; this.style.max = '100'; this.style.step = '5';
    this.styleOut = doc.createElement('output');
    const styleLabel = doc.createElement('label'); styleLabel.append(doc.createTextNode(WINDOW_STYLE_COPY.style), this.style, this.styleOut, doc.createTextNode(' %'));
    styleLabel.style.display = 'block';
    this.status = doc.createElement('output');
    this.root.append(hint, styleLabel, this.status);
    this.style.addEventListener('input', () => { this.styleOut.textContent = this.style.value; });
    this.style.addEventListener('change', () => this.save());
    this.render();
  }

  private save(): void {
    const ok = writeWindowStyle(this.storage, Number(this.style.value) / 100);
    this.status.textContent = ok ? '' : WINDOW_STYLE_COPY.refused;
    if (ok) announceWindowStyle(this.root.ownerDocument.defaultView, readWindowStyle(this.storage)); // this window's preview applies it too
    this.render();
  }

  private render(): void {
    const percent = String(Math.round(readWindowStyle(this.storage) * 100));
    this.style.value = percent; this.styleOut.textContent = percent;
  }
}
