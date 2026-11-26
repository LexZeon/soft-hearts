/**
 * The model file formats the app loads as they are (I-152 原样载入, docs/claude/2026-11-19-model-adapter-and-vrm-display.md):
 * MMD (.pmx / .pmd) and VRM (.vrm). One list, read by every place that takes a model file: the file pickers, the character
 * card's model binding, the agent channel's load_model, the asset protocol's allow list and the model content key
 * (keyForModel). Foundation: no Node, no Three, no part imports.
 */
export type ModelFormat = 'mmd' | 'vrm';

/** Lower-case extensions with the dot, in the order the pickers list them. */
export const MODEL_FILE_EXTENSIONS: readonly string[] = Object.freeze(['.pmx', '.pmd', '.vrm']);
/** The same for file dialogs (no dot). */
export const MODEL_DIALOG_EXTENSIONS: readonly string[] = Object.freeze(MODEL_FILE_EXTENSIONS.map(extension => extension.slice(1)));

/** The extension of a path, file name or URL path (lower case, with the dot; '' when there is none). Query and hash are ignored. */
export function modelExtensionOf(value: string): string {
  const text = String(value ?? '').split(/[?#]/u)[0];
  const name = text.split(/[\\/]/u).pop() ?? '';
  let decoded = name;
  try { decoded = decodeURIComponent(name); } catch { /* a raw name with a stray % stays as it is */ }
  const dot = decoded.lastIndexOf('.');
  return dot > 0 ? decoded.slice(dot).toLowerCase() : '';
}

/** True only for a model file extension the app loads ('.pmx', '.pmd', '.vrm'; any case). */
export function isModelFileExtension(extension: string): boolean {
  return typeof extension === 'string' && MODEL_FILE_EXTENSIONS.includes(extension.toLowerCase());
}

/** The format of a model path, file name or asset URL; null when it is not a model file. */
export function modelFormatOf(value: string): ModelFormat | null {
  const extension = modelExtensionOf(value);
  return extension === '.vrm' ? 'vrm' : extension === '.pmx' || extension === '.pmd' ? 'mmd' : null;
}
