// T-239 + Codex X-435: nothing of a file the user is asked about is read before the user agreed. Before the OK only the
// path checks and the file's stat (name, place, size, modification time) are known; after the OK its bytes are read ONCE,
// and exactly those bytes are used from then on (imported, or planned, shown in the second dialog and written) — never read
// again by path. The size + modification-time check stays in front of that one read and right after it.
// What was given up (2026-11-12): T-239 had fingerprinted the bytes for the first dialog to refuse a same-size, same-time swap
// between that dialog and the OK. That fingerprint was itself a read of the whole file before consent; reading nothing before
// the user says yes outranks binding to pre-consent bytes the user never saw (docs/claude/2026-11-12-t239-channel-fixes.md).
import { readFile } from 'node:fs/promises';
import { AgentToolError } from './registry';
import { assertUnchanged, nodeFileSystem, type FileFacts, type FileSystemPort } from './validate';

export interface FileBytesPort {
  /** The whole file (character cards: at most 1 MB). Called only after the user agreed, once per agreed request. */
  readBytes(file: string): Promise<Uint8Array>;
}

export const nodeFileBytes: FileBytesPort = { readBytes: file => readFile(file) };

/** A port over a text reader (tests). */
export function fileBytesFrom(readBytes: (file: string) => Promise<Uint8Array>): FileBytesPort {
  return { readBytes };
}

export const FILE_CHANGED_AFTER_CONFIRM = '文件在确认之后被改动或移走了，已取消；请重新请求。';

/** After the user agreed: the file's bytes, read once, still the size and time the dialog showed (checked before and after). */
export async function readConfirmedBytes(facts: FileFacts, port: FileBytesPort, fs: FileSystemPort = nodeFileSystem): Promise<Uint8Array> {
  await assertUnchanged(facts, fs);
  let bytes: Uint8Array;
  try { bytes = await port.readBytes(facts.file); } catch { throw new AgentToolError('unavailable', FILE_CHANGED_AFTER_CONFIRM); }
  await assertUnchanged(facts, fs);
  return bytes;
}

/** The same, decoded as UTF-8 exactly like readFile(file, 'utf8') (a BOM is kept for the card parser). */
export async function readConfirmedText(facts: FileFacts, port: FileBytesPort, fs: FileSystemPort = nodeFileSystem): Promise<string> {
  return Buffer.from(await readConfirmedBytes(facts, port, fs)).toString('utf8');
}
