// 2026-11-23 the paid prewarm step:
// on the triggers 'start' (the app is ready) and 'switch' (another character comes on stage) only, once the free spare process is up, do what
// I-134 does before a budget restart (docs/claude/2026-11-15-prewarm-restart.md): compose the prepared opening from this moment's window
// (persona, relationship lines, her note, the window; no turn content, no current message) and send it once as a hidden request from a
// throwaway process that borrows the spare's folder, so Claude's prompt cache holds the opening. The first turn on that spare then sends
// two blocks: block 1 the cached opening, block 2 the usual new-turn content.
//
// What the hidden request carries is the opening and nothing else (the user's own wording allowed one short neutral line; none is sent, so
// nothing is ever made up for the user). Its output is dropped at the model's first output (warmOpening). It is never shown, archived, read
// aloud, counted as a turn, and never reaches mood or familiarity: it does not go through stream(), has no reply id, no timing, no
// availability and nothing of it is written into the session's record. A deleted or changed context drops it with everything else.
import type { ChatMessage } from '../../../shared/foundation/chat';
import type { RelaxedChat, OpeningMemory } from '../i139-chat';
import { claudeInput } from '../claude';
import type { ClaudeChatProcess } from '../claude-process';
import { composePreparedOpening, planSessionTurn, type SessionTurnPlan } from '../claude-session-prompt';
import { warmOpening, type SessionRestartEntry } from './prewarm';

type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };

/** The triggers that may warm: the ones after which a message is likely to come soon. */
export const START_WARM_WHYS = ['start', 'switch'] as const;
export type StartWarmWhy = (typeof START_WARM_WHYS)[number];
export const warmsOnStart = (why: string | undefined): why is StartWarmWhy => why === 'start' || why === 'switch';

/** What the host gives for this moment: the fixed parts of the opening and her archive's window (no turn, no current message). */
export interface StartOpeningInput {
  basePersona: string;
  openingContext: string | null;
  openingNote: string | null;
  relaxed?: RelaxedChat | null;
  openingMemory?: OpeningMemory;
  history: readonly ChatMessage[];
}

export interface StartWarmDeps {
  /** The host's opening for the character on stage; null: nothing to warm. Read when a warm begins. */
  input(): StartOpeningInput | null | undefined;
  /** At least this long between two warms of this character (the user's usage); 0 or less: never warm. */
  minGapMs(): number;
  /** A throwaway process in the spare's folder (PersistentClaudeChat.start). */
  startWarmer(model: string, directory: string): Promise<ClaudeChatProcess>;
  /** A reply is streaming, a call is on or the chat is gone: nothing is warmed. */
  blocked(): boolean;
  now(): number;
  timers: Timers;
  timeoutMs?: number;
  log?(line: string): void;
}

type Status = SessionRestartEntry['warm'];

interface Warm {
  process: ClaudeChatProcess;
  why: StartWarmWhy;
  opening: string;
  known: ChatMessage[];
  basePersona: string;
  openingContext: string | null;
  status: Status;
  warmer: ClaudeChatProcess | null;
  dropped: boolean;
}

/** What a turn that takes the spare learns: how the warm went and, when it finished, what the turn opens with. */
export interface StartWarmAdoption {
  why: StartWarmWhy;
  status: Status;
  /** Set when the warm finished and still fits this turn: the cached opening, the window it holds, the turn's plan after it. */
  use?: { opening: string; known: ChatMessage[]; plan: SessionTurnPlan; openingContext: string | null };
}

export class StartWarmer {
  private warm: Warm | null = null;
  /** When the last warm of this character was sent (the dedupe). */
  private lastBeganAt: number | null = null;

  constructor(private readonly deps: StartWarmDeps) {}

