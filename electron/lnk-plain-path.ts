/**
 * A .lnk written by the shell stores its target as a shell item list (the "ID list"). For a folder inside OneDrive the
 * shell builds that list through a virtual root (the redirected Documents folder, OneDrive's own namespace). Windows
 * reads the target from the ID list first, so when OneDrive is not running the link's target comes back empty and
 * double-clicking it does nothing, although the file is right there (2026-11-06).
 *
 * `withPlainIdList` replaces that list with one built from the target's plain path: This PC, the drive, then one item per folder
 * and the file. Nothing in it needs OneDrive. Everything else in the link (flags other than the list, LinkInfo with the plain local
 * path, strings, the property store with the app id) is kept byte for byte. Layout: MS-SHLLINK and the shell item format.
 */
const HEADER_SIZE = 0x4c;
const LINK_CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');
const HAS_ID_LIST = 0x1;
const THIS_PC = Buffer.from('1f50e04fd020ea3a6910a2d808002b30309d', 'hex'); // type 0x1f + CLSID {20D04FE0-3AEA-1069-A2D8-08002B30309D}
const ATTR_DIRECTORY = 0x10, ATTR_ARCHIVE = 0x20;

function item(body: Buffer): Buffer {
  const size = Buffer.alloc(2); size.writeUInt16LE(body.length + 2);
  return Buffer.concat([size, body]);
}
/** A file-system item with a Unicode primary name (type 0x35 folder, 0x36 file), as the shell writes for names that are not plain 8.3. */
function fileSystemItem(name: string, directory: boolean): Buffer | null {
  const text = Buffer.from(name + '\0', 'utf16le');
  const body = Buffer.alloc(12 + text.length + (text.length % 2));
  body[0] = directory ? 0x35 : 0x36;
  body.writeUInt16LE(directory ? ATTR_DIRECTORY : ATTR_ARCHIVE, 10);
  text.copy(body, 12);
  return body.length + 2 > 0xffff ? null : item(body);
}

/** The ID list (without the leading size field) for an absolute `C:\dir\file` path, or null for anything else. */
export function plainIdList(target: string): Buffer | null {
  const match = /^([A-Za-z]):\\(.+)$/u.exec(target);
  if (!match) return null;
  const parts = match[2].split('\\');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  const drive = Buffer.concat([Buffer.from([0x2f]), Buffer.from(`${match[1].toUpperCase()}:\\`, 'latin1')]);
  const items = [item(THIS_PC), item(Buffer.concat([drive, Buffer.alloc(23 - drive.length)]))];
  for (let i = 0; i < parts.length; i++) {
    const next = fileSystemItem(parts[i], i < parts.length - 1);
    if (!next) return null;
    items.push(next);
  }
  const list = Buffer.concat([...items, Buffer.alloc(2)]);
  return list.length > 0xffff ? null : list;
}

/** The same link with its ID list rebuilt from `target`, or null when the bytes are not a link with an ID list or the path is not a plain drive path. */
export function withPlainIdList(link: Buffer, target: string): Buffer | null {
  if (link.length < HEADER_SIZE + 2 || link.readUInt32LE(0) !== HEADER_SIZE || !link.subarray(4, 20).equals(LINK_CLSID)) return null;
  if (!(link.readUInt32LE(0x14) & HAS_ID_LIST)) return null;
  const listEnd = HEADER_SIZE + 2 + link.readUInt16LE(HEADER_SIZE);
  const list = plainIdList(target);
  if (!list || listEnd > link.length) return null;
  const size = Buffer.alloc(2); size.writeUInt16LE(list.length);
  return Buffer.concat([link.subarray(0, HEADER_SIZE), size, list, link.subarray(listEnd)]);
}
