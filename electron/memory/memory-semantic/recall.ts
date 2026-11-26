// "Recall by meaning" (I-111): which old memories of this character and connection are close in MEANING to what the user just said.
// A flat scan over the vectors of the current scope (no vector database); the vectors are computed from what the user said in each
// finished chat segment, backfilled a few at a time when the user is not with her, and cached on disk (vectors.ts).
//
// What a turn gets: `scores(text)` is synchronous and local (a dot product per memory), like the keyword recall; it needs the user's
// line already turned into a vector, which `prefetch(text)` does (the caller starts it early and waits at most knobs.pace.prefetchMs). With the
// switch off, the model missing, broken or too slow, `scores` returns nothing and recall is exactly what it was. Similarity is a
// candidate signal, never a fact: below the floor nothing comes back, and the score stays under a literal match (knobs.match.maxScore).
// Nothing here logs a memory or a line.

import type { NoteSegmentInfo, NoteSegmentText } from '../../../shared/memory/memory-notes/interface';
import { MEMORY_SEMANTIC_KNOBS, type MemorySemanticKnobs } from '../../../shared/memory/memory-semantic/knobs';
import { dot, memoryEmbedText, queryEmbedText, semanticScore } from '../../../shared/memory/memory-semantic/score';
import { CharacterVectors, type VectorStore } from './vectors';

export interface SemanticArchive {
  noteSegments(now: number): readonly NoteSegmentInfo[];
  noteSegment(id: string, now: number): NoteSegmentText | null;
}

export interface SemanticRecallDeps {
  store: VectorStore;
  archive: SemanticArchive;
  /** Texts -> unit vectors (the embedding process). Rejects when the process is not there or fails. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** The switch is on AND the model is installed and not being changed. Off: nothing is computed and nothing is found. */
  active(): boolean;
  /** The current character and connection (MemoryStore.noteScope of the current scope), or null while switching. */
  current(): { characterId: string; scope: string } | null;
  /** The user is with her now: the backfill waits. */
  busy(): boolean;
  now?(): number;
  /** [0, 1): a different value per user line (the floor's jitter). */
  random?(): number;
  knobs?: MemorySemanticKnobs;
  /** Counts only. */
  changed?(): void;
}

/**
 * The caller's wait for `prefetch`: at most `ms`, never throws. Past the limit the turn goes on without meaning (the vector, when it
 * lands, serves the next call). First-character speed is one of the few things that is written hard (README, the seven principles).
 */
export function prefetchWithin(recall: Pick<SemanticRecall, 'prefetch'>, text: string, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    (timer as { unref?(): void }).unref?.();
    let work: Promise<void>;
    try { work = recall.prefetch(text); } catch { clearTimeout(timer); resolve(); return; }
    void work.then(() => undefined, () => undefined).then(() => { clearTimeout(timer); resolve(); });
  });
}

export interface SemanticStats { queries: number; hits: number; embedded: number; skipped: number; failed: number; saved: number }
export interface SemanticHit { score: number; terms: readonly string[]; similarity: number }

interface QueryVector { vector: Float32Array; jitter: number }
const QUERY_CACHE = 8;

export class SemanticRecall {
  readonly stats: SemanticStats = { queries: 0, hits: 0, embedded: 0, skipped: 0, failed: 0, saved: 0 };
  private readonly loaded = new Map<string, CharacterVectors>();
  private readonly loading = new Map<string, Promise<CharacterVectors>>();
  private readonly queries = new Map<string, QueryVector>();
  private readonly inflight = new Map<string, Promise<void>>();
  private ticking = false;
  private readonly knobs: MemorySemanticKnobs;

  constructor(private readonly deps: SemanticRecallDeps) { this.knobs = deps.knobs ?? MEMORY_SEMANTIC_KNOBS; }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private active(): boolean { try { return this.deps.active(); } catch { return false; } }
  private current(): { characterId: string; scope: string } | null { try { return this.deps.current(); } catch { return null; } }

