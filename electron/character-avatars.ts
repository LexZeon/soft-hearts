// C2 角色页: each card's small picture. Kept on this computer only (`<profile>/character-avatars/<id>.png`), never in
// an exported card. The picture is a half-body shot the control window's preview takes when a card is linked to the
// model on stage; without one, a preview image that ships in the model's folder; without that, the name's first
// letter (drawn by the page). Host only: the renderer sends PNG bytes and a card id, never a path.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** PNG bytes beside the destination, then one rename (the text-only atomic writer cannot carry binary). */
export async function writeBinaryAtomic(file: string, bytes: Uint8Array): Promise<void> {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const AVATAR_LIMITS = Object.freeze({ bytes: 400_000, side: 512, previewBytes: 4_000_000 });
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG the host accepts as an avatar: signature, IHDR first, sides within the limit, bounded size. */
export function validateAvatarPng(bytes: Uint8Array): { width: number; height: number } {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || bytes.length > AVATAR_LIMITS.bytes) throw Error('头像图片大小不正确。');
  if (PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) throw Error('头像必须是 PNG 图片。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw Error('头像必须是 PNG 图片。');
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width > AVATAR_LIMITS.side || height > AVATAR_LIMITS.side) throw Error('头像尺寸不正确。');
  return { width, height };
}

/** `data:image/png;base64,...` from the renderer → bytes (or an error); nothing else is accepted. */
export function avatarBytesFromDataUrl(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > AVATAR_LIMITS.bytes * 1.4 + 64) throw Error('头像图片大小不正确。');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match) throw Error('头像必须是 PNG 图片。');
  const bytes = new Uint8Array(Buffer.from(match[1], 'base64'));
  validateAvatarPng(bytes);
  return bytes;
}

export class CharacterAvatarStore {
  private readonly directory: string;
  constructor(profileDirectory: string, private readonly write: (file: string, bytes: Uint8Array) => Promise<void> = writeBinaryAtomic) {
    this.directory = path.join(profileDirectory, 'character-avatars');
  }
  private file(id: string): string {
    if (typeof id !== 'string' || !uuid.test(id)) throw Error('角色卡编号不正确。');
    return path.join(this.directory, `${id.toLowerCase()}.png`);
  }
  async save(id: string, bytes: Uint8Array): Promise<void> {
    validateAvatarPng(bytes);
    const file = this.file(id);
    await mkdir(this.directory, { recursive: true });
    await this.write(file, bytes);
  }
  /** The saved picture as a data URL, or null (none, unreadable or no longer valid). */
  async read(id: string): Promise<string | null> {
    try {
      const file = this.file(id);
      if ((await stat(file)).size > AVATAR_LIMITS.bytes) return null;
      const bytes = new Uint8Array(await readFile(file));
      validateAvatarPng(bytes);
      return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    } catch { return null; }
  }
  async has(id: string): Promise<boolean> {
    try { return (await stat(this.file(id))).isFile(); } catch { return false; }
  }
  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}

/** File names a model's folder uses for its own preview picture (never a texture such as face.png). */
const PREVIEW_NAME = /^(?:preview|thumb|thumbnail|icon|cover|readme|サムネ|サムネイル|プレビュー|预览|預覽|封面|头像|頭像|缩略图)(?:[ _-]?\d*)$/iu;
const PREVIEW_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

/** The model folder's own preview picture: a preview-like name, or the model file's name with an image extension. */
export async function findModelPreview(modelPath: string): Promise<string | null> {
  if (!path.isAbsolute(modelPath)) return null;
  const folder = path.dirname(modelPath), stem = path.basename(modelPath, path.extname(modelPath)).toLowerCase();
  let entries: string[];
  try { entries = await readdir(folder); } catch { return null; }
  const candidates = entries.filter(name => PREVIEW_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .filter(name => { const base = path.basename(name, path.extname(name)); return PREVIEW_NAME.test(base) || base.toLowerCase() === stem; })
    .sort((a, b) => a.localeCompare(b));
  for (const name of candidates) {
    const file = path.join(folder, name);
    try { const info = await stat(file); if (info.isFile() && info.size <= AVATAR_LIMITS.previewBytes) return file; } catch { /* Next one. */ }
  }
  return null;
}
