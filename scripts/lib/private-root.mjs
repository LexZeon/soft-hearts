// Where a script may write private files (raw chat text, backups): a folder that does not sync anywhere and is not part of the repository.
// Moved out of scripts/experience/lib.mjs (maintainer tooling the public snapshot leaves out) so the kept scripts that use it load there too.
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCodexProfilePath } from './app-identity.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const inside = (parent, child) => {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The private folder may not sync anywhere and may not be part of the repository. */
export async function assertPrivateRoot(directory, environment = process.env) {
  const resolved = path.resolve(directory);
  const real = await realpath(resolved).catch(() => resolved);
  const synced = [environment.OneDrive, environment.OneDriveConsumer, environment.OneDriveCommercial]
    .filter(Boolean).concat(environment.USERPROFILE ? [path.join(environment.USERPROFILE, 'OneDrive')] : []);
  for (const root of synced) if (inside(root, real)) throw Error(`The private folder may not be inside OneDrive (${root}).`);
  if (inside(REPO_ROOT, real)) throw Error('The private folder may not be inside the repository.');
  if (isCodexProfilePath(real)) throw Error('Refusing a path inside the Codex edition profile.');
  return real;
}
