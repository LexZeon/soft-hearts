// 记忆's window and quit steps (wiring rewrite step 5b, docs/claude/2026-11-17-wiring-step-5b.md), moved from electron/main.ts's
// windowEvents and before-quit word for word. electron/main.ts's order lists say which run when, in which order: wireWindowEvents
// (electron/wiring/window-events-wiring.ts) for a window's events, wireQuit (electron/wiring/quit-wiring.ts) before quitting; the wiring
// golden pins both. A window step is called with the window's scope (win, owner, windowId).
// What they read: 记忆's own live bindings, imported; the experience journal and the app session (made by electron/main.ts while it is
// evaluated, before any step can run), bound once by wireMemoryCleanup.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app, type BrowserWindow } from 'electron';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { settleWithin } from '../foundation/settle-within';
import type { AppJournal, readBuildCommit } from '../memory';
import type { AppSessionHost } from '../memory/app-session/host';
import type { JournalExtras } from '../memory/journal/extras';
import { diaryWriter, herNote, memoryNotes, movingMemory, reviewWriter, semantic, textInvitationMemory, textMemorialHost, upcoming, userProfileManagement,
  userProfileSource, userProfiles } from './memory-wiring';

/** The experience journal's objects electron/main.ts makes (fixed once made). */
export interface MemoryCleanupNeeds {
  readonly appJournal: AppJournal;
  readonly buildCommit: ReturnType<typeof readBuildCommit>;
  readonly appSession: AppSessionHost;
  readonly journalExtras: JournalExtras;
  journalCharacterId(): string | null;
}
let appJournal!: AppJournal;
let buildCommit!: ReturnType<typeof readBuildCommit>;
let appSession!: AppSessionHost;
let journalExtras!: JournalExtras;
let journalCharacterId!: () => string | null;

/** electron/main.ts binds the steps once its journal objects are made. */
export function wireMemoryCleanup(needs: MemoryCleanupNeeds): void {
  ({ appJournal, buildCommit, appSession, journalExtras } = needs);
  journalCharacterId = () => needs.journalCharacterId();
}

// ---- window steps

/** Page-gone step: the companion's renderer is gone: a text memorial being written stops. */
export function cancelPetMemorial(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if(owner==='pet')textMemorialHost?.cancel();
}

// ---- quit steps

/** Quit step, first: the experience journal's stop line is written now, synchronously. */
export function noteQuitting(): void {
  appJournal.appQuitting(app.getVersion(), buildCommit, journalCharacterId(), appSession.stop()); // I-022: the stop is written now, synchronously; it never waits
}
/** Quit step: her profile source, diary, note, moving memory, look-backs, profile management and text memorials stop. */
export function releaseProfile(): void {
  userProfileSource.clear();
  diaryWriter?.dispose(); herNote?.writer.dispose(); movingMemory?.handoff.dispose();
  reviewWriter?.dispose();
  userProfileManagement?.dispose();
  textMemorialHost?.dispose();
}
/** Flush step: chat notes, recall by meaning and plans finish their pending saves. */
export async function flushMemoryNotes(): Promise<void> {
  await memoryNotes?.dispose(); // I-021: the running note call stops; pending note saves finish
  await semantic?.recall.flush().catch(() => undefined); semantic?.host.dispose(); // I-111: computed vectors are written; the embedding process ends
  await upcoming?.dispose(); // P-001: pending mark saves finish
}
/** Flush step, last: text invitations, the journal's reading and lines, and the 「允许记录」 switch are written. */
export async function flushMemoryStores(): Promise<void> {
  await textInvitationMemory?.flush();
  journalExtras.reading.flush();
  await appJournal.flush();
  await settleWithin(userProfiles?.settled()); // the 「允许记录」 switch's file write (≤1.5 s), so a restart reads the new value
}
