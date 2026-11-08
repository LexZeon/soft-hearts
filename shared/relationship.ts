// 熟悉度 (docs/claude/2026-11-02-familiarity-plan.md): how long she has known the user, which
// days really counted, the optional "slowly warming up" stages, milestone days, the nickname
// consent words and the wording of the opening lines. Pure functions only; the files and the
// policy live in electron/relationship/. Nothing here mentions the user as "他/她".

export const RELATIONSHIP_STAGES = ['new', 'warming', 'familiar', 'close', 'old'] as const;
export type RelationshipStage = (typeof RELATIONSHIP_STAGES)[number];
export const STAGE_LABELS: Readonly<Record<RelationshipStage, string>> = {
  new: '初识', warming: '熟起来', familiar: '熟悉', close: '亲近', old: '老朋友',
};
/** Together-days needed to reach warming / familiar / close / old (before the card's tendencies scale them). */
export const STAGE_BASE_THRESHOLDS = [3, 10, 30, 90] as const;

export interface Tendencies { playful: number; close: number; comfortable: number; cautious: number }
export const NEUTRAL_TENDENCIES: Readonly<Tendencies> = { playful: 1, close: 1, comfortable: 1, cautious: 1 };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * How fast this card warms up: above 1 slower, below 1 faster. A cautious card is slow; a close,
 * playful or comfortable one is quick. The default card (all 1) is exactly 1.
 */
export function warmUpPace(tendencies: Tendencies): number {
  const open = 0.6 * tendencies.close + 0.2 * tendencies.playful + 0.2 * tendencies.comfortable;
  if (!(open > 0.05)) return 2;
  return clamp(tendencies.cautious / open, 0.5, 2);
}

/** The four thresholds for this card; strictly increasing, whole days. */
export function stageThresholds(tendencies: Tendencies = NEUTRAL_TENDENCIES): number[] {
  const pace = warmUpPace(tendencies);
  const result: number[] = [];
  for (const base of STAGE_BASE_THRESHOLDS) {
    const scaled = Math.max(1, Math.ceil(base * pace - 1e-9));
    result.push(result.length && scaled <= result[result.length - 1] ? result[result.length - 1] + 1 : scaled);
  }
  return result;
}

export function stageFor(effectiveDays: number, thresholds: readonly number[]): RelationshipStage {
  let index = 0;
  for (const threshold of thresholds) if (effectiveDays >= threshold) index++;
  return RELATIONSHIP_STAGES[Math.min(index, RELATIONSHIP_STAGES.length - 1)];
}

export interface StageProgress { stage: RelationshipStage; next: RelationshipStage | null; daysToNext: number | null }
export function stageProgress(effectiveDays: number, thresholds: readonly number[]): StageProgress {
  const stage = stageFor(effectiveDays, thresholds);
  const index = RELATIONSHIP_STAGES.indexOf(stage);
  if (index >= thresholds.length) return { stage, next: null, daysToNext: null };
  return { stage, next: RELATIONSHIP_STAGES[index + 1], daysToNext: Math.max(1, Math.ceil(thresholds[index] - effectiveDays - 1e-9)) };
}
export const stageAtLeast = (stage: RelationshipStage, minimum: RelationshipStage) =>
  RELATIONSHIP_STAGES.indexOf(stage) >= RELATIONSHIP_STAGES.indexOf(minimum);

// ---- the stored numbers (pure transitions) ----

export const RELATIONSHIP_LIMITS = Object.freeze({
  /** About eleven years of days; past this nothing more is recorded rather than anything being dropped. */
  days: 4000,
  milestones: 24,
  backfilledScopes: 16,
  /** A real day: this many back-and-forth rounds in one local day, or one round plus a touch / a feeding. */
  roundsForDay: 3,
  /** Each quality day adds this much to the effective days ... */
  qualityWeight: 0.5,
  /** ... up to this many extra days in total, so it cannot be farmed. */
  qualityCap: 10,
  nicknameMax: 8,
});

export interface RelationshipToday { date: string; rounds: number; touched: boolean }
export interface RelationshipData {
  version: 1;
  /** Local date of the first real chat with this character. */
  metDate: string;
  /** Days that counted as time spent together, oldest first, no duplicates. */
  days: string[];
  /** Days with a quality moment (her confident read of the user, a concern/support reaction, a diary entry). */
  qualityDays: string[];
  today: RelationshipToday;
  /** Chat scopes (character + chat model) already scanned for older chats. */
  backfilled: string[];
  nickname: string | null;
  /** What the user calls HER (a nickname the user gave her or keeps using); she knows it from the first line of every session. Older files have none. */
  herNickname: string | null;
  /** She has asked once; she never asks again. */
  nicknameAsked: boolean;
  /** `date#milestone-key` already mentioned. */
  milestones: string[];
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}
const dayIndex = (date: string): number => {
  const [year, month, day] = date.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
};

