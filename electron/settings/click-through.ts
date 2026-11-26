// no-pet-ok-file: the settings field holding click-through is named pet (shared/foundation/settings.ts), so its name has to be written here
// Click-through follows the user's own setting (I-223, docs/claude/2026-11-26-click-through-keeps-setting.md).
// Showing or hiding her never touches `pet.clickThrough`; only the user's own choices change it (the settings page, the tray's
// 恢复鼠标交互, 恢复桌宠, 恢复默认设置, the channel, a chat card), and each of those leaves one `setting` journal row.
// Pure functions: no Electron, so the tests import them directly.
import type { AppSettings } from '../../shared/foundation/settings';
import type { AgentSettingId, AgentSettingValue, SettingVia } from '../../shared/safety';

/** How a click-through change happened (the journal row's `via`; 'agent' and 'chat' are written by the channel's own row). */
export type ClickThroughVia = Extract<SettingVia, 'settings' | 'tray' | 'recover' | 'reset'>;

/** Tray 隐藏桌宠/显示桌宠, Ctrl+Alt+P and the companion window's close: only whether she is shown flips. */
export function toggledVisibility(current: AppSettings): AppSettings {
  return { ...current, pet: { ...current.pet, visible: !current.pet.visible } };
}

/** The tray's 恢复鼠标交互: the user's explicit rescue; she is shown and click-through goes off. */
export function trayRescue(current: AppSettings): AppSettings {
  return { ...current, pet: { ...current.pet, visible: true, clickThrough: false } };
}

/** The tray's 恢复鼠标交互 as one step: write the rescue, then the journal row that says it came from the tray. */
export async function rescueFromTray(store: { current: AppSettings; persist(next: AppSettings): Promise<unknown> }, journal: ClickThroughJournal | null | undefined, characterId: string | null): Promise<void> {
  const previous = store.current;
  await store.persist(trayRescue(previous));
  noteClickThrough(journal, characterId, previous, store.current, 'tray');
}

/** What a journal row needs when click-through differs between two settings; null when it did not change. */
export function clickThroughChange(previous: AppSettings, next: AppSettings): { previous: boolean; value: boolean } | null {
  const before = previous.pet.clickThrough === true, after = next.pet.clickThrough === true;
  return before === after ? null : { previous: before, value: after };
}

/** The part of the experience journal this needs (electron/memory/journal AppJournal.setting). */
export interface ClickThroughJournal {
  setting(id: AgentSettingId, previous: AgentSettingValue | null, value: AgentSettingValue | null, via: ClickThroughVia, characterId: string | null): void;
}

/** Writes the one row for a change (nothing when the value stayed); a journal that fails never stops the settings write. */
export function noteClickThrough(journal: ClickThroughJournal | null | undefined, characterId: string | null, previous: AppSettings, next: AppSettings, via: ClickThroughVia): void {
  const change = clickThroughChange(previous, next);
  if (!change || !journal) return;
  try { journal.setting('click_through', change.previous, change.value, via, characterId); } catch { /* the journal is only a record */ }
}
