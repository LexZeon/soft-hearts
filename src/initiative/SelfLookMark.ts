/**
 * I-085 step 4a, companion window (docs/claude/2026-11-12-i085-steps-2-4.md): when she really looks at you herself (steps 1 and 2: a frame was
 * taken, "desk:self-look"), a small eye mark lights up beside her for a moment and fades. No text, nothing about what she saw, never
 * clickable (pointer-events: none, so it is never a pat or a pinch); it is only the sign that she looked, so you know. The window hidden:
 * nothing is shown. Another look while it is lit only keeps it lit a little longer (never a stack of eyes).
 */
import { registerUiMessages } from '../../shared/foundation/ui-language';
import { uiText } from '../foundation/ui-language';

registerUiMessages({
  en: { '她看了你一眼': 'She glanced at you' },
  'zh-CN': {},
});

export interface SelfLookMarkAPI { onSelfLook(callback: () => void): () => void }
interface Doc { createElement(tag: string): HTMLElement }
interface MarkTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }

/** How long the eye stays lit after a look (ms). */
export const SELF_LOOK_MARK_MS = 2_600;

const EYE_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M2 12c2.6-4.2 6-6.3 10-6.3s7.4 2.1 10 6.3c-2.6 4.2-6 6.3-10 6.3S4.6 16.2 2 12z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg>';

export class SelfLookMark {
  readonly element: HTMLElement;
  private unsubscribe: (() => void) | null = null;
  private timer: unknown = null;
  private readonly timers: MarkTimers;

  constructor(parent: HTMLElement, private readonly api: SelfLookMarkAPI, private readonly options: {
    /** The window is hidden or minimised right now: nothing lights. */
    blocked?: () => boolean;
    holdMs?: number;
    timers?: MarkTimers;
    document?: Doc;
  } = {}) {
    const doc = options.document ?? document;
    this.timers = options.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    this.element = doc.createElement('div');
    this.element.className = 'self-look-eye';
    this.element.hidden = true;
    this.element.setAttribute('role', 'img');
    this.element.setAttribute('aria-label', uiText('她看了你一眼'));
    this.element.innerHTML = EYE_SVG;
    parent.append(this.element);
  }

  init(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.api.onSelfLook(() => this.show());
  }

  /** Lights the eye for `holdMs` (again while lit: the time starts over). */
  show(): void {
    if (this.options.blocked?.() === true) return;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.element.hidden = false;
    this.element.classList.add('is-lit');
    this.timer = this.timers.set(() => { this.timer = null; this.hide(); }, Math.max(0, this.options.holdMs ?? SELF_LOOK_MARK_MS));
  }

  hide(): void {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    this.element.classList.remove('is-lit');
    this.element.hidden = true;
  }

  dispose(): void {
    this.hide();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
