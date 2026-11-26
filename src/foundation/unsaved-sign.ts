import { uiText, uiTemplate } from './ui-language';

/**
 * The "unsaved" sign (after a monthly limit typed into the voice page never took effect because Save was not pressed:
 * "未保存的设置要显示未保存，提示保存按钮在哪里。"). One shared piece for every control page that has an explicit save button:
 * while it has changes that are not saved, the section shows "未保存" next to the changed fields, a line says where the save button is,
 * and the save button is highlighted. All of it goes away when the page reports clean (saved or reverted).
 * It changes only what the user sees; what is saved and when stays with the page. Pages that apply a change the moment it is made
 * do not use it. docs/claude/2026-11-24-unsaved-sign.md.
 */
export interface UnsavedSignOptions {
  /** The page's own save button; its current text names it in the pointer line, and it is highlighted while unsaved. */
  saveButton: HTMLElement;
  /** What the page is called in the leave note ("「语音」页还有未保存的修改"). Authored copy (goes through uiText). */
  page: string;
  /** The section heading: gets the "未保存" badge while the page is unsaved and no changed row is named. */
  title?: HTMLElement | null | (() => HTMLElement | null | undefined);
  /** The save button's name in the pointer line when its own text changes (e.g. "保存中…"); default: its current text. */
  label?: () => string;
}
export interface UnsavedSign {
  /** Report the page state. `fields`: the field rows that changed (each gets a small "未保存" badge); none is fine. */
  update(dirty: boolean, fields?: readonly (HTMLElement | null | undefined)[]): void;
  readonly dirty: boolean;
  dispose(): void;
}

interface Entry { page: string; isDirty(): boolean; announced: boolean }
const entries = new Set<Entry>();

const make = (tag: string, className: string, text: string): HTMLElement => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
};

export function attachUnsavedSign(options: UnsavedSignOptions): UnsavedSign {
  const lit = (on: boolean): void => { // tolerant: older test doubles of a button have no classList or attributes
    try { if (on) options.saveButton.classList?.add?.("unsaved-save"); else options.saveButton.classList?.remove?.("unsaved-save"); } catch { /* not a real element */ }
  };
  const { saveButton } = options;
  const state = { dirty: false };
  const line = make('p', 'unsaved-sign', '');
  line.setAttribute('role', 'status'); line.hidden = true;
  const entry: Entry = { page: options.page, isDirty: () => state.dirty, announced: false };
  const badges = new Map<HTMLElement, HTMLElement>();
  const place = (): void => {
    // The line sits right above the row that holds the save button, so it points at it.
    const row = saveButton.parentElement;
    const host = row?.parentElement;
    if (row && host) { if (line.parentElement !== host || line.nextSibling !== row) host.insertBefore?.(line, row); }
  };
  entries.add(entry);
  const sync = (fields: readonly (HTMLElement | null | undefined)[]): void => {
    const named = fields.filter((item): item is HTMLElement => !!item);
    const heading = typeof options.title === "function" ? options.title() : options.title;
    const wanted = new Set<HTMLElement>(state.dirty ? (named.length || !heading ? named : [heading]) : []);
    for (const [row, badge] of badges) if (!wanted.has(row)) { badge.remove?.(); badges.delete(row); }
    for (const row of wanted) if (!badges.has(row)) {
      const badge = make('span', 'unsaved-badge', uiText('未保存'));
      row.insertBefore?.(badge, row.firstChild ?? null); badges.set(row, badge);
    }
  };
  return {
    update(dirty, fields = []) {
      state.dirty = dirty;
      if (!dirty) entry.announced = false;
      if (dirty) place();
      line.hidden = !dirty;
      line.textContent = dirty ? uiTemplate`未保存 · 改完点这一页下面的「${(options.label?.() ?? saveButton.textContent ?? '').trim()}」才生效` : '';
      lit(dirty);
      if (dirty) saveButton.setAttribute?.('data-unsaved', 'true'); else saveButton.removeAttribute?.('data-unsaved');
      sync(fields);
    },
    get dirty() { return state.dirty; },
    dispose() { entries.delete(entry); line.remove?.(); state.dirty = false; sync([]); lit(false); saveButton.removeAttribute?.('data-unsaved'); },
  };
}

/** Pages with unsaved changes right now. */
export function unsavedPages(): string[] {
  return [...entries].filter(item => item.isDirty()).map(item => uiText(item.page));
}

/**
 * Leaving a page or closing the window with unsaved changes: say so once per page and per time away, never block (the changes stay
 * where they are). Returns the notice it gave (null: nothing to say).
 */
export function announceUnsaved(notify: (text: string) => void): string | null {
  const fresh = [...entries].filter(item => item.isDirty() && !item.announced);
  if (!fresh.length) return null;
  for (const item of fresh) item.announced = true;
  const names = fresh.map(item => uiText(item.page)).join(uiText('、'));
  const text = uiTemplate`${names} 还有没保存的修改，先替你留着；回到那一页点「保存」才生效。`;
  notify(text);
  return text;
}

/** The window was closed or hidden: the next return may say it again once. */
export function rearmUnsavedAnnouncements(): void { for (const item of entries) item.announced = false; }

/** The control window was closed (hidden) and is back: say once what was kept. Called once by the window wiring; the listener lives here, not in the wiring. */
export function watchWindowForUnsaved(notify: (text: string) => void): void {
  document.addEventListener('visibilitychange', () => { if (document.hidden) rearmUnsavedAnnouncements(); else announceUnsaved(notify); });
}
