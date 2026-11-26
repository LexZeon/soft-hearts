// A small APNG writer (animated PNG) in plain node: takes same-size PNG frames (for example from a canvas) and reuses their IDAT data as
// fcTL / fdAT frames. No dependency; zlib.crc32 and Buffer are enough. Used by scripts/dev/capture-showcase.mjs for the README loops
// (docs/images/README.md). tests/apng-writer.test.mjs checks the structure.
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** The chunks of a PNG file as { type, data }. Throws when it is not a PNG. */
export function readChunks(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    chunks.push({ type: png.toString('latin1', offset + 4, offset + 8), data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

/**
 * `frames`: PNG buffers of the same size and colour type; `delaysMs`: how long each stays (milliseconds); `loops`: 0 = forever.
 * Every frame is drawn whole over the previous one (no blend, no disposal), so a frame never depends on another one's pixels.
 */
export function buildApng(frames, delaysMs, { loops = 0 } = {}) {
  if (!frames.length || frames.length !== delaysMs.length) throw new Error('frames and delays must be the same, non-zero length');
  const header = readChunks(frames[0]).find(entry => entry.type === 'IHDR').data;
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  const parts = [SIGNATURE, chunk('IHDR', header)];
  const control = Buffer.alloc(8); control.writeUInt32BE(frames.length, 0); control.writeUInt32BE(loops, 4);
  parts.push(chunk('acTL', control));
  let sequence = 0;
  frames.forEach((png, index) => {
    const own = readChunks(png);
    const ihdr = own.find(entry => entry.type === 'IHDR').data;
    if (!ihdr.equals(header)) throw new Error(`frame ${index} differs from frame 0 in size or format`);
    const data = Buffer.concat(own.filter(entry => entry.type === 'IDAT').map(entry => entry.data));
    const frame = Buffer.alloc(26);
    frame.writeUInt32BE(sequence++, 0); frame.writeUInt32BE(width, 4); frame.writeUInt32BE(height, 8);
    frame.writeUInt16BE(Math.min(65535, Math.max(1, Math.round(delaysMs[index]))), 20); frame.writeUInt16BE(1000, 22);
    parts.push(chunk('fcTL', frame));
    if (index === 0) parts.push(chunk('IDAT', data));
    else { const number = Buffer.alloc(4); number.writeUInt32BE(sequence++, 0); parts.push(chunk('fdAT', Buffer.concat([number, data]))); }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