export function emptyRelationship(today: string): RelationshipData {
  return { version: 1, metDate: today, days: [], qualityDays: [], today: { date: today, rounds: 0, touched: false },
    backfilled: [], nickname: null, herNickname: null, nicknameAsked: false, milestones: [] };
}

function insertDate(list: readonly string[], date: string): string[] {
  if (list.includes(date) || list.length >= RELATIONSHIP_LIMITS.days) return [...list];
  return [...list, date].sort();
}
function rolled(data: RelationshipData, date: string): RelationshipToday {
  return data.today.date === date ? data.today : { date, rounds: 0, touched: false };
}
function counted(data: RelationshipData, today: RelationshipToday): RelationshipData {
  const real = today.rounds >= RELATIONSHIP_LIMITS.roundsForDay || (today.rounds >= 1 && today.touched);
  return { ...data, today, days: real ? insertDate(data.days, today.date) : data.days };
}
/** One finished back-and-forth chat round on `date`. A day counts once, however many rounds follow. */
export function withRound(data: RelationshipData, date: string): RelationshipData {
  const today = rolled(data, date);
  return counted(data, { ...today, rounds: today.rounds + 1 });
}
/** A touch (head pat, cheek) or a feeding on `date`; it counts only together with a chat round. */
export function withTouch(data: RelationshipData, date: string): RelationshipData {
  return counted(data, { ...rolled(data, date), touched: true });
}
export function withQuality(data: RelationshipData, date: string): RelationshipData {
  return { ...data, qualityDays: insertDate(data.qualityDays, date) };
}

/** Days (quality ones only if the day also counted) + a capped bonus. Never goes down. */
export function effectiveDays(data: Pick<RelationshipData, 'days' | 'qualityDays'>): number {
  const days = new Set(data.days);
  const quality = data.qualityDays.filter(date => days.has(date)).length;
  return data.days.length + Math.min(RELATIONSHIP_LIMITS.qualityCap, quality * RELATIONSHIP_LIMITS.qualityWeight);
}

/** 认识第 N 天: the first chat day is day 1. */
export function dayNumber(metDate: string, today: string): number {
  return Math.max(1, dayIndex(today) - dayIndex(metDate) + 1);
}

/** A character nobody has chatted with yet starts counting on the day of the first chat, however long the app was open before it. */
export function withFreshStart(data: RelationshipData, today: string): RelationshipData {
  if (data.backfilled.length || data.days.length || data.today.rounds || data.qualityDays.length) return data;
  return { ...data, metDate: today, today: data.today.date === today ? data.today : { date: today, rounds: 0, touched: false } };
}

/**
 * Older chats of this scope: the earliest chat day becomes the day they met and days with enough
 * rounds count. Merging only ever adds days and moves the meeting day earlier.
 */
export function withBackfill(data: RelationshipData, scopeKey: string, first: string | null, rounds: ReadonlyMap<string, number> | Record<string, number>): RelationshipData {
  if (data.backfilled.includes(scopeKey)) return data;
  const entries = rounds instanceof Map ? [...rounds] : Object.entries(rounds);
  let days = [...data.days];
  for (const [date, count] of entries) {
    if (isDateKey(date) && count >= RELATIONSHIP_LIMITS.roundsForDay) days = insertDate(days, date);
  }
  const metDate = first && isDateKey(first) && first < data.metDate ? first : data.metDate;
  const todayRounds = entries.find(([date]) => date === data.today.date)?.[1] ?? 0;
  const today = todayRounds > data.today.rounds ? { ...data.today, rounds: todayRounds } : data.today;
  return { ...data, metDate, days, today,
    backfilled: [...data.backfilled, scopeKey].slice(-RELATIONSHIP_LIMITS.backfilledScopes) };
}

// ---- milestone days ----

