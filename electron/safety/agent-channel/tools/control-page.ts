// I-173: what
// open_control_page may be asked. A page of 「带我去」, or an item of the handbook (read_handbook's id) that names its page and the element
// to flash there, or both when they agree; a card id only for opening that card's 「更多」 menu (deleting a card lives there). Pure: the
// tool (tools/stage.ts) opens the page through the host's own 「打开控制窗口」 operation. Navigation only: nothing here changes anything.
import { CAPABILITIES, type CapabilityEntry } from '../../../../shared/settings';
import { TAKE_ME_THERE_IDS, takeMeThereItem, type TakeMeThereFocus, type TakeMeThereId } from '../../../../shared/initiative';
import { AgentToolError } from '../registry';
import { argsObject, cardId, oneOf } from '../validate';

export interface ControlPageRequest {
  page: TakeMeThereId;
  /** The handbook item asked for, with its label (shown back to Claude). */
  item?: { id: string; label: string };
  /** What the window flashes: an element id and/or the card whose 「更多」 opens. Absent: the page's own section. */
  focus?: TakeMeThereFocus;
}

const ITEM_ID = /^[a-z][a-z0-9_]{0,63}$/u;
/** The pages where a card id means something: the card wall's 「更多」 (deleting). */
const CARD_PAGES: readonly TakeMeThereId[] = ['delete-character'];

/** A handbook item by id, or null (only ids of the capability list; nothing else is looked up). */
export function handbookItem(id: string, entries: readonly CapabilityEntry[] = CAPABILITIES): CapabilityEntry | null {
  return entries.find(entry => entry.id === id) ?? null;
}

export function controlPageRequest(raw: unknown, entries: readonly CapabilityEntry[] = CAPABILITIES): ControlPageRequest {
  const args = argsObject(raw, ['page', 'item', 'character']);
  if (args.page === undefined && args.item === undefined) throw new AgentToolError('invalid_input', '给 page（「带我去」的页名）或 item（手册里那一项的 id），至少一个。');
  let page: TakeMeThereId | undefined = args.page === undefined ? undefined : oneOf(args.page, TAKE_ME_THERE_IDS, 'page ');
  let item: ControlPageRequest['item'], anchor: string | null = null;
  if (args.item !== undefined) {
    if (typeof args.item !== 'string' || !ITEM_ID.test(args.item)) throw new AgentToolError('invalid_input', 'item 只接受手册（read_handbook）里那一项的 id，比如 tts_fish_key。');
    const entry = handbookItem(args.item, entries);
    if (!entry) throw new AgentToolError('invalid_input', `手册里没有 ${args.item} 这一项；用 read_handbook {"category": …} 查 id。`);
    const place = takeMeThereItem(entry);
    if (!place) throw new AgentToolError('invalid_input', `「${entry.label}」只是界面本身，没有可以带去的那一页。`);
    if (page !== undefined && page !== place.destination) throw new AgentToolError('invalid_input', `「${entry.label}」在 ${place.destination} 这一页，不在 ${page}；只给 item 就行。`);
    page = place.destination; anchor = place.anchor; item = { id: entry.id, label: entry.label };
  }
  let character: string | undefined;
  if (args.character !== undefined) {
    if (!CARD_PAGES.includes(page!)) throw new AgentToolError('invalid_input', 'character 只和 item: character_delete（或 page: delete-character）一起用：打开那张卡的「更多」菜单。');
    character = cardId(args.character);
  }
  const focus: TakeMeThereFocus = { ...(anchor ? { anchor } : {}), ...(character ? { character } : {}) };
  return { page: page!, ...(item ? { item } : {}), ...(Object.keys(focus).length ? { focus } : {}) };
}
