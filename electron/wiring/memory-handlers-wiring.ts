// 记忆's handlers that were still written in electron/main.ts's registerIPC (wiring rewrite step 5, docs/claude/2026-11-17-wiring-step-5.md),
// moved unchanged: 体验记录 (E2: its switch, a dedicated intent like setInnerLoop; "刚才发生了什么" reads the writer's newest lines), the
// companion window's motion-glitch notes and the journal's fact notes. electron/main.ts calls registerJournalHandlers where those lines were,
// inside the agent channel's recorder (the wiring golden pins the handlers, their flags and what the recorder sees).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import { registerJournalIpc, type AppJournal } from '../memory';
import type { JournalExtras } from '../memory/journal/extras';
import { publicSettings, type SettingsStore } from '../settings';
import type { PartIpc } from './ipc-wiring';
import { broadcast } from './shell-wiring';
import { senseFeeds, unboundReadPause } from './unbound-wiring';
import { companionFact } from './unbound-senses-wiring';
import { poseUseFact } from './senses-pose-uses-wiring';

/** What the handlers read (the part table in electron/main.ts gives getters). */
export interface JournalHandlersNeeds {
  readonly store: SettingsStore;
  readonly pet: BrowserWindow | null;
  readonly appJournal: AppJournal;
  readonly journalExtras: JournalExtras;
  journalCharacterId(): string | null;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
}

export function registerJournalHandlers(ipc: PartIpc, needs: JournalHandlersNeeds): void {
  const { host, scopedHost } = ipc;
  // What the handlers read: each is set before the ready chain registers (registerIPC, after both windows exist) and not replaced later.
  const { store, pet, appJournal, journalExtras, journalCharacterId, mutate } = needs;
  // 体验记录 (E2): the switch is a dedicated intent like setInnerLoop; "刚才发生了什么" reads the writer's newest lines.
  registerJournalIpc(host, { journal: appJournal, enabled: () => store.current.experienceJournal === true, characterId: journalCharacterId, mutate,
    persist: async value => { await store.persist({ ...store.current, experienceJournal: value }); broadcast('desk:settings', publicSettings(store.current)); } });
  scopedHost('noteMotionGlitch', (sender, value) => sender === pet?.webContents.id && appJournal.motionGlitch(value, journalCharacterId()), false);
  scopedHost('noteJournalFact', (sender, kind, value) => kind === 'pose-use' ? (unboundReadPause(value), poseUseFact(value)) // I-189: her reading paused for you / a turned face held a barge-in (closed words; electron/senses/pose-uses/host.ts)
    : journalExtras.fact(kind, value, companionFact(kind, sender === pet?.webContents.id)), false); // batches D, F: not twice while she is out
  senseFeeds.fact = (kind, value) => journalExtras.fact(kind, value, true); // batches D, F: her full-screen page's facts, the same path (electron/unbound/sense-bridge.ts checked the window and kind)
}
