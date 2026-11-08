import {
  USER_STATE_FADE_MS, USER_STATE_MIN_CONFIDENCE, USER_STATES, cleanUserStateReason, isActiveUserState, userStateChatLine, userStateInnerLoopLine,
  type ActiveUserState, type UserStateJudgment, type UserStateKind, type UserStateView,
} from '../shared/user-state';
import { appendBounded } from './reply-latency';

export interface UserStateEntry { state: ActiveUserState; confidence: number; reason: string; at: number }
const MAX_CHARACTERS = 128;

/**
 * Her read of how the user is right now ("读懂你的情绪", docs/claude/2026-11-02-user-state-plan.md).
 * Memory only, on purpose: nothing here is written to a file, exported, put in the diary or
 * the user profile, and a restart starts empty. One judgment per character; a new one replaces
 * the old; each active state fades on its own clock (about the user, so the same for every card).
 * calm and unknown do not persist, they only clear what was there.
 */
export class UserStateStore {
  private readonly entries = new Map<string, UserStateEntry>();
  private readonly clock: () => number;
  constructor(private readonly options: {
    clock?: () => number;
    /** Called after a judgment was stored, replaced or cleared (not for ignored ones). */
    changed?: (characterId: string) => void;
    /** Called for every judgment that passed the confidence gate (the developer diagnostics). */
    record?: (entry: { at: number; state: UserStateKind; confidence: number }, characterId: string) => void;
  } = {}) { this.clock = options.clock ?? Date.now; }

  /** Applies one parsed judgment. Returns whether the stored judgment changed. */
  note(characterId: string, judgment: UserStateJudgment | null, at = this.clock()): boolean {
    if (!judgment || typeof characterId !== 'string' || !characterId) return false;
    if (!(USER_STATES as readonly string[]).includes(judgment.state) || !Number.isFinite(judgment.confidence)
      || judgment.confidence < USER_STATE_MIN_CONFIDENCE || judgment.confidence > 1 || !Number.isFinite(at)) return false;
    try { this.options.record?.({ at, state: judgment.state, confidence: judgment.confidence }, characterId); } catch { /* Diagnostics never block a reply. */ }
    let changed: boolean;
    if (isActiveUserState(judgment.state)) {
      this.entries.delete(characterId);
      this.entries.set(characterId, { state: judgment.state, confidence: judgment.confidence, reason: cleanUserStateReason(judgment.reason), at });
      while (this.entries.size > MAX_CHARACTERS) this.entries.delete(this.entries.keys().next().value!);
      changed = true;
    } else changed = this.entries.delete(characterId);
    if (changed) this.notify(characterId);
    return changed;
  }

  /** The unfaded judgment for this character, if any. */
  current(characterId: string, now = this.clock()): (UserStateEntry & { fadesAt: number }) | null {
    const entry = this.entries.get(characterId);
    if (!entry) return null;
    const fadesAt = entry.at + USER_STATE_FADE_MS[entry.state];
    if (now >= fadesAt) { this.entries.delete(characterId); return null; }
    return { ...entry, fadesAt };
  }

  /** The private line for the next chat turns; '' when there is nothing (or it has faded). */
  chatContext(characterId: string, now = this.clock()): string {
    const entry = this.current(characterId, now);
    return entry ? userStateChatLine(entry, now) : '';
  }
  /** The shorter line for the inner loop's decision input. */
  innerLoopContext(characterId: string, now = this.clock()): string {
    const entry = this.current(characterId, now);
    return entry ? userStateInnerLoopLine(entry, now) : '';
  }
  /** Developer panel only: no reason text. */
  view(characterId: string, now = this.clock()): UserStateView | null {
    const entry = this.current(characterId, now);
    return entry ? { state: entry.state, confidence: entry.confidence, at: entry.at, fadesAt: entry.fadesAt } : null;
  }

  clear(characterId: string): void {
    if (this.entries.delete(characterId)) this.notify(characterId);
  }
  private notify(characterId: string): void {
    try { this.options.changed?.(characterId); } catch { /* A closed panel just misses this update. */ }
  }
}

export interface UserStateDiagnostic { at: number; state: UserStateKind; confidence: number }

/** Whitelist copy: time, state and confidence only. Never the reason or any text. */
export function sanitizeUserStateDiagnostic(value: unknown): UserStateDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.at) || (v.at as number) < 0 || typeof v.state !== 'string' || !(USER_STATES as readonly string[]).includes(v.state)
    || typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) return null;
  return { at: v.at as number, state: v.state as UserStateKind, confidence: v.confidence };
}

/** Developer mode only: one line per accepted judgment in `<profile>/dev/user-state.jsonl` (bounded, rotated by appendBounded). */
export class UserStateDiagnostics {
  constructor(private readonly options: {
    enabled(): boolean;
    file(): string | null;
    write?: (file: string, line: string) => Promise<void>;
  }) {}
  record(value: unknown): void {
    let enabled = false;
    try { enabled = this.options.enabled() === true; } catch { enabled = false; }
    if (!enabled) return;
    const entry = sanitizeUserStateDiagnostic(value);
    if (!entry) return;
    let file: string | null = null;
    try { file = this.options.file(); } catch { file = null; }
    if (file) void (this.options.write ?? appendBounded)(file, JSON.stringify(entry) + '\n').catch(() => {});
  }
}
