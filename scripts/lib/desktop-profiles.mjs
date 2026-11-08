// The two desktop channel profiles. Stable is the user's existing %APPDATA%\soft-hearts-claude;
// development is a separate %APPDATA%\soft-hearts-claude-dev, seeded once from stable when it is
// first created. Nothing is ever copied from development back to stable. No app is started here.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEVELOPMENT_PROFILE_FOLDER, STABLE_PROFILE_FOLDER, assertNotCodexProfile } from './app-identity.mjs';

const REFERENCES = { stable: 'desktop-profile.json', development: 'desktop-development-profile.json' };
/** App stores are JSON or JSON-lines files; Chromium's own top-level files have no such extension. */
const SEED_FILE = /\.jsonl?$/i;
/** App folders use lowercase-kebab names; Chromium's (Cache, GPUCache, Local Storage, blob_storage, ...) never do. */
const SEED_FOLDER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// chat: Claude's empty working folder; dev: developer logs; databases: Chromium WebSQL;
// codex-tasks.json: external task ownership must not be duplicated into a second profile.
// claude-tasks.json (R20 task switch) and agent-channel.json / agent-channel/ (the internal channel's live token,
// endpoint and socket folder): opt-ins that are off by default and turned on per profile with their own notice;
// the token belongs to the stable app's endpoint and must never be handed to a second profile.
const SKIPPED = new Set(['chat', 'dev', 'databases', 'codex-tasks.json', 'claude-tasks.json', 'agent-channel.json', 'agent-channel']);
/**
 * Electron safeStorage (Chromium OSCrypt) on Windows keeps one AES key per user-data folder in "Local State"
 * (os_crypt.encrypted_key), wrapped with DPAPI for the current Windows user. The *Encrypted fields in settings.json
 * can only be decrypted with that key, so it is copied together with them. Same user, same machine: DPAPI unwraps it.
 */
const LOCAL_STATE = 'Local State';
const ENCRYPTED_SETTINGS = ['apiKeyEncrypted', 'voiceInputApiKeyEncrypted', 'ttsApiKeyEncrypted'];
const SEEDING_PREFIX = '.seeding-';

