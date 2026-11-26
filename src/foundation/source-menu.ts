/**
 * I-190: the one source list both windows draw (the companion toolbar's ▾ menus, the camera and listening panels, the Unbound input box's
 * senses panel). It draws a model (shared/senses/source-picker.ts SourceMenuModel, repeated here structurally: foundation imports no part)
 * as a radio menu: "跟着系统默认" first, the one in use checked, the user's names as plain text (textContent only). Arrow keys, Home/End,
 * Enter/Space pick; Esc and Tab close a popup. A pick only reports the item id: what it means is the caller's (never a switch).
 */
import { uiText } from './ui-language';

export interface SourceListItem { id: string; label: string; checked: boolean; own?: boolean; number?: number }
export interface SourceListModel { kind: string; title: string; items: SourceListItem[]; note?: string }

/** Draws the list into a fresh element (`role=group` with a title, a `role=menu` of `menuitemradio` buttons and the note). */
export function renderSourceList(doc: Document, model: SourceListModel, pick: (id: string) => void): HTMLElement {
  const root = doc.createElement('div');
  root.className = 'source-list';
  root.dataset.sourceKind = model.kind;
  root.setAttribute('role', 'group');
  const title = doc.createElement('div');
  title.className = 'source-list-title';
  title.id = `source-list-${model.kind}-${++lists}`;
  title.textContent = uiText(model.title);
  root.setAttribute('aria-labelledby', title.id);
  const menu = doc.createElement('div');
  menu.className = 'source-list-items';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-labelledby', title.id);
  for (const item of model.items) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'source-list-item';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(item.checked));
    button.dataset.sourceId = item.id;
    button.tabIndex = item.checked ? 0 : -1;
    // Our words are translated; a device or window name is the user's own and is shown as it is (textContent only).
    button.textContent = item.number !== undefined ? `${uiText(item.label)} ${item.number}` : item.own ? item.label : uiText(item.label);
    button.addEventListener('click', () => pick(item.id));
    menu.append(button);
  }
  menu.addEventListener('keydown', event => moveFocus(menu, event));
  root.append(title, menu);
  if (model.note) {
    const note = doc.createElement('p');
    note.className = 'source-list-note';
    note.textContent = uiText(model.note);
    root.append(note);
  }
  return root;
}
let lists = 0;

/** Arrow keys walk the items (wrapping), Home/End jump; the focused item is the only one in the tab order. */
function moveFocus(menu: HTMLElement, event: KeyboardEvent): void {
  const items = [...menu.querySelectorAll<HTMLButtonElement>('.source-list-item')];
  if (!items.length) return;
  const at = Math.max(0, items.indexOf(menu.ownerDocument.activeElement as HTMLButtonElement));
  const next = event.key === 'ArrowDown' ? (at + 1) % items.length : event.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
  if (next < 0) return;
  event.preventDefault();
  for (const [index, item] of items.entries()) item.tabIndex = index === next ? 0 : -1;
  items[next].focus();
}

/** Puts the first checked item (or the first) in focus: opening a menu by keyboard lands on what is in use. */
export function focusChecked(root: HTMLElement): void {
  const target = root.querySelector<HTMLButtonElement>('.source-list-item[aria-checked="true"]') ?? root.querySelector<HTMLButtonElement>('.source-list-item');
  target?.focus({ preventScroll: true });
}

export interface PopupPlace { left: number; top: number; maxHeight: number }
/**
 * Where a popup of `size` goes under (or, without room, over) the anchor, kept inside the window with a 6 px margin: the menus near the
 * companion window's edges used to run off it. Pure (tests/i190-source-pickers.test.ts).
 */
export function placePopup(anchor: { left: number; top: number; bottom: number; width: number }, size: { width: number; height: number }, view: { width: number; height: number }): PopupPlace {
  const margin = 6, gap = 4;
  const below = view.height - anchor.bottom - gap - margin, above = anchor.top - gap - margin;
  const downward = size.height <= below || below >= above;
  const room = Math.max(60, downward ? below : above);
  const height = Math.min(size.height, room);
  const top = downward ? anchor.bottom + gap : anchor.top - gap - height;
  const left = Math.min(Math.max(margin, anchor.left + anchor.width / 2 - size.width / 2), Math.max(margin, view.width - size.width - margin));
  return { left: Math.round(left), top: Math.round(Math.max(margin, top)), maxHeight: Math.round(room) };
}

/**
 * A small popup holding one source list, opened from a ▾ button: `aria-expanded` on the button, focus moves in, Esc/Tab/a click outside
 * close it and give focus back to the button when it was inside. One open at a time per popup object.
 */
export class SourcePopup {
  private root: HTMLElement | null = null;
  private trigger: HTMLElement | null = null;
  private readonly outside = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (this.root && target && !this.root.contains(target) && !this.trigger?.contains(target)) this.close(false);
  };
  private readonly keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(true); }
    else if (event.key === 'Tab') this.close(false);
  };
  constructor(private readonly doc: Document, private readonly changed: (open: boolean) => void = () => {}) {}

  get isOpen(): boolean { return !!this.root; }
  get openFor(): HTMLElement | null { return this.trigger; }

  open(trigger: HTMLElement, model: SourceListModel, pick: (id: string) => void): void {
    this.close(false);
    const root = this.doc.createElement('div');
    root.className = 'source-popup';
    root.dataset.moodUi = 'true';
    root.append(renderSourceList(this.doc, model, id => { this.close(true); pick(id); }));
    root.addEventListener('keydown', this.keys);
    this.doc.body.append(root);
    this.root = root; this.trigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    this.place();
    this.doc.addEventListener('pointerdown', this.outside, true);
    this.changed(true);
    focusChecked(root);
  }

  /** Redraws the open list (a choice made in another window, a device plugged in) without moving focus away from it. */
  refresh(model: SourceListModel, pick: (id: string) => void): void {
    const root = this.root;
    if (!root) return;
    const hadFocus = root.contains(this.doc.activeElement);
    root.replaceChildren(renderSourceList(this.doc, model, id => { this.close(true); pick(id); }));
    this.place();
    if (hadFocus) focusChecked(root);
  }

  close(returnFocus: boolean): void {
    const root = this.root, trigger = this.trigger;
    if (!root) return;
    const hadFocus = root.contains(this.doc.activeElement);
    this.root = null; this.trigger = null;
    this.doc.removeEventListener('pointerdown', this.outside, true);
    root.remove();
    trigger?.setAttribute('aria-expanded', 'false');
    if (trigger && (returnFocus || hadFocus)) trigger.focus({ preventScroll: true });
    this.changed(false);
  }

  private place(): void {
    const root = this.root, trigger = this.trigger, view = this.doc.defaultView;
    if (!root || !trigger || !view) return;
    const rect = trigger.getBoundingClientRect();
    const spot = placePopup(rect, { width: root.offsetWidth || 240, height: root.scrollHeight || 200 }, { width: view.innerWidth, height: view.innerHeight });
    root.style.left = `${spot.left}px`; root.style.top = `${spot.top}px`; root.style.maxHeight = `${spot.maxHeight}px`;
  }
}
