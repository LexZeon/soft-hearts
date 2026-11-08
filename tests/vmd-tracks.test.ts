import assert from "node:assert/strict";
import test from "node:test";
import { stripDefaultVmdTracks, type VmdBoneFrame, type VmdMorphFrame } from "../src/stage/vmd-tracks";

const bone = (boneName: string, frameNum: number, position = [0, 0, 0], rotation = [0, 0, 0, 1]): VmdBoneFrame & { interpolation: number[] } =>
  ({ boneName, frameNum, position, rotation, interpolation: [20, 107] });
const morph = (morphName: string, frameNum: number, weight: number): VmdMorphFrame => ({ morphName, frameNum, weight });
const source = (motions: VmdBoneFrame[], morphs: VmdMorphFrame[] = []) => ({
  metadata: { motionCount: motions.length, morphCount: morphs.length, magic: "Vocaloid Motion Data 0002", cameraCount: 1 },
  motions, morphs, cameras: [{ frameNum: 1000 }], coordinateSystem: "right",
});

test("only whole default bone and zero morph tracks are removed, including quaternion sign equivalents", () => {
  const input = source([
    bone("center", 0), bone("wave", 0), bone("center", 90, [-0, 0, 0], [0, 0, 0, -1]),
    bone("wave", 45, [0, 1, 0]), bone("wave", 90),
  ], [morph("off", 0, 0), morph("blink", 0, 0), morph("off", 120, -0), morph("blink", 30, 1), morph("blink", 60, 0)]);
  const { vmd, report } = stripDefaultVmdTracks(input);
  assert.deepEqual(vmd.motions.map(frame => frame.boneName), ["wave", "wave", "wave"]);
  assert.deepEqual(vmd.morphs.map(frame => frame.morphName), ["blink", "blink", "blink"]);
  assert.deepEqual(report.removedBoneNames, ["center"]);
  assert.deepEqual(report.removedMorphNames, ["off"]);
  assert.deepEqual(report.before, { boneTracks: 2, boneKeyframes: 5, morphTracks: 2, morphKeyframes: 5 });
  assert.deepEqual(report.after, { boneTracks: 1, boneKeyframes: 3, morphTracks: 1, morphKeyframes: 3 });
  assert.equal(vmd.metadata.motionCount, 3);
  assert.equal(vmd.metadata.morphCount, 3);
  assert.equal(report.durationFrames, 120, "removing a static endpoint must not trim the clip's time");
});

test("constant non-default initial poses and nonzero expressions remain intact", () => {
  const angle = Math.PI / 6;
  const rotation = [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
  const input = source([
    bone("lowered-arm", 0, [0, 0, 0], rotation), bone("lowered-arm", 300, [0, 0, 0], rotation.map(value => -value)),
    bone("offset", 0, [0.2, 0, 0]), bone("offset", 300, [0.2, 0, 0]),
  ], [morph("smile", 0, 0.75), morph("smile", 300, 0.75)]);
  const { vmd, report } = stripDefaultVmdTracks(input);
  assert.deepEqual(vmd.motions, input.motions);
  assert.deepEqual(vmd.morphs, input.morphs);
  assert.deepEqual(report.keptStaticPoseNames, ["lowered-arm", "offset"]);
  assert.deepEqual(report.keptStaticMorphNames, ["smile"]);
  assert.deepEqual(report.removedBoneNames, []);
  assert.deepEqual(report.removedMorphNames, []);
});

test("dynamic tracks returning to the default pose are preserved and small translations are not treated as zero", () => {
  const input = source([
    bone("arm", 0), bone("arm", 15, [0, 0, 0], [0, 0, 0.1, Math.sqrt(0.99)]), bone("arm", 30),
    bone("tiny", 0), bone("tiny", 15, [Number.EPSILON, 0, 0]), bone("tiny", 30),
  ], [morph("tiny-morph", 0, 0), morph("tiny-morph", 1, Number.EPSILON), morph("tiny-morph", 2, 0)]);
  const { vmd, report } = stripDefaultVmdTracks(input);
  assert.deepEqual(vmd.motions, input.motions);
  assert.deepEqual(vmd.morphs, input.morphs);
  assert.equal(report.after.boneTracks, 2);
  assert.equal(report.after.morphTracks, 1);
});

test("invalid or nonfinite transforms are kept conservatively rather than called motionless", () => {
  const input = source([
    bone("zero-quaternion", 0, [0, 0, 0], [0, 0, 0, 0]),
    bone("scaled-quaternion", 0, [0, 0, 0], [0, 0, 0, 2]),
    bone("nan", 0, [NaN, 0, 0]),
    bone("short", 0, [0, 0]),
    bone("bad-time", -1),
  ], [morph("infinite", 0, Infinity), morph("bad-time", NaN, 0)]);
  const { vmd, report } = stripDefaultVmdTracks(input);
  assert.deepEqual(vmd.motions, input.motions);
  assert.deepEqual(vmd.morphs, input.morphs);
  assert.deepEqual(report.removedBoneNames, []);
  assert.deepEqual(report.removedMorphNames, []);
  assert.deepEqual(report.keptStaticPoseNames, []);
});

test("filtering does not mutate source arrays, frames, interpolation or unrelated VMD sections", () => {
  const input = source([bone("default", 0), bone("pose", 0, [0, 1, 0])], [morph("off", 1, 0)]);
  const before = structuredClone(input);
  Object.freeze(input.metadata);
  input.motions.forEach(frame => { Object.freeze(frame.position); Object.freeze(frame.rotation); Object.freeze(frame); });
  Object.freeze(input.motions); Object.freeze(input.morphs);
  const { vmd } = stripDefaultVmdTracks(input);
  assert.deepEqual(input, before);
  assert.notEqual(vmd, input);
  assert.notEqual(vmd.metadata, input.metadata);
  assert.equal(vmd.motions[0], input.motions[1], "remaining keyframes are byte-value-equivalent original frame objects");
  assert.equal(vmd.cameras, input.cameras);
  assert.equal(vmd.coordinateSystem, "right");
  assert.equal(vmd.metadata.cameraCount, 1);
});

test("all-default and empty motions remain valid data and retain original duration separately", () => {
  const { vmd, report } = stripDefaultVmdTracks(source([bone("center", 0), bone("center", 600)], [morph("off", 900, 0)]));
  assert.deepEqual(vmd.motions, []);
  assert.deepEqual(vmd.morphs, []);
  assert.equal(vmd.metadata.motionCount, 0);
  assert.equal(vmd.metadata.morphCount, 0);
  assert.equal(report.durationFrames, 900);
  const empty = stripDefaultVmdTracks(source([]));
  assert.equal(empty.report.durationFrames, 0);
  assert.deepEqual(empty.report.removedBoneNames, []);
});
