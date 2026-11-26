/**
 * Unbound v1 step 3 (docs/claude/2026-11-17-unbound-step3.md): the two checks on what the microphone heard, in the order they run
 * (electron/voice/voice-chat-host.ts calls them through its `screen` and `wake` ports; electron/wiring/senses-voice-input-wiring.ts
 * gives them their ports).
 *
 * 1. screenClip, before a clip is recognized: while the user records their voiceprint sample the clip is taken for that (not for her
 *    chat); otherwise, with the voiceprint in use, a clip that is clearly someone else's voice is dropped before it ever becomes words.
 *    "Can't confirm" (too short, noisy, two voices mixed) and "unsure" count as the user (the face check's rule).
 * 2. wakeFilter, after a clip is recognized, only while she is out listening for her name (no call on): words that do not contain her
 *    real name or a name the user calls her are dropped unseen; with her name the call starts and the words become its first turn.
 *    Before that, nothing is sent to Claude, shown or kept. Only words as written (sound-alikes need a pinyin table; not downloaded).
 */
import { wavSamples } from '../asr/features';
import { counted, type VoiceCheck } from '../../../shared/senses/voiceprint';
import { nameHeard } from '../../../shared/memory';
import { namePlace } from './name-call';
import type { MediaOwner } from '../../../shared/foundation/runtime-state';

export interface ScreenHost {
  readonly enrolling: boolean;
  take(samples: Float32Array): Promise<boolean>;
  check(samples: Float32Array): Promise<{ check: VoiceCheck } | null>;
}

export async function screenClip(host: ScreenHost | null, wav: ArrayBuffer): Promise<'pass' | 'drop' | 'taken'> {
  if (!host) return 'pass';
  let samples: Float32Array;
  try { samples = wavSamples(wav); } catch { return 'pass'; } // not a clip the recognizer could use either: as before
  if (host.enrolling) return await host.take(samples) ? 'taken' : 'pass';
  const result = await host.check(samples);
  return result && !counted(result.check) ? 'drop' : 'pass';
}

export interface WakePorts {
  /** A call is on (then nothing here applies). */
  callOn(): boolean;
  /**
   * This window listens for her name now: she is out in Unbound, the microphone the user turned on is this window's, the voiceprint
   * is in use (the user's choice: her name AND your voice), recognition runs on this computer, and she is awake.
   */
  listening(owner: MediaOwner): boolean;
  /** Her real name and the names the user calls her (shared/memory/nickname-table.ts wakeNames). */
  names(): readonly string[];
  /** Starts the call in this window; false when it could not start (then the words are dropped too). */
  startCall(owner: MediaOwner): Promise<boolean>;
  /**
   * Unbound step 4 (afternoon addition A): your voice (the voiceprint passed it), no name, no call: you are talking, not to her. Told
   * the fact only; the words never go with it (they are dropped right here, as before).
   */
  talkedNotToHer?(): void;
  /**
   * Afternoon addition D: the camera's pose sensing is sure you face the screen now (its facing band 'sure'). Absent: not sure.
   */
  facingSure?(): boolean;
  /**
   * Afternoon addition D: her name in the middle of a sentence while not surely facing her: haiku says whether the sentence calls her
   * (only that one sentence is sent). Absent: such a sentence does not count (as before step 4: only the name counted, anywhere).
   */
  askCalling?(name: string, sentence: string): Promise<boolean>;
}

/** What listening for her name depends on (read when asked; electron/wiring/senses-voiceprint-wiring.ts fills it in). */
export interface ListeningState {
  /** She is out (Unbound entering or out; her companion window hides then). */
  out: boolean;
  /** The microphone the user turned on, and whose window it is. */
  voiceInput: boolean;
  voiceOwner: MediaOwner | null | undefined;
  /** The voiceprint is in use (switch on, enrolled, model there). */
  voiceprintActive: boolean;
  /** Recognition runs on this computer. */
  localRecognition: boolean;
  asleep: boolean;
}

/**
 * The microphone stays open for her name only when ALL of these hold (user's 定稿 2026-11-15: in Unbound, her name AND your voice;
 * docs/claude/2026-11-14-unbound-v1-scope.md). Pure, so each condition has a test that fails when it is dropped.
 */
export function listensForName(state: ListeningState, owner: MediaOwner): boolean {
  return state.out && state.voiceInput === true && state.voiceOwner === owner && state.voiceprintActive && state.localRecognition && !state.asleep;
}

/** True: the words go on (no listening for her name now, or her name was said and the call started). False: dropped unseen. */
export async function wakeFilter(ports: WakePorts, owner: MediaOwner, text: string): Promise<boolean> {
  if (ports.callOn() || !ports.listening(owner)) return true;
  if (typeof text !== 'string' || !text.trim()) return false;
  const name = nameHeard(text, ports.names());
  if (!name) { try { ports.talkedNotToHer?.(); } catch { /* a notice only */ } return false; }
  if (!(await callsHer(ports, text, name))) { try { ports.talkedNotToHer?.(); } catch { /* a notice only */ } return false; }
  return ports.startCall(owner).catch(() => false);
}

/**
 * Afternoon addition D: the name alone or at a clause's start is a call; in the middle it is a call when the camera is sure you face her,
 * else haiku decides from that one sentence (no haiku port: it counts, as it did before step 4).
 */
export async function callsHer(ports: Pick<WakePorts, 'facingSure' | 'askCalling'>, text: string, name: string): Promise<boolean> {
  const where = namePlace(text, name);
  if (!where || where.place !== 'middle') return true;
  try { if (ports.facingSure?.() === true) return true; } catch { /* not sure */ }
  if (!ports.askCalling) return true;
  try { return await ports.askCalling(name, where.sentence) === true; } catch { return false; }
}
