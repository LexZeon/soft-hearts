// Host side of the preinstalled characters' models (shared/cards/bundled-characters.ts): verify the bundled bytes and give the model a native
// asset grant, the same checks BundledAssets makes for the factory Gene (no symlink, exact size, SHA-256). Paths come from the trusted resource
// folder and the manifest only.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { bundledCharacterModel, BUNDLED_CHARACTER_MODELS, GENE_MODEL_KEY, type BundledCharacterFile } from '../../shared/cards/bundled-characters';
import type { AssetRef } from '../../shared/foundation/settings';
import type { AssetRegistry } from '../foundation/assets';

const damaged = () => new Error('预装资源缺失或损坏，请重新解压完整的软件包。');

/** One manifest file: a plain file (never a link) of the exact size and hash, inside the resource folder. Returns its path. */
async function verifiedFile(directory: string, file: BundledCharacterFile): Promise<string> {
  if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(file.path) || file.path.split('/').some(part => part === '.' || part === '..')) throw damaged();
  try {
    const base = path.resolve(directory), target = path.join(base, ...file.path.split('/'));
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== file.bytes) throw damaged();
    const bytes = await readFile(target);
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw damaged();
    if (path.relative(path.join(await realpath(base), ...file.path.split('/')), await realpath(target)) !== '') throw damaged();
    return target;
  } catch { throw damaged(); }
}

/** Checks every file of the model, then registers the model file (its folder is the grant). */
export async function resolveBundledCharacterModel(key: string, directory: string, registry: AssetRegistry): Promise<AssetRef> {
  const entry = bundledCharacterModel(key);
  if (!entry) throw damaged();
  let model = '';
  for (const file of entry.files) {
    const target = await verifiedFile(directory, file);
    if (file.path === entry.model) model = target;
  }
  return registry.register(model);
}

const same = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * The reference a registered model path goes by on a card: `bundled:gene` for the factory Gene (`genePath`), `bundled:one` / `bundled:mumi`
 * for those models in the resource folder, else the path itself.
 */
export function bundledReferenceForPath(directory: string, modelPath: string, genePath?: string): string {
  if (genePath && modelPath === genePath) return GENE_MODEL_KEY;
  return BUNDLED_CHARACTER_MODELS.find(entry => same(path.join(directory, entry.model), modelPath))?.key ?? modelPath;
}
