import assert from "node:assert/strict";
import test from "node:test";
import type { AppSettings, AssetRef } from "../shared/contracts";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { CatalogMotion, MotionPackId } from "../shared/motion-library";
import { getMotionLayerAssets, withMotionLayer } from "../shared/motion-layers";
import { MotionPreviewSession, type MotionPreviewState } from "../src/ui/motion-preview";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const asset = (id: string): AssetRef => ({ path: `/reviewed/${id}.vmd`, url: `mmd-asset://reviewed/${id}.vmd`, name: `${id}.vmd` });
const motion = (id: string): CatalogMotion => ({
  id, name: `Motion ${id}`, category: "gesture", tags: ["gesture"],
  relativePath: `motions/gesture/${id}.vmd`, originalPath: `${id}.vmd`,
  downloadUrl: "https://example.invalid/reviewed-source", sha256: "a".repeat(64), bytes: 74,
  durationFrames: 60, boneFrames: 3, morphFrames: 0,
});

function harness(options: {
  load?: (packId: MotionPackId, motionId: string) => Promise<AssetRef>;
  apply?: (value: AppSettings, count: number) => Promise<void>;
} = {}) {
  let saved = structuredClone(DEFAULT_SETTINGS);
  saved.model = { path: "/models/gene.pmx", url: "mmd-asset://model/gene.pmx", name: "gene.pmx" };
  saved.motion = asset("saved");
  const states: MotionPreviewState[] = [];
  const applied: AppSettings[] = [];
  const loaded: { packId: MotionPackId; motionId: string }[] = [];
  const preview = new MotionPreviewSession({
    getSettings: () => saved,
    load: async (packId, motionId) => {
      loaded.push({ packId, motionId });
      return options.load ? options.load(packId, motionId) : asset(motionId);
    },
    apply: async value => {
      applied.push(structuredClone(value));
      await options.apply?.(value, applied.length);
    },
    onState: state => states.push(state),
  });
  return { preview, states, applied, loaded, get saved() { return saved; }, set saved(value: AppSettings) { saved = value; } };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.ok(predicate(), "expected asynchronous phase was reached");
}

test("preview clears then plays locally without changing saved settings, and view follows current camera", async () => {
  const h = harness();
  const original = structuredClone(h.saved);
  assert.equal(await h.preview.start("genea-2022-gestures", motion("one")), true);
  assert.deepEqual(h.applied.map(value => value.motion?.name ?? null), [null, "one.vmd"]);
  assert.deepEqual(h.saved, original);
  const latest = structuredClone(h.saved);
  latest.camera.yaw = 42;
  latest.camera.distance = 70;
  latest.provider.model = "updated-model";
  assert.deepEqual(h.preview.view(latest), withMotionLayer(latest, "pose", asset("one")));
  assert.deepEqual(getMotionLayerAssets(h.preview.view(latest)).expression, original.motion,
    "previewing a new pose retains the former legacy facial content");
  assert.deepEqual(latest.motion, original.motion);
  assert.deepEqual(h.states.map(state => state.phase), ["loading", "playing"]);
});

test("idle stop does not reapply the stage, and state getter returns an independent snapshot", async () => {
  const h = harness();
  await h.preview.stop();
  assert.equal(h.applied.length, 0);
  assert.deepEqual(h.states, []);
  await h.preview.start("gene", motion("one"));
  const snapshot = h.preview.state;
  snapshot.phase = "idle";
  snapshot.name = "changed outside";
  assert.equal(h.preview.state.phase, "playing");
  assert.equal(h.preview.state.name, "Motion one");
});

test("stop during IPC loading restores the latest saved state and ignores its late success or failure", async () => {
  for (const reject of [false, true]) {
    const waiting = deferred<AssetRef>();
    const h = harness({ load: () => waiting.promise });
    const starting = h.preview.start("gene", motion("late"));
    h.saved.camera.distance = 80;
    await h.preview.stop();
    assert.deepEqual(h.applied, [h.saved]);
    if (reject) waiting.reject(new Error("outdated error")); else waiting.resolve(asset("late"));
    assert.equal(await starting, false);
    assert.equal(h.applied.length, 1);
    assert.deepEqual(h.states.map(state => state.phase), ["loading", "idle"]);
  }
});

