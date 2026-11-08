import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_RUNTIME, MediaRuntime } from "../electron/runtime";

const frame = "data:image/jpeg;base64,aGVsbG8=";
test("runtime toggles start off, remain ephemeral and assign only explicit callers", () => {
  const runtime = new MediaRuntime();
  assert.deepEqual(runtime.state, EMPTY_RUNTIME);
  assert.deepEqual(
    runtime.update({ voiceInput: true, cameraSharing: true }, "pet"),
    {
      ...EMPTY_RUNTIME,
      voiceInput: true,
      voiceOwner: "pet",
      cameraSharing: true,
      // I-036: with no pose component at all (no policy here), the old single switch means 「发图片」, as it always did there.
      cameraImages: true,
      cameraOwner: "pet",
    },
  );
  runtime.update({ voiceInput: true }, "controls");
  assert.equal(runtime.state.voiceOwner, "controls");
  assert.equal(runtime.state.cameraOwner, "pet");
  assert.deepEqual(new MediaRuntime().state, EMPTY_RUNTIME);
  assert.deepEqual(runtime.reset(), EMPTY_RUNTIME);
});
test("runtime patches cannot assign owners or change saved settings", () => {
  for (const patch of [
    null,
    [],
    {},
    { voiceInput: 1 },
    { voiceOwner: "pet" },
    { screenSharing: true, apiKey: "secret" },
  ]) {
    assert.throws(() => new MediaRuntime().update(patch, "controls"));
  }
});
test("camera frames are owner-scoped, cleared on disable or transfer and never restored", () => {
  const runtime = new MediaRuntime();
  assert.throws(() => runtime.publishCamera("pet", frame));
  runtime.update({ cameraSharing: true }, "pet");
  assert.throws(() => runtime.publishCamera("controls", frame));
  assert.throws(() => runtime.publishCamera("pet", "file:///private.png"));
  runtime.publishCamera("pet", frame);
  assert.deepEqual(runtime.cameraAttachment(), {
    source: "camera",
    dataUrl: frame,
  });
  runtime.update({ cameraSharing: true }, "controls");
  assert.equal(runtime.cameraAttachment(), null);
  runtime.publishCamera("controls", frame);
  runtime.update({ cameraSharing: false }, "pet");
  runtime.update({ cameraSharing: true }, "controls");
  assert.equal(runtime.cameraAttachment(), null);
});
test("media permission keeps microphone and video owners separate from manual capture", () => {
  const runtime = new MediaRuntime();
  assert.equal(runtime.allowsMedia("controls", "audio"), false);
  assert.equal(runtime.allowsMedia("pet", "video"), false);
  assert.equal(runtime.allowsMedia("controls", "video", true), true);
  assert.equal(runtime.allowsMedia("controls", "audio", true), false);
  runtime.update({ voiceInput: true }, "pet");
  runtime.update({ cameraSharing: true }, "controls");
  assert.equal(runtime.allowsMedia("pet", "audio"), true);
  assert.equal(runtime.allowsMedia("controls", "audio"), false);
  assert.equal(runtime.allowsMedia("controls", "video"), true);
  assert.equal(runtime.allowsMedia("pet", "video", true), false);
});
test("owner destruction revokes its media and screen consent, and revisions invalidate late captures", () => {
  const runtime = new MediaRuntime();
  runtime.update(
    { voiceInput: true, screenSharing: true, cameraSharing: true },
    "pet",
  );
  runtime.publishCamera("pet", frame);
  const revision = runtime.revision;
  assert.deepEqual(runtime.dropOwner("pet"), EMPTY_RUNTIME);
  assert.equal(runtime.cameraAttachment(), null);
  assert.ok(runtime.revision > revision);
});
