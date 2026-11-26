// The stage's source files, for the smokes that fingerprint the code they test. Since I-176 step 3 the stage is Unbound's window engine:
// src/unbound/window-mode/window-stage.ts plus the rest of src/unbound/window-mode/ (the old src/stage/MmdStage.ts family is deleted).
// Sorted by plain code-point order so the list (and any hash over it) is the same on every machine.
import { readdirSync } from 'node:fs';
import path from 'node:path';

export const STAGE_FILE = 'src/unbound/window-mode/window-stage.ts';
export const STAGE_MODULE_DIR = 'src/unbound/window-mode';

/** Posix-style relative paths under `root`: window-stage.ts first, then every other src/unbound/window-mode/*.ts sorted. */
export function stageSourceFiles(root) {
  const modules = readdirSync(path.join(root, STAGE_MODULE_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `${STAGE_MODULE_DIR}/${entry.name}`)
    .filter((file) => file !== STAGE_FILE)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [STAGE_FILE, ...modules];
}
