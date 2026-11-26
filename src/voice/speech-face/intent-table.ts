/**
 * I-073 part 3, layer 1 data: what a clause of her reply means, from local rules only (no model call; the user chose
 * option A). One row = one cue: where it looks (the clause's end, its start, or anywhere), what it matches, which intent it
 * suggests and how strongly (0..1). A clause's intent is the one with the highest summed weight (each row counts once,
 * however often it matches, so "？？？" is no stronger than "？": punctuation never chains).
 *
 * Adding a cue = adding a row here; adding a language = adding a table (I-071 will add the English side's wiring; the
 * table is already used for any clause written mostly in Latin letters). Our own rows, written for this project.
 */
export const SPEECH_INTENTS = Object.freeze(['calm', 'happy', 'emphasis', 'question', 'thinking', 'shy', 'affirm'] as const);
export type SpeechIntent = typeof SPEECH_INTENTS[number];

export interface IntentRow {
  /** 'end': the clause's last characters (after trailing quotes/spaces); 'start': its first; 'any': anywhere. */
  readonly at: 'end' | 'start' | 'any';
  readonly match: RegExp;
  readonly intent: Exclude<SpeechIntent, 'calm'>;
  readonly weight: number;
}
const row = (at: IntentRow['at'], match: RegExp, intent: IntentRow['intent'], weight: number): IntentRow => Object.freeze({ at, match, intent, weight });

export const INTENT_TABLE_ZH: readonly IntentRow[] = Object.freeze([
  // 提问：问号本身只是"可能"，配上疑问词、语气词才明确
  row('end', /[？?]+$/, 'question', 0.35),
  row('end', /[吗嘛呢吧][？?]*$/, 'question', 0.25),
  row('any', /为什么|为啥|怎么|是不是|要不要|好不好|对不对|行不行|可不可以|有没有|几点|多少|哪[里儿个]|什么/, 'question', 0.3),
  // 强调：感叹号只是"可能"，配上强调词才明确；反问（难道、怎么可能）算强调
  row('end', /[！!]+$/, 'emphasis', 0.3),
  row('any', /真的|超级|特别|一定|绝对|非常|简直|居然|竟然|根本|千万|最[好喜爱棒]/, 'emphasis', 0.3),
  row('any', /难道|怎么可能|才不会|哪有/, 'emphasis', 0.45),
  row('any', /太.{1,4}了/, 'emphasis', 0.25),
  // 开心
  row('any', /哈哈|嘻嘻|嘿嘿|好耶|太好了|好开心|开心|高兴|喜欢|好棒|真棒|好可爱|好看|好玩|幸福/, 'happy', 0.5),
  row('end', /[～~♪]+[！!。]?$/, 'happy', 0.3),
  // 思考。连着的句号"。。。"也是省略号（2026-11-18：Mumi 写"嗯。。。"，原来只认"…"和"..."，她的犹豫一次也没动过眉眼）
  row('start', /^(嗯+[…\.]{1,}|[嗯啊]+(…+|\.{2,}|。{2,})|唔|呃|让我想想|我想想|这个嘛)/, 'thinking', 0.55),
  row('any', /可能|也许|大概|好像|说不定|不太确定|我猜|或许/, 'thinking', 0.35),
  row('end', /(…+|\.{3,}|。{2,})$/, 'thinking', 0.25),
  // 害羞
  row('any', /害羞|不好意思|才不是|讨厌啦|人家|脸红|笨蛋|羞|别这样看/, 'shy', 0.55),
  // 结巴（"我、我""给、给、给我的"）：紧张，或一下子太开心。一个字、顿号、同一个字；"苹果、香蕉"这样的列举不算
  row('any', /([一-鿿])、\1/, 'shy', 0.55),
  // 肯定、收束
  row('start', /^(嗯[，,。！!]?$|嗯[，,]|好的|好呀|好啊|对呀|对啊|对的|是的|没错|当然|知道了|放心|好嘞|行)/, 'affirm', 0.55),
  row('any', /我在呢|我会的|一定会|交给我/, 'affirm', 0.3),
]);

export const INTENT_TABLE_EN: readonly IntentRow[] = Object.freeze([
  row('end', /\?+$/, 'question', 0.35),
  row('start', /^(why|how|what|where|when|who|which|do you|did you|are you|can you|could you|would you|is it|isn't it)\b/i, 'question', 0.3),
  row('end', /!+$/, 'emphasis', 0.3),
  row('any', /\b(really|so much|totally|definitely|absolutely|never|always|seriously|the best)\b/i, 'emphasis', 0.3),
  row('any', /\b(haha|hehe|yay|love it|so happy|glad|awesome|cute|wonderful|fun)\b/i, 'happy', 0.5),
  row('end', /[~♪]+[!.]?$/, 'happy', 0.3),
  // "Mm..." and "Ah..." open a hesitation too, like 嗯。。。 and 啊。。。 in the Chinese table (English Mumi, 2026-11-18)
  row('start', /^(hmm+|um+|uh+|let me think|well,|(mm+|ah+)(…|\.{2,}))/i, 'thinking', 0.55),
  row('any', /\b(maybe|perhaps|probably|i guess|i think|not sure|might)\b/i, 'thinking', 0.35),
  row('end', /(…|\.{3,})$/, 'thinking', 0.25),
  row('any', /\b(embarrass\w*|blush\w*|don't look|stop it|silly)\b/i, 'shy', 0.55),
  // A stutter ("I-I", "w-what"): nervous, or suddenly too happy (the Chinese table's 结巴 row)
  row('any', /\b([a-z])-\1/i, 'shy', 0.55),
  row('start', /^(yes|yeah|yep|sure|of course|okay|ok|right|got it|alright|i will)\b/i, 'affirm', 0.55),
  row('any', /\b(i'm here|i promise|leave it to me)\b/i, 'affirm', 0.3),
]);
