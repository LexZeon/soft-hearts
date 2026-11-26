// 体验记录 (the experience journal): the entry types of the memory part (记忆和关系): relationship, app, journal, truncated, upcoming, special-day, period-review.
// shared/memory/journal.ts joins every part's slice and keeps THE BOUNDARY written at its top: a line holds times, the character
// id, a type, fixed enum values, numbers and a plain-language reason from a fixed table; never a word of chat, a file path or a key.
// Moved here from shared/memory/journal.ts on 2026-11-16 (docs/claude/2026-11-16-journal-split.md) without changing a line it writes.
// THE RULE FOR A NEW ENTRY TYPE: it goes into its part's slice, shared/<part>/journal-entries.ts: its input shape in the part's
// <Part>JournalInput, its closed word lists beside it, its case in the slice's three functions (reason, build, describe) and its
// name in <PART>_JOURNAL_TYPES. Then its name goes into JOURNAL_TYPES in shared/memory/journal.ts, valid inputs for it into
// BASES in tests/helpers/journal-behaviour.ts, and both goldens are regenerated (scripts/dev/journal-surface.mjs --write,
// scripts/dev/journal-behaviour.ts --write), saying why in the commit. A part without a slice gets one: a new file like this, one
// entry in each of the four slice tables of shared/memory/journal.ts, and its names on the part's index.ts.
import { APP_STOP_CAUSES, APP_STOP_CAUSE_LABEL, type AppStopCause } from '../foundation/app-session';
import { count, finite, has, type JournalTranslate } from '../foundation/journal-fields';
import { RELATIONSHIP_DIAGNOSTIC_KINDS, RELATIONSHIP_STAGES, type RelationshipDiagnosticKind, type RelationshipStage } from './relationship';
import { SPECIAL_DAY_EVENTS, SPECIAL_DAY_FIRST, SPECIAL_DAY_KINDS, type SpecialDayEvent, type SpecialDayFirst, type SpecialKind } from './special-day';

/** I-088 第 1 条: one look-back (a week or a month): written, skipped (not enough to write about), failed (the call), invalid (the answer could not be used). */
export const PERIOD_REVIEW_EVENTS = ['written', 'skipped', 'failed', 'invalid'] as const;
export type PeriodReviewJournalEvent = (typeof PERIOD_REVIEW_EVENTS)[number];
export const PERIOD_REVIEW_KINDS = ['week', 'month'] as const;
export type PeriodReviewJournalKind = (typeof PERIOD_REVIEW_KINDS)[number];
const PERIOD_REVIEW_REASON: Readonly<Record<PeriodReviewJournalEvent, Readonly<Record<PeriodReviewJournalKind, string>>>> = {
  written: { week: '她写好了上一周的回顾', month: '她写好了上个月的回顾' },
  skipped: { week: '上一周的内容还不够，她没写回顾', month: '上个月的内容还不够，她没写回顾' },
  failed: { week: '写上一周的回顾时没有成功（连不上或出错），晚些再试', month: '写上个月的回顾时没有成功（连不上或出错），晚些再试' },
  invalid: { week: '她写的上一周的回顾不能用，晚些再试', month: '她写的上个月的回顾不能用，晚些再试' },
};
/** P-001: she noted a plan of yours / asked about one / you spoke of it first / it expired unasked. Counts only, never the plan. */
export const UPCOMING_JOURNAL_EVENTS = ['recorded', 'asked', 'user-said', 'expired'] as const;
export type UpcomingJournalEvent = (typeof UPCOMING_JOURNAL_EVENTS)[number];
/** P-001: which path noted it: the small look two quiet minutes after you said it, or the segment's note. */
export const UPCOMING_JOURNAL_VIA = ['early', 'note'] as const;
export type UpcomingJournalVia = (typeof UPCOMING_JOURNAL_VIA)[number];
const UPCOMING_REASON: Readonly<Record<UpcomingJournalEvent, string>> = {
  recorded: '她记下了你说的计划', asked: '她问起了你说过的计划', 'user-said': '你自己先说起了这件计划', expired: '计划过期了，她没碰上机会问',
};

