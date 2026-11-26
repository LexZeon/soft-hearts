/**
 * 在场 (P1 第二阶段, docs/claude/2026-11-03-pose-sensing-stage2.md): the user came back in front of the computer (local camera
 * sensing saw it). A light thing for her mood: a little less bored. It is deliberately NOT an interaction and not a mood event:
 * no interaction clock (lastInteractionAt, so "读懂你的情绪", her own life's "away" time and 熟悉度 do not see it), no freshness
 * dose, no reply cue, no trend sample and no reason line. Boredom keeps rising the usual way afterwards (she is not being played
 * with), and when the user leaves nothing changes at all.
 */
import { advanceMood, type MoodParameters, type MoodState } from './mood';

const MAX_IDS = 256;

export function applyMoodPresence(state: MoodState, presence: { id: string; relief: number }, now: number, p: MoodParameters): MoodState {
  if (!presence || typeof presence.id !== 'string' || !presence.id.trim() || presence.id.length > 160) throw new Error('Invalid presence id');
  if (typeof presence.relief !== 'number' || !Number.isFinite(presence.relief) || presence.relief < 0 || presence.relief > 30) throw new Error('Invalid presence relief');
  const next = advanceMood(state, now, { online: true }, p);
  if (next.recentEventIds.includes(presence.id)) return next;
  next.recentEventIds = [...next.recentEventIds, presence.id].slice(-MAX_IDS);
  next.boredom = Math.max(0, Math.min(100, next.boredom - presence.relief));
  return next;
}
