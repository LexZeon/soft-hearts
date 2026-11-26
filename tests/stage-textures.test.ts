import assert from "node:assert/strict";
import test from "node:test";
import { fitTextureSize, MAX_TEXTURE_SIZE, resizedTextureCanvas } from "../src/stage/textures";

test("a resized texture's canvas stays in ordinary memory, so a graphics driver reset cannot blank her textures (2026-11-22)", () => {
  const calls: unknown[] = [];
  const canvas = { width: 0, height: 0, getContext: (kind: string, options?: unknown) => { calls.push([kind, options]); return {
    imageSmoothingQuality: "low", drawImage: (...args: unknown[]) => calls.push(["draw", ...args.slice(1)]) }; } };
  const doc = { createElement: (tag: string) => { assert.equal(tag, "canvas"); return canvas; } } as unknown as Pick<Document, "createElement">;
  const made = resizedTextureCanvas({} as CanvasImageSource, { width: 1024, height: 512 }, doc);
  assert.equal(made, canvas as unknown);
  assert.deepEqual(calls, [["2d", { willReadFrequently: true }], ["draw", 0, 0, 1024, 512]]);
  assert.deepEqual([canvas.width, canvas.height], [1024, 512]);
  const none = resizedTextureCanvas({} as CanvasImageSource, { width: 1, height: 1 }, { createElement: () => ({ getContext: () => null }) } as never);
  assert.equal(none, null);
});

test("desktop maps are capped at 1024 while preserving small toon textures", () => {
  assert.equal(MAX_TEXTURE_SIZE, 1024);
  assert.deepEqual(fitTextureSize(2048, 2048), { width: 1024, height: 1024 });
  assert.deepEqual(fitTextureSize(4096, 2048), { width: 1024, height: 512 });
  assert.deepEqual(fitTextureSize(512, 4096), { width: 128, height: 1024 });
  assert.deepEqual(fitTextureSize(32, 32), { width: 32, height: 32 });
});
