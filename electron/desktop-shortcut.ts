import { createHash } from 'node:crypto';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withPlainIdList } from './lnk-plain-path';
import { appUserModelId, isOwnExecutable, isOwnShortcut, shortcutName, type DesktopChannel } from '../scripts/lib/app-identity.mjs';

/** Created only after the host has verified its own immutable bundle and profile. */
export interface VerifiedDesktopEntry {
  kind: 'verified-own-desktop-entry-v1';
  channel: DesktopChannel;
  executable: string;
  profile: string;
  workspaceRoot: string;
  desktopDirectory: string;
  versionId: string;
  manifestSha256: string;
  asarSha256: string;
  ownerMarker: string;
}

export interface DesktopShortcutDetails {
  target: string;
  cwd: string;
  args: string;
  description: string;
  icon: string;
  iconIndex: number;
  appUserModelId: string;
}
/** The host supplies only the two Electron shell methods; this is not IPC. */
export interface DesktopShortcutShell {
  writeShortcutLink(shortcutPath: string, operation: 'create' | 'replace', details: DesktopShortcutDetails): boolean;
  readShortcutLink(shortcutPath: string): Pick<DesktopShortcutDetails, 'target'> & Partial<DesktopShortcutDetails>;
}
export interface DesktopShortcutReceipt {
  kind: 'native-stable-shortcut-v1' | 'native-development-shortcut-v1';
  channel: DesktopChannel;
  manifestSha256: string;
  executable: string;
  shortcutPath: string;
  shortcutSha256: string;
  targetPath: string;
  arguments: string;
  /** The exact link this write replaced, so the updater can archive it or put it back. */
  previous: { sha256: string; bytesBase64: string } | null;
}

/** A failure after an attempted write; `restored` says whether the previous state was put back. */
export class DesktopShortcutError extends Error {
  constructor(message: string, public readonly savedAttempted: boolean, public readonly restored = false) {
    super(message);
    this.name = 'DesktopShortcutError';
  }
}

const DESCRIPTIONS: Record<DesktopChannel, string> = { stable: 'soft hearts next · 稳定版', development: 'soft hearts next · 最新开发版' };
const MAX_LINK_BYTES = 1024 * 1024;
/** A replaced link travels back inside the receipt; real links are a few KB. */
const MAX_PREVIOUS_BYTES = 32 * 1024;
const unsafe = /["\u0000-\u001f\u007f]/u;
const hash64 = /^[a-f0-9]{64}$/i;
const marker24 = /^[a-f0-9]{24}$/i;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function absoluteWindowsPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 32767 || unsafe.test(value) || !path.win32.isAbsolute(value)) return false;
  if (/^\\\\[?.]\\/u.test(value.replaceAll('/', '\\'))) return false;
  const root = path.win32.parse(value).root;
  if (!root || value.slice(root.length).includes(':')) return false;
  return !value.slice(root.length).split(/[\\/]/u).some(part => part === '.' || part === '..');
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function validate(entry: VerifiedDesktopEntry): { link: string; details: DesktopShortcutDetails } {
  if (!entry || entry.kind !== 'verified-own-desktop-entry-v1' || (entry.channel !== 'stable' && entry.channel !== 'development') ||
      !absoluteWindowsPath(entry.executable) || !absoluteWindowsPath(entry.profile) ||
      !absoluteWindowsPath(entry.workspaceRoot) || !absoluteWindowsPath(entry.desktopDirectory) ||
      /[\\/]$/u.test(entry.profile) ||
      typeof entry.versionId !== 'string' || !hash64.test(entry.versionId) ||
      typeof entry.manifestSha256 !== 'string' || !hash64.test(entry.manifestSha256) ||
      typeof entry.asarSha256 !== 'string' || !hash64.test(entry.asarSha256) ||
      typeof entry.ownerMarker !== 'string' || !marker24.test(entry.ownerMarker)) {
    throw new DesktopShortcutError('Invalid verified desktop entry.', false);
  }
  const { channel, executable } = entry;
  const expectedRoot = path.win32.join(entry.workspaceRoot, 'release', channel, entry.versionId);
  const parent = path.win32.dirname(executable);
  const archDirectory = path.win32.basename(parent);
  if (!sameWindowsPath(path.win32.dirname(parent), expectedRoot) ||
      !/^win-(?:x64|arm64)-unpacked$/i.test(archDirectory) ||
      !isOwnExecutable(executable)) {
    throw new DesktopShortcutError('The executable is outside its immutable channel version.', false);
  }
  // The host path module is path.win32 on Windows; elsewhere it lets tests use real temporary folders.
  const link = path.join(entry.desktopDirectory, shortcutName(channel));
  if (!isOwnShortcut(link, channel)) throw new DesktopShortcutError('Unexpected desktop shortcut name.', false);
  // The installed host verifies its own manifest and derives profile/build/owner before locking.
  const args = `--soft-hearts-channel=${channel}`;
  return { link, details: { target: executable, cwd: parent, args, description: DESCRIPTIONS[channel], icon: executable, iconIndex: 0,
    appUserModelId: appUserModelId(channel) } };
}

