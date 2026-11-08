import assert from "node:assert/strict";
import test from "node:test";
import { MediaRuntime } from "../electron/runtime";
import { SystemAudioRuntime } from "../electron/system-audio";

test("system audio starts off and requires explicit Windows consent for a loopback audio grant", () => {
  const runtime = new SystemAudioRuntime("win32");
  assert.deepEqual(runtime.state, { active: false });
  assert.equal(runtime.displayStreams(10, true, true), null);
  assert.deepEqual(runtime.setSharing(true, 10), { active: true });
  const streams = runtime.displayStreams(10, true, true);
  assert.deepEqual(streams, { audio: "loopback" });
  assert.equal(Object.hasOwn(streams!, "video"), false, "the consent gate never selects a desktop video source");
  assert.equal(runtime.displayStreams(20, true, true), null);
  assert.equal(runtime.displayStreams(10, false, true), null);
  assert.equal(runtime.displayStreams(10, true, false), null);
});

test("invalid values, non-Windows consent and a different owner cannot enable or revoke a session", () => {
  const runtime = new SystemAudioRuntime("win32");
  for (const value of [null, undefined, {}, "true", 1]) assert.throws(() => runtime.setSharing(value, 10), /开关/);
  for (const platform of ["linux", "darwin"] as const) {
    const unsupported = new SystemAudioRuntime(platform);
    assert.throws(() => unsupported.setSharing(true, 10), /Windows/);
    assert.deepEqual(unsupported.setSharing(false, 10), { active: false });
  }
  runtime.setSharing(true, 10);
  assert.throws(() => runtime.setSharing(true, 20), /另一个窗口/);
  assert.throws(() => runtime.setSharing(false, 20), /未开启/);
  assert.deepEqual(runtime.state, { active: true });
});

test("stop, owner teardown and reset revoke future grants without persisting any media data", () => {
  const runtime = new SystemAudioRuntime("win32");
  runtime.setSharing(true, 10);
  assert.deepEqual(runtime.dropOwner(20), { active: true });
  assert.deepEqual(runtime.dropOwner(10), { active: false });
  assert.equal(runtime.displayStreams(10, true, true), null);
  runtime.setSharing(true, 10);
  assert.deepEqual(runtime.reset(), { active: false });
  assert.equal(runtime.displayStreams(10, true, true), null);
  runtime.setSharing(true, 10);
  assert.deepEqual(runtime.setSharing(false, 10), { active: false });
  assert.equal(runtime.displayStreams(10, true, true), null);
  const snapshot = runtime.state;
  snapshot.active = true;
  assert.deepEqual(runtime.state, { active: false });
});

test("loopback consent grants no microphone, camera, screen attachment or ASR ownership", () => {
  const audio = new SystemAudioRuntime("win32");
  const media = new MediaRuntime();
  audio.setSharing(true, 10);
  assert.equal(media.allowsMedia("pet", "audio"), false);
  assert.equal(media.allowsMedia("pet", "video"), false);
  assert.equal(media.cameraAttachment(), null);
  assert.deepEqual(media.state, { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null });
  media.update({ voiceInput: true }, "controls");
  assert.equal(media.allowsMedia("pet", "audio"), false);
  assert.equal(media.allowsMedia("controls", "audio"), true);
});
