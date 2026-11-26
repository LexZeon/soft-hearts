// 她的文件夹 (I-050): the one place a file name from her tail becomes a name on disk. Only a plain top-level file name of a
// text file survives: no separators, no drive or stream colon, no "..", no leading dot (hidden or her own subfolders), no
// Windows device names, no trailing dot or space (Windows would silently drop them and alias another file), no control,
// zero-width or bidi characters, at most HER_FOLDER_NAME_MAX characters. Pure; tests drive it directly.
import { HER_FOLDER_EXTENSIONS, HER_FOLDER_NAME_MAX } from '../../../shared/initiative/her-folder';

export type HerFileNameResult = { ok: true; name: string } | { ok: false; why: 'name' | 'extension' };

// C0 and C1 controls, zero-width, bidi marks and overrides, line and paragraph separators, BOM.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
// Characters Windows forbids in a name (and both separators everywhere); ':' would also open an alternate data stream.
const FORBIDDEN = /[<>:"/\\|?*]/u;
// Device names, with or without an extension (CON.txt is still the console), including the superscript-digit ports.
const RESERVED = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/iu;

/**
 * The checked name, or why it was refused. A name without an extension gets ".md" (she wrote text); any other extension is
 * refused, also a double one that ends in something else ("信.md.exe").
 */
export function sanitizeHerFileName(raw: unknown): HerFileNameResult {
  if (typeof raw !== 'string') return { ok: false, why: 'name' };
  let name = raw.normalize('NFC');
  if (!name || name !== name.trim() || INVISIBLE.test(name) || FORBIDDEN.test(name)) return { ok: false, why: 'name' };
  if (name.startsWith('.') || name.includes('..') || /[. ]$/u.test(name)) return { ok: false, why: 'name' };
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : '';
  if (!extension) name += '.md';
  else if (!(HER_FOLDER_EXTENSIONS as readonly string[]).includes(extension)) return { ok: false, why: 'extension' };
  // The part before the first dot decides a device name ("nul.tar.md" is still NUL); spaces before the dot are ignored by Windows.
  const stem = name.slice(0, name.indexOf('.')).replace(/ +$/u, '');
  if (!stem || RESERVED.test(stem)) return { ok: false, why: 'name' };
  if ([...name].length > HER_FOLDER_NAME_MAX || Buffer.byteLength(name, 'utf8') > 240) return { ok: false, why: 'name' };
  return { ok: true, name };
}

/** How two names compare on the folder's file system: Windows (and macOS by default) ignore case. */
export function nameKey(name: string, platform: NodeJS.Platform = process.platform): string {
  const normal = name.normalize('NFC');
  return platform === 'linux' ? normal : normal.toLowerCase();
}