  /**
   * `spare` is up and blank. Starts the warm unless it was done lately, a reply streams, a call is on, or this spare is already
   * warm or warming (a newer trigger for the same spare finds the same pending request, which is what it would send).
   */
  begin(why: string | undefined, spare: ClaudeChatProcess): void {
    if (!warmsOnStart(why)) return;
    const gap = this.deps.minGapMs();
    if (!(gap > 0) || this.deps.blocked() || !spare.alive || spare.turnsStarted) return;
    if (this.warm && this.warm.process === spare && !this.warm.dropped) return;
    if (this.lastBeganAt !== null && this.deps.now() - this.lastBeganAt < gap) return;
    let input: StartOpeningInput | null | undefined;
    try { input = this.deps.input(); } catch { input = null; }
    if (!input?.basePersona) return;
    const known = input.history.map(message => ({ role: message.role, content: message.content }));
    let opening: string;
    try { opening = composePreparedOpening({ basePersona: input.basePersona, openingContext: input.openingContext, openingNote: input.openingNote, history: known,
      ...(input.relaxed ? { relaxed: input.relaxed } : {}), ...(input.openingMemory ? { openingMemory: input.openingMemory } : {}) });
      claudeInput({ prompt: opening }); }
    catch { return; } // Too long: no warm.
    this.cancel(); // an older pending warm (another spare) is dropped; its process closes
    const warm: Warm = { process: spare, why, opening, known, basePersona: input.basePersona, openingContext: input.openingContext, status: 'none', warmer: null, dropped: false };
    this.warm = warm;
    this.lastBeganAt = this.deps.now();
    void this.run(warm, spare);
  }

  private async run(warm: Warm, spare: ClaudeChatProcess): Promise<void> {
    let warmer: ClaudeChatProcess | null = null;
    try { warmer = await this.deps.startWarmer(spare.model, spare.folder); } catch { warmer = null; }
    // Dropped while the process started, or a reply or a call began meanwhile: nothing is sent.
    if (!warmer || warm.dropped || this.deps.blocked() || !spare.alive || spare.turnsStarted) {
      warmer?.close('closed');
      if (!warm.dropped && this.warm === warm) { warm.status = 'failed'; }
      return;
    }
    warm.status = 'warming';
    warm.warmer = warmer;
    const ok = await warmOpening(warmer, warm.opening, this.deps.timers, this.deps.timeoutMs);
    warm.warmer = null;
    if (warm.status === 'warming') warm.status = ok ? 'warmed' : 'failed';
    this.deps.log?.(`start warm ${warm.why}: ${warm.status}`);
  }

  /**
   * Forget the warm: its hidden request stops, its throwaway process closes, nothing of its window stays in memory. `pendingOnly`: only
   * one that has not finished (she switched away: a finished warm still serves the spare when she comes back).
   */
  cancel(pendingOnly = false): void {
    const warm = this.warm;
    if (!warm || (pendingOnly && (warm.status === 'warmed' || warm.status === 'failed'))) return;
    this.warm = null;
    warm.dropped = true;
    warm.warmer?.close('closed');
    warm.warmer = null;
  }

  /**
   * A turn takes `process` (the spare). When a warm was made for it: still warming (the user wrote first) the request is stopped and the
   * turn goes on as today (status stays 'warming'); finished, the turn opens with the cached opening when its persona is the same and its
   * window lines up (the turn's lines of relationship stay in its own block when they differ from the warmed ones, so none is lost).
   */
  adopt(process: ClaudeChatProcess, input: { basePersona: string; openingContext?: string | null }, history: readonly ChatMessage[]): StartWarmAdoption | null {
    const warm = this.warm;
    this.cancel(); // whoever takes a process ends the warm: a turn that takes another one leaves it no use
    if (!warm || warm.process !== process) return null;
    const status = warm.status;
    const result: StartWarmAdoption = { why: warm.why, status };
    if (status !== 'warmed' || warm.basePersona !== input.basePersona) return result;
    const plan = warm.known.length ? planSessionTurn(warm.known, history) : { opening: false, history: [...history] };
    if (!plan) return result;
    result.use = { opening: warm.opening, known: warm.known, plan, openingContext: warm.openingContext === (input.openingContext ?? null) ? warm.openingContext : null };
    return result;
  }
}
