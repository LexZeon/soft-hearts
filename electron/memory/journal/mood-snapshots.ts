// 体验记录 I-179: the 'mood-snapshot' line, her whole mood (D/O/E/N/C, A, B, M, the label, how tired, what she is doing in her own
// life) written once when the app starts, once when the character changes, then every five minutes while it runs. It fills the gap
// between mood changes, where the values only drift down with their half-lives, so the curve can be read back. Numbers and closed
// words only; it reads the published MoodView and changes nothing. The caller (MoodJournal.view) calls it only while the journal
// switch is on, so nothing is queued while it is off. Five minutes is a fixed value on purpose: it is a logging cadence for
// comparing against chat, not behaviour of hers.
import type { MoodView } from '../../../shared/mood';
import type { MoodNow, MoodSnapshotWhen } from '../../../shared/mood';
import type { JournalSink } from './sources';

export const MOOD_SNAPSHOT_EVERY_MS = 5 * 60_000;

/** Her whole mood in a published view (the values she shows, B and M, and A / F / the phase when the sleepiness model reports). */
export function moodNowFromView(view: Pick<MoodView, 'snapshot' | 'fatigue'>): MoodNow {
  const { snapshot, fatigue } = view;
  return { values: { ...snapshot.values }, label: snapshot.primary, B: snapshot.boredom, M: snapshot.longing,
    ...(fatigue ? { A: fatigue.A, F: fatigue.F, phase: fatigue.phase } : {}) };
}

/** A journal input as it goes to the writer; a mood-book line also carries her whole mood at that moment (`now`), when she has one. */
export function withMoodNow<T extends { type: string }>(input: T, view: Pick<MoodView, 'snapshot' | 'fatigue'>): T {
  try { return input.type === 'mood-book' && view.snapshot ? { ...input, now: moodNowFromView(view) } : input; } catch { return input; }
}

export class MoodSnapshots {
  private lastAt: number | null = null;
  private lastCharacter: string | null = null;
  constructor(private readonly sink: JournalSink, private readonly clock: () => number = Date.now) {}

  /** Every published view: writes a snapshot at the start, at a character switch and every MOOD_SNAPSHOT_EVERY_MS. */
  view(view: MoodView): void {
    try {
      const id = view.characterId;
      if (!id || !view.snapshot?.values) return;
      const now = this.clock();
      const when: MoodSnapshotWhen | null = this.lastCharacter === null ? 'start' : id !== this.lastCharacter ? 'switch'
        : this.lastAt === null || now - this.lastAt >= MOOD_SNAPSHOT_EVERY_MS ? 'tick' : null;
      if (!when) return;
      this.lastAt = now; this.lastCharacter = id;
      this.sink.record({ type: 'mood-snapshot', characterId: id, when, ...moodNowFromView(view), ...(view.herLife ? { activity: view.herLife.activity } : {}) });
    } catch { /* Keeping a record never blocks her. */ }
  }
}
