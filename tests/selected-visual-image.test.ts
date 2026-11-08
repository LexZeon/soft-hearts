import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, MAX_SELECTED_IMAGE_BYTES,
  readSelectedVisualImage, selectedImageHeader, type EncodedVisualImage,
} from '../electron/selected-visual-image';

// These are synthetic header fixtures, not encoded-image/real codec acceptance.
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(kind: string, data = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); result.write(kind, 4, 'ascii'); data.copy(result, 8);
  return result;
}
function png(width = 640, height = 360, extra: Buffer[] = []): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([signature, chunk('IHDR', header), ...extra, chunk('IEND')]);
}
function jpeg(width = 640, height = 360, bytes = 33): Buffer {
  const result = Buffer.alloc(bytes);
  Buffer.from([255, 216, 255, 224, 0, 8, 0, 0, 0, 0, 0, 0, 255, 192, 0, 17, 8]).copy(result);
  result.writeUInt16BE(height, 17); result.writeUInt16BE(width, 19);
  result[21] = 3; result[31] = 255; result[32] = 217;
  return result;
}
function webp(kind: 'VP8X' | 'VP8L' | 'VP8 ', width = 640, height = 360): Buffer {
  const result = Buffer.alloc(30); result.write('RIFF'); result.writeUInt32LE(22, 4);
  result.write('WEBP', 8); result.write(kind, 12); result.writeUInt32LE(10, 16);
  if (kind === 'VP8X') { result.writeUIntLE(width - 1, 24, 3); result.writeUIntLE(height - 1, 27, 3); }
  else if (kind === 'VP8L') {
    const w = width - 1, h = height - 1;
    result[20] = 0x2f; result[21] = w & 255; result[22] = (w >> 8) | ((h & 3) << 6);
    result[23] = (h >> 2) & 255; result[24] = (h >> 10) & 15;
  } else {
    Buffer.from([0x9d, 1, 0x2a]).copy(result, 23);
    result.writeUInt16LE(width, 26); result.writeUInt16LE(height, 28);
  }
  return result;
}
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const isZero = (bytes: Buffer): boolean => bytes.every(byte => byte === 0);
const safeMessage = '图片无法安全读取或超出静态制作范围；原图未修改。';
const signal = (): AbortSignal => new AbortController().signal;
const output = (width = 960, height = 540): EncodedVisualImage => ({
  bytes: jpeg(width, height), width, height, thumbnail: jpeg(240, 135),
});

async function ownedFile(bytes: Buffer, run: (file: string, directory: string) => Promise<void>): Promise<void> {
  const tempRoot = await realpath(os.tmpdir()), prefix = 'soft-hearts-selected-image-';
  const directory = await mkdtemp(path.join(tempRoot, prefix));
  const file = path.join(directory, 'synthetic-private-selection.png'), original = Buffer.from(bytes);
  try {
    await writeFile(file, original, { flag: 'wx' });
    await run(file, directory);
  } finally {
    // Never recursively delete a computed or substituted path outside this owned Temp root.
    assert.equal(path.dirname(path.resolve(directory)), tempRoot);
    assert.ok(path.basename(directory).startsWith(prefix));
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    assert.equal(await realpath(directory), directory);
    try { assert.deepEqual(await readFile(file), original, 'the original selected file must remain byte-for-byte intact'); }
    finally { await rm(directory, { recursive: true, force: false }); }
  }
}
async function rejected(file: string, task: Promise<unknown>): Promise<void> {
  await assert.rejects(task, (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error.message, safeMessage);
    assert.equal(error.message.includes(file), false);
    assert.equal(error.message.includes(path.dirname(file)), false);
    return true;
  });
}

for (const [name, bytes] of [
  ['PNG', png()], ['JPEG', jpeg()], ['WebP VP8X', webp('VP8X')],
  ['WebP VP8L', webp('VP8L')], ['WebP VP8 lossy', webp('VP8 ')],
] as const) {
  test(`synthetic ${name} header reports dimensions without decoding`, () => {
    assert.deepEqual(selectedImageHeader(bytes), { width: 640, height: 360 });
  });
}

