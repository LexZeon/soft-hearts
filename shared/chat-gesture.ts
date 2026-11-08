import type { MoodContext, MoodSnapshot, MoodValues } from './mood';

/** A reply may suggest a performance, never a file, permission or mood reward. */
export type ChatGestureIntent = 'none' | 'explain' | 'upbeat' | 'consider';
export type ActiveChatGestureIntent = Exclude<ChatGestureIntent, 'none'>;
export interface ChatGestureAppraisal {
  gesture?: ChatGestureIntent;
  context: MoodContext;
  delta: Partial<MoodValues>;
  reason: string;
}
export interface ChatGestureSelection { intent: ActiveChatGestureIntent; strength: number; reason: string }
export interface ChatGestureCue extends ChatGestureSelection { id: string; at: number; expiresAt: number }
export interface ChatGestureResource {
  cueId: string;
  intent: ActiveChatGestureIntent;
  packId: 'genea-2022-gestures' | 'mpi-embm-gestures';
  motionId: 'speaking-gesture-2' | 'conversation-joy';
  url: string;
  sha256: string;
  durationMs: number;
}

export function isChatGestureIntent(value: unknown): value is ChatGestureIntent {
  return value === 'none' || value === 'explain' || value === 'upbeat' || value === 'consider';
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const safe = (value: number) => Number.isFinite(value) ? value : 0;

/** Deterministic selection from an accepted reply and host state; no clocks or mutations. */
export function selectChatGesture(appraisal: ChatGestureAppraisal | null, snapshot: MoodSnapshot): ChatGestureSelection | null {
  if (!appraisal || !isChatGestureIntent(appraisal.gesture) || appraisal.gesture === 'none'
    || snapshot.phase !== 'idle' || !Number.isFinite(snapshot.intensity.posture) || snapshot.intensity.posture <= 0) return null;
  let intent: ActiveChatGestureIntent = appraisal.gesture;
  const seriousContext = [appraisal.context, snapshot.context].some(value => ['concern', 'disappointment', 'offense'].includes(value));
  const seriousFeeling = ['concerned', 'disappointed', 'upset', 'sad', 'tense-expectation'].includes(snapshot.primary);
  const pressure = clamp((safe(snapshot.values.C) - 50) / 50, 0, 1);
  const cautious = clamp(safe(snapshot.tendencies.cautious) / 10, 0, 1);
  const serious = seriousContext || seriousFeeling || pressure >= 0.6;
  if (intent === 'upbeat' && serious) {
    // An offended role should not perform a celebratory or automatic reassuring gesture.
    if (appraisal.context === 'offense' || snapshot.context === 'offense') return null;
    intent = 'consider';
  }
  const mixed = snapshot.companion === 'cautious' || snapshot.companion === 'wistful' ? -0.07
    : snapshot.companion === 'close' || snapshot.companion === 'comfortable' ? 0.02 : 0;
  const positiveTrend = clamp((safe(snapshot.trend.D) + safe(snapshot.trend.E)) / 24, -1, 1);
  const stressTrend = clamp(safe(snapshot.trend.C) / 12, -1, 1);
  const playful = clamp(safe(snapshot.tendencies.playful) / 10, 0, 1);
  const base = intent === 'consider' ? 0.30 : intent === 'explain' ? 0.46 : 0.58;
  const emphasis = intent === 'upbeat' ? positiveTrend * 0.07 + playful * 0.06
    : intent === 'consider' ? Math.max(0, stressTrend) * 0.025 : positiveTrend * 0.035;
  const restraint = pressure * 0.07 + cautious * 0.06 + (serious && intent === 'explain' ? 0.05 : 0);
  const strength = clamp((base + mixed + emphasis - restraint) * clamp(snapshot.intensity.posture, 0, 100) / 50, 0, 0.7);
  if (strength <= 0) return null;
  return { intent, strength, reason: intent !== appraisal.gesture ? '认真情境下改为克制思考手势'
    : intent === 'consider' ? '结合当前感受与趋势，克制回应'
      : intent === 'explain' ? '结合当前感受与趋势，说明回应' : '结合积极情境与角色强度，轻快回应' };
}
