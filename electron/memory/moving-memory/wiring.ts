// I-139 A3: the host's one construction point for her "most moving thing" (electron/main.ts calls createMovingMemory once, next to her note).
// Off (getPromptSwitches().relaxed is not true): nothing is read, written or requested, and the control window's view says `active: false`.
// Security review 2026-11-15: the opening reads it only while the diary ticket ("允许记录") is valid for that scope; the window names a version
// by its `chosenAt`; `prune` (called by main.ts after a chat record is deleted, edited or forgotten) drops versions whose record is gone,
// whether the switch is on or not.
import { userProfileScopeId, type UserProfileScope } from '../user-profile';
import { askHerNoteWithClaude } from '../her-note/wiring';
import { localDateKey } from '../diary/diary-dates';
import { isLeakedDraft } from '../../brain/long-chat/history';
import type { MovingMemoryView } from '../../../shared/memory/moving-memory';
import { MovingMemoryHandoff, type HandoffOptions } from './handoff';
import { MovingMemoryStore } from './store';

export interface MovingMemoryHost {
  store: MovingMemoryStore;
  handoff: MovingMemoryHandoff;
  /** For the chat session's `openingMemory`: the thing she opens with for this scope, or null (never throws; null while the switch is off or "允许记录" is not on for it). */
  openingFor(scope: UserProfileScope): { date: string; text: string } | null;
  /** What the control window shows. */
  view(scope: UserProfileScope | null): MovingMemoryView;
  /** `chosenAt`: the version the window showed as current; nothing happens when that is not the current one any more. */
  deleteCurrent(scope: UserProfileScope | null, chosenAt: unknown): Promise<MovingMemoryView>;
  /** `chosenAt`: the version the window showed; nothing happens when it is not kept any more. */
  restore(scope: UserProfileScope | null, chosenAt: unknown): Promise<MovingMemoryView>;
  /**
   * A chat record of this scope was deleted, edited or forgotten: every version (and deleted quote) whose words no longer occur in a record
   * of the scope (for a version: a record of its own date) is removed. Reads the archive only when the scope holds something; never rejects.
   */
  prune(scope: UserProfileScope): Promise<boolean>;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function createMovingMemory(directory: string, options: Omit<HandoffOptions, 'store' | 'ask'> & { ask?: HandoffOptions['ask'] }): MovingMemoryHost {
  const store = new MovingMemoryStore(directory);
  const handoff = new MovingMemoryHandoff({ ...options, store, ask: options.ask ?? ((input, signal) => askHerNoteWithClaude(input, signal)) });
  const view = (scope: UserProfileScope | null): MovingMemoryView => {
    let on = false;
    try { on = options.enabled(); } catch { on = false; }
    if (!on || !scope) return { active: false, versions: [] };
    try {
      const state = store.state(scope);
      return { active: true, versions: state.versions.map((v, i) => ({ date: v.date, text: v.text, why: v.why ?? null, chosenAt: v.chosenAt, current: i === 0 && !state.cleared })) };
    } catch { return { active: true, versions: [] }; }
  };
  const consented = (scope: UserProfileScope) => { const ticket = options.profiles.diaryTicket(); return !!ticket && ticket.scopeId === userProfileScopeId(scope); };
  const prune = async (scope: UserProfileScope): Promise<boolean> => {
    try {
      const state = store.state(scope);
      if (!state.versions.length && !state.deleted.length) return false;
      let english = false;
      try { english = options.character(scope)?.english === true; } catch { english = false; } // I-071: judged by the character's language, as when it was chosen
      const language = english ? 'en' : null;
      const archive = options.messages(scope, 0, (options.now ?? Date.now)() + 1).filter(m => !isLeakedDraft(m, { language }));
      return await store.prune(scope, (text, date) => archive.some(m => m.content.includes(text) && (date === undefined || localDateKey(m.createdAt) === date)));
    } catch { return false; }
  };
  return {
    store, handoff, view, prune,
    openingFor: scope => { try { if (!options.enabled() || !consented(scope)) return null; const c = store.current(scope); return c ? { date: c.date, text: c.text } : null; } catch { return null; } },
    deleteCurrent: async (scope, chosenAt) => { if (scope && view(scope).active && isTime(chosenAt)) await store.deleteCurrent(scope, chosenAt); return view(scope); },
    restore: async (scope, chosenAt) => { if (scope && view(scope).active && isTime(chosenAt)) await store.restore(scope, chosenAt); return view(scope); },
  };
}
