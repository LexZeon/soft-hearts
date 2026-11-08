import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { AmbientAudioStore } from './ambient-audio-store';
import type { AtomicFileWriter } from './atomic-file';
import { AMBIENT_AUDIO_LIMITS as LIMITS, validateAmbientLanguage, type AmbientScope, type AmbientTranscript,
  type AmbientTranscriptInput, type AmbientTranscriptPage, type AmbientTranscriptQuery, type AmbientContextQuery,
  type AmbientContextItem, type AmbientComment, type AmbientCommentInput, type AmbientDeleteResult,
  type AmbientUserResponse, type AmbientLongTermCandidate, type AmbientLanguage } from '../shared/ambient-audio';
import type { AudioReadingPublication } from './audio-reading-host-broker';
import type { MemoryStore } from './memory';

interface ReadingRecord extends AmbientTranscript { scopeKey: string; observations: NonNullable<AmbientTranscript['observations']>; }
interface ReadingComment extends AmbientComment { scopeKey: string; }
interface Sidecar {
  version: 2; records: ReadingRecord[]; comments: ReadingComment[];
  deleted: string[]; deletedComments: string[]; responses: string[];
  /** Durable suppression and retry receipt if deletion from the legacy file fails. */
  legacyDeletes: { scopeKey: string; id: string; pending: boolean }[];
  sequences: { scopeKey: string; sessionId: string; last: number }[];
}
export interface ReadingArchiveStage { commit(): Promise<void>; discard(): Promise<void>; }
interface Options {
  now?(): number;
  legacyWriteFile?: AtomicFileWriter;
  stage?(file: string, text: string): Promise<ReadingArchiveStage>;
}
export interface ReadingAppendResult {
  state: 'cancelled' | 'committed'; committed: boolean; publishable: boolean;
  inserted: boolean; record: AmbientTranscript | null;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const scopeKey = (scope: AmbientScope) => {
  if (!scope || typeof scope.characterId !== 'string' || !scope.characterId || scope.characterId.length > 256
    || typeof scope.providerScope !== 'string' || !scope.providerScope || scope.providerScope.length > 4096
    || scope.characterId.includes('\0') || scope.providerScope.includes('\0')) throw Error('Invalid audio archive scope.');
  return hash(JSON.stringify([scope.characterId, scope.providerScope]));
};
const receipt = (scope: string, id: string) => hash(JSON.stringify([scope, id]));
const token = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 256 && !/[\0\r\n]/.test(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const modes = (value: unknown): value is ('music' | 'movie')[] => Array.isArray(value) && value.length > 0 && value.length <= 2
  && value.every(v => v === 'music' || v === 'movie') && new Set(value).size === value.length;
const text = (value: unknown, max = 4000): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
const plain = <T extends { scopeKey: string }>(record: T): Omit<T, 'scopeKey'> => { const { scopeKey: _key, ...value } = record; return structuredClone(value); };
const summary = (record: AmbientTranscript) => { const { text: original, ...rest } = record; return { ...rest, excerpt: original.slice(0, 180), totalCharacters: original.length }; };
const empty = (): Sidecar => ({ version: 2, records: [], comments: [], deleted: [], deletedComments: [], responses: [], legacyDeletes: [], sequences: [] });
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/** Stage only an owned ordinary file. Cancellation may discard this temp, never a user file. */
export async function stageReadingArchive(file: string, value: string): Promise<ReadingArchiveStage> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(value, 'utf8'); await handle.sync(); }
  catch (error) {
    try { await handle.close(); await rm(temporary, { force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Audio archive staging and cleanup failed.'); }
    throw error;
  }
  await handle.close();
  return {
    commit: async () => {
      // Same bounded Windows sharing-lock policy as the existing v1 writer.
      const delays = [25, 50, 100, 200, 400];
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, file); return; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= delays.length) throw error;
          await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        }
      }
    }, discard: () => rm(temporary, { force: true }),
  };
}

