// 体验记录 (E2): turns what the existing hosts already report (MoodHost's accepted events and views, the her-life, her-needs,
// relationship, user-state, inner-loop and game callbacks, the character cards after a change) into journal inputs. Nothing here
// reads text: each converter copies enum values and numbers only, and shared/journal.ts checks them again before a line is made.
import { createHash } from 'node:crypto';
import type { CharacterCardState } from '../../shared/character-cards';
import type { HerLifeActivity } from '../../shared/her-life';
import type { HerNeedEvent } from '../../shared/her-needs';
import type { InnerLoopDiagnostic } from '../../shared/inner-loop';
import {
  moodEventSource, type BoredomLevel, type JournalInput, type LongingLevel, type PoseJournalEvent,
} from '../../shared/journal';
import type { PoseFollowKind } from '../../shared/pose-reactions';
import { moodJudgeWhyOf } from '../../shared/behaviors/mood-judge/choose';
import type { MoodContext, MoodLabel, MoodParameters, MoodValues } from '../../shared/mood';
import type { MoodView } from '../../shared/mood-runtime';
import type { RelationshipDiagnostic } from '../../shared/relationship';
import type { UserStateKind } from '../../shared/user-state';

/** A source that holds moments back to merge them (a run of pats): settled into its line before the switch goes off. */
export interface JournalHolder { settle(): void }

/** Where journal inputs go (electron/journal/writer.ts JournalWriter, app-journal.ts AppJournal, or a test array). */
export interface JournalSink {
  record(input: JournalInput): unknown;
  /** Whether a line handed over now would be kept (the user's switch). Without it the sink always keeps. */
  accepting?(): boolean;
  /** Registers a holder, settled when the switch is turned off (app-journal.ts registerJournalIpc). */
  holdBack?(holder: JournalHolder): void;
}

const safely = (sink: JournalSink | null | undefined, input: JournalInput) => { try { sink?.record(input); } catch { /* Keeping a record never blocks her. */ } };

/** One accepted mood change, as MoodHost reports it (electron/mood.ts setJournalObserver). `reason` is looked up, never written. */
export interface MoodJournalEvent {
  characterId: string;
  type: 'rua' | 'food' | 'chat' | 'appraisal' | 'lift';
  reason?: string;
  context?: MoodContext;
  /** A pat's effective milliseconds. */
  effectiveMs?: number;
  before: MoodValues;
  after: MoodValues;
  labelBefore: MoodLabel;
  labelAfter: MoodLabel;
}

/** Patting arrives as many small events; strokes closer than this are one "你摸了摸头". */
export const TOUCH_GAP_MS = 4_000;
/** A label counts as changed once it held this long (labels can flicker at a threshold). */
export const LABEL_STABLE_MS = 5_000;

export function boredomLevel(value: number, p: Pick<MoodParameters, 'boredom'>['boredom']): BoredomLevel {
  return value >= p.speechAt ? 'speech' : value >= p.motionAt ? 'motion' : value >= p.lookAt ? 'look' : 'none';
}
export function longingLevel(value: number, p: Pick<MoodParameters, 'longing'>['longing']): LongingLevel {
  if (value <= 0) return 'none';
  return value >= p.cryAt ? 'cry' : value >= p.sadAt ? 'sad' : value >= p.longingAt ? 'longing' : 'none';
}
const BOREDOM_ORDER: readonly BoredomLevel[] = ['none', 'look', 'motion', 'speech'];
const LONGING_ORDER: readonly LongingLevel[] = ['none', 'longing', 'sad', 'cry'];

interface ViewState { label: MoodLabel; candidate: MoodLabel | null; since: number; boredom: BoredomLevel; longing: LongingLevel; sleeping: boolean | null }
interface PendingTouch { characterId: string; before: MoodValues; after: MoodValues; labelBefore: MoodLabel; labelAfter: MoodLabel; count: number; durationMs: number; lastAt: number }

/**
 * The mood side: accepted events (a run of pats becomes one line), and from the views the label, the boredom and longing
 * thresholds and falling asleep / waking up.
 *
 * 关着就不记 (the user's rule): while the switch is off nothing is merged or waited on, so nothing from that time can become a
 * line after it is turned on. Pats while off start no run (and end one nobody settled); a label seen while off is simply known,
 * never "a change" later. A run that began while on is settled into its line when the switch is turned off (`holdBack`), before
 * the "体验记录关闭" line. Her mood itself is never touched here: only what is written.
 */
