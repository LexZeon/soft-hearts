/**
 * Model lab privacy rules (docs/claude/2026-11-02-model-lab.md): user models
 * are usually licensed for personal use only, so the models, the lab's config
 * and everything computed from them (profiles, proxies, scores, timings) stay
 * in a local folder outside this repository and outside OneDrive. These checks
 * refuse a report folder (and a config file) inside a git repository, inside
 * this checkout or inside OneDrive, following junctions and symlinks of the
 * part of the path that exists. The lab never uses the network.
 */
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class LabError extends Error {}

/** This checkout's root (scripts/model-lab/ is two levels down). */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const CONFIG_ENV = 'SOFT_HEARTS_MODEL_LAB_CONFIG';
export const DEFAULT_CONFIG = process.platform === 'win32' ? 'C:\\mmd-test\\model-lab.json' : path.join(os.homedir(), 'mmd-test', 'model-lab.json');

export interface PathContext {
  /** Folders the lab must never write into: this checkout (and anything else the caller names). */
  repoRoots: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** Symlink/junction resolution of an existing path (fs.realpathSync.native). */
  realpath?: (value: string) => string;
  exists?: (value: string) => boolean;
  /** Path semantics (case-insensitive on Windows). */
  platform?: NodeJS.Platform;
}
export const defaultPathContext = (env: Readonly<Record<string, string | undefined>> = process.env): PathContext => ({ repoRoots: [REPO_ROOT], env });

const ONEDRIVE_ENV = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'];

function api(context: PathContext) { return (context.platform ?? process.platform) === 'win32' ? path.win32 : path.posix; }
/** `child` is `parent` or below it. */
export function isInside(child: string, parent: string, context: PathContext): boolean {
  const p = api(context), fold = (value: string) => (context.platform ?? process.platform) === 'win32' ? value.toLowerCase() : value;
  const relative = p.relative(fold(p.resolve(parent)), fold(p.resolve(child)));
  return relative === '' || (!relative.startsWith('..') && !p.isAbsolute(relative));
}

/** The path with its deepest existing ancestor resolved through junctions and symlinks (the rest appended). */
function realPathOf(value: string, context: PathContext): string {
  const p = api(context), exists = context.exists ?? existsSync, realpath = context.realpath ?? realpathSync.native;
  let at = p.resolve(value);
  const tail: string[] = [];
  for (;;) {
    if (exists(at)) {
      try { return p.join(realpath(at), ...tail.reverse()); } catch { return p.resolve(value); }
    }
    const parent = p.dirname(at);
    if (parent === at) return p.resolve(value);
    tail.push(p.basename(at)); at = parent;
  }
}

export interface PathProblem { kind: 'relative' | 'onedrive' | 'repository' | 'git'; message: string }
/** Why `target` may not hold private model data (null when it may). Checks the path as written and as resolved. */
export function privatePathProblem(target: string, context: PathContext): PathProblem | null {
  const p = api(context), exists = context.exists ?? existsSync;
  if (!p.isAbsolute(target)) return { kind: 'relative', message: `${target} is not an absolute path` };
  const resolved = realPathOf(target, context);
  for (const candidate of [...new Set([p.resolve(target), resolved])]) {
    const oneDrive = candidate.split(/[\\/]+/).find(segment => /onedrive/i.test(segment));
    if (oneDrive) return { kind: 'onedrive', message: `${candidate} is inside OneDrive ("${oneDrive}"), which syncs it to the cloud` };
    for (const key of ONEDRIVE_ENV) {
      const root = context.env[key];
      if (root && p.isAbsolute(root) && isInside(candidate, root, context)) return { kind: 'onedrive', message: `${candidate} is inside OneDrive (${key}=${root})` };
    }
    for (const root of context.repoRoots) {
      if (isInside(candidate, root, context) || isInside(candidate, realPathOf(root, context), context))
        return { kind: 'repository', message: `${candidate} is inside the repository (${root})` };
    }
    for (let at = candidate, previous = ''; at !== previous; previous = at, at = p.dirname(at)) {
      if (exists(p.join(at, '.git'))) return { kind: 'git', message: `${candidate} is inside a git repository (${at})` };
    }
  }
  return null;
}

/** Throws unless `reportDir` is a private local folder (see privatePathProblem). */
export function assertPrivateReportDir(reportDir: string, context: PathContext): void {
  const problem = privatePathProblem(reportDir, context);
  if (problem) throw new LabError(`Refusing reportDir: ${problem.message}. Reports hold data computed from your models; keep them in a local folder outside the repository and OneDrive, e.g. C:\\mmd-test\\reports.`);
}

// ---------------------------------------------------------------- config

export interface LabModelEntry { id: string; pmx: string }
export interface LabConfig { path: string; reportDir: string; models: LabModelEntry[] }

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** A model id is also its report folder name: letters, digits, dot, dash, underscore; no path parts. */
export function validModelId(id: unknown): id is string {
  return typeof id === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(id) && !RESERVED.test(id) && !id.endsWith('.');
}

/** `{ "reportDir": "...", "models": [{ "id": "...", "pmx": "..." }] }`; relative paths are relative to the config file. */
export function parseLabConfig(text: string, configPath: string, platform: NodeJS.Platform = process.platform): LabConfig {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (error) { throw new LabError(`${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LabError(`${configPath}: expected an object with "reportDir" and "models"`);
  const record = value as Record<string, unknown>, base = p.dirname(p.resolve(configPath));
  if (typeof record.reportDir !== 'string' || !record.reportDir.trim()) throw new LabError(`${configPath}: "reportDir" must be a folder path`);
  if (!Array.isArray(record.models) || !record.models.length || record.models.length > 100) throw new LabError(`${configPath}: "models" must list 1 to 100 models`);
  const seen = new Set<string>();
  const models = record.models.map((entry, index) => {
    const model = entry as Record<string, unknown> | null;
    if (!model || typeof model !== 'object') throw new LabError(`${configPath}: models[${index}] must be { "id": ..., "pmx": ... }`);
    if (!validModelId(model.id)) throw new LabError(`${configPath}: models[${index}].id must be 1-64 letters, digits, ".", "_" or "-" (it names the report folder)`);
    if (seen.has(model.id.toLowerCase())) throw new LabError(`${configPath}: duplicate model id "${model.id}"`);
    seen.add(model.id.toLowerCase());
    if (typeof model.pmx !== 'string' || !/\.pmx$/i.test(model.pmx.trim())) throw new LabError(`${configPath}: models[${index}].pmx must be a .pmx file path`);
    return { id: model.id, pmx: p.resolve(base, model.pmx.trim()) };
  });
  return { path: p.resolve(configPath), reportDir: p.resolve(base, record.reportDir.trim()), models };
}

// ---------------------------------------------------------------- network

/** Replaces the global network entry points with ones that throw; returns a restore function. The lab imports no network module. */
export function blockNetwork(): () => void {
  const keys = ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'] as const;
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const refuse = () => { throw new LabError('model-lab never uses the network'); };
  for (const key of keys) Object.defineProperty(globalThis, key, { value: refuse, configurable: true, writable: true, enumerable: false });
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  };
}
