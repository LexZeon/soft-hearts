// "读懂你的情绪" (docs/claude/2026-11-02-user-state-plan.md): her short-lived read of how the
// user is right now. It rides on the existing reply tail as one optional field, lives only in
// memory (electron/user-state.ts) and fades. Pure helpers only: parsing, fade times and the
// wording of the private context lines.

export const USER_STATES = ['tired', 'annoyed', 'low', 'happy', 'excited', 'calm', 'unknown'] as const;
export type UserStateKind = (typeof USER_STATES)[number];
/** The states that persist for a while; calm and unknown only clear what was there. */
export type ActiveUserState = Exclude<UserStateKind, 'calm' | 'unknown'>;

/** Same gate as the rest of the reply tail. */
export const USER_STATE_MIN_CONFIDENCE = 0.75;
export const USER_STATE_REASON_MAX = 40;

const MINUTE = 60_000;
/** About the user, not the character: the same for every card. */
export const USER_STATE_FADE_MS: Readonly<Record<ActiveUserState, number>> = {
  happy: 30 * MINUTE, excited: 30 * MINUTE, annoyed: 45 * MINUTE, tired: 90 * MINUTE, low: 180 * MINUTE,
};
export const USER_STATE_LABELS: Readonly<Record<ActiveUserState, string>> = {
  tired: '累', annoyed: '烦', low: '低落', happy: '开心', excited: '兴奋',
};

/** What the model writes into the tail (after parsing). */
export interface UserStateJudgment { state: UserStateKind; confidence: number; reason: string }

/** Developer-panel view; no reason text. */
export interface UserStateView { state: ActiveUserState; confidence: number; at: number; fadesAt: number }

export const isActiveUserState = (state: UserStateKind): state is ActiveUserState => state !== 'calm' && state !== 'unknown';

/** A short single line of plain text: no markers, no control characters, bounded. */
export function cleanUserStateReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Control, format (bidi, zero-width) and line/paragraph separator characters, plus markers and backticks, become spaces.
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>`]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return Array.from(text).slice(0, USER_STATE_REASON_MAX).join('').trim();
}

/**
 * The tail's optional `user` field. Anything missing, malformed or not confident enough is
 * simply null: the caller drops this field only and the rest of the tail stays valid.
 */
export function parseUserStateField(value: unknown): UserStateJudgment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = value as Record<string, unknown>;
  const state = field.state, confidence = field.confidence;
  if (typeof state !== 'string' || !(USER_STATES as readonly string[]).includes(state)) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < USER_STATE_MIN_CONFIDENCE || confidence > 1) return null;
  if (field.reason !== undefined && typeof field.reason !== 'string') return null;
  return { state: state as UserStateKind, confidence, reason: cleanUserStateReason(field.reason) };
}

/** "刚刚" / "约 20 分钟前" / "约 2 小时前". */
export function userStateAgo(ageMs: number): string {
  const minutes = Math.round(Math.max(0, ageMs) / MINUTE);
  if (minutes < 1) return '刚刚';
  return minutes < 90 ? `约${minutes}分钟前` : `约${Math.round(minutes / 60)}小时前`;
}

interface LineEntry { state: ActiveUserState; confidence: number; reason: string; at: number }

/** One private line for the next chat turns (principle 6: it shapes how she is, never what she says about the user). */
export function userStateChatLine(entry: LineEntry, now: number): string {
  const detail = [userStateAgo(now - entry.at), `把握${entry.confidence}`, ...(entry.reason ? [entry.reason] : [])].join('，');
  return `你对用户此刻状态的判断：${USER_STATE_LABELS[entry.state]}（${detail}）。按性格自然体现，别说出这个判断，别因此说教或劝用户找别人；以用户这轮的话为准。`;
}

/** The same judgment for the inner loop's decision input. */
export function userStateInnerLoopLine(entry: LineEntry, now: number): string {
  const detail = [userStateAgo(now - entry.at), ...(entry.reason ? [entry.reason] : [])].join('，');
  return `你对用户此刻状态的判断：${USER_STATE_LABELS[entry.state]}（${detail}）。只是参考，按你的性格自然对待，不必说出这个判断。`;
}

/**
 * Added to the per-turn tail instruction (electron/mood-chat.ts). Kept short: the first character
 * of a reply is sensitive to how much per-turn prompt there is (docs/claude/2026-11-02-R28-prompt-eval.md).
 * `unknown` is accepted by the parser but not advertised, so a model that is merely unsure omits the
 * field instead of wiping an earlier judgment.
 */
export const USER_STATE_INSTRUCTION =
  '可选第六字段user，用户明确透露状态时才写：{"state":"tired","confidence":0.8,"reason":"加班晚了"}，'
  + 'state限tired/annoyed/low(情绪低落)/happy/excited/calm(缓过来了)，别在正文提及。';