  private vectorsOf(characterId: string): Promise<CharacterVectors> {
    const ready = this.loaded.get(characterId);
    if (ready) return Promise.resolve(ready);
    let pending = this.loading.get(characterId);
    if (!pending) {
      pending = this.deps.store.load(characterId).catch(() => new CharacterVectors()).then(vectors => {
        const existing = this.loaded.get(characterId);
        if (existing) return existing;
        this.loaded.set(characterId, vectors); return vectors;
      }).finally(() => this.loading.delete(characterId));
      this.loading.set(characterId, pending);
    }
    return pending;
  }

  // ---- asking (the user's line) ----

  /**
   * Turns the user's line into a vector for `scores` (and loads the character's vectors, off the reply path). Never throws; resolves
   * when done or when there is nothing to do (switch off, model not ready, a failure): the caller races it with a short timeout.
   */
  prefetch(text: string): Promise<void> {
    if (!this.active() || typeof text !== 'string' || !text.trim()) return Promise.resolve();
    const cur = this.current();
    if (cur) void this.vectorsOf(cur.characterId);
    if (this.queries.has(text)) return Promise.resolve();
    let pending = this.inflight.get(text);
    if (!pending) {
      const jitter = Math.max(0, this.knobs.match.floorJitter) * Math.min(0.999999, Math.max(0, this.deps.random?.() ?? Math.random()));
      pending = this.deps.embed([queryEmbedText(text, this.knobs)]).then(([vector]) => {
        if (!vector) return;
        this.queries.set(text, { vector, jitter });
        while (this.queries.size > QUERY_CACHE) this.queries.delete(this.queries.keys().next().value!);
      }).catch(() => { this.stats.failed++; }).finally(() => this.inflight.delete(text));
      this.inflight.set(text, pending);
    }
    return pending;
  }

  /**
   * The memories (of the current character and connection only) whose meaning is close to `text`, as a score per record id. Synchronous:
   * it uses what `prefetch` already computed; without that it starts the computation for the next call and returns nothing.
   */
  scores(text: string): Map<string, SemanticHit> {
    const found = new Map<string, SemanticHit>();
    if (!this.active() || typeof text !== 'string' || !text.trim()) return found;
    const cur = this.current();
    if (!cur) return found;
    const vectors = this.loaded.get(cur.characterId);
    const query = this.queries.get(text);
    if (!vectors || !query) { void this.prefetch(text); return found; }
    this.stats.queries++;
    const hits: { id: string; score: number; similarity: number }[] = [];
    for (const [id, entry] of vectors.entries) {
      if (entry.scope !== cur.scope || !entry.vector) continue;
      const similarity = dot(query.vector, entry.vector);
      const score = semanticScore(similarity, query.jitter, this.knobs);
      if (score > 0) hits.push({ id, score, similarity });
    }
    hits.sort((a, b) => b.score - a.score);
    for (const hit of hits.slice(0, Math.max(0, this.knobs.match.top))) found.set(hit.id, { score: hit.score, terms: [], similarity: hit.similarity });
    if (found.size) this.stats.hits++;
    return found;
  }

  // ---- computing (the user's old memories) ----

  /** How many of the current scope's finished chats have their meaning computed (for the control window). */
  progress(): { indexed: number; total: number } {
    const cur = this.current();
    if (!cur) return { indexed: 0, total: 0 };
    const vectors = this.loaded.get(cur.characterId);
    let segments: readonly NoteSegmentInfo[];
    try { segments = this.deps.archive.noteSegments(this.now()); } catch { return { indexed: 0, total: 0 }; }
    let total = 0, indexed = 0;
    for (const segment of segments) {
      if (segment.scope !== cur.scope || !segment.ended) continue;
      total++;
      if (vectors?.entries.get(segment.id)?.signature === segment.source) indexed++;
    }
    return { indexed, total };
  }