/** The link this channel owns, or null when there is none yet. Anything but a small regular file is left alone. */
async function existingLink(link: string): Promise<Buffer | null> {
  let stat;
  try { stat = await lstat(link); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PREVIOUS_BYTES) throw new Error('The fixed shortcut is not a small regular file.');
  return readFile(link);
}

/**
 * Right after the shell saves a link on the real desktop, something (Explorer fetching the new program's icon, the indexer, a
 * scanner) can hold it open for a moment: on 2026-11-06 the plain-path rewrite and the restore both failed on every attempt
 * while the same steps passed in an unwatched folder. Those file steps are retried briefly; anything else fails at once.
 */
export const LOCK_RETRY = Object.freeze({ attempts: 8, waitMs: 120 });
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN']);
const busy = (error: unknown) => BUSY_CODES.has((error as NodeJS.ErrnoException | null)?.code ?? '') || (error as { shellRead?: boolean } | null)?.shellRead === true;
async function patiently<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await step(); }
    catch (error) {
      if (attempt >= LOCK_RETRY.attempts || !busy(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY.waitMs * attempt));
    }
  }
}
const failureCode = (error: unknown) => { const code = (error as NodeJS.ErrnoException | null)?.code; return typeof code === 'string' && /^[A-Z_]{2,20}$/u.test(code) ? code : null; };

async function restore(link: string, previous: Buffer | null): Promise<boolean> {
  try {
    await patiently(async () => {
      if (previous) await writeFile(link, previous);
      else await unlink(link).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    });
    return true;
  } catch { return false; }
}

/**
 * Creates or replaces this channel's one fixed link (and nothing else), then verifies it by readback.
 * On any failure after the write the previous link is put back, or the new one removed. Never launches a process.
 */
export async function installOwnDesktopShortcut(entry: VerifiedDesktopEntry, shellApi: DesktopShortcutShell): Promise<DesktopShortcutReceipt> {
  const { link, details } = validate(entry);
  let previous: Buffer | null;
  try { previous = await existingLink(link); }
  catch { throw new DesktopShortcutError('The fixed shortcut is not a small regular file; it was left unchanged.', false); }
  try {
    if (!shellApi.writeShortcutLink(link, previous ? 'replace' : 'create', details)) throw new Error('Shortcut write failed.');
    const { actual, bytes } = await patiently(async () => {
      // The link must open without OneDrive running: its shell item list is rebuilt from the plain path (see ./lnk-plain-path).
      const plain = withPlainIdList(await readFile(link), details.target);
      if (plain) await writeFile(link, plain);
      let actual: ReturnType<DesktopShortcutShell['readShortcutLink']>;
      try { actual = shellApi.readShortcutLink(link); }
      catch (error) { throw Object.assign(new Error('Shortcut readback failed.'), { shellRead: true, cause: error }); }
      if (!actual || actual.target !== details.target || actual.cwd !== details.cwd || actual.args !== details.args ||
          actual.icon !== details.icon || actual.iconIndex !== 0 || actual.appUserModelId !== details.appUserModelId) {
        throw new Error('Shortcut readback did not match the verified entry.');
      }
      const after = await lstat(link);
      if (!after.isFile() || after.isSymbolicLink() || after.size > MAX_LINK_BYTES) throw new Error('The updated shortcut is not a bounded file.');
      const bytes = await readFile(link);
      if (bytes.length > MAX_LINK_BYTES) throw new Error('The updated shortcut exceeds the limit.');
      return { actual: { target: actual.target, args: actual.args }, bytes };
    });
    return { kind: entry.channel === 'stable' ? 'native-stable-shortcut-v1' : 'native-development-shortcut-v1', channel: entry.channel,
      manifestSha256: entry.manifestSha256, executable: details.target, shortcutPath: link, shortcutSha256: sha256(bytes),
      targetPath: actual.target, arguments: actual.args, previous: previous && { sha256: sha256(previous), bytesBase64: previous.toString('base64') } };
  } catch (error) {
    const restored = await restore(link, previous);
    const code = failureCode(error) ?? ((error as { shellRead?: boolean } | null)?.shellRead ? 'READBACK' : null);
    throw new DesktopShortcutError(`The fixed desktop shortcut could not be verified${code ? ` (${code})` : ''}.`, true, restored);
  }
}
