// Tiny writers for the archive formats the pose component uses, so tests build real .tgz/.zip bytes in memory.
import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';

export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export const integrity = (data: Uint8Array) => `sha512-${createHash('sha512').update(data).digest('base64')}`;

function tarHeader(name: string, size: number, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257); header.write('00', 263);
  let sum = 0; for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}
const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

/** npm-style tarball: everything under `package/`; names over 100 bytes use a pax header. */
export function makeTgz(entries: { name: string; data: Buffer }[], top = 'package'): Buffer {
  const parts: Buffer[] = [];
  for (const { name, data } of entries) {
    const full = `${top}/${name}`;
    if (Buffer.byteLength(full) > 100) {
      const record = ` path=${full}\n`;
      let length = record.length + 2; while (String(length).length + record.length !== length) length = String(length).length + record.length;
      const body = Buffer.from(`${length}${record}`);
      parts.push(tarHeader('PaxHeader', body.length, 'x'), pad(body));
    }
    parts.push(tarHeader(full, data.length), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** Minimal zip (deflate or stored), central directory at the end. */
export function makeZip(entries: { name: string; data: Buffer; store?: boolean }[], padding = 0): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  if (padding) { locals.push(Buffer.alloc(padding)); offset = padding; }
  for (const { name, data, store } of entries) {
    const body = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(store ? 0 : 8, 10);
    record.writeUInt32LE(body.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body); central.push(record, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * A fetch double over in-memory files: honours Range (206) unless told not to, counts bytes and calls.
 * `cut`: the connection drops halfway through the body (the stream errors like undici's "terminated").
 */
export function fakeFetch(files: Map<string, Buffer>, options: { ranges?: boolean; fail?: (url: string, call: number) => boolean; cut?: (url: string) => boolean } = {}) {
  const calls: { url: string; range: string | null }[] = [];
  let bytes = 0;
  const fetch = async (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    init.signal?.throwIfAborted();
    const range = init.headers?.Range ?? null;
    calls.push({ url, range });
    if (options.fail?.(url, calls.length)) throw new TypeError('fetch failed');
    const data = files.get(url);
    if (!data) return { status: 404, ok: false, headers: { get: () => null }, body: null, arrayBuffer: async () => new ArrayBuffer(0) };
    let body = data, status = 200;
    const match = range && options.ranges !== false ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (match) { body = data.subarray(Number(match[1]), Number(match[2]) + 1); status = 206; }
    const cut = !match && !!options.cut?.(url);
    bytes += cut ? Math.floor(body.length / 2) : body.length;
    const copy = Buffer.from(body);
    return {
      status, ok: true, headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? String(copy.length) : null },
      body: new ReadableStream<Uint8Array>({ start(controller) {
        const end = cut ? Math.floor(copy.length / 2) : copy.length;
        for (let i = 0; i < end; i += 65_536) controller.enqueue(copy.subarray(i, Math.min(end, i + 65_536)));
        if (cut) controller.error(new TypeError('terminated')); else controller.close();
      } }),
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.length),
    };
  };
  return { fetch, calls, bytes: () => bytes };
}
