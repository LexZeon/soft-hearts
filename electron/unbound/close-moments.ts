/**
 * I-184 (docs/claude/2026-11-22-i184-unbound-kiss.md): the host side of her close moments in full-screen Unbound (凑近看、亲亲、抱抱; one
 * family). All local: no Claude call, no new sense, no new permission.
 *
 *  - Her own: the peek host (peek.ts) asks `own` when it is about to come up to the lens anyway (its idle wait, its pace, the arbiter's
 *    turn): a kiss or a hug this time, or null (the look, as before). Rare: the chooser's share, a day's cap, a cooldown.
 *  - Pulled close: the peek host asks `pulled` when you let her go at the nearest after holding her there (CLOSE_MOMENT_KNOBS.pullHoldMs):
 *    look (the peek as before), kiss, hug, shy back a step, or nothing. One decision per let-go; a kiss or a hug starts a cooldown.
 *  - It happened (the page reached its hold): the mood moment 'kiss' / 'hug' (its own family's cooldown and day count; the journal's
 *    'moment-kiss' / 'moment-hug' row comes with it), the record that caps the next ones, and one fact sentence for her next chat turn.
 * Memory only: a restart starts the counts again (as the mood moments' own gate).
 */
import {
  CLOSE_MOMENT_KNOBS, CloseMomentHistory, chatCloseBlock, chooseAfterBeat, chooseCloseMoment, handYieldsTo, planCloseMoment,
  type AfterBeat, type CloseArms, type ChatCloseBlock, type CloseAct, type CloseGates, type CloseHappened, type CloseKind, type CloseMomentKnobs, type CloseMomentPlan,
  type CloseTemperament, type CloseVia,
} from '../../shared/unbound/close-moments';
import type { MoodReading } from '../../shared/unbound/director';
import { MOOD_LABEL_IDS, type MoodLabel } from '../../shared/foundation/mood';
import { momentDay } from '../../shared/foundation/mood-moments';

export interface CloseMomentPorts {
  clock(): number;
  random(): number;
  /** The local day key (default: the mood moments' own). */
  day?(now: number): string;
  /** Her mood for movement (the peek's reading). */
  mood(): MoodReading | null;
  /** The mood view's label now and the card's mood template (weights, intensity): read only. */
  view(): { snapshot?: { primary?: unknown }; parameters?: { weights?: Record<string, unknown>; intensity?: Record<string, unknown> } } | null;
  /** You are typing to her now (recent keystrokes in her small box: electron/unbound/typing.ts typingNow), not merely the box being open. */
  typing(): boolean;
  /** A game, an offer or her reach for your hand holds her arms. */
  playing(): boolean;
  /** 2026-11-25: who holds her arms (closeArmsOf); absent: as `playing` says ('game' when it holds them). */
  arms?(): CloseArms;
  /** 2026-11-25: her hand reach lets go (offered or held): a kiss / hug of hers is walking up (handYieldsTo). */
  dropHand?(): void;
  /** You are pulling her now. */
  pulling?(): boolean;
  /** The mood moment 'kiss' / 'hug'; true when applied (its own cooldown family gates it). */
  moment(kind: 'kiss' | 'hug'): boolean;
  /** One kiss or hug happened (the interaction history's turn line takes it). */
  happened?(item: CloseHappened): void;
  knobs?(): Partial<CloseMomentKnobs>;
}
/** What the peek host knows and hands in (the rest of the gates are read here). */
export interface CloseBase { shown: boolean; asleep: boolean; inCall: boolean; speaking: boolean }
/** The peek host's view of this (peek.ts PeekPorts.close). */
export interface CloseMomentsLink {
  own(base: CloseBase): 'kiss' | 'hug' | null;
  pulled(base: CloseBase, heldMs: number): CloseKind;
  /** I-185: her reply's ⟦kiss⟧ / ⟦hug⟧: why it cannot walk up now (chatCloseBlock), or null. `busy`: a peek or a moment is on. Optional: an older link answers 'lighter'. */
  chat?(base: CloseBase, kind: 'kiss' | 'hug', busy: boolean): ChatCloseBlock | null;
  plan(kind: CloseAct, via: CloseVia): CloseMomentPlan | null;
  /** 2026-11-25: a kiss or a hug is walking up now (its performance started): her hand reach lets go first. Optional: an older link does nothing. */
  started?(kind: CloseAct, via: CloseVia): void;
  /** `arms` (I-192 follow-up, Codex T-261): 'still' when her arms could not move on this model (the hug was her face coming close). */
  happened(kind: 'kiss' | 'hug', via: CloseVia, after: AfterBeat | null, arms?: 'still'): void;
}
export interface CloseMomentView { last: { via: CloseVia; kind: CloseKind; at: number } | null; done: number }

