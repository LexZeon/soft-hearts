import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export interface CharacterStickerPngInfo {
  width: number;
  height: number;
  sha256: string;
  hasAlpha: boolean;
  visiblePixels: number;
  transparentPixels: number;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LIMITS = {
  reference: { bytes: 8 * 1024 * 1024, edge: 1024, pixels: 1024 * 1024 },
  result: { bytes: 16 * 1024 * 1024, edge: 2048, pixels: 2048 * 2048 },
} as const;
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const MAX_CHUNKS = 4096;
// Closed, uncompressed metadata subset. No ancillary decoder or profile engine.
const METADATA_LENGTH: Readonly<Record<string, number>> = { cHRM: 32, gAMA: 4, sRGB: 1, pHYs: 9 };
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

function fail(reason: string): never { throw new Error('PNG rejected: ' + reason); }
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let value = 0xffffffff;
  for (let i = start; i < end; i++) value = CRC_TABLE[(value ^ bytes[i]) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function paeth(left: number, up: number, upperLeft: number): number {
  const p = left + up - upperLeft;
  const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

/**
 * Bounded in-memory decoder for one 8-bit, noninterlaced grayscale/RGB/GA/RGBA
 * PNG. It validates structure and actual alpha pixels, not appearance/likeness.
 * Indexed color, tRNS, APNG and ancillary formats outside the closed subset are
 * unsupported rather than silently interpreted as opaque or ignored images.
 */
export function validateCharacterStickerPng(bytes: Uint8Array, kind: 'reference' | 'result'): CharacterStickerPngInfo {
  if (!(bytes instanceof Uint8Array)) fail('input must be PNG bytes');
  if (kind !== 'reference' && kind !== 'result') fail('unknown image purpose');
  const limits = LIMITS[kind];
  if (bytes.byteLength < SIGNATURE.length || bytes.byteLength > limits.bytes) fail('encoded byte limit');
  // Own one bounded snapshot; a caller cannot change validated/hash bytes later.
  const input = Buffer.from(bytes);
  if (!input.subarray(0, 8).equals(SIGNATURE)) fail('signature');
  let offset = 8, width = 0, height = 0, colorType = -1, channels = 0;
  let header = false, imageData = false, ended = false, compressedLength = 0, chunkCount = 0;
  const compressedParts: Buffer[] = [], metadata = new Set<string>();
  while (offset < input.length) {
    if (++chunkCount > MAX_CHUNKS) fail('chunk count limit');
    if (input.length - offset < 12) fail('truncated chunk');
    const length = input.readUInt32BE(offset), dataStart = offset + 8, dataEnd = dataStart + length;
    if (dataEnd + 4 > input.length) fail('chunk length');
    for (let i = offset + 4; i < offset + 8; i++)
      if (!(input[i] >= 65 && input[i] <= 90) && !(input[i] >= 97 && input[i] <= 122)) fail('non-ASCII chunk type');
    const type = input.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()) fail('chunk type/reserved bit');
    if (crc32(input, offset + 4, dataEnd) !== input.readUInt32BE(dataEnd)) fail('chunk CRC');
    if (!header && type !== 'IHDR') fail('IHDR must be first');
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') fail('APNG is unsupported');
    if (type === 'IHDR') {
      if (header || offset !== 8 || length !== 13) fail('IHDR count/order/length');
      width = input.readUInt32BE(dataStart); height = input.readUInt32BE(dataStart + 4);
      if (!width || !height || width > limits.edge || height > limits.edge || width * height > limits.pixels)
        fail('dimensions/pixel limit');
      colorType = input[dataStart + 9]; channels = CHANNELS[colorType] ?? 0;
      if (input[dataStart + 8] !== 8 || !channels) fail('only 8-bit grayscale/RGB/GA/RGBA is supported');
      if (input[dataStart + 10] !== 0 || input[dataStart + 11] !== 0 || input[dataStart + 12] !== 0)
        fail('compression/filter method or interlace is unsupported');
      header = true;
    } else if (type === 'IDAT') {
      if (ended) fail('IDAT order');
      imageData = true;
      if (length) { compressedParts.push(input.subarray(dataStart, dataEnd)); compressedLength += length; }
    } else if (type === 'IEND') {
      if (!imageData || length !== 0) fail('IEND order/length');
      offset = dataEnd + 4;
      if (offset !== input.length) fail('trailing bytes or multiple images');
      ended = true;
      break;
    } else {
      if (type === 'PLTE' || type === 'tRNS') fail('palette/color-key transparency is unsupported; use an alpha channel');
      if (!Object.hasOwn(METADATA_LENGTH, type)) fail('unsupported chunk ' + type);
      if (imageData || metadata.has(type) || length !== METADATA_LENGTH[type]) fail('metadata order/count/length');
      if (type === 'gAMA' && input.readUInt32BE(dataStart) === 0) fail('invalid gamma');
      if (type === 'sRGB' && input[dataStart] > 3) fail('invalid sRGB intent');
      if (type === 'pHYs' && input[dataStart + 8] > 1) fail('invalid physical unit');
      metadata.add(type);
    }
    offset = dataEnd + 4;
  }
  if (!header || !ended || !compressedLength) fail('missing complete image data/IEND');
  const rowBytes = width * channels, expectedLength = height * (rowBytes + 1);
  const compressed = compressedParts.length === 1 ? compressedParts[0] : Buffer.concat(compressedParts, compressedLength);
  let scanlines: Buffer;
  try {
    // Node's sync info result exposes consumed input. The typings do not model
    // info:true; reject an unavailable receipt instead of accepting extra data.
    const decoded = inflateSync(compressed, { maxOutputLength: expectedLength, info: true }) as unknown as {
      buffer: Buffer; engine: { bytesWritten: number };
    };
    if (!Buffer.isBuffer(decoded.buffer) || decoded.buffer.length !== expectedLength
      || decoded.engine?.bytesWritten !== compressedLength) fail('deflate length/trailing input');
    scanlines = decoded.buffer;
  } catch { fail('invalid or oversized deflate stream/scanline length'); }
  let previous = new Uint8Array(rowBytes), current = new Uint8Array(rowBytes), cursor = 0;
  const hasAlpha = colorType === 4 || colorType === 6;
  let visiblePixels = 0, transparentPixels = 0;
  for (let y = 0; y < height; y++) {
    const filter = scanlines[cursor++];
    if (filter > 4) fail('unsupported row filter');
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= channels ? current[x - channels] : 0, up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      current[x] = (scanlines[cursor++] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const alpha = hasAlpha ? current[x * channels + channels - 1] : 255;
      if (alpha >= 32) visiblePixels++;
      if (alpha <= 16) transparentPixels++;
    }
    [previous, current] = [current, previous];
  }
  if (!visiblePixels) fail('image has no visible pixels');
  if (kind === 'result') {
    const minimum = Math.min(64, Math.ceil(width * height / 100));
    if (visiblePixels < minimum || transparentPixels < minimum) fail('result needs meaningful visible and transparent pixels');
  }
  return { width, height, sha256: createHash('sha256').update(input).digest('hex'), hasAlpha, visiblePixels, transparentPixels };
}