export const MILESTONE_DAYS = [7, 30, 100, 365] as const;
export interface Milestone { key: string; text: string }
/** Day 7, 30, 100, 365 and every later anniversary of the meeting day; otherwise null. */
export function milestoneFor(metDate: string, today: string): Milestone | null {
  const number = dayNumber(metDate, today);
  if ((MILESTONE_DAYS as readonly number[]).includes(number)) return { key: `day-${number}`, text: `今天是你们认识的第 ${number} 天` };
  if (metDate.slice(5) === today.slice(5)) {
    const years = Number(today.slice(0, 4)) - Number(metDate.slice(0, 4));
    if (years >= 1) return { key: `year-${years}`, text: `今天是你们认识的纪念日（满 ${years} 年）` };
  }
  return null;
}

// ---- nickname ----

const NICKNAME_BLOCK = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>&"'`\\/:@{}\[\]“”‘’「」『』]/u;
/** A nickname she may ask about / use: 1–8 characters, plain text only. Null when it is not one. */
export function cleanNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const length = Array.from(text).length;
  if (!text || length > RELATIONSHIP_LIMITS.nicknameMax || NICKNAME_BLOCK.test(text)) return null;
  return text;
}

const AFFIRM = new Set(['好', '好的', '好呀', '好啊', '好哇', '好吧', '好哒', '好滴', '行', '行啊', '行呀', '行吧', '可以', '可以啊', '可以呀', '可以的',
  '当然', '当然可以', '没问题', '同意', '愿意', '嗯', '嗯嗯', '嗯好', '嗯嗯好', '好呀好呀', 'ok', 'okay', 'yes', 'sure']);
const REFUSE = new Set(['不', '不用', '不要', '不行', '不可以', '不愿意', '不想', '不好', '不必', '算了', '不用了', '不要了', '不用啦', '不要啦',
  '别', '别了', '拒绝', '还是不要了', '还是算了', 'no', 'nope']);

/**
 * Literal reading of the user's very next message after she asked. Only a short, plain yes counts;
 * a longer answer, a different subject, silence or anything unclear is 'unknown' and saves nothing.
 */
export function classifyNicknameReply(text: unknown): 'affirm' | 'refuse' | 'unknown' {
  if (typeof text !== 'string' || text.length > 24 || /[\r\n\t]/u.test(text)) return 'unknown';
  const literal = text.normalize('NFKC').trim().replace(/[\s。.!！~～…,，]+$/u, '').replace(/^[\s,，]+/u, '').toLowerCase();
  if (!literal) return 'unknown';
  if (REFUSE.has(literal)) return 'refuse';
  if (AFFIRM.has(literal)) return 'affirm';
  return 'unknown';
}

// ---- wording (the opening lines of a session; never per turn) ----

const STAGE_GUIDE: Readonly<Record<RelationshipStage, string>> = {
  new: '你们才刚认识不久：对用户有好奇心，愿意多了解对方，但不装熟，措辞比熟人更保留一点，不说起很多"以前"的事，也不必特意说出你们才认识多久。',
  warming: '你们已经聊过一阵子了：比刚认识时放松，偶尔可以开个小玩笑，保留会少一些，但还没到无话不说。',
  familiar: '你们已经很熟悉了：说话可以更随意，可以逗用户、吐槽、闹点小脾气，记得你们之间的小事。',
  close: '你们很亲近：不用刻意客气，可以直接表达偏心和在乎，也敢说得直白一点。',
  old: '你们是老朋友了：很多话不用说全，默契、玩笑和互相的了解都可以自然流露。',
};

export interface RelationshipOpeningInput {
  dayNumber: number;
  /** The card's "关系慢慢升温" switch. Off: no stage, she is familiar from the first day. */
  slowWarmUp: boolean;
  stage?: RelationshipStage;
  nickname?: string | null;
  /** What the user calls her (see RelationshipData.herNickname). */
  herNickname?: string | null;
  milestone?: Milestone | null;
}

/** The line placed right after the persona when a session opens. */
export function relationshipOpeningText(input: RelationshipOpeningInput): string {
  const days = Math.max(1, Math.floor(input.dayNumber));
  const parts: string[] = [];
  if (input.slowWarmUp && input.stage) {
    parts.push(`【你们的关系】你们认识第 ${days} 天，现在的关系：${STAGE_LABELS[input.stage]}。${STAGE_GUIDE[input.stage]}按你自己的性格自然体现（慢热的角色放开得更慢），不要说出“关系阶段”这几个字。`);
  } else {
    parts.push(`【你们的关系】你们认识第 ${days} 天。这只是日期，不是生疏程度：你从一开始就和用户很熟，不客气、不装生，说话的分寸完全由你自己的性格决定。`);
  }
  if (input.nickname) parts.push(`用户同意你这样称呼用户：“${input.nickname}”。自然地用，不必每句都叫。`);
  if (input.herNickname) parts.push(`用户叫你“${input.herNickname}”，这是你们之间的称呼，你早就知道、也接受了：别当成第一次听到，不用每句都提，怎么回应由你的性格自然决定。`);
  if (input.milestone) parts.push(`${input.milestone.text}，可以自然地提一句，不强求；提过就不再提。`);
  return parts.join('\n');
}

