import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSettings } from "../src/ui/settings-merge";
test("host clears unchanged cloned layer assets while preserving a concurrent edit in another channel", () => {
  const asset = (name: string) => ({ path: `${name}.vmd`, url: `mmd-asset://test/${name}.vmd`, name });
  const sent = { motion: asset("stand"), motionLayers: { gesture: asset("talk") as ReturnType<typeof asset> | null, expression: asset("happy") }, camera: { yaw: 0 } };
  const current = structuredClone(sent);
  current.motionLayers.expression = asset("angry");
  current.camera.yaw = 12;
  const accepted = { ...structuredClone(sent), motionLayers: { gesture: null, expression: asset("happy") } };
  const merged = mergeSettings<typeof sent>(sent, current, accepted);
  assert.equal(merged.motionLayers.gesture, null);
  assert.equal(merged.motionLayers.expression.name, "angry");
  assert.equal(merged.camera.yaw, 12);
  assert.deepEqual(mergeSettings(sent.motion, structuredClone(sent.motion), null), null);
});
test("settings acknowledge normalized fields without losing camera edits made during save", () => {
  const sent = {
    camera: { yaw: 30, pitch: 0 },
    provider: { key: "secret" },
    model: null as null | { name: string },
  };
  const current = structuredClone(sent);
  current.camera.yaw = 60;
  const accepted = structuredClone(sent);
  accepted.provider.key = "••••••••";
  accepted.model = { name: "picked.pmx" };
  const merged = mergeSettings(sent, current, accepted);
  assert.equal(merged.camera.yaw, 60);
  assert.equal(merged.provider.key, "••••••••");
  assert.deepEqual(merged.model, accepted.model);
});
test("settings can accept native selection and preserve a newer local clear independently", () => {
  const sent = {
    model: { name: "old" } as { name: string } | null,
    motion: { name: "old.vmd" } as { name: string } | null,
  };
  assert.deepEqual(
    mergeSettings(
      sent,
      { ...sent, motion: null },
      { model: { name: "new" }, motion: sent.motion },
    ),
    { model: { name: "new" }, motion: null },
  );
});