const inside = (parent, child) => { const rel = path.relative(parent, child); return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function physical(directory) { try { return await realpath(directory); } catch (error) { if (error.code === 'ENOENT') return path.resolve(directory); throw error; } }

function appDataDirectory(environment) {
  const value = environment?.APPDATA;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error('APPDATA is unavailable; no desktop profile was chosen.');
  return value;
}
async function readReference(file) {
  let bytes;
  try { if ((await lstat(file)).isSymbolicLink()) throw Error('A desktop profile reference may not be a link.'); bytes = await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (bytes.length > 16384) throw Error('The desktop profile reference is too large.');
  const reference = JSON.parse(bytes);
  if (reference?.version !== 1 || typeof reference.directory !== 'string' || !path.isAbsolute(reference.directory) || /[\x00-\x1f"]/.test(reference.directory))
    throw Error('Invalid desktop profile reference.');
  assertNotCodexProfile(reference.directory);
  return { version: 1, directory: reference.directory };
}
async function writeReference(file, directory) {
  await mkdir(path.dirname(file), { recursive: true });
  const reference = { version: 1, directory };
  await writeFile(file, JSON.stringify(reference, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return reference;
}
async function assertDirectory(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('A desktop profile must be a real folder.');
  assertNotCodexProfile(await realpath(directory));
}

/** release/desktop-profile.json → the user's existing profile. Created once; an existing reference is kept. */
export async function ensureStableProfileReference(workspaceRoot, environment = process.env) {
  const file = path.join(workspaceRoot, 'release', REFERENCES.stable);
  const existing = await readReference(file);
  if (existing) { await assertDirectory(existing.directory); return existing; }
  const directory = assertNotCodexProfile(path.join(appDataDirectory(environment), STABLE_PROFILE_FOLDER));
  await mkdir(directory, { recursive: true }); // The app creates the same folder on its first start.
  await assertDirectory(directory);
  return writeReference(file, directory);
}

async function copyTree(source, target, summary) {
  await mkdir(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, summary);
    else if (entry.isFile()) { await copyFile(from, to, constants.COPYFILE_EXCL); summary.files++; }
    // Links and special files are never followed or copied.
  }
}
/** Copies the app's own settings and data from a stable profile into an empty folder. Returns what was copied. */
export async function seedProfile(stableDirectory, target) {
  const summary = { files: 0, folders: [], localState: false, secretKey: false, encryptedSettings: false, secretsNeedReentry: false };
  for (const entry of await readdir(stableDirectory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const from = path.join(stableDirectory, entry.name), to = path.join(target, entry.name);
    if (entry.isFile() && (SEED_FILE.test(entry.name) || entry.name === LOCAL_STATE)) {
      await copyFile(from, to, constants.COPYFILE_EXCL); summary.files++;
      if (entry.name === LOCAL_STATE) summary.localState = true;
    } else if (entry.isDirectory() && SEED_FOLDER.test(entry.name)) { await copyTree(from, to, summary); summary.folders.push(entry.name); }
  }
  const json = async name => { try { return JSON.parse(await readFile(path.join(target, name), 'utf8')); } catch { return null; } };
  // The copied Local State must actually carry the wrapped key; a file without it decrypts nothing.
  const key = (await json(LOCAL_STATE))?.os_crypt?.encrypted_key;
  summary.secretKey = typeof key === 'string' && Buffer.from(key, 'base64').subarray(0, 5).toString('latin1') === 'DPAPI';
  const settings = await json('settings.json');
  summary.encryptedSettings = ENCRYPTED_SETTINGS.some(key => typeof settings?.[key] === 'string');
  summary.secretsNeedReentry = summary.encryptedSettings && !summary.secretKey;
  summary.folders.sort();
  return summary;
}
/** Windows can refuse a folder rename for a moment while a virus scanner still reads the files just copied into it. */
export async function renameNewFolder(from, to, { attempts = 10, pause = attempt => 100 * attempt, move = rename } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await move(from, to); }
    catch (error) {
      // Never retry over a folder that appeared meanwhile; that stays an error.
      if (attempt >= attempts || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || await exists(to)) throw error;
      await new Promise(resolve => setTimeout(resolve, pause(attempt)));
    }
  }
}
async function createSeededProfile(stableDirectory, directory) {
  const temporary = path.join(path.dirname(directory), SEEDING_PREFIX + path.basename(directory) + '-' + randomUUID());
  await mkdir(temporary);
  try {
    const summary = await seedProfile(stableDirectory, temporary);
    if (await exists(directory)) throw Error('The development profile folder appeared while it was being seeded; nothing was replaced.');
    await renameNewFolder(temporary, directory);
    return summary;
  } finally {
    if (path.dirname(temporary) !== path.dirname(directory) || !path.basename(temporary).startsWith(SEEDING_PREFIX)) throw Error('Refusing unexpected cleanup.');
    await rm(temporary, { recursive: true, force: true });
  }
}
async function assertSeparate(development, stable) {
  const a = (await physical(development)).toLowerCase(), b = (await physical(stable)).toLowerCase();
  if (a === b || inside(a, b) || inside(b, a)) throw Error('Development and stable profiles must be separate.');
}

/**
 * release/desktop-development-profile.json → a separate profile. When its folder is created it is seeded once from
 * stable; an existing folder is never seeded again. Returns the reference plus `seeded` (null when nothing was copied).
 */
export async function ensureDevelopmentProfile(workspaceRoot, environment = process.env) {
  const stable = await ensureStableProfileReference(workspaceRoot, environment);
  const file = path.join(workspaceRoot, 'release', REFERENCES.development);
  const defaultDirectory = assertNotCodexProfile(path.join(appDataDirectory(environment), DEVELOPMENT_PROFILE_FOLDER));
  const existing = await readReference(file);
  const directory = existing?.directory ?? defaultDirectory;
  await assertSeparate(directory, stable.directory);
  let seeded = null;
  if (!(await exists(directory))) {
    // Only the own default folder may be (re)created; a missing custom folder stays an error.
    if (existing && path.resolve(directory).toLowerCase() !== path.resolve(defaultDirectory).toLowerCase()) throw Error('The development profile folder is missing.');
    seeded = await createSeededProfile(stable.directory, directory);
  }
  await assertDirectory(directory);
  const reference = existing ?? await writeReference(file, directory);
  return { ...reference, seeded };
}
