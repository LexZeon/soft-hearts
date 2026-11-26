/**
 * Reads `metadata_props` (ModelProto field 14: key/value strings) from an ONNX file without loading it: the top-level
 * protobuf fields are walked with small positional reads and the graph (hundreds of MB) is skipped by its length.
 * SenseVoice keeps its CMVN, LFR sizes and language/ITN ids there (sherpa-onnx export). tests/local-asr-onnx-metadata.test.ts.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface ByteSource { size: number; read(position: number, length: number): Uint8Array }

const MAX_ENTRY = 1 << 20; // a metadata entry (CMVN: 560 floats as text) is far below 1 MiB

function varint(source: ByteSource, position: number): { value: number; next: number } {
  const bytes = source.read(position, Math.min(10, source.size - position));
  let value = 0, scale = 1;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    value += (byte & 0x7f) * scale;
    if (!(byte & 0x80)) { if (!Number.isSafeInteger(value)) break; return { value, next: position + index + 1 }; }
    scale *= 128;
  }
  throw new Error('bad protobuf varint');
}

function entry(bytes: Uint8Array): [string, string] | null {
  const source: ByteSource = { size: bytes.length, read: (p, l) => bytes.subarray(p, p + l) };
  let key: string | null = null, value: string | null = null, at = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (at < bytes.length) {
    const tag = varint(source, at); at = tag.next;
    const field = Math.floor(tag.value / 8), wire = tag.value % 8;
    if (wire !== 2) return null;
    const length = varint(source, at); at = length.next;
    if (at + length.value > bytes.length) return null;
    const text = decoder.decode(bytes.subarray(at, at + length.value)); at += length.value;
    if (field === 1) key = text; else if (field === 2) value = text;
  }
  return key === null ? null : [key, value ?? ''];
}

/** All metadata_props of a ModelProto. Throws when the bytes are not a well-formed top-level message. */
export function readOnnxMetadata(source: ByteSource): Map<string, string> {
  const result = new Map<string, string>();
  let at = 0;
  while (at < source.size) {
    const tag = varint(source, at); at = tag.next;
    const field = Math.floor(tag.value / 8), wire = tag.value % 8;
    if (wire === 0) at = varint(source, at).next;
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      const length = varint(source, at); at = length.next;
      if (at + length.value > source.size) throw new Error('truncated protobuf field');
      if (field === 14) {
        if (length.value > MAX_ENTRY) throw new Error('metadata entry too large');
        const pair = entry(source.read(at, length.value));
        if (pair) result.set(pair[0], pair[1]);
      }
      at += length.value;
    } else throw new Error('unsupported protobuf wire type');
    if (at > source.size) throw new Error('truncated protobuf message');
  }
  return result;
}

export function readOnnxMetadataFile(file: string): Map<string, string> {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    return readOnnxMetadata({ size, read: (position, length) => {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, position);
      return buffer.subarray(0, read);
    } });
  } finally { closeSync(fd); }
}

/** What the SenseVoice recognizer needs from the metadata, checked. */
export interface SenseVoiceMeta {
  lfrM: number; lfrN: number; negMean: Float32Array; invStddev: Float32Array; vocabSize: number;
  languages: Record<'auto' | 'zh' | 'en' | 'yue' | 'ja' | 'ko', number>; withItn: number; withoutItn: number;
}
export function senseVoiceMeta(meta: Map<string, string>): SenseVoiceMeta {
  const int = (key: string) => { const value = Number(meta.get(key)); if (!Number.isInteger(value) || value < 0) throw new Error(`metadata ${key} missing`); return value; };
  const floats = (key: string) => {
    const values = (meta.get(key) ?? '').split(',').map(Number);
    if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error(`metadata ${key} missing`);
    return Float32Array.from(values);
  };
  if (meta.get('model_type') !== 'sense_voice_ctc') throw new Error('not a SenseVoice CTC model');
  const result: SenseVoiceMeta = {
    lfrM: int('lfr_window_size'), lfrN: int('lfr_window_shift'), negMean: floats('neg_mean'), invStddev: floats('inv_stddev'), vocabSize: int('vocab_size'),
    languages: { auto: int('lang_auto'), zh: int('lang_zh'), en: int('lang_en'), yue: int('lang_yue'), ja: int('lang_ja'), ko: int('lang_ko') },
    withItn: int('with_itn'), withoutItn: int('without_itn'),
  };
  if (result.negMean.length !== 80 * result.lfrM || result.invStddev.length !== result.negMean.length) throw new Error('metadata CMVN size');
  return result;
}
