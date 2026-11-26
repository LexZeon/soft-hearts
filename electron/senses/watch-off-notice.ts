// turned itself off (evening: "和她一看会自己关").
// Whenever 一起看 goes from on (the screen shared and words of the computer's sound on) to off, ONE journal row says why, as a closed word
// (shared/senses/journal-entries.ts WATCH_OFF_WHYS). The places that end it note their cause first (noteWatchOffCause); the detector sees the
// change on the host's one-second tick and picks the cause up. Nothing noted within the window means 'other': a way off nobody named, which is
// exactly what the row is there to show. The user's own off always wins over any other note made in the same moments.
//
// The notes live in memory for a few seconds and carry no text. Pure: the clock is injected.
import type { WatchOffWhy } from '../../shared/senses';

/** A cause noted more than this long ago is not the cause of a change seen now (the detector looks every second; this only bounds a stale note). */
export const WATCH_OFF_CAUSE_MS = 10_000;

let noted: { why: WatchOffWhy; at: number } | null = null;

const userOffListeners = new Set<() => void>();
/**
 * 2026-11-24 (续): something that waits on 一起看 staying as the user left it (her window minimized, then back) hears every one of the user's own
 * offs here, whether the screen's or the dialogue's, so it never starts again what the user turned off. Returns the way to stop listening.
 */
export function onWatchUserOff(listener: () => void): () => void {
  userOffListeners.add(listener);
  return () => { userOffListeners.delete(listener); };
}

// 2026-11-24 (再续, docs/claude/2026-11-24-watch-turns-off.md): a switch the HOST turns off on its own account (Unbound's way back putting the
// switches as they were) goes through the very paths the user's click uses, and used to be written down as the user's. While such a step runs, a
// 'user' note is taken as the step's own word and the user-off listeners are not told (the user did not turn anything off).
const notUsers: WatchOffWhy[] = [];
export async function asNotUsers<T>(why: WatchOffWhy, run: () => Promise<T>): Promise<T> {
  notUsers.push(why);
  try { return await run(); } finally { notUsers.splice(notUsers.lastIndexOf(why), 1); }
}

/** The switches with every OFF made through them taken as not the user's (Unbound's way back, which only puts the switches as they were). */
export function offAsNotUsers<S extends { set: (...args: any[]) => Promise<void> }>(switches: S | null, why: WatchOffWhy): S | null {
  if (!switches) return null;
  return { ...switches, set: (kind: unknown, enabled: unknown, ...rest: unknown[]) => enabled === true ? switches.set(kind, enabled, ...rest) : asNotUsers(why, () => switches.set(kind, enabled, ...rest)) };
}

/**
 * The cause an audio-reading intent to switch OFF stands for, or null when it says nothing about 一起看. Only the computer's sound matters here
 * (the microphone's cells never end 一起看). With the companion window not on the screen the off is the window's own step (her page stopping its
 * capture because the window left), not a hand: that is 'window-hidden'. Only an off while she is on the screen is the user's.
 */
export function offCauseOfIntent(intent: { enabled: boolean; source: string }, companionOnScreen: boolean): WatchOffWhy | null {
  if (intent.enabled || intent.source !== 'system-audio') return null;
  return companionOnScreen ? 'user' : 'window-hidden';
}

/** Names why 一起看 is about to end. The first note of a moment stands, except that the user's own off replaces any other. */
export function noteWatchOffCause(why: WatchOffWhy, now: number = Date.now()): void {
  if (why === 'user' && notUsers.length) {
    if (!(noted && now - noted.at < WATCH_OFF_CAUSE_MS)) noted = { why: notUsers[notUsers.length - 1]!, at: now };
    return;
  }
  if (why === 'user') for (const listener of [...userOffListeners]) { try { listener(); } catch { /* a listener never changes what the user's off does */ } }
  if (noted && now - noted.at < WATCH_OFF_CAUSE_MS && why !== 'user') return;
  noted = { why, at: now };
}

const changeListeners = new Set<(change: { kind: 'began' } | { kind: 'ended'; why: WatchOffWhy }) => void>();
/**
 * 2026-11-24 (Unbound, 一起看 kept after full screen): whoever must tell the user's hand from its own steps hears every on-to-off change with
 * its cause ('user' only for the user's hand) and every off-to-on change, from the detector's tick. Returns the way to stop listening.
 */
export function onWatchChange(listener: (change: { kind: 'began' } | { kind: 'ended'; why: WatchOffWhy }) => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}
function tell(change: { kind: 'began' } | { kind: 'ended'; why: WatchOffWhy }): void {
  for (const listener of [...changeListeners]) { try { listener(change); } catch { /* a listener never changes what she does */ } }
}

/** Forgets the notes (tests). */
export function clearWatchOffCause(): void { noted = null; }

function takeCause(now: number): WatchOffWhy {
  const found = noted && now - noted.at < WATCH_OFF_CAUSE_MS ? noted.why : 'other';
  noted = null;
  return found;
}

export interface WatchOffPorts {
  /** 一起看 is on right now (screen shared and words of the computer's sound on). */
  on(): boolean;
  /** One call per on-to-off change, with the cause and how long it had been on (ms, from the tick that first saw it on). */
  ended(why: WatchOffWhy, lastedMs?: number): void;
  /** One call per off-to-on change. */
  began?(): void;
  now?(): number;
}

export class WatchOffDetector {
  private was = false;
  private since = 0;
  constructor(private readonly ports: WatchOffPorts) {}
  /** Called every second. */
  tick(): void {
    const now = this.ports.now?.() ?? Date.now();
    const on = this.ports.on();
    if (this.was && !on) { const why = takeCause(now); try { this.ports.ended(why, Math.max(0, now - this.since)); } catch { /* the journal never changes what she does */ } tell({ kind: 'ended', why }); }
    if (!this.was && on) { this.since = now; try { this.ports.began?.(); } catch { /* the same */ } tell({ kind: 'began' }); }
    this.was = on;
  }
}
