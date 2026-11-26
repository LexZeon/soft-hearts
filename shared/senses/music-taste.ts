/**
 * I-077 step 2: her music taste, a small card trait (docs/claude/2026-11-11-i077-step2.md).
 *
 * Three 0..100 whole numbers, 50 = no preference: tempo (slow ... fast), brightness (soft ... bright), energy (calm ... intense).
 * It only scales how engaged she gets while listening (src/stage/music-react/taste.ts): songs she likes get more of her reactions and a
 * livelier dance, songs she does not care for get a lighter version of the same; never none, never a dislike face. A card without the
 * field, or with all three at 50, is exactly what it was before (the field is then left out of the stored card and the export).
 * Pure data: no Electron, no files, nothing Claude-specific.
 */
import type { MusicTaste } from '../foundation/character-card';
export type { MusicTaste };
export const MUSIC_TASTE_AXES = ['tempo', 'brightness', 'energy'] as const;
export type MusicTasteAxis = (typeof MUSIC_TASTE_AXES)[number];
export const NEUTRAL_MUSIC_TASTE: Readonly<MusicTaste> = Object.freeze({ tempo: 50, brightness: 50, energy: 50 });
/** The two ends of each axis, in words (the card editor's labels). */
export const MUSIC_TASTE_ENDS: Readonly<Record<MusicTasteAxis, readonly [string, string]>> = Object.freeze({
  tempo: ['慢歌', '快歌'], brightness: ['柔和的', '明亮的'], energy: ['安静平缓', '热烈有劲'],
});

export const isNeutralMusicTaste = (taste: Readonly<MusicTaste> | null | undefined): boolean =>
  !taste || MUSIC_TASTE_AXES.every(axis => taste[axis] === 50);

/**
 * A taste as stored on a card: exactly the three axes, each a whole number 0..100. All three at 50 gives `undefined` (no field).
 * Anything else throws (the message is shown to the user).
 */
export function validateMusicTaste(value: unknown): MusicTaste | undefined {
  if (value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('她的音乐口味格式不对。');
  const input = value as Record<string, unknown>, out = {} as MusicTaste;
  for (const key of Object.keys(input)) if (!(MUSIC_TASTE_AXES as readonly string[]).includes(key)) throw new Error(`音乐口味里没有「${key}」这一项。`);
  for (const axis of MUSIC_TASTE_AXES) {
    const n = input[axis];
    if (n === undefined) { out[axis] = 50; continue; }
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100) throw new Error('音乐口味的每一项要是 0 到 100 的整数（50 是没有偏好）。');
    out[axis] = n;
  }
  return isNeutralMusicTaste(out) ? undefined : out;
}

/** The taste of a card (neutral when it has none). */
export function musicTasteOf(card: { musicTaste?: unknown } | null | undefined): Readonly<MusicTaste> {
  try { return validateMusicTaste(card?.musicTaste) ?? NEUTRAL_MUSIC_TASTE; } catch { return NEUTRAL_MUSIC_TASTE; }
}
