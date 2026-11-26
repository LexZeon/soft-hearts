// I-089 item 1 「回忆有轻重」 (docs/claude/2026-11-12-i089-items-4-1.md). When several memories all match what the user just said, which
// one mattered more to her goes first: the user brought it up again and again, it came with strong feeling, it is a plan not yet done.
// Pure: no clock, no I/O. This only orders candidates the literal and note matching already admitted (memory.ts retrieve): it never
// makes a memory match, never shows one that did not, and for a memory with no note, no feeling mark and the starting weight it is 0
// (so an old memory orders exactly as before).

import type { MemoryNoteTraits } from './interface';
import { MEMORY_NOTES_KNOBS, type MemoryNotesKnobs } from './knobs';

const clamp01 = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
const DAY = 86_400_000;

export interface MatterInput {
  /** The record's weight now (shared/memory/memory.ts memoryWeightAt: it rises when the user recalls it and eases back over a month). */
  weight: number;
  /** MemoryConfig.baseWeight: no reinforcement at all. */
  baseWeight: number;
  traits: MemoryNoteTraits | null;
  now: number;
}

/**
 * 0..1: how much it mattered. The three reasons combine as "any strong one lifts it" (1 - Π(1 - part)), not as shares of a total:
 *  - repeated: the weight above the starting one, as a share of knobs.matter.weightFull;
 *  - felt: the feeling she rated when she wrote the note (0..3), easing with the note's age, slower the stronger it was;
 *  - open plan: a plan not done yet, for knobs.matter.planDays after the talk.
 */
export function recallMatter(input: MatterInput, knobs: MemoryNotesKnobs = MEMORY_NOTES_KNOBS): number {
  const k = knobs.matter;
  const repeated = clamp01((input.weight - input.baseWeight) / Math.max(1, k.weightFull));
  let felt = 0, plan = 0;
  const t = input.traits;
  if (t) {
    const ageDays = Math.max(0, (input.now - t.at) / DAY);
    if (t.felt !== null && t.felt > 0) felt = (t.felt / 3) * Math.pow(2, -ageDays / (Math.max(1, k.feltHalfLifeDays) * (1 + t.felt / 2)));
    if (t.openPlans && ageDays <= k.planDays) plan = clamp01(k.planPart);
  }
  return clamp01(1 - (1 - repeated) * (1 - felt) * (1 - plan));
}

/** The ordering bonus (0..knobs.matter.maxBonus). */
export const matterBonus = (matter: number, knobs: MemoryNotesKnobs = MEMORY_NOTES_KNOBS): number => clamp01(matter) * Math.max(0, knobs.matter.maxBonus);

/**
 * What she just recalled stays out of the front for a few of the user's next lines. Counts a "turn" per distinct user text (a recall
 * made again for the same message, as when the notes changed mid-turn, is the same turn). Memory only, never saved.
 */
export class RecallCooldown {
  private turn = 0;
  private lastText: string | null = null;
  private readonly shown = new Map<string, number>();
  constructor(private readonly cap = 256) {}

  /** The user said something: moves on a turn when it is not the same text as the last call. */
  begin(text: string): void {
    if (text !== this.lastText) { this.turn++; this.lastText = text; }
  }
  /** Is this record still cooling after being recalled? */
  cooling(recordId: string, knobs: MemoryNotesKnobs = MEMORY_NOTES_KNOBS): boolean {
    const at = this.shown.get(recordId);
    return at !== undefined && this.turn - at > 0 && this.turn - at <= knobs.matter.cooldownTurns;
  }
  /** These records were handed to her this turn. */
  shownNow(recordIds: Iterable<string>): void {
    for (const id of recordIds) { this.shown.delete(id); this.shown.set(id, this.turn); }
    while (this.shown.size > this.cap) this.shown.delete(this.shown.keys().next().value!);
  }
  forget(recordIds: Iterable<string>): void { for (const id of recordIds) this.shown.delete(id); }
}
