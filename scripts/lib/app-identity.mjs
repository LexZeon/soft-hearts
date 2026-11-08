// The one place that names this edition (soft hearts next) on disk, in Windows and in Electron.
// Scripts and the packaged desktop entry import it. tests/app-identity.test.ts proves that
// nothing here can match the Codex edition, which runs side by side on the same PC.
import path from 'node:path';

export const PACKAGE_NAME = 'soft-hearts-next';
export const PRODUCT_NAME = 'soft hearts next';
export const APP_ID = 'io.softhearts.next';
export const EXECUTABLE_NAME = PRODUCT_NAME + '.exe';
/** The user's existing profile. Equal to PROFILE_FOLDER in electron/profile.ts and the string inlined in electron/desktop-entry.ts. */
export const STABLE_PROFILE_FOLDER = 'soft-hearts-claude';
export const DEVELOPMENT_PROFILE_FOLDER = 'soft-hearts-claude-dev';
export const CHANNELS = Object.freeze(['stable', 'development']);
export const SHORTCUT_NAMES = Object.freeze({
  development: 'soft hearts next - 最新开发版.lnk',
  stable: 'soft hearts next - 稳定版.lnk',
});
/** Separate taskbar identities, so a running development build never groups with the stable one. */
export const APP_USER_MODEL_IDS = Object.freeze({ stable: APP_ID, development: APP_ID + '.dev' });

/** Names owned by the Codex edition. Listed only so guards and tests can refuse them; never used to find anything. */
export const CODEX_EDITION = Object.freeze({
  packageName: 'soft-hearts',
  productName: 'soft hearts',
  executableName: 'soft hearts.exe',
  appId: 'io.softhearts.app',
  profileFolder: 'soft-hearts',
  shortcutNames: Object.freeze(['soft hearts.lnk', 'soft hearts - 完整交付版.lnk']),
});

/** Win32 compares names case-insensitively and drops trailing dots and spaces. */
export function windowsName(name) {
  return String(name).replace(/[. ]+$/u, '').toLowerCase();
}
function channelKey(channel) {
  if (!CHANNELS.includes(channel)) throw Error('Unknown desktop channel.');
  return channel;
}
export function shortcutName(channel) { return SHORTCUT_NAMES[channelKey(channel)]; }
export function appUserModelId(channel) { return APP_USER_MODEL_IDS[channelKey(channel)]; }
export function profileFolder(channel) { return channelKey(channel) === 'stable' ? STABLE_PROFILE_FOLDER : DEVELOPMENT_PROFILE_FOLDER; }

/** Exact match on the file name only; `soft hearts.exe` and any other name never match. */
export function isOwnExecutable(file) {
  return typeof file === 'string' && windowsName(path.win32.basename(file)) === EXECUTABLE_NAME;
}
/** Exact match on one channel's fixed link name; the Codex links never match. */
export function isOwnShortcut(file, channel) {
  return typeof file === 'string' && windowsName(path.win32.basename(file)) === windowsName(shortcutName(channel));
}
/** True when any folder on the path is the Codex profile folder (`%APPDATA%\soft-hearts` or anything inside it). */
export function isCodexProfilePath(directory) {
  return typeof directory === 'string' && directory.split(/[\\/]+/u).some(part => windowsName(part) === CODEX_EDITION.profileFolder);
}
export function assertNotCodexProfile(directory) {
  if (isCodexProfilePath(directory)) throw Error('The Codex edition profile is never used by soft hearts next.');
  return directory;
}
