// 给你留点东西 (I-050 第 2 步) wiring: turns what electron/main.ts can read into the KeepsakeHost's options, so main.ts only passes lazy readers.
// Nothing here starts anything by itself.
import path from 'node:path';
import type { MoodTendency } from '../../../shared/foundation/mood';
import { MOOD_LABELS } from '../../../shared/mood';
import { proactiveTalk, type ProactiveTalk } from '../../../shared/behaviors/inner-rhythm/knobs';
import { innerRhythmTalkScale } from '../../../shared/behaviors/inner-rhythm/choose';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import type { HerFolderHost } from './host';
import { KeepsakeHost } from './keepsake';
import { keepsakeWithClaude } from './keepsake-model';

export interface KeepsakeWiring {
  folder: HerFolderHost;
  directory(): string | null;
  characterId(): string | null;
  /** The current scope's profile (UserProfileManagement.get()): null when 「允许记录」 is off or no scope. */
  profile(): { enabled: boolean; entries: readonly { kind: string; text: string }[] } | null;
  persona(): string;
  /** The active card's language (cardLanguageOf). */
  speechLanguage?(): CardLanguage;
  mood(): { snapshot: { primary: keyof typeof MOOD_LABELS }; parameters: { weights: Partial<Record<MoodTendency, number>> } };
  talk(): ProactiveTalk | undefined;
  /** The chat model setting as stored ('' keeps Claude Code's default). */
  model(): string;
  /** The same gates proactive talk uses for background work (not asleep, the user not busy, nothing else going, Claude reachable). */
  calm(): boolean;
  /** 心情第二批: her keepsake line was shown (MoodHost.moments.note). */
  moment?(kind: 'keepsake' | 'special-day', characterId: string, key: string): void;
}

export function createKeepsake(wiring: KeepsakeWiring): KeepsakeHost {
  return new KeepsakeHost({
    folder: wiring.folder,
    file: () => { const dir = wiring.directory(); return dir ? path.join(dir, 'her-keepsakes.json') : null; },
    characterId: wiring.characterId,
    // A guess about the user ("pending_inference") is never a date she knows.
    recordingTexts: () => {
      const profile = wiring.profile();
      return profile && profile.enabled ? profile.entries.filter(entry => entry.kind !== 'pending_inference').map(entry => entry.text) : null;
    },
    persona: wiring.persona, ...(wiring.speechLanguage ? { speechLanguage: wiring.speechLanguage } : {}),
    moodWords: () => MOOD_LABELS[wiring.mood().snapshot.primary] ?? '平静',
    personality: () => wiring.mood().parameters.weights,
    talkScale: () => innerRhythmTalkScale(proactiveTalk(wiring.talk())),
    calm: wiring.calm,
    ask: (prompt, signal) => keepsakeWithClaude(prompt, wiring.model(), signal),
    ...(wiring.moment ? { moment: wiring.moment } : {}),
  });
}
