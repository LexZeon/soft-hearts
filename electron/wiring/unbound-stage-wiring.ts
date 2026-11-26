// I-209 step 3 (docs/claude/2026-11-24-i209-step3-instances.md): what each other character on the full-screen stage reads as her own and writes
// as hers, given to the stage coordinator (electron/unbound/company/stage.ts) by unbound-wiring's startUnbound. Her mood is her live view
// (CompanionService.moodOf, step 2's StageMoods); her close moments read her own stage and write her own journal rows; the mood moments, the
// interaction history and the touch brain stay the desktop companion's (step 5 gives each one her own). No module-level side effects.
import { MAIN_KEY, type CloseBeatSequence, type CompanyStage, type StageCharacterWiring, type UnboundHost } from '../unbound';
import { StageTouchMood } from '../mood';
import type { UnboundNeeds } from './unbound-wiring';

/** The host of `owner` when she is someone else out on stage (null: nobody, the first one, or not out): her turn reads her own place. */
export function stageHostOf(stage: CompanyStage | null, owner: string | null | undefined): UnboundHost | null {
  if (!stage || !owner || owner === MAIN_KEY || !stage.keys().includes(owner)) return null;
  return stage.hostOf(owner);
}

/** What her close moments read of you and the stage (you typing into the box now, whether she is being pulled), and her page's relay. */
export interface StageReads { typing(): boolean; pulled(id: string): boolean; relay(id: string, channel: string, value: unknown): void; /** I-209 step 4: the user's music settings (null before loaded). */ musicSettings?(): unknown }

/** Each other character's own readings and writes. `needs` and `sequence` are read when used. */
export function stageCharacters(needs: () => UnboundNeeds, sequence: () => CloseBeatSequence, reads: StageReads): StageCharacterWiring {
  const view = (id: string) => { try { return needs().companion.moodOf(id); } catch { return null; } };
  const journal = (row: Record<string, unknown> & { type: string }, id: string) => { try { needs().appJournal.record({ ...row, characterId: id } as never); } catch { /* the journal never blocks her */ } };
  // Her live mood (step 2's StageMoods, once a second) goes to her own page, as the first one's goes to hers.
  try { needs().companion?.stageMoods?.onView(view => reads.relay(view.characterId, 'desk:mood', view)); } catch { /* no mood yet: her page reads it when it loads */ }
  // I-209 step 4: a pat, a pinch or a pull on her moves HER mood as the first one's touches move hers (electron/mood/stage-touch.ts).
  const touch = new StageTouchMood({ event: (event, id) => needs().companion.mood.event(event, id), lift: (lift, id) => needs().companion.mood.lift(lift, id), view, clock: () => Date.now() });
  return {
    mood: id => ({
      get: () => view(id),
      interaction: value => touch.interaction(id, value),
      // The song is detected once (perceive once): its frames and settings reach her page too (unbound-senses-wiring.ts relayStageMusic); her
      // own page decides whether she dances, nods or stays still. Pose sensing is measured against one window, so she gets none of it.
      senses: () => ({ poseSensing: () => false, fact: () => false, musicSettings: () => reads.musicSettings?.() ?? null }),
    }),
    peekMood: id => view(id),
    pull: (id, report) => { touch.pulled(id, report); },
    close: id => ({
      view: () => view(id) as never,
      typing: () => reads.typing(), playing: () => false, pulling: () => reads.pulled(id),
      moment: kind => { try { return needs().companion.mood.moments.note(kind, id); } catch { return false; } }, happened: () => {}, // I-209 step 4: her kiss / hug moves her own mood
      notes: {
        missed: () => {}, // 2026-11-25: its journal row is `outcome` (one per kiss / hug she wrote)
        outcome: fate => journal({ type: 'close-beat', ...fate }, id),
        notReached: kind => journal({ type: 'close-beat-skipped', kind, block: 'unreached' }, id),
        interrupted: (action, by) => journal({ type: 'action-interrupted', action, by }, id),
      },
      sequence: sequence(),
    }),
    journal: (id, row) => journal(row as never, id),
    frames: (id, row) => { try { needs().appJournal.record({ type: 'frame-time', characterId: id, ...row }); } catch { /* the journal never blocks her */ } },
    mouth: (id, sentences) => { if (id) try { needs().appJournal.record({ type: 'mouth-reading', characterId: id, sentences } as never); } catch { /* the journal never blocks her */ } }, // 2026-11-25: checked by the journal (closed words, numbers)
  };
}
