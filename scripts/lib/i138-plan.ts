// I-138 restart-drift experiment (docs/claude/2026-11-15-i134-restart-drift-experiment.md, tool: docs/claude/2026-11-15-i138-tool.md):
// the plan (how many calls each step makes), the call cap, the output-folder check and moment suggestion. No model call happens here.
import { access } from 'node:fs/promises';
import path from 'node:path';
import { assertPrivateRoot } from './private-root.mjs';
import { assertNotProfilePath } from './i134-replay';
import { localDateKey } from '../../electron/memory/diary/diary-dates';
import type { Timed } from '../../electron/brain/long-chat/history';

/** W: the same live process goes on. R: closed and rebuilt from the archive (today + 60 + note). R0: like R without the note. C: a forked copy compacted once. */
export type DriftArm = 'W' | 'R' | 'R0' | 'C';
/** The order the arms run in after the warm-up: the archive-based ones first, then the fork, the live process last. */
export const DRIFT_ARMS: readonly DriftArm[] = ['R', 'R0', 'C', 'W'];
export const DRIFT_ARM_NAMES: Readonly<Record<DriftArm, string>> = { W: '不换', R: '换进程', R0: '换进程不带笔记', C: '被压缩' };
export const DEFAULT_CALL_CAP = 115;

export interface DriftSettings {
  /** Real user lines fed live during the warm-up. */
  warmup: number;
  /** Real user lines each arm continues with. */
  next: number;
  /** Number of moments. */
  moments: number;
  /** Gate 1: one reviewer call per moment. */
  review: boolean;
  /** Question 1: calls that measure characters per token (separate from the moments). */
  q1Calls: number;
  /** Arms planned (default all four). */
  arms?: readonly DriftArm[];
}
export const DEFAULT_SETTINGS: DriftSettings = { warmup: 12, next: 5, moments: 3, review: true, q1Calls: 0 };

export interface PlanStep { step: string; calls: number; per: number }
/**
 * Everything the run would call, per step. One call = one model request: a chat turn, her note, the /compact of the C arm, the reviewer.
 * (The compaction is a model call too: it writes the summary.)
 */
export function plannedCalls(settings: DriftSettings): { steps: PlanStep[]; total: number } {
  const arms = settings.arms ?? DRIFT_ARMS;
  const m = settings.moments;
  const steps: PlanStep[] = [
    { step: '她的笔记（每个时刻 1 次）', per: 1, calls: m },
    { step: `热身（每个时刻 ${settings.warmup} 次）`, per: settings.warmup, calls: m * settings.warmup },
    ...(arms.includes('C') ? [{ step: '压缩（C 组，每个时刻 1 次）', per: 1, calls: m }] : []),
    ...arms.map(arm => ({ step: `${arm} ${DRIFT_ARM_NAMES[arm]}（每个时刻 ${settings.next} 次）`, per: settings.next, calls: m * settings.next })),
    ...(settings.review ? [{ step: '第一道关：Claude 审查（每个时刻 1 次）', per: 1, calls: m }] : []),
    ...(settings.q1Calls ? [{ step: '问题 1：字到词元', per: settings.q1Calls, calls: settings.q1Calls }] : []),
  ];
  return { steps, total: steps.reduce((sum, item) => sum + item.calls, 0) };
}

/** A hard stop on model requests. `take` throws once the cap would be passed, before anything is sent. */
export class CallCap {
  used = 0;
  constructor(readonly cap: number, used = 0) { this.used = used; }
  take(kind: string): void {
    if (this.used + 1 > this.cap) throw new Error(`已到 ${this.cap} 次调用上限（${kind}），停止。`);
    this.used++;
  }
}

/** The output folder may not be inside the repository (any parent with a .git), OneDrive, a Codex profile or a soft hearts profile. */
export async function assertDriftOut(label: string, target: string): Promise<string> {
  assertNotProfilePath(label, target);
  const real = await assertPrivateRoot(target);
  for (let dir = path.resolve(real); ; dir = path.dirname(dir)) {
    if (await access(path.join(dir, '.git')).then(() => true, () => false)) throw new Error(`${label} 不能放在代码仓库里（${dir} 有 .git）。`);
    if (path.dirname(dir) === dir) break;
  }
  return real;
}

/**
 * Candidate moments: a user message followed (same local day) by at least `need - 1` more user messages, each less than `maxGapMs` after the
 * previous one. Returns ids and times only (never text). Spread over the chat: at most one per day, newest first when `limit` cuts.
 */
export function suggestMoments(messages: readonly Timed[], need: number, options: { maxGapMs?: number; limit?: number } = {}): { id: string; at: number; users: number }[] {
  const maxGap = options.maxGapMs ?? 30 * 60_000;
  const users = messages.filter(message => message.role === 'user');
  const found: { id: string; at: number; users: number }[] = [];
  const seenDays = new Set<string>();
  for (let i = 0; i < users.length; i++) {
    const day = localDateKey(users[i]!.createdAt);
    if (seenDays.has(day)) continue;
    let run = 1;
    while (i + run < users.length && localDateKey(users[i + run]!.createdAt) === day && users[i + run]!.createdAt - users[i + run - 1]!.createdAt < maxGap) run++;
    if (run >= need) { seenDays.add(day); found.push({ id: `m${String(found.length + 1).padStart(2, '0')}`, at: users[i]!.createdAt, users: run }); }
  }
  const limit = options.limit ?? 10;
  return found.length > limit ? found.slice(-limit).map((item, index) => ({ ...item, id: `m${String(index + 1).padStart(2, '0')}` })) : found;
}
