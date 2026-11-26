// I-134 new chat (docs/claude/2026-11-14-i134-new-chat-plan.md): small pieces shared by the host-built chat window, her nightly note
// and the replay harness (scripts/lib/i134-replay.ts), so all three see the same text for the same message.
//   - time markers: 【11月5日 21:30】 in front of a message that starts a new local day or comes 3 hours or more after the one before;
//   - leaked drafts: an old reply of hers that shows a draft, a plan in English or an internal tag. Such replies are left out of what is
//     sent to Claude (the archive itself is never changed), because a long window full of them invites her to leak again.
import { localDateKey } from '../../memory';
import { getPromptSwitches } from '../../../shared/brain/prompt-switches';

export interface Timed { role: 'user' | 'assistant'; content: string; createdAt: number }

export const MARKER_GAP_MS = 3 * 3_600_000;
const pad2 = (value: number) => String(value).padStart(2, '0');

/** `【11月5日 21:30】`, local time. */
export function timeMarker(ms: number): string {
  const date = new Date(ms);
  return `【${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}】`;
}

/** A message gets a marker when it is on another local day than the one before it, or at least 3 hours after it. The first message gets none. */
export function needsMarker(previousAt: number | null, at: number): boolean {
  return previousAt !== null && (localDateKey(previousAt) !== localDateKey(at) || at - previousAt >= MARKER_GAP_MS);
}

/** Markers decided on the whole sequence given, so the same message reads the same wherever a window starts. */
export function markTimes<T extends Timed>(messages: readonly T[]): T[] {
  return messages.map((message, index) => needsMarker(index > 0 ? messages[index - 1]!.createdAt : null, message.createdAt)
    ? { ...message, content: timeMarker(message.createdAt) + message.content } : { ...message });
}

/** Internal tags that must never be in a reply she said out loud. */
const INTERNAL_TAG = /<\/?\s*(thinking|thinking_mode|reply|analysis|scratchpad|sh-[a-z-]+)\b/iu;
/** A run of 40+ characters that is almost all ASCII letters and spaces: a plan or screen description in English. */
const ENGLISH_RUN = /[A-Za-z][A-Za-z ,.'’:;()\-]{39,}/u;
/** A note to herself in Chinese: she never calls you 用户 when she talks to you, and these words only appear in instructions. */
const CHINESE_NOTE = /用户[^。！？\n]{0,40}(回复|语气|照做|设定|尾注)|(回复|语气重点)[^。！？\n]{0,20}用户/u;

/**
 * I-139 (docs/claude/2026-11-15-i139-defences.md): under the I-139 switch the instructions call the person "这个人", so a note in the
 * new words reads "这个人想听安慰，回复要轻一点". She says "这个人"/"对方" in speech too, so only a sentence said to no one counts
 * (no you or me, no particle, no ！？～): the same shape as CHINESE_NOTE, judged a sentence at a time.
 */
const LISTENER_NOTE = /(?:(?<![你您我他她它那哪谁])这个人(?![家们])|对方)[^。！？\n]{0,40}(回复|回应|语气|照做|设定|尾注)|(回复|回应|语气重点)[^。！？\n]{0,20}(?:(?<![你您我他她它那哪谁])这个人(?![家们])|对方)/u;
const SAID_TO_SOMEONE = /[你您咱俺我]|人家|[呀呢啦吧嘛哦哟哈嘿哼嗯唔诶欸哎啊哇嘻喔噢嗷呐咯嘞喽呗]|[！？～~!?]/u;
/** I-071: the card speaks English (CardLanguage 'en'; I-139's language 'en' reads the same). */
export const englishChat = (language: string | null | undefined): boolean => language === 'en';
const listenerNote = (content: string): boolean => content.split(/(?<=[。！？!?\n])/u).some(sentence => LISTENER_NOTE.test(sentence) && !SAID_TO_SOMEONE.test(sentence));

/**
 * True for one of her replies that leaked a draft, an English plan or an internal tag when it was written. Only assistant messages
 * are judged. Measured on the real chat of 2026-11-03..13 (private): it flags the leaks found by reading the chat and nothing else
 * (docs/claude/2026-11-14-i134-new-chat-plan.md). `listenerWords` (default: the I-139 switch) also reads notes in the new words.
 */
// `language`: the card's (I-071). An English card's replies are English prose, so the English-run rule is not applied to them (2026-11-21:
// it dropped every reply of One (English) from the window, the window then ended before her last reply and every turn started a cold
// process, docs/claude/2026-11-21-warm-reuse-diverged.md); an English plan in them is the live guard's job (reply-draft-guard.ts isEnglishPlan).
export function isLeakedDraft(message: Pick<Timed, 'role' | 'content'>, options: { listenerWords?: boolean; language?: string | null } = {}): boolean {
  if (message.role !== 'assistant') return false;
  return INTERNAL_TAG.test(message.content) || (!englishChat(options.language) && ENGLISH_RUN.test(message.content)) || CHINESE_NOTE.test(message.content)
    || ((options.listenerWords ?? getPromptSwitches().relaxed === true) && listenerNote(message.content));
}