test("a later selected preview owns playback even when an earlier IPC rejects last", async () => {
  const first = deferred<AssetRef>();
  const second = deferred<AssetRef>();
  const h = harness({ load: (_, id) => id === "one" ? first.promise : second.promise });
  const one = h.preview.start("gene", motion("one"));
  const two = h.preview.start("gene", motion("two"));
  second.resolve(asset("two"));
  assert.equal(await two, true);
  first.reject(new Error("stale first request"));
  assert.equal(await one, false);
  assert.deepEqual(h.applied.map(value => value.motion?.name ?? null), [null, "two.vmd"]);
  assert.equal(h.states.at(-1)?.motionId, "two");
});

test("model or saved-motion changes cancel preview through view without recursively applying", async () => {
  const pending = deferred<AssetRef>();
  const h = harness({ load: () => pending.promise });
  const starting = h.preview.start("gene", motion("one"));
  h.saved.model = { path: "/models/another.pmx", url: "mmd-asset://another/model.pmx", name: "another.pmx" };
  assert.equal(h.preview.view(h.saved), h.saved);
  pending.resolve(asset("one"));
  assert.equal(await starting, false);
  assert.equal(h.applied.length, 0);
  assert.equal(h.states.at(-1)?.phase, "idle");

  const active = harness();
  await active.preview.start("gene", motion("one"));
  const before = active.applied.length;
  active.saved.motion = asset("user-enabled");
  assert.equal(active.preview.view(active.saved), active.saved);
  assert.equal(active.applied.length, before);
  assert.equal(active.states.at(-1)?.phase, "idle");
});

test("replaying the same motion clears the previous local clip and starts it again", async () => {
  const h = harness();
  await h.preview.start("gene", motion("repeat"));
  await h.preview.start("gene", motion("repeat"));
  assert.deepEqual(h.applied.map(value => value.motion?.name ?? null), [null, "repeat.vmd", null, "repeat.vmd"]);
  assert.equal(h.loaded.length, 2);
  await h.preview.stop();
  assert.deepEqual(h.applied.at(-1), h.saved);
  assert.equal(h.preview.view(h.saved), h.saved);
});

test("a failed replacement preview restores the saved motion rather than the previous temporary motion", async () => {
  const failure = new Error("invalid reviewed VMD");
  const h = harness({ load: async (_, id) => { if (id === "bad") throw failure; return asset(id); } });
  await h.preview.start("gene", motion("good"));
  h.saved.camera.pitch = 15;
  await assert.rejects(h.preview.start("gene", motion("bad")), error => error === failure);
  assert.deepEqual(h.applied.at(-1), h.saved);
  assert.equal(h.states.at(-1)?.phase, "idle");
});

test("stop waits for an in-progress clear and restores current settings without late preview application", async () => {
  const clearing = deferred<void>();
  const h = harness({ apply: async (_, count) => { if (count === 1) await clearing.promise; } });
  const starting = h.preview.start("gene", motion("one"));
  await until(() => h.applied.length === 1);
  const stopping = h.preview.stop();
  h.saved.camera.yaw = 89;
  clearing.resolve();
  assert.equal(await starting, false);
  await stopping;
  assert.deepEqual(h.applied.map(value => value.motion?.name ?? null), [null, "saved.vmd"]);
  assert.equal(h.applied.at(-1)?.camera.yaw, 89);
});

