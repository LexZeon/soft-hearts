// P-001 step 1: wiring of "she remembers your plans" so electron/main.ts only adds a few lines. Four jobs:
//  - mark a chat segment "may record" when the user's recording switch is on for all of it (turnBegun, from MemoryStore.onTurnBegun);
//  - hand the notebook its hooks (marked / noted / dropped / survivors): the note call of a marked segment carries one extra question, and the
//    plans in its answer go into the list of the segment's own character (electron/memory/upcoming/book.ts, files of their own: store.ts);
//  - turning the switch off by hand wipes every mark (every list file is deleted by the user profile store at the same moment, via UpcomingPort.purgeAll);
//  - once in a while let plans that were never asked about expire and old closed ones leave.
// Nothing here reads a message except the marked segment's own note answer, in memory, to find the plans; nothing is logged but counts.

import { resolveDue } from '../../../shared/behaviors/upcoming/due';
import type { UpcomingBook } from '../../../shared/behaviors/upcoming/interface';
import { extractUpcoming } from '../../../shared/behaviors/upcoming/prompt';
import { DEV_SEGMENT_PREFIX } from '../../../shared/behaviors/upcoming/state';
import type { UpcomingJournalEvent, UpcomingJournalVia } from '../../../shared/memory/journal-entries';
import { PRIVATE_LITERAL } from '../../foundation/private-literal';
import { sensitive } from '../user-profile-reply';
import type { NotebookUpcomingHooks } from '../memory-notes/host';
import { UpcomingAsk, type UpcomingAskDeps } from './ask';
import { EarlyUpcoming, type EarlyUpcomingDeps } from './early';
import { UpcomingMarks } from './marks';

export interface UpcomingHostDeps {
  /** The profile files' directory (the marks file sits beside them). */
  directory: string;
  book: UpcomingBook;
  /** The user's recording switch, with a ready profile. */
  recording(): boolean;
  /** The profile scope id (userProfileScopeId) of the character and connection a chat segment's notebook key belongs to, or null when unknown. */
  scopeOf(noteScope: string): string | null;
  /** The plan list or a mark changed: refresh what is shown. */
  changed?(): void;
  /** The experience journal: closed events and counts only. */
  journal?(event: UpcomingJournalEvent, count: number, via?: UpcomingJournalVia): void;
  /**
   * "两分钟先记下": the small look at a marked segment's new messages once the user has been quiet for UPCOMING_KNOBS.early.quietSeconds
   * (electron/memory/upcoming/early.ts). Absent: plans are noted only by the segment's note, as before.
   */
  early?: Pick<EarlyUpcomingDeps, 'archive' | 'write' | 'userBusy' | 'modelBusy' | 'lastActivityAt' | 'tickMs' | 'localDay' | 'knobs'>;
  /** Steps 2 and 3: asking once a plan's time has come (electron/memory/upcoming/ask.ts). Absent: she never asks. */
  ask?: Pick<UpcomingAskDeps, 'hour' | 'asleep' | 'userState' | 'random' | 'knobs'>;
  now?(): number;
  /** How often plans are settled (default 30 minutes; also once at start). */
  settleMs?: number;
}

/** The profile's own refusals (sensitive words, credentials, paths) for anything the plan memory would keep. */
const rejectText = (text: string): boolean => PRIVATE_LITERAL.test(text) || sensitive.test(text);

export type UpcomingTestResult = 'ok' | 'recording-off' | 'nothing';

