import assert from "node:assert/strict";
import test from "node:test";
import { fitTextureSize, MAX_TEXTURE_SIZE } from "../src/stage/textures";

test("desktop maps are capped at 1024 while preserving small toon textures", () => {
  assert.equal(MAX_TEXTURE_SIZE, 1024);
  assert.deepEqual(fitTextureSize(2048, 2048), { width: 1024, height: 1024 });
  assert.deepEqual(fitTextureSize(4096, 2048), { width: 1024, height: 512 });
  assert.deepEqual(fitTextureSize(512, 4096), { width: 128, height: 1024 });
  assert.deepEqual(fitTextureSize(32, 32), { width: 32, height: 32 });
});
