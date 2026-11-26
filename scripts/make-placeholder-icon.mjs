// Writes assets/icons/soft-hearts.ico: a plain opaque black square at 16, 32, 48 and 256 px (PNG-compressed entries).
// A placeholder until a real icon is designed (0.2.1). Run `node scripts/make-placeholder-icon.mjs` to regenerate it, or replace the
// .ico with a real one at the same path; scripts/desktop-shortcut.ps1 points the desktop shortcut at that path. No dependencies.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ICON_SIZES = Object.freeze([16, 32, 48, 256]);

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** A solid black, fully opaque RGBA PNG of size x size. */
export function blackPng(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6; // 8 bit, RGBA
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x++) row[1 + x * 4 + 3] = 255; // black, alpha 255
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** The .ico file bytes: an icon directory with one PNG entry per size. */
export function placeholderIco(sizes = ICON_SIZES) {
  const images = sizes.map(blackPng);
  const directory = Buffer.alloc(6 + 16 * sizes.length);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  sizes.forEach((size, index) => {
    const at = 6 + 16 * index;
    directory[at] = size >= 256 ? 0 : size; directory[at + 1] = size >= 256 ? 0 : size;
    directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(images[index].length, at + 8); directory.writeUInt32LE(offset, at + 12);
    offset += images[index].length;
  });
  return Buffer.concat([directory, ...images]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icons', 'soft-hearts.ico');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, placeholderIco());
  console.log('wrote ' + target);
}
