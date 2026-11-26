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

/**
 * 2026-11-26 (docs/claude/2026-11-26-update-blank-card.md): a preinstalled model is the same model wherever the app is installed. A source
 * ZIP unpacked into a new folder, or each packaged build in its own versioned folder, puts the bundled files at a new absolute path while the
 * settings and older cards still hold the old one. What identifies a bundled model is where it sits inside an app's `assets/bundled/`
 * folder: the factory Gene at `mmdagent-ex/gene/<revision>/model/gene.pmx` (any pinned revision), One and Mumi at their manifest paths.
 * Returns its key, or null for any other file (a model the user loaded keeps being compared by its own path).
 */
const GENE_BUNDLED_TAIL = /\/assets\/bundled\/mmdagent-ex\/gene\/[0-9a-f]{40}\/model\/gene\.pmx$/u;
export function bundledModelKeyForInstalledPath(modelPath: string | null | undefined): string | null {
  if (typeof modelPath !== 'string' || !modelPath) return null;
  const clean = modelPath.replace(/\\/gu, '/').replace(/\/+/gu, '/').toLowerCase();
  if (GENE_BUNDLED_TAIL.test(clean)) return GENE_MODEL_KEY;
  return BUNDLED_CHARACTER_MODELS.find(model => clean.endsWith(`/assets/bundled/${model.model.toLowerCase()}`))?.key ?? null;
}

/** A card's or the stage's model reference in the form cards compare by: a bundled model's key (from any install folder), else as given. */
export function canonicalModelReference<T extends string | null | undefined>(reference: T): T | string {
  if (isBundledModelKey(reference)) return reference;
  return bundledModelKeyForInstalledPath(reference) ?? reference;
}
