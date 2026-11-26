/**
 * Unbound v1 step 1: the two things Unbound keeps in the profile (`unbound-entry.json`): the user's 「以后直接进，不再问」 (with
 * the bundle list it was given for) and, only while she is out, the permission bundle's session (so a run that dies while she is
 * out is put back at the next start). Names and booleans only. Writes are atomic and one at a time.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../foundation/atomic-file';
import { parseBundleSession, type BundleSession } from './permission-bundle';

export const UNBOUND_ENTRY_FILE = 'unbound-entry.json';
export interface UnboundEntryRecord { version: 1; skipAsk: string | null; session: BundleSession | null }
const EMPTY: UnboundEntryRecord = Object.freeze({ version: 1, skipAsk: null, session: null }) as UnboundEntryRecord;

export function parseUnboundEntryRecord(value: unknown): UnboundEntryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY };
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return { ...EMPTY };
  const skipAsk = typeof v.skipAsk === 'string' && v.skipAsk.length <= 200 ? v.skipAsk : null;
  return { version: 1, skipAsk, session: parseBundleSession(v.session) };
}

export interface UnboundEntryStoreDeps { read?(file: string): Promise<string>; write?: AtomicFileWriter }

export class UnboundEntryStore {
  private record: UnboundEntryRecord = { ...EMPTY };
  private writes: Promise<void> = Promise.resolve();
  readonly ready: Promise<UnboundEntryRecord>;
  private readonly file: string;
  private readonly write: AtomicFileWriter;

  constructor(directory: string, deps: UnboundEntryStoreDeps = {}) {
    this.file = path.join(directory, UNBOUND_ENTRY_FILE);
    this.write = deps.write ?? atomicWriteFile;
    const read = deps.read ?? (file => readFile(file, 'utf8'));
    this.ready = read(this.file).then(text => { this.record = parseUnboundEntryRecord(JSON.parse(text)); return this.record; },
      () => this.record);
  }

  get skipAsk(): string | null { return this.record.skipAsk; }
  get session(): BundleSession | null { return this.record.session ? structuredClone(this.record.session) : null; }

  setSkipAsk(signature: string | null): Promise<void> { return this.update({ skipAsk: signature }); }
  /** I-159 D 「下次进来时再问我」: forget the saved tick, so the page comes again. true when one was saved. */
  async clearSkipAsk(): Promise<boolean> {
    await this.ready;
    const had = this.record.skipAsk !== null;
    if (had) await this.setSkipAsk(null);
    return had;
  }
  setSession(session: BundleSession | null): Promise<void> { return this.update({ session: session ? structuredClone(session) : null }); }

  private update(patch: Partial<UnboundEntryRecord>): Promise<void> {
    const run = async () => {
      await this.ready;
      this.record = { ...this.record, ...patch };
      await this.write(this.file, JSON.stringify(this.record, null, 2));
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }
}
