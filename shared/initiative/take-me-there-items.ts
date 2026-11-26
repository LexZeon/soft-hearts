// I-173: one item of the
// capability list (shared/settings/capabilities.ts) → the 「带我去」 page it lives on and the element to flash there. Both sides use it: the
// user's Claude (open_control_page {"item": …}) and the handbook it reads (read_handbook's goTo), so the two land on the same page as her
// chat's 「带我去」 (which picks the same page through CAPABILITY_PLACES). Pure data and lookups: opening a place only shows a page.
//
// The anchor is the item's first control written as a plain element id (`#tts-fish-key`); an item whose controls are all patterns or
// data attributes flashes its page's section instead (the leaf target). tests/i173-reachable-options.test.ts holds every handbook item to
// "changeable through the channel, or reachable on both sides".
import { TAKE_ME_THERE, isTakeMeThereAnchor, type TakeMeThereId } from './take-me-there';
import { CAPABILITY_PLACES } from './take-me-there-coverage';

/** The two fields of a capability entry this reads (CapabilityEntry fits; no import of the settings part). */
export interface TakeMeThereItemSource { readonly id: string; readonly controls: readonly string[] }
export interface TakeMeThereItem {
  readonly destination: TakeMeThereId;
  /** The element to flash on that page (looked up by id only), or null: the page's own section. */
  readonly anchor: string | null;
}

/**
 * Items whose first plain control is not where 「带我去」 should land: deleting a card is on her tile's 「更多」 (the channel names the card),
 * not the editor's 删除 button further down.
 */
const ANCHOR_OVERRIDES: Readonly<Record<string, string | null>> = Object.freeze({ character_delete: null });

/** The page a capability item's 「带我去」 opens, or null when it has none (only the interface itself and things that are not a page). */
export function capabilityDestination(id: string): TakeMeThereId | null {
  const cover = Object.prototype.hasOwnProperty.call(CAPABILITY_PLACES, id) ? CAPABILITY_PLACES[id] : undefined;
  return typeof cover === 'string' && Object.prototype.hasOwnProperty.call(TAKE_ME_THERE, cover) ? cover : null;
}

/** The first control written as a plain element id (`#name`), without the `#`; null when there is none. */
export function capabilityAnchor(controls: readonly string[]): string | null {
  for (const control of controls) {
    const id = /^#([A-Za-z][A-Za-z0-9_-]*)$/u.exec(control.trim())?.[1];
    if (id && isTakeMeThereAnchor(id)) return id;
  }
  return null;
}

/** I-173's check: one handbook item, whether the channel can change it, and both sides' answers for it (fed with the app's real registries). */
export interface ReachInput {
  /** The capability list's entries (ui: only the interface itself; changeable: capabilityChannel). */
  readonly items: readonly (TakeMeThereItemSource & { readonly ui?: boolean; readonly label?: string; readonly changeable: boolean })[];
  /** open_control_page's page list, as the user's Claude sees it (the catalog's enum). */
  readonly channelPages: readonly string[];
  /** The page open_control_page {"item": id} opens, or null when it refuses. */
  channelItem(id: string): string | null;
  /** Whether something the user says to her makes her offer 「带我去」 to this page. */
  chatReaches(destination: TakeMeThereId): boolean;
}

/**
 * on both sides: every handbook item the channel cannot
 * change must have a 「带我去」 page that the channel's open_control_page opens (by page and by item) and that her chat can offer. Returns
 * readable lines, empty when nothing is left out. Pure: tests/i173-reachable-options.test.ts feeds it the app's registries.
 */
export function optionReachGaps(input: ReachInput): string[] {
  const gaps: string[] = [];
  for (const item of input.items) {
    if (item.ui || item.changeable) continue;
    const name = `${item.id}${item.label ? `（${item.label}）` : ''}`;
    const place = takeMeThereItem(item);
    if (!place) { gaps.push(`${name}：通道改不了，也没有「带我去」的去处`); continue; }
    if (!input.channelPages.includes(place.destination)) gaps.push(`${name}：去处 ${place.destination} 不在 open_control_page 的页名里（你的 Claude 带不过去）`);
    let opened: string | null = null;
    try { opened = input.channelItem(item.id); } catch { opened = null; }
    if (opened !== place.destination) gaps.push(`${name}：open_control_page {"item"} 没有打开 ${place.destination}（打开的是 ${opened ?? '无'}）`);
    if (!input.chatReaches(place.destination)) gaps.push(`${name}：她在聊天里给不出「带我去：${TAKE_ME_THERE[place.destination].title}」`);
  }
  return gaps;
}

/** Where 「带我去」 takes the user for this item: its page and the element to flash, or null when it has no page. */
export function takeMeThereItem(entry: TakeMeThereItemSource): TakeMeThereItem | null {
  const destination = capabilityDestination(entry.id);
  if (!destination) return null;
  const anchor = Object.prototype.hasOwnProperty.call(ANCHOR_OVERRIDES, entry.id) ? ANCHOR_OVERRIDES[entry.id] : capabilityAnchor(entry.controls);
  return { destination, anchor };
}
