import { CUE_TEXT, FEED_CUE_MAX_BYTES, cueInstruction, isCueKind, type CueKind, type FeedCueClip } from '../shared/feed-cue';
import type { TtsConfig } from '../shared/tts';
import { supportsTurnSpeechEmotion } from './speech-emotion';
import type { SpeechSynthesizer } from './speech-runtime';
import { synthesizeBailianSpeech, validateTtsConfig } from './tts';

/** A cue synthesis that takes longer than this is abandoned (the renderer skips late cues anyway). */
export const FEED_CUE_TIMEOUT_MS = 8000;
/** After a failure, the same voice is not asked again for this long. */
export const FEED_CUE_RETRY_MS = 60_000;
/** #32: ten feeding sounds and the waiting hum per voice, for a voice switch or two. */
const MAX_ENTRIES = 32;

/**
 * B06 feeding cues in the character's own Bailian voice. Fixed host texts only
 * (the renderer names a kind), one bounded clip per voice and kind, cached in
 * memory. It runs beside the reply's SpeechRuntime and never touches it: a cue
 * cannot cancel, replace or delay the reply speech that is paused meanwhile.
 * Nothing is archived, rewarded or logged as conversation. X1 adds the
 * waiting hum ("think") as one more fixed kind with its own instruction.
 * #32 adds eight more feeding sounds (shared/feed-cue.ts FEED_SOUND_IDS), each with its fixed text and tone; still one
 * bounded clip per voice and kind, asked for only when the renderer needs it.
 */
export class FeedCueSynth {
  private readonly clips = new Map<string, FeedCueClip>();
  private readonly inflight = new Map<string, Promise<FeedCueClip | null>>();
  private readonly failedAt = new Map<string, number>();
  constructor(
    private readonly synthesize: SpeechSynthesizer = synthesizeBailianSpeech,
    private readonly now: () => number = () => Date.now(),
    private readonly timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void } = {
      set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  ) {}

  /** null: not Bailian, not configured, failed recently, or the stream was not a short cue. */
  async clip(kind: unknown, config: TtsConfig): Promise<FeedCueClip | null> {
    if (!isCueKind(kind)) throw new Error('提示音种类不正确。');
    if (!config || config.provider !== 'bailian') return null;
    let cue: TtsConfig;
    try { cue = validateTtsConfig(structuredClone(supportsTurnSpeechEmotion(config.model)
      ? { ...config, emotion: 'custom', instruction: cueInstruction(kind) } : { ...config })); }
    catch { return null; }
    const key = JSON.stringify([cue.apiHost, cue.region, cue.model, cue.voice, cue.instruction, cue.emotion, cue.rate, kind]);
    const cached = this.clips.get(key);
    if (cached) return { pcm: cached.pcm };
    const pending = this.inflight.get(key);
    if (pending) return pending.then(clip => clip && { pcm: clip.pcm });
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.now() - failed < FEED_CUE_RETRY_MS) return null;
    const request = this.request(cue, kind).then(clip => {
      if (clip) { this.clips.set(key, clip); while (this.clips.size > MAX_ENTRIES) this.clips.delete(this.clips.keys().next().value!); this.failedAt.delete(key); }
      else this.failedAt.set(key, this.now());
      return clip;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request.then(clip => clip && { pcm: clip.pcm });
  }

  clear(): void { this.clips.clear(); this.failedAt.clear(); }

  private async request(config: TtsConfig, kind: CueKind): Promise<FeedCueClip | null> {
    const controller = new AbortController();
    const timer = this.timers.set(() => controller.abort(), FEED_CUE_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let bytes = 0, tooLong = false;
    try {
      await this.synthesize(config, CUE_TEXT[kind], controller.signal, event => {
        if (event.type !== 'audio' || controller.signal.aborted) return;
        if (event.format !== 'pcm_s16le' || event.sampleRate !== 24000 || event.channels !== 1) { tooLong = true; controller.abort(); return; }
        const chunk = Buffer.from(event.data, 'base64');
        bytes += chunk.length;
        if (bytes > FEED_CUE_MAX_BYTES) { tooLong = true; controller.abort(); return; }
        chunks.push(chunk);
      });
    } catch { return null; }
    finally { this.timers.clear(timer); }
    if (tooLong || controller.signal.aborted || bytes < 2) return null;
    const pcm = Buffer.concat(chunks);
    return { pcm: pcm.subarray(0, pcm.length - (pcm.length % 2)).toString('base64') };
  }
}