export class MoodJournal {
  private touch: PendingTouch | null = null;
  private readonly views = new Map<string, ViewState>();
  constructor(private readonly sink: JournalSink, private readonly clock: () => number = Date.now) {
    try { sink.holdBack?.({ settle: () => this.flushTouch() }); } catch { /* A sink without the switch hook. */ }
  }

  private accepting(): boolean { try { return this.sink.accepting ? this.sink.accepting() === true : true; } catch { return false; } }

  event(event: MoodJournalEvent): void {
    try {
      if (!this.accepting()) { this.touch = null; return; }
      const now = this.clock(), source = moodEventSource(event.type, event.reason);
      if (source === 'touch') {
        const pending = this.touch;
        if (pending && pending.characterId === event.characterId && now - pending.lastAt <= TOUCH_GAP_MS) {
          pending.after = { ...event.after }; pending.labelAfter = event.labelAfter; pending.count++;
          pending.durationMs += Math.max(0, event.effectiveMs ?? 0); pending.lastAt = now;
          return;
        }
        this.flushTouch();
        this.touch = { characterId: event.characterId, before: { ...event.before }, after: { ...event.after }, labelBefore: event.labelBefore,
          labelAfter: event.labelAfter, count: 1, durationMs: Math.max(0, event.effectiveMs ?? 0), lastAt: now };
        return;
      }
      this.flushTouch();
      // I-027 心情调整员: its correction is its own line, with the closed why its fixed reason names (never haiku's words).
      const judged = event.type === 'lift' ? moodJudgeWhyOf(event.reason) : null;
      if (judged) {
        safely(this.sink, { type: 'mood-judge', characterId: event.characterId, why: judged, before: event.before, after: event.after,
          labelBefore: event.labelBefore, labelAfter: event.labelAfter });
        return;
      }
      safely(this.sink, { type: 'mood-event', characterId: event.characterId, source, ...(event.type === 'appraisal' && event.context ? { context: event.context } : {}),
        before: event.before, after: event.after, labelBefore: event.labelBefore, labelAfter: event.labelAfter });
    } catch { /* Never blocks a mood event. */ }
  }

  /** The pats so far, as one line (also on quit, and once the pats paused). */
  flushTouch(): void {
    const pending = this.touch;
    this.touch = null;
    if (!pending) return;
    safely(this.sink, { type: 'mood-event', characterId: pending.characterId, source: 'touch', before: pending.before, after: pending.after,
      labelBefore: pending.labelBefore, labelAfter: pending.labelAfter, count: pending.count, durationMs: pending.durationMs });
  }

  /** Every published MoodView (about once a second). */
  view(view: MoodView): void {
    try {
      const now = this.clock(), on = this.accepting();
      if (!on) this.touch = null;
      else if (this.touch && now - this.touch.lastAt > TOUCH_GAP_MS) this.flushTouch();
      const id = view.characterId;
      if (!id || !view.snapshot) return;
      const label = view.snapshot.primary;
      const boredom = boredomLevel(view.snapshot.boredom, view.parameters.boredom);
      const longing = longingLevel(view.snapshot.longing, view.parameters.longing);
      const phase = view.fatigue?.phase;
      const sleeping = phase ? phase === 'asleep' || phase === 'micro-awake' : null;
      const state = this.views.get(id);
      if (!state) {
        this.views.set(id, { label, candidate: null, since: now, boredom, longing, sleeping });
        // She may have missed the user while the app was closed: that is worth a line at the first look.
        if (longing !== 'none') safely(this.sink, { type: 'longing', characterId: id, level: longing, value: view.snapshot.longing, atStart: true });
        return;
      }
      if (!on || label === state.label) { state.label = label; state.candidate = null; }
      else if (state.candidate !== label) { state.candidate = label; state.since = now; }
      else if (now - state.since >= LABEL_STABLE_MS) {
        safely(this.sink, { type: 'mood-label', characterId: id, from: state.label, to: label });
        state.label = label; state.candidate = null;
      }
      if (BOREDOM_ORDER.indexOf(boredom) > BOREDOM_ORDER.indexOf(state.boredom) || (boredom === 'none' && state.boredom !== 'none'))
        safely(this.sink, { type: 'boredom', characterId: id, level: boredom, value: view.snapshot.boredom });
      state.boredom = boredom;
      if (LONGING_ORDER.indexOf(longing) > LONGING_ORDER.indexOf(state.longing) || (longing === 'none' && state.longing !== 'none'))
        safely(this.sink, { type: 'longing', characterId: id, level: longing, value: view.snapshot.longing });
      state.longing = longing;
      if (sleeping !== null && state.sleeping !== null && sleeping !== state.sleeping && phase)
        safely(this.sink, { type: 'sleep', characterId: id, event: sleeping ? 'asleep' : 'awake', phase });
      if (sleeping !== null) state.sleeping = sleeping;
    } catch { /* Never blocks a view. */ }
  }
}

