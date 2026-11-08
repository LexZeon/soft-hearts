import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { validateCharacterStickerPng } from '../electron/character-sticker-png';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Fixture CRC uses the bitwise specification, independently of the decoder table.
function chunk(type: string | Buffer, data = Buffer.alloc(0)): Buffer {
  const name = typeof type === 'string' ? Buffer.from(type, 'ascii') : type;
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8);
  let crc = 0xffffffff;
  for (const value of Buffer.concat([name, data])) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}
function ihdr(width = 2, height = 1, color = 6, depth = 8, interlace = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width); data.writeUInt32BE(height, 4);
  data[8] = depth; data[9] = color; data[12] = interlace;
  return chunk('IHDR', data);
}
const transparentAndVisible = Buffer.from([0, 10, 20, 30, 0, 40, 50, 60, 255]);
function png(scanlines = transparentAndVisible, header = ihdr(), compressed = deflateSync(scanlines)): Buffer {
  return Buffer.concat([signature, header, chunk('IDAT', compressed), chunk('IEND')]);
}
function alphaPng(alphas: number[], width: number): Buffer {
  assert.equal(alphas.length % width, 0);
  const height = alphas.length / width, rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * (1 + width * 4) + 1 + x * 4;
    rows[i] = 100; rows[i + 1] = 150; rows[i + 2] = 200; rows[i + 3] = alphas[y * width + x];
  }
  return png(rows, ihdr(width, height));
}

test('decodes supported grayscale/RGB/GA/RGBA bytes and hashes the exact PNG snapshot', () => {
  const rgba = png();
  assert.deepEqual(validateCharacterStickerPng(rgba, 'result'), {
    width: 2, height: 1, sha256: createHash('sha256').update(rgba).digest('hex'),
    hasAlpha: true, visiblePixels: 1, transparentPixels: 1,
  });
  for (const [color, scanlines, alpha, visible, transparent] of [
    [0, [0, 10, 20], false, 2, 0], [2, [0, 10, 20, 30, 40, 50, 60], false, 2, 0],
    [4, [0, 10, 0, 20, 255], true, 1, 1],
  ] as const) {
    const info = validateCharacterStickerPng(png(Buffer.from(scanlines), ihdr(2, 1, color)), 'reference');
    assert.equal(info.hasAlpha, alpha); assert.equal(info.visiblePixels, visible); assert.equal(info.transparentPixels, transparent);
  }
  const compressed = deflateSync(transparentAndVisible);
  const split = Buffer.concat([signature, ihdr(), chunk('IDAT', compressed.subarray(0, 2)), chunk('IDAT', compressed.subarray(2)), chunk('IEND')]);
  assert.equal(validateCharacterStickerPng(split, 'result').transparentPixels, 1);
  const gamma = Buffer.alloc(4); gamma.writeUInt32BE(45455);
  const metadata = Buffer.concat([signature, ihdr(), chunk('gAMA', gamma), chunk('sRGB', Buffer.from([0])), chunk('IDAT', compressed), chunk('IEND')]);
  assert.equal(validateCharacterStickerPng(metadata, 'result').visiblePixels, 1);
});

test('unfilters all five row modes including nontrivial Paeth upper-left prediction', () => {
  // First row alpha=[200,100]. Second-row residuals below must decode [255,0].
  // Paeth's second alpha picks upper-left200 (not left255 or up100).
  const residues = [[255, 0], [255, 1], [55, 156], [155, 79], [55, 56]];
  for (let filter = 0; filter <= 4; filter++) {
    const data = Buffer.from([0, 10, 20, 30, 200, 40, 50, 60, 100,
      filter, 0, 0, 0, residues[filter][0], 0, 0, 0, residues[filter][1]]);
    const info = validateCharacterStickerPng(png(data, ihdr(2, 2)), 'result');
    assert.equal(info.visiblePixels, 3, 'filter ' + filter);
    assert.equal(info.transparentPixels, 1, 'filter ' + filter);
  }
});

test('rejects bad PNG/chunk CRC, lengths, order, missing end and trailing or multiple images', () => {
  const valid = png(), badCrc = Buffer.from(valid); badCrc[badCrc.length - 1] ^= 1;
  const hugeLength = Buffer.from(valid); hugeLength.writeUInt32BE(0xffffffff, 8);
  const nonAsciiName = Buffer.from('IHDR'); nonAsciiName[0] |= 128;
  const malformed = [Buffer.from('not PNG'), badCrc, hugeLength, valid.subarray(0, valid.length - 1),
    valid.subarray(0, valid.length - 12), Buffer.concat([valid, Buffer.from([0])]), Buffer.concat([valid, valid]),
    Buffer.concat([signature, chunk('IDAT', deflateSync(transparentAndVisible)), ihdr(), chunk('IEND')]),
    Buffer.concat([signature, ihdr(), ihdr(), chunk('IDAT', deflateSync(transparentAndVisible)), chunk('IEND')]),
    Buffer.concat([signature, ihdr(), chunk('IEND')]),
    Buffer.concat([signature, ihdr(), chunk('IDAT', deflateSync(transparentAndVisible)), chunk('IEND', Buffer.from([0]))]),
    Buffer.concat([signature, chunk(nonAsciiName, Buffer.alloc(13)), chunk('IEND')]),
    Buffer.concat([signature, ihdr(), chunk('ABCD'), chunk('IDAT', deflateSync(transparentAndVisible)), chunk('IEND')]),
  ];
  for (const bytes of malformed) assert.throws(() => validateCharacterStickerPng(bytes, 'reference'), /PNG rejected/);
});

