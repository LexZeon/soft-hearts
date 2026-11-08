import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AgentToolError } from './registry';

const invalid = (message: string) => new AgentToolError('invalid_input', message);

/** A plain JSON object with only the listed keys; `undefined` counts as `{}`. */
export function argsObject(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype)
    throw invalid('参数必须是一个对象。');
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw invalid(`不认识的参数：${key.slice(0, 40)}。`);
  return raw as Record<string, unknown>;
}

export function noArgs(raw: unknown): Record<string, never> {
  argsObject(raw, []);
  return {};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function cardId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid('角色卡 id 必须是 list_characters 返回的 UUID。');
  return value.toLowerCase();
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw invalid(`${label}只接受：${allowed.join('、')}。`);
  return value as T;
}

/**
 * An absolute local file path with one of the given extensions. UNC, device and
 * relative paths are refused (a UNC path would make Windows contact another machine).
 */
export function localFilePath(value: unknown, extensions: readonly string[], platform: NodeJS.Platform = process.platform): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) throw invalid('路径不正确。');
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32' ? /^[\\/]{2}/.test(value) || !/^[a-zA-Z]:[\\/]/.test(value) : !value.startsWith('/') || value.startsWith('//'))
    throw invalid('请给出本机的绝对路径（不支持网络路径或相对路径）。');
  const normalized = api.normalize(value);
  if (!extensions.includes(api.extname(normalized).toLowerCase())) throw invalid(`只接受 ${extensions.join(' / ')} 文件。`);
  return normalized;
}

export interface FileFacts { file: string; name: string; directory: string; size: number; mtimeMs: number }
export interface FileSystemPort {
  realpath(file: string): Promise<string>;
  stat(file: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>;
}
export const nodeFileSystem: FileSystemPort = { realpath, stat };

/** Resolves links, requires an existing regular file within the size limit, and keeps the extension check on the real file. */
export async function inspectLocalFile(file: string, extensions: readonly string[], maxBytes: number,
  fs: FileSystemPort = nodeFileSystem, platform: NodeJS.Platform = process.platform): Promise<FileFacts> {
  const api = platform === 'win32' ? path.win32 : path.posix;
  let real: string;
  try { real = await fs.realpath(file); } catch { throw new AgentToolError('unavailable', '文件不存在或无法读取。'); }
  localFilePath(real, extensions, platform);
  const info = await fs.stat(real).catch(() => null);
  if (!info?.isFile()) throw new AgentToolError('unavailable', '这不是一个普通文件。');
  if (info.size > maxBytes) throw new AgentToolError('invalid_input', `文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
  return { file: real, name: api.basename(real), directory: api.dirname(real), size: info.size, mtimeMs: info.mtimeMs };
}

/** The file confirmed by the user must still be the same bytes-on-disk identity when the action runs. */
export async function assertUnchanged(facts: FileFacts, fs: FileSystemPort = nodeFileSystem): Promise<void> {
  const info = await fs.stat(facts.file).catch(() => null);
  if (!info?.isFile() || info.size !== facts.size || info.mtimeMs !== facts.mtimeMs)
    throw new AgentToolError('unavailable', '文件在确认之后被改动或移走，已取消。');
}
