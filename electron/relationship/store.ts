import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../atomic-file';
import { KeptFields, splitUnknownFields, type KnownFields } from '../unknown-fields';
import {
  RELATIONSHIP_LIMITS, cleanNickname, emptyRelationship, isDateKey, type RelationshipData,
} from '../../shared/relationship';

const MAX_FILE_BYTES = 400_000;
/**
 * What this version knows in a relationship file (docs/claude/2026-11-04-keep-unknown-fields.md). Anything else a newer
 * version wrote is kept aside and written back with the next change, never read; before, such a file was refused and the
 * character worked from an empty relationship (as if they had just met) until a newer version ran again. `today` is one
 * whole value: it starts over every day, so a newer version's part of it must not move on to another day.
 */
const RELATIONSHIP_KNOWN_FIELDS: KnownFields = { version: true, metDate: true, days: true, qualityDays: true, today: true,
  backfilled: true, nickname: true, herNickname: true, nicknameAsked: true, milestones: true };

/** A file name for any character id: the id itself when it is a plain token, a hash of it otherwise. */
export function relationshipFileName(characterId: string): string {
  if (typeof characterId !== 'string' || !characterId || characterId.length > 256 || characterId.includes('\0')) throw Error('角色编号不正确。');
  return (/^[A-Za-z0-9_-]{1,64}$/.test(characterId) ? characterId : createHash('sha256').update(characterId).digest('hex')) + '.json';
}

function dates(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit) throw Error('关系数据格式不正确。');
  const out: string[] = [];
  for (const item of value) {
    if (!isDateKey(item)) throw Error('关系数据格式不正确。');
    if (!out.includes(item)) out.push(item);
  }
  return out.sort();
}

/** Throws on anything this file must not contain; the caller then leaves the file alone. */
export function validateRelationship(value: unknown): RelationshipData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('关系数据格式不正确。');
  const input = value as Record<string, unknown>;
  const keys = ['version', 'metDate', 'days', 'qualityDays', 'today', 'backfilled', 'nickname', 'herNickname', 'nicknameAsked', 'milestones'];
  if (input.version !== 1 || Object.keys(input).some(key => !keys.includes(key)) || !isDateKey(input.metDate)) throw Error('关系数据格式不正确。');
  const today = input.today as Record<string, unknown> | undefined;
  if (!today || typeof today !== 'object' || !isDateKey(today.date) || !Number.isSafeInteger(today.rounds) || (today.rounds as number) < 0
    || typeof today.touched !== 'boolean') throw Error('关系数据格式不正确。');
  const nickname = input.nickname === null || input.nickname === undefined ? null : cleanNickname(input.nickname);
  if (input.nickname !== null && input.nickname !== undefined && nickname === null) throw Error('关系数据格式不正确。');
  // Absent in files written before the user could give her a nickname.
  const herNickname = input.herNickname === null || input.herNickname === undefined ? null : cleanNickname(input.herNickname);
  if (input.herNickname !== null && input.herNickname !== undefined && herNickname === null) throw Error('关系数据格式不正确。');
  if (typeof input.nicknameAsked !== 'boolean') throw Error('关系数据格式不正确。');
  const backfilled = input.backfilled, milestones = input.milestones;
  if (!Array.isArray(backfilled) || backfilled.length > RELATIONSHIP_LIMITS.backfilledScopes || !backfilled.every(item => typeof item === 'string' && item.length <= 128)
    || !Array.isArray(milestones) || milestones.length > RELATIONSHIP_LIMITS.milestones || !milestones.every(item => typeof item === 'string' && item.length <= 64))
    throw Error('关系数据格式不正确。');
  return {
    version: 1, metDate: input.metDate, days: dates(input.days, RELATIONSHIP_LIMITS.days), qualityDays: dates(input.qualityDays, RELATIONSHIP_LIMITS.days),
    today: { date: today.date as string, rounds: today.rounds as number, touched: today.touched as boolean },
    backfilled: [...backfilled] as string[], nickname, herNickname, nicknameAsked: input.nicknameAsked, milestones: [...milestones] as string[],
  };
}

/**
 * One small file per character (`<profile>/relationship/<id>.json`): how long they have known each
 * other. Per character on purpose, so a different chat model never starts it over; it is not part of
 * the exported character card. A file it cannot read is left untouched and the character simply
 * works from memory until the next start.
 */
export class RelationshipStore {
  private readonly cache = new Map<string, RelationshipData>();
  private readonly readOnly = new Set<string>();
  /** Per character: the unknown fields of its file (unknown-fields.ts). */
  private readonly kept = new Map<string, KeptFields>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  constructor(profileDirectory: string, private readonly options: { write?: AtomicFileWriter; today(): string; log?: (line: string) => void }) {
    this.directory = path.join(profileDirectory, 'relationship');
  }

  private file(characterId: string): string { return path.join(this.directory, relationshipFileName(characterId)); }

  /** The cached data, or null before `load` (or `update`) has run for this character. */
  peek(characterId: string): RelationshipData | null {
    const data = this.cache.get(characterId);
    return data ? structuredClone(data) : null;
  }

  /** Reads the file once; a missing file starts empty (today is the day they met), a broken one is left alone. */
  load(characterId: string): Promise<RelationshipData> {
    return this.serialize(async () => this.read(characterId));
  }

  /** Applies a pure change, caches it, and writes the file. Resolves to the new data. */
  update(characterId: string, change: (data: RelationshipData) => RelationshipData): Promise<RelationshipData> {
    return this.serialize(async () => {
      const before = await this.read(characterId);
      const after = change(structuredClone(before));
      this.cache.set(characterId, after);
      if (JSON.stringify(after) !== JSON.stringify(before) && !this.readOnly.has(characterId)) {
        try {
          await mkdir(this.directory, { recursive: true });
          const stored = (this.kept.get(characterId) ?? KeptFields.none).writeInto(after);
          await (this.options.write ?? atomicWriteFile)(this.file(characterId), JSON.stringify(stored, null, 2));
        } catch { /* Counting goes on from memory; the next change tries the file again. */ }
      }
      return structuredClone(after);
    });
  }

  private async read(characterId: string): Promise<RelationshipData> {
    const cached = this.cache.get(characterId);
    if (cached) return structuredClone(cached);
    let data: RelationshipData;
    const file = this.file(characterId);
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) throw Error('too large');
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      const split = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? splitUnknownFields(raw as Record<string, unknown>, RELATIONSHIP_KNOWN_FIELDS,
          { label: `relationship/${path.basename(file)}`, ...(this.options.log ? { log: this.options.log } : {}) })
        : null;
      data = validateRelationship(split ? split.known : raw);
      if (split && !split.kept.empty) this.kept.set(characterId, split.kept);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.readOnly.add(characterId);
      data = emptyRelationship(this.options.today());
    }
    this.cache.set(characterId, data);
    return structuredClone(data);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  /** C2 删除角色时"同时删除她的记忆": this character's file (days, nickname, milestones) goes. */
  forget(characterId: string): Promise<void> {
    return this.serialize(async () => {
      const file = this.file(characterId);
      this.cache.delete(characterId); this.readOnly.delete(characterId); this.kept.delete(characterId);
      await rm(file, { force: true });
    });
  }

  flush(): Promise<void> { return this.queue.then(() => {}, () => {}); }
}
