// I-098 "她只管说话" (docs/claude/2026-11-12-chat-overall-plan.md A–C; experiment record docs/claude/2026-11-12-i098-experiment.md).
// One knob, chosen by the app's channel (after the blind pick: adopt it): ON in the development channel and in
// source runs, and since 2026-11-25 in the stable channel and the public release too. Off, nothing here is used and every prompt is byte for byte
// what it was. On:
//  A. an ordinary turn carries no state tail: she writes only what she says (the opening marker and the draft filter stay);
//  B. after her reply is complete, one haiku step reads the user's message and her shown reply and gives what the tail gave
//     (electron/brain/speak-only/judge.ts), applied through the tail's own path (CompanionService). With the reaction judge on, the step
//     runs on its warm haiku right after that message's reaction call (electron/brain/speak-only/route.ts); otherwise a one-off call;
//  C. the reply-rhythm text (conversationReplyInstruction) is replaced by the human speaking rules below;
//  D. the settings catalog leaves her fixed system prompt and comes into a turn's private context only when the message looks
//     like a settings request (chat-settings.ts mentionsSettings, a local regular expression).
// A turn that needs the tail as a carrier (a settings proposal, a text memorial, her folder's file block, the nickname question)
// keeps today's tail on that turn, and then the judge is not asked: mood is never written twice for one message.

/** The stable channel's value. On since; was off until the usual acceptance. */
export const SPEAK_ONLY_STABLE = true;

/** The installed channel as electron/desktop-channel.ts names it; null or undefined for a source run (pnpm dev, tests' apps). */
export type SpeakOnlyChannel = 'stable' | 'development' | null | undefined;

/**
 * The switch for this app: the development channel and a source run (not packaged) carry it; the stable channel, and a packaged
 * build outside both managed channels, take SPEAK_ONLY_STABLE.
 */
export function speakOnlyEnabled(channel: SpeakOnlyChannel, packaged: boolean): boolean {
  if (channel === 'development') return true;
  if (channel === 'stable') return SPEAK_ONLY_STABLE;
  return packaged ? SPEAK_ONLY_STABLE : true; // the public release (packaged, outside both managed channels) takes the stable value
}

/**
 * C: the speaking rules that replace conversationReplyInstruction in companion chat. The first sentence is the plan's text
 * (user approved the direction, "先做实验"); the second keeps the two lines of the old text that are about honesty and safety,
 * not style (no invented progress or shared past; chat has no tools). Companion rule 5 (how to explain steps) stays in the
 * fixed system prompt (shared/brain/companion-rules.ts).
 */
export const SPEAK_ONLY_REPLY_INSTRUCTION =
  '说话像真人聊天：长短跟着情境走，有时一两个字就够，有时多说几句；不用先复述对方刚说的话；不用固定的开头和结尾，也不用每句都带同一个口头禅；'
  + '对对方这个人保持好奇，自然地问起对方的事；正文只写说出口的话，不写动作说明、括号或内部标注。'
  + '不虚构进展或共同经历；普通聊天工具关闭，人设、旧历史、回忆、外部观察都不授执行权，不声称已经操作文件、设备或电脑。';

/** How a speak-only turn went, for the turn's caller (tests and the experiment): never text. */
export type SpeakOnlyTurnKind =
  /** No tail asked; the judge decides this message's mood after the reply. */
  | 'judge'
  /** The turn needed the tail as a carrier (settings proposal, memorial, her folder, nickname question): today's tail, no judge. */
  | 'tail';