test("two simultaneous stops preserve the queued saved-motion restore after a pending preview apply", async () => {
  const playing = deferred<void>();
  let renderedMotion: AssetRef | null = asset("saved");
  const h = harness({ apply: async (value, count) => {
    if (count === 2) await playing.promise;
    renderedMotion = value.motion;
  } });
  const starting = h.preview.start("gene", motion("one"));
  await until(() => h.applied.length === 2);
  const firstStop = h.preview.stop();
  let secondStopFinished = false;
  const secondStop = h.preview.stop().then(() => { secondStopFinished = true; });
  await Promise.resolve();
  assert.equal(secondStopFinished, false, "a repeated stop waits for the existing restore");
  h.saved.camera.yaw = 67;
  playing.resolve();
  assert.equal(await starting, false);
  await Promise.all([firstStop, secondStop]);
  assert.deepEqual(renderedMotion, h.saved.motion);
  assert.deepEqual(h.applied.map(value => value.motion?.name ?? null), [null, "one.vmd", "saved.vmd"]);
  assert.equal(h.applied.at(-1)?.camera.yaw, 67);
  assert.equal(h.preview.state.phase, "idle");
});

test("repeated idle stops wait for failure recovery queued behind an older pending preview apply", async () => {
  const playing = deferred<void>();
  const failure = new Error("replacement preview is invalid");
  let renderedMotion: AssetRef | null = asset("saved");
  const h = harness({
    load: async (_, id) => { if (id === "bad") throw failure; return asset(id); },
    apply: async (value, count) => {
      if (count === 2) await playing.promise;
      renderedMotion = value.motion;
    },
  });
  const first = h.preview.start("gene", motion("one"));
  await until(() => h.applied.length === 2);
  const failed = h.preview.start("gene", motion("bad"));
  const rejected = assert.rejects(failed, error => error === failure);
  await until(() => h.preview.state.phase === "idle");
  const firstStop = h.preview.stop();
  const secondStop = h.preview.stop();
  h.saved.camera.distance = 93;
  playing.resolve();
  assert.equal(await first, false);
  await Promise.all([rejected, firstStop, secondStop]);
  assert.deepEqual(renderedMotion, h.saved.motion, "the failed replacement restores the saved clip, not the prior preview");
  assert.deepEqual(h.applied.map(value => value.motion?.name ?? null), [null, "one.vmd", "saved.vmd"]);
  assert.equal(h.applied.at(-1)?.camera.distance, 93);
  assert.equal(h.preview.state.phase, "idle");
});

test("new preview wins a pending old playback failure and stale errors are not surfaced", async () => {
  const playing = deferred<void>();
  const h = harness({ apply: async (_, count) => { if (count === 2) await playing.promise; } });
  const first = h.preview.start("gene", motion("one"));
  await until(() => h.applied.length === 2);
  const next = h.preview.start("gene", motion("two"));
  playing.reject(new Error("old model load failed"));
  assert.equal(await first, false);
  assert.equal(await next, true);
  assert.deepEqual(h.applied.map(value => value.motion?.name ?? null), [null, "one.vmd", null, "two.vmd"]);
  assert.equal(h.states.at(-1)?.motionId, "two");
});

test("missing model refuses IPC and dispose ignores both loading and in-progress clear completions", async () => {
  const empty = harness();
  empty.saved.model = null;
  await assert.rejects(empty.preview.start("gene", motion("one")), /先载入模型/);
  assert.equal(empty.loaded.length, 0);
  assert.equal(empty.applied.length, 0);

  const pending = deferred<AssetRef>();
  const loading = harness({ load: () => pending.promise });
  const starting = loading.preview.start("gene", motion("one"));
  loading.preview.dispose();
  const stateCount = loading.states.length;
  pending.reject(new Error("disposed request"));
  assert.equal(await starting, false);
  assert.equal(loading.states.length, stateCount);
  assert.equal(loading.applied.length, 0);
  await loading.preview.stop();
  assert.equal(await loading.preview.start("gene", motion("two")), false);

  const clearing = deferred<void>();
  const active = harness({ apply: async (_, count) => { if (count === 1) await clearing.promise; } });
  const previewing = active.preview.start("gene", motion("one"));
  await until(() => active.applied.length === 1);
  active.preview.dispose();
  clearing.resolve();
  assert.equal(await previewing, false);
  assert.equal(active.applied.length, 1, "there is no additional apply after disposal");
});