/**
 * What decides whether an open session must restart: the switch, the stage and the nickname.
 * The day number and the milestone sentence deliberately do not, so a day change never restarts a chat.
 */
export function relationshipSessionTag(input: Pick<RelationshipOpeningInput, 'slowWarmUp' | 'stage' | 'nickname' | 'herNickname'>): string {
  return `${input.slowWarmUp ? input.stage ?? 'new' : 'off'}|${input.nickname ?? ''}${input.herNickname ? `|her:${input.herNickname}` : ''}`;
}

/** Added to one turn's reply tail when she may ask for a nickname (electron/mood-chat.ts); the only per-turn cost, once. */
export const NICKNAME_ASK_INSTRUCTION =
  '这一轮你可以顺带自然地问用户一次：以后想怎么称呼用户（按你的性格起个能一直用的叫法，不超过6个字，别拿刚聊到的某件事来叫；用户提过自己的名字或喜欢的叫法就用那个）。'
  + '叫法写在问句里，别说已经改了，别催；用户在难过、很忙或在说正事，就不要问。问了的话，在状态尾注里再加字段 "nick":"你问的那个叫法"（第七个字段，没问就不要写）。';

/** The meme line in the opening block: at most two small things, quoted from her own diary. */
export const MEME_CONTEXT_NOTE = '以下是只属于你们两个人的小事（来自你自己的日记，新到旧）。至多自然提起一件，不要背诵，不要每次都提；这次对话用不上就不提。';

// ---- developer panel and diagnostics (numbers only) ----

/** Developer mood panel only (MoodView.relationship). Never carries the nickname or any text. */
export interface RelationshipView {
  dayNumber: number;
  togetherDays: number;
  qualityDays: number;
  /** togetherDays plus the capped quality bonus (what the stage thresholds are compared with). */
  effectiveDays: number;
  slowWarmUp: boolean;
  /** Present only while the card has "关系慢慢升温" on. */
  stage?: RelationshipStage;
  nextStage?: RelationshipStage | null;
  daysToNext?: number | null;
  thresholds?: number[];
  /** The stage was set by hand in developer mode (until restart). */
  overridden?: boolean;
  hasNickname: boolean;
  nicknameAsked: boolean;
}

export const RELATIONSHIP_DIAGNOSTIC_KINDS = ['day', 'quality', 'stage', 'backfill', 'milestone', 'nickname-ask', 'nickname-saved',
  'nickname-declined', 'nickname-ignored', 'nickname-changed', 'her-nickname-saved', 'override'] as const;
export type RelationshipDiagnosticKind = (typeof RELATIONSHIP_DIAGNOSTIC_KINDS)[number];
export interface RelationshipDiagnostic {
  at: number;
  kind: RelationshipDiagnosticKind;
  dayNumber: number;
  togetherDays: number;
  qualityDays: number;
  /** Only when the card is slowly warming up. */
  stage?: RelationshipStage;
}

/** Whitelist copy: a time, one of the fixed kinds and four numbers. Never a nickname, a date string or any text. */
export function sanitizeRelationshipDiagnostic(value: unknown): RelationshipDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const whole = (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0;
  if (!whole(v.at) || typeof v.kind !== 'string' || !(RELATIONSHIP_DIAGNOSTIC_KINDS as readonly string[]).includes(v.kind)
    || !whole(v.dayNumber) || !whole(v.togetherDays) || !whole(v.qualityDays)) return null;
  const stage = typeof v.stage === 'string' && (RELATIONSHIP_STAGES as readonly string[]).includes(v.stage) ? v.stage as RelationshipStage : undefined;
  return { at: v.at as number, kind: v.kind as RelationshipDiagnosticKind, dayNumber: v.dayNumber as number,
    togetherDays: v.togetherDays as number, qualityDays: v.qualityDays as number, ...(stage ? { stage } : {}) };
}
