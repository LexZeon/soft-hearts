// P-001: the "may record" mark of a chat segment. A segment is marked only when the user's recording switch was on for ALL of it (set when its
// first message arrives while the switch is on; taken away as soon as a later message arrives while it is off). Segment ids only, no text:
// `upcoming-marks.json` beside the profile files. Turning the switch off by hand deletes every mark at once (the file is removed, no bin).
// Only a marked segment's note call carries the extra question about plans (electron/memory/memory-notes/core.ts).

import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { putListed, takeListed, type ListedPart } from '../../foundation/keyed-part';
import { createAtomicFileWriter, type AtomicFileDependencies } from '../../foundation/atomic-file';

export const UPCOMING_MARKS_FILE = 'upcoming-marks.json';
/** The most marks kept (the oldest go first): a mark is only needed until its note is written. */
export const MAX_MARKS = 2000;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);

export class UpcomingMarks {
  private ids = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly file: string;
  constructor(private readonly directory: string, private readonly atomic: AtomicFileDependencies = {}) {
    this.file = path.join(directory, UPCOMING_MARKS_FILE);
  }

  /** An unreadable file is no marks (nothing is recorded for those segments); it is never written over by a read. */
  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as { version?: unknown; ids?: unknown };
      if (data && data.version === 1 && Array.isArray(data.ids)) this.ids = new Set(data.ids.filter(id).slice(-MAX_MARKS));
    } catch { /* none */ }
  }
  has(recordId: string): boolean { return this.ids.has(recordId); }
  get size(): number { return this.ids.size; }

  /** The first message of a segment came in while the switch was on. */
  add(recordId: string): void {
    if (!id(recordId) || this.ids.has(recordId)) return;
    this.ids.add(recordId);
    while (this.ids.size > MAX_MARKS) this.ids.delete(this.ids.values().next().value as string);
    this.save();
  }
  /** A later message came in while the switch was off: the segment is no longer whole-recorded. */
  remove(recordIds: readonly string[]): void {
    let changed = false;
    for (const recordId of recordIds) changed = this.ids.delete(recordId) || changed;
    if (changed) this.save();
  }
  /** Only these segments still exist. */
  keepOnly(existing: ReadonlySet<string>): void {
    let changed = false;
    for (const recordId of [...this.ids]) if (!existing.has(recordId)) { this.ids.delete(recordId); changed = true; }
    if (changed) this.save();
  }
  /** The switch was turned off by hand: every mark goes, the file too. */
  wipe(): Promise<void> {
    this.ids.clear();
    return this.enqueue(async () => { await rm(this.file, { force: true }); }, true);
  }
  /** I-144 回收站: the marks of these segments, each with its place; null when none. Nothing changes. */
  recycleCopy(recordIds: readonly string[]): ListedPart<string> | null {
    const mine = new Set(recordIds);
    return takeListed([...this.ids], recordId => mine.has(recordId));
  }
  /** I-144: puts what recycleCopy copied back at its places (written in order with the other changes). */
  recycleRestore(part: ListedPart<string>): Promise<void> {
    if (!part || !Array.isArray(part.items) || part.items.some(item => !id(item?.value))) return Promise.reject(new Error('回收站里这一项的数据不完整，原文件已保留。'));
    this.ids = new Set(putListed([...this.ids], part, (a, b) => a === b));
    this.save();
    return this.queue;
  }
  flush(): Promise<void> { return this.queue; }
  dispose(): void { this.disposed = true; }

  private save(): void {
    void this.enqueue(async () => {
      // Takes the set as it is when it runs, so a burst of changes writes once and the last one wins.
      if (!this.ids.size) { await rm(this.file, { force: true }); return; }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await createAtomicFileWriter(this.atomic)(this.file, JSON.stringify({ version: 1, ids: [...this.ids] }) + '\n');
    });
  }
  private enqueue(operation: () => Promise<void>, always = false): Promise<void> {
    const next = this.queue.then(() => this.disposed && !always ? undefined : operation()).catch(() => { /* Not saved: the marks are in memory until restart; a lost mark only means one segment is not asked about. */ });
    this.queue = next;
    return next;
  }
}