test('header accepts exact byte, edge and pixel ceilings, and rejects just outside them', () => {
  const base = png(), sized = png(640, 360, [chunk('IDAT', Buffer.alloc(MAX_SELECTED_IMAGE_BYTES - base.length - 12))]);
  assert.equal(sized.length, MAX_SELECTED_IMAGE_BYTES);
  assert.deepEqual(selectedImageHeader(sized), { width: 640, height: 360 });
  assert.deepEqual(selectedImageHeader(png(MAX_IMAGE_EDGE, 1)), { width: MAX_IMAGE_EDGE, height: 1 });
  assert.equal(4000 * 3000, MAX_IMAGE_PIXELS);
  assert.deepEqual(selectedImageHeader(jpeg(4000, 3000)), { width: 4000, height: 3000 });
  for (const bytes of [Buffer.alloc(23), Buffer.alloc(MAX_SELECTED_IMAGE_BYTES + 1),
    png(0, 1), jpeg(1, 0), png(MAX_IMAGE_EDGE + 1, 1), webp('VP8X', 1, MAX_IMAGE_EDGE + 1), png(4000, 3001)]) {
    assert.throws(() => selectedImageHeader(bytes));
  }
});

test('PNG header rejects bad IHDR, truncated chunks and missing IEND', () => {
  const wrongType = png(), wrongLength = png(), badSignature = png();
  wrongType.write('JHDR', 12); wrongLength.writeUInt32BE(12, 8); badSignature[0] = 0;
  for (const bytes of [wrongType, wrongLength, badSignature, png().subarray(0, 32), png().subarray(0, 33)]) {
    assert.throws(() => selectedImageHeader(bytes));
  }
});

test('JPEG header rejects broken markers, truncated segments and missing verifiable SOF', () => {
  const marker = jpeg(), length = jpeg(), missing = Buffer.alloc(30);
  marker[12] = 0; length.writeUInt16BE(100, 14);
  Buffer.from([255, 216, 255, 224, 0, 28]).copy(missing);
  for (const bytes of [marker, length, missing, jpeg().subarray(0, 24)]) assert.throws(() => selectedImageHeader(bytes));
});

test('WebP header rejects inconsistent RIFF length, truncated payload and bad bitstream signature', () => {
  const riff = webp('VP8X'), lossless = webp('VP8L'), lossy = webp('VP8 '), unknown = webp('VP8X');
  riff.writeUInt32LE(23, 4); lossless[20] = 0; lossy[23] = 0; unknown.write('NOPE', 12);
  for (const bytes of [riff, lossless, lossy, unknown, webp('VP8X').subarray(0, 29)]) assert.throws(() => selectedImageHeader(bytes));
});

test('APNG and animated WebP are refused before any codec is involved', () => {
  const animated = webp('VP8X'); animated[20] |= 2;
  assert.throws(() => selectedImageHeader(png(640, 360, [chunk('acTL', Buffer.alloc(8))])), /静态/);
  assert.throws(() => selectedImageHeader(animated), /静态/);
});

for (const [name, input] of [['PNG', png()], ['JPEG', jpeg()], ['WebP', webp('VP8X')]] as const) {
  test(`selected synthetic ${name} sends exact transformed JPEG bytes/hash and clears owned buffers`, async () => {
    await ownedFile(input, async file => {
      const controller = new AbortController(), encoded = output(), expected = Buffer.from(encoded.bytes), thumb = Buffer.from(encoded.thumbnail);
      let calls = 0, source: Buffer | undefined;
      const selected = await readSelectedVisualImage(file, controller.signal, async (bytes, suppliedSignal) => {
        calls++; source = bytes; assert.equal(suppliedSignal, controller.signal); assert.deepEqual(bytes, input); return encoded;
      });
      assert.equal(calls, 1); assert.ok(source); assert.ok(isZero(source));
      assert.equal(selected.dataUrl, `data:image/jpeg;base64,${expected.toString('base64')}`);
      assert.equal(selected.previewDataUrl, `data:image/jpeg;base64,${thumb.toString('base64')}`);
      assert.equal(selected.sha256, hash(expected)); assert.notEqual(selected.sha256, hash(input));
      assert.deepEqual({ width: selected.width, height: selected.height }, { width: 960, height: 540 });
      assert.deepEqual(encoded.bytes, expected); assert.ok(isZero(encoded.thumbnail));
      selected.release(); selected.release();
      assert.ok(isZero(encoded.bytes)); assert.ok(isZero(encoded.thumbnail));
      assert.equal(selected.dataUrl, ''); assert.equal(selected.previewDataUrl, ''); assert.equal(selected.sha256, '');
    });
  });
}

