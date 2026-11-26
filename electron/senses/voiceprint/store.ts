/**
 * Unbound v1 step 3: where the user's voiceprint lives. One file in the profile directory:
 *
 *   voiceprint.json  { "version": 1, "enabled": boolean, "print"?: "<base64 of safeStorage-encrypted JSON>" }
 *
 * Only numbers (the mean of the user's own clips and two cut-offs from them), never a recording; encrypted with the system's secure
 * storage (Electron `safeStorage`, like the face check and the API keys). Without encryption nothing is enrolled (no plain-text
 * fallback). `deleteAll` removes the file. The switch itself is in the clear (it says nothing about a voice).
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import type { SecretStorage } from '../../settings';
import type { VoiceCalibration } from '../../../shared/senses/voiceprint';
import { VOICEPRINT_MODEL_SHAPE } from './manifest';

export const VOICEPRINT_DATA_FILE = 'voiceprint.json';

export interface Voiceprint { centroid: Float32Array; calibration: VoiceCalibration; clips: number; seconds: number; at: number }
export interface VoiceprintData { enabled: boolean; print: Voiceprint | null }

export class VoiceprintEncryptionUnavailable extends Error {
  constructor() { super('secure storage is not available'); this.name = 'VoiceprintEncryptionUnavailable'; }
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function pack(print: Voiceprint): string {
  const v = Buffer.from(print.centroid.buffer, print.centroid.byteOffset, print.centroid.byteLength).toString('base64');
  return JSON.stringify({ v, r: print.calibration.reject, a: print.calibration.accept, c: print.clips, s: print.seconds, t: Math.round(print.at) });
}

function unpack(text: string): Voiceprint | null {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || typeof raw.v !== 'string' || !finite(raw.r) || !finite(raw.a) || !finite(raw.c) || !finite(raw.s) || !finite(raw.t)) return null;
  const bytes = Buffer.from(raw.v, 'base64');
  if (bytes.byteLength !== VOICEPRINT_MODEL_SHAPE.embedding * 4) return null;
  const centroid = new Float32Array(VOICEPRINT_MODEL_SHAPE.embedding);
  new Uint8Array(centroid.buffer).set(bytes);
  if (!centroid.every(Number.isFinite)) return null;
  return { centroid, calibration: { reject: raw.r, accept: raw.a }, clips: raw.c, seconds: raw.s, at: raw.t };
}

export class VoiceprintDataStore {
  readonly file: string;
  constructor(directory: string, private readonly secret: SecretStorage, private readonly write: AtomicFileWriter = atomicWriteFile) {
    this.file = path.join(directory, VOICEPRINT_DATA_FILE);
  }

  get encryptionAvailable(): boolean { try { return this.secret.isEncryptionAvailable(); } catch { return false; } }

  /** Missing, unreadable or undecryptable data reads as "off, nothing enrolled" (never throws). */
  async load(): Promise<VoiceprintData> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.file, 'utf8')); } catch { return { enabled: false, print: null }; }
    if (!raw || typeof raw !== 'object') return { enabled: false, print: null };
    const record = raw as Record<string, unknown>;
    const enabled = record.version === 1 && record.enabled === true;
    let print: Voiceprint | null = null;
    if (typeof record.print === 'string' && this.encryptionAvailable) {
      try { print = unpack(this.secret.decryptString(Buffer.from(record.print, 'base64'))); } catch { print = null; }
    }
    return { enabled, print };
  }

  /** Throws VoiceprintEncryptionUnavailable when there is a print to save and no secure storage. */
  async save(data: VoiceprintData): Promise<void> {
    const record: Record<string, unknown> = { version: 1, enabled: data.enabled };
    if (data.print) {
      if (!this.encryptionAvailable) throw new VoiceprintEncryptionUnavailable();
      record.print = this.secret.encryptString(pack(data.print)).toString('base64');
    }
    await this.write(this.file, JSON.stringify(record) + '\n');
  }

  /** One-click delete (and 「允许记录」 off): the whole file goes (switch off, nothing enrolled). */
  async deleteAll(): Promise<void> { await rm(this.file, { force: true }); }
}
