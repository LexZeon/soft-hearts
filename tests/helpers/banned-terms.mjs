// The maintainer's private word list (the one the public export scans for; never in the repository). Tests that guard against private
// names leaking use it when the file is there, and check nothing when it is not (a stranger's machine has no such list).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Lower-cased terms from SOFT_HEARTS_BANNED_TERMS or .local/release-banned-terms.txt; an empty list when neither exists. */
export function privateTerms() {
  const file = process.env.SOFT_HEARTS_BANNED_TERMS ?? path.join(REPO, '.local', 'release-banned-terms.txt');
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean);
  } catch { return []; }
}

/** The terms that appear in a text (empty when the list is missing). */
export function privateTermsIn(text) {
  const lowered = String(text).toLowerCase();
  return privateTerms().filter((term) => lowered.includes(term));
}
