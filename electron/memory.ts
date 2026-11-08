import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, type AtomicFileWriter } from "./atomic-file";
import {
  DEFAULT_MEMORY_CONFIG, MEMORY_CATEGORIES, deriveMemoryMetadata, isMemoryTopicChange, isSpecificMemoryTag,
  memoryRecallMatch, memoryWeightAt, validateMemoryConfig,
  type MemoryConfig, type MemoryEdit, type MemoryInitiative, type MemoryListQuery, type MemoryMention,
  type MemoryMessage, type MemoryMessageStatus, type MemoryPage, type MemoryReadQuery,
  type MemoryRecall, type MemoryRecallNote, type MemoryRecallOptions, type MemoryRecordPage, type MemoryScope,
  type MemorySummary, type MemoryTurnHandle, type MemoryTurnStart, type RecentChatMessage,
} from "../shared/memory";
import type { ProactiveOrigin, ProactiveContentSource } from '../shared/proactive-speech';
import type { MemoryNoteHint, MemoryRecallHints, NoteSegmentInfo, NoteSegmentText, RecordsRemoval } from '../shared/memory-notes/interface';

/**
 * I-021 删除一致性 (docs/claude/2026-11-04-memory-notes-delete.md): beside `memories.jsonl`, which character and connection each
 * scope of the journal belongs to. The journal keys records by an opaque hash of the two, and the connection includes the
 * chat model the user typed, so "all of her chat memory" (the recycle bin, deleting a character) cannot otherwise find what
 * she was told under a model that is not the current one. Ids and connection hashes only, never a word of a conversation or
 * a model name; the journal's own format and writes are unchanged.
 */
export const MEMORY_SCOPES_FILE = 'memory-scopes.json';
interface ScopeOwner { characterId: string; providerScope: string }

interface StoredRecord {
  id: string;
  scopeKey: string;
  conversationId: string;
  title: string;
  tags: string[];
  category: MemorySummary["category"];
  manual: { title: boolean; tags: boolean; category: boolean };
  createdAt: number;
  updatedAt: number;
  lastFinishedAt: number;
  weight: number;
  weightAt: number;
  mentions: MemoryMention[];
  messages: MemoryMessage[];
  sealed: boolean;
  continuationOf?: string;
  origin?: ProactiveOrigin;
}
interface RecallEpisode {
  id: string;
  targets: string[];
  topicTags: string[];
  lastAt: number;
}
type JournalEvent =
  | { type: "header"; version: 1; config: MemoryConfig; tombstones: string[]; recalls?: [string, RecallEpisode][]; noteIds?: [string, string[]][] }
  | { type: "record"; record: StoredRecord }
  | { type: "begin"; recordId: string; record?: StoredRecord; previousId?: string; user: MemoryMessage; assistant: MemoryMessage; metadata: Required<MemoryEdit> }
  | { type: "delta"; scopeKey: string; turnId: string; delta: string; at: number }
  | { type: "finish"; scopeKey: string; turnId: string; status: MemoryMessageStatus; at: number }
  | { type: "seal"; scopeKey: string }
  | { type: "edit"; scopeKey: string; recordId: string; edit: MemoryEdit }
  | { type: "mention"; scopeKey: string; recordId: string; mention: MemoryMention; weight: number }
  | { type: "recall"; scopeKey: string; eventId: string; episode: RecallEpisode; mentions: { recordId: string; mention: MemoryMention; weight: number }[] }
  | { type: "configure"; config: MemoryConfig };

function identity(value: unknown, name: string, limit = 256): string {
  if (typeof value !== "string" || !value || value.length > limit || value.includes("\0")) throw new Error(`记忆${name}不正确。`);
  return value;
}
function time(value: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) throw new Error("记忆时间必须为有效的毫秒时间。");
  return value;
}
function scopeKey(scope: MemoryScope): string {
  const character = identity(scope?.characterId, "角色编号");
  const provider = identity(scope?.providerScope, "连接范围", 4096);
  return createHash("sha256").update(JSON.stringify([character, provider])).digest("hex");
}
const turnKey = (scope: string, id: string) => `${scope}:${id}`;
const copy = <T>(value: T): T => structuredClone(value);
/** Opaque manual-management selector only; stored record/scope identities are unchanged. */
export const TEXT_INVITATION_ID_PREFIX = 'text-invitation:';
const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;

/**
 * A host-only, append-only private journal. Streaming writes add only the new text.
 * Deleting a record atomically compacts the journal so deleted originals are removed,
 * rather than surviving behind a tombstone. No renderer-supplied path is accepted.
 */
export class MemoryStore {
  private readonly file: string;
  private records = new Map<string, StoredRecord>();
  private turns = new Map<string, string>();
  private active = new Map<string, string>();
  private tombstones = new Set<string>();
  private recalls = new Map<string, RecallEpisode>();
  private noteIds = new Map<string, Set<string>>();
  private config: MemoryConfig = validateMemoryConfig(DEFAULT_MEMORY_CONFIG);
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private recoveryNotice?: string;
  /** I-021: her notebook (electron/memory-notes/). Only asked during retrieve and told after a removal; it never writes this journal. */
  private recallHints: MemoryRecallHints | null = null;
  private removalListener: ((recordIds: readonly string[], how: RecordsRemoval) => void) | null = null;
  /** Bumped when records leave or the notebook is swapped: a recall made before is stale (recallRevision). */
  private recallEpoch = 0;
  /** I-021 删除一致性: scope hash → its character and connection (MEMORY_SCOPES_FILE); `ownersDirty` until saved. */
  private owners = new Map<string, ScopeOwner>();
  private ownersDirty = false;
  private ownersReadOnly = false;

  constructor(private readonly directory: string, private readonly journal: 'conversation' | 'text-invitations' = 'conversation',
    // Compaction replaces the whole journal; on Windows a short sharing lock (OneDrive, antivirus,
    // indexer) can fail that rename for a moment, which the shared atomic writer waits out.
    private readonly writeAtomic: AtomicFileWriter = atomicWriteFile) {
    if (journal !== 'conversation' && journal !== 'text-invitations') throw new Error('未知的主机文字归档。');
    this.file = path.join(directory, journal === 'text-invitations' ? 'text-invitations.jsonl' : 'memories.jsonl');
  }

