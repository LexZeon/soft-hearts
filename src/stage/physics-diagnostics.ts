// The local physics' per-part diagnostics (moved from model-physics.ts unchanged in meaning, R01 2026-11-17, to keep that file
// under 40 KB): actual weighted display deltas, suitable for bounded native QA evidence.
import { Quaternion, Vector3, type Camera } from "three";
import type { BoneLayer } from "./model-physics";

const IDENTITY = new Quaternion();

export interface PartDiagnostics {
  weight: number; maxAngle: number; maxDisplacement: number; stepMs: number; springMs: number; solverIterations: number;
  frameSerial: number; maxFrameAngle: number; maxFrameDisplacement: number;
  /** Actual scene/world units at the current model scale, not screen pixels. */
  maxWorldDownward: number; maxWorldFrameDisplacement: number; outputBoneCount: number;
  maxScreenFrameDisplacementDip: number | null; screenSampleCount: number;
  samples: { boneIndex: number; localQuatDelta: number[]; positionDelta: number[] }[];
}

const validPosition = (value: Vector3) => [value.x, value.y, value.z].every(Number.isFinite);

export function partDiagnostics(layers: readonly BoneLayer[], weight: number, applied: boolean, camera: Camera | undefined,
  viewport: { width: number; height: number } | undefined,
  counts: Pick<PartDiagnostics, "stepMs" | "springMs" | "solverIterations" | "frameSerial" | "maxFrameAngle" | "maxFrameDisplacement" | "maxWorldFrameDisplacement" | "outputBoneCount">): PartDiagnostics {
  let maxAngle = 0, maxDisplacement = 0, maxWorldDownward = 0;
  const worldPosition = new Vector3();
  const currentScreen = new Vector3(), previousScreen = new Vector3();
  const projectionAvailable = camera && viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)
    && viewport.width > 0 && viewport.height > 0;
  let maxScreenFrameDisplacementDip: number | null = null, screenSampleCount = 0;
  const samples: { boneIndex: number; localQuatDelta: number[]; positionDelta: number[] }[] = [];
  for (const layer of layers) {
    if (!layer.output) continue;
    const rotation = weight > 0 ? layer.baseQuaternion.clone().invert().multiply(layer.appliedQuaternion).normalize() : new Quaternion();
    const offset = weight > 0 ? layer.appliedPosition.clone().sub(layer.basePosition) : new Vector3();
    maxAngle = Math.max(maxAngle, IDENTITY.angleTo(rotation));
    maxDisplacement = Math.max(maxDisplacement, offset.length());
    if (weight > 0) maxWorldDownward = Math.max(maxWorldDownward,
      layer.baseWorldPosition.y - layer.bone.getWorldPosition(worldPosition).y);
    if (projectionAvailable && layer.previousWorldValid && applied) {
      currentScreen.copy(layer.previousWorldPosition).project(camera);
      previousScreen.copy(layer.previousWorldPosition).sub(layer.worldFrameDelta).project(camera);
      const inView = (p: Vector3) => validPosition(p) && p.z >= -1 && p.z <= 1 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05;
      if (inView(currentScreen) && inView(previousScreen)) {
        const distance = Math.hypot((currentScreen.x - previousScreen.x) * viewport.width / 2,
          (currentScreen.y - previousScreen.y) * viewport.height / 2);
        maxScreenFrameDisplacementDip = Math.max(maxScreenFrameDisplacementDip ?? 0, distance);
        screenSampleCount++;
      }
    }
    if (samples.length < 4) samples.push({ boneIndex: layer.index, localQuatDelta: rotation.toArray(), positionDelta: offset.toArray() });
  }
  return { weight, maxAngle, maxDisplacement, samples, maxWorldDownward, maxScreenFrameDisplacementDip, screenSampleCount, ...counts };
}
