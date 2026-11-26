// I-195: what her alarms add to her prompts. Only while the switch is on: one sentence (how to write a marker; every chat turn) and, when she has
// any waiting, one short list (so she notices a "when he talks about X" herself and does not set the same twice). When one wakes, the moments host
// tells her as information (the I-188 rule: the app only says what happened; what she does is hers). Her notes are her own words, cut and cleaned.
// Pure.
import { ALARM_EVENTS, type AlarmView, type AlarmWhy } from './interface';
import { cleanAlarmWords } from './parse';
import { ALARM_KNOBS } from './knobs';

/** The one sentence in her chat prompt (switch on): the marker, its trigger words, the event words. Kept short: it is paid for on every turn. */
export function alarmSentence(): string {
  return '你可以给自己留个心（可选，很少用）：回复里写看不见的记号⟪alarm|in=20m|note=给自己的话⟫，到点或事发生时应用会告诉你。'
    + '时间写 in=20m|2h|3d、at=21:30、day=tomorrow|2026-12-01|mon|next-mon（可再加 at）；等事写 on=' + ALARM_EVENTS.join('|') + '；等他说到某词写 talk=词；时间和 on 可一起写。'
    + '⟪alarm|done=编号⟫取消下面列的一条。记号不会显示。';
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const EVENT_WORDS: Readonly<Record<string, string>> = {
  back: '他回到座位时', 'first-today': '今天第一次见时', 'fullscreen-back': '他从全屏程序出来时', 'user-sleep': '他说要睡了时', 'video-end': '视频放完时', sitting: '他坐很久时',
  'screen-error': '屏幕上报错时', 'game-over': '游戏输了时', win: '游戏赢了时', 'download-done': '下载完成时', kiss: '亲亲时', hug: '抱抱时', 'late-night': '深夜他还在用电脑时',
};
const clock = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1}月${d.getDate()}日周${WEEK[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** One alarm in words, for her list and the profile page: when / what it waits for. */
export function describeTrigger(alarm: Pick<AlarmView, 'at' | 'on' | 'talk'>, now?: number): string {
  const time = alarm.at === null ? '' : (now !== undefined && new Date(alarm.at).toDateString() === new Date(now).toDateString() ? '今天' + clock(alarm.at).split(' ')[1] : clock(alarm.at));
  if (alarm.on) return (time ? `${time} 以后，` : '') + (EVENT_WORDS[alarm.on] ?? '那件事发生时');
  if (alarm.talk) return (time ? `${time} 以后，` : '') + `他说到「${cleanAlarmWords(alarm.talk, ALARM_KNOBS.talkChars)}」时`;
  return time;
}

/** Her waiting alarms as one list line block (numbered as she cancels them); '' when none. */
export function alarmListLine(alarms: readonly AlarmView[], now: number): string {
  if (!alarms.length) return '';
  return '你给自己留着的心（还没到，备注是你自己写的）：' + alarms.map((a, i) => `${i + 1}）${describeTrigger(a, now)}「${cleanAlarmWords(a.note, ALARM_KNOBS.noteChars)}」`).join('；');
}

/** When one wakes: the information handed to her (never a reaction; I-188). `late`: minutes past a time alarm's time. */
export function alarmWokeLine(note: string, why: AlarmWhy, late = 0): string {
  const words = cleanAlarmWords(note, ALARM_KNOBS.noteChars);
  const cause = why === 'time' ? `到点了${late >= 10 ? `（已经过了约 ${Math.round(late)} 分钟，用户刚才不在）` : ''}` : why === 'talk' ? '用户说到了你等的那个词' : `${EVENT_WORDS[why] ?? '那件事发生了'}已经到了`;
  return `你之前给自己留了个心（你自己写的备注：「${words}」），现在${cause}。`;
}

// ---------------------------------------------------------------- the user's words

const CANCEL = /(取消|撤销|撤掉|删掉|删除|去掉|清掉|清空|别留|不要|不用|算了)/u;
const THING = /(闹钟|留心|留的心|留了个心|[她你]自己(?:定|留|记)的|[她你]给自己(?:定|留|记)的?(?:提醒|事|心)?|她的提醒|她定的提醒)/u;
const ALL = /(全部|所有|都|一起)/u;
const NUMBERS: Readonly<Record<string, number>> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** "取消她的闹钟" / "她给自己留的心不要了" / "把她的闹钟都取消": null when the message is not about taking her alarms away. */
export function parseAlarmCancel(text: unknown): { which: number | 'all' | 'any' } | null {
  const message = typeof text === 'string' ? text.slice(0, 400) : '';
  if (!CANCEL.test(message) || !THING.test(message)) return null;
  if (ALL.test(message)) return { which: 'all' };
  const nth = /第\s*([一二两三四五六七八九十]|\d{1,2})\s*(?:个|条|项)/u.exec(message);
  if (nth) { const n = NUMBERS[nth[1]] ?? Number(nth[1]); if (n >= 1) return { which: n }; }
  return { which: 'any' };
}

/** The user says they are going to sleep (the event 'user-sleep'; read from their own message only). */
export const USER_SLEEP = /(晚安|我(?:先|要|去)?睡(?:了|觉了)|去睡(?:觉|了)|要睡了|睡觉了|good ?night|going to (?:bed|sleep)|heading to bed)/iu;
