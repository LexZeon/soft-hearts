// I-195: one marker body, read. `alarm|in=20m|note=…` / `alarm|at=21:30|note=…` / `alarm|day=next-mon|at=09:00|note=…` / `alarm|on=back|note=…` /
// `alarm|talk=考试|note=…` / `alarm|at=21:00|on=back|note=…` (the time opens the window the event may count in), and `alarm|done=2` / `alarm|done=all`
// (take one of the listed ones away). Everything is local and closed: keys, values and the event words are fixed; anything else (an unknown key, a
// repeated key, a time out of range, an empty note, two triggers of the wrong kinds) makes the marker malformed and it is dropped silently.
// Pure: `now` is passed in; times are the local clock. The note is her own words, cleaned and cut here.
import { isAlarmEvent, ALARM_MARK_WORD, type AlarmEvent, type AlarmMarker } from './interface';
import { ALARM_KNOBS, type AlarmKnobs } from './knobs';

const MINUTE = 60_000, DAY = 86_400_000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const KEYS = ['in', 'at', 'day', 'on', 'talk', 'note', 'done'] as const;

/** One of her words, cleaned: one line, no control characters, no brackets of any marker or tag, cut to `max` characters. */
export function cleanAlarmWords(text: unknown, max: number): string {
  return Array.from(String(text ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/[<>⟦⟧⟪⟫【】〖〗|]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, max).join('').trim();
}

const midnight = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const addDays = (dayStart: number, days: number) => { const d = new Date(dayStart); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime(); };
const at = (dayStart: number, hour: number, minute: number) => { const d = new Date(dayStart); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime(); };

/** A day word → that day's start (local midnight), or null. */
function resolveDay(word: string, now: number): number | null {
  const today = midnight(now);
  if (word === 'today') return today;
  if (word === 'tomorrow') return addDays(today, 1);
  const weekday = /^(next-)?(sun|mon|tue|wed|thu|fri|sat)$/u.exec(word);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[2] as (typeof WEEKDAYS)[number]), here = new Date(today).getDay();
    if (!weekday[1]) return addDays(today, ((target - here + 7) % 7) || 7); // the next one after today
    const sinceMonday = (here + 6) % 7; // the Monday of this week, then next week's day (Monday-first weeks)
    return addDays(addDays(today, -sinceMonday), 7 + ((target + 6) % 7));
  }
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(word), short = /^(\d{1,2})-(\d{1,2})$/u.exec(word);
  if (!full && !short) return null;
  const year = full ? Number(full[1]) : new Date(now).getFullYear(), month = Number(full ? full[2] : short![1]), date = Number(full ? full[3] : short![2]);
  const build = (y: number) => { const d = new Date(y, month - 1, date); return d.getFullYear() === y && d.getMonth() === month - 1 && d.getDate() === date ? d.getTime() : null; };
  const first = build(year);
  if (first === null) return null;
  return !full && first < today ? build(year + 1) : first; // "12-01" in December already gone means next year
}

/** The marker body between the brackets → a marker, or null when it is not one or is malformed. */
export function parseAlarmMarker(body: unknown, now: number, knobs: AlarmKnobs = ALARM_KNOBS): AlarmMarker | null {
  if (typeof body !== 'string' || !Number.isFinite(now)) return null;
  const parts = body.split('|').map(part => part.trim());
  if (parts.shift()?.toLowerCase() !== ALARM_MARK_WORD) return null;
  const fields = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim().toLowerCase(), value = part.slice(eq + 1).trim();
    if (!(KEYS as readonly string[]).includes(key) || fields.has(key) || !value) return null;
    fields.set(key, value);
  }
  const done = fields.get('done');
  if (done !== undefined) {
    if (fields.size !== 1) return null;
    if (done.toLowerCase() === 'all') return { kind: 'drop', which: 'all' };
    return /^\d{1,2}$/u.test(done) && Number(done) >= 1 ? { kind: 'drop', which: Number(done) } : null;
  }
  const note = cleanAlarmWords(fields.get('note'), knobs.noteChars);
  if (!note) return null;
  const on = fields.get('on')?.toLowerCase() ?? null;
  if (on !== null && !isAlarmEvent(on)) return null;
  const talkRaw = fields.get('talk');
  const talk = talkRaw === undefined ? null : cleanAlarmWords(talkRaw, knobs.talkChars);
  if (talkRaw !== undefined && !talk) return null;
  if (on !== null && talk !== null) return null; // one thing to wait for
  const waits = on !== null || talk !== null;
  const timed = fields.has('in') || fields.has('at') || fields.has('day');
  if (!waits && !timed) return null;
  let when: number | null = null;
  if (timed) {
    if (fields.has('in')) {
      if (fields.has('at') || fields.has('day')) return null;
      const span = /^(\d{1,4})([mhd])$/u.exec(fields.get('in')!.toLowerCase());
      if (!span) return null;
      when = now + Number(span[1]) * (span[2] === 'm' ? MINUTE : span[2] === 'h' ? 60 * MINUTE : DAY);
    } else {
      const clock = fields.has('at') ? /^([01]?\d|2[0-3]):([0-5]\d)$/u.exec(fields.get('at')!) : null;
      if (fields.has('at') && !clock) return null;
      const hour = clock ? Number(clock[1]) : null, minute = clock ? Number(clock[2]) : 0;
      if (fields.has('day')) {
        const day = resolveDay(fields.get('day')!.toLowerCase(), now);
        if (day === null) return null;
        when = at(day, hour ?? (waits ? 0 : knobs.defaultHour), minute); // a day for an event: from the start of that day
      } else {
        const today = at(midnight(now), hour!, minute);
        when = !waits && today - now < knobs.minMinutes * MINUTE ? at(addDays(midnight(now), 1), hour!, minute) : today; // a time alone rolls to tomorrow
      }
    }
    if (when - now > knobs.maxDays * DAY) return null;
    if (!waits && when - now < knobs.minMinutes * MINUTE) return null;
  }
  return { kind: 'set', spec: { at: when, on: on as AlarmEvent | null, talk, note } };
}
