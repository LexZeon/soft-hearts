// 感知's wiring, I-189 what the local pose signals are used for (electron/senses/pose-uses/host.ts; docs/claude/2026-11-22-i189-pose-uses.md).
// startPoseAndFace (electron/wiring/senses-wiring.ts) makes the host once, before pose sensing exists, and feeds it every checked signal;
// the moments host asks it for pose facts (electron/wiring/initiative-moments-wiring.ts), the chat turn for its private lines (through
// momentsChatTurn), userGaze carries its attention reading to the windows, and the windows' 'pose-use' facts come back here
// (electron/wiring/memory-handlers-wiring.ts). No module-level side effects: nothing here runs on import.
import type { BrowserWindow } from 'electron';
import { cardLanguageOf } from '../../shared/cards';
import type { JournalInput, MemoryScope } from '../../shared/memory';
import { chatAvailability } from '../brain';
import { PoseUsesHost } from '../senses';
import { voiceCallOn } from './voice-cleanup-wiring';
import { userInputUntil } from './senses-look-wiring'; // live binding: the user is typing until then

/** The pose uses host (null until wirePoseUses ran, or when it could not be made). */
export let poseUses: PoseUsesHost | null = null;

/** What the host reads, handed over by startPoseAndFace (read when used). */
export interface PoseUsesNeeds {
  companion(): { currentScope(): MemoryScope; memory: { chatWindowSource(scope: MemoryScope): readonly { role: 'user' | 'assistant'; content: string; createdAt: number }[] } } | null;
  characterCards(): { getActive(): Parameters<typeof cardLanguageOf>[0] & { id: string } } | null;
  chatRunning(): boolean;
  /** Her voice is sounding (a reading, or a window's mouth open). */
  speaking(): boolean;
  controls(): BrowserWindow | null;
  record(input: JournalInput): void;
  journalCharacterId(): string | null;
}

const dayKey = (now: number): string => { const d = new Date(now); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

/** startPoseAndFace calls this once. */
export function wirePoseUses(needs: PoseUsesNeeds): PoseUsesHost {
  poseUses = new PoseUsesHost({
    dayKey,
    language: () => { const cards = needs.characterCards(); return cards ? cardLanguageOf(cards.getActive()) : 'zh-CN'; },
    herLine: () => {
      const chat = needs.companion(), cards = needs.characterCards();
      if (!chat || !cards) return null;
      const scope = chat.currentScope();
      if (scope.characterId !== cards.getActive().id) return null; // a card switch in between: nothing
      const last = chat.memory.chatWindowSource(scope).at(-1);
      return last?.role === 'assistant' ? { text: last.content, at: last.createdAt } : null;
    },
    herBusy: () => needs.chatRunning() || needs.speaking(),
    // #3 sends only when a typed message could go now: chat available, not typing, no call, no turn running, the control window there.
    canAnswer: () => { const controls = needs.controls(); return chatAvailability.isAvailable() && Date.now() >= userInputUntil && !voiceCallOn() && !needs.chatRunning() && !!controls && !controls.isDestroyed(); },
    // The control window's own chat box path (the same message full-screen Unbound's small box uses: src/wiring/control-window-wiring.ts).
    answer: text => { const controls = needs.controls(); if (!controls || controls.isDestroyed()) return false; controls.webContents.send('desk:unbound-say', text); return true; },
    journal: row => { needs.record({ type: 'pose-use', characterId: needs.journalCharacterId(), ...row }); },
  });
  return poseUses;
}

/** The chat turn's pose lines ('' when none): read through momentsChatTurn. */
export function poseUsesChatTurn(text: unknown): string {
  try { return poseUses?.chatTurn(text) ?? ''; } catch { return ''; }
}

/** A window's 'pose-use' fact (noteJournalFact): #1 her reading paused / resumed / ended, #2 a turned face held a barge-in. */
export function poseUseFact(value: unknown): boolean {
  try { return poseUses?.fact(value) === true; } catch { return false; }
}
