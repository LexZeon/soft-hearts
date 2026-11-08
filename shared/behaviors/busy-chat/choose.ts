/**
 * I-039: after a busy stretch of chatting her own speech caps rise (speechIntervalMs shorter, speechPerHour larger), and fall back as the
 * messages age out. Pure functions; the numbers are in knobs.ts. Never touches speechWithoutReply. No floor, no ceiling.
 */
import type { MoodParameters } from '../../mood';
import { deriveDispositions } from '../reactions/dispositions';
import { BUSY_CHAT_KNOBS, type BusyChatKnobs } from './knobs';

const MINUTE = 60_000;

/** The user's message times still inside the window (past or now only). */
export function recentChatTimes(times: readonly number[], now: number, knobs: BusyChatKnobs = BUSY_CHAT_KNOBS): number[] {
  const from = now - knobs.windowMinutes * MINUTE;
  return times.filter(at => Number.isFinite(at) && at > from && at <= now);
}

/** 1 = the card's average; clingier cards boost more, restrained ones less (derived from the card, not the user's slider). */
export function busyChatScale(card: MoodParameters, knobs: BusyChatKnobs = BUSY_CHAT_KNOBS): number {
  const d = deriveDispositions(card);
  const raw = 1 + knobs.clingyWeight * (d.clingy - 50) / 50 - knobs.restrainedWeight * (d.restrained - 50) / 50;
  return Math.min(knobs.scaleRange[1], Math.max(knobs.scaleRange[0], raw));
}

export interface BusyChatInput { readonly card: MoodParameters; readonly chatTimes: readonly number[]; readonly now: number; readonly less?: boolean }

/** The card's frequency with the busy-chat boost; the very object when nothing changes. */
export function busyChatFrequency(input: BusyChatInput, knobs: BusyChatKnobs = BUSY_CHAT_KNOBS): MoodParameters['frequency'] {
  const base = input.card.frequency;
  if (input.less) return base;
  const count = recentChatTimes(input.chatTimes, input.now, knobs).length;
  const tier = count >= knobs.veryBusyAt ? { interval: knobs.veryBusyInterval, extra: knobs.veryBusyExtra }
    : count >= knobs.busyAt ? { interval: knobs.busyInterval, extra: knobs.busyExtra } : null;
  // A card that does not let her speak on her own (0 per hour) stays that way.
  if (!tier || base.speechPerHour <= 0) return base;
  const scale = busyChatScale(input.card, knobs);
  const interval = Math.min(base.speechIntervalMs, Math.round(base.speechIntervalMs * (1 - (1 - tier.interval) * scale)));
  const perHour = base.speechPerHour + Math.max(0, Math.round(tier.extra * scale));
  if (interval === base.speechIntervalMs && perHour === base.speechPerHour) return base;
  return { ...base, speechIntervalMs: interval, speechPerHour: perHour };
}
