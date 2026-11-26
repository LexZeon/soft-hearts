/**
 * I-209: what the host and the full-screen pages say to each other about the others on stage. Their own channels, so nothing of it ever
 * sends a scene (a scene places her again). Plain values only: numbers, card ids, flags; never a path, a name or anything she said.
 *
 *  - step 1's guard stays: the frame-cost guard's "one fewer" (shared/unbound/company/guard.ts), from the window of the one you talk with;
 *  - step 3 (each one her own full screen): every page reports her body while two or more are on stage, and hears the shared world
 *    (shared/unbound/company/bodies.ts StageView); one being sent back says when she has walked out.
 */
import { COMPANY_MAX_PRESENT } from './presence';

export const UNBOUND_COMPANY_REQUESTS = Object.freeze({
  /** The frame-cost guard says: one fewer (shared/unbound/company/guard.ts CompanyGuardVerdict). */
  guard: 'unbound:company-guard',
} as const);

/** I-209 step 3: each page's own requests to the stage coordinator (electron/unbound/company/stage.ts). */
export const UNBOUND_STAGE_REQUESTS = Object.freeze({
  /** Her body now (StageBody): where she stands, how wide, how she moves. */
  body: 'unbound:stage-body',
  /** She was sent back and has walked out of the screen: her window may close. */
  left: 'unbound:stage-left',
  /** 2026-11-24 (docs/claude/2026-11-24-stage-smooth.md): her frame times of the last minute (FrameMinute plus tier and withYou): one journal row. */
  frames: 'unbound:stage-frames',
  /** 2026-11-25 (docs/claude/2026-11-25-stage-mouth-height.md): how far her lips parted while she read one reply (closed words, numbers): one 'mouth-reading' row under her id. */
  mouth: 'unbound:stage-mouth',
} as const);
export const UNBOUND_STAGE_EVENTS = Object.freeze({ stage: 'unbound:stage' } as const);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The page's guard verdict (shared/unbound/company/guard.ts). */
export function parseCompanyGuard(value: unknown): { present: number; p95Ms: number; budgetMs: number } | null {
  if (!record(value) || !Number.isInteger(value.present) || !finite(value.p95Ms) || !finite(value.budgetMs)) return null;
  const present = value.present as number;
  if (present < 2 || present > COMPANY_MAX_PRESENT || value.p95Ms < 0 || value.p95Ms > 10_000 || value.budgetMs <= 0 || value.budgetMs > 1_000) return null;
  return { present, p95Ms: value.p95Ms, budgetMs: value.budgetMs };
}