test('rejects APNG and unsupported bit depths, palette/color key, interlace or ancillary modes', () => {
  for (const type of ['acTL', 'fcTL', 'fdAT', 'PLTE', 'tRNS', 'iCCP', 'tEXt']) {
    const bytes = Buffer.concat([signature, ihdr(), chunk(type), chunk('IDAT', deflateSync(transparentAndVisible)), chunk('IEND')]);
    assert.throws(() => validateCharacterStickerPng(bytes, 'reference'), /unsupported/);
  }
  for (const header of [ihdr(2, 1, 3), ihdr(2, 1, 6, 16), ihdr(2, 1, 6, 8, 1)])
    assert.throws(() => validateCharacterStickerPng(png(transparentAndVisible, header), 'reference'), /supported/);
  const compressed = chunk('IDAT', deflateSync(transparentAndVisible));
  assert.throws(() => validateCharacterStickerPng(Buffer.concat([signature, ihdr(), compressed, chunk('sRGB', Buffer.from([0])), compressed, chunk('IEND')]), 'reference'), /order/);
});

test('enforces per-purpose byte/dimension limits before inflation and exact bounded deflate length', () => {
  assert.throws(() => validateCharacterStickerPng(Buffer.alloc(8 * 1024 * 1024 + 1), 'reference'), /byte limit/);
  assert.throws(() => validateCharacterStickerPng(Buffer.alloc(16 * 1024 * 1024 + 1), 'result'), /byte limit/);
  for (const [kind, edge] of [['reference', 1024], ['result', 2048]] as const) {
    for (const header of [ihdr(0), ihdr(edge + 1), ihdr(1, edge + 1), ihdr(0xffffffff, 0xffffffff)])
      assert.throws(() => validateCharacterStickerPng(png(transparentAndVisible, header), kind), /dimensions/);
  }
  for (const raw of [transparentAndVisible.subarray(0, 8), Buffer.concat([transparentAndVisible, Buffer.from([0])])])
    assert.throws(() => validateCharacterStickerPng(png(raw), 'reference'), /deflate/);
  assert.throws(() => validateCharacterStickerPng(png(transparentAndVisible, ihdr(), Buffer.from([1, 2, 3])), 'reference'), /deflate/);
  assert.throws(() => validateCharacterStickerPng(png(transparentAndVisible, ihdr(), Buffer.concat([deflateSync(transparentAndVisible), Buffer.from([0])])), 'reference'), /deflate/);
  const excessiveChunks = Buffer.concat([signature, ihdr(), ...Array.from({ length: 4096 }, () => chunk('IDAT')),
    chunk('IDAT', deflateSync(transparentAndVisible)), chunk('IEND')]);
  assert.throws(() => validateCharacterStickerPng(excessiveChunks, 'reference'), /chunk count/);
  const badFilter = Buffer.from(transparentAndVisible); badFilter[0] = 5;
  assert.throws(() => validateCharacterStickerPng(png(badFilter), 'reference'), /row filter/);
});

test('counts decoded alpha thresholds and requires meaningful visible and transparent output', () => {
  const boundary = alphaPng([16, 32, 17, 31], 2);
  assert.deepEqual([validateCharacterStickerPng(boundary, 'result').transparentPixels,
    validateCharacterStickerPng(boundary, 'result').visiblePixels], [1, 1]);
  const opaque = alphaPng([255, 255, 255, 255], 2), empty = alphaPng([0, 0, 0, 0], 2);
  assert.equal(validateCharacterStickerPng(opaque, 'reference').visiblePixels, 4);
  assert.throws(() => validateCharacterStickerPng(opaque, 'result'), /meaningful/);
  assert.throws(() => validateCharacterStickerPng(empty, 'result'), /no visible/);
  assert.throws(() => validateCharacterStickerPng(empty, 'reference'), /no visible/);
  const sufficient = Array(256).fill(20); sufficient.fill(0, 0, 3); sufficient.fill(255, 3, 6);
  assert.equal(validateCharacterStickerPng(alphaPng(sufficient, 16), 'result').visiblePixels, 3);
  const insufficient = [...sufficient]; insufficient[3] = 20;
  assert.throws(() => validateCharacterStickerPng(alphaPng(insufficient, 16), 'result'), /meaningful/);
  const capped = Array(10_000).fill(20); capped.fill(0, 0, 64); capped.fill(255, 64, 128);
  assert.equal(validateCharacterStickerPng(alphaPng(capped, 100), 'result').transparentPixels, 64);
});