const SPECIAL_DAY_REASON: Readonly<Record<SpecialDayEvent, string>> = {
  hinted: '今天是你的特别的日子，她得到一次可以说点什么的机会', said: '她说起了你的特别的日子', expired: '你的特别的日子过去了，她没碰上机会说',
  'user-first': '你的特别的日子，你自己先说起了',
};
const RELATIONSHIP_REASON: Readonly<Record<RelationshipDiagnosticKind, string>> = {
  day: '新的一天（相处天数 +1）', quality: '今天是好好相处的一天', stage: '关系阶段变了', backfill: '补算了以前的相处天数',
  milestone: '认识纪念日', 'nickname-ask': '她问了以后怎么称呼你', 'nickname-saved': '记住了你的称呼', 'nickname-declined': '你没让她换称呼',
  'nickname-ignored': '称呼的事没有下文', 'nickname-changed': '你改了称呼', 'her-nickname-saved': '记住了你给她起的外号', 'card-milestone': '她觉得角色卡里的那件事发生了（里程碑到了）', override: '开发者临时改了关系阶段',
};
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** How long the app may have been closed in a line: ten years is plenty (more is kept as ten years). */
const CLOSED_MAX_MS = 10 * 366 * 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');
export function journalClock(at: number): string { const date = new Date(at); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; }

/** "8 小时 12 分", "3 天 2 小时", "12 分", "40 秒": how long the app was closed, in the panel's words. */
export function journalDuration(ms: number, tr: JournalTranslate): string {
  const seconds = Math.max(0, Math.round(ms / 1000)), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days > 0) return tr('{0} 天 {1} 小时', days, hours % 24);
  if (hours > 0) return tr('{0} 小时 {1} 分', hours, minutes % 60);
  if (minutes > 0) return tr('{0} 分', minutes);
  return tr('{0} 秒', seconds);
}

/** I-022: what an app line adds after the version — how it quit, or when the previous run stopped and how long it was closed. */
function appStopText(entry: Extract<MemoryJournalInput, { type: 'app' }>, tr: JournalTranslate): string {
  if (entry.event === 'quit') return entry.cause ? tr(' · {0}', tr(APP_STOP_CAUSE_LABEL[entry.cause])) : '';
  if (entry.stopped === 'unknown') return tr(' · 没有上次退出的记录');
  if (entry.stoppedAt === undefined || entry.closedMs === undefined) return '';
  if (entry.clockBack) return tr(' · 电脑时间比上次停下时还早，关了多久不算');
  if (entry.stopped === 'unclean') return tr(' · 上次没正常退出，最多关了 {0}（估的：按 {1} 最后一次还在算）', journalDuration(entry.closedMs, tr), journalClock(entry.stoppedAt));
  return tr(' · 上次 {0} 退出（{1}），关了 {2}', journalClock(entry.stoppedAt), tr(APP_STOP_CAUSE_LABEL[entry.cause ?? 'other']), journalDuration(entry.closedMs, tr));
}

/** The journal entry types of this part, in JOURNAL_TYPES order (shared/memory/journal.ts dispatches by it). */
export const MEMORY_JOURNAL_TYPES = ['relationship', 'app', 'journal', 'truncated', 'upcoming', 'special-day', 'period-review'] as const;

