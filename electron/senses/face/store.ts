/**
 * I-135: where the user's face embeddings live. One file in the profile directory:
 *
 *   face-check.json  { "version": 1, "enabled": boolean, "faces"?: "<base64 of safeStorage-encrypted JSON>" }
 *
 * Only numbers, never a picture; encrypted with the system's secure storage (Electron `safeStorage`, like the API keys in
 * electron/settings/settings.ts). When encryption is not available nothing is enrolled (no plain-text fallback). `deleteAll` removes
 * the file. The switch itself is saved in the same file in the clear (it says nothing about a face).
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import type { SecretStorage } from '../../settings';
import type { EnrolledFace } from './enrolment';
import { EMBEDDING_SIZE } from './score';

export const FACE_DATA_FILE = 'face-check.json';
const MAX_FACES = 64;

export interface FaceData { enabled: boolean; faces: EnrolledFace[] }

export class FaceEncryptionUnavailable extends Error {
  constructor() { super('secure storage is not available'); this.name = 'FaceEncryptionUnavailable'; }
}

function packFaces(faces: readonly EnrolledFace[]): string {
  return JSON.stringify(faces.map(face => ({ v: Buffer.from(face.vector.buffer, face.vector.byteOffset, face.vector.byteLength).toString('base64'), s: face.source, t: Math.round(face.at) })));
}

function unpackFaces(text: string): EnrolledFace[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) return [];
  const faces: EnrolledFace[] = [];
  for (const item of raw.slice(0, MAX_FACES)) {
    if (!item || typeof item !== 'object') continue;
    const { v, s, t } = item as Record<string, unknown>;
    if (typeof v !== 'string' || (s !== 'enrol' && s !== 'auto') || typeof t !== 'number' || !Number.isFinite(t)) continue;
    const bytes = Buffer.from(v, 'base64');
    if (bytes.byteLength !== EMBEDDING_SIZE * 4) continue;
    const vector = new Float32Array(EMBEDDING_SIZE);
    new Uint8Array(vector.buffer).set(bytes);
    if (!vector.every(Number.isFinite)) continue;
    faces.push({ vector, source: s, at: t });
  }
  return faces;
}

export class FaceDataStore {
  readonly file: string;
  constructor(directory: string, private readonly secret: SecretStorage, private readonly write: AtomicFileWriter = atomicWriteFile) {
    this.file = path.join(directory, FACE_DATA_FILE);
  }

  get encryptionAvailable(): boolean {
    try { return this.secret.isEncryptionAvailable(); } catch { return false; }
  }

  /** Missing, unreadable or undecryptable data reads as "off, nothing enrolled" (never throws). */
  async load(): Promise<FaceData> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.file, 'utf8')); } catch { return { enabled: false, faces: [] }; }
    if (!raw || typeof raw !== 'object') return { enabled: false, faces: [] };
    const record = raw as Record<string, unknown>;
    const enabled = record.version === 1 && record.enabled === true;
    let faces: EnrolledFace[] = [];
    if (typeof record.faces === 'string' && this.encryptionAvailable) {
      try { faces = unpackFaces(this.secret.decryptString(Buffer.from(record.faces, 'base64'))); } catch { faces = []; }
    }
    return { enabled, faces };
  }

  /** Throws FaceEncryptionUnavailable when there are faces to save and no secure storage. */
  async save(data: FaceData): Promise<void> {
    const record: Record<string, unknown> = { version: 1, enabled: data.enabled };
    if (data.faces.length) {
      if (!this.encryptionAvailable) throw new FaceEncryptionUnavailable();
      record.faces = this.secret.encryptString(packFaces(data.faces.slice(0, MAX_FACES))).toString('base64');
    }
    await this.write(this.file, JSON.stringify(record) + '\n');
  }

  /** One-click delete: the whole file goes (switch off, nothing enrolled). */
  async deleteAll(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
