// I-048: the screenshot cache. A captured frame is kept on disk for a short time (knobs.notes.screenshotMinutes) so she can look at
// it again or a description can be rewritten; after that it is deleted. Files live only under the directory given (a folder per
// character); the age is in the file name, so expiry follows the injected clock. The frame is the data URL text, written with the
// repo's atomic writer.

import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../atomic-file';
import { characterKey } from '../memory-keywords/store';
import { WATCH_TIMELINE_KNOBS, type WatchTimelineKnobs } from '../../shared/behaviors/watch-timeline/knobs';

export const SCREENSHOT_FOLDER = 'watch-screens';
const MAX_CHARS = 12_000_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const FILE = /^(\d{1,15})_([A-Za-z0-9_-]{1,64})\.frame$/u;

export class ScreenshotCache {
  constructor(
    private readonly root: string,
    private readonly now: () => number,
    private readonly knobs: WatchTimelineKnobs['notes'] = WATCH_TIMELINE_KNOBS.notes,
    private readonly write: AtomicFileWriter = atomicWriteFile,
  ) {}

  private folder(characterId: string): string { return path.join(this.root, SCREENSHOT_FOLDER, characterKey(characterId)); }
  private expired(at: number): boolean { return this.now() - at >= this.knobs.screenshotMinutes * 60_000; }

  /** Keep one frame. `at` is when it was captured. False when the id or the frame is not acceptable, or it is already expired. */
  async put(characterId: string, id: string, dataUrl: string, at: number): Promise<boolean> {
    if (!ID.test(id) || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/') || dataUrl.length > MAX_CHARS) return false;
    if (!Number.isInteger(at) || at < 0 || this.expired(at)) return false;
    const folder = this.folder(characterId);
    await mkdir(folder, { recursive: true });
    await this.write(path.join(folder, `${at}_${id}.frame`), dataUrl);
    return true;
  }

  private async entries(characterId: string): Promise<{ at: number; id: string; file: string }[]> {
    const folder = this.folder(characterId);
    let names: string[];
    try { names = await readdir(folder); } catch { return []; }
    return names.flatMap(name => { const match = FILE.exec(name); return match ? [{ at: Number(match[1]), id: match[2], file: path.join(folder, name) }] : []; });
  }

  /** The frame, or null when it is unknown or has expired (an expired file is deleted on the way). */
  async get(characterId: string, id: string): Promise<string | null> {
    const found = (await this.entries(characterId)).find(entry => entry.id === id);
    if (!found) return null;
    if (this.expired(found.at)) { await rm(found.file, { force: true }); return null; }
    try { return await readFile(found.file, 'utf8'); } catch { return null; }
  }

  /** Delete everything past its time, in every character's folder (also leftovers of an interrupted write). Returns how many frames went. */
  async sweep(): Promise<number> {
    const top = path.join(this.root, SCREENSHOT_FOLDER);
    let folders: string[];
    try { folders = await readdir(top); } catch { return 0; }
    let removed = 0;
    for (const name of folders) {
      const folder = path.join(top, name);
      let files: string[];
      try { files = await readdir(folder); } catch { continue; }
      for (const file of files) {
        const match = FILE.exec(file);
        if (match && !this.expired(Number(match[1]))) continue;
        await rm(path.join(folder, file), { force: true });
        if (match) removed++;
      }
      try { if (!(await readdir(folder)).length) await rm(folder, { recursive: true, force: true }); } catch { /* folder already gone */ }
    }
    return removed;
  }

  /** One frame goes now (a cancelled description, a refusal). */
  async remove(characterId: string, id: string): Promise<void> {
    if (!ID.test(id)) return;
    const found = (await this.entries(characterId)).find(entry => entry.id === id);
    if (found) await rm(found.file, { force: true });
  }

  /** How many frames are on disk and how big (counts only: for the developer panel and the experience journal). */
  async stats(): Promise<{ files: number; bytes: number }> {
    const top = path.join(this.root, SCREENSHOT_FOLDER);
    let files = 0, bytes = 0, folders: string[];
    try { folders = await readdir(top); } catch { return { files, bytes }; }
    for (const name of folders) {
      let names: string[];
      try { names = await readdir(path.join(top, name)); } catch { continue; }
      for (const file of names) {
        if (!FILE.test(file)) continue;
        try { bytes += (await stat(path.join(top, name, file))).size; files++; } catch { /* gone meanwhile */ }
      }
    }
    return { files, bytes };
  }

  /** Forget: every frame of this character goes now, expired or not. */
  async forget(characterId: string): Promise<void> {
    await rm(this.folder(characterId), { recursive: true, force: true });
  }
}