/** V2 sidecar + unchanged V1 reader/writer. New metadata never enters the legacy file. */
export class AudioReadingArchive extends AmbientAudioStore {
  private readonly readingFile: string;
  private readonly readingNow: () => number;
  private readonly readingStage: NonNullable<Options['stage']>;
  private sidecar = empty();
  private readingQueue: Promise<unknown> = Promise.resolve();
  private readingLoaded = false;
  private readingRecent = new Set<string>();
  private readingCandidates = new Map<string, { scope: string; value: AmbientLongTermCandidate }>();
  private readingGeneration = 0;
  private readingScopeGenerations = new Map<string, number>();

  constructor(directory: string, options: Options = {}) {
    super(directory, { now: options.now, writeFile: options.legacyWriteFile });
    this.readingFile = path.join(directory, 'audio-reading-v2.json');
    this.readingNow = options.now ?? Date.now; this.readingStage = options.stage ?? stageReadingArchive;
  }
  override async load(): Promise<void> {
    await super.load();
    await this.serial(async () => {
      if (this.readingLoaded) return;
      let value: unknown;
      try {
        if ((await stat(this.readingFile)).size > LIMITS.archiveBytes) throw Error('Archive capacity exceeded.');
        value = JSON.parse(await readFile(this.readingFile, 'utf8'));
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.readingLoaded = true; return; } throw Error('音频v2档案无法读取，原文件保持。'); }
      this.sidecar = this.validate(value); this.readingLoaded = true;
      // Persistence is searchable only. It never joins this run's recent context.
    });
  }
  appendReading(scope: AmbientScope, publication: AudioReadingPublication, language: AmbientLanguage): Promise<ReadingAppendResult> {
    const key = scopeKey(scope), verifiedLanguage = validateAmbientLanguage(language), generation = this.readingStamp(key);
    if (!token(publication.segmentId) || !token(publication.captureId) || !/^[A-Za-z0-9_-]{1,100}$/.test(publication.scopeId) || !text(publication.text)
      || !['system-audio', 'microphone'].includes(publication.source) || !timestamp(publication.startedAtMs)
      || !timestamp(publication.endedAtMs) || publication.endedAtMs <= publication.startedAtMs) return Promise.reject(Error('Invalid ambient final.'));
    return this.serial(async () => {
      this.readyReading();
      const duplicate = this.sidecar.records.find(r => r.scopeKey === key && r.observations.some(o => o.segmentId === publication.segmentId));
      if (duplicate) {
        const observed = duplicate.observations.find(o => o.segmentId === publication.segmentId)!;
        if (observed.text !== publication.text || observed.source !== publication.source || duplicate.sessionId !== publication.scopeId)
          throw Error('Ambient segment identity conflict.');
        return { state: 'committed', committed: true, publishable: false, inserted: false, record: plain(duplicate) };
      }
      const segmentReceipt = `ar-${publication.segmentId}`;
      if (this.sidecar.deleted.includes(receipt(key, segmentReceipt))) throw Error('Deleted ambient segment cannot be restored.');
      const match = normalized(publication.text);
      // Only overlapping cross-source observations, never repeated same-source lyrics.
      const shared = match.length >= 8 ? this.sidecar.records.find(r => r.scopeKey === key && r.sessionId === publication.scopeId
        && r.source !== publication.source && r.observations.length < 8 && Math.abs(r.endedAt - publication.endedAtMs) <= 2000
        && Math.min(r.endedAt, publication.endedAtMs) > Math.max(r.startedAt, publication.startedAtMs)
        && normalized(r.text) === match) : undefined;
      const previousSequence = this.sidecar.sequences.find(s => s.scopeKey === key && s.sessionId === publication.scopeId);
      const nextSequence = (previousSequence?.last ?? 0) + 1;
      if (!Number.isSafeInteger(nextSequence)) throw Error('Audio observation sequence exhausted.');
      // Preserve the existing host/mood observation contract. Immutable segment
      // hashes remain in observations and make retries stable across reloads.
      const id = `${publication.scopeId}:${nextSequence}`;
      for (;;) {
        const purposes = [...publication.currentPurposes()];
        if (publication.signal.aborted || generation !== this.readingStamp(key) || !modes(purposes)) return this.cancelled();
        const observation = { segmentId: publication.segmentId, source: publication.source, purposes,
          startedAt: publication.startedAtMs, endedAt: publication.endedAtMs, text: publication.text };
        const record: ReadingRecord = shared ? { ...shared,
          purposes: [...new Set([...(shared.purposes ?? [shared.mode]), ...purposes])],
          observations: [...shared.observations, observation],
          tags: [...new Set([...shared.tags, publication.source, ...purposes])].slice(0, LIMITS.tags) }
          : { id, sessionId: publication.scopeId, mode: purposes[0], purposes, scopeKey: key, source: publication.source,
            startedAt: publication.startedAtMs, endedAt: publication.endedAtMs, text: publication.text,
            language: verifiedLanguage, title: publication.text.trim().slice(0, 80), tags: [publication.source, ...purposes],
            createdAt: this.readingNow(), observations: [observation] };
        const next: Sidecar = { ...this.sidecar,
          records: shared ? this.sidecar.records.map(r => r === shared ? record : r) : [...this.sidecar.records, record],
          sequences: shared ? this.sidecar.sequences : previousSequence
            ? this.sidecar.sequences.map(s => s === previousSequence ? { ...s, last: nextSequence } : s)
            : [...this.sidecar.sequences, { scopeKey: key, sessionId: publication.scopeId, last: nextSequence }],
        };
        const staged = await this.prepare(next);
        const current = [...publication.currentPurposes()];
        if (publication.signal.aborted || generation !== this.readingStamp(key) || !modes(current)) { await staged.discard(); return this.cancelled(); }
        if (JSON.stringify(current) !== JSON.stringify(purposes)) { await staged.discard(); continue; }
        // Linearization: a synchronous decision before invoking rename. A revoke
        // which already won cancels; after commit starts it cannot erase a real
        // durable receipt. Publication is independently checked after settlement.
        const gate: { state: 'pending' | 'cancelled' | 'commit-started' } = { state: 'pending' };
        const revoke = () => { if (gate.state === 'pending') gate.state = 'cancelled'; };
        publication.signal.addEventListener('abort', revoke, { once: true });
        if (publication.signal.aborted) revoke();
        try {
          if (gate.state === 'cancelled' || generation !== this.readingStamp(key) || !publication.currentPurposes().length) { await staged.discard(); return this.cancelled(); }
          gate.state = 'commit-started';
          await this.commit(staged, next);
        } finally { publication.signal.removeEventListener('abort', revoke); }
        const publishable = !publication.signal.aborted && generation === this.readingStamp(key) && publication.currentPurposes().length > 0;
        if (publishable && !shared) {
          this.readingRecent.add(receipt(key, record.id));
          const recent = this.sidecar.records.filter(r => r.scopeKey === key && r.sessionId === record.sessionId && this.readingRecent.has(receipt(key, r.id)))
            .sort((a, b) => b.endedAt - a.endedAt);
          for (const old of recent.slice(LIMITS.recentRecords)) this.readingRecent.delete(receipt(key, old.id));
        }
        return { state: 'committed', committed: true, publishable: publishable && !shared, inserted: !shared, record: plain(record) };
      }
    });
  }
  override list(scope: AmbientScope, query: AmbientTranscriptQuery = {}): AmbientTranscriptPage {
    this.readyReading(); const key = scopeKey(scope);
    if (query.query !== undefined && (typeof query.query !== 'string' || query.query.length > 200) || query.tag !== undefined && !token(query.tag)) throw Error('Invalid audio query.');
    const offset = this.number(query.offset, 0, Number.MAX_SAFE_INTEGER), limit = this.number(query.limit, 30, 100);
    const hidden = new Set(this.sidecar.legacyDeletes.filter(r => r.scopeKey === key).map(r => r.id));
    const legacy: AmbientTranscriptPage['records'] = [];
    let first = super.list(scope, { ...query, offset: 0, limit: 100 });
    const legacyTotal = first.total - [...hidden].filter(id => { const r = super.read(scope, id); return r && this.matches(r, query); }).length;
    for (let from = 0; from < first.total && legacy.length < offset + limit; from += 100) {
      const page = from === 0 ? first : super.list(scope, { ...query, offset: from, limit: 100 });
      legacy.push(...page.records.filter(r => !hidden.has(r.id)));
    }
    const own = this.sidecar.records.filter(r => r.scopeKey === key && this.matches(r, query)).map(r => summary(plain(r)));
    const records = [...legacy, ...own].sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
    return { offset, limit, total: legacyTotal + own.length, records: records.slice(offset, offset + limit),
      tags: [...new Set([...first.tags, ...this.sidecar.records.filter(r => r.scopeKey === key).flatMap(r => r.tags)])].sort().slice(0, 200) };
  }
  override read(scope: AmbientScope, id: string): AmbientTranscript | null {
    this.readyReading(); const key = scopeKey(scope); if (!token(id)) throw Error('Invalid audio identity.');
    const own = this.sidecar.records.find(r => r.scopeKey === key && r.id === id);
    return own ? plain(own) : this.sidecar.legacyDeletes.some(r => r.scopeKey === key && r.id === id) ? null : super.read(scope, id);
  }
  override context(scope: AmbientScope, query: AmbientContextQuery): AmbientContextItem[] {
    this.readyReading(); const key = scopeKey(scope), now = query.now ?? this.readingNow();
    const own = this.sidecar.records.filter(r => r.scopeKey === key && r.sessionId === query.sessionId && this.readingRecent.has(receipt(key, r.id))
      && r.endedAt <= now && now - r.endedAt <= LIMITS.recentMilliseconds).map(r => ({ ...summary(plain(r)), text: r.text, truncated: false }));
    const all = [...super.context(scope, query), ...own].sort((a, b) => a.endedAt - b.endedAt);
    let remaining = this.number(query.maxCharacters, LIMITS.recentCharacters, LIMITS.recentCharacters);
    const count = this.number(query.maxRecords, LIMITS.recentRecords, LIMITS.recentRecords);
    if (!count || !remaining) return [];
    return all.slice(-count).reverse().flatMap(r => {
      if (!remaining) return [];
      const value = r.text.slice(0, remaining); remaining -= value.length;
      return [{ ...r, text: value, truncated: value.length !== r.text.length }];
    }).reverse();
  }
  override appendComment(scope: AmbientScope, input: AmbientCommentInput): Promise<{ comment: AmbientComment; inserted: boolean }> {
    const key = scopeKey(scope);
    if (!input.recordIds?.some(id => this.sidecar.records.some(r => r.scopeKey === key && r.id === id))) return super.appendComment(scope, input);
    return this.serial(async () => {
      this.readyReading();
      if (!token(input.id) || input.id.length > 100 || !token(input.sessionId) || !text(input.text, LIMITS.commentCharacters) || !timestamp(input.createdAt)
        || !input.recordIds.length || input.recordIds.length > 3 || new Set(input.recordIds).size !== input.recordIds.length
        || input.recordIds.some(id => this.read(scope, id)?.sessionId !== input.sessionId)) throw Error('Invalid reading comment link.');
      if (this.sidecar.deletedComments.includes(receipt(key, input.id))) throw Error('Deleted reading comment cannot be restored.');
      const existing = this.sidecar.comments.find(c => c.scopeKey === key && c.id === input.id);
      if (existing) return { comment: plain(existing), inserted: false };
      const comment: ReadingComment = { ...structuredClone(input), source: 'ambient-assistant-comment', scopeKey: key };
      await this.save({ ...this.sidecar, comments: [...this.sidecar.comments, comment] });
      return { comment: plain(comment), inserted: true };
    });
  }
  override comments(scope: AmbientScope, id?: string): AmbientComment[] {
    const key = scopeKey(scope);
    return [...super.comments(scope, id), ...this.sidecar.comments.filter(c => c.scopeKey === key && (id === undefined || c.recordIds.includes(id))).map(plain)]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  override deleteComment(scope: AmbientScope, id: string): Promise<boolean> {
    const key = scopeKey(scope);
    if (!this.sidecar.comments.some(c => c.scopeKey === key && c.id === id)) return super.deleteComment(scope, id);
    return this.serial(async () => {
      await this.save({ ...this.sidecar, comments: this.sidecar.comments.filter(c => c.scopeKey !== key || c.id !== id),
        deletedComments: [...new Set([...this.sidecar.deletedComments, receipt(key, id)])] });
      this.clearTransient(scope); return true;
    });
  }
  override delete(scope: AmbientScope, id: string): Promise<AmbientDeleteResult> {
    const key = scopeKey(scope);
    return this.serial(async () => {
      const own = this.sidecar.records.some(r => r.scopeKey === key && r.id === id);
      const legacy = super.read(scope, id), pending = this.sidecar.legacyDeletes.find(r => r.scopeKey === key && r.id === id);
      if (!own && !legacy && !pending) return { deleted: false, invalidatedCandidateIds: [] };
      const removed = this.sidecar.comments.filter(c => c.scopeKey === key && c.recordIds.includes(id));
      const next: Sidecar = { ...this.sidecar, records: this.sidecar.records.filter(r => r.scopeKey !== key || r.id !== id),
        comments: this.sidecar.comments.filter(c => !removed.includes(c)), deleted: [...new Set([...this.sidecar.deleted, receipt(key, id),
          ...this.sidecar.records.filter(r => r.scopeKey === key && r.id === id).flatMap(r => r.observations.map(o => receipt(key, `ar-${o.segmentId}`)))])],
        deletedComments: [...new Set([...this.sidecar.deletedComments, ...removed.map(c => receipt(key, c.id))])],
        legacyDeletes: legacy && !pending ? [...this.sidecar.legacyDeletes, { scopeKey: key, id, pending: true }] : this.sidecar.legacyDeletes };
      const invalidatedOwn = [...this.readingCandidates.entries()].filter(([, c]) => c.scope === key && c.value.recordIds.includes(id)).map(([candidateId]) => candidateId);
      await this.save(next); this.readingRecent.delete(receipt(key, id)); this.clearTransient(scope);
      let legacyResult: AmbientDeleteResult = { deleted: false, invalidatedCandidateIds: [] };
      if (legacy || pending?.pending) {
        legacyResult = await super.delete(scope, id);
        await this.save({ ...this.sidecar, legacyDeletes: this.sidecar.legacyDeletes.map(r => r.scopeKey === key && r.id === id ? { ...r, pending: false } : r) });
      }
      return { deleted: own || !!legacy || !!pending, invalidatedCandidateIds: [...new Set([...invalidatedOwn, ...legacyResult.invalidatedCandidateIds])],
        deletedCommentIds: [...new Set([...removed.map(c => c.id), ...(legacyResult.deletedCommentIds ?? [])])] };
    });
  }
  /** Retry only durable partial legacy removals for the supplied host-owned scope. */
  async reconcile(scope: AmbientScope): Promise<void> {
    const key = scopeKey(scope);
    for (const pending of this.sidecar.legacyDeletes.filter(r => r.scopeKey === key && r.pending)) await this.delete(scope, pending.id);
    // A legacy writer may have removed a referenced record while this app was off.
    await this.serial(async () => {
      const removed = this.sidecar.comments.filter(c => c.scopeKey === key && c.recordIds.some(id => !this.read(scope, id)));
      if (removed.length) await this.save({ ...this.sidecar, comments: this.sidecar.comments.filter(c => !removed.includes(c)),
        deletedComments: [...new Set([...this.sidecar.deletedComments, ...removed.map(c => receipt(key, c.id))])] });
    });
  }
  /** Repair only already-acknowledged archival copies, never a presentation,
   * user turn, model call or reward. V1 memory tombstones prevent resurrection
   * when the pinned older app deleted a copy without understanding this sidecar.
   */
  repairCommentCopies(scope: AmbientScope, memory: Pick<MemoryStore,
    'findInitiative' | 'hasDeletedTurn' | 'appendInitiative' | 'delete'>): Promise<{ copied: number; deleted: number; pending: number }> {
    const key = scopeKey(scope);
    return this.serial(async () => {
      this.readyReading();
      let copied = 0, deleted = 0, pending = 0;
      for (const comment of this.sidecar.comments.filter(c => c.scopeKey === key)) {
        const existing = memory.findInitiative(scope, comment.id);
        const missingSource = comment.recordIds.some(id => !this.read(scope, id));
        const withdrawn = memory.hasDeletedTurn(scope, comment.id);
        if (!missingSource && !withdrawn && existing) continue;
        if (copied + deleted >= LIMITS.recentRecords) { pending++; continue; }
        if (!missingSource && !withdrawn) {
          try {
            await memory.appendInitiative(scope, { id: comment.id, text: comment.text, at: comment.createdAt,
              origin: { kind: 'proactive', id: comment.id, at: comment.createdAt,
                sources: ['ambient'], labels: ['外部音频资料'] } });
            copied++; continue;
          } catch (error) {
            // A real user deletion can win while the append waits on its queue.
            // The original error still escapes unless that durable fact exists.
            if (!memory.hasDeletedTurn(scope, comment.id)) throw error;
          }
        }
        if (existing) await memory.delete(scope, existing.recordId);
        await this.save({ ...this.sidecar,
          comments: this.sidecar.comments.filter(c => c !== comment),
          deletedComments: [...new Set([...this.sidecar.deletedComments, receipt(key, comment.id)])],
        });
        deleted++;
      }
      return { copied, deleted, pending };
    });
  }
  /** Withdraw only this source's transient context; persisted originals stay searchable. */
  clearSourceTransient(scope: AmbientScope, source: 'system-audio' | 'microphone'): void {
    const key = scopeKey(scope), ids = new Set<string>();
    for (const r of this.sidecar.records) if (r.scopeKey === key && r.observations.some(o => o.source === source)) {
      this.readingRecent.delete(receipt(key, r.id)); ids.add(r.id);
    }
    for (const [id, c] of this.readingCandidates) if (c.scope === key && c.value.recordIds.some(record => ids.has(record))) this.readingCandidates.delete(id);
  }
  override invalidatePendingTransient(scope: AmbientScope): void {
    super.invalidatePendingTransient(scope); const key = scopeKey(scope);
    this.readingScopeGenerations.set(key, (this.readingScopeGenerations.get(key) ?? 0) + 1);
  }
  override clearTransient(scope?: AmbientScope): void {
    super.clearTransient(scope);
    if (!scope) this.readingGeneration++;
    if (!scope) { this.readingRecent.clear(); this.readingCandidates.clear(); return; }
    const key = scopeKey(scope);
    for (const r of this.sidecar.records) if (r.scopeKey === key) this.readingRecent.delete(receipt(key, r.id));
    for (const [id, c] of this.readingCandidates) if (c.scope === key) this.readingCandidates.delete(id);
  }
  override recordUserResponse(scope: AmbientScope, input: AmbientUserResponse): Promise<AmbientLongTermCandidate | null> {
    const key = scopeKey(scope);
    if (!input.recordIds?.some(id => this.sidecar.records.some(r => r.scopeKey === key && r.id === id))) return super.recordUserResponse(scope, input);
    const generation = this.readingStamp(key);
    return this.serial(async () => {
      if (generation !== this.readingStamp(key) || !token(input.eventId) || !text(input.text, LIMITS.userResponseCharacters) || !timestamp(input.at)
        || !input.recordIds.length || input.recordIds.length > 3 || new Set(input.recordIds).size !== input.recordIds.length) return null;
      const event = receipt(key, `response:${input.eventId}`);
      const recent = this.context(scope, { sessionId: this.read(scope, input.recordIds[0])?.sessionId ?? '', now: input.at });
      if (this.sidecar.responses.includes(event) || input.recordIds.some(id => !recent.some(r => r.id === id))) return null;
      await this.save({ ...this.sidecar, responses: [...this.sidecar.responses, event] });
      if (generation !== this.readingStamp(key) || !/我.{0,8}(喜欢|讨厌|想|觉得|记得|偏好|害怕)|i (?:like|prefer|love|hate|remember)|私.{0,20}(好き|嫌い|思|覚)/iu.test(input.text)) return null;
      const value: AmbientLongTermCandidate = { id: event, eventId: input.eventId, recordIds: [...input.recordIds], userText: input.text,
        at: input.at, source: 'user-response-to-system-audio', requiresReview: true };
      this.readingCandidates.set(event, { scope: key, value });
      while (this.readingCandidates.size > 12) this.readingCandidates.delete(this.readingCandidates.keys().next().value!);
      return structuredClone(value);
    });
  }
  override candidate(scope: AmbientScope, id: string): AmbientLongTermCandidate | null {
    const own = this.readingCandidates.get(id);
    if (own?.scope === scopeKey(scope)) {
      const now = this.readingNow();
      if (now >= own.value.at && now - own.value.at <= LIMITS.recentMilliseconds && own.value.recordIds.every(r => this.read(scope, r) && this.readingRecent.has(receipt(own.scope, r)))) return structuredClone(own.value);
      this.readingCandidates.delete(id);
    }
    return super.candidate(scope, id);
  }
  override async flush(): Promise<void> { await super.flush(); await this.readingQueue; }
  private readingStamp(key: string): string { return `${this.readingGeneration}:${this.readingScopeGenerations.get(key) ?? 0}`; }
  private readyReading(): void { if (!this.readingLoaded) throw Error('Audio reading archive is not loaded.'); }
  private number(value: number | undefined, fallback: number, max: number): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw Error('Invalid audio query limit.');
    return value;
  }
  private matches(record: AmbientTranscript, query: AmbientTranscriptQuery): boolean {
    const needle = query.query?.trim().toLocaleLowerCase();
    return (!query.tag || record.tags.includes(query.tag)) && (!needle || [record.text, record.title, ...record.tags].some(v => v.toLocaleLowerCase().includes(needle)));
  }
  private cancelled(): ReadingAppendResult { return { state: 'cancelled', committed: false, publishable: false, inserted: false, record: null }; }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.readingQueue.then(operation, operation); this.readingQueue = result.catch(() => undefined); return result;
  }
  private async prepare(next: Sidecar): Promise<ReadingArchiveStage> {
    const value = JSON.stringify(next) + '\n';
    if (Buffer.byteLength(value) > LIMITS.archiveBytes) throw Error('Audio archive capacity exceeded.');
    await mkdir(path.dirname(this.readingFile), { recursive: true });
    return this.readingStage(this.readingFile, value);
  }
  private async commit(staged: ReadingArchiveStage, next: Sidecar): Promise<void> {
    try { await staged.commit(); this.sidecar = next; }
    catch (error) {
      try { await staged.discard(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Audio archive commit and owned-temp cleanup failed.'); }
      throw error;
    }
  }
  private async save(next: Sidecar): Promise<void> { await this.commit(await this.prepare(next), next); }
  private validate(value: unknown): Sidecar {
    const v = value as Sidecar;
    if (!v || typeof v !== 'object' || Array.isArray(v) || v.version !== 2
      || Object.keys(v).sort().join() !== ['version', 'records', 'comments', 'deleted', 'deletedComments', 'responses', 'legacyDeletes', 'sequences'].sort().join()
      || ![v.records, v.comments, v.deleted, v.deletedComments, v.responses, v.legacyDeletes, v.sequences].every(Array.isArray)) throw Error('Invalid audio v2 archive.');
    const sequenceKeys = new Set<string>();
    for (const counter of v.sequences) {
      const key = receipt(counter.scopeKey, counter.sessionId);
      if (!/^[a-f0-9]{64}$/.test(counter.scopeKey) || !/^[A-Za-z0-9_-]{1,100}$/.test(counter.sessionId)
        || !Number.isSafeInteger(counter.last) || counter.last < 1 || sequenceKeys.has(key)) throw Error('Invalid audio observation counter.');
      sequenceKeys.add(key);
    }
    const keys = new Set<string>(), recordKeys = new Set<string>();
    for (const r of v.records) {
      if (!r || !/^[a-f0-9]{64}$/.test(r.scopeKey) || !token(r.id) || !token(r.sessionId) || !text(r.text)
        || !text(r.title, 120) || !timestamp(r.startedAt) || !timestamp(r.endedAt) || r.endedAt <= r.startedAt || !timestamp(r.createdAt)
        || !['system-audio', 'microphone'].includes(r.source) || !modes(r.purposes) || !r.purposes.includes(r.mode)
        || !Array.isArray(r.tags) || r.tags.length > 12 || !r.tags.every(t => token(t) && t.length <= 40)
        || !Array.isArray(r.observations) || !r.observations.length || r.observations.length > 8) throw Error('Invalid audio v2 record.');
      const counter = v.sequences.find(s => s.scopeKey === r.scopeKey && s.sessionId === r.sessionId);
      const suffix = r.id.slice(r.sessionId.length + 1), recordKey = receipt(r.scopeKey, r.id);
      if (!r.id.startsWith(r.sessionId + ':') || !/^[1-9][0-9]{0,19}$/.test(suffix)
        || !Number.isSafeInteger(Number(suffix)) || !counter || Number(suffix) > counter.last || recordKeys.has(recordKey)) throw Error('Invalid audio observation identity.');
      recordKeys.add(recordKey);
      r.language = validateAmbientLanguage(r.language);
      for (const o of r.observations) {
        if (!o || !token(o.segmentId) || !['system-audio', 'microphone'].includes(o.source) || !modes(o.purposes)
          || !timestamp(o.startedAt) || !timestamp(o.endedAt) || o.endedAt <= o.startedAt || !text(o.text)) throw Error('Invalid audio observation.');
        const k = receipt(r.scopeKey, o.segmentId); if (keys.has(k)) throw Error('Duplicate audio observation.'); keys.add(k);
      }
      if (v.deleted.includes(receipt(r.scopeKey, r.id))) throw Error('Deleted audio record restored.');
    }
    for (const list of [v.deleted, v.deletedComments, v.responses]) if (new Set(list).size !== list.length || list.some(k => !/^[a-f0-9]{64}$/.test(k))) throw Error('Invalid audio receipts.');
    for (const c of v.comments) if (!c || !token(c.id) || c.id.length > 100 || !token(c.sessionId) || !text(c.text, 500) || !timestamp(c.createdAt)
      || !/^[a-f0-9]{64}$/.test(c.scopeKey) || c.source !== 'ambient-assistant-comment' || !Array.isArray(c.recordIds) || !c.recordIds.length
      || c.recordIds.length > 3 || !c.recordIds.every(token) || v.deletedComments.includes(receipt(c.scopeKey, c.id))) throw Error('Invalid audio comments.');
    for (const d of v.legacyDeletes) if (!d || !/^[a-f0-9]{64}$/.test(d.scopeKey) || !token(d.id) || typeof d.pending !== 'boolean') throw Error('Invalid legacy removal receipt.');
    return structuredClone(v);
  }
}
