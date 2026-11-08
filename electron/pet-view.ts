import type { AppSettings } from "../shared/contracts";
import { validateSettings } from "./validation";
import { DEFAULT_SETTINGS } from "../shared/defaults";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const PET_SIZE = { width: 400, height: 560 };

/** Recover only presentation state; assets, connections and character data stay intact. */
export function petRecovery(
  current: AppSettings,
  area: Bounds,
): { settings: AppSettings; bounds: Bounds } {
  if (![area.x, area.y, area.width, area.height].every(Number.isFinite) || area.width <= 0 || area.height <= 0)
    throw new Error("显示器工作区无效，无法恢复桌宠位置。");
  const scale = fittedPetScale(DEFAULT_SETTINGS.pet.scale ?? 1, area);
  const width = Math.max(1, Math.floor(PET_SIZE.width * scale));
  const height = Math.max(1, Math.floor(PET_SIZE.height * scale));
  return {
    settings: {
      ...current,
      camera: structuredClone(DEFAULT_SETTINGS.camera),
      pet: { ...structuredClone(DEFAULT_SETTINGS.pet), scale },
    },
    bounds: {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    },
  };
}

export function petViewSettings(
  current: AppSettings,
  value: unknown,
): AppSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("桌宠视图设置格式不正确。");
  const view = value as Record<string, unknown>;
  if (
    !Object.keys(view).length ||
    (view.camera === undefined && view.scale === undefined) ||
    Object.keys(view).some((key) => key !== "camera" && key !== "scale")
  )
    throw new Error("桌宠视图只允许修改镜头和大小。");
  if (
    view.scale !== undefined &&
    (typeof view.scale !== "number" || !Number.isFinite(view.scale))
  )
    throw new Error("桌宠大小必须为有限数值。");
  if (view.camera !== undefined) {
    const camera = view.camera as Record<string, unknown>;
    const required = ["yaw", "pitch", "distance", "targetX", "targetY", "fov"];
    if (
      !camera ||
      typeof camera !== "object" ||
      Array.isArray(camera) ||
      Object.keys(camera).some(
        (key) => ![...required, "targetZ"].includes(key),
      ) ||
      required.some(
        (key) =>
          typeof camera[key] !== "number" || !Number.isFinite(camera[key]),
      ) ||
      (camera.targetZ !== undefined &&
        (typeof camera.targetZ !== "number" ||
          !Number.isFinite(camera.targetZ)))
    )
      throw new Error("桌宠镜头设置格式不正确。");
  }
  const next = {
    ...current,
    camera: view.camera ?? current.camera,
    pet: { ...current.pet, scale: view.scale ?? current.pet.scale },
  };
  // A deliberate legacy uniform-scale edit leaves the independent size mode.
  if (view.scale !== undefined && view.scale !== current.pet.scale) delete next.pet.size;
  return validateSettings(next, current);
}

export function sizedPetBounds(current: Bounds, size: { width: number; height: number }, area: Bounds): Bounds {
  const width = Math.max(1, Math.min(size.width, area.width));
  const height = Math.max(1, Math.min(size.height, area.height));
  return clampPetBounds({ ...current, width, height }, area);
}

export function fittedPetScale(scale: number, area: Bounds): number {
  return Math.min(
    Math.max(0.5, Math.min(2, scale)),
    area.width / PET_SIZE.width,
    area.height / PET_SIZE.height,
  );
}
export function clampPetBounds(bounds: Bounds, area: Bounds): Bounds {
  return {
    ...bounds,
    x: Math.round(
      Math.max(area.x, Math.min(area.x + area.width - bounds.width, bounds.x)),
    ),
    y: Math.round(
      Math.max(
        area.y,
        Math.min(area.y + area.height - bounds.height, bounds.y),
      ),
    ),
  };
}
export function scaledPetBounds(
  current: Bounds,
  scale: number,
  area: Bounds,
): { scale: number; bounds: Bounds } {
  const actual = fittedPetScale(scale, area);
  const width = Math.max(1, Math.floor(PET_SIZE.width * actual));
  const height = Math.max(1, Math.floor(PET_SIZE.height * actual));
  return {
    scale: actual,
    bounds: clampPetBounds(
      {
        width,
        height,
        x: current.x + (current.width - width) / 2,
        y: current.y + current.height - height,
      },
      area,
    ),
  };
}