  /**
   * One backfill step (the host calls it on a timer): a few finished chats of the current scope that have no vector, or whose text changed,
   * newest first. Waits while the user is with her; never throws; at most one at a time.
   */
  async tick(): Promise<number> {
    if (this.ticking || !this.active() || this.safe(() => this.deps.busy(), true)) return 0;
    const cur = this.current();
    if (!cur) return 0;
    this.ticking = true;
    try {
      const vectors = await this.vectorsOf(cur.characterId);
      const now = this.now();
      let segments: readonly NoteSegmentInfo[];
      try { segments = this.deps.archive.noteSegments(now); } catch { return 0; }
      const mine = segments.filter(segment => segment.scope === cur.scope && segment.ended);
      // Entries of this scope whose memory is gone leave (a deleted memory normally tells us; this is the safety net).
      const everyone = new Set(segments.map(segment => segment.id));
      for (const [id, entry] of vectors.entries) if (entry.scope === cur.scope && !everyone.has(id)) { vectors.entries.delete(id); vectors.dirty = true; }
      const stale = mine.filter(segment => vectors.entries.get(segment.id)?.signature !== segment.source).sort((a, b) => b.lastAt - a.lastAt);
      const work: { segment: NoteSegmentInfo; text: string }[] = [];
      for (const segment of stale) {
        if (work.length >= Math.max(1, this.knobs.pace.batch)) break;
        const body = this.safe(() => this.deps.archive.noteSegment(segment.id, now), null);
        const text = body ? memoryEmbedText(body.messages.filter(message => message.role === 'user').map(message => message.content), this.knobs) : '';
        if (!text) { vectors.entries.set(segment.id, { scope: cur.scope, signature: segment.source, vector: null }); vectors.dirty = true; this.stats.skipped++; continue; }
        work.push({ segment, text });
      }
      if (work.length) {
        let made: Float32Array[];
        try { made = await this.deps.embed(work.map(item => item.text)); } catch { this.stats.failed++; return 0; }
        if (made.length !== work.length) { this.stats.failed++; return 0; }
        // The scope or the switch may have changed while the model worked: what came back is kept only for the scope it was made for.
        work.forEach((item, index) => { vectors.entries.set(item.segment.id, { scope: cur.scope, signature: item.segment.source, vector: made[index]! }); });
        vectors.dirty = true; this.stats.embedded += work.length;
      }
      const remaining = stale.length - work.length;
      if (vectors.dirty && (remaining <= 0 || now - vectors.lastSavedAt >= this.knobs.pace.saveSeconds * 1000)) await this.save(cur.characterId, vectors);
      try { this.deps.changed?.(); } catch { /* a closed window misses one update */ }
      return work.length;
    } finally { this.ticking = false; }
  }

  private async save(characterId: string, vectors: CharacterVectors): Promise<void> {
    vectors.dirty = false; vectors.lastSavedAt = this.now();
    try { await this.deps.store.save(characterId, vectors); this.stats.saved++; } catch { vectors.dirty = true; }
  }

  /** Quitting: whatever is computed and not yet written is written. */
  async flush(): Promise<void> {
    for (const [characterId, vectors] of this.loaded) if (vectors.dirty) await this.save(characterId, vectors);
  }

  // ---- forgetting ----

  /** Memories were deleted (whose they were is not known): their vectors go from every loaded set and every file, at once. */
  async removeEverywhere(ids: readonly string[]): Promise<void> {
    for (const vectors of this.loaded.values()) for (const id of ids) if (vectors.entries.delete(id)) vectors.dirty = true;
    await this.deps.store.removeFromAll(ids).catch(() => 0);
  }

  async forgetCharacter(characterId: string): Promise<void> {
    this.loaded.delete(characterId); this.loading.delete(characterId);
    await this.deps.store.forgetCharacter(characterId).catch(() => undefined);
  }

  /** The model was deleted: its vectors are of no use and are memory-derived, so they go too. */
  async forgetAll(): Promise<void> {
    this.loaded.clear(); this.loading.clear(); this.queries.clear();
    await this.deps.store.removeAll().catch(() => undefined);
  }

  /** The switch went off: the user's lines kept for a moment go; the vectors stay on disk, unused. */
  deactivate(): void { this.queries.clear(); }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
}
