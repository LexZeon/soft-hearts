import { uiText } from '../foundation/ui-language';
import { icon } from '../foundation/icons';

/**
 * 识图分三档 · 第 1 步「细看」(docs/claude/2026-11-03-image-depth-step1.md): the "给她看看屏幕" button, in the companion's chat and in the
 * control window's composer. It shows only while screen sharing is on (she cannot look at a screen nobody shared; the switch
 * itself stays where it is, off by default). Pressing it sends what is typed — or "你看看我的屏幕。" when the box is empty —
 * with the shared screen taken at that moment (the host takes it: preload `sharedAttachments({ look: true })`). Saying it in
 * words ("你看看这个") does the same without the button; this one always works.
 */
export const LOOK_BUTTON_LABEL = '给她看看屏幕';
/** Sent when the box is empty. */
export const LOOK_BUTTON_MESSAGE = '你看看我的屏幕。';
/**
 * I-084 beside it, only while 「发图片」 is on. It sends what is typed — or
 * "你看看我。" — with one clear camera picture taken right then (preload `sharedAttachments({ lookAtMe: true })`), exactly like saying
 * "看看我" (it also lifts a "别看", as those words do). Nothing is captured while 「发图片」 is off: the host checks again.
 */
export const LOOK_ME_LABEL = '让她看看我';
export const LOOK_ME_MESSAGE = '你看看我。';
export type LookButtonKind = 'screen' | 'me';

/** The text the button sends: what the user typed, or the default ask. */
export function lookButtonContent(value: string, kind: LookButtonKind = 'screen'): string {
  return value.trim() || uiText(kind === 'me' ? LOOK_ME_MESSAGE : LOOK_BUTTON_MESSAGE);
}

/** Whether the button shows: the screen one while screen sharing is on, 「让她看看我」 while 「发图片」 is on. */
export function lookButtonShown(kind: LookButtonKind, state: { screenSharing: boolean; cameraSharing?: boolean; cameraImages?: boolean }): boolean {
  return kind === 'me' ? state.cameraSharing === true && state.cameraImages === true : state.screenSharing === true;
}

export class LookButton {
  readonly element: HTMLButtonElement;
  private disposed = false;
  private readonly kind: LookButtonKind;

  /** `before`: the element to sit in front of (the companion's send button); null appends. `compact`: icon only (the companion). */
  constructor(parent: HTMLElement, before: Element | null, compact: boolean, onLook: () => void, kind: LookButtonKind = 'screen') {
    this.kind = kind;
    const me = kind === 'me';
    const button = document.createElement('button');
    button.type = 'button';
    button.id = compact ? (me ? 'pet-look-me' : 'pet-look-screen') : me ? 'look-me' : 'look-screen';
    button.className = (compact ? 'look-screen' : 'tool look-screen') + (me ? ' look-me' : '');
    const label = uiText(me ? LOOK_ME_LABEL : LOOK_BUTTON_LABEL);
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon(me ? 'camera' : 'screen');
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

  /** Visible only while screen sharing is on (「让她看看我」: while 「发图片」 is on). */
  update(state: { screenSharing: boolean; cameraSharing?: boolean; cameraImages?: boolean }): void {
    if (this.disposed) return;
    this.element.hidden = !lookButtonShown(this.kind, state);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.onclick = null;
    this.element.remove();
  }
}
