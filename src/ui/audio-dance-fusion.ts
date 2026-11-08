import type { AudioDanceSample } from '../../shared/audio-dance';
import type { AudioReadingSource } from '../../shared/audio-reading-toggles';

const sources: AudioReadingSource[] = ['system-audio', 'microphone'];
type Entry = { sample: AudioDanceSample; receivedAt: number };

/** Select one complete spectrum with hysteresis, never add two copies of a song.
 * Freshness uses this renderer's clock, not another window's performance epoch.
 */
export class AudioDanceFusion {
  private entries: Partial<Record<AudioReadingSource, Entry>> = {};
  private selected: AudioReadingSource | null = null;
  private challenger: AudioReadingSource | null = null;
  private challengerSince = 0;
  private lastOutputAt = -Infinity;

  clear(source?: AudioReadingSource): void {
    if (source) delete this.entries[source]; else this.entries = {};
    if (!source || this.selected === source) this.selected = null;
    if (!source || this.challenger === source) this.challenger = null;
  }
  push(source: AudioReadingSource, sample: AudioDanceSample, receivedAt: number): void {
    if (!sources.includes(source) || !Number.isFinite(receivedAt) || receivedAt < 0) return;
    this.entries[source] = { sample: { ...sample }, receivedAt };
  }
  read(now: number): { sample: AudioDanceSample; source: AudioReadingSource } | null {
    if (!Number.isFinite(now) || now < 0) return null;
    const fresh = sources.filter(source => {
      const age = now - (this.entries[source]?.receivedAt ?? -Infinity);
      return age >= 0 && age <= 250;
    });
    if (!fresh.length) { this.selected = this.challenger = null; return null; }
    const energy = (source: AudioReadingSource) => this.entries[source]!.sample.rms;
    const strongest = fresh.reduce((best, source) => energy(source) > energy(best) ? source : best);
    if (!this.selected || !fresh.includes(this.selected)) { this.selected = strongest; this.challenger = null; }
    else if (strongest !== this.selected && energy(strongest) > Math.max(0.003, energy(this.selected) * 1.5)) {
      if (this.challenger !== strongest) { this.challenger = strongest; this.challengerSince = now; }
      else if (now - this.challengerSince >= 300) { this.selected = strongest; this.challenger = null; }
    } else this.challenger = null;
    // Both streams can deliver in the same render turn; one Stage sample/30Hz.
    if (now - this.lastOutputAt < 1000 / 30) return null;
    this.lastOutputAt = now;
    return { source: this.selected, sample: { ...this.entries[this.selected]!.sample, time: now / 1000 } };
  }
}