  async load(): Promise<void> {
    return this.mutate(async () => {
      if (this.loaded) return;
      await mkdir(this.directory, { recursive: true });
      await this.loadOwners();
      let source: string;
      try { source = await readFile(this.file, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("聊天记忆无法读取，原文件已保留。");
        await writeFile(this.file, this.line({ type: "header", version: 1, config: this.config, tombstones: [] }), { encoding: "utf8", flag: "wx", mode: 0o600 });
        this.loaded = true;
        return;
      }
      const rows = source.split("\n");
      let incompleteTail = false;
      try {
        for (let index = 0; index < rows.length; index++) {
          const line = rows[index];
          if (!line.trim()) continue;
          let event: JournalEvent;
          try { event = JSON.parse(line); }
          catch (error) {
            // A process/power loss can leave only the last append incomplete. Never
            // skip corruption inside the archive or overwrite the source silently.
            if (this.journal === 'conversation' && index === rows.length - 1 && !source.endsWith("\n")) { incompleteTail = true; break; }
            throw error;
          }
          if (index === 0 && (event.type !== "header" || event.version !== 1)) throw new Error("Missing memory header");
          this.apply(event);
        }
        if (!rows[0]?.trim()) throw new Error("Empty memory archive");
      } catch {
        this.records.clear(); this.turns.clear(); this.active.clear(); this.tombstones.clear(); this.recalls.clear(); this.noteIds.clear();
        throw new Error("聊天记忆格式不正确，原文件已保留，请检查 memories.jsonl。");
      }
      this.loaded = true;
      const interrupted: JournalEvent[] = [];
      for (const record of this.records.values()) {
        for (const message of record.messages) {
          if (message.role === "assistant" && message.status === "streaming") {
            interrupted.push({ type: "finish", scopeKey: record.scopeKey, turnId: message.turnId, status: "interrupted", at: message.updatedAt });
          }
        }
      }
      if (incompleteTail) {
        // Only complete journal operations were acknowledged. An incomplete last
        // operation cannot be replayed; retain all preceding originals without a
        // second hidden archive which could undermine individual deletion.
        this.recoveryNotice = "检测到异常退出留下的未完成写入，已恢复此前完整写入的聊天文字；最后未完成的片段可能缺失。";
        await this.compact();
      }
      for (const event of interrupted) await this.commit(event);
    });
  }

  getConfig(): MemoryConfig { this.ready(); return copy(this.config); }
  getNotice(): string | undefined { return this.recoveryNotice; }
  configure(value: Partial<MemoryConfig>): Promise<MemoryConfig> {
    return this.mutate(async () => {
      this.ready();
      const next = validateMemoryConfig({ ...this.config, ...value });
      await this.commit({ type: "configure", config: next });
      return copy(this.config);
    });
  }

  beginTurn(scope: MemoryScope, input: MemoryTurnStart): Promise<MemoryTurnHandle> {
    if (this.journal === 'text-invitations') throw new Error('主动邀请归档不接受普通对话轮次。');
    const key = scopeKey(scope);
    const id = identity(input.id, "轮次编号");
    time(input.at);
    if (typeof input.userText !== "string") throw new Error("聊天记忆只保存文字。");
    const conversation = input.conversationId === undefined ? "default" : identity(input.conversationId, "会话编号");
    return this.mutate(async () => {
      this.ready();
      const composite = turnKey(key, id);
      if (this.tombstones.has(composite)) throw new Error("该轮聊天已删除，不能通过重试恢复。");
      const existing = this.turns.get(composite);
      if (existing) return { recordId: existing, turnId: id };
      let record = this.records.get(this.active.get(key) ?? "");
      if (record?.messages.some(message => message.role === "assistant" && message.status === "streaming")) throw new Error("上一轮聊天记忆尚未结束。");
      const previous = record;
      const turns = record?.messages.filter(message => message.role === "assistant" && message.status === "complete").length ?? 0;
      const gap = record ? input.at - record.lastFinishedAt : 0;
      const continuation = record && !input.newTopic && !isMemoryTopicChange(input.userText) && record.conversationId === conversation &&
        (gap >= this.config.segmentGapMinutes * 60_000 || turns >= this.config.segmentTurns);
      const newRecord = !record || record.sealed || record.conversationId !== conversation || input.newTopic || isMemoryTopicChange(input.userText) ||
        gap >= this.config.segmentGapMinutes * 60_000 || turns >= this.config.segmentTurns;
      const metadata = deriveMemoryMetadata(input.userText, this.knownTags(key));
      if (newRecord) {
        record = {
          id: randomUUID(), scopeKey: key, conversationId: conversation,
          ...metadata, manual: { title: false, tags: false, category: false },
          createdAt: input.at, updatedAt: input.at, lastFinishedAt: input.at,
          weight: this.config.baseWeight, weightAt: input.at, mentions: [], messages: [], sealed: false,
          ...(continuation && previous ? { continuationOf: previous.id } : {}),
        };
        if (continuation && previous) record.tags = [...previous.tags];
      }
      const user: MemoryMessage = { id: randomUUID(), turnId: id, role: "user", content: input.userText, createdAt: input.at, updatedAt: input.at, status: "complete" };
      const assistant: MemoryMessage = { id: randomUUID(), turnId: id, role: "assistant", content: "", createdAt: input.at, updatedAt: input.at, status: "streaming" };
      await this.own(scope, key, true);
      await this.commit({ type: "begin", recordId: record!.id, ...(newRecord ? { record: record! } : {}), ...(newRecord && previous ? { previousId: previous.id } : {}), user, assistant, metadata });
      return { recordId: record!.id, turnId: id };
    });
  }

  /**
   * Archive a completed host initiative as one assistant original. It never
   * invents a user turn, changes an ordinary conversation, rewards mood or notes
   * a user recollection. Image/audio bytes and capture locations are not stored.
   */
  appendInitiative(scope: MemoryScope, input: MemoryInitiative, current?: () => boolean): Promise<MemoryTurnHandle> {
    const key = scopeKey(scope);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(field => !['id', 'text', 'at', 'origin'].includes(field))) throw new Error('主动记录格式不正确。');
    const id = identity(input.id, '轮次编号', 100), at = time(input.at);
    const text = input.text;
    if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 2000 || text.includes('\0')) throw new Error('主动记录需要 1～2000 字符的完成文字。');
    const origin = this.validateOrigin(input.origin);
    if (origin.id !== id || origin.at !== at) throw new Error('主动记录来源与本次身份不一致。');
    return this.mutate(async () => {
      this.ready();
      if (current && !current()) throw new Error('主动记录的显示身份已失效。');
      const composite = turnKey(key, id);
      if (this.tombstones.has(composite)) throw new Error('该主动记录已删除，不能通过重试恢复。');
      const existingId = this.turns.get(composite);
      if (existingId) {
        const existing = this.records.get(existingId);
        if (!existing?.origin || existing.messages.length !== 1 || existing.messages[0].content !== text
          || JSON.stringify(existing.origin) !== JSON.stringify(origin)) throw new Error('主动记录编号已用于不同内容。');
        return { recordId: existingId, turnId: id };
      }
      const metadata = deriveMemoryMetadata(text, this.knownTags(key));
      const record: StoredRecord = {
        id: randomUUID(), scopeKey: key, conversationId: 'initiative',
        ...metadata, title: `主动 · ${metadata.title}`, tags: [...new Set(['角色主动', ...metadata.tags])].slice(0, 5),
        manual: { title: false, tags: false, category: false },
        createdAt: at, updatedAt: at, lastFinishedAt: at,
        weight: 0, weightAt: at, mentions: [], sealed: true, origin,
        messages: [{ id: randomUUID(), turnId: id, role: 'assistant', content: text,
          createdAt: at, updatedAt: at, status: 'complete' }],
      };
      await this.own(scope, key, true);
      await this.commit({ type: 'record', record });
      return { recordId: record.id, turnId: id };
    });
  }

  /** Host-only lookup for a linked observation/comment lifecycle; scope remains mandatory. */
  findInitiative(scope: MemoryScope, id: string): MemoryTurnHandle | null {
    this.ready();
    const key = scopeKey(scope), turnId = identity(id, '轮次编号', 100);
    const recordId = this.turns.get(turnKey(key, turnId));
    const record = recordId ? this.find(key, recordId) : undefined;
    return record?.origin?.id === turnId ? { recordId: record.id, turnId } : null;
  }

  /** Host archive reconciliation only; the existing v1 tombstone stays authoritative. */
  hasDeletedTurn(scope: MemoryScope, id: string): boolean {
    this.ready();
    return this.tombstones.has(turnKey(scopeKey(scope), identity(id, '轮次编号', 100)));
  }

  /** Host voice continuation updates one open user original, never adds a turn.
   * Existing record events keep the shared profile readable by the fixed build. */
  extendOpenUser(scope: MemoryScope, turnId: string, canonicalText: string, at: number): Promise<boolean> {
    const key = scopeKey(scope); identity(turnId, "轮次编号"); time(at);
    if (typeof canonicalText !== 'string' || !canonicalText.trim() || canonicalText.length > 16000 || canonicalText.includes('\0'))
      throw new Error('连续语音原文超出范围。');
    return this.mutate(async () => {
      this.ready();
      if (this.assistant(key, turnId)?.status !== 'streaming') return false;
      const record = this.records.get(this.turns.get(turnKey(key, turnId)) ?? '');
      const original = record?.messages.find(message => message.turnId === turnId && message.role === 'user');
      if (!record || record.scopeKey !== key || !original) return false;
      if (canonicalText === original.content) return true;
      if (!canonicalText.startsWith(original.content + '\n')) throw new Error('连续语音不能改写已接受的原文。');
      const updated = copy(record);
      const message = updated.messages.find(value => value.id === original.id)!;
      message.content = canonicalText; message.updatedAt = Math.max(message.updatedAt, at);
      updated.updatedAt = Math.max(updated.updatedAt, at);
      await this.commit({ type: 'record', record: updated });
      return true;
    });
  }

  appendAssistant(scope: MemoryScope, turnId: string, delta: string, at: number): Promise<boolean> {
    const key = scopeKey(scope); identity(turnId, "轮次编号"); time(at);
    if (typeof delta !== "string") throw new Error("聊天片段必须为文字。");
    return this.mutate(async () => {
      this.ready();
      const message = this.assistant(key, turnId);
      if (!message || message.status !== "streaming" || !delta) return false;
      await this.commit({ type: "delta", scopeKey: key, turnId, delta, at });
      return true;
    });
  }

  finishTurn(scope: MemoryScope, turnId: string, status: "complete" | "stopped" | "error", at: number): Promise<boolean> {
    const key = scopeKey(scope); identity(turnId, "轮次编号"); time(at);
    if (!["complete", "stopped", "error"].includes(status)) throw new Error("聊天完成状态不正确。");
    return this.mutate(async () => {
      this.ready();
      if (this.assistant(key, turnId)?.status !== "streaming") return false;
      await this.commit({ type: "finish", scopeKey: key, turnId, status, at });
      return true;
    });
  }

  seal(scope: MemoryScope): Promise<void> {
    const key = scopeKey(scope);
    return this.mutate(async () => { this.ready(); await this.commit({ type: "seal", scopeKey: key }); });
  }

  list(scope: MemoryScope, query: MemoryListQuery = {}, now = Date.now(), invitations?: MemoryStore): MemoryPage {
    this.ready(); const key = scopeKey(scope); time(now);
    if (invitations) { invitations.ready(); if (invitations.journal !== 'text-invitations' || invitations === this) throw new Error('主动邀请归档不正确。'); }
    const offset = boundedInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(query.limit, 20, 1, 50);
    const tag = this.queryText(query.tag, 80);
    const search = this.queryText(query.query, 500).toLocaleLowerCase();
    const records = [...this.records.values(), ...(invitations ? [...invitations.records.values()].map(record => ({ ...record, id: TEXT_INVITATION_ID_PREFIX + record.id })) : [])].filter(record => record.scopeKey === key && (!tag || record.tags.includes(tag)) &&
      (!search || [record.title, ...record.tags, ...record.messages.map(message => message.content)].some(value => value.toLocaleLowerCase().includes(search))))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
    const notice = [this.recoveryNotice, invitations?.recoveryNotice].filter(Boolean).join(' ');
    return { records: records.slice(offset, offset + limit).map(record => this.summary(record, now)), total: records.length, offset, limit, tags: [...new Set([...this.knownTags(key), ...(invitations?.knownTags(key) ?? [])])].sort().slice(0, 200), ...(notice ? { notice } : {}) };
  }

  read(scope: MemoryScope, id: string, query: MemoryReadQuery = {}, now = Date.now()): MemoryRecordPage | undefined {
    this.ready(); time(now);
    const record = this.find(scopeKey(scope), identity(id, "记录编号"));
    if (!record) return undefined;
    const offset = boundedInteger(query.messageOffset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(query.messageLimit, 4, 1, 10);
    const textOffset = boundedInteger(query.textOffset, 0, 0, Number.MAX_SAFE_INTEGER);
    const textLimit = boundedInteger(query.textLimit, 4000, 1, 4000);
    const messages = record.messages.slice(offset, offset + limit).map(message => ({
      ...message, content: Array.from(message.content).slice(textOffset, textOffset + textLimit).join(""),
      contentOffset: textOffset, totalCharacters: Array.from(message.content).length,
      ...(Array.from(message.content).length > textOffset + textLimit ? { nextTextOffset: textOffset + textLimit } : {}),
    }));
    return { ...this.summary(record, now), messages, messageOffset: offset,
      ...(offset + messages.length < record.messages.length ? { nextMessageOffset: offset + messages.length } : {}) };
  }

  edit(scope: MemoryScope, id: string, edit: MemoryEdit, current?: () => boolean): Promise<MemorySummary> {
    const key = scopeKey(scope); identity(id, "记录编号");
    const validated = this.validateEdit(edit);
    return this.mutate(async () => {
      this.ready(); const record = this.find(key, id);
      if (current && !current()) throw new Error('记录管理的角色和连接已改变。');
      if (!record) throw new Error("聊天记录不存在。");
      await this.commit({ type: "edit", scopeKey: key, recordId: id, edit: validated });
      return this.summary(record, Date.now());
    });
  }

  delete(scope: MemoryScope, id: string, current?: () => boolean): Promise<boolean> {
    const key = scopeKey(scope); identity(id, "记录编号");
    return this.mutate(async () => {
      this.ready(); const record = this.find(key, id);
      if (current && !current()) throw new Error('记录管理的角色和连接已改变。');
      if (!record) return false;
      // Build the replacement first: on write failure the in-memory archive remains intact.
      const remaining = [...this.records.values()].filter(item => item.id !== id);
      const released = this.releasedContinuations(record, remaining);
      const nextRecords = remaining.map(item => released.get(item.id) ?? item);
      const nextTombstones = new Set(this.tombstones);
      for (const message of record.messages) nextTombstones.add(turnKey(key, message.turnId));
      const nextRecalls = new Map([...this.recalls].map(([episodeKey, episode]) => {
        const next = copy(episode);
        if (next.targets.includes(id)) {
          next.targets = next.targets.filter(target => target !== id);
          next.topicTags = [...new Set(next.targets.flatMap(target => (released.get(target) ?? this.records.get(target))?.tags ?? []))];
        }
        return [episodeKey, next] as const;
      }));
      await this.compact(nextRecords, nextTombstones, nextRecalls);
      this.records.delete(id);
      for (const updated of released.values()) this.records.set(updated.id, updated);
      for (const message of record.messages) this.turns.delete(turnKey(key, message.turnId));
      if (this.active.get(key) === id) this.active.delete(key);
      this.tombstones = nextTombstones;
      this.recalls = nextRecalls;
      this.notifyRemoved([id], { recoverable: false });
      return true;
    });
  }

  /** C2 角色页, host only: when this scope last chatted (the newest message time), or null. */
  lastActivity(scope: MemoryScope): number | null {
    this.ready(); const key = scopeKey(scope);
    let last: number | null = null;
    if (this.journal !== 'conversation') return null;
    for (const record of this.records.values()) {
      if (record.scopeKey !== key || record.origin) continue;
      for (const message of record.messages) if (message.content?.trim() && (last === null || message.createdAt > last)) last = message.createdAt;
    }
    return last;
  }

  /**
   * C2 删除角色时"同时删除她的记忆", host only: every record of this scope goes, compacted out of the journal like
   * a single delete (no original survives behind a tombstone). Resolves to how many records went.
   */
  forgetScope(scope: MemoryScope, keep?: (records: unknown[]) => Promise<void>): Promise<number> {
    const key = scopeKey(scope);
    return this.mutate(async () => {
      this.ready();
      const doomed = [...this.records.values()].filter(record => record.scopeKey === key);
      if (!doomed.length) return 0;
      // I-014 回收站: the records are handed over (copies) before anything is removed; if keeping them fails, nothing goes.
      if (keep) await keep(doomed.map(record => copy(record)));
      const ids = new Set(doomed.map(record => record.id));
      const nextRecords = [...this.records.values()].filter(record => !ids.has(record.id));
      const nextTombstones = new Set(this.tombstones);
      for (const record of doomed) for (const message of record.messages) nextTombstones.add(turnKey(key, message.turnId));
      const nextRecalls = new Map([...this.recalls].map(([episodeKey, episode]) => {
        const next = copy(episode);
        if (next.targets.some(target => ids.has(target))) {
          next.targets = next.targets.filter(target => !ids.has(target));
          next.topicTags = [...new Set(next.targets.flatMap(target => this.records.get(target)?.tags ?? []))];
        }
        return [episodeKey, next] as const;
      }));
      await this.compact(nextRecords, nextTombstones, nextRecalls);
      for (const record of doomed) {
        this.records.delete(record.id);
        for (const message of record.messages) this.turns.delete(turnKey(key, message.turnId));
      }
      if (this.active.has(key)) this.active.delete(key);
      this.tombstones = nextTombstones;
      this.recalls = nextRecalls;
      // Handed to `keep` (the recycle bin): they may come back, so the notebook keeps what the user decided about their notes.
      this.notifyRemoved([...ids], { recoverable: !!keep });
      return doomed.length;
    });
  }

  /**
   * I-014 回收站, host only: puts records that `forgetScope(scope, keep)` handed over back into the archive. Each one comes
   * back sealed (a conversation that already ended), so the conversation the user is in now carries on untouched; a
   * record whose id is already present is skipped. Their turns stop being tombstoned. Resolves to how many came back.
   * `owner`: the character and connection they were forgotten from (the bin knows it), so they can be found by character again.
   */
  restoreRecords(records: readonly unknown[], owner?: MemoryScope): Promise<number> {
    const ownerKey = owner ? scopeKey(owner) : null;
    return this.mutate(async () => {
      this.ready();
      if (this.journal !== 'conversation') throw new Error('只有聊天记忆可以从回收站放回。');
      if (!Array.isArray(records) || records.length > 100_000) throw new Error('回收站里的聊天记忆格式不正确。');
      const incoming: StoredRecord[] = [];
      for (const raw of records) {
        const record = copy(raw) as StoredRecord;
        if (!record || typeof record !== 'object' || typeof record.scopeKey !== 'string' || !/^[a-f0-9]{64}$/.test(record.scopeKey))
          throw new Error('回收站里的聊天记忆格式不正确。');
        this.assertRecord(record);
        if (this.records.has(record.id) || incoming.some(item => item.id === record.id)) continue;
        record.sealed = true;
        for (const message of record.messages) if (message.role === 'assistant' && message.status === 'streaming') message.status = 'interrupted';
        incoming.push(record);
      }
      if (!incoming.length) return 0;
      const nextTombstones = new Set(this.tombstones);
      for (const record of incoming) for (const message of record.messages) nextTombstones.delete(turnKey(record.scopeKey, message.turnId));
      if (owner && ownerKey && incoming.some(record => record.scopeKey === ownerKey)) await this.own(owner, ownerKey, true);
      await this.compact([...this.records.values(), ...incoming], nextTombstones, this.recalls);
      this.tombstones = nextTombstones;
      for (const record of incoming) this.apply({ type: 'record', record });
      return incoming.length;
    });
  }

  /**
   * C2 continuity (pretrial fixes 2026-11-03), host only: the conversation this scope talked in last (the newest ordinary
   * record's conversation id) and when, or null. Host initiatives are observations, never a conversation of their own.
   */
  latestConversation(scope: MemoryScope): { id: string; at: number } | null {
    this.ready(); const key = scopeKey(scope);
    if (this.journal !== 'conversation') return null;
    let newest: StoredRecord | null = null;
    for (const record of this.records.values()) {
      if (record.scopeKey !== key || record.origin || !record.messages.length) continue;
      if (!newest || record.updatedAt > newest.updatedAt || (record.updatedAt === newest.updatedAt && record.createdAt > newest.createdAt)) newest = record;
    }
    return newest ? { id: newest.conversationId, at: newest.updatedAt } : null;
  }

  /**
   * C2/C3 continuity (pretrial fixes 2026-11-03), host only: one conversation of this scope (every ordinary record with
   * that conversation id) as finished turns, oldest first, the last `limit` messages (the chat window's own bound). A turn
   * counts when her reply has text and finished or was stopped (what the window keeps); a failed or still streaming reply
   * leaves its turn out. Host initiatives (screen, camera, ambient) are observations, never part of it. No new storage:
   * the records are the chat memory the user already has.
   */
  recentConversation(scope: MemoryScope, conversationId: string, limit = 24): RecentChatMessage[] {
    this.ready(); const key = scopeKey(scope);
    const bound = boundedInteger(limit, 24, 1, 200);
    if (this.journal !== 'conversation' || typeof conversationId !== 'string' || !conversationId) return [];
    const records = [...this.records.values()].filter(record => record.scopeKey === key && !record.origin && record.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const messages: RecentChatMessage[] = [];
    for (const record of records) {
      for (const user of record.messages) {
        if (user.role !== 'user' || !user.content.trim()) continue;
        const reply = record.messages.find(message => message.role === 'assistant' && message.turnId === user.turnId);
        if (!reply || !reply.content.trim() || (reply.status !== 'complete' && reply.status !== 'stopped')) continue;
        messages.push({ role: 'user', content: user.content }, { role: 'assistant', content: reply.content });
      }
    }
    return messages.slice(-bound);
  }

  /**
   * L3 diary source, host only: this scope's ordinary chat originals whose own time falls in
   * [start, end), oldest first. Host initiatives (screen, camera, ambient audio and any other
   * `origin` record) are observations rather than chat between the two, so they never appear.
   */
  conversationMessages(scope: MemoryScope, start: number, end: number): Pick<MemoryMessage, "role" | "content" | "createdAt">[] {
    this.ready(); const key = scopeKey(scope); time(start); time(end);
    if (this.journal !== 'conversation' || end <= start) return [];
    return [...this.records.values()].filter(record => record.scopeKey === key && !record.origin)
      .flatMap(record => record.messages)
      .filter(message => message.createdAt >= start && message.createdAt < end && typeof message.content === "string" && message.content.trim())
      .sort((a, b) => a.createdAt - b.createdAt || (a.role === b.role ? 0 : a.role === "user" ? -1 : 1))
      .map(message => ({ role: message.role, content: message.content, createdAt: message.createdAt }));
  }

  /**
   * Relationship backfill (electron/relationship/), host only: when this scope's ordinary chat began, and per local day
   * (named by `dayOf`) how many of the user's messages got a finished reply. Host initiatives never count.
   */
  chatActivity(scope: MemoryScope, dayOf: (ms: number) => string): { first: number | null; rounds: Map<string, number> } {
    this.ready(); const key = scopeKey(scope);
    const rounds = new Map<string, number>();
    let first: number | null = null;
    if (this.journal !== 'conversation') return { first, rounds };
    for (const record of this.records.values()) {
      if (record.scopeKey !== key || record.origin) continue;
      for (const message of record.messages) {
        if (message.role !== 'user' || !message.content?.trim()) continue;
        if (first === null || message.createdAt < first) first = message.createdAt;
        const answered = record.messages.some(other => other.role === 'assistant' && other.turnId === message.turnId && other.status === 'complete' && !!other.content?.trim());
        if (answered) { const day = dayOf(message.createdAt); rounds.set(day, (rounds.get(day) ?? 0) + 1); }
      }
    }
    return { first, rounds };
  }

  retrieve(scope: MemoryScope, text: string, options: MemoryRecallOptions = {}, now = Date.now()): MemoryRecall[] {
    this.ready(); const key = scopeKey(scope); time(now);
    if (typeof text !== "string") return [];
    const maxRecords = boundedInteger(options.maxRecords, this.config.recallRecords, 0, Math.min(3, this.config.recallRecords));
    let budget = boundedInteger(options.maxChars, this.config.recallCharacters, 0, Math.min(3000, this.config.recallCharacters));
    if (!maxRecords || !budget || !text.trim()) return [];
    // An autonomous observation is browseable history, not a user preference or
    // established shared experience. Promotion requires a separate explicit,
    // host-verified user follow-up protocol; none is implemented implicitly here.
    // I-021: her notes add to the literal score (names, places, events, near words, "那家店去了吗") and point at the words to
    // excerpt around; what is handed over is still the original, inside the same record and character budget. With no notes
    // every score, order and excerpt is exactly what it was.
    const hint = this.recallHintsFor(text);
    const candidates = [...this.records.values()].filter(record => record.scopeKey === key && !record.origin && record.id !== options.excludeRecordId)
      .map(record => {
        const literal = memoryRecallMatch(text, record), note = hint(record.id);
        return { record, note, score: literal.score + (note?.score ?? 0), explicit: literal.explicit || !!note?.explicit,
          weight: memoryWeightAt(record.weight, record.weightAt, now, this.config) };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || b.weight - a.weight || b.record.updatedAt - a.record.updatedAt);
    const result: MemoryRecall[] = [];
    for (const item of candidates) {
      if (result.length >= maxRecords || budget <= 0) break;
      const excerpt = this.excerpt(item.record, text, budget, item.note?.terms);
      if (!excerpt) continue;
      // The note's one-line title (≤ 20, like the automatic one) helps her place it; a title the user wrote stays.
      const title = item.note?.title && !item.record.manual.title ? { title: item.note.title } : {};
      result.push({ ...this.summary(item.record, now), ...title, excerpt });
      budget -= Array.from(excerpt).length;
    }
    return result;
  }

  // ---- I-021 her notebook (electron/memory-notes/): read-only views and two hooks; nothing here writes the journal ----

  /** The notebook answers during retrieve (local matching, never awaited); null detaches it. */
  setRecallHints(hints: MemoryRecallHints | null): void { this.recallHints = hints; this.recallEpoch++; }
  /**
   * Told after a record left the archive (a deletion, or a scope's records forgotten); null detaches it. `how.recoverable`: the
   * records went into the recycle bin and may come back (forgetScope with `keep`), rather than being deleted for good.
   */
  onRecordsRemoved(listener: ((recordIds: readonly string[], how: RecordsRemoval) => void) | null): void { this.removalListener = listener; }
  /** The opaque scope identity the notebook compares segments with (the same hash the journal keys records by). */
  noteScope(scope: MemoryScope): string { return scopeKey(scope); }
  /** I-049: the character a scope hash (noteScope) belongs to, when the archive has learned it; null otherwise. */
  characterOfScope(key: string): string | null { return this.owners.get(key)?.characterId ?? null; }
  /**
   * I-021 删除一致性: changes whenever something a recall may have used was taken back (a note deleted, records removed). A turn
   * that recalled before an await and is put together after it recalls again when this moved (CompanionService.begin).
   */
  recallRevision(): string {
    let notes = 0;
    try { notes = this.recallHints?.revision ?? 0; } catch { notes = 0; }
    return `${this.recallEpoch}.${notes}`;
  }

  // ---- I-021 删除一致性: which character each scope belongs to (MEMORY_SCOPES_FILE) ----

  /**
   * Every connection scope this character's chat memory has been kept under (what "all of her chat memory" must cover beside
   * the current connection and the usual model aliases). Learned when she is chatted with or opened under a connection.
   */
  providerScopesOf(characterId: string): string[] {
    if (this.journal !== 'conversation' || typeof characterId !== 'string') return [];
    return [...new Set([...this.owners.values()].filter(owner => owner.characterId === characterId).map(owner => owner.providerScope))];
  }
  /**
   * The character is opened under this connection (CompanionService.context): if the journal already has memories under it
   * that nobody has claimed yet (written before this list existed), they are hers. Never throws for a failed save.
   */
  rememberScope(scope: MemoryScope): Promise<void> {
    const key = scopeKey(scope);
    return this.mutate(async () => { this.ready(); await this.own(scope, key, false); });
  }
  /** `create`: a record of this scope is about to be written; otherwise only when the journal already has some. */
  private async own(scope: MemoryScope, key: string, create: boolean): Promise<void> {
    if (this.journal !== 'conversation') return;
    if (!this.owners.has(key)) {
      if (!create && ![...this.records.values()].some(record => record.scopeKey === key)) return;
      this.owners.set(key, { characterId: scope.characterId, providerScope: scope.providerScope });
      this.ownersDirty = true;
    }
    if (!this.ownersDirty || this.ownersReadOnly) return;
    // Its own file, written whole; a failed save never blocks a chat turn and is tried again at the next turn.
    try {
      await atomicWriteFile(path.join(this.directory, MEMORY_SCOPES_FILE), JSON.stringify({ version: 1,
        scopes: [...this.owners.values()].map(owner => ({ characterId: owner.characterId, providerScope: owner.providerScope })) }));
      this.ownersDirty = false;
    } catch { /* Kept in memory; saved with the next one. */ }
  }
  private async loadOwners(): Promise<void> {
    this.owners.clear(); this.ownersDirty = false; this.ownersReadOnly = false;
    if (this.journal !== 'conversation') return;
    const file = path.join(this.directory, MEMORY_SCOPES_FILE);
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    // A file that is there but cannot be read now is never written over (this run keeps what it learns in memory only).
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.ownersReadOnly = true; return; }
    try {
      const value = JSON.parse(text) as { version?: unknown; scopes?: unknown };
      if (value?.version !== 1 || !Array.isArray(value.scopes)) throw new Error('unreadable');
      for (const item of value.scopes.slice(0, 100_000) as Partial<ScopeOwner>[]) {
        try {
          const owner = { characterId: identity(item?.characterId, '角色编号'), providerScope: identity(item?.providerScope, '连接范围', 4096) };
          this.owners.set(scopeKey(owner), owner);
        } catch { /* One bad row is dropped. */ }
      }
    } catch {
      // Unreadable: set aside beside it (never overwritten); the list is learned again as she is used.
      await rename(file, `${file}.unreadable-${Date.now()}`).catch(() => { this.ownersReadOnly = true; });
    }
  }

  /**
   * Every ordinary chat segment of every scope (host initiatives are observations, never noted). A segment has `ended` when no
   * reply streams and the next message would begin a new record: sealed, quiet for segmentGapMinutes, or segmentTurns complete
   * turns. `source` changes whenever its text does (text only ever grows: replies stream in, a voice turn extends).
   */
  noteSegments(now = Date.now()): NoteSegmentInfo[] {
    this.ready();
    if (this.journal !== 'conversation') return [];
    return [...this.records.values()].filter(record => !record.origin).map(record => this.segmentInfo(record, now));
  }
  /** One segment's messages with text, in order; null for an unknown id or a host initiative. */
  noteSegment(id: string, now = Date.now()): NoteSegmentText | null {
    this.ready();
    const record = typeof id === 'string' ? this.records.get(id) : undefined;
    if (this.journal !== 'conversation' || !record || record.origin) return null;
    return { info: this.segmentInfo(record, now),
      messages: record.messages.filter(message => message.content.trim()).map(message => ({ role: message.role, content: message.content })) };
  }
  private segmentInfo(record: StoredRecord, now: number): NoteSegmentInfo {
    let characters = 0, userChars = 0, replies = 0, complete = 0, streaming = false;
    for (const message of record.messages) {
      characters += message.content.length;
      if (message.role === 'user') userChars += Array.from(message.content.trim()).length;
      else {
        if (message.content.trim()) replies++;
        if (message.status === 'complete') complete++;
        if (message.status === 'streaming') streaming = true;
      }
    }
    const ended = !streaming && (record.sealed || now - record.lastFinishedAt >= this.config.segmentGapMinutes * 60_000 || complete >= this.config.segmentTurns);
    return { id: record.id, scope: record.scopeKey, createdAt: record.createdAt, lastAt: record.lastFinishedAt, ended,
      source: `${record.messages.length}.${characters}.${record.updatedAt}`, userChars, replies };
  }
  private recallHintsFor(text: string): (recordId: string) => MemoryNoteHint | null {
    const hints = this.recallHints;
    if (!hints || this.journal !== 'conversation') return () => null;
    let lookup: (recordId: string) => MemoryNoteHint | null;
    try { lookup = hints.prepare(text); } catch { return () => null; }
    return recordId => { try { return lookup(recordId); } catch { return null; } };
  }
  private notifyRemoved(recordIds: string[], how: RecordsRemoval): void {
    if (this.journal !== 'conversation' || !recordIds.length) return;
    this.recallEpoch++;
    try { this.removalListener?.(recordIds, how); } catch { /* The notebook catches up on its next look (reconcile). */ }
  }
  /**
   * I-021 删除一致性: a continuation took the tags of the segment it carried on from (beginTurn). When that segment is deleted,
   * its tags that the continuation's own words do not bear out go from it and from the continuations after it, so the deleted
   * segment cannot still be found by them (list by tag, recall); a tag the user set by hand stays. The continuation then links
   * to what the deleted one carried on from, if that is still here. Originals, titles and times are untouched. Copies.
   */
  private releasedContinuations(removed: StoredRecord, remaining: readonly StoredRecord[]): Map<string, StoredRecord> {
    const released = new Map<string, StoredRecord>();
    const children = new Map<string, StoredRecord[]>();
    for (const record of remaining) {
      if (record.scopeKey !== removed.scopeKey || !record.continuationOf) continue;
      children.set(record.continuationOf, [...(children.get(record.continuationOf) ?? []), record]);
    }
    if (!children.has(removed.id)) return released;
    const inherited = new Set(removed.tags);
    const ids = new Set(remaining.map(record => record.id));
    const known = [...new Set(remaining.filter(record => record.scopeKey === removed.scopeKey).flatMap(record => record.tags))];
    const queue = [...children.get(removed.id)!], seen = new Set<string>([removed.id]);
    while (queue.length) {
      const record = queue.shift()!;
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      queue.push(...(children.get(record.id) ?? []));
      const next = copy(record);
      let changed = false;
      if (next.continuationOf === removed.id) {
        if (removed.continuationOf && ids.has(removed.continuationOf)) next.continuationOf = removed.continuationOf; else delete next.continuationOf;
        changed = true;
      }
      if (!next.manual.tags) {
        const own = next.messages.filter(message => message.role === 'user' && message.content).map(message => message.content);
        const kept = next.tags.filter(tag => !inherited.has(tag) || own.some(text => memoryRecallMatch(text, { title: '', tags: [tag] }).score > 0));
        if (kept.length !== next.tags.length) {
          const derived = own.flatMap(text => deriveMemoryMetadata(text, known).tags);
          next.tags = [...new Set([...kept, ...derived])].slice(0, 5);
          if (!next.tags.length) next.tags = ['日常'];
          changed = true;
        }
      }
      if (changed) released.set(next.id, next);
    }
    return released;
  }

  reinforce(scope: MemoryScope, id: string, mention: MemoryMention): Promise<number | undefined> {
    const key = scopeKey(scope); identity(id, "记录编号"); this.validateMention(mention);
    return this.mutate(async () => {
      this.ready(); const record = this.find(key, id);
      if (!record) return undefined;
      if (record.origin) return 0;
      const weight = memoryWeightAt(record.weight, record.weightAt, mention.at, this.config);
      if (record.mentions.some(item => item.eventId === mention.eventId || item.episodeId === mention.episodeId)) return weight;
      const effectiveAt = Math.max(mention.at, record.weightAt);
      const recent = record.mentions.filter(item => item.at <= effectiveAt && item.at > effectiveAt - this.config.mentionWindowHours * 3_600_000).length;
      const nextWeight = Math.min(this.config.maxWeight, weight + (this.config.mentionGains[recent] ?? 0));
      await this.commit({ type: "mention", scopeKey: key, recordId: id, mention: copy(mention), weight: nextWeight });
      return nextWeight;
    });
  }

  /** Only unique source-supported recollections qualify; ambiguous same-tag records do not. */
  detectExplicitRecall(scope: MemoryScope, text: string, excludeRecordId?: string): string[] {
    this.ready(); const key = scopeKey(scope);
    if (typeof text !== "string") return [];
    const matches = [...this.records.values()].filter(record => record.scopeKey === key && !record.origin && record.id !== excludeRecordId)
      .map(record => ({ id: record.id, match: memoryRecallMatch(text, record) })).filter(item => item.match.explicit)
      .sort((a, b) => b.match.score - a.match.score);
    if (!matches.length || (matches[1] && matches[1].match.score === matches[0].match.score)) return [];
    return [matches[0].id];
  }

  /**
   * Called once for each accepted user message. Episode state lives in the journal,
   * independently of chat windows, new conversations, seal() and application restarts.
   * Returns only targets newly reinforced in this continuous recollection episode.
   */
  noteUserRecall(scope: MemoryScope, text: string, note: MemoryRecallNote): Promise<string[]> {
    const key = scopeKey(scope);
    identity(note?.eventId, "事件编号"); time(note.at);
    if (typeof text !== "string") throw new Error("回忆判断只接受用户文字。");
    if (note.excludeRecordId !== undefined) identity(note.excludeRecordId, "记录编号");
    if (note.confirmedRecordId !== undefined) identity(note.confirmedRecordId, "记录编号");
    return this.mutate(async () => {
      this.ready();
      if (this.noteIds.get(key)?.has(note.eventId)) return [];
      const previous = this.recalls.get(key);
      const at = Math.max(note.at, previous?.lastAt ?? note.at);
      const knownTags = this.knownTags(key);
      const metadata = deriveMemoryMetadata(text, knownTags);
      const topicTags = metadata.tags.filter(tag => tag !== "日常");
      const gap = previous ? at - previous.lastAt : 0;
      const concreteTopics = new Set(["电影", "音乐", "游戏", "读书", "工作", "学习", "编程", "雨天", "吃饭", "角色设定"]);
      const nextTopics = topicTags.filter(tag => concreteTopics.has(tag));
      const namedTopics = topicTags.filter(tag => isSpecificMemoryTag(tag) && (knownTags.includes(tag) || text.includes(`《${tag}》`) || text.includes(`#${tag}`)));
      const previousNamed = previous?.topicTags.filter(isSpecificMemoryTag) ?? [];
      const changedNamedObject = namedTopics.length > 0 && previousNamed.length > 0 && namedTopics.every(tag => !previousNamed.includes(tag));
      const unrelatedTopic = previous && previous.targets.length > 0 && (changedNamedObject ||
        (nextTopics.length > 0 && nextTopics.every(tag => !previous.topicTags.includes(tag))));
      const ended = !previous || isMemoryTopicChange(text) || gap >= this.config.segmentGapMinutes * 60_000 || unrelatedTopic;
      const episode: RecallEpisode = ended
        ? { id: randomUUID(), targets: [], topicTags: [], lastAt: at }
        : { ...copy(previous), lastAt: at };
      let targets = this.detectExplicitRecall(scope, text, note.excludeRecordId);
      // A short acknowledgement alone is neither source evidence nor substantive
      // confirmation. A named object/title from the actual recalled source is.
      if (!targets.length && note.confirmedRecordId && note.confirmedRecordId !== note.excludeRecordId && Array.from(text.trim()).length >= 8) {
        const confirmed = this.find(key, note.confirmedRecordId);
        if (confirmed && !confirmed.origin && memoryRecallMatch(text, confirmed).score >= 4) targets = [confirmed.id];
      }
      const mentions: { recordId: string; mention: MemoryMention; weight: number }[] = [];
      for (const id of targets) {
        const record = this.find(key, id);
        if (!record || record.origin || episode.targets.includes(id)) continue;
        const mention = { eventId: note.eventId, episodeId: episode.id, at };
        if (record.mentions.some(item => item.eventId === mention.eventId || item.episodeId === mention.episodeId)) continue;
        const effectiveAt = Math.max(at, record.weightAt);
        const oldWeight = memoryWeightAt(record.weight, record.weightAt, effectiveAt, this.config);
        const recent = record.mentions.filter(item => item.at <= effectiveAt && item.at > effectiveAt - this.config.mentionWindowHours * 3_600_000).length;
        mentions.push({ recordId: id, mention, weight: Math.min(this.config.maxWeight, oldWeight + (this.config.mentionGains[recent] ?? 0)) });
        episode.targets.push(id);
      }
      if (targets.length) episode.topicTags = [...new Set(episode.targets.flatMap(id => this.find(key, id)?.tags ?? []))];
      await this.commit({ type: "recall", scopeKey: key, eventId: note.eventId, episode, mentions });
      return mentions.map(item => item.recordId);
    });
  }

  /** Wait for preceding streaming appends during a graceful application shutdown. */
  async flush(): Promise<void> { await this.queue; }

  private ready(): void { if (!this.loaded) throw new Error("聊天记忆尚未载入。"); }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending;
  }
  private line(event: JournalEvent): string { return `${JSON.stringify(event)}\n`; }
  private async commit(event: JournalEvent): Promise<void> {
    await appendFile(this.file, this.line(event), { encoding: "utf8", mode: 0o600 });
    this.apply(event);
  }
  private async compact(records = [...this.records.values()], tombstones = this.tombstones, recalls = this.recalls): Promise<void> {
    const header: JournalEvent = { type: "header", version: 1, config: this.config, tombstones: [...tombstones],
      recalls: [...recalls], noteIds: [...this.noteIds].map(([key, ids]) => [key, [...ids]]) };
    // Same exclusive temporary file beside the journal, then rename; a failed attempt removes its temporary file.
    await this.writeAtomic(this.file, this.line(header) + records.map(record => this.line({ type: "record", record })).join(""));
  }
  private find(key: string, id: string): StoredRecord | undefined {
    const record = this.records.get(id); return record?.scopeKey === key ? record : undefined;
  }
  private assistant(key: string, id: string): MemoryMessage | undefined {
    return this.records.get(this.turns.get(turnKey(key, id)) ?? "")?.messages.find(message => message.turnId === id && message.role === "assistant");
  }
  private knownTags(key: string): string[] {
    return [...new Set([...this.records.values()].filter(record => record.scopeKey === key).flatMap(record => record.tags))];
  }
  private summary(record: StoredRecord, now: number): MemorySummary {
    return { id: record.id, title: record.title, tags: [...record.tags], category: record.category,
      createdAt: record.createdAt, updatedAt: record.updatedAt, weight: record.origin ? 0 : memoryWeightAt(record.weight, record.weightAt, now, this.config),
      messageCount: record.messages.length, turnCount: record.messages.filter(message => message.role === "user").length,
      sealed: record.sealed, ...(record.continuationOf ? { continuationOf: record.continuationOf } : {}),
      ...(record.origin ? { origin: copy(record.origin) } : {}) };
  }
  private queryText(value: unknown, limit: number): string {
    if (value === undefined) return "";
    if (typeof value !== "string" || value.length > limit || value.includes("\0")) throw new Error("记忆查询格式不正确。");
    return value.trim();
  }
  private validateEdit(value: MemoryEdit): MemoryEdit {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["title", "tags", "category"].includes(key))) throw new Error("记忆编辑只允许标题、标签和分类。");
    const edit: MemoryEdit = {};
    if (value.title !== undefined) { edit.title = this.queryText(value.title, 80); if (!edit.title) throw new Error("记忆标题不能为空。"); }
    if (value.tags !== undefined) {
      if (!Array.isArray(value.tags) || value.tags.length < 1 || value.tags.length > 10) throw new Error("记忆标签需要 1～10 个。");
      edit.tags = [...new Set(value.tags.map(tag => { const item = this.queryText(tag, 40); if (!item) throw new Error("记忆标签不能为空。"); return item; }))];
    }
    if (value.category !== undefined) { if (!MEMORY_CATEGORIES.includes(value.category)) throw new Error("记忆分类不正确。"); edit.category = value.category; }
    return edit;
  }
  private validateMention(mention: MemoryMention): void {
    if (!mention || typeof mention !== "object") throw new Error("记忆提及格式不正确。");
    identity(mention.eventId, "事件编号"); identity(mention.episodeId, "回忆片段编号"); time(mention.at);
  }
  private validateOrigin(value: unknown): ProactiveOrigin {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(field => !['kind', 'id', 'at', 'sources', 'labels'].includes(field))) throw new Error('主动来源只接受有界文字身份。');
    const origin = value as ProactiveOrigin;
    if (origin.kind !== 'proactive' || typeof origin.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(origin.id)) throw new Error('主动来源编号不正确。');
    time(origin.at);
    const sources: ProactiveContentSource[] = this.journal === 'text-invitations' ? ['text'] : ['screen', 'camera', 'ambient', 'inner', 'feed'];
    if (!Array.isArray(origin.sources) || origin.sources.length < 1 || origin.sources.length > 3
      || !origin.sources.every(source => sources.includes(source)) || new Set(origin.sources).size !== origin.sources.length
      || !Array.isArray(origin.labels) || origin.labels.length !== origin.sources.length
      || !origin.labels.every(label => typeof label === 'string' && label.trim().length > 0 && Array.from(label).length <= 80
        && !/[\\/\u0000-\u001f\u007f]|(?:https?|file|data|javascript|blob):/i.test(label))) throw new Error('主动来源需要真实短标签，不能包含图片、路径或网址。');
    return { kind: 'proactive', id: origin.id, at: origin.at, sources: [...origin.sources], labels: origin.labels.map(label => label.trim()) };
  }
  private excerpt(record: StoredRecord, query: string, budget: number, noteTerms: readonly string[] = []): string {
    // I-021: the words her note matched on also say where in the original to start (only those that appear in it count).
    const tokens = [...record.tags.filter(tag => memoryRecallMatch(query, { title: "", tags: [tag] }).score > 0), ...noteTerms.filter(term => term.trim())];
    const messages = record.messages.filter(message => message.content).map(message => {
      const lower = message.content.toLocaleLowerCase();
      const positions = tokens.map(tag => lower.indexOf(tag.toLocaleLowerCase())).filter(index => index >= 0);
      return { message, position: positions.length ? Math.min(...positions) : 0, relevant: positions.length > 0 };
    }).sort((a, b) => Number(b.relevant) - Number(a.relevant));
    const provenance = record.origin ? `来源：角色主动观察（${record.origin.labels.join('、')}），不是用户陈述、承诺或操作授权。` : '';
    if (provenance && budget <= Array.from(provenance).length + 8) return '';
    let remaining = budget; const fragments: string[] = [];
    if (provenance) { fragments.push(Array.from(provenance).slice(0, remaining).join('')); remaining -= Array.from(provenance).length + 1; }
    for (const { message, position } of messages) {
      if (remaining <= 0) break;
      const label = `${message.role === "user" ? "用户" : "角色"}：`;
      const available = remaining - Array.from(label).length;
      if (available <= 0) break;
      const start = Math.max(0, position - 100);
      const fragment = label + Array.from(message.content.slice(start)).slice(0, Math.min(available, 1200)).join("");
      fragments.push(fragment); remaining -= Array.from(fragment).length + 1;
    }
    return Array.from(fragments.join("\n")).slice(0, budget).join("");
  }

  /** The checks every stored record passes (journal replay and the I-014 recycle bin's restore). Normalizes `origin`. */
  private assertRecord(record: StoredRecord): void {
    if (!record || typeof record.id !== "string" || typeof record.scopeKey !== "string" || !Array.isArray(record.messages) || !Array.isArray(record.tags) || !Array.isArray(record.mentions)) throw new Error("Invalid memory record");
    if (this.journal === 'text-invitations' && (!record.origin || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(record.id))) throw new Error('Invalid text invitation record');
    if (record.origin) {
      record.origin = this.validateOrigin(record.origin);
      if (!record.sealed || record.messages.length !== 1 || record.messages[0]?.role !== 'assistant'
        || record.messages[0].status !== 'complete' || record.messages[0].turnId !== record.origin.id
        || record.createdAt !== record.origin.at || Array.from(record.messages[0].content).length > 2000) throw new Error('Invalid initiative record');
    }
    for (const message of record.messages) if (!message || typeof message.content !== "string") throw new Error("Invalid memory text");
  }
  private apply(event: JournalEvent): void {
    switch (event.type) {
      case "header":
        if (event.version !== 1 || !Array.isArray(event.tombstones) || !event.tombstones.every(item => typeof item === "string")) throw new Error("Invalid memory header");
        this.config = validateMemoryConfig(event.config); this.tombstones = new Set(event.tombstones);
        this.recalls = new Map(event.recalls ?? []);
        this.noteIds = new Map((event.noteIds ?? []).map(([key, ids]) => [key, new Set(ids)]));
        break;
      case "record": {
        const record = event.record;
        this.assertRecord(record);
        this.records.set(record.id, record);
        for (const message of record.messages) this.turns.set(turnKey(record.scopeKey, message.turnId), record.id);
        if (!record.sealed) this.active.set(record.scopeKey, record.id);
        break;
      }
      case "begin": {
        if (event.record) this.apply({ type: "record", record: event.record });
        const record = this.records.get(event.recordId);
        if (!record || typeof event.user?.content !== "string" || event.user.role !== "user" || event.assistant?.role !== "assistant") throw new Error("Invalid memory turn");
        if (event.previousId) { const previous = this.records.get(event.previousId); if (previous) previous.sealed = true; }
        record.messages.push(event.user, event.assistant); record.updatedAt = Math.max(record.updatedAt, event.user.updatedAt);
        if (!record.manual.tags) record.tags = [...new Set([...record.tags, ...event.metadata.tags])].slice(0, 5);
        this.turns.set(turnKey(record.scopeKey, event.user.turnId), record.id); this.active.set(record.scopeKey, record.id);
        break;
      }
      case "delta": {
        if (typeof event.delta !== "string") throw new Error("Invalid memory delta");
        const message = this.assistant(event.scopeKey, event.turnId);
        if (message?.status === "streaming") { if (!message.content) message.createdAt = event.at; message.content += event.delta; message.updatedAt = Math.max(message.updatedAt, event.at); const record = this.records.get(this.turns.get(turnKey(event.scopeKey, event.turnId))!); if (record) record.updatedAt = Math.max(record.updatedAt, event.at); }
        break;
      }
      case "finish": {
        const message = this.assistant(event.scopeKey, event.turnId);
        if (message?.status === "streaming") { message.status = event.status; message.updatedAt = Math.max(message.updatedAt, event.at); const record = this.records.get(this.turns.get(turnKey(event.scopeKey, event.turnId))!); if (record) { record.lastFinishedAt = Math.max(record.lastFinishedAt, event.at); record.updatedAt = Math.max(record.updatedAt, event.at); } }
        break;
      }
      case "seal": { const record = this.records.get(this.active.get(event.scopeKey) ?? ""); if (record) record.sealed = true; this.active.delete(event.scopeKey); break; }
      case "edit": {
        const record = this.find(event.scopeKey, event.recordId); if (!record) break;
        const edit = this.validateEdit(event.edit);
        for (const key of ["title", "tags", "category"] as const) { if (edit[key] !== undefined) { Object.assign(record, { [key]: copy(edit[key]) }); record.manual[key] = true; } }
        break;
      }
      case "mention": { const record = this.find(event.scopeKey, event.recordId); if (record) { this.validateMention(event.mention); record.mentions.push(event.mention); record.weight = event.weight; record.weightAt = Math.max(record.weightAt, event.mention.at); } break; }
      case "recall": {
        identity(event.eventId, "事件编号"); time(event.episode.lastAt);
        this.recalls.set(event.scopeKey, event.episode);
        const ids = this.noteIds.get(event.scopeKey) ?? new Set<string>(); ids.add(event.eventId); this.noteIds.set(event.scopeKey, ids);
        for (const item of event.mentions) this.apply({ type: "mention", scopeKey: event.scopeKey, recordId: item.recordId, mention: item.mention, weight: item.weight });
        break;
      }
      case "configure": this.config = validateMemoryConfig(event.config); break;
      default: throw new Error("Unknown memory event");
    }
  }
}
