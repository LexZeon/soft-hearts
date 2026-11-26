// Where the measurement scripts that write raw chat text put it (never in the repository). Order, first that is set wins:
//   1. the script's --out-dir / --raw-dir flag
//   2. the environment variable SOFT_HEARTS_PRIVATE_DIR
//   3. the first line of the untracked local file `.local/private-dir.txt` (an absolute folder path; .local is neither committed nor exported)
//   4. the default `<home>/.soft-hearts-raw`
// The scripts print which one was used before writing anything.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type PrivateDirSource = 'flag' | 'env' | 'local-file' | 'default';
export interface PrivateDirChoice { dir: string; source: PrivateDirSource }
export interface PrivateDirInputs {
  /** The value given on the command line (--out-dir / --raw-dir), if any. */
  flag?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** The repository root, where `.local/private-dir.txt` lives. */
  root?: string;
  home?: string;
  /** Reads a text file; throws when it is missing. Replaceable in tests. */
  readFile?: (file: string) => string;
}

export const PRIVATE_DIR_FILE = path.join('.local', 'private-dir.txt');

/** The first non-empty line of the local file, when it is an absolute path; otherwise null. */
export function readLocalPrivateDir(root: string, readFile: (file: string) => string = file => readFileSync(file, 'utf8')): string | null {
  let text: string;
  try { text = readFile(path.join(root, PRIVATE_DIR_FILE)); } catch { return null; }
  const line = text.replace(/^﻿/u, '').split(/\r?\n/u).map(part => part.trim()).find(part => part.length > 0);
  return line && path.isAbsolute(line) ? line : null;
}

/** The base folder for raw text (a script adds its own sub-folder). */
export function resolvePrivateDir(inputs: PrivateDirInputs = {}): PrivateDirChoice {
  const flag = inputs.flag?.trim();
  if (flag) return { dir: flag, source: 'flag' };
  const env = (inputs.env ?? process.env).SOFT_HEARTS_PRIVATE_DIR?.trim();
  if (env) return { dir: env, source: 'env' };
  const local = readLocalPrivateDir(inputs.root ?? process.cwd(), inputs.readFile);
  if (local) return { dir: local, source: 'local-file' };
  return { dir: path.join(inputs.home ?? os.homedir(), '.soft-hearts-raw'), source: 'default' };
}

const SOURCE_TEXT: Record<PrivateDirSource, string> = {
  flag: 'the command-line flag', env: 'SOFT_HEARTS_PRIVATE_DIR', 'local-file': `${PRIVATE_DIR_FILE.replace(/\\/gu, '/')}`, default: 'the default (nothing else was set)',
};
/** A script's own raw-text folder: the flag as given, otherwise `<base>/<sub>` where the base follows the order above. */
export function resolveRawFolder(sub: string, inputs: PrivateDirInputs = {}): PrivateDirChoice {
  const choice = resolvePrivateDir(inputs);
  return choice.source === 'flag' ? choice : { ...choice, dir: path.join(choice.dir, sub) };
}

/** The line a script prints before it writes any raw text. */
export const describePrivateDir = (choice: PrivateDirChoice): string => `raw text will be written to ${choice.dir} (from ${SOURCE_TEXT[choice.source]})`;