export class UpcomingHost {
  readonly marks: UpcomingMarks;
  readonly early: EarlyUpcoming | null;
  readonly ask: UpcomingAsk | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly deps: UpcomingHostDeps, marks?: UpcomingMarks) {
    this.marks = marks ?? new UpcomingMarks(deps.directory);
    this.ask = deps.ask ? new UpcomingAsk({ ...deps.ask, book: deps.book, recording: () => deps.recording(), changed: () => deps.changed?.(),
      journal: (event, count) => deps.journal?.(event, count), now: deps.now }) : null;
    this.early = deps.early ? new EarlyUpcoming({ ...deps.early, recording: () => deps.recording(), marked: id => this.marks.has(id), scopeOf: key => deps.scopeOf(key),
      book: deps.book, reject: rejectText, changed: () => deps.changed?.(), journal: (event, count, via) => deps.journal?.(event, count, via), now: deps.now }) : null;
  }

  async start(): Promise<void> {
    await this.marks.load();
    this.settle();
    this.early?.start();
    if (!this.timer) { this.timer = setInterval(() => this.settle(), this.deps.settleMs ?? 30 * 60_000); this.timer.unref?.(); }
  }

  /**
   * A user message began (or went on in) the chat segment `recordId`. First message of a segment: marked only if the switch is on now. Later
   * message: the switch is off now, so the segment was not recorded as a whole any more: the mark goes. (Turning the switch off by hand wipes
   * every mark anyway; this covers the switch being off at the moment of a message without a hand turning it off, e.g. no profile ready.)
   */
  turnBegun(info: { recordId: string; first: boolean }): void {
    try {
      const on = this.deps.recording();
      if (info.first) { if (on) this.marks.add(info.recordId); }
      else if (!on) this.marks.remove([info.recordId]);
    } catch { /* A missed mark only means this segment is not asked about. */ }
  }

  hooks(): NotebookUpcomingHooks {
    return {
      marked: id => this.marks.has(id),
      noted: info => this.noted(info),
      dropped: ids => this.dropped(ids),
      survivors: ids => this.survivors(ids),
    };
  }

  private noted(info: Parameters<NotebookUpcomingHooks['noted']>[0]): void {
    this.early?.noteWritten(info.recordId); // what the early look examined and what the note covers are the same ground; the book dedupes
    // The mark must still stand and the switch still be on when the answer lands. The plan goes to the segment's own character, shown or not.
    if (!this.deps.recording() || !this.marks.has(info.recordId)) return;
    const scope = this.deps.scopeOf(info.scope);
    if (!scope) return;
    const items = extractUpcoming(info.raw, info.messages, { at: info.at, reject: rejectText });
    if (!items.length) return;
    void this.deps.book.add({ from: info.recordId, items, scope }).then(added => {
      if (added > 0) { this.deps.journal?.('recorded', added, 'note'); this.deps.changed?.(); }
    }).catch(() => undefined);
  }

  private dropped(ids: readonly string[]): void {
    this.marks.remove(ids);
    this.early?.forget(ids);
    void this.deps.book.dropSegments(ids).then(removed => { if (removed > 0) this.deps.changed?.(); }).catch(() => undefined);
  }

  private survivors(ids: ReadonlySet<string>): void {
    this.marks.keepOnly(ids);
    this.early?.keepOnly(ids);
    void this.deps.book.keepSegments(ids).then(removed => { if (removed > 0) this.deps.changed?.(); }).catch(() => undefined);
  }

  /** I-087: ids of the plans noted since `since` (only a book that can tell: the real one), for a pinky promise. */
  recentPlanIds(since: number): readonly string[] {
    const book = this.deps.book as UpcomingBook & { recentIds?(since: number): readonly string[] };
    try { return book.recentIds?.(since) ?? []; } catch { return []; }
  }

  /** The user turned recording off by hand: every mark is deleted at once (the list files are deleted by the profile store at the same moment). */
  recordingOff(): Promise<void> { this.early?.recordingOff(); return this.marks.wipe(); }

  settle(): void {
    void this.deps.book.settle().then(expired => { if (expired > 0) { this.deps.journal?.('expired', expired); this.deps.changed?.(); } }).catch(() => undefined);
  }

  // ---- developer test commands (electron/safety/test-commands/): they go through the same book, and so through the same recording switch ----

  /** 「测试：记一件事」: a small made-up plan "明天下午" (due tomorrow 18:00, like a real one). */
  async testAdd(): Promise<UpcomingTestResult> {
    if (!this.deps.recording()) return 'recording-off';
    const now = this.deps.now?.() ?? Date.now();
    const dueAt = resolveDue('明天下午', now);
    if (dueAt === null) return 'nothing';
    const added = await this.deps.book.add({ from: `${DEV_SEGMENT_PREFIX}${now}`, items: [{ what: '试一试的一件事', said: '明天下午', dueAt }] });
    if (added > 0) { this.deps.journal?.('recorded', added); this.deps.changed?.(); }
    return added > 0 ? 'ok' : 'nothing';
  }
  /** 「测试：到时候了」: the earliest plan still waiting is due now. */
  async testDue(): Promise<UpcomingTestResult> {
    if (!this.deps.recording()) return 'recording-off';
    const changed = await this.deps.book.makeDue();
    if (changed) this.deps.changed?.();
    return changed ? 'ok' : 'nothing';
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.early?.dispose();
    await this.marks.flush();
    this.marks.dispose();
  }
}
