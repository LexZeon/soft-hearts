// I-088 第 1 条 她的"这阵子"回顾: the host's wiring in one place, so electron/main.ts only adds a few lines. The store is made before the user profile
// store (which takes it as a port); the writer after the diary writer; recall is handed to the chat archive.
import path from 'node:path';
import type { MemoryScope } from '../../../shared/memory/memory';
import type { JournalInput } from '../../../shared/memory/journal';
import type { ReviewRecallSource } from '../memory';
import { userProfileScopeId, type UserProfileScope, type UserProfileStore } from '../user-profile';
import { ReviewStore } from './store';
import { PeriodReviewWriter, type ReviewCharacter, type ReviewWriterEvent } from './writer';
import type { ReviewNoteLine } from './prompt';

/** Beside the profile files, in the same folder (`review-<scopeId>.json`). */
export function createReviewStore(profileDirectory: string, recording: () => boolean): ReviewStore {
  return new ReviewStore(path.resolve(profileDirectory), { recording });
}

/** What MemoryStore.retrieve asks: the look-back of this character and connection, if the message points at one. */
export function reviewRecallSource(store: ReviewStore): ReviewRecallSource {
  return {
    recall: (scope: MemoryScope, text: string, now: number) => store.recall(userProfileScopeId({ characterId: scope.characterId, providerScope: scope.providerScope }), text, now),
    get revision() { return store.revision; },
  };
}

/** The journal line for one writer event: closed words only (shared/memory/journal.ts 'period-review'). */
export function reviewJournalEntry(event: ReviewWriterEvent, characterId: string | null): JournalInput | null {
  if (event.type === 'call') return null;
  return { type: 'period-review', characterId, kind: event.kind, event: event.type };
}

export interface PeriodReviewWiring {
  profiles: UserProfileStore;
  store: ReviewStore;
  scope(): UserProfileScope | null;
  notes(scope: UserProfileScope, start: number, end: number): readonly ReviewNoteLine[];
  character(scope: UserProfileScope): ReviewCharacter | null;
  model(): string | null;
  generate(request: { prompt: string; model: string }, signal: AbortSignal): Promise<string>;
  diaryBusy(): boolean;
  changed(): void;
  journal(entry: JournalInput | null): void;
  /** The clock; the app leaves it out (real time). Tests pass theirs so which weeks are "finished" does not follow today's date. */
  now?: () => number;
}

export function createPeriodReviewWriter(wiring: PeriodReviewWiring): PeriodReviewWriter {
  return new PeriodReviewWriter({
    profiles: wiring.profiles, store: wiring.store, scope: wiring.scope, notes: wiring.notes, character: wiring.character, model: wiring.model,
    generate: wiring.generate, diaryBusy: wiring.diaryBusy, written: () => wiring.changed(), ...(wiring.now ? { now: wiring.now } : {}),
    report: event => { try { wiring.journal(reviewJournalEntry(event, wiring.scope()?.characterId ?? null)); } catch { /* The journal never changes what she writes. */ } },
  });
}
