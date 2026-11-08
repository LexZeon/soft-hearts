import { uiText } from './ui-language';
import { icon } from './icons';

/**
 * 识图分三档 · 第 1 步「细看」(docs/claude/2026-11-03-image-depth-step1.md): the "给她看看屏幕" button, in the pet's chat and in the
 * control window's composer. It shows only while screen sharing is on (she cannot look at a screen nobody shared; the switch
 * itself stays where it is, off by default). Pressing it sends what is typed — or "你看看我的屏幕。" when the box is empty —
 * with the shared screen taken at that moment (the host takes it: preload `sharedAttachments({ look: true })`). Saying it in
 * words ("你看看这个") does the same without the button; this one always works.
 */
export const LOOK_BUTTON_LABEL = '给她看看屏幕';
/** Sent when the box is empty. */
export const LOOK_BUTTON_MESSAGE = '你看看我的屏幕。';

/** The text the button sends: what the user typed, or the default ask. */
export function lookButtonContent(value: string): string {
  return value.trim() || uiText(LOOK_BUTTON_MESSAGE);
}

export class LookButton {
  readonly element: HTMLButtonElement;
  private disposed = false;

  /** `before`: the element to sit in front of (the pet's send button); null appends. `compact`: icon only (the pet). */
  constructor(parent: HTMLElement, before: Element | null, compact: boolean, onLook: () => void) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = compact ? 'pet-look-screen' : 'look-screen';
    button.className = compact ? 'look-screen' : 'tool look-screen';
    const label = uiText(LOOK_BUTTON_LABEL);
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon('screen');
    if (!compact) {
      const text = document.createElement('span');
      text.textContent = label;
      button.append(text);
    }
    button.hidden = true;
    button.onclick = () => { if (!this.disposed && !button.hidden) onLook(); };
    if (before && before.parentElement === parent) parent.insertBefore(button, before);
    else parent.append(button);
    this.element = button;
  }

  /** Visible only while screen sharing is on. */
  update(state: { screenSharing: boolean }): void {
    if (this.disposed) return;
    this.element.hidden = state.screenSharing !== true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.onclick = null;
    this.element.remove();
  }
}