test('cancellation before read never calls the decoder and does not expose its reason or selected path', async () => {
  await ownedFile(png(), async file => {
    const controller = new AbortController(); controller.abort(Error(`private cancellation: ${file}`));
    let calls = 0;
    await rejected(file, readSelectedVisualImage(file, controller.signal, async () => { calls++; return output(); }));
    assert.equal(calls, 0);
  });
});

test('cancellation during transformation clears source, output and thumbnail and returns no image', async () => {
  await ownedFile(png(), async file => {
    const controller = new AbortController(), encoded = output(); let source: Buffer | undefined;
    await rejected(file, readSelectedVisualImage(file, controller.signal, async bytes => {
      source = bytes; controller.abort(); return encoded;
    }));
    assert.ok(source && isZero(source)); assert.ok(isZero(encoded.bytes)); assert.ok(isZero(encoded.thumbnail));
  });
});

test('decoder failure is generalized without selected path, stack detail or retained source bytes', async () => {
  await ownedFile(png(), async file => {
    let source: Buffer | undefined;
    await rejected(file, readSelectedVisualImage(file, signal(), async bytes => { source = bytes; throw Error(`codec private path ${file}`); }));
    assert.ok(source && isZero(source));
  });
});

test('missing and directory selections are generalized and never sent to a decoder', async () => {
  await ownedFile(png(), async (file, directory) => {
    let calls = 0; const transform = async () => { calls++; return output(); };
    for (const selected of [path.join(directory, 'missing-private-file.png'), directory]) {
      await rejected(selected, readSelectedVisualImage(selected, signal(), transform));
    }
    assert.equal(calls, 0); assert.ok((await readFile(file)).length > 0);
  });
});

for (const [name, input] of [
  ['undersized', Buffer.alloc(23)], ['oversized', Buffer.alloc(MAX_SELECTED_IMAGE_BYTES + 1)],
  ['truncated PNG', png().subarray(0, 33)], ['animated PNG', png(640, 360, [chunk('acTL', Buffer.alloc(8))])],
] as const) {
  test(`${name} selected file is refused before transformation and remains unchanged`, async () => {
    await ownedFile(input, async file => {
      let calls = 0;
      await rejected(file, readSelectedVisualImage(file, signal(), async () => { calls++; return output(); }));
      assert.equal(calls, 0);
    });
  });
}

for (const [name, make] of [
  ['non-JPEG output', () => ({ ...output(), bytes: png(960, 540) })],
  ['non-JPEG thumbnail', () => ({ ...output(), thumbnail: png(240, 135) })],
  ['output dimensions inconsistent with metadata', () => ({ ...output(), width: 961 })],
  ['invalid output dimensions', () => ({ ...output(), height: 0 })],
  ['thumbnail beyond edge limit', () => ({ ...output(), thumbnail: jpeg(401, 135) })],
  ['thumbnail beyond byte limit', () => ({ ...output(), thumbnail: jpeg(240, 135, 160_001) })],
  ['transformed image beyond byte limit', () => ({ ...output(), bytes: jpeg(960, 540, MAX_SELECTED_IMAGE_BYTES + 1) })],
] as const) {
  test(`${name} is refused with all returned transformation buffers cleared`, async () => {
    await ownedFile(png(), async file => {
      const encoded = make(); let source: Buffer | undefined;
      await rejected(file, readSelectedVisualImage(file, signal(), async bytes => { source = bytes; return encoded; }));
      assert.ok(source && isZero(source)); assert.ok(isZero(encoded.bytes)); assert.ok(isZero(encoded.thumbnail));
    });
  });
}