/** What a caller hands to the writer for this part's types (shared/memory/journal.ts JournalInput joins every part's). */
export type MemoryJournalInput =
  | { type: 'relationship'; characterId: string; kind: RelationshipDiagnosticKind; dayNumber: number; togetherDays: number; qualityDays: number; stage?: RelationshipStage }
  /**
   * 应用启动 / 退出 (I-022 "关应用也记"): times, a closed cause and how long it was closed, never anything else.
   * quit: `cause`, how it was asked to quit. start: how the previous run ended — `stopped` 'clean' (it wrote its stop: `stoppedAt`
   * is exact, with its `cause`), 'unclean' (上次没正常退出: `stoppedAt` is its last sign of life and `closedMs` an upper bound,
   * `estimated: true`) or 'unknown' (no record, the first start that keeps one); `clockBack` when the clock is now earlier than that.
   * Lines written before I-022 have none of these and still read back.
   */
  | { type: 'app'; characterId: string | null; event: 'start' | 'quit'; version: string; commit: string | null;
      cause?: AppStopCause; stopped?: 'clean' | 'unclean' | 'unknown'; stoppedAt?: number; closedMs?: number; estimated?: true; clockBack?: true }
  | { type: 'journal'; characterId: string | null; event: 'on' | 'off' }
  | { type: 'truncated'; characterId: null; day: string }
  /** P-001 她记得的事: one of four closed events and how many plans (a number, never the plan or the words). */
  | { type: 'upcoming'; characterId: string | null; event: UpcomingJournalEvent; count: number; via?: UpcomingJournalVia }
  /** I-059 特别的日子: hinted / said / expired / user-first, the kind of day, and who brought it up first that day (null: not decided yet). Never a word of what was said. */
  | { type: 'special-day'; characterId: string | null; event: SpecialDayEvent; kind: SpecialKind; first: SpecialDayFirst | null }
  /** I-088 第 1 条 她的"这阵子"回顾: a week or a month, and one of four closed events. Never a word of the look-back. */
  | { type: 'period-review'; characterId: string | null; kind: PeriodReviewJournalKind; event: PeriodReviewJournalEvent };

// ---------------------------------------------------------------- the fixed plain-language reasons

/** The fixed reason of this part's entries (shared/memory/journal.ts journalReason). Only enum fields choose it; nothing a caller wrote can reach it. */
export function memoryJournalReason(entry: MemoryJournalInput): string {
  switch (entry.type) {
    case 'relationship': return RELATIONSHIP_REASON[entry.kind];
    case 'app': return entry.event === 'start' ? '应用启动' : '应用退出';
    case 'journal': return entry.event === 'on' ? '体验记录开启' : '体验记录关闭';
    case 'truncated': return '今天的记录到上限了，后面的不再写';
    // ---- I-050 her folder
    case 'upcoming': return UPCOMING_REASON[entry.event];
    case 'special-day': return SPECIAL_DAY_REASON[entry.event];
    case 'period-review': return PERIOD_REVIEW_REASON[entry.event][entry.kind];
  }
}

// ---------------------------------------------------------------- building a line (the whitelist)

/**
 * This part's lines, field by field from closed sets (shared/memory/journal.ts buildJournalEntry checked the input, the type and the
 * character id, and adds the version, the time and the reason). Null when anything does not fit.
 */
