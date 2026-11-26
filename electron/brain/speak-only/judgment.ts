// I-098 B: one message's judge, after its reply completed and was kept (moved out of companion.ts unchanged for I-209 step 2, which
// needed the room there). Its answer goes the tail's own way, once (the mood event `appraisal-<id>` in reply to this message: with the
// reaction table on it takes the tail's share of MoodBlend, so haiku's parallel read and this one never add up to more than one message;
// the mood core takes one appraisal per message, and only for the newest). A newer message, another character or conversation: nothing
// of the answer is used. No usable answer (failed, timed out, capped, off the rules, unconfident): the tailless lift stands in, as for a
// reply without a usable tail.
import type { JournalInput } from '../../../shared/memory';
import { chatActionAllowed, type ChatActionWord } from '../../../shared/brain/chat-actions';
import { getPromptSwitches } from '../../../shared/brain/prompt-switches';
import type { MoodHost } from '../../mood';
import type { DayReadStore, RelationshipHost } from '../../memory';
import type { UserStateStore } from '../../senses';
import type { ChatActionPort } from '../companion';
import type { SpeakOnlyJudge, SpeakOnlyOutcome } from './judge-host';
import { judgeBookInput } from './book-journal';

/** What the judgment touches (CompanionService's own parts). */
export interface SpeakOnlyJudgmentPorts {
  mood: MoodHost;
  /** The judge in use now (a newer setSpeakOnly makes an older one's answer unused). */
  judgeNow(): SpeakOnlyJudge | null;
  /** The tail's one line of her numbers now. */
  moodNow(): string;
  note(input: JournalInput): void;
  chatActions: ChatActionPort | null;
  userState: UserStateStore;
  dayRead: DayReadStore;
  relationship: RelationshipHost;
}

export async function speakOnlyJudgment(ports: SpeakOnlyJudgmentPorts, judge: SpeakOnlyJudge, turn: { id: string; characterId: string; conversationId: string; userText: string; reply: string;
  persona: string; actions: readonly ChatActionWord[]; expressionToken: string; current: () => boolean }): Promise<SpeakOnlyOutcome> {
  const { id, characterId } = turn, { mood, chatActions } = ports;
  let outcome: SpeakOnlyOutcome;
  try { outcome = await judge.judge(id, { userText: turn.userText, reply: turn.reply, moodNow: ports.moodNow(), persona: turn.persona, ...(getPromptSwitches().situation ? { fullPersonality: true } : {}), actions: turn.actions }); }
  catch { outcome = { kind: 'failed', ms: 0 }; }
  // I-098: the journal's mood-book line (closed values and numbers only), with the outcome as it was used.
  const book = (used: SpeakOnlyOutcome) => { try { ports.note(judgeBookInput(characterId, used, id)); } catch { /* the journal never changes her mood */ } };
  try {
    const live = turn.current() && ports.judgeNow() === judge;
    if (!live || !judge.isLatest(id) || outcome.kind === 'superseded') {
      book({ kind: 'superseded' });
      mood.cancelChatGesture(id);
      // Replaced by a newer message in the same conversation: the reply still counts as a message without a usable tail.
      if (live) mood.moments.tailless(characterId, id);
      return { kind: 'superseded' };
    }
    book(outcome);
    if (outcome.kind !== 'judged') {
      mood.cancelChatGesture(id);
      mood.moments.tailless(characterId, id);
      return outcome;
    }
    const { appraisal, userState, chatAction } = outcome.judgment;
    mood.event({ type: 'appraisal', id: `appraisal-${id}`, responseTo: id, ...appraisal }, characterId, { expressions: turn.expressionToken === mood.get().token });
    mood.requestChatGesture(id, appraisal, turn.expressionToken);
    const view = mood.get();
    if (chatAction && view.token === turn.expressionToken && chatActionAllowed(chatAction, { expressions: view.expressions, snapshot: view.snapshot }))
      try { chatActions?.request(chatAction); } catch { /* the stage simply does not get it */ }
    else if (chatAction) { try { chatActions?.noted?.(chatAction, 'held'); } catch { /* journal only */ } }
    else { try { chatActions?.noted?.(null, null); } catch { /* journal only */ } }
    ports.userState.note(characterId, userState);
    ports.dayRead.noteSaid(userState?.state);
    if ((userState && userState.state !== 'calm' && userState.state !== 'unknown') || appraisal.context === 'concern' || appraisal.context === 'support')
      void ports.relationship.noteQuality(characterId);
    return outcome;
  } catch { return outcome; }
}
