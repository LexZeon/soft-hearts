import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { withCodexImages } from "../electron/codex-images";
import { codexArguments } from "../electron/codex";

// Original 32×32 solid-green PNG fixture; no user screen or model content.
const green =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQ0lEQVR4AcXBAQEAAAiDMKR/5xuD7RgjJDGJSUxiEpOYxCQmMYlJTGISk5jEJCYxiUlMYhKTmMQkJjGJSUxiEpOYxB4v5AI+g+yDOgAAAABJRU5ErkJggg==";
const image = `data:image/png;base64,${green}`;
test("Codex images use owned temporary paths and never appear in capability probe arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "soft-vision-test-"));
  try {
    await withCodexImages(
      [image],
      root,
      new AbortController().signal,
      async (files) => {
        assert.equal(files.length, 1);
        assert.ok(path.relative(root, files[0]).startsWith("vision-"));
        assert.deepEqual(
          await readFile(files[0]),
          Buffer.from(green, "base64"),
        );
        const task = {
          kind: "chat" as const,
          model: "selected-model",
          workingDirectory: "isolated",
          writable: false,
          prompt: "What color?",
          imageDataUrls: [image],
        };
        const args = codexArguments(task, files);
        assert.equal(args[args.indexOf("--image") + 1], files[0]);
        assert.equal(args[args.indexOf("--model") + 1], "selected-model");
        assert.ok(!codexArguments(task).includes("--image"));
      },
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Codex image files are deleted when inference fails or is cancelled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "soft-vision-cleanup-"));
  try {
    await assert.rejects(
      withCodexImages([image], root, new AbortController().signal, async () => {
        throw new Error("unsupported CLI");
      }),
      /unsupported CLI/,
    );
    assert.deepEqual(await readdir(root), []);
    const controller = new AbortController();
    await assert.rejects(
      withCodexImages([image], root, controller.signal, async (files) => {
        assert.equal(
          (await readFile(files[0])).length,
          Buffer.from(green, "base64").length,
        );
        controller.abort();
        controller.signal.throwIfAborted();
      }),
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Codex image decoding rejects arbitrary files, invalid signatures and excessive attachments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "soft-vision-reject-"));
  try {
    for (const images of [
      ["file:///private.png"],
      ["data:image/png;base64,aGVsbG8="],
      [image.replace("image/png", "image/jpeg")],
      [image, image, image],
    ]) {
      await assert.rejects(
        withCodexImages(images, root, new AbortController().signal, async () =>
          assert.fail("must not run inference"),
        ),
      );
      assert.deepEqual(await readdir(root), []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
