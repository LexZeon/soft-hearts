import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import * as filesystem from 'node:fs/promises';

// File metadata only: never execute a candidate or open account/config files.
export async function discoverCodex(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const io = options.io ?? filesystem;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const executable = async file => {
    try {
      if (!(await io.stat(file)).isFile()) return false;
      await io.access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch { return false; }
  };
  if (env.CODEX_PATH) {
    return await executable(env.CODEX_PATH)
      ? { status: 'found', path: paths.resolve(env.CODEX_PATH) }
      : { status: 'invalid-override', path: null };
  }
  const name = platform === 'win32' ? 'codex.exe' : 'codex';
  for (const entry of (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')) {
    const directory = entry.replace(/^"|"$/g, '');
    if (!directory) continue;
    const candidate = paths.resolve(directory, name);
    if (await executable(candidate)) return { status: 'found', path: candidate };
  }
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const bin = paths.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const directories = await io.readdir(bin, { withFileTypes: true });
      const candidates = [];
      for (const directory of directories) {
        if (!directory.isDirectory()) continue;
        const candidate = paths.join(bin, directory.name, name);
        if (!(await executable(candidate))) continue;
        const metadata = await io.stat(candidate);
        if (metadata.mtimeMs > 0) candidates.push({ path: candidate, time: metadata.mtimeMs });
      }
      candidates.sort((a, b) => b.time - a.time);
      if (candidates.length) return { status: 'found', path: candidates[0].path };
    } catch { /* Missing/inaccessible desktop installation is not a login failure. */ }
  }
  if (platform === 'darwin' || platform === 'linux') {
    const home = options.home ?? os.homedir();
    // GUI launchers need not inherit the user's interactive shell PATH.
    // Use a finite list; never start a shell or scan a user's home directory.
    const candidates = [
      paths.join(home, '.local', 'bin', name),
      ...(platform === 'darwin' ? ['/opt/homebrew/bin/codex'] : []),
      '/usr/local/bin/codex',
      '/usr/bin/codex',
    ];
    for (const candidate of candidates) {
      if (await executable(candidate)) return { status: 'found', path: candidate };
    }
  }
  return { status: 'missing', path: null };
}
