/**
 * I-117 for the app: the local reading of each message, the reaction judge's closed field, the card in both windows, and the private
 * lines for her turn. Memory only; it keeps closed flags and times, never the user's words, and sends nothing anywhere.
 *
 * IPC (shared/safety/card.ts): getSafetyCard (either window: the card as it is now, for a window that opens later) and
 * safetyCardAnswer (either window: 「我现在安全」 or 「关闭」 for the card on screen). The channel desk:safety-card tells both windows.
 * Record: docs/claude/2026-11-13-i117-safety-card.md.
 */
import { detectDanger, type DangerLevel } from '../../shared/safety/detect';
import { resolveCrisisRegion, systemCrisisRegion, type CrisisRegion } from '../../shared/safety/crisis-lines';
import { SafetyState, SAFETY_KNOBS, type SafetyKnobs, type YieldReason } from '../../shared/safety/state';
import { CLOSED_SAFETY_CARD, readSafetyCardAnswer, type SafetyCardView } from '../../shared/safety/card';
import type { ReactionSafetyPort } from '../mood';

type Register = (method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly?: boolean) => void;

export interface SafetyWiring {
  /** The setting 「所在地区（求助信息用）」 (AppSettings.crisisRegion; absent: 'auto'). */
  region(): unknown;
  /** desk:safety-card to both windows. */
  broadcast(view: SafetyCardView): void;
  clock?(): number;
  /** Tests: the system's guess for 'auto'. */
  guess?(): CrisisRegion;
  knobs?: SafetyKnobs;
  night?(now: number): string;
}

/** What electron/brain/companion.ts asks on each message (CompanionSafetyPort). */
export interface SafetyChatPort {
  /** Reads this message (nothing kept), may show the card, and returns this turn's private lines ('' for none). */
  turn(id: string, text: string, realer: boolean): string;
  /** Reads a message without taking any line (a voice group's spoken sentence). */
  read(id: string, text: string): void;
}

export function createSafety(wiring: SafetyWiring) {
  const clock = () => { try { return wiring.clock?.() ?? Date.now(); } catch { return Date.now(); } };
  const state = new SafetyState(wiring.knobs ?? SAFETY_KNOBS, wiring.night);
  let view: SafetyCardView = CLOSED_SAFETY_CARD;
  let shown = 0;
  const region = (): CrisisRegion => { try { return resolveCrisisRegion(wiring.region(), wiring.guess ?? systemCrisisRegion); } catch { return 'other'; } };
  const tell = () => { try { wiring.broadcast(view); } catch { /* a window that is gone */ } };
  const note = (id: string, level: DangerLevel, tired: boolean, source: 'local' | 'judge') => {
    const { show } = state.note({ turnId: id, level, tired, source }, clock());
    if (!show) return;
    view = { open: true, id: `card-${++shown}`, region: region() };
    tell();
  };
  const chat: SafetyChatPort = {
    turn: (id, text, realer) => {
      try {
        const reading = detectDanger(text);
        note(id, reading.level, reading.tired, 'local');
        return state.turn(clock(), realer).join('\n');
      } catch { return ''; }
    },
    read: (id, text) => {
      try { const reading = detectDanger(text); note(id, reading.level, reading.tired, 'local'); } catch { /* never blocks her */ }
    },
  };
  const reactionPort: ReactionSafetyPort = {
    answer: (id, level) => { if (level === 'early' || level === 'clear') { try { note(id, level, false, 'judge'); } catch { /* never blocks a reaction */ } } },
  };
  const answer = (value: unknown): SafetyCardView => {
    const input = readSafetyCardAnswer(value);
    if (!input || !view.open || input.id !== view.id) return view;
    state.answer(input.answer, clock());
    view = { ...view, open: false };
    tell();
    return view;
  };
  return {
    chat,
    reactionPort,
    answer,
    /** 更真实的情绪 yields now (the inner loop's rule and the chat's per-turn line). */
    yielding: (): YieldReason | null => { try { return state.yielding(clock()); } catch { return null; } },
    view: (): SafetyCardView => view,
    /** Closed facts for diagnostics and tests. */
    stateView: () => state.view(clock()),
    register(scopedHost: Register): void {
      scopedHost('getSafetyCard', () => view, false);
      scopedHost('safetyCardAnswer', (_sender, value) => answer(value), false);
    },
  };
}
export type SafetyHost = ReturnType<typeof createSafety>;
