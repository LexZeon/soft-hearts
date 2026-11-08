/**
 * Minimal readers for the two archive formats the pose component comes in: npm `.tgz` and OpenMMLab `.zip`.
 * Only what the manifest needs: keep a fixed list of entries, verify each one's size and SHA-256 before
 * anything is renamed into place. Everything else in the archive is skipped without being written.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, inflateRawSync } from 'node:zlib';
import type { ManifestFile } from './manifest';

export class ComponentVerifyError extends Error {
  constructor(message: string) { super(message); this.name = 'ComponentVerifyError'; }
}

export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Throws unless `data` is exactly the manifest file. */
export function verifyFile(file: ManifestFile, data: Uint8Array): void {
  if (data.byteLength !== file.size) throw new ComponentVerifyError(`size mismatch: ${file.to}`);
  if (sha256(data) !== file.sha256) throw new ComponentVerifyError(`hash mismatch: ${file.to}`);
}

// ---------------------------------------------------------------- tar.gz

/** Name relative to the package root: npm tarballs put everything under one top folder (`package/`). */
function stripTop(name: string): string {
  const clean = name.replace(/\\/g, '/').replace(/^\.\//, '');
  const slash = clean.indexOf('/');
  return slash < 0 ? '' : clean.slice(slash + 1);
}
function octal(block: Buffer, start: number, length: number): number {
  const raw = block.subarray(start, start + length);
  if (raw[0] & 0x80) { // base-256 (GNU) for very large sizes
    let value = 0;
    for (let i = 1; i < raw.length; i++) value = value * 256 + raw[i];
    return value;
  }
  const text = raw.toString('latin1').replace(/\0.*$/s, '').trim();
  return text ? parseInt(text, 8) : 0;
}
const cString = (block: Buffer, start: number, end: number) => block.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');

type TarEntry = { kind: 'keep'; file: ManifestFile; chunks: Buffer[]; remaining: number; padding: number }
  | { kind: 'skip'; remaining: number; padding: number }
  | { kind: 'pax' | 'longname'; chunks: Buffer[]; remaining: number; padding: number };

/**
 * Stream a gzip'd tarball and return the wanted files (verified). Names are compared with the top folder
 * stripped. Rejects when a wanted file is missing, duplicated or differs from the manifest.
 */
export async function extractTarGz(archivePath: string, wanted: readonly ManifestFile[], signal?: AbortSignal): Promise<Map<ManifestFile, Buffer>> {
  const byName = new Map(wanted.map(file => [file.from, file]));
  const found = new Map<ManifestFile, Buffer>();
  let pending = Buffer.alloc(0);
  let entry: TarEntry | null = null;
  let paxPath: string | null = null, longName: string | null = null, zeroBlocks = 0, ended = false;
  const finish = (done: TarEntry) => {
    if (done.kind === 'keep') {
      const data = Buffer.concat(done.chunks);
      verifyFile(done.file, data);
      found.set(done.file, data);
    } else if (done.kind === 'pax') {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(Buffer.concat(done.chunks).toString('utf8'));
      if (match) paxPath = match[1];
    } else if (done.kind === 'longname') longName = Buffer.concat(done.chunks).toString('utf8').replace(/\0.*$/s, '');
  };
  const step = (): boolean => { // false: need more input
    if (entry) {
      if (entry.remaining > 0) {
        if (!pending.length) return false;
        const take = Math.min(entry.remaining, pending.length);
        if (entry.kind !== 'skip') entry.chunks.push(pending.subarray(0, take));
        pending = pending.subarray(take); entry.remaining -= take;
        if (entry.remaining > 0) return false;
      }
      if (pending.length < entry.padding) return false;
      pending = pending.subarray(entry.padding);
      const done = entry; entry = null;
      finish(done);
      return true;
    }
    if (pending.length < 512) return false;
    const header = pending.subarray(0, 512); pending = pending.subarray(512);
    if (header.every(byte => byte === 0)) { if (++zeroBlocks >= 2) ended = true; return true; }
    zeroBlocks = 0;
    const type = String.fromCharCode(header[156] || 48);
    const size = octal(header, 124, 12);
    const padding = (512 - (size % 512)) % 512;
    if (type === 'x' || type === 'L') {
      if (size > 65_536) throw new ComponentVerifyError('oversized tar metadata');
      entry = { kind: type === 'x' ? 'pax' : 'longname', chunks: [], remaining: size, padding };
      return true;
    }
    const prefix = header.subarray(257, 262).toString('latin1') === 'ustar' ? cString(header, 345, 500) : '';
    const base = cString(header, 0, 100);
    const name = stripTop(longName ?? paxPath ?? (prefix ? `${prefix}/${base}` : base));
    longName = paxPath = null;
    const file = (type === '0' || type === '7') ? byName.get(name) : undefined;
    if (file) {
      if (found.has(file)) throw new ComponentVerifyError(`duplicate entry: ${name}`);
      if (size !== file.size) throw new ComponentVerifyError(`size mismatch: ${file.to}`);
      entry = { kind: 'keep', file, chunks: [], remaining: size, padding };
    } else entry = { kind: 'skip', remaining: size, padding };
    return true;
  };
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (!ended && step()) { /* keep parsing */ }
        callback();
      } catch (error) { callback(error as Error); }
    },
  });
  await pipeline(createReadStream(archivePath), createGunzip(), sink, { signal });
  for (const file of wanted) if (!found.has(file)) throw new ComponentVerifyError(`missing in archive: ${file.from}`);
  return found;
}

