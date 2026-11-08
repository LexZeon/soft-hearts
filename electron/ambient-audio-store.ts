import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';
import {
  AMBIENT_AUDIO_LIMITS as LIMITS, validateAmbientLanguage,
  type AmbientComment, type AmbientCommentInput, type AmbientContextItem, type AmbientContextQuery, type AmbientDeleteResult,
  type AmbientLongTermCandidate, type AmbientScope, type AmbientTranscript, type AmbientTranscriptInput,
  type AmbientTranscriptPage, type AmbientTranscriptQuery, type AmbientTranscriptSummary, type AmbientUserResponse,
} from '../shared/ambient-audio';

interface StoredTranscript extends AmbientTranscript { scopeKey: string; }
interface StoredComment extends AmbientComment { scopeKey: string; }
interface Archive {
  version: 1;
  records: StoredTranscript[];
  comments: StoredComment[];
  /** Hashes alone prevent deleted segments and accepted responses being replayed after restart. */
  deleted: string[];
  responses: string[];
  deletedComments: string[];
}
export interface AmbientAudioStoreOptions {
  now?: () => number;
  writeFile?: AtomicFileWriter;
}
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function identity(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) throw new Error(`系统音频${label}不正确。`);
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('系统音频时间不正确。');
  return value;
}
function scopeKey(scope: AmbientScope): string {
  return hash(JSON.stringify([identity(scope?.characterId, '角色'), identity(scope?.providerScope, '连接范围', 4096)]));
}
const recordKey = (scope: string, id: string): string => hash(JSON.stringify([scope, id]));
function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : fallback;
}
function boundedText(text: string, maximum: number): string {
  let result = '';
  for (const character of text) { if (result.length + character.length > maximum) break; result += character; }
  return result;
}
function metadata(value: AmbientTranscriptInput): { title: string; tags: string[] } {
  const compact = value.text.replace(/\s+/gu, ' ').trim();
  const defaultTitle = `${value.mode === 'music' ? '音乐文字' : '电影对白'} · ${Array.from(compact).slice(0, 24).join('')}`;
  const title = value.title === undefined ? defaultTitle : identity(value.title, '标题', LIMITS.titleCharacters);
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > LIMITS.tags)) throw new Error('系统音频标签过多。');
  const tags = [...new Set(['system-audio', value.mode, ...(value.tags ?? []).map(tag => identity(tag, '标签', LIMITS.tagCharacters))])];
  if (tags.length > LIMITS.tags) throw new Error('系统音频标签过多。');
  return { title, tags };
}
function validatedInput(value: AmbientTranscriptInput): AmbientTranscriptInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('系统音频文字片段不正确。');
  const allowed = ['id', 'sessionId', 'mode', 'startedAt', 'endedAt', 'text', 'language', 'title', 'tags'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('系统音频文字片段包含未知字段。');
  const id = identity(value.id, '片段编号'), sessionId = identity(value.sessionId, '会话编号');
  if (value.mode !== 'music' && value.mode !== 'movie') throw new Error('系统音频用途不正确。');
  const startedAt = timestamp(value.startedAt), endedAt = timestamp(value.endedAt);
  if (endedAt < startedAt) throw new Error('系统音频片段结束时间早于开始时间。');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > LIMITS.segmentCharacters || value.text.includes('\0')) {
    throw new Error('系统音频转写文字为空或超出单段上限。');
  }
  const language = validateAmbientLanguage(value.language);
  const next = { id, sessionId, mode: value.mode, startedAt, endedAt, text: value.text, language };
  return { ...next, ...metadata({ ...next, title: value.title, tags: value.tags }) };
}
function publicRecord(record: StoredTranscript): AmbientTranscript {
  const { scopeKey: _scope, ...value } = record;
  return clone(value);
}
function validatedComment(value: AmbientCommentInput): AmbientCommentInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['id', 'sessionId', 'recordIds', 'text', 'createdAt'].includes(key))) throw new Error('系统音频评论格式不正确。');
  const id = identity(value.id, '评论编号'), sessionId = identity(value.sessionId, '会话编号');
  if (!Array.isArray(value.recordIds) || !value.recordIds.length || value.recordIds.length > LIMITS.commentRecordReferences
    || new Set(value.recordIds).size !== value.recordIds.length) throw new Error('系统音频评论关联不正确。');
  const recordIds = value.recordIds.map(recordId => identity(recordId, '关联片段编号'));
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > LIMITS.commentCharacters || value.text.includes('\0')) throw new Error('系统音频评论文字为空或过长。');
  return { id, sessionId, recordIds, text: value.text, createdAt: timestamp(value.createdAt) };
}
function publicComment(comment: StoredComment): AmbientComment {
  const { scopeKey: _scope, ...value } = comment;
  return clone(value);
}
function summary(record: StoredTranscript): AmbientTranscriptSummary {
  const { text, ...value } = publicRecord(record);
  return { ...value, excerpt: Array.from(text).slice(0, 160).join(''), totalCharacters: text.length };
}
function canReviewResponse(text: string): boolean {
  const compact = text.trim();
  if (/^(?:嗯+|哦+|好+|是的|对的|是啊|哈哈+|ok(?:ay)?|yes|no|sure|thanks|thank you|そう|うん|はい)[\s.!?。！？,，]*$/iu.test(compact)) return false;
  if (/不是我(?:的|在)|角色(?:的)?台词|not my (?:view|opinion|preference)|ただの台詞|私の意見ではない/iu.test(compact)) return false;
  return /我(?:很|也|一直|特别|不|更)?(?:喜欢|讨厌|想|觉得|记得|偏好|害怕)|i (?:really |also |always |don't |do not )?(?:like|prefer|dislike|love|hate|remember)|私(?:は|も).{0,20}(?:好き|嫌い|思|覚)/iu.test(compact);
}

/** Host-private text archive. No microphone, renderer paths, audio bytes or automatic user facts. */
export class AmbientAudioStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly writeFile: AtomicFileWriter;
  private archive: Archive = { version: 1, records: [], comments: [], deleted: [], responses: [], deletedComments: [] };
  private recent = new Set<string>();
  private candidates = new Map<string, { scopeKey: string; value: AmbientLongTermCandidate }>();
  private transientGeneration = 0;
  private scopeGenerations = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(private readonly directory: string, options: AmbientAudioStoreOptions = {}) {
    if (!path.isAbsolute(directory)) throw new Error('系统音频档案目录必须由主进程提供。');
    this.file = path.join(directory, 'system-audio-transcripts.json');
    this.now = options.now ?? Date.now;
    this.writeFile = options.writeFile ?? atomicWriteFile;
  }
  async load(): Promise<void> {
    return this.mutate(async () => {
      if (this.loaded) return;
      await mkdir(this.directory, { recursive: true });
      let source: string;
      try {
        if ((await stat(this.file)).size > LIMITS.archiveBytes) throw new Error('Archive capacity exceeded');
        source = await readFile(this.file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('系统音频文字档案无法读取，原文件已保留。');
        await this.persist(this.archive); this.loaded = true; return;
      }
      try {
        const parsed: unknown = JSON.parse(source);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid archive');
        const archive = parsed as Archive;
        if (Object.keys(archive).some(key => !['version', 'records', 'comments', 'deleted', 'responses', 'deletedComments'].includes(key)) || archive.version !== 1
          || !Array.isArray(archive.records) || !Array.isArray(archive.deleted) || !Array.isArray(archive.responses)) throw new Error('Invalid archive');
        // Earlier v1 transcript-only archives remain valid and gain empty comments in memory.
        if (archive.comments !== undefined && !Array.isArray(archive.comments)
          || archive.deletedComments !== undefined && !Array.isArray(archive.deletedComments)) throw new Error('Invalid comments');
        const keys = new Set<string>();
        const records = archive.records.map(record => {
          if (!record || typeof record !== 'object' || record.source !== 'system-audio' || !/^[a-f0-9]{64}$/.test(record.scopeKey)) throw new Error('Invalid record');
          const { scopeKey: scope, source: _source, createdAt, ...input } = record;
          const validated = validatedInput(input);
          const key = recordKey(scope, validated.id);
          if (keys.has(key)) throw new Error('Duplicate record'); keys.add(key);
          return { ...validated, title: validated.title!, tags: validated.tags!, source: 'system-audio' as const, scopeKey: scope, createdAt: timestamp(createdAt) };
        });
        const receipts = (items: unknown[]) => {
          if (!items.every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)) || new Set(items).size !== items.length) throw new Error('Invalid receipts');
          return items as string[];
        };
        const deleted = receipts(archive.deleted), responses = receipts(archive.responses);
        if (deleted.some(key => keys.has(key))) throw new Error('Deleted record restored');
        const commentKeys = new Set<string>();
        const comments = (archive.comments ?? []).map(comment => {
          if (!comment || typeof comment !== 'object' || comment.source !== 'ambient-assistant-comment' || !/^[a-f0-9]{64}$/.test(comment.scopeKey)) throw new Error('Invalid comment');
          const { scopeKey: scope, source: _source, ...input } = comment;
          const validated = validatedComment(input), key = recordKey(scope, validated.id);
          if (commentKeys.has(key) || validated.recordIds.some(id => !records.some(record => record.scopeKey === scope && record.id === id && record.sessionId === validated.sessionId))) throw new Error('Invalid comment links');
          commentKeys.add(key);
          return { ...validated, scopeKey: scope, source: 'ambient-assistant-comment' as const };
        });
        const deletedComments = receipts(archive.deletedComments ?? []);
        if (deletedComments.some(key => commentKeys.has(key))) throw new Error('Deleted comment restored');
        this.archive = { version: 1, records, comments, deleted, responses, deletedComments };
      } catch {
        throw new Error('系统音频文字档案格式不正确，原文件已保留。');
      }
      // Persisted text remains searchable; it is never automatically replayed as new context.
      this.loaded = true;
    });
  }
  append(scope: AmbientScope, input: AmbientTranscriptInput): Promise<{ record: AmbientTranscript; inserted: boolean }> {
    const scopeIdentity = scopeKey(scope), next = validatedInput(input);
    const generation = this.generation(scopeIdentity);
    return this.mutate(async () => {
      this.ready();
      const key = recordKey(scopeIdentity, next.id);
      if (this.archive.deleted.includes(key)) throw new Error('该系统音频片段已删除，不能通过重试恢复。');
      const existing = this.archive.records.find(record => record.scopeKey === scopeIdentity && record.id === next.id);
      if (existing) return { record: publicRecord(existing), inserted: false };
      const record: StoredTranscript = { ...next, title: next.title!, tags: next.tags!, scopeKey: scopeIdentity, source: 'system-audio', createdAt: timestamp(this.now()) };
      const archive = { ...this.archive, records: [...this.archive.records, record] };
      await this.persist(archive);
      this.archive = archive;
      if (generation === this.generation(scopeIdentity)) this.recent.add(key);
      this.pruneRecent(timestamp(this.now()));
      return { record: publicRecord(record), inserted: true };
    });
  }
  list(scope: AmbientScope, query: AmbientTranscriptQuery = {}): AmbientTranscriptPage {
    this.ready(); const key = scopeKey(scope);
    if (query.query !== undefined && (typeof query.query !== 'string' || query.query.length > 200)) throw new Error('系统音频搜索文字过长。');
    if (query.tag !== undefined) identity(query.tag, '搜索标签', LIMITS.tagCharacters);
    const available = this.archive.records.filter(record => record.scopeKey === key);
    const needle = query.query?.trim().toLocaleLowerCase();
    const matches = available.filter(record => (!query.tag || record.tags.includes(query.tag))
      && (!needle || [record.text, record.title, ...record.tags].some(value => value.toLocaleLowerCase().includes(needle))))
      .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
    const offset = boundedInteger(query.offset, 0, Number.MAX_SAFE_INTEGER), limit = boundedInteger(query.limit, 30, LIMITS.pageRecords);
    return { records: matches.slice(offset, offset + limit).map(summary), total: matches.length, offset, limit,
      tags: [...new Set(available.flatMap(record => record.tags))].sort().slice(0, 200) };
  }
  read(scope: AmbientScope, id: string): AmbientTranscript | null {
    this.ready(); const key = scopeKey(scope); identity(id, '片段编号');
    const record = this.archive.records.find(record => record.scopeKey === key && record.id === id);
    return record ? publicRecord(record) : null;
  }
  /** Call only for the host-accepted acknowledgement that this complete comment was actually displayed. */
  appendComment(scope: AmbientScope, input: AmbientCommentInput): Promise<{ comment: AmbientComment; inserted: boolean }> {
    const key = scopeKey(scope), value = validatedComment(input);
    return this.mutate(async () => {
      this.ready();
      if (this.archive.deletedComments.includes(recordKey(key, value.id))) throw new Error('该系统音频评论已删除，不能通过重试恢复。');
      if (value.recordIds.some(id => !this.archive.records.some(record => record.scopeKey === key && record.id === id && record.sessionId === value.sessionId))) throw new Error('系统音频评论只能关联同一角色、连接与会话中仍存在的片段。');
      const existing = this.archive.comments.find(comment => comment.scopeKey === key && comment.id === value.id);
      if (existing) return { comment: publicComment(existing), inserted: false };
      const comment: StoredComment = { ...value, scopeKey: key, source: 'ambient-assistant-comment' };
      const archive = { ...this.archive, comments: [...this.archive.comments, comment] };
      await this.persist(archive); this.archive = archive;
      return { comment: publicComment(comment), inserted: true };
    });
  }
  /** Archive read only: persisted comments do not automatically re-enter listening context. */
  comments(scope: AmbientScope, recordId?: string): AmbientComment[] {
    this.ready(); const key = scopeKey(scope);
    if (recordId !== undefined) identity(recordId, '片段编号');
    return this.archive.comments.filter(comment => comment.scopeKey === key && (recordId === undefined || comment.recordIds.includes(recordId)))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(publicComment);
  }
  /** Remove only the acknowledged comment copy; absence is an idempotent success for callers deleting another archive copy. */
  deleteComment(scope: AmbientScope, id: string): Promise<boolean> {
    const key = scopeKey(scope); identity(id, '评论编号');
    return this.mutate(async () => {
      this.ready();
      if (!this.archive.comments.some(comment => comment.scopeKey === key && comment.id === id)) return false;
      const archive = { ...this.archive, comments: this.archive.comments.filter(comment => comment.scopeKey !== key || comment.id !== id),
        deletedComments: [...this.archive.deletedComments, recordKey(key, id)] };
      await this.persist(archive); this.archive = archive;
      this.clearTransient(scope);
      return true;
    });
  }
  delete(scope: AmbientScope, id: string): Promise<AmbientDeleteResult> {
    const key = scopeKey(scope); identity(id, '片段编号');
    return this.mutate(async () => {
      this.ready();
      if (!this.archive.records.some(record => record.scopeKey === key && record.id === id)) return { deleted: false, invalidatedCandidateIds: [] };
      const receipt = recordKey(key, id);
      const removedComments = this.archive.comments.filter(comment => comment.scopeKey === key && comment.recordIds.includes(id));
      const archive = { ...this.archive, records: this.archive.records.filter(record => record.scopeKey !== key || record.id !== id), deleted: [...this.archive.deleted, receipt],
        comments: this.archive.comments.filter(comment => !removedComments.includes(comment)),
        deletedComments: [...this.archive.deletedComments, ...removedComments.map(comment => recordKey(key, comment.id))] };
      await this.persist(archive); this.archive = archive; this.recent.delete(receipt);
      const invalidatedCandidateIds: string[] = [];
      for (const [candidateId, candidate] of this.candidates) {
        if (candidate.scopeKey === key && candidate.value.recordIds.includes(id)) { invalidatedCandidateIds.push(candidateId); this.candidates.delete(candidateId); }
      }
      return { deleted: true, invalidatedCandidateIds, ...(removedComments.length ? { deletedCommentIds: removedComments.map(comment => comment.id) } : {}) };
    });
  }
  context(scope: AmbientScope, query: AmbientContextQuery): AmbientContextItem[] {
    this.ready(); const key = scopeKey(scope), sessionId = identity(query?.sessionId, '会话编号');
    const now = timestamp(query.now ?? this.now());
    this.pruneRecent(now);
    const count = boundedInteger(query.maxRecords, LIMITS.recentRecords, LIMITS.recentRecords);
    let remaining = boundedInteger(query.maxCharacters, LIMITS.recentCharacters, LIMITS.recentCharacters);
    const records = this.archive.records.filter(record => record.scopeKey === key && record.sessionId === sessionId
      && this.recent.has(recordKey(key, record.id)) && record.endedAt <= now && now - record.endedAt <= LIMITS.recentMilliseconds)
      .sort((a, b) => b.endedAt - a.endedAt || a.id.localeCompare(b.id)).slice(0, count);
    const result: AmbientContextItem[] = [];
    for (const record of records) {
      if (remaining <= 0) break;
      const text = boundedText(record.text, remaining);
      if (!text) break;
      remaining -= text.length;
      result.push({ ...summary(record), text, truncated: text !== record.text });
    }
    return result.reverse();
  }
  /** Invalidate only work which has not yet joined the short context; accepted text/candidates stay available. */
  invalidatePendingTransient(scope: AmbientScope): void {
    const key = scopeKey(scope);
    this.scopeGenerations.set(key, (this.scopeGenerations.get(key) ?? 0) + 1);
  }
  clearTransient(scope?: AmbientScope): void {
    if (!scope) { this.transientGeneration++; this.recent.clear(); this.candidates.clear(); return; }
    const key = scopeKey(scope);
    this.invalidatePendingTransient(scope);
    for (const record of this.archive.records) if (record.scopeKey === key) this.recent.delete(recordKey(key, record.id));
    for (const [id, candidate] of this.candidates) if (candidate.scopeKey === key) this.candidates.delete(id);
  }
  /** Only call after the host accepts an actual user message responding to these linked observations. */
  recordUserResponse(scope: AmbientScope, input: AmbientUserResponse): Promise<AmbientLongTermCandidate | null> {
    const key = scopeKey(scope), eventId = identity(input?.eventId, '用户回应编号'), at = timestamp(input?.at);
    const generation = this.generation(key);
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > LIMITS.userResponseCharacters || input.text.includes('\0')) throw new Error('系统音频用户回应文字不正确。');
    const text = input.text;
    if (!Array.isArray(input.recordIds) || input.recordIds.length === 0 || input.recordIds.length > 3 || new Set(input.recordIds).size !== input.recordIds.length) throw new Error('系统音频回应关联不正确。');
    const recordIds = input.recordIds.map(id => identity(id, '关联片段编号'));
    return this.mutate(async () => {
      this.ready(); const receipt = recordKey(key, `user-response:${eventId}`);
      this.pruneRecent(at);
      if (generation !== this.generation(key)) return null;
      if (this.archive.responses.includes(receipt)) return null;
      const linked = recordIds.map(id => this.archive.records.find(record => record.scopeKey === key && record.id === id));
      if (linked.some(record => !record || !this.recent.has(recordKey(key, record.id)) || record.endedAt > at || at - record.endedAt > LIMITS.recentMilliseconds)) return null;
      const archive = { ...this.archive, responses: [...this.archive.responses, receipt] };
      await this.persist(archive); this.archive = archive;
      if (generation !== this.generation(key)) return null;
      if (!canReviewResponse(text)) return null;
      const candidate: AmbientLongTermCandidate = { id: receipt, eventId, recordIds, userText: text, at,
        source: 'user-response-to-system-audio', requiresReview: true };
      this.candidates.set(receipt, { scopeKey: key, value: candidate });
      while (this.candidates.size > LIMITS.recentRecords) this.candidates.delete(this.candidates.keys().next().value!);
      return clone(candidate);
    });
  }
  candidate(scope: AmbientScope, id: string): AmbientLongTermCandidate | null {
    this.ready(); this.pruneRecent(timestamp(this.now()));
    const candidate = this.candidates.get(identity(id, '候选编号'));
    return candidate?.scopeKey === scopeKey(scope) ? clone(candidate.value) : null;
  }
  async flush(): Promise<void> { await this.queue; }
  private generation(scope: string): string { return `${this.transientGeneration}:${this.scopeGenerations.get(scope) ?? 0}`; }
  private pruneRecent(now: number): void {
    const counts = new Map<string, number>();
    for (const record of [...this.archive.records].sort((a, b) => b.endedAt - a.endedAt)) {
      const key = recordKey(record.scopeKey, record.id);
      if (!this.recent.has(key)) continue;
      const session = JSON.stringify([record.scopeKey, record.sessionId]);
      const count = counts.get(session) ?? 0;
      if (record.endedAt > now || now - record.endedAt > LIMITS.recentMilliseconds || count >= LIMITS.recentRecords) this.recent.delete(key);
      else counts.set(session, count + 1);
    }
    for (const [id, candidate] of this.candidates) {
      if (candidate.value.recordIds.some(recordId => !this.recent.has(recordKey(candidate.scopeKey, recordId)))) this.candidates.delete(id);
    }
  }
  private ready(): void { if (!this.loaded) throw new Error('系统音频文字档案尚未载入。'); }
  private async persist(archive: Archive): Promise<void> {
    const source = JSON.stringify(archive) + '\n';
    if (Buffer.byteLength(source, 'utf8') > LIMITS.archiveBytes) throw new Error('系统音频文字档案已达上限，请先删除不需要的记录；既有原文仍保留。');
    await this.writeFile(this.file, source);
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