// ---------------------------------------------------------------- the other hosts' callbacks

export function herLifeInput(characterId: string, entry: { from: HerLifeActivity; to: HerLifeActivity; at: number; until: number | null }, test = false): JournalInput {
  const minutes = entry.until === null ? null : Math.max(0, Math.round((entry.until - entry.at) / 60_000));
  return { type: 'her-life', characterId, from: entry.from, to: entry.to, untilMinutes: minutes, ...(test ? { test: true } : {}) };
}

export function herNeedInput(characterId: string, event: Pick<HerNeedEvent, 'type' | 'id' | 'via' | 'snubbed' | 'dejection'>): JournalInput {
  return { type: 'her-need', characterId, event: event.type, need: event.id, ...(event.via ? { via: event.via } : {}),
    ...(event.snubbed ? { snubbed: true } : {}), ...(typeof event.dejection === 'number' ? { dejection: event.dejection } : {}) };
}
export function herNeedReliefInput(characterId: string, relief: number): JournalInput {
  return { type: 'her-need', characterId, event: 'relieved', need: null, relief };
}

export function userStateInput(characterId: string, entry: { state: UserStateKind; confidence: number }): JournalInput {
  return { type: 'user-state', characterId, state: entry.state, confidence: entry.confidence };
}

export function relationshipInput(characterId: string, entry: RelationshipDiagnostic): JournalInput {
  return { type: 'relationship', characterId, kind: entry.kind, dayNumber: entry.dayNumber, togetherDays: entry.togetherDays,
    qualityDays: entry.qualityDays, ...(entry.stage ? { stage: entry.stage } : {}) };
}

export function innerLoopInput(characterId: string, entry: InnerLoopDiagnostic): JournalInput {
  return { type: 'inner-loop', characterId, cue: entry.cue, decision: entry.decision, result: entry.result, called: entry.called,
    quiet: entry.quiet, ...(entry.restReminder ? { restReminder: true } : {}) };
}

// ---------------------------------------------------------------- character cards

/** What the journal compares between two card states. Hashes stay in memory; no name, path or text is ever written. */
function cardDigest(card: CharacterCardState['cards'][number]): { content: string; model: string } {
  const { modelPath, modelName, ...rest } = card as typeof card & { modelPath?: string };
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  return { content: hash(JSON.stringify(rest)), model: hash(JSON.stringify([modelPath ?? null, modelName ?? null])) };
}

/** Card activation, edits and model links, from the card state after each change (main.ts syncCharacter). */
export class CharacterJournal {
  private known: Map<string, { content: string; model: string; linked: boolean }> | null = null;
  private activeId = '';
  constructor(private readonly sink: JournalSink) {}

  observe(state: Pick<CharacterCardState, 'cards' | 'activeId'> | null | undefined): void {
    try {
      if (!state || !Array.isArray(state.cards)) return;
      const next = new Map(state.cards.map(card => {
        const digest = cardDigest(card);
        return [card.id, { ...digest, linked: !!((card as { modelPath?: string }).modelPath || card.modelName) }];
      }));
      const previous = this.known;
      this.known = next;
      const activeChanged = this.activeId !== state.activeId;
      const before = this.activeId;
      this.activeId = state.activeId;
      if (!previous) return; // The first look only learns the cards.
      for (const [id, card] of next) {
        const old = previous.get(id);
        if (!old) { safely(this.sink, { type: 'character', characterId: id, event: 'add' }); continue; }
        if (old.content !== card.content) safely(this.sink, { type: 'character', characterId: id, event: 'update' });
        if (old.model !== card.model) safely(this.sink, { type: 'character', characterId: id, event: 'model-link', linked: card.linked });
      }
      for (const id of previous.keys()) if (!next.has(id)) safely(this.sink, { type: 'character', characterId: id, event: 'remove' });
      if (activeChanged && before !== state.activeId && state.activeId) safely(this.sink, { type: 'character', characterId: state.activeId, event: 'activate' });
    } catch { /* Never blocks a card change. */ }
  }
}

/** P1 第二阶段 (electron/pose-reactions/host.ts): one category line; shared/journal.ts checks it again. */
export function poseInput(characterId: string, event: PoseJournalEvent, kind: PoseFollowKind | null): JournalInput {
  return { type: 'pose', characterId, event, kind: event === 'follow' || event === 'pass' || event === 'pause' ? kind : null };
}
