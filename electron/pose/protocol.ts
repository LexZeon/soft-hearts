/**
 * Messages between the main process and the pose inference process (utilityProcess), and between the
 * inference process and the hidden sensor window (MessagePort). The host validates every message from the
 * inference process with `parseWorkerMessage`; anything else is dropped.
 */
import { parsePoseSignal, POSE_LEVELS, type PoseLevel, type PoseSignal } from '../../shared/pose-signals';

export interface WorkerInit {
  type: 'init';
  /** Absolute path of the onnxruntime-node package folder inside the component directory. */
  runtimeEntry: string;
  detector: string; detectorSha256: string;
  pose: string; poseSha256: string;
  /** Cached result for this computer (same fingerprint): skip the full self-test. */
  prefer: 'dml' | 'cpu' | null;
  /** DirectML failed here before: go straight to the CPU. */
  dmlBad: boolean;
}
export type HostToWorker = WorkerInit | { type: 'port' } | { type: 'pressure'; on: boolean } | { type: 'stop' };

export type WorkerToHost =
  | { type: 'ready'; route: 'dml' | 'cpu'; level: PoseLevel; p90: { dml: number | null; cpu: number | null }; dmlBad: boolean }
  | { type: 'signal'; signal: PoseSignal }
  | { type: 'route'; route: 'cpu' }
  | { type: 'level'; level: PoseLevel }
  | { type: 'paused' }
  | { type: 'failed'; reason: 'runtime' | 'models' | 'no-route' };

/** Sensor window ⇄ inference process. */
export type SensorToWorker = { type: 'frame'; width: number; height: number; data: ArrayBuffer };
export type WorkerToSensor = { type: 'fps'; fps: number } | { type: 'ack'; fps: number };

const ms = (n: unknown) => n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 120_000);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join() === [...expected].sort().join();

export function parseWorkerMessage(value: unknown): WorkerToHost | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'ready': {
      const p = v.p90 as Record<string, unknown> | null;
      if (!keys(v, ['type', 'route', 'level', 'p90', 'dmlBad']) || (v.route !== 'dml' && v.route !== 'cpu') || !(POSE_LEVELS as readonly unknown[]).includes(v.level)
        || typeof v.dmlBad !== 'boolean' || !p || typeof p !== 'object' || !keys(p, ['dml', 'cpu']) || !ms(p.dml) || !ms(p.cpu)) return null;
      return { type: 'ready', route: v.route, level: v.level as PoseLevel, p90: { dml: p.dml as number | null, cpu: p.cpu as number | null }, dmlBad: v.dmlBad };
    }
    case 'signal': {
      if (!keys(v, ['type', 'signal'])) return null;
      const signal = parsePoseSignal(v.signal);
      return signal ? { type: 'signal', signal } : null;
    }
    case 'route': return keys(v, ['type', 'route']) && v.route === 'cpu' ? { type: 'route', route: 'cpu' } : null;
    case 'level': return keys(v, ['type', 'level']) && (POSE_LEVELS as readonly unknown[]).includes(v.level) ? { type: 'level', level: v.level as PoseLevel } : null;
    case 'paused': return keys(v, ['type']) ? { type: 'paused' } : null;
    case 'failed': return keys(v, ['type', 'reason']) && (v.reason === 'runtime' || v.reason === 'models' || v.reason === 'no-route') ? { type: 'failed', reason: v.reason } : null;
    default: return null;
  }
}

/** Frames from the sensor window: RGBA, at most 640×480 (the window sends ≤ 320×240). */
export function parseSensorFrame(value: unknown): { width: number; height: number; rgba: Uint8Array } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const width = v.width, height = v.height, data = v.data;
  if (v.type !== 'frame' || typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height)
    || width < 16 || height < 16 || width > 640 || height > 480) return null;
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
  return bytes && bytes.byteLength === width * height * 4 ? { width, height, rgba: bytes } : null;
}