// ---------------------------------------------------------------- zip

export interface ZipEntry { name: string; method: number; compressedSize: number; size: number; localOffset: number; flags: number }

/** End-of-central-directory record inside the last bytes of a zip. */
export function findZipDirectory(tail: Buffer, archiveSize: number): { offset: number; size: number } {
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tail.readUInt32LE(at) !== 0x06054b50) continue;
    const size = tail.readUInt32LE(at + 12), offset = tail.readUInt32LE(at + 16);
    if (size === 0xffffffff || offset === 0xffffffff) throw new ComponentVerifyError('zip64 is not supported');
    if (offset + size > archiveSize) throw new ComponentVerifyError('zip directory out of range');
    return { offset, size };
  }
  throw new ComponentVerifyError('not a zip file');
}
export function parseZipEntries(directory: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  for (let at = 0; at + 46 <= directory.length && directory.readUInt32LE(at) === 0x02014b50;) {
    const nameLength = directory.readUInt16LE(at + 28), extra = directory.readUInt16LE(at + 30), comment = directory.readUInt16LE(at + 32);
    if (at + 46 + nameLength > directory.length) break;
    entries.push({
      flags: directory.readUInt16LE(at + 8), method: directory.readUInt16LE(at + 10),
      compressedSize: directory.readUInt32LE(at + 20), size: directory.readUInt32LE(at + 24),
      localOffset: directory.readUInt32LE(at + 42), name: directory.toString('utf8', at + 46, at + 46 + nameLength),
    });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}
/**
 * The entry for a manifest file: name ending in `from` (OpenMMLab nests it under a dated folder),
 * or, failing that, the only `.onnx` entry of exactly the expected size. The SHA-256 is checked after inflating.
 */
export function pickZipEntry(entries: readonly ZipEntry[], file: ManifestFile): ZipEntry {
  const bySuffix = entries.filter(entry => !entry.name.endsWith('/') && (entry.name === file.from || entry.name.endsWith(`/${file.from}`)));
  const candidates = bySuffix.length ? bySuffix : entries.filter(entry => entry.name.toLowerCase().endsWith('.onnx'));
  const sized = candidates.filter(entry => entry.size === file.size);
  if (sized.length !== 1) throw new ComponentVerifyError(`missing in archive: ${file.from}`);
  return sized[0];
}
/** Local header + compressed bytes of one entry → verified file bytes. */
export function inflateZipEntry(entry: ZipEntry, local: Buffer, file: ManifestFile): Buffer {
  if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) throw new ComponentVerifyError('bad zip entry header');
  if (entry.flags & 1) throw new ComponentVerifyError('encrypted zip entry');
  const start = 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const body = local.subarray(start, start + entry.compressedSize);
  if (body.length !== entry.compressedSize) throw new ComponentVerifyError('truncated zip entry');
  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(body);
  else if (entry.method === 8) {
    try { data = inflateRawSync(body, { maxOutputLength: file.size + 1 }); }
    catch { throw new ComponentVerifyError(`corrupt zip entry: ${file.from}`); }
  } else throw new ComponentVerifyError('unsupported zip compression');
  verifyFile(file, data);
  return data;
}
/** Bytes after the local header offset that surely hold the header (name + extra ≤ 2 × 64 KiB) and the data. */
export const zipEntrySpan = (entry: ZipEntry) => 30 + 2 * 65_535 + entry.compressedSize;

/** Extract wanted entries from a zip file on disk; every entry is verified against the manifest. */
export async function extractZipFile(archivePath: string, wanted: readonly ManifestFile[]): Promise<Map<ManifestFile, Buffer>> {
  const handle = await open(archivePath, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const dir = findZipDirectory(tail, size);
    const directory = Buffer.alloc(dir.size);
    await handle.read(directory, 0, dir.size, dir.offset);
    const entries = parseZipEntries(directory);
    const found = new Map<ManifestFile, Buffer>();
    for (const file of wanted) {
      const entry = pickZipEntry(entries, file);
      const span = Math.min(zipEntrySpan(entry), size - entry.localOffset);
      const local = Buffer.alloc(span);
      await handle.read(local, 0, span, entry.localOffset);
      found.set(file, inflateZipEntry(entry, local, file));
    }
    return found;
  } finally { await handle.close(); }
}
