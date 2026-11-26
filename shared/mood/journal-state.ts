// 体验记录 I-179: the rest of her mood state beside D/O/E/N/C, for the mood
// part's journal lines: A (adenosine) and F (how tired) with the sleepiness phase, the two mood values B (boredom) and M (longing), the
// turn a chat-caused change belongs to, and the 'mood-snapshot' line written every few minutes. Numbers, closed words and one id only:
// never a word of the chat (the id is the request id of the turn; it only lines changes up with each other). Every field is optional so
// lines written before this still read; a field that does not fit is dropped, not the line.
import { FATIGUE_PHASES, finite, has, id, level, round, unit, type JournalTranslate } from '../foundation/journal-fields';
import { MOOD_CHANNELS, MOOD_LABEL_IDS, type MoodLabel, type MoodValues } from '../foundation/mood';
import { HER_LIFE_ACTIVITIES, type HerLifeActivity } from '../stage';

export type JournalFatiguePhase = (typeof FATIGUE_PHASES)[number];
/** What a mood-event / mood-judge line carries beside D/O/E/N/C: B and M before and after, A, F and the phase at that time. */
export interface MoodAux { A?: number; F?: number; phase?: JournalFatiguePhase; B?: { before: number; after: number }; M?: { before: number; after: number } }
/** Everything of her mood at one moment (a mood-book line's `now`, a snapshot's body). */
export interface MoodNow { values: MoodValues; label: MoodLabel; A?: number; F?: number; phase?: JournalFatiguePhase; B: number; M: number }
export const MOOD_SNAPSHOT_WHENS = ['start', 'switch', 'tick'] as const;
export type MoodSnapshotWhen = (typeof MOOD_SNAPSHOT_WHENS)[number];
export interface MoodSnapshotInput extends MoodNow { type: 'mood-snapshot'; characterId: string; when: MoodSnapshotWhen; activity?: HerLifeActivity }

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const pair = (value: unknown): { before: number; after: number } | undefined => {
  const v = record(value);
  return v && finite(v.before) && finite(v.after) ? { before: level(v.before), after: level(v.after) } : undefined;
};
/** The turn id of a chat-caused change, or nothing (a value that is not a plain id is dropped). */
export const turnOf = (value: unknown): { turn?: string } => { const turn = id(value); return turn ? { turn } : {}; };

/** The body fields of a line: A and F as 0-1 (two places), the phase. */
function bodyOf(v: Record<string, unknown>): Pick<MoodAux, 'A' | 'F' | 'phase'> {
  const A = unit(v.A), F = unit(v.F);
  return { ...(A !== undefined ? { A } : {}), ...(F !== undefined ? { F } : {}), ...(has(FATIGUE_PHASES, v.phase) ? { phase: v.phase } : {}) };
}

/** A mood-event / mood-judge `aux` field, or nothing when absent or unusable. */
export function moodAuxOf(value: unknown): { aux?: MoodAux } {
  const v = record(value);
  if (!v) return {};
  const B = pair(v.B), M = pair(v.M), aux: MoodAux = { ...bodyOf(v), ...(B ? { B } : {}), ...(M ? { M } : {}) };
  return Object.keys(aux).length ? { aux } : {};
}

/** A MoodNow, or null when the values or the label do not fit. */
export function moodNowOf(value: unknown): MoodNow | null {
  const v = record(value), values = record(v?.values);
  if (!v || !values || !has(MOOD_LABEL_IDS, v.label) || !finite(v.B) || !finite(v.M)) return null;
  const out = {} as MoodValues;
  for (const channel of MOOD_CHANNELS) { if (!finite(values[channel])) return null; out[channel] = level(values[channel]); }
  return { values: out, label: v.label, ...bodyOf(v), B: level(v.B), M: level(v.M) };
}

/** The 'mood-snapshot' line (shared/mood/journal-entries.ts hands its case here). */
export function buildMoodSnapshot(characterId: string | null, v: Record<string, unknown>): MoodSnapshotInput | null {
  const now = moodNowOf(v);
  if (!characterId || !now || !has(MOOD_SNAPSHOT_WHENS, v.when) || (v.activity != null && !has(HER_LIFE_ACTIVITIES, v.activity))) return null;
  return { type: 'mood-snapshot', characterId, when: v.when, ...now, ...(v.activity != null ? { activity: v.activity as HerLifeActivity } : {}) };
}

/** "D 52 O 61 E 58 N 40 C 12 · 无聊 3 想念 0 · A 0.31"; plain text. */
export function moodNowText(now: MoodNow, tr: JournalTranslate): string {
  const parts = [MOOD_CHANNELS.map(channel => `${channel} ${Math.round(now.values[channel])}`).join(' '), tr('无聊 {0} 想念 {1}', Math.round(now.B), Math.round(now.M))];
  if (now.A !== undefined) parts.push(`A ${round(now.A, 2)}`);
  if (now.F !== undefined) parts.push(tr('倦意 {0}', round(now.F, 2)));
  return parts.join(' · ');
}
