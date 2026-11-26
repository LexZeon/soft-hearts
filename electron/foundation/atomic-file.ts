import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

export type AtomicFileWriter = (file: string, data: string) => Promise<void>;
export interface AtomicFileDependencies {
  platform?: NodeJS.Platform;
  rename?: typeof rename;
  writeFile?: typeof writeFile;
  rm?: typeof rm;
  wait?: (ms: number) => Promise<void>;
}

const renameDelays = [25, 50, 100, 200, 400] as const;
function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

/** Write once beside the destination; Windows sharing locks may delay only rename. */
export function createAtomicFileWriter(dependencies: AtomicFileDependencies = {}): AtomicFileWriter {
  const platform = dependencies.platform ?? process.platform;
  const write = dependencies.writeFile ?? writeFile;
  const move = dependencies.rename ?? rename;
  const remove = dependencies.rm ?? rm;
  const wait: (ms: number) => Promise<void> = dependencies.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  return async (file, data) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    let written = false;
    try {
      await write(temporary, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      written = true;
      for (let attempt = 0; ; attempt++) {
        try {
          await move(temporary, file);
          return;
        } catch (error) {
          const code = errorCode(error);
          if (platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')
            || attempt >= renameDelays.length) throw error;
          await wait(renameDelays[attempt]);
        }
      }
    } catch (error) {
      // A failed write may leave partial bytes. An exclusive-open collision,
      // however, never grants ownership of an already existing temporary file.
      if (written || errorCode(error) !== 'EEXIST') {
        try { await remove(temporary, { force: true }); }
        catch { /* Cleanup must not replace the original persistence error. */ }
      }
      throw error;
    }
  };
}

export const atomicWriteFile = createAtomicFileWriter();