const safe = <T>(read: () => T, fallback: T): T => { try { const value = read(); return value ?? fallback; } catch { return fallback; } };
const num = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** The card's template as the chooser reads it (anything odd: neutral). */
export function temperamentOf(parameters: { weights?: Record<string, unknown>; intensity?: Record<string, unknown> } | null | undefined): CloseTemperament {
  const w = parameters?.weights ?? {}, i = parameters?.intensity ?? {};
  return { weights: { playful: num(w.playful, 1), close: num(w.close, 1), comfortable: num(w.comfortable, 1), cautious: num(w.cautious, 1) },
    intensity: { expression: num(i.expression, 50), playful: num(i.playful, 50) } };
}
export const labelOf = (value: unknown): MoodLabel | null => (MOOD_LABEL_IDS as readonly unknown[]).includes(value) ? value as MoodLabel : null;

export class CloseMomentsHost implements CloseMomentsLink {
  readonly history = new CloseMomentHistory();
  private last: CloseMomentView['last'] = null;
  private done = 0;

  constructor(private readonly ports: CloseMomentPorts) {}

  private now(): number { const value = safe(() => this.ports.clock(), Date.now()); return Number.isFinite(value) ? value : Date.now(); }
  private knobs(): CloseMomentKnobs { return { ...CLOSE_MOMENT_KNOBS, ...safe(() => this.ports.knobs?.() ?? {}, {}) }; }
  private day(now: number): string { return safe(() => this.ports.day?.(now) ?? momentDay(now), momentDay(now)); }
  private read() {
    const view = safe(() => this.ports.view(), null);
    return { mood: safe(() => this.ports.mood(), null), label: labelOf(view?.snapshot?.primary), temperament: temperamentOf(view?.parameters) };
  }
  private gates(base: CloseBase): CloseGates {
    return { ...base, typing: safe(() => this.ports.typing(), false), armsHeld: safe(() => this.ports.playing(), false), pulled: safe(() => this.ports.pulling?.() ?? false, false) };
  }
  private choose(via: CloseVia, base: CloseBase): CloseKind {
    const now = this.now(), r = this.read();
    if (!r.mood) return 'look'; // no mood reading: as before
    const choice = chooseCloseMoment({ via, now, day: this.day(now), mood: r.mood, label: r.label, temperament: r.temperament, gates: this.gates(base),
      history: this.history, knobs: this.knobs() }, safe(() => this.ports.random(), 0.5));
    this.last = { via, kind: choice.kind, at: now };
    return choice.kind;
  }

  /** The peek's slot: a kiss or a hug this time, or null (the look). */
  own(base: CloseBase): 'kiss' | 'hug' | null {
    const kind = this.choose('own', base);
    return kind === 'kiss' || kind === 'hug' ? kind : null;
  }

  /** A let-go at the nearest. Held there shorter than the knob: the look, as before (no decision). */
  pulled(base: CloseBase, heldMs: number): CloseKind {
    if (!(num(heldMs, 0) >= this.knobs().pullHoldMs)) return 'look';
    return this.choose('pulled', base);
  }

  /** I-185: her reply's kiss or hug (no chooser: she wrote it); the family's gates except "she is speaking"; never a cooldown. */
  chat(base: CloseBase, kind: 'kiss' | 'hug', busy: boolean): ChatCloseBlock | null {
    const now = this.now();
    const block = chatCloseBlock({ kind, gates: this.gates(base), busy, arms: this.arms() });
    this.last = { via: 'chat', kind: block ? 'none' : kind, at: now };
    return block;
  }

  /** 2026-11-25: who holds her arms now (her hand reach alone never blocks what she wrote). */
  private arms(): CloseArms { return safe(() => this.ports.arms?.() ?? (this.ports.playing() ? 'game' : 'free'), 'free'); }

  /** 2026-11-25: a kiss or a hug started walking up: her own hand reach lets go first (her arms come round as it goes back, never a jump). */
  started(kind: CloseAct, _via: CloseVia): void {
    if (handYieldsTo(kind, this.arms())) safe(() => { this.ports.dropHand?.(); return true; }, false);
  }

  /** The plan for an act (null without her mood). */
  plan(kind: CloseAct, via: CloseVia): CloseMomentPlan | null {
    const r = this.read();
    if (!r.mood) return null;
    const random = () => safe(() => this.ports.random(), 0.5);
    const after: AfterBeat = kind === 'shy' ? 'shy' : chooseAfterBeat({ mood: r.mood, label: r.label, temperament: r.temperament }, random());
    return planCloseMoment({ kind, after, via, mood: r.mood, label: r.label, temperament: r.temperament, knobs: this.knobs() }, random);
  }

  /** The page reached the hold: it happened (once per performance; the peek host calls it once). */
  happened(kind: 'kiss' | 'hug', via: CloseVia, after: AfterBeat | null, arms?: 'still'): void {
    const now = this.now();
    this.history.record({ kind, via, at: now, day: this.day(now) });
    this.done++;
    safe(() => this.ports.moment(kind), false);
    // I-192 follow-up: what played: a hug whose arms could not move says so (nothing claims they moved).
    safe(() => { this.ports.happened?.({ kind, via, after, at: now, ...(arms === 'still' ? { arms } : {}) }); return true; }, false);
  }

  view(): CloseMomentView { return { last: this.last ? { ...this.last } : null, done: this.done }; }
}
