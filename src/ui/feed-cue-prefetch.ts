import type { TtsConfig } from '../../shared/tts';

/** The part of a VoiceOutput playback state the prefetch reads. */
export interface FeedCuePlaybackState {
  phase: string;
  provider?: TtsConfig['provider'];
  /** Present while a reply is being read aloud (absent for voice previews). */
  replyId?: string;
}
export interface FeedCuePrefetchOptions {
  /** FeedCuePlayer.prefetch: both clips for the current voice, no audio device, its own cache and failure back-off. */
  prefetch(): void;
  getTtsConfig(): TtsConfig | null;
  /** The read-aloud switch. */
  voiceOn(): boolean;
}

/** Everything that changes how a cue sounds (the host keys its cache the same way). */
export function feedCueVoiceKey(config: TtsConfig): string {
  return JSON.stringify([config.provider, config.apiHost, config.region, config.model, config.voice, config.rate]);
}

/**
 * B06 feeding cues ("啊～"/"嗯～"), warmed before the first feed. Bailian's
 * first audio takes ~1.2 s, longer than the "啊" may wait, so a cue fetched
 * only when the snack is picked up is usually skipped the first time.
 *
 * Once a reply starts playing aloud in the Bailian voice in this app session
 * (its first audio is already out, so the fetch never competes with it), both
 * cues are fetched in the background for that voice, once per reply. After
 * that, a new voice (voice, model, rate, or the character's voice binding)
 * while read-aloud is on is warmed right away. Nothing is asked while
 * read-aloud is off or the provider is not Bailian: it is a paid call. No UI;
 * the player's cache and failure back-off decide whether a request is made.
 */
export class FeedCuePrefetch {
  private armed = false;
  private reply = '';
  private voice = '';
  constructor(private readonly options: FeedCuePrefetchOptions) {}

  /** Armed by the first reply read aloud in the Bailian voice. */
  get active(): boolean { return this.armed; }

  /** VoiceOutput.onState. */
  playback(state: FeedCuePlaybackState | null | undefined): void {
    if (!state || state.phase !== 'playing' || state.provider !== 'bailian' || typeof state.replyId !== 'string' || !state.replyId) return;
    if (state.replyId === this.reply) return;
    const config = this.eligible();
    if (!config) return;
    this.armed = true; this.reply = state.replyId;
    this.warm(config);
  }

  /** Settings or the active character changed: a new voice is warmed while read-aloud is on. */
  voiceContextChanged(): void {
    if (!this.armed) return;
    const config = this.eligible();
    if (config && feedCueVoiceKey(config) !== this.voice) this.warm(config);
  }

  private warm(config: TtsConfig): void {
    this.voice = feedCueVoiceKey(config);
    try { this.options.prefetch(); } catch { /* A cue is optional. */ }
  }

  private eligible(): TtsConfig | null {
    let config: TtsConfig | null;
    try { config = this.options.voiceOn() ? this.options.getTtsConfig() : null; } catch { return null; }
    return config?.provider === 'bailian' ? config : null;
  }
}
