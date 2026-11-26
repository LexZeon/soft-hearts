// I-112 B: "更真实的情绪" turns itself off after a time the user chose in the consent dialog (docs/claude/2026-11-14-i112-realer-emotions-timer.md).
// Pure: no Electron, no clock of its own. The end time (epoch ms) lives only in this machine's characters.json, never in a card file.

export const REALER_DURATIONS = ['day', 'week', 'month', 'forever'] as const;
export type RealerDuration = (typeof REALER_DURATIONS)[number];
/** The user's default (plan v2, "按推荐"): a week. */
export const DEFAULT_REALER_DURATION: RealerDuration = 'week';
export const REALER_DURATION_LABELS: Readonly<Record<RealerDuration, string>> = Object.freeze({ day: '一天', week: '一周', month: '一个月', forever: '一直开' });

const DAY_MS = 24 * 60 * 60 * 1000;
const SPAN_DAYS: Record<Exclude<RealerDuration, 'forever'>, number> = { day: 1, week: 7, month: 30 };

export function isRealerDuration(value: unknown): value is RealerDuration {
  return typeof value === 'string' && (REALER_DURATIONS as readonly string[]).includes(value);
}

/** The end time for a choice started at `now`; null for "一直开" (never expires). */
export function realerUntil(duration: RealerDuration, now: number): number | null {
  return duration === 'forever' ? null : now + SPAN_DAYS[duration] * DAY_MS;
}

/** What the card editor shows next to the switch; the card is the public card (the end time is its local state). */
export type RealerStatus =
  | { kind: 'until'; month: number; day: number; hour: string; minute: string }
  | { kind: 'forever' }
  | { kind: 'expired' };

export function realerStatus(card: { realerEmotions?: boolean; realerEmotionsUntil?: number; realerEmotionsExpired?: boolean }): RealerStatus | null {
  if (card.realerEmotions === true) {
    if (typeof card.realerEmotionsUntil !== 'number') return { kind: 'forever' };
    const at = new Date(card.realerEmotionsUntil);
    const two = (value: number) => String(value).padStart(2, '0');
    return { kind: 'until', month: at.getMonth() + 1, day: at.getDate(), hour: two(at.getHours()), minute: two(at.getMinutes()) };
  }
  return card.realerEmotionsExpired === true ? { kind: 'expired' } : null;
}
