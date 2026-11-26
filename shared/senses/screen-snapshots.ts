/** Runtime-only screen cache controls; no device consent is persisted. */
export interface ScreenSnapshotOptions {
  enabled: boolean;
  intervalSeconds: number;
}

export interface ScreenSnapshotState extends ScreenSnapshotOptions {
  active: boolean;
  pending: boolean;
  capturedAt: number | null;
}

export const DEFAULT_SCREEN_SNAPSHOT_OPTIONS: Readonly<ScreenSnapshotOptions> = Object.freeze({
  enabled: false,
  intervalSeconds: 10,
});
export const SCREEN_SNAPSHOT_INTERVAL = Object.freeze({ min: 2, max: 300 });

export function validateScreenSnapshotOptions(value: unknown, current: ScreenSnapshotOptions): ScreenSnapshotOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('自动截图设置格式不正确。');
  const patch = value as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => key !== 'enabled' && key !== 'intervalSeconds')) throw new Error('只允许修改自动截图开关和间隔。');
  if ('enabled' in patch && typeof patch.enabled !== 'boolean') throw new Error('自动截图开关不正确。');
  if ('intervalSeconds' in patch && (typeof patch.intervalSeconds !== 'number' || !Number.isInteger(patch.intervalSeconds)
    || patch.intervalSeconds < SCREEN_SNAPSHOT_INTERVAL.min || patch.intervalSeconds > SCREEN_SNAPSHOT_INTERVAL.max))
    throw new Error('自动截图间隔须为 2 到 300 的整数秒。');
  return { ...current, ...patch } as ScreenSnapshotOptions;
}
