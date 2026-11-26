// I-188 #13: "明天提醒我…" / "等下叫我" / "八点叫我" / "remind me in 20 minutes to …" read locally (no model): a reminder with a time,
// one she should ask about (no time said), or "不用提醒了" (cancel). Common Chinese and English forms only; a time that had to be guessed
// (no am/pm, "等下", a day without a clock) is marked `guessed` so she confirms it in her reply. Pure: the caller gives the wall time; the
// local clock is the system's (Date).

export type ReminderRequest =
  | { readonly kind: 'set'; readonly dueAt: number; readonly what: string; readonly guessed: boolean }
  | { readonly kind: 'unclear'; readonly what: string }
  | { readonly kind: 'cancel' };

const MINUTE = 60_000;
const MAX_AHEAD_MS = 7 * 24 * 60 * MINUTE;
const ZH_DIGITS: Readonly<Record<string, number>> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** "8", "十", "十二", "二十五", "两" → number; NaN otherwise. */
export function zhNumber(raw: string): number {
  const text = raw.trim();
  if (/^\d{1,3}$/u.test(text)) return Number(text);
  if (!text || !/^[零〇一二两三四五六七八九十]+$/u.test(text)) return NaN;
  const ten = text.indexOf('十');
  if (ten < 0) return text.length === 1 ? ZH_DIGITS[text] : NaN;
  const before = text.slice(0, ten), after = text.slice(ten + 1);
  const tens = before ? ZH_DIGITS[before] : 1, ones = after ? ZH_DIGITS[after] : 0;
  return before.length > 1 || after.length > 1 || tens === undefined || ones === undefined ? NaN : tens * 10 + ones;
}

