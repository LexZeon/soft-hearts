import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeTestMotion } from "../scripts/create-test-motion.mjs";
import { createVmdParser, readableVmdHeader } from "../src/stage/vmd";

test("a truncated Shift-JIS model label does not corrupt or rewrite VMD motion data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soft-hearts-vmd-"));
  try {
    const file = path.join(directory, "original.vmd");
    await writeTestMotion(file);
    const bytes = await readFile(file);
    bytes.fill(0x61, 30, 49);
    bytes[49] = 0x83; // The exact broken-label pattern in upstream normal.vmd.
    const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const original = new Uint8Array(source).slice();
    const errors: unknown[][] = [];
    const savedError = console.error;
    console.error = (...args) => errors.push(args);
    let parsed: { metadata: { motionCount: number }; motions: { boneName: string; frameNum: number }[] };
    try {
      const parser = createVmdParser() as { parseVmd(buffer: ArrayBuffer, leftToRight: boolean): typeof parsed };
      parsed = parser.parseVmd(source, true);
    } finally {
      console.error = savedError;
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(new Uint8Array(source), original, "original bytes stay unchanged");
    assert.equal(parsed!.metadata.motionCount, 3);
    assert.deepEqual(parsed!.motions.map((frame) => [frame.boneName, frame.frameNum]),
      [["センター", 0], ["センター", 30], ["センター", 60]]);
    assert.deepEqual(new Uint8Array(readableVmdHeader(source)).subarray(50), original.subarray(50));
    bytes[48] = 0x83;
    bytes[49] = 0x5a; // A complete two-byte character is not changed.
    const complete = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    assert.equal(readableVmdHeader(complete), complete);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
