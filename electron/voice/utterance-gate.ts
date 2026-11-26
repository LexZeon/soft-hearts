/**
 * The host side of "who may cut her off" (I-204, three recognized characters interrupt her, her own echo is judged by
 * how well it matches what she is reading; the decision itself is shared/behaviors/interrupt/judge.ts). VoiceChatHost runs every
 * recognized clip through `gateClip` before the words go anywhere:
 *   - held (under three characters or her own echo while she speaks; a short/quiet filler-only clip in continuous listening):
 *     the clip becomes '' — never a turn, never shown, kept or sent, no "在听但不出字" note — and the journal counts it (numbers, no words);
 *   - interrupts (three or more recognized characters while she speaks, not her echo): the call learns she was talked over (its count,
 *     the plan stopped, the cut point and the user's line for her next turn) before the words are delivered; delivering them stops her
 *     reading as before.
 * Sound alone never reaches here: the microphone's speech start no longer stops her (electron/voice/voice-conversation-session.ts).
 * Electron-free; a failing port never changes the verdict.
 */
import { INTERRUPT_KNOBS, type InterruptKnobs } from '../../shared/behaviors/interrupt/knobs';
import { clipLevels, judgeUtterance, type ClipLevels, type GateNumbers, type GateVerdict, type HeldKind, type InterruptBy } from '../../shared/behaviors/interrupt/judge';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { wavSamples } from '../senses';

export interface UtteranceGatePorts {
  /** Her voice is sounding now (a window's mouth is open, or the host is reading aloud). Absent or failing: not speaking. */
  herVoice?(): boolean;
  /** What she is reading now or just read, for the echo check ('' when unknown). */
  herText?(): string;
  /** This window listens continuously (a call, or listening for her name), where noise can come back as "嗯". */
  continuous?(owner: MediaOwner): boolean;
  /** A clip was held (journal: a count with its numbers, never the words). */
  held?(kind: HeldKind, overHer: boolean, owner: MediaOwner, numbers?: GateNumbers): void;
  /** A clip interrupts her: tell the call before its words are delivered (`heard.text` is the user's line, for her next turn only). */
  interrupted?(owner: MediaOwner, by: InterruptBy, overHer: boolean, heard?: HeardLine): void;
  knobs?: InterruptKnobs;
}

/** The line that cut her and its numbers (I-204): the words go to her next turn's private note only, the numbers to the journal. */
export interface HeardLine extends GateNumbers { text: string }

/**
 * Her voice is sounding now, for the wiring: a window says its mouth is open (setAmbientAudioSpeaking), or the host's reading runtime is
 * synthesizing or still draining a segment. Only then is there anything to interrupt.
 */
export function herVoiceFrom(speakingWindows: { readonly size: number }, runtime: { readonly busy: boolean }, call: { reading(): boolean }): boolean {
  // The call's own sentence-by-sentence reading counts (the 16:55 cuts): without it a "嗯" in a call reading was a turn and cancelled her.
  let calling = false;
  try { calling = call.reading() === true; } catch { calling = false; }
  return speakingWindows.size > 0 || runtime.busy || calling;
}

const ask = <T>(read: (() => T) | undefined, fallback: T): T => { try { return read ? read() : fallback; } catch { return fallback; } };

/** The clip's levels (16 kHz PCM16 WAV), or null when it cannot be read. */
export function wavLevels(wav: ArrayBuffer, knobs: InterruptKnobs = INTERRUPT_KNOBS): ClipLevels | null {
  try { return clipLevels(wavSamples(wav), 16_000, knobs); } catch { return null; }
}

/** The verdict for one recognized clip, with its journal note or call notice already given. */
export function gateClip(ports: UtteranceGatePorts, owner: MediaOwner, text: string, wav: ArrayBuffer): GateVerdict {
  const knobs = ports.knobs ?? INTERRUPT_KNOBS;
  const overHer = ask(ports.herVoice, false) === true;
  const verdict = judgeUtterance({ text, levels: wavLevels(wav, knobs), overHer, continuous: ask(() => ports.continuous?.(owner) === true, false),
    herText: overHer ? ask(ports.herText, '') : '' }, knobs);
  const numbers: GateNumbers = { chars: verdict.chars, match: verdict.match };
  if (!verdict.pass) { try { ports.held?.(verdict.held, overHer, owner, numbers); } catch { /* a count only */ } }
  else if (verdict.interrupt) { try { ports.interrupted?.(owner, verdict.interrupt, overHer, { ...numbers, text }); } catch { /* delivering the words still stops her */ } }
  return verdict;
}
