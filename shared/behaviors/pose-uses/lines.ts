// I-189: the private lines her next chat turn may carry about what local pose sensing noticed.
// Each line states a fact in closed words and numbers; none suggests a reaction, a wording or an offer.
//  - two people (#7): one fixed sentence. It takes NO input but the card language: no count, no position, no picture, no description.
//  - sitting (#6) background: only when the user's own message asks about sitting (never a report otherwise).
//  - a nod / shake sent as the user's answer (#3): says the turn was a gesture, not typed words.
import type { HeadGesture } from './nod';
import type { SittingFacts } from './body-time';

type Language = 'zh-CN' | 'en';

/** #7: the one note (fixed words; nothing from the frame goes in). */
export function twoPeopleNote(language: Language = 'zh-CN'): string {
  return language === 'en'
    ? '(App note: the camera, on this computer only, sees what looks like one more person in the frame. Just information.)'
    : '（应用提示：摄像头本机看到，画面里好像还有一个人。只是资料。）';
}

const SITTING_ASK_ZH = /(坐了多久|坐多久|坐了多长|坐了一天|坐了好久|坐了很久|久坐|坐太久|坐了几个小时|起来过|站起来过|起身|动一动|活动一下)/u;
const SITTING_ASK_EN = /\b(how long (have|did) i (been )?sit|sitting (too )?long|sat (too )?long|been sitting|stood up|stand up|get up)\b/iu;

/** The user's message asks about sitting ("我今天坐了多久？", "have I been sitting too long?"). */
export function asksAboutSitting(text: unknown): boolean {
  const t = String(text ?? '').slice(0, 400);
  return SITTING_ASK_ZH.test(t) || SITTING_ASK_EN.test(t);
}

/** #6 background: today's seated minutes, stand-ups and this stretch; '' with nothing measured. */
export function sittingNote(facts: SittingFacts | null, language: Language = 'zh-CN'): string {
  if (!facts || !(facts.todayMinutes > 0 || facts.minutes > 0)) return '';
  const today = Math.max(0, Math.round(facts.todayMinutes)), ups = Math.max(0, Math.round(facts.standUps)), now = Math.max(0, Math.round(facts.minutes));
  return language === 'en'
    ? `(App note, estimated by the camera on this computer only: today the user has sat about ${today} minutes and stood up ${ups} times; ${now > 0 ? `this time they have been sitting about ${now} minutes without getting up` : 'they are not sitting right now'}. Just information.)`
    : `（应用提示，摄像头本机估计：用户今天一共坐了约 ${today} 分钟，起身过 ${ups} 次；${now > 0 ? `这次已经连续坐了约 ${now} 分钟没起身` : '这会儿没在坐着'}。只是资料。）`;
}

/** #1: her last reading ended unheard because the user turned away or left and stayed away (the rest is only in her bubble). */
export function unheardRestNote(language: Language = 'zh-CN'): string {
  return language === 'en'
    ? '(App note: while your last reply was being read aloud, the camera, on this computer only, saw the user turn away or leave and not come back; the rest of it only stayed in your bubble, unread.)'
    : '（应用提示：你上一条回复念到一半时，摄像头本机看到用户转开或离开了，一直没回来；后面的话只留在气泡里，没有念出来。）';
}

/** #3: what the user's turn says (shown in the chat as a small line). */
export function gestureTurnText(gesture: HeadGesture, language: Language = 'zh-CN'): string {
  if (language === 'en') return gesture === 'nod' ? '(nods)' : '(shakes head)';
  return gesture === 'nod' ? '（点头）' : '（摇头）';
}

/** #3: the private line that comes with that turn. */
export function gestureTurnNote(gesture: HeadGesture, language: Language = 'zh-CN'): string {
  if (language === 'en') return `(App note: this turn was not typed. The camera, on this computer only, saw the user ${gesture === 'nod' ? 'nod' : 'shake their head'} right after your question, and the app sent that as the user's answer.)`;
  return `（应用提示：这一条不是用户打的字。摄像头本机看到用户在你问完之后${gesture === 'nod' ? '点了点头' : '摇了摇头'}，应用把它当作用户的回答发了过来。）`;
}