const NUM = '(\\d{1,3}|[零〇一二两三四五六七八九十]{1,3})';
const ZH_TRIGGER = /(提醒一下我|提醒我|记得叫我|到时候?叫我|到点叫我|叫醒我|叫我|喊我)/u;
const ZH_CANCEL = /(不用|别|不要|甭|无需)再?(提醒|叫|喊)(我)?了|取消(这个|那个|刚才的|一下)?提醒|提醒(就)?(取消|算了|不用了)/u;
const EN_TRIGGER = /\b(remind me|wake me(?: up)?|ping me)\b/iu;
const EN_CANCEL = /\b(?:don'?t|do not|no need to|never mind|stop)\b[^.!?]*\b(?:remind|wak(?:e|ing) me|ping)|\bcancel (?:the|that|my) reminder\b|\bforget the reminder\b/iu;
const FILLER = /^[，,。.！!？?、\s~～]+|[，,。.！!？?、\s~～]+$/gu;
const ZH_TAIL = /(吧|哦|喔|啊|呀|哈|呗|好吗|好不好|可以吗|行吗|一下)+$/u;

/** Read one user message. Null: not about a reminder. `now` is the wall time the message was written. */
export function parseReminderRequest(text: unknown, now: number, whatChars = 40): ReminderRequest | null {
  if (typeof text !== 'string' || !text.trim() || text.length > 500 || !Number.isFinite(now)) return null;
  const message = text.replace(/\s+/gu, ' ').trim();
  if (ZH_CANCEL.test(message) || EN_CANCEL.test(message)) return { kind: 'cancel' };
  const zh = ZH_TRIGGER.exec(message);
  if (zh) return finish(zhTime(message, now), zhWhat(message, zh), now, whatChars);
  const en = EN_TRIGGER.exec(message);
  if (en) return finish(enTime(message, now), enWhat(message, en), now, whatChars);
  return null;
}

function finish(time: { at: number; guessed: boolean } | null, what: string, now: number, whatChars: number): ReminderRequest {
  const clean = Array.from(what.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, Math.max(4, whatChars)).join('');
  if (!time || !Number.isFinite(time.at) || time.at <= now || time.at - now > MAX_AHEAD_MS) return { kind: 'unclear', what: clean };
  return { kind: 'set', dueAt: Math.floor(time.at / MINUTE) * MINUTE, what: clean, guessed: time.guessed };
}

// ---------------------------------------------------------------- Chinese

const ZH_RELATIVE = new RegExp(`(?:过)?${NUM}\\s*(?:个)?\\s*(半)?\\s*(分钟|分|小时|钟头)\\s*(?:后|之后|以后)?`, 'u');
const ZH_HALF_HOUR = /半\s*(?:个)?\s*(?:小时|钟头)\s*(?:后|之后|以后)?/u;
const ZH_SOON = /(等一?下|等会儿?|一会儿?|待会儿?|过会儿?|晚点儿?)/u;
const ZH_CLOCK = new RegExp(`${NUM}\\s*(?:点|[:：])\\s*(半|一刻|三刻|${NUM}\\s*分?)?`, 'u');
const ZH_DAY = /(今天|今晚|今早|明天|明早|明晚|后天)/u;
const ZH_PERIOD = /(凌晨|早上|早晨|清早|上午|中午|下午|傍晚|晚上|夜里|半夜)/u;

function zhTime(text: string, now: number): { at: number; guessed: boolean } | null {
  if (ZH_HALF_HOUR.test(text) && !/[0-9零〇一二两三四五六七八九十]\s*(?:个)?\s*半\s*(?:个)?\s*(?:小时|钟头)/u.test(text)) return { at: now + 30 * MINUTE, guessed: false };
  const relative = ZH_RELATIVE.exec(text);
  if (relative && /(后|之后|以后)|^过|过\d|过[零〇一二两三四五六七八九十]/u.test(relative[0])) {
    const n = zhNumber(relative[1]);
    if (Number.isFinite(n) && n > 0) {
      const hours = relative[3] === '小时' || relative[3] === '钟头';
      return { at: now + (hours ? (n + (relative[2] ? 0.5 : 0)) * 60 : n) * MINUTE, guessed: false };
    }
  }
  const dayWord = ZH_DAY.exec(text)?.[1] ?? '';
  const period = ZH_PERIOD.exec(text)?.[1] ?? (dayWord === '今晚' || dayWord === '明晚' ? '晚上' : dayWord === '今早' || dayWord === '明早' ? '早上' : '');
  const dayOffset = dayWord.startsWith('明') ? 1 : dayWord === '后天' ? 2 : 0;
  const clock = ZH_CLOCK.exec(text);
  if (clock) {
    let hour = zhNumber(clock[1]);
    const tail = clock[2] ?? '';
    const minute = tail === '半' ? 30 : tail === '一刻' ? 15 : tail === '三刻' ? 45 : clock[3] ? zhNumber(clock[3]) : 0;
    if (!Number.isFinite(hour) || hour > 24 || !Number.isFinite(minute) || minute > 59) return null;
    if (/[:：]/u.test(clock[0]) && !clock[3]) return null;
    if (period && hour < 12 && ['下午', '傍晚', '晚上', '夜里'].includes(period)) hour += 12;
    else if (period === '中午' && hour <= 3) hour += 12;
    if (hour === 24) hour = 0;
    return atClock(now, hour, minute, dayOffset, !period && !dayWord && hour >= 1 && hour <= 11 ? 'either' : dayWord ? 'fixed' : 'next');
  }
  if (dayWord || period) {
    const guess: Readonly<Record<string, number>> = { 凌晨: 6, 早上: 8, 早晨: 8, 清早: 7, 上午: 10, 中午: 12, 下午: 15, 傍晚: 18, 晚上: 21, 夜里: 22, 半夜: 0 };
    const at = atClock(now, guess[period] ?? 9, 0, dayOffset, dayWord ? 'fixed' : 'next');
    return at ? { at: at.at, guessed: true } : null;
  }
  if (ZH_SOON.test(text)) return { at: now + 20 * MINUTE, guessed: true };
  return null;
}

/** 'fixed': that day; 'next': today, or tomorrow if past; 'either': the next of h:mm and (h+12):mm (am/pm unknown → guessed). */
function atClock(now: number, hour: number, minute: number, dayOffset: number, mode: 'fixed' | 'next' | 'either'): { at: number; guessed: boolean } | null {
  const make = (h: number, plusDays: number) => { const d = new Date(now); d.setDate(d.getDate() + plusDays); d.setHours(h, minute, 0, 0); return d.getTime(); };
  if (mode === 'fixed') return { at: make(hour, dayOffset), guessed: false };
  const candidates = mode === 'either' ? [make(hour, 0), make(hour + 12, 0), make(hour, 1)] : [make(hour, 0), make(hour, 1)];
  const next = candidates.filter(at => at > now).sort((a, b) => a - b)[0];
  return next === undefined ? null : { at: next, guessed: mode === 'either' };
}

/** What to remind: the words after the trigger (else before it), without the time words, fillers and polite tails. */
function zhWhat(text: string, trigger: RegExpExecArray): string {
  const strip = (part: string) => part.replace(new RegExp(ZH_RELATIVE.source, 'gu'), '').replace(new RegExp(ZH_HALF_HOUR.source, 'gu'), '')
    .replace(new RegExp(ZH_CLOCK.source, 'gu'), '').replace(new RegExp(ZH_DAY.source, 'gu'), '').replace(new RegExp(ZH_PERIOD.source, 'gu'), '')
    .replace(new RegExp(ZH_SOON.source, 'gu'), '').replace(/^(?:一下|下|去|要|该|得|记得|在|的时候|到时候?)+/u, '').replace(FILLER, '').replace(ZH_TAIL, '').replace(FILLER, '').trim();
  const after = strip(text.slice(trigger.index + trigger[0].length));
  if (after) return after;
  return strip(text.slice(0, trigger.index).replace(/(你|麻烦你?|请|帮我|能不能|可以|记得)+$/u, '').replace(/^(你|麻烦你?|请|帮我|能不能)+/u, ''));
}

// ---------------------------------------------------------------- English

function enTime(text: string, now: number): { at: number; guessed: boolean } | null {
  const lower = text.toLowerCase();
  if (/\bin (?:half an hour|30 min)/u.test(lower)) return { at: now + 30 * MINUTE, guessed: false };
  const relative = /\bin (an?|\d{1,3}) (minutes?|mins?|hours?|hrs?)\b/u.exec(lower);
  if (relative) {
    const n = relative[1].startsWith('a') ? 1 : Number(relative[1]);
    return { at: now + n * (relative[2].startsWith('h') ? 60 : 1) * MINUTE, guessed: false };
  }
  const tomorrow = /\btomorrow\b/u.test(lower), tonight = /\btonight\b/u.test(lower);
  const at = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/u.exec(lower);
  if (at) {
    let hour = Number(at[1]);
    const minute = at[2] ? Number(at[2]) : 0, half = at[3]?.[0];
    if (hour > 23 || minute > 59) return null;
    if (half === 'p' && hour < 12) hour += 12;
    if (half === 'a' && hour === 12) hour = 0;
    if (!half && tonight && hour < 12) hour += 12;
    return atClock(now, hour, minute, tomorrow ? 1 : 0, tomorrow ? 'fixed' : half || tonight || hour >= 12 || hour === 0 ? 'next' : 'either');
  }
  if (tomorrow || tonight) { const fixed = atClock(now, tonight ? 21 : 9, 0, tomorrow ? 1 : 0, 'fixed'); return fixed ? { at: fixed.at, guessed: true } : null; }
  if (/\b(later|in a bit|in a while|soon)\b/u.test(lower)) return { at: now + 20 * MINUTE, guessed: true };
  return null;
}

function enWhat(text: string, trigger: RegExpExecArray): string {
  const after = text.slice(trigger.index + trigger[0].length);
  const to = /\b(?:to|about|that)\s+(.+)$/iu.exec(after)?.[1] ?? after;
  return to.replace(/\b(?:in (?:half an hour|an?|\d{1,3}) (?:minutes?|mins?|hours?|hrs?)|at \d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?|tomorrow|tonight|later|in a bit|in a while|soon|please)\b/giu, '')
    .replace(/\s+/gu, ' ').replace(FILLER, '').trim();
}
