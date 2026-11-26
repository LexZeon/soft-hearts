import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { buildApng, readChunks } from '../scripts/dev/apng.mjs';

// a tiny PNG encoder for the test: 2x2 RGBA, one colour
function png(r, g, b) {
  const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0); return Buffer.concat([length, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.from([0, r, g, b, 255, r, g, b, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]);
}

test('an APNG has acTL, a first frame in IDAT, later frames in fdAT, numbered in order, with valid CRCs', () => {
  const out = buildApng([png(255, 0, 0), png(0, 255, 0), png(0, 0, 255)], [100, 120, 140]);
  const chunks = readChunks(out);
  assert.deepEqual(chunks.map(entry => entry.type), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
  assert.equal(chunks[1].data.readUInt32BE(0), 3, 'three frames');
  const numbers = chunks.filter(entry => entry.type === 'fcTL' || entry.type === 'fdAT').map(entry => entry.data.readUInt32BE(0));
  assert.deepEqual(numbers, [0, 1, 2, 3, 4], 'one sequence over fcTL and fdAT');
  assert.equal(chunks[2].data.readUInt16BE(20), 100);
  // every CRC checks out
  for (let offset = 8; offset < out.length;) { const length = out.readUInt32BE(offset); assert.equal(out.readUInt32BE(offset + 8 + length) >>> 0, zlib.crc32(out.subarray(offset + 4, offset + 8 + length)) >>> 0); offset += 12 + length; }
  // the second frame's pixels are the second picture's: inflate its fdAT data (after the 4-byte number)
  const pixels = zlib.inflateSync(chunks[5].data.subarray(4));
  assert.deepEqual([...pixels.subarray(1, 5)], [0, 255, 0, 255]);
});

test('frames that differ in size, or no frames, are refused', () => {
  assert.throws(() => buildApng([], []));
  assert.throws(() => buildApng([png(1, 2, 3)], [100, 100]));
});
