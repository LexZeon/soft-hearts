// I-059 wiring: turns what electron/main.ts can read into the SpecialDayHost's options, so main.ts only passes lazy readers.
import path from 'node:path';
import { MOOD_LABELS } from '../../../shared/mood';
import type { HerFolderHost } from '../../initiative';
import { SpecialDayHost } from './host';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import { specialLinePrompt, specialLineWithClaude } from './model';
import { herVoiceRelaxed } from '../../../shared/voice';

export interface SpecialDayWiring {
  folder: HerFolderHost;
  directory(): string | null;
  characterId(): string | null;
  /** The current scope's profile (UserProfileManagement.get()): null when 「允许记录」 is off or no scope. */
  profile(): { enabled: boolean; entries: readonly { kind: string; text: string }[] } | null;
  persona(): string;
  /** I-178: the last few turns of her current conversation as a data block (electron/brain/proactive-chat.ts), '' when none. Absent: none. */
  recentChat?(): string;
  /** I-071: her language now (default Chinese). */
  language?(): CardLanguage;
  mood(): { snapshot: { primary: keyof typeof MOOD_LABELS } };
  /** The chat model setting as stored ('' keeps Claude Code's default). */
  model(): string;
  /** The same gates proactive talk uses for background work. */
  calm(): boolean;
  journal(input: { characterId: string | null; event: 'hinted' | 'said' | 'expired' | 'user-first'; kind: 'birthday' | 'anniversary'; first: 'her' | 'user' | null }): void;
  /** 心情第二批: she spoke of the user's special day (MoodHost.moments.note('special-day'), D and O a little up). */
  moment?(characterId: string, key: string): void;
}

export function createSpecialDay(wiring: SpecialDayWiring): SpecialDayHost {
  return new SpecialDayHost({
    file: () => { const dir = wiring.directory(); return dir ? path.join(dir, 'special-day.json') : null; },
    characterId: wiring.characterId,
    folderOn: () => wiring.folder.enabled(),
    // The same source as I-050: a guess about the user ("pending_inference") is never a date she knows.
    recordingTexts: () => {
      const profile = wiring.profile();
      return profile && profile.enabled ? profile.entries.filter(entry => entry.kind !== 'pending_inference').map(entry => entry.text) : null;
    },
    // 心情第二批: "said" (she spoke of the day, in a reply or her own line) is the moment; the journal line stays as it was.
    journal: input => {
      wiring.journal(input);
      if (input.event === 'said' && input.characterId) { try { wiring.moment?.(input.characterId, `${input.kind}`); } catch { /* her mood never changes what she says */ } }
    },
    calm: wiring.calm,
    ...(wiring.language ? { language: wiring.language } : {}),
    ask: (kind, signal, language) => specialLineWithClaude(specialLinePrompt({ persona: wiring.persona(), moodWords: MOOD_LABELS[wiring.mood().snapshot.primary] ?? (language === 'en' ? 'calm' : '平静'), kind, ...(language ? { language } : {}), ...(herVoiceRelaxed() ? { relaxed: true } : {}), chat: (() => { try { return wiring.recentChat?.() ?? ''; } catch { return ''; } })() }), wiring.model(), signal, undefined, language),
  });
}
