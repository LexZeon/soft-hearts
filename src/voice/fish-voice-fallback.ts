import type { TtsConfig } from '../../shared/foundation/tts-config';
import { fishBudgetExhausted, validFishBudgetView, type FishBudgetView } from '../../shared/voice/fish-voice';

/**
 * I-070: when this month's Drama 3 limit is used up, a window reads in the system voice instead — no error, no lost words —
 * until the month changes or the user raises the limit. The switch only happens while this window is not reading, so a
 * reply that started in Drama 3 finishes in Drama 3 (the host lets that reply's later sentences through) and a reply that
 * started in the system voice finishes in it. The settings page keeps showing the user's own choice (Drama 3).
 */
export class FishVoiceFallback {
  private budget: FishBudgetView | null = null;
  private latched = false;
  private idle = true;
  constructor(private readonly now: () => Date = () => new Date()) {}

  /** A view from the host (startup read or a 'desk:tts-budget' push); anything malformed is ignored. */
  update(value: unknown): FishBudgetView | null {
    const view = validFishBudgetView(value);
    if (view) this.budget = view;
    return view;
  }
  view(): FishBudgetView | null { return this.budget ? { ...this.budget } : null; }

  /** The reading's lifecycle: idle/error means nothing is being read in this window. */
  playback(phase: string | undefined): void { this.idle = phase === 'idle' || phase === 'error' || phase === undefined; }

  /** Is this month's limit used up for this config (whatever this window is reading right now)? */
  exhausted(config: Pick<TtsConfig, 'provider' | 'fishMonthlyCapUsd'>): boolean {
    return config.provider === 'fish' && fishBudgetExhausted(this.budget, config.fishMonthlyCapUsd, this.now());
  }

  /** The config the window reads with: the user's own, or the system voice while Drama 3's month is used up. */
  speaking(config: TtsConfig): TtsConfig {
    if (this.idle) this.latched = this.exhausted(config);
    return this.latched && config.provider === 'fish' ? { ...config, provider: 'system' } : config;
  }
}
