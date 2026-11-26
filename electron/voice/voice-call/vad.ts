/**
 * I-099: the host side of the call's voice activity detection.
 *
 * The call's window resamples its microphone chunks to 16 kHz and asks here (IPC `voiceCallVad`); this checks that the
 * asker is the call's own window, that the call is on and that this window owns the consented microphone, then passes the
 * chunk to the Silero VAD in the local recognizer's process (electron/senses/asr/host.ts `vad`) and returns only the window
 * probabilities. Outside a call, from another window, or without the local recognizer, the answer is null and the window
 * goes by loudness as before. Nothing is stored and nothing leaves this computer.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import silero from '../../../shared/voice/silero-vad.json';
import smartTurn from '../../../shared/voice/smart-turn.json';
import { checkedPcm, checkedTurnPcm } from '../../senses/asr/protocol';
import type { VoiceCallOwner } from '../../../shared/voice/voice-call';

export interface CallVadPorts {
  /** The call's window while a call is on, otherwise null. */
  callOwner(): VoiceCallOwner | null;
  /** The window that owns the microphone while voice input is on, otherwise null. */
  microphoneOwner(): string | null | undefined;
  /** The local recognizer when it may run the VAD (the 识别方式 is local and its component is ready), otherwise null. */
  engine(): { vad(pcm: Float32Array, reset: boolean): Promise<number[] | null>; turn?(pcm: Float32Array): Promise<number | null> } | null;
}

export class CallVadBridge {
  constructor(private readonly ports: CallVadPorts) {}

  /** One chunk from `owner`'s window → its window probabilities, or null (go by loudness). Never throws. */
  async probe(owner: VoiceCallOwner, pcm: unknown, reset: unknown): Promise<number[] | null> {
    try {
      if (this.ports.callOwner() !== owner || this.ports.microphoneOwner() !== owner) return null;
      const samples = checkedPcm(pcm);
      const engine = samples ? this.ports.engine() : null;
      if (!samples || !engine) return null;
      const probs = await engine.vad(samples, reset === true);
      // The call may have ended or moved while the chunk was being heard: then nothing goes back.
      return probs && this.ports.callOwner() === owner ? probs : null;
    } catch { return null; }
  }

  /**
   * I-099/I-100: the last seconds of the user's turn (16 kHz, at most 8 s) from `owner`'s window → Smart Turn's probability that
   * the turn is complete, or null (go by silence). Same gate as the VAD: the call's own window, the call on, the microphone
   * consented and owned by it, the local recognizer. A call that ended meanwhile gets nothing. Never throws.
   */
  async probeTurn(owner: VoiceCallOwner, pcm: unknown): Promise<number | null> {
    try {
      if (this.ports.callOwner() !== owner || this.ports.microphoneOwner() !== owner) return null;
      const samples = checkedTurnPcm(pcm);
      const engine = samples ? this.ports.engine() : null;
      if (!samples || !engine?.turn) return null;
      const p = await engine.turn(samples);
      return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 && this.ports.callOwner() === owner ? p : null;
    } catch { return null; }
  }
}

/** The bundled model's place under assets/bundled (shared/voice/silero-vad.json). */
export const SILERO_VAD_RELATIVE = silero.model.relativePath;

/**
 * Reads the bundled Silero VAD and checks its size and SHA-256 against shared/voice/silero-vad.json; null when it is missing or
 * changed (the call then goes by loudness). `read` is the Electron main process's fs (it reads inside app.asar).
 */
export function loadSileroModel(file: string, read: (file: string) => Uint8Array = readFileSync): { bytes: Uint8Array; sha256: string } | null {
  try {
    const bytes = read(file);
    if (bytes.byteLength !== silero.model.bytes) return null;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return sha256 === silero.model.sha256 ? { bytes: new Uint8Array(bytes), sha256 } : null;
  } catch { return null; }
}

/** I-099/I-100: the bundled Smart Turn's place under assets/bundled (shared/voice/smart-turn.json). */
export const SMART_TURN_RELATIVE = smartTurn.model.relativePath;

/** Smart Turn's bytes, checked the same way (size and SHA-256 against shared/voice/smart-turn.json); null: the call goes by silence. */
export function loadSmartTurnModel(file: string, read: (file: string) => Uint8Array = readFileSync): { bytes: Uint8Array; sha256: string } | null {
  try {
    const bytes = read(file);
    if (bytes.byteLength !== smartTurn.model.bytes) return null;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return sha256 === smartTurn.model.sha256 ? { bytes: new Uint8Array(bytes), sha256 } : null;
  } catch { return null; }
}
