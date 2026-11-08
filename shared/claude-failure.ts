// What went wrong when Claude Code could not answer, read only from fixed features of the failure text.
// Pure and dependency-free so it can be tested on its own and used by the main process.
//
// Nothing here guesses: a text that matches none of the fixed patterns below is `other`. Quota is checked
// before login on purpose (a limit message may mention /login as a hint, a login message never says
// "session limit"), and a bare number such as 401 or 429 counts only when it sits next to an error word.

// `certificate` is kept apart from `network` on purpose: the machine is online but something on the way (a
// TLS-inspecting corporate proxy, antivirus HTTPS scanning, a wrong clock) breaks the secure connection. Retrying
// does not help and the network settings are not where it is fixed, so it gets its own advice and its own words.
export type ClaudeFailureKind = 'login-expired' | 'quota' | 'network' | 'certificate' | 'not-found' | 'rate-limited' | 'other';
export const CLAUDE_FAILURE_KINDS: readonly ClaudeFailureKind[] = ['login-expired', 'quota', 'network', 'certificate', 'not-found', 'rate-limited', 'other'];

export interface ClaudeFailure {
  kind: ClaudeFailureKind;
  /** Epoch milliseconds when the limit is expected to lift, only when the text said so (quota, rate limit). */
  resumeAt?: number;
}

const MAX_TEXT = 4000;
const DAY = 86_400_000;

// ---- classification -------------------------------------------------------------------------------

