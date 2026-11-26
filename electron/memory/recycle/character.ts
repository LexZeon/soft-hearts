// I-144 删角色先进回收站. Deleting a character makes one bin
// entry: her card with its model binding, reaction settings and picture, and, when "同时删除她的记忆" was ticked, every row of the data map
// the bin keeps (electron/foundation/data-map.ts recycle: 'take'), her own earlier bin entries included. Everything is captured first, the
// entry is written, and only then is anything removed: a capture that fails, or an entry that cannot be written, deletes nothing.
// Finding her back puts every row back as it was, under the same id; she does not become the current character.
// No Electron import: tests drive it with real stores.
import type { MemoryScope } from '../../../shared/memory/memory';
import { DATA_MAP, dataStore, recycleIds, type RecycleId } from '../../foundation/data-map';
import type { MemoryRecycleBin, RecycleSummaryView } from '../memory-recycle-bin';
import type { RecyclePort, RecycleRegistry } from './ports';

/** The rows that go with the card whether or not the box is ticked (data map characterForget 'with-card'). */
export const CARD_ROWS: readonly RecycleId[] = DATA_MAP.filter(row => row.characterForget === 'with-card' && row.recycle === 'take').map(row => row.id as RecycleId);
/** Removed by the host's own card removal (the card and its reaction settings go together, electron/cards/character-response.ts). */
const REMOVED_WITH_CARD: readonly RecycleId[] = ['character-cards', 'character-response'];
/** Rebuilt from the others when they come back, so they go back last; and the bin's own earlier entries last of all. */
const RESTORED_LAST: readonly RecycleId[] = ['memory-keywords', 'memory-vectors', 'recycle-bin'];

/**
 * Restore order: the card first (the rest may check she exists), then the index of her connections, then the table's order, then what is
 * worked out from the rest. Removal runs the other way round (the card first: it is the one step that may refuse, the last card).
 */
export function restoreOrder(ids: readonly RecycleId[] = recycleIds()): RecycleId[] {
  const first: RecycleId[] = [...CARD_ROWS, 'memory-scopes'];
  return [...first.filter(id => ids.includes(id)), ...ids.filter(id => !first.includes(id) && !RESTORED_LAST.includes(id)), ...RESTORED_LAST.filter(id => ids.includes(id))];
}
export function removeOrder(ids: readonly RecycleId[] = recycleIds()): RecycleId[] { return [...restoreOrder(ids)].reverse().sort((a, b) => Number(CARD_ROWS.includes(b)) - Number(CARD_ROWS.includes(a))); }

/** One row's capture: per character, or per connection scope. */
export type CapturedRow = { per: 'character'; value: unknown } | { per: 'scope'; values: Record<string, unknown> };
export interface CharacterEntryData {
  kind: 'character';
  characterId: string;
  /** The box was ticked: her memories are in here too. */
  memories: boolean;
  rows: Partial<Record<RecycleId, CapturedRow>>;
}

export interface CharacterRecyclePorts {
  bin: MemoryRecycleBin;
  registry: RecycleRegistry;
  /** Every connection she may have memories under (characterProviderScopes). */
  providerScopes(characterId: string): string[];
  /** The host removes the card (and its reaction settings); it may refuse (the last card). */
  removeCard(characterId: string): Promise<void>;
  /** Whether a card with this id exists now. */
  cardExists(characterId: string): boolean;
}

export interface CharacterRecycleOutcome { entry: RecycleSummaryView; failed: RecycleId[] }
export interface CharacterRestoreOutcome { restored: RecycleSummaryView; failed: RecycleId[]; replaced: RecycleSummaryView | null }

const label = (id: RecycleId) => dataStore(id).label;

async function captureRows(characterId: string, ids: readonly RecycleId[], ports: Pick<CharacterRecyclePorts, 'registry' | 'providerScopes'>, strict: boolean):
  Promise<Partial<Record<RecycleId, CapturedRow>>> {
  const rows: Partial<Record<RecycleId, CapturedRow>> = {};
  const scopes = ports.providerScopes(characterId);
  for (const id of ids) {
    const port = ports.registry[id];
    if (!port) continue;
    try {
      if (port.per === 'character') {
        const value = await port.capture(characterId);
        if (value !== null && value !== undefined) rows[id] = { per: 'character', value };
      } else {
        const values: Record<string, unknown> = {};
        for (const providerScope of scopes) {
          const value = await port.capture({ characterId, providerScope });
          if (value !== null && value !== undefined) values[providerScope] = value;
        }
        if (Object.keys(values).length) rows[id] = { per: 'scope', values };
      }
    } catch (error) {
      if (strict) throw new Error(`「${label(id)}」没能收进回收站，所以什么都没删。`, { cause: error });
    }
  }
  return rows;
}