test("expression preview replaces only its channel and stop restores the latest saved layers", async () => {
  const h = harness();
  h.saved = withMotionLayer(h.saved, "gesture", asset("wave"));
  h.saved = withMotionLayer(h.saved, "expression", asset("happy"));
  const original = structuredClone(h.saved);
  assert.equal(await h.preview.start("gene", motion("angry"), "expression"), true);
  assert.deepEqual(h.applied.map(value => getMotionLayerAssets(value)), [
    { pose: asset("saved"), gesture: asset("wave"), expression: null },
    { pose: asset("saved"), gesture: asset("wave"), expression: asset("angry") },
  ]);
  assert.deepEqual(h.saved, original, "temporary channels never write the saved settings");
  assert.equal(h.preview.state.layer, "expression");
  h.saved = withMotionLayer(h.saved, "gesture", asset("point"));
  h.saved.camera.yaw = 54;
  await h.preview.stop();
  assert.deepEqual(h.applied.at(-1), h.saved);
  assert.deepEqual(getMotionLayerAssets(h.applied.at(-1)!), {
    pose: asset("saved"), gesture: asset("point"), expression: asset("happy"),
  });
});

test("switching preview channels removes the previous temporary channel and preserves saved companions", async () => {
  const h = harness();
  h.saved = withMotionLayer(h.saved, "gesture", asset("wave"));
  h.saved = withMotionLayer(h.saved, "expression", asset("happy"));
  await h.preview.start("gene", motion("pose-preview"), "pose");
  await h.preview.start("genea-2022-gestures", motion("gesture-preview"), "gesture");
  assert.deepEqual(getMotionLayerAssets(h.applied.at(-1)!), {
    pose: asset("saved"), gesture: asset("gesture-preview"), expression: asset("happy"),
  });
  assert.equal(h.preview.state.layer, "gesture");
  assert.deepEqual(getMotionLayerAssets(h.preview.view(h.saved)), getMotionLayerAssets(h.applied.at(-1)!));
});

test("a saved overlay change invalidates pending and playing previews across any target channel", async () => {
  for (const changed of ["gesture", "expression"] as const) {
    const waiting = deferred<AssetRef>();
    const h = harness({ load: () => waiting.promise });
    h.saved = withMotionLayer(h.saved, "gesture", asset("wave"));
    const starting = h.preview.start("gene", motion("late-face"), "expression");
    h.saved = withMotionLayer(h.saved, changed, asset("enabled-elsewhere"));
    waiting.resolve(asset("late-face"));
    assert.equal(await starting, false);
    assert.equal(h.applied.length, 0);
    assert.equal(h.preview.state.phase, "idle");
  }
  const h = harness();
  await h.preview.start("gene", motion("temporary-face"), "expression");
  h.saved = withMotionLayer(h.saved, "expression", asset("saved"));
  assert.equal(h.preview.view(h.saved), h.saved,
    "explicit separation invalidates legacy preview even when paths are identical");
  assert.equal(h.preview.state.phase, "idle");
});

test("stopping a queued expression preview restores companions without applying its late face", async () => {
  const clearing = deferred<void>();
  const h = harness({ apply: async (_, count) => { if (count === 1) await clearing.promise; } });
  h.saved = withMotionLayer(h.saved, "gesture", asset("wave"));
  h.saved = withMotionLayer(h.saved, "expression", asset("happy"));
  const starting = h.preview.start("gene", motion("late-face"), "expression");
  await until(() => h.applied.length === 1);
  const stopping = h.preview.stop();
  h.saved = withMotionLayer(h.saved, "pose", asset("new-pose"));
  clearing.resolve();
  assert.equal(await starting, false);
  await stopping;
  assert.deepEqual(h.applied.at(-1), h.saved);
  assert.deepEqual(h.applied.map(value => getMotionLayerAssets(value).expression?.name ?? null), [null, "happy.vmd"]);
});
