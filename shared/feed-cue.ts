/**
 * B06 feeding cues: a short "啊" when the snack reaches her
 * mouth (she opens it), a short "嗯" when it is delivered (she is eating). In
 * her own current voice; they are not replies (no history, reward or text).
 *
 * #32 (I-020, docs/claude/2026-11-04-feed-cue.md): each of the two moments now has a few sounds she picks from
 * (shared/behaviors/feed-cue/): five before the bite, five after it, and "no sound" in each. They are still fixed host
 * texts (shared/behaviors/feed-cue/knobs.ts, never written by a model): a renderer can only name a sound, never send text,
 * and each sound is synthesized once per voice and cached, like the two before.
 */
import { FEED_CUE_KNOBS } from './behaviors/feed-cue/knobs';

/** The two moments of a feed: the snack at her mouth ('ah') and the bite ('mm'). Also the two original sounds. */
export type FeedCueKind = 'ah' | 'mm';
export const FEED_CUE_KINDS: readonly FeedCueKind[] = Object.freeze(['ah', 'mm']);
/** #32: what she may say as the snack reaches her mouth ('ah' = the original "啊～"). */
export const FEED_OPEN_SOUND_IDS = Object.freeze(['ah', 'wa', 'aowu', 'soft', 'huh'] as const);
export type FeedOpenSoundId = typeof FEED_OPEN_SOUND_IDS[number];
/** #32: what she may say once the bite landed ('mm' = the original "嗯～"). */
export const FEED_EAT_SOUND_IDS = Object.freeze(['mm', 'yum', 'haochi', 'wuen', 'wu'] as const);
export type FeedEatSoundId = typeof FEED_EAT_SOUND_IDS[number];
export type FeedSoundId = FeedOpenSoundId | FeedEatSoundId;
export const FEED_SOUND_IDS: readonly FeedSoundId[] = Object.freeze([...FEED_OPEN_SOUND_IDS, ...FEED_EAT_SOUND_IDS]);

const soundKnob = (id: FeedSoundId) => (FEED_OPEN_SOUND_IDS as readonly string[]).includes(id)
  ? FEED_CUE_KNOBS.open[id as FeedOpenSoundId] : FEED_CUE_KNOBS.eat[id as FeedEatSoundId];
/** Fixed host texts of every feeding sound (#32 knobs). */
export const FEED_SOUND_TEXT: Readonly<Record<FeedSoundId, string>> = Object.freeze(Object.fromEntries(FEED_SOUND_IDS.map(id => [id, soundKnob(id).text])) as Record<FeedSoundId, string>);
/** The two original texts. */
export const FEED_CUE_TEXT: Readonly<Record<FeedCueKind, string>> = Object.freeze({ ah: FEED_SOUND_TEXT.ah, mm: FEED_SOUND_TEXT.mm });
/** Style for models that take an instruction (Bailian); otherwise the character's plain voice. The two original sounds use it. */
export const FEED_CUE_INSTRUCTION = FEED_CUE_KNOBS.open.ah.tone;
/** A cue clip is at most this long (24 kHz mono PCM16): anything longer is not a cue. */
export const FEED_CUE_MAX_SECONDS = 2.5;
export const FEED_CUE_MAX_BYTES = Math.round(FEED_CUE_MAX_SECONDS * 24000) * 2;

/** One synthesized cue: base64 PCM16 little-endian, 24 kHz, mono. */
export interface FeedCueClip { pcm: string }

export function isFeedCueKind(value: unknown): value is FeedCueKind {
  return value === 'ah' || value === 'mm';
}
export function isFeedSoundId(value: unknown): value is FeedSoundId {
  return typeof value === 'string' && (FEED_SOUND_IDS as readonly string[]).includes(value);
}
export function isFeedOpenSound(value: unknown): value is FeedOpenSoundId {
  return typeof value === 'string' && (FEED_OPEN_SOUND_IDS as readonly string[]).includes(value);
}
export function isFeedEatSound(value: unknown): value is FeedEatSoundId {
  return typeof value === 'string' && (FEED_EAT_SOUND_IDS as readonly string[]).includes(value);
}

/**
 * X1 (docs/claude/2026-11-02-waiting-expression.md): a soft "嗯…" when a sent
 * message starts waiting, read-aloud on only. Same fixed-text, per-voice cached
 * cue path as the feeding cues, played by its own player instance (own clip
 * cache and playback), so the two never stop or evict each other. Audio only:
 * never chat text, history or an archive entry.
 */
export type CueKind = FeedSoundId | 'think';
export const THINK_CUE_KINDS: readonly CueKind[] = Object.freeze(['think']);
export const CUE_TEXT: Readonly<Record<CueKind, string>> = Object.freeze({ ...FEED_SOUND_TEXT, think: '嗯…' });
export const THINK_CUE_INSTRUCTION = '轻柔、短促的沉吟，像正在想事情时自然发出的一声“嗯”；只读这一个字，不要加别的。';
export function cueInstruction(kind: CueKind): string {
  if (kind === 'think') return THINK_CUE_INSTRUCTION;
  if (kind === 'ah' || kind === 'mm') return FEED_CUE_INSTRUCTION;
  return soundKnob(kind).tone;
}
export function isCueKind(value: unknown): value is CueKind {
  return isFeedSoundId(value) || value === 'think';
}
