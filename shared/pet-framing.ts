import type { CameraConfig } from './contracts';

export type PetFramingPreset = 'full' | 'portrait';
export interface PetFramingState {
  session: string;
  modelGeneration: number;
  cameraRevision: number;
  contextRevision: number;
  modelUrl: string;
  ready: boolean;
  camera: CameraConfig;
}
export interface PetFramingRequest { id: string; preset: PetFramingPreset; expiresAt: number; expected: PetFramingState; }
export interface PetFramingReport { id: string; applied: boolean; state: PetFramingState; }
const keys = (v: unknown, names: readonly string[]): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const fields = Object.getOwnPropertyDescriptors(v);
  return Reflect.ownKeys(fields).length === names.length && names.every(k => fields[k] && 'value' in fields[k]);
};
export const framingId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export function readFramingCamera(v: unknown): CameraConfig {
  if (!keys(v, ['yaw', 'pitch', 'distance', 'targetX', 'targetY', 'targetZ', 'fov'])
    || Object.values(v).some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 10000)
    || (v.distance as number) <= 0 || (v.fov as number) <= 0 || (v.fov as number) >= 180) throw Error('取景相机状态不正确。');
  return { ...v } as unknown as CameraConfig;
}
export function readPetFramingState(v: unknown): PetFramingState {
  if (!keys(v, ['session', 'modelGeneration', 'cameraRevision', 'contextRevision', 'modelUrl', 'ready', 'camera'])
    || !framingId(v.session) || typeof v.ready !== 'boolean' || typeof v.modelUrl !== 'string' || v.modelUrl.length > 4096
    || [v.modelGeneration, v.cameraRevision, v.contextRevision].some(n => !Number.isSafeInteger(n) || (n as number) < 0))
    throw Error('取景目标状态不正确。');
  return { ...v, camera: readFramingCamera(v.camera) } as unknown as PetFramingState;
}
export function readPetFramingReport(v: unknown): PetFramingReport {
  if (!keys(v, ['id', 'applied', 'state']) || !framingId(v.id) || typeof v.applied !== 'boolean') throw Error('取景回执不正确。');
  return { id: v.id, applied: v.applied, state: readPetFramingState(v.state) };
}
export const sameFramingCamera = (a: CameraConfig, b: CameraConfig): boolean =>
  ['yaw', 'pitch', 'distance', 'targetX', 'targetY', 'targetZ', 'fov'].every(k =>
    (k === 'targetZ' ? a.targetZ ?? 0 : (a as unknown as Record<string, number>)[k])
      === (k === 'targetZ' ? b.targetZ ?? 0 : (b as unknown as Record<string, number>)[k]));
export const sameFramingState = (a: PetFramingState, b: PetFramingState): boolean =>
  a.session === b.session && a.modelGeneration === b.modelGeneration && a.cameraRevision === b.cameraRevision
  && a.contextRevision === b.contextRevision && a.modelUrl === b.modelUrl && a.ready === b.ready && sameFramingCamera(a.camera, b.camera);
