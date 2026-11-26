// I-071 v2 (17:3x: "claude助手应该有所有手册（包括未来的）"): finds and reads the manuals read_handbook shows
// (shared/safety/user-manuals.json is the list of files that are manuals). One root: the repository in a source checkout,
// resources/assistant-docs/ in the packaged app (package.json extraResources keeps the same docs/ layout). Only the files on that
// list are looked at, one by one (no folder is listed); a caller names a page by id, never a path.
// T-239 (Codex review: a manual folder turned into a junction, or a linked file, could be read through): every file is resolved
// to its real path, which must be exactly the expected place under the real root; anything reached through a junction, symlink
// or other alias inside the tree is skipped. The root itself may be reached through one.
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { USER_MANUALS, handbookDocFor, handbookDocSpec, type HandbookDocId, type HandbookDocKind, type HandbookDocSpec } from '../../../shared/safety/handbook-docs';

/** A page bigger than this is not read (the largest handbook page is about 200 KB). */
const MAX_BYTES = 1024 * 1024;
/** How long a listing (and the text read with it) is reused: a page added or edited in a source checkout shows up after this. */
const LIST_MS = 60_000;

export interface HandbookDocs {
  list(): Promise<HandbookDocSpec[]>;
  read(id: HandbookDocId): Promise<string>;
}

export interface HandbookDocsIo {
  read(file: string): Promise<string>;
  size(file: string): Promise<number>;
  /** The real path (links, junctions and short names resolved). */
  realpath(file: string): Promise<string>;
}

const nodeIo: HandbookDocsIo = {
  read: file => readFile(file, 'utf8'),
  size: async file => (await stat(file)).size,
  realpath: file => realpath(file),
};

/** The same place: Windows paths compare without case (realpath keeps the on-disk case, but the expected path may differ in it). */
const samePlace = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export function handbookDocsReader(root: string, io: Partial<HandbookDocsIo> = {}, now: () => number = Date.now, manuals: ReadonlyMap<string, HandbookDocKind> = USER_MANUALS): HandbookDocs {
  const use = { ...nodeIo, ...io };
  let texts = new Map<string, Promise<string>>();
  let listed: { at: number; specs: Promise<HandbookDocSpec[]> } | null = null;
  let realRoot: Promise<string> | null = null;
  const rootReal = () => {
    if (!realRoot) { const own = realRoot = use.realpath(root); own.catch(() => { if (realRoot === own) realRoot = null; }); }
    return realRoot;
  };
  /** `relative` (a folder or file under the root, '/'-separated) only when its real path is exactly that place under the real root. */
  const inside = async (relative: string): Promise<string> => {
    const base = await rootReal();
    const expected = path.join(base, ...relative.split('/'));
    const real = await use.realpath(path.join(root, ...relative.split('/')));
    if (!samePlace(real, expected)) throw new Error('outside the manuals');
    return real;
  };
  const text = (file: string) => {
    let pending = texts.get(file);
    if (!pending) {
      pending = (async () => {
        const real = await inside(file);
        if (await use.size(real) > MAX_BYTES) throw new Error('too large');
        const markdown = await use.read(real);
        // Checked again after reading: a link put in place while it was read is not used either.
        if (!samePlace(await use.realpath(real), real)) throw new Error('outside the manuals');
        return markdown;
      })();
      const own = pending;
      own.catch(() => { if (texts.get(file) === own) texts.delete(file); });
      texts.set(file, pending);
    }
    return pending;
  };
  const scan = async (): Promise<HandbookDocSpec[]> => {
    const specs: HandbookDocSpec[] = [];
    // A page this build does not have, or one reached through a link to somewhere else, is skipped.
    for (const file of [...manuals.keys()].sort()) {
      if (!handbookDocFor(file, manuals)) continue;
      const markdown = await text(file).catch(() => null);
      const spec = markdown === null ? null : handbookDocSpec(file, markdown, manuals);
      if (spec) specs.push(spec);
    }
    return specs;
  };
  const list = () => {
    if (!listed || now() - listed.at > LIST_MS) {
      texts = new Map();
      realRoot = null;
      const specs = scan(), entry = { at: now(), specs };
      specs.catch(() => { if (listed === entry) listed = null; });
      listed = entry;
    }
    return listed.specs;
  };
  return {
    list,
    async read(id) {
      const spec = (await list()).find(doc => doc.id === id);
      if (!spec) throw new Error('unknown doc');
      return text(spec.file);
    },
  };
}
