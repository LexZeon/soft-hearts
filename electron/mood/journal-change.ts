// 体验记录 I-179: the numbers a mood journal line carries beside D/O/E/N/C, read from the state the model really has (nothing is
// invented): B boredom and M longing (before and after), A adenosine, F how tired and the sleepiness phase, and for a chat-caused
// change the id of the turn. Split out of electron/mood/mood.ts so that file does not grow. Reads only; changes no mood.
import { getMoodSnapshot, type MoodParameters, type MoodState, type SpeechIntervalStretch } from '../../shared/foundation/mood';
import type { FatigueView, MoodAux } from '../../shared/mood';
import type { MoodJournalEvent } from '../memory';

type Fatigue = Pick<FatigueView, 'A' | 'F' | 'phase'> | undefined;
const fatigueFields = (fatigue: Fatigue) => fatigue ? { A: fatigue.A, F: fatigue.F, phase: fatigue.phase } : {};

/** The mood journal event for one accepted change: `before` is the state advanced to the event's time, `after` the state now. */
export function moodJournalEvent(characterId: string, after: MoodState, parameters: MoodParameters, stretch: SpeechIntervalStretch, before: MoodState,
  event: Pick<MoodJournalEvent, 'type' | 'reason' | 'context' | 'effectiveMs' | 'turn'>, fatigue: Fatigue): MoodJournalEvent {
  const was = getMoodSnapshot(before, before.updatedAt, parameters, stretch), now = getMoodSnapshot(after, after.updatedAt, parameters, stretch);
  const aux: MoodAux = { ...fatigueFields(fatigue), B: { before: was.boredom, after: now.boredom }, M: { before: was.longing, after: now.longing } };
  return { characterId, ...event, before: { ...before.values }, after: { ...after.values }, labelBefore: was.primary, labelAfter: now.primary, aux };
}
