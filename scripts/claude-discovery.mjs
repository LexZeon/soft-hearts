import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import * as filesystem from 'node:fs/promises';

// File metadata only: never execute a candidate or open account/config files.
// The pet always uses the user's own, unmodified Claude Code installation.
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
  if (env.CLAUDE_PATH) {
    return await executable(env.CLAUDE_PATH)
      ? { status: 'found', path: paths.resolve(env.CLAUDE_PATH) }
      : { status: 'invalid-override', path: null };
  }
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  for (const entry of (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')) {
    const directory = entry.replace(/^"|"$/g, '');
    if (!directory) continue;
    const candidate = paths.resolve(directory, name);
    if (await executable(candidate)) return { status: 'found', path: candidate };
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
  return { status: 'missing', path: null };
}
