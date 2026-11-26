/**
 * I-017 (docs/claude/2026-11-03-her-state-line.md): what her body is doing to the sound right now, as the one value the companion window
 * reports to the host (shared/mood/her-state.ts StageMusicState). Read-only: it never changes what she does.
 *
 *  - off: she does not hear (the capture is off);
 *  - silent: the capture is on but nothing loud has come in for MUSIC_NEW_SONG_GAP_S;
 *  - still / nod / dance: sound is coming in and this is what her body shows: M1's tier while a song is recognized, R15's dance
 *    with "让她一直跟着跳"; and since I-016 (docs/claude/2026-11-03-listen-kind.md) "still" whenever the sound is not recognized as
 *    music (talk, a show's dialogue), because then neither the dance nor the nod is shown.
 *
 * `beat` (I-016) is the fast layer's "像音乐" score (music-likeness.ts, 0..1, two decimals), reported so the host's slower layer
 * can tell music, a show, talk and quiet apart (electron/senses/listen-kind-source.ts). 0 while she does not hear.
 */
import { MUSIC_AUDIBLE_RMS, MUSIC_NEW_SONG_GAP_S, type MusicChoice } from './music-choice';
import type { StageMusicState } from '../../shared/mood';

export { MUSIC_AUDIBLE_RMS };

export interface MusicPresenceInput {
  /** The audio switch says she hears (MmdStage.musicHearing). */
  hearing: boolean;
  /** The M1 director, absent before the music settings arrive (then the stage is the original R15 path). */
  choice: Pick<MusicChoice, 'isAlways' | 'tier' | 'getState'> | undefined;
  /** The R15 dance is on (MmdStage.musicEnabled). */
  danceOn: boolean;
  /** Seconds since the last loud sample (Infinity when none). */
  sinceLoudS: number;
  /** I-016: the fast layer recognizes music now (music-likeness.ts). Absent: as before I-016 (no recognition). */
  music?: boolean;
  /** I-016: the fast layer's score 0..1. */
  beat?: number;
  /**
   * 2026-11-24: how much of the nod and of the dance is on her
   * body now (0..1). Given, "nod" and "dance" are said only while that much of it shows (MUSIC_SHOWN_MIN); otherwise "still", the truth on
   * screen (yielding to speech or a touch, not yet on the beat, strength 0, hidden). Absent: the tier as before.
   */
  shown?: { nod: number; dance: number };
}

/** The share of a nod or a dance on her body from which she is told she does it. */
export const MUSIC_SHOWN_MIN = 0.35;

export interface MusicPresence { music: StageMusicState; always: boolean; beat: number }

export function musicPresence(input: MusicPresenceInput): MusicPresence {
  const told = tierPresence(input), shown = input.shown;
  if (!shown || (told.music !== 'nod' && told.music !== 'dance')) return told;
  return (told.music === 'nod' ? shown.nod : shown.dance) >= MUSIC_SHOWN_MIN ? told : { ...told, music: 'still' };
}

/** What the tier (her choice, or "一直跟着跳") says, before what shows is checked. */
function tierPresence(input: MusicPresenceInput): MusicPresence {
  const choice = input.choice, always = choice ? choice.isAlways : true;
  const beat = input.hearing && Number.isFinite(input.beat) ? Math.round(Math.min(1, Math.max(0, input.beat!)) * 100) / 100 : 0;
  if (!input.hearing) return { music: 'off', always, beat: 0 };
  const recent = input.sinceLoudS >= 0 && input.sinceLoudS < MUSIC_NEW_SONG_GAP_S;
  if (!recent) return { music: 'silent', always, beat };
  // The original R15 path (no settings yet) has no recognition: it dances to any sound, as it always did.
  if (!choice) return { music: input.danceOn ? 'dance' : 'still', always, beat };
  // I-016: not music → neither the dance nor the nod is shown.
  if (input.music === false) return { music: 'still', always, beat };
  if (choice.isAlways) return { music: choice.tier === 'dance' ? 'dance' : 'still', always, beat };
  if (input.music === undefined && !choice.getState().audible) return { music: 'silent', always, beat };
  const tier = choice.tier;
  return { music: tier === 'dance' ? 'dance' : tier === 'nod' ? 'nod' : 'still', always, beat };
}
