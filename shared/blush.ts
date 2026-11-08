/** Model-local positioning, expressed in the unmodified reference eye spacing. */
export interface BlushCalibration {
  eyeOffsetX: number;
  eyeOffsetY: number;
  eyeSpacingScale: number;
  mouthOffsetX: number;
  mouthOffsetY: number;
}

export const DEFAULT_BLUSH_CALIBRATION: Readonly<BlushCalibration> = Object.freeze({
  eyeOffsetX: 0,
  eyeOffsetY: 0,
  eyeSpacingScale: 1,
  mouthOffsetX: 0,
  mouthOffsetY: 0,
});

export interface BlushCalibrationView {
  /** Content identity only; no model path, character identity or private record. */
  modelKey: string | null;
  calibration: BlushCalibration;
  revision: number;
  storageError?: string;
}

export function validateBlushCalibration(value: unknown): BlushCalibration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('脸红定位校准格式不正确。');
  const input = value as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_BLUSH_CALIBRATION) as (keyof BlushCalibration)[];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_BLUSH_CALIBRATION, key)))
    throw new Error('脸红定位校准只接受完整的眼位、眼距和嘴部偏移。');
  const result = {} as BlushCalibration;
  for (const key of keys) {
    const item = input[key];
    const low = key === 'eyeSpacingScale' ? 0.5 : -0.5;
    const high = key === 'eyeSpacingScale' ? 1.5 : 0.5;
    if (typeof item !== 'number' || !Number.isFinite(item) || item < low || item > high)
      throw new Error(`脸红定位校准 ${key} 必须为 ${low}～${high} 的有限数值。`);
    result[key] = item;
  }
  return result;
}
