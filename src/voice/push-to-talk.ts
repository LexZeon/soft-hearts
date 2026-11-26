/**
 * Hold T to talk (urgent): with voice input on, the microphone's sound is used only while T is held in this
 * window; letting go sends what was said. Without T held, the sound is thrown away (MediaInput, `pushToTalk`).
 *
 * T still types a "t" where the user is writing: in a text field that already holds text, T is an ordinary key. In an empty
 * field a quick tap (under PUSH_TO_TALK_TAP_MS) types the letter; holding it talks. An input method composing (Chinese pinyin)
 * keeps T for itself. Ctrl/Alt/Meta + T are left alone.
 */
export const PUSH_TO_TALK_CODE = 'KeyT';
export const PUSH_TO_TALK_TAP_MS = 250;

export interface PushToTalkMedia {
  /** Voice input is on and its capture is open in this window. */
  readonly canHoldToTalk: boolean;
  holdToTalk(): void;
  /** `send` false: a tap, nothing was said. */
  releaseToTalk(send?: boolean): void;
}

export interface TalkKey {
  code: string;
  key?: string;
  repeat?: boolean;
  isComposing?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  target?: unknown;
}

type Field = { kind: 'none' } | { kind: 'empty' | 'text'; element: HTMLInputElement | HTMLTextAreaElement | HTMLElement };

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

/** Where a key would type: nowhere, an empty field, or a field that already has text. */
export function fieldOf(target: unknown): Field {
  const element = target as { tagName?: string; type?: string; value?: string; isContentEditable?: boolean; textContent?: string | null } | null;
  if (!element || typeof element !== 'object') return { kind: 'none' };
  const tag = String(element.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || (tag === 'INPUT' && TEXT_INPUT_TYPES.has(String(element.type ?? '').toLowerCase())))
    return { kind: String(element.value ?? '') ? 'text' : 'empty', element: element as unknown as HTMLInputElement };
  if (element.isContentEditable) return { kind: String(element.textContent ?? '') ? 'text' : 'empty', element: element as unknown as HTMLElement };
  return { kind: 'none' };
}

export interface PushToTalkPorts {
  media(): PushToTalkMedia | null;
  now(): number;
  /** Types the letter a tap meant into the field it was meant for. */
  type(element: HTMLElement, letter: string): void;
}

export class PushToTalk {
  private held: { since: number; field: HTMLElement | null; letter: string } | null = null;
  constructor(private readonly ports: PushToTalkPorts) {}

  get holding(): boolean { return this.held !== null; }

  /** True: the page must not act on this key (preventDefault). */
  down(event: TalkKey): boolean {
    if (event.code !== PUSH_TO_TALK_CODE || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (this.held) return true; // the key repeating while held types nothing
    if (event.isComposing || event.key === 'Process') return false;
    const media = this.ports.media();
    if (!media?.canHoldToTalk) return false;
    const field = fieldOf(event.target);
    if (field.kind === 'text') return false;
    this.held = { since: this.ports.now(), field: field.kind === 'empty' ? field.element as HTMLElement : null, letter: event.shiftKey ? 'T' : 't' };
    media.holdToTalk();
    return true;
  }

  up(event: TalkKey): boolean {
    if (event.code !== PUSH_TO_TALK_CODE || !this.held) return false;
    const held = this.held; this.held = null;
    const tap = this.ports.now() - held.since < PUSH_TO_TALK_TAP_MS;
    this.ports.media()?.releaseToTalk(!tap);
    if (tap && held.field) this.ports.type(held.field, held.letter);
    return true;
  }

  /** The window lost focus with T down: what was said is sent, as when T is let go. */
  blur(): void {
    if (!this.held) return;
    const held = this.held; this.held = null;
    this.ports.media()?.releaseToTalk(this.ports.now() - held.since >= PUSH_TO_TALK_TAP_MS);
  }
}

function typeInto(element: HTMLElement, letter: string): void {
  const field = element as HTMLInputElement | HTMLTextAreaElement;
  if (typeof field.setRangeText === 'function' && typeof field.selectionStart === 'number') {
    field.setRangeText(letter, field.selectionStart, field.selectionEnd ?? field.selectionStart, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  element.ownerDocument?.execCommand?.('insertText', false, letter);
}

/** Listens on this window (capture phase, so a focused control cannot swallow T first). Returns the undo. */
export function wirePushToTalk(view: Window, media: () => PushToTalkMedia | null): () => void {
  const talk = new PushToTalk({ media, now: () => performance.now(), type: typeInto });
  const down = (event: KeyboardEvent) => { if (talk.down(event)) { event.preventDefault(); event.stopPropagation(); } };
  const up = (event: KeyboardEvent) => { if (talk.up(event)) { event.preventDefault(); event.stopPropagation(); } };
  const blur = () => talk.blur();
  view.addEventListener('keydown', down, true);
  view.addEventListener('keyup', up, true);
  view.addEventListener('blur', blur);
  return () => { view.removeEventListener('keydown', down, true); view.removeEventListener('keyup', up, true); view.removeEventListener('blur', blur); talk.blur(); };
}