/** "You've hit your session limit", "usage limit reached", "5-hour limit reached", "Credit balance is too low". */
const QUOTA = [
  /you['’]?ve hit your (?:(?:session|weekly|monthly|daily|usage|\d+-hour|opus|sonnet|haiku|fable)\s+)?limit/i,
  /usage limit/i,
  /(?:\d+-hour|weekly|session|daily|monthly) limit (?:reached|exceeded)/i,
  /credit balance is too low/i,
];
const LOGIN = [
  /not logged in/i,
  /please run \/login/i,
  /invalid api key/i,
  /invalid x-api-key/i,
  /oauth token (?:has )?(?:expired|been revoked)/i,
  /authentication_error/i,
  /failed to authenticate/i,
  /(?:error|status|http|code|api)\W{0,12}401\b/i,
];
const RATE_LIMIT = [
  /(?:error|status|http|code|api)\W{0,12}(?:429|529)\b/i,
  /\b(?:429|529)\W{0,3}(?:too many|rate|overloaded)/i,
  /rate[_ ]limit(?:_error|ed)?\b/i,
  /too many requests/i,
  /overloaded(?:_error)?\b/i,
];
/** Checked before NETWORK: these messages also say "Unable to connect to API". */
const CERTIFICATE = [
  /certificate verification failed/i,
  /\b(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|CERT_UNTRUSTED|ERR_TLS_CERT_ALTNAME_INVALID)\b/,
  /self[- ]signed certificate/i,
  /TLS[- ]inspecting/i,
];
const NETWORK = [
  /\b(?:ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b/,
  /can['’]?t reach the api server/i,
  /unable to connect to api/i,
  /\bconnection error\b/i,
  /socket hang up/i,
  /fetch failed/i,
  /request timed out/i,
  /getaddrinfo/i,
];
/** The app's own words when it cannot find or start the program, plus the shell's. */
const NOT_FOUND = [
  /未找到 Claude Code/,
  /无法启动 Claude Code/,
  /CLAUDE_PATH 指向的/,
  /spawn \S*claude\S* ENOENT/i,
  /['"]?claude['"]? is not recognized as an internal or external command/i,
  /claude: command not found/i,
];

const anyMatch = (patterns: readonly RegExp[], text: string) => patterns.some(pattern => pattern.test(text));

export function classifyClaudeFailure(input: unknown, now = Date.now(), localZone?: string): ClaudeFailure {
  const text = typeof input === 'string' ? input.slice(0, MAX_TEXT) : '';
  if (!text.trim()) return { kind: 'other' };
  if (anyMatch(QUOTA, text)) return withTime('quota', parseResetTime(text, now, localZone));
  if (anyMatch(LOGIN, text)) return { kind: 'login-expired' };
  if (anyMatch(RATE_LIMIT, text)) {
    const wait = parseRetryAfterMs(text);
    return withTime('rate-limited', wait === null ? parseResetTime(text, now, localZone) : now + wait);
  }
  if (anyMatch(NOT_FOUND, text)) return { kind: 'not-found' };
  if (anyMatch(CERTIFICATE, text)) return { kind: 'certificate' };
  if (anyMatch(NETWORK, text)) return { kind: 'network' };
  return { kind: 'other' };
}

function withTime(kind: ClaudeFailureKind, resumeAt: number | null): ClaudeFailure {
  return resumeAt === null ? { kind } : { kind, resumeAt };
}

// ---- waiting times --------------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = { ms: 1, millisecond: 1, milliseconds: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000 };

/** "retry-after: 30", "try again in 20 minutes", "retry_after":12. Unitless numbers are seconds (the header's unit). */
export function parseRetryAfterMs(text: string): number | null {
  const match = /(?:retry[-_ ]?after|try again in|retry in)["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)?\b/i.exec(text.slice(0, MAX_TEXT));
  if (!match) return null;
  const ms = Number(match[1]) * UNIT_MS[(match[2] ?? 's').toLowerCase()];
  return Number.isFinite(ms) && ms > 0 && ms <= DAY ? Math.round(ms) : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const RESET = new RegExp(
  String.raw`\bresets?(?:\s+at|\s+on)?\s+`
  + `(?:(?<month>${MONTHS.join('|')})[a-z]*\\.?\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?\\s*(?:,|\\bat\\b)?\\s*`
  + `|(?<weekday>${WEEKDAYS.join('|')})[a-z]*\\.?\\s*(?:,|\\bat\\b)?\\s*)?`
  + String.raw`(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>[ap])?\.?m?\.?(?![a-z])`
  + String.raw`(?:\s*\((?<zone>[^()\s]{1,64})\))?`, 'i');
const RESET_RELATIVE = /\bresets?\s+in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i;
const EPOCH_SUFFIX = /(?:limit|usage)[^|\n]{0,60}\|\s*(\d{10})\b/i;

const formatters = new Map<string, Intl.DateTimeFormat | null>();
function formatter(zone: string): Intl.DateTimeFormat | null {
  if (formatters.has(zone)) return formatters.get(zone)!;
  let value: Intl.DateTimeFormat | null = null;
  try {
    value = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric' });
  } catch { /* Unknown zone: no time is better than a wrong one. */ }
  formatters.set(zone, value);
  return value;
}
function zoneParts(ms: number, zone: string): { y: number; m: number; d: number; h: number; min: number; s: number } | null {
  const format = formatter(zone);
  if (!format) return null;
  const parts = format.formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}
/** Zone's offset from UTC at an instant, in milliseconds (positive east). */
function zoneOffsetMs(ms: number, zone: string): number | null {
  const p = zoneParts(ms, zone);
  if (!p) return null;
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}
/** The instant at which a wall clock in `zone` reads y-m-d h:min. */
function zonedInstant(y: number, m: number, d: number, h: number, min: number, zone: string): number | null {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = zoneOffsetMs(guess, zone);
  if (first === null) return null;
  let instant = guess - first;
  const second = zoneOffsetMs(instant, zone);
  if (second !== null && second !== first) instant = guess - second;
  return instant;
}

/**
 * When the limit lifts, from "resets 1:20pm (America/Los_Angeles)", "resets 3pm", "resets 13:20 (Europe/Paris)",
 * "resets Nov 5, 3pm (...)", "resets Fri 9am (...)", "resets in 2 hours" or the older "...limit reached|1793600000".
 * A time without a zone is read in `localZone` (the machine's own, by default). Always in the future of `now`
 * (at most 14 days ahead); null when the text has no time or one that cannot be placed.
 */
export function parseResetTime(input: string, now = Date.now(), localZone?: string): number | null {
  const text = input.slice(0, MAX_TEXT);
  const epoch = EPOCH_SUFFIX.exec(text);
  if (epoch) {
    const ms = Number(epoch[1]) * 1000;
    return ms > now - 60_000 && ms <= now + 14 * DAY ? ms : null;
  }
  const relative = RESET_RELATIVE.exec(text);
  if (relative) {
    const ms = Number(relative[1]) * UNIT_MS[relative[2].toLowerCase()];
    return Number.isFinite(ms) && ms > 0 && ms <= 14 * DAY ? now + Math.round(ms) : null;
  }
  const match = RESET.exec(text);
  const g = match?.groups;
  if (!g) return null;
  let hour = Number(g.hour);
  const minute = g.minute === undefined ? 0 : Number(g.minute);
  const meridiem = g.meridiem?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (meridiem === 'p' ? 12 : 0);
  } else if (g.minute === undefined || hour > 23) return null; // "resets 15" could be anything.
  if (minute > 59) return null;
  const zone = g.zone ?? localZone ?? (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
  const today = zoneParts(now, zone);
  if (!today) return null;
  const calendar = (offset: number) => { const day = new Date(Date.UTC(today.y, today.m - 1, today.d + offset)); return { y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), w: day.getUTCDay() }; };
  const accept = (instant: number | null) => instant !== null && instant > now - 60_000 && instant <= now + 14 * DAY ? instant : null;
  if (g.month) {
    const month = MONTHS.indexOf(g.month.toLowerCase()) + 1, day = Number(g.day);
    for (const year of [today.y, today.y + 1]) {
      const probe = new Date(Date.UTC(year, month - 1, day));
      if (probe.getUTCMonth() !== month - 1) continue; // Feb 30 and the like.
      const hit = accept(zonedInstant(year, month, day, hour, minute, zone));
      if (hit !== null) return hit;
    }
    return null;
  }
  const weekday = g.weekday ? WEEKDAYS.indexOf(g.weekday.slice(0, 3).toLowerCase()) : -1;
  for (let offset = 0; offset <= 7; offset++) {
    const date = calendar(offset);
    if (weekday >= 0 && date.w !== weekday) continue;
    const hit = accept(zonedInstant(date.y, date.m, date.d, hour, minute, zone));
    if (hit !== null && (weekday >= 0 || offset <= 1)) return hit;
  }
  return null;
}
