// I-098: the experience journal's 'mood-book' line for one typed message (shared/foundation/mood-book.ts): who kept the book, how it went, and
// the numbers it gave as answered. Built here from the judge's outcome or her accepted tail; nothing of the reply, the user's words
// or the reason text goes in.
import type { JournalInput } from '../../../shared/memory';
import type { MoodAppraisal } from '../../mood';
import type { UserStateJudgment } from '../../../shared/senses';
import type { SpeakOnlyOutcome } from './judge-host';

type MoodBookInput = Extract<JournalInput, { type: 'mood-book' }>;

const time = (ms: number) => Number.isFinite(ms) && ms >= 0 ? { ms: Math.round(ms) } : {};

/** The judge's line: its outcome as the companion used it (superseded when the answer was not used). */
export function judgeBookInput(characterId: string, outcome: SpeakOnlyOutcome, turn?: string): MoodBookInput {
  return { ...judgeBook(characterId, outcome), ...(turn ? { turn } : {}) };
}
function judgeBook(characterId: string, outcome: SpeakOnlyOutcome): MoodBookInput {
  if (outcome.kind === 'judged') {
    const { appraisal, userState } = outcome.judgment;
    return { type: 'mood-book', characterId, by: 'judge', outcome: 'judged', ...(outcome.via ? { via: outcome.via } : {}), context: appraisal.context,
      delta: { ...appraisal.delta }, ...(userState ? { user: true as const } : {}), ...time(outcome.ms) };
  }
  if (outcome.kind === 'unusable') return { type: 'mood-book', characterId, by: 'judge', outcome: 'unusable', ...(outcome.via ? { via: outcome.via } : {}), ...time(outcome.ms) };
  if (outcome.kind === 'failed') return { type: 'mood-book', characterId, by: 'judge', outcome: 'failed', ...time(outcome.ms) };
  return { type: 'mood-book', characterId, by: 'judge', outcome: outcome.kind };
}

/** Her own tail's line (an accepted tail on a typed message): the same numbers, for comparison. */
export function tailBookInput(characterId: string, appraisal: Pick<MoodAppraisal, 'context' | 'delta'>, userState: UserStateJudgment | null, turn?: string): MoodBookInput {
  return { type: 'mood-book', characterId, by: 'tail', outcome: 'judged', context: appraisal.context, delta: { ...appraisal.delta }, ...(userState ? { user: true as const } : {}), ...(turn ? { turn } : {}) };
}
