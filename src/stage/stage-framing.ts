import { MathUtils } from 'three';
import type { CameraConfig } from '../../shared/contracts';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { sameFramingCamera } from '../../shared/pet-framing';

/**
 * Share of the viewport height above the model that framing keeps clear for the pet's hover toolbar
 * (2026-11-02 P4). In the default 400x560 pet window the expanded toolbar is three rows (12 buttons
 * wrap into two, plus the window-size readout) ending 97 px down, and it reveals itself for a pointer
 * 24 px below that: 121 px. 0.22 x 560 = 123 px. Applied in every window, so the controls preview and
 * the pet frame to the same camera; a pet whose toolbar reaches lower (narrow or small windows) uses
 * its measured reach instead (framingTopBand).
 */
export const FRAMING_TOP_BAND = 0.22;
const MAX_TOP_BAND = 0.35;

export type FramingPreset = 'full' | 'portrait';
/** Model bind-pose bounds in world units (MmdStage measures them on load). */
export interface FramingModel { height: number; width: number; baseY: number; centerX: number; }
export interface FramingView {
  aspect: number;
  fov: number;
  /** Share of the viewport height, from the top, the model must stay below (clamped to 0..0.35). */
  topBand?: number;
}

/**
 * Full or portrait framing. Without a top band this is the original rule (full: 6% of the model
 * height above and below; portrait: upper body from 46.5% to 103.5%). A top band lifts only the
 * upper edge of the visible range until the model's top sits at or below the band, so the crown
 * pat region is never under the toolbar; the lower edge (feet, or the portrait cut) stays put.
 */
export function framingCamera(preset: FramingPreset, model: FramingModel, view: FramingView): CameraConfig {
  const portrait = preset === 'portrait';
  const visibleHeight = model.height * (portrait ? 0.57 : 1.12);
  const visibleWidth = portrait ? model.height * 0.46 : model.width * 1.12;
  const centerY = model.baseY + model.height * (portrait ? 0.75 : 0.5);
  const low = centerY - visibleHeight / 2, high = centerY + visibleHeight / 2, top = model.baseY + model.height;
  const band = MathUtils.clamp(Number.isFinite(view.topBand) ? view.topBand! : 0, 0, MAX_TOP_BAND);
  const lifted = band > 0 ? Math.max(high, (top - band * low) / (1 - band)) : high;
  const span = lifted === high ? visibleHeight : lifted - low;
  const distance = Math.max(span, visibleWidth / (view.aspect || 1)) / (2 * Math.tan(MathUtils.degToRad(view.fov / 2)));
  return { yaw: 0, pitch: 0, distance, targetY: lifted === high ? centerY : (low + lifted) / 2, targetX: model.centerX, targetZ: 0, fov: view.fov };
}

/** The band a pet frames with: the shared band, or the measured toolbar when it reaches lower (narrow windows). */
export function framingTopBand(viewportHeight: number, reservedTopPixels = 0): number {
  const measured = viewportHeight > 0 && Number.isFinite(reservedTopPixels) && reservedTopPixels > 0 ? reservedTopPixels / viewportHeight : 0;
  return Math.min(MAX_TOP_BAND, Math.max(FRAMING_TOP_BAND, measured));
}

/**
 * The shipped default camera (distance 30, target height 10) was never framed for any model: a fresh
 * profile, "use bundled model" and "restore defaults" save it. On the bundled Gene it puts the crown
 * above the pet window (P4). The pet replaces it with full framing before the model's first frame.
 */
export const isUnframedCamera = (camera: CameraConfig): boolean => sameFramingCamera(camera, DEFAULT_SETTINGS.camera);
