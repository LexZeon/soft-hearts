/**
 * I-209 step 2: a live mood for every character on the
 * full-screen stage, not only the active one. The active one keeps MoodHost's own view (get(), the one-second tick, the windows); each
 * other one on stage has her own profile moved on every tick as online (she is there with you), so a turn of hers reads her mood now
 * (MoodHost.chatContext({ characterId })) and an event for her lands on a mood that kept time.
 *
 * Who is on stage comes from the brain's turn owners (CompanionService.stage, fed by step 1's presence). Nobody shows these views yet:
 * `onView` is the seam for step 3's per-character UI (her own bubble, her own panel). With nobody else on stage nothing here runs.
 */
import type { MoodParameters } from '../../shared/foundation/mood';
import type { LiveMood } from './mood';

/** What StageMoods needs of MoodHost. */
export interface StageMoodHost {
  readonly activeCharacterId: string;
  liveOf(characterId: string, advance?: { online: boolean }): LiveMood | null;
  ensure(characterId: string, value?: MoodParameters): void;
  setStageSource(source: (characterId: string) => boolean): void;
}

/** A tick further apart than this (a suspended app, a long pause) moves her on as offline, as MoodHost.refresh does for the active one. */
export const STAGE_MOOD_ONLINE_GAP_MS = 5_000;

export class StageMoods {
  private present: string[] = [];
  private readonly lastTick = new Map<string, number>();
  private readonly listeners = new Set<(view: LiveMood) => void>();
  private templateFor: (characterId: string) => MoodParameters | undefined = () => undefined;

  constructor(private readonly host: StageMoodHost, private readonly clock: () => number = Date.now) {
    host.setStageSource(id => this.present.includes(id));
  }

  /** Her card's mood template, for a character who comes on stage without a profile (the wiring reads the card store). */
  setTemplateSource(source: (characterId: string) => MoodParameters | undefined): void { this.templateFor = source; }

  /** Who is on stage besides the active one now (in the order they came). */
  set(ids: readonly string[]): void {
    const next = [...new Set(ids)].filter(id => id && id !== this.host.activeCharacterId);
    for (const id of next) if (!this.present.includes(id)) {
      let template: MoodParameters | undefined;
      try { template = this.templateFor(id); } catch { template = undefined; }
      try { this.host.ensure(id, template); } catch { /* she simply has no live mood yet */ }
    }
    for (const id of this.present) if (!next.includes(id)) this.lastTick.delete(id);
    this.present = next;
  }

  ids(): string[] { return [...this.present]; }

  /** The one-second tick (after MoodHost.tick): each one on stage moves on, online when the last tick was recent; listeners hear her view. */
  tick(): void {
    const now = this.clock();
    for (const id of this.present) {
      if (id === this.host.activeCharacterId) continue; // became the active one: MoodHost keeps her time now
      const last = this.lastTick.get(id);
      const online = last !== undefined && now - last >= 0 && now - last <= STAGE_MOOD_ONLINE_GAP_MS;
      this.lastTick.set(id, now);
      let view: LiveMood | null = null;
      try { view = this.host.liveOf(id, { online }); } catch { view = null; }
      if (view) for (const listener of [...this.listeners]) { try { listener(view); } catch { /* a view never stops her time */ } }
    }
  }

  /** Her live mood now (the active one's too), or null. */
  view(characterId: string): LiveMood | null {
    try { return this.host.liveOf(characterId); } catch { return null; }
  }

  /** Step 3's seam: each tick's view of everyone on stage besides the active one. */
  onView(listener: (view: LiveMood) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