async function eachTarget(port: RecyclePort, characterId: string, row: CapturedRow, run: (target: MemoryScope | string, captured: unknown) => Promise<unknown>): Promise<void> {
  if (port.per === 'character' && row.per === 'character') { await run(characterId, row.value); return; }
  if (port.per === 'scope' && row.per === 'scope') {
    for (const [providerScope, value] of Object.entries(row.values)) await run({ characterId, providerScope }, value);
    return;
  }
  throw new Error('回收站里这一项的数据不完整，原文件已保留。');
}

/**
 * Deletes a character through the bin. `forgetMemories`: the box "同时删除她的记忆" (her memories go into the same entry; unticked they stay
 * where they are). Throws, deleting nothing, when a part cannot be captured, the entry cannot be written, or the card cannot be removed.
 * `failed`: parts that were captured but could not be removed afterwards (they stay where they were, and their copy is in the entry).
 */
export async function recycleCharacter(characterId: string, characterName: string, forgetMemories: boolean, ports: CharacterRecyclePorts): Promise<CharacterRecycleOutcome> {
  if (!ports.bin.ready) throw new Error('回收站还没准备好，什么都没删，稍后再试。');
  const ids = forgetMemories ? recycleIds() : CARD_ROWS;
  const rows = await captureRows(characterId, ids, ports, true);
  const data: CharacterEntryData = { kind: 'character', characterId, memories: forgetMemories, rows };
  const entry = await ports.bin.put({ characterId, characterName, part: 'character', count: Object.keys(rows).length, memories: forgetMemories,
    label: forgetMemories ? '角色卡和她的全部记忆' : '角色卡和模型关联' }, data);
  try { await ports.removeCard(characterId); }
  catch (error) { await ports.bin.discard(entry.id).catch(() => { /* Cleared at the bin's next load. */ }); throw error; }
  const failed: RecycleId[] = [];
  for (const id of removeOrder(Object.keys(rows) as RecycleId[])) {
    if (REMOVED_WITH_CARD.includes(id)) continue;
    const port = ports.registry[id], row = rows[id];
    if (!port || !row) continue;
    try { await eachTarget(port, characterId, row, (target, captured) => (port.remove as (t: unknown, c: unknown) => Promise<unknown>)(target, captured)); }
    catch { failed.push(id); }
  }
  return { entry, failed };
}

/**
 * Puts a character entry back. Anything of hers that appeared since (it should not: her id was gone) goes into a new entry first, so
 * nothing is lost. The entry leaves the bin only when every part came back; otherwise it stays, and finding back again finishes it.
 */
export async function restoreCharacterEntry(entryId: unknown, ports: CharacterRecyclePorts): Promise<CharacterRestoreOutcome> {
  const { summary, data } = await ports.bin.read(entryId);
  const value = data as CharacterEntryData | null;
  if (!value || value.kind !== 'character' || value.characterId !== summary.characterId || !value.rows || typeof value.rows !== 'object')
    throw new Error('回收站里这一项的数据不完整，原文件已保留。');
  const characterId = summary.characterId;
  const known = new Set<string>(recycleIds());
  const ids = (Object.keys(value.rows) as RecycleId[]).filter(id => known.has(id));
  // The card is back already (an earlier try put it back, then stopped): its rows are done.
  const cardBack = ports.cardExists(characterId);
  const todo = ids.filter(id => !(cardBack && CARD_ROWS.includes(id)));
  // What is there now under her id goes into the bin first, then out of the way.
  const memoryIds = todo.filter(id => !CARD_ROWS.includes(id) && id !== 'recycle-bin');
  const residue = await captureRows(characterId, memoryIds, ports, true);
  let replaced: RecycleSummaryView | null = null;
  if (Object.keys(residue).length) {
    replaced = await ports.bin.put({ characterId, characterName: summary.characterName, part: 'character', count: Object.keys(residue).length, memories: true,
      label: '找回时换下来的记忆' }, { kind: 'character', characterId, memories: true, rows: residue } satisfies CharacterEntryData);
    for (const id of removeOrder(Object.keys(residue) as RecycleId[])) {
      const port = ports.registry[id], row = residue[id];
      if (port && row) await eachTarget(port, characterId, row, (target, captured) => (port.remove as (t: unknown, c: unknown) => Promise<unknown>)(target, captured));
    }
  }
  const failed: RecycleId[] = [];
  for (const id of restoreOrder(todo)) {
    const port = ports.registry[id], row = value.rows[id];
    if (!row) continue;
    if (!port) { failed.push(id); continue; }
    try { await eachTarget(port, characterId, row, (target, captured) => (port.restore as (t: unknown, c: unknown) => Promise<void>)(target, captured)); }
    catch { failed.push(id); }
  }
  if (!failed.length) await ports.bin.remove(summary.id);
  return { restored: summary, failed, replaced };
}
