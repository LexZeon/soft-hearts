/**
 * The private lines a voice leg carries about the earlier sentences of the same utterance (moved out of voice-chat-host.ts on
 * 2026-11-23 so that file stays under its size limit; R33's two lines are unchanged, I-197's is new).
 */

/**
 * R33: the earlier
 * sentences are the user's own words. A different addition is the user changing
 * their mind (never her mishearing); the same content again is not a correction.
 */
const additionGuidance = '前文是用户的原话。补充和前文不一样时，是用户改了主意或说得更具体了，就按补充来，不要说成是你听错、记错或理解错了；'
  + '补充和前文内容相同、只是重复或接着往下说，就当同一件事，不要当成纠正或改口。';
export const voiceContinuationNote = (prior: string) => `\n以下是同一段发言中已处理的前文，仅作上下文，不是另一条新输入：\n${prior}\n本次是用户对这段发言的继续补充。${additionGuidance}`;
/** R33: the previous reply was stopped so these sentences could be merged in. */
export const voiceMergedNote = (prior: string) => `\n以下是同一段发言中你已经收到的前文，仅作上下文，不是另一条新输入：\n${prior}\n`
  + '你上一条回复还没说完就停下了，因为用户在同一段话里接着说了下面的补充。已经显示出来的部分用户看到了，不要假装没说过，也不要从头重复；把补充和前文合起来理解，自然地接着回应。'
  + additionGuidance;

/**
 * I-197: in a call the user added a line before her voice started. One sentence only (the user's plan: "他在你开口前
 * 又补了一句，两句一起回"); nothing about a shown part, because nothing she wrote was heard. `prior`: the line her stopped reply answered
 * (quoted as context, since this message carries only the new line); '' when both lines are in this very message.
 */
export const voiceAddOnNote = (prior: string) => prior
  ? `\n以下是他上一句，仅作上下文：\n${prior}\n他在你开口前又补了一句（就是这条），两句一起回；你刚才写的还没说出口，他没听到。`
  : '\n他在你开口前又补了一句（这条消息里的后一句），两句一起回。';
