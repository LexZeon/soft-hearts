import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import * as filesystem from 'node:fs/promises';

// The Claude desktop app's own copy of Claude Code (its Code tab): <app data>\Claude\claude-code\<version>\...\claude.exe on Windows
// (also inside an MSIX package's LocalCache\Roaming), ~/Library/Application Support/Claude/claude-code/<version>/ on macOS. It is
// not signed in on its own (the desktop app signs in through its local proxy) and its versioned folder goes away when the app
// updates, so the companion never uses it: the user installs the official Claude Code and signs in once
// (docs/claude/2026-11-25-claude-env-from-session.md).
const DESKTOP_BUNDLED = /[\\/]Claude[\\/]claude-code[\\/]\d+\.\d+\.\d+[^\\/]*[\\/]/i;
export function isDesktopBundledClaude(file) {
  return typeof file === 'string' && DESKTOP_BUNDLED.test(file);
}

// File metadata only: never execute a candidate or open account/config files.
// The companion always uses the user's own, unmodified Claude Code installation.
// Results: found (path), invalid-override (CLAUDE_PATH is not a file; no fallback), desktop-bundled (CLAUDE_PATH names the desktop
// app's copy, or that copy is the only Claude Code here; no fallback, nothing to run), missing.
export async function discoverClaude(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const io = options.io ?? filesystem;
  const home = options.home ?? os.homedir();
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const executable = async file => {
    try {
      if (!(await io.stat(file)).isFile()) return false;
      await io.access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch { return false; }
  };
  const directory = async folder => {
    try { return (await io.stat(folder)).isDirectory?.() === true; } catch { return false; }
  };
  if (env.CLAUDE_PATH) {
    if (!(await executable(env.CLAUDE_PATH))) return { status: 'invalid-override', path: null };
    return isDesktopBundledClaude(paths.resolve(env.CLAUDE_PATH))
      ? { status: 'desktop-bundled', path: null }
      : { status: 'found', path: paths.resolve(env.CLAUDE_PATH) };
  }
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  let bundledSeen = false;
  for (const entry of (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')) {
    const folder = entry.replace(/^"|"$/g, '');
    if (!folder) continue;
    const candidate = paths.resolve(folder, name);
    if (!(await executable(candidate))) continue;
    // A PATH entry into the desktop app's copy is skipped; an official install later on PATH or below still wins.
    if (isDesktopBundledClaude(candidate)) { bundledSeen = true; continue; }
    return { status: 'found', path: candidate };
  }
  // GUI launchers need not inherit the interactive shell PATH. Use a finite list
  // of official install locations; never start a shell or scan the home folder.
  const candidates = platform === 'win32'
    ? [
        paths.join(env.USERPROFILE || home, '.local', 'bin', name), // native installer
        ...(env.LOCALAPPDATA ? [paths.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', name)] : []),
        // npm global install links a .cmd shim; the native binary sits in the package.
        ...(env.APPDATA ? [paths.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', name)] : []),
      ]
    : [
        paths.join(home, '.local', 'bin', name),
        ...(platform === 'darwin' ? ['/opt/homebrew/bin/claude'] : []),
        '/usr/local/bin/claude',
        '/usr/bin/claude',
      ];
  for (const candidate of candidates) {
    if (await executable(candidate)) return { status: 'found', path: candidate };
  }
  // Nothing usable. Say so plainly when the desktop app's copy is what is here: a desktop-app user needs the official one too.
  // Evidence (metadata only): a PATH entry above, the parent session's CLAUDE_CODE_EXECPATH, or the desktop app's claude-code folder.
  if (bundledSeen) return { status: 'desktop-bundled', path: null };
  const execPath = env.CLAUDE_CODE_EXECPATH;
  if (execPath && isDesktopBundledClaude(execPath) && await executable(execPath)) return { status: 'desktop-bundled', path: null };
  const desktopFolder = platform === 'win32'
    ? (env.APPDATA ? paths.join(env.APPDATA, 'Claude', 'claude-code') : null)
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support', 'Claude', 'claude-code') : null;
  if (desktopFolder && await directory(desktopFolder)) return { status: 'desktop-bundled', path: null };
  return { status: 'missing', path: null };
}
