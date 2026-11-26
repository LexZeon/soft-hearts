// Renderer wiring, I-189 #1 and #2 (docs/claude/2026-11-22-i189-pose-uses.md): the host's attention reading in this window
// (src/senses/user-attention.ts), her reading's pause while you are turned away or gone (src/voice/away-read-pause.ts) and the call's
// question "is the user's face turned from the screen" (MediaInput's overHerHeld). Both windows make these the first time they are asked;
// the companion window feeds the store from its userGaze poll and tells the control window over a channel. Nothing runs on import.
import { UserAttentionStore } from '../senses';
import { AwayReadPause, SharedPause, type PausableSpeech } from '../voice';
import { isPet } from './shell-wiring'; // no-pet-ok: the existing name of the companion window flag

let store: UserAttentionStore | null = null;
let channel: BroadcastChannel | null = null;
let pollWanted: () => boolean = () => false;
let lastHeldNote = -Infinity;
/** This window's away pause (null until startAwayReadPause ran). */
export let awayReadPause: AwayReadPause | null = null;

const fact = (value: Record<string, unknown>) => { try { void window.desktop.noteJournalFact('pose-use', value).catch(() => {}); } catch { /* journal only */ } };

/** This window's attention store (made on first use, with the channel between the two windows). */
export function userAttention(): UserAttentionStore {
  if (store) return store;
  try { channel = new BroadcastChannel('soft-hearts-user-attention'); } catch { channel = null; }
  const made = new UserAttentionStore(() => performance.now(), message => channel?.postMessage(message));
  if (channel) channel.onmessage = event => { if (!isPet) made.receive(event.data); }; // no-pet-ok: only the control window listens; the companion window polls
  store = made;
  return made;
}

/** The companion window's userGaze answer, every poll (src/wiring/stage-wiring.ts). */
export function noteUserGaze(reading: unknown): void { userAttention().fromGaze(reading); }

/** The companion window keeps polling while it is hidden when her voice or a call needs the reading (the voice wiring says when). */
export function wantAttentionPoll(wanted: () => boolean): void { pollWanted = wanted; }
export function attentionPollWanted(): boolean {
  if (awayReadPause?.active) return true;
  try { return pollWanted() === true; } catch { return false; }
}

/**
 * The voice wiring calls this once with the targets feeding also pauses (her voice, the reply's reveal, her bubble). Returns the shared
 * pause; feeding takes its own handle from it (`as('feed')`), so neither owner's resume talks over the other's pause.
 */
export function startAwayReadPause(parts: { targets: readonly PausableSpeech[]; reading(): string | null; end(replyId: string): void }): SharedPause {
  const shared = new SharedPause(parts.targets);
  awayReadPause = new AwayReadPause({
    pause: shared.as('away'), attention: () => userAttention().current(), reading: () => parts.reading(), end: id => parts.end(id),
    now: () => performance.now(), timers: { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    fact: (event, seconds) => fact({ use: 'read-pause', event, ...(seconds !== undefined ? { seconds } : {}) }),
  });
  userAttention().onChange(() => awayReadPause?.check());
  return shared;
}

/**
 * #2, asked by MediaInput only when a barge-in would fire in a call: the user's face is turned from the screen (sure, held a moment), so
 * what they say is not talking over her. One journal line at most every 20 s.
 */
export function overHerHeld(): boolean {
  const held = userAttention().turned();
  const now = performance.now();
  if (held && now - lastHeldNote >= 20_000) { lastHeldNote = now; fact({ use: 'barge-hold', event: 'held' }); }
  return held;
}
