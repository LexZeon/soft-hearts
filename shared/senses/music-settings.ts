/** Local presentation only. A saved strength never grants audio capture. */
export interface MusicSettings {
  strength: number;
  /**
   * 让她一直跟着跳 (M1, advanced, default off). Off: the music switch only lets her hear, and she decides
   * whether to nod or dance. On: the original R15 behaviour, she dances whenever music plays.
   */
  alwaysDance: boolean;
}
export const DEFAULT_MUSIC_SETTINGS: Readonly<MusicSettings> = Object.freeze({ strength: 0.7, alwaysDance: false });

function own(value: unknown, key: keyof MusicSettings): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
}

export function normalizeMusicSettings(value: unknown, previous?: unknown): MusicSettings {
  const before = own(previous, 'strength');
  const fallback = typeof before === 'number' && Number.isFinite(before)
    ? Math.max(0, Math.min(1, before)) : DEFAULT_MUSIC_SETTINGS.strength;
  const strength = own(value, 'strength');
  const alwaysBefore = own(previous, 'alwaysDance'), always = own(value, 'alwaysDance');
  return { strength: typeof strength === 'number' && Number.isFinite(strength)
    ? Math.max(0, Math.min(1, strength)) : fallback,
  alwaysDance: typeof always === 'boolean' ? always : typeof alwaysBefore === 'boolean' ? alwaysBefore : DEFAULT_MUSIC_SETTINGS.alwaysDance };
}
