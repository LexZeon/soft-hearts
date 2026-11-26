// 「带我去」 button (I-051, shared/initiative/take-me-there.ts): shown under her reply where a setting card would be. DOM by textContent only;
// the one thing a tap does is ask the host to open a page (the host decides, a closed set of ids). It never changes a setting.
import { uiText, uiTemplate } from '../foundation/ui-language';
import { TAKE_ME_THERE, isTakeMeThereAnchor, isTakeMeThereCharacter, isTakeMeThereId, type TakeMeThereRequest, type TakeMeThereView } from '../../shared/initiative/take-me-there';
import { CONTROL_NAVIGATION, isNavigationGroup, type ControlNavigationLeaf, type ControlNavigationNode } from '../settings';

/** Strict shape check of host data before any DOM work; anything else is ignored. */
export function readTakeMeThere(value: unknown): TakeMeThereView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'take-me-there' || v.version !== 1 || typeof v.offerId !== 'string' || !v.offerId || v.offerId.length > 120
    || !isTakeMeThereId(v.destination) || (v.state !== 'open' && v.state !== 'gone')) return null;
  return { kind: 'take-me-there', version: 1, offerId: v.offerId, destination: v.destination, state: v.state };
}

/** The navigation leaf of a destination (null when the control window no longer has it). */
export function takeMeThereLeaf(destination: unknown): ControlNavigationLeaf | null {
  if (!isTakeMeThereId(destination)) return null;
  const find = (nodes: readonly ControlNavigationNode[]): ControlNavigationLeaf | null => {
    for (const node of nodes) {
      if (isNavigationGroup(node)) { const inner = find(node.children); if (inner) return inner; }
      else if (node.id === TAKE_ME_THERE[destination].leafId) return node;
    }
    return null;
  };
  return find(CONTROL_NAVIGATION);
}

type Doc = Pick<Document, 'createElement'>;

export interface TakeMeTherePorts {
  go(request: TakeMeThereRequest): Promise<boolean>;
  /** Where the button goes: the end of the chat log, or the companion's chat area. */
  container(): HTMLElement | null;
  error?(message: string): void;
  /** Insert first (the companion's chat area, above the input) instead of last. */
  prepend?: boolean;
}

export class TakeMeThereOffers {
  private shown: { root: HTMLElement; offerId: string; busy: boolean } | null = null;
  constructor(private readonly ports: TakeMeTherePorts, private readonly doc: Doc = document) {}

  /** A new button, or the host taking the shown one away. Only one is ever shown. */
  present(raw: unknown): void {
    const view = readTakeMeThere(raw);
    if (!view) return;
    if (view.state === 'gone') { if (this.shown?.offerId === view.offerId) this.clear(); return; }
    this.clear();
    const container = this.ports.container();
    if (!container) return;
    const root = this.doc.createElement('section');
    root.className = 'take-me-there';
    root.setAttribute('role', 'group');
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = 'take-me-there__button';
    button.textContent = uiTemplate`带我去：${uiText(TAKE_ME_THERE[view.destination].title)}`;
    button.onclick = () => void this.tap(view, button);
    root.append(button);
    this.shown = { root, offerId: view.offerId, busy: false };
    if (this.ports.prepend) container.prepend(root); else container.append(root);
  }

  clear(): void { this.shown?.root.remove(); this.shown = null; }

  private async tap(view: TakeMeThereView, button: HTMLButtonElement): Promise<void> {
    const shown = this.shown;
    if (!shown || shown.offerId !== view.offerId || shown.busy) return;
    shown.busy = true; button.disabled = true;
    try {
      if (!await this.ports.go({ offerId: view.offerId, destination: view.destination })) this.clear(); // Expired or stale: the button goes.
    } catch (error) { this.ports.error?.(String(error instanceof Error ? error.message : error)); }
    finally { shown.busy = false; button.disabled = false; }
  }
}

/** I-173: how the control window finds the item a request names (by element id only; a card's tile through the character page). */
export interface TakeMeThereFocusPorts {
  byId(id: string): HTMLElement | null;
  /** Opens that card's 「更多」 menu on the card wall and returns the element to flash (its 删除), or null. Never clicks anything. */
  revealCardMenu?(characterId: string): Promise<HTMLElement | null>;
}
/**
 * I-173: the element to flash for a navigate request: the card's 「更多」 when a card id came, else the anchor's element, else the page's own
 * section (the leaf target). Shapes are checked again here (an element id, a UUID), so nothing else is ever looked up.
 */
export async function takeMeThereFocusElement(request: unknown, leafTarget: string, ports: TakeMeThereFocusPorts): Promise<HTMLElement | null> {
  const focus = request && typeof request === 'object' ? request as { anchor?: unknown; character?: unknown } : {};
  if (isTakeMeThereCharacter(focus.character) && ports.revealCardMenu) {
    const menu = await ports.revealCardMenu(focus.character.toLowerCase()).catch(() => null);
    if (menu) return menu;
  }
  return (isTakeMeThereAnchor(focus.anchor) ? ports.byId(focus.anchor) : null) ?? ports.byId(leafTarget);
}

/** Briefly marks the item a tap led to (control window). Never invokes it. */
export const TAKE_ME_THERE_FLASH_MS = 1800;
export function flashTarget(element: HTMLElement | null, schedule: (callback: () => void, ms: number) => unknown = setTimeout): void {
  while (element && element.getClientRects().length === 0 && element.parentElement) element = element.parentElement; // A hidden item: its visible container.
  const marked = element;
  if (!marked) return;
  marked.classList.add('take-me-there-flash');
  schedule(() => marked.classList.remove('take-me-there-flash'), TAKE_ME_THERE_FLASH_MS);
}
