/**
 * The preinstalled characters' models (0.2.0, docs/claude/2026-11-25-six-presets.md). A card carries a bundled model as a short key, never a
 * path: `bundled:gene` (the factory Gene, its own manifest in shared/actions/bundled-assets.json), `bundled:one` and `bundled:mumi`
 * (shared/cards/bundled-characters.json, under assets/bundled/). Pure: no Node, DOM or Electron; the host checks and registers the files
 * (electron/cards/bundled-character-models.ts).
 */
import manifest from './bundled-characters.json';

/** Kept equal to BUNDLED_CHARACTER_MODEL in character-cards.ts (this file may not import it: that one imports this). */
export const GENE_MODEL_KEY = 'bundled:gene';

export interface BundledCharacterFile { path: string; bytes: number; sha256: string }
export interface BundledCharacterModel { key: string; name: string; /** Relative to assets/bundled/. */ model: string; files: BundledCharacterFile[] }

export const BUNDLED_CHARACTER_MODELS: readonly BundledCharacterModel[] = manifest.models;

/** Every key a card may carry as a bundled model. */
export function isBundledModelKey(value: unknown): value is string {
  return value === GENE_MODEL_KEY || BUNDLED_CHARACTER_MODELS.some(model => model.key === value);
}

/** What a card shows as its model name for a bundled key. */
export function bundledModelName(key: string): string {
  return BUNDLED_CHARACTER_MODELS.find(model => model.key === key)?.name ?? 'Gene';
}

export const bundledCharacterModel = (key: string): BundledCharacterModel | undefined => BUNDLED_CHARACTER_MODELS.find(model => model.key === key);