export function buildMemoryJournalEntry(type: string, v: Record<string, unknown>, characterId: string | null): MemoryJournalInput | null {
  let body: MemoryJournalInput | null = null;
  switch (type) {
    case 'relationship': {
      const dayNumber = count(v.dayNumber, 100_000), togetherDays = count(v.togetherDays, 100_000), qualityDays = count(v.qualityDays, 100_000);
      if (!characterId || !has(RELATIONSHIP_DIAGNOSTIC_KINDS, v.kind) || dayNumber === undefined || togetherDays === undefined || qualityDays === undefined) return null;
      body = { type, characterId, kind: v.kind, dayNumber, togetherDays, qualityDays, ...(has(RELATIONSHIP_STAGES, v.stage) ? { stage: v.stage } : {}) };
      break;
    }
    case 'app': {
      if ((v.event !== 'start' && v.event !== 'quit') || typeof v.version !== 'string' || !VERSION.test(v.version)) return null;
      // I-022: a field that does not fit is dropped, the line stays (it still says the app started or quit).
      const extra: { cause?: AppStopCause; stopped?: 'clean' | 'unclean' | 'unknown'; stoppedAt?: number; closedMs?: number; estimated?: true; clockBack?: true } = {};
      if (v.event === 'quit' && has(APP_STOP_CAUSES, v.cause)) extra.cause = v.cause;
      if (v.event === 'start' && (v.stopped === 'clean' || v.stopped === 'unclean' || v.stopped === 'unknown')) {
        const stoppedAt = finite(v.stoppedAt) && v.stoppedAt >= 0 ? Math.floor(v.stoppedAt) : undefined, closedMs = count(v.closedMs, CLOSED_MAX_MS);
        if (v.stopped === 'unknown') extra.stopped = 'unknown';
        else if (stoppedAt !== undefined && closedMs !== undefined) {
          Object.assign(extra, { stopped: v.stopped, stoppedAt, closedMs });
          if (v.stopped === 'unclean') extra.estimated = true;
          else if (has(APP_STOP_CAUSES, v.cause)) extra.cause = v.cause;
          if (v.clockBack === true) extra.clockBack = true;
        }
      }
      body = { type, characterId, event: v.event, version: v.version, commit: typeof v.commit === 'string' && COMMIT.test(v.commit) ? v.commit : null, ...extra };
      break;
    }
    case 'journal':
      if (v.event !== 'on' && v.event !== 'off') return null;
      body = { type, characterId, event: v.event };
      break;
    case 'truncated':
      if (typeof v.day !== 'string' || !DAY.test(v.day)) return null;
      body = { type, characterId: null, day: v.day };
      break;
    case 'special-day': {
      if (!has(SPECIAL_DAY_EVENTS, v.event) || !has(SPECIAL_DAY_KINDS, v.kind) || (v.first != null && !has(SPECIAL_DAY_FIRST, v.first))) return null;
      body = { type, characterId, event: v.event, kind: v.kind, first: (v.first ?? null) as SpecialDayFirst | null };
      break;
    }
    case 'period-review':
      // Closed words only: week or month, and what became of it. A look-back's text is never an input.
      if (!has(PERIOD_REVIEW_KINDS, v.kind) || !has(PERIOD_REVIEW_EVENTS, v.event)) return null;
      body = { type, characterId, kind: v.kind, event: v.event };
      break;
    case 'upcoming': {
      const n = count(v.count, 100);
      if (!has(UPCOMING_JOURNAL_EVENTS, v.event) || n === undefined || n < 1) return null;
      if (v.via !== undefined && !has(UPCOMING_JOURNAL_VIA, v.via)) return null;
      body = { type, characterId, event: v.event, count: n, ...(v.via !== undefined ? { via: v.via as UpcomingJournalVia } : {}) };
      break;
    }
  }
  return body;
}

// ---------------------------------------------------------------- "刚才发生了什么": one plain line per entry

/** This part's entries in the control window, after the time (shared/memory/journal.ts describeJournalEntry); `reason` is the entry's reason, translated. */
export function describeMemoryJournalEntry(entry: MemoryJournalInput, reason: string, tr: JournalTranslate): string {
  let body: string;
  switch (entry.type) {
    case 'relationship': body = tr('{0}（认识第 {1} 天 · 相处 {2} 天）', reason, entry.dayNumber, entry.togetherDays); break;
    case 'app': body = tr('{0}（{1}{2}）', reason, entry.version, entry.commit ? ` · ${entry.commit.slice(0, 7)}` : '') + appStopText(entry, tr); break;
    case 'upcoming':
      body = tr('{0}（{1} 件）', reason, String(entry.count));
      break;
    case 'special-day':
      body = tr('{0}（{1}，{2}）', reason, tr(entry.kind === 'birthday' ? '生日' : '纪念日'), tr(entry.first === 'her' ? '她先提起的' : entry.first === 'user' ? '你先提起的' : '还没人提起'));
      break;
    case 'period-review':
      body = reason;
      break;
    default: body = reason;
  }
  return body;
}
