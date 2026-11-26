/**
 * I-154 follow-up, batches D and F (docs/claude/2026-11-21-unbound-full-D.md): what of her senses reaches her full-screen page, and the rules
 * the host and the page share for it. (D: her reactions to you and her look at you, with the pose readings
 * forwarded), then "我们除了”拉“，和移动，可以两个同时做。还有就是unbound是按照全开权限设计的。" (F as well: the listen-together samples).
 *
 * Only what the companion window already receives, only to the window she is shown in, only while the source is on:
 *  - where pose sensing says you are (the companion window's userGaze reading: presence, facing, movement, a point, the screen interest;
 *    numbers and closed words, shared/behaviors/gaze-attention/interface.ts), while camera pose sensing runs; off sends one null at once;
 *  - the music samples of 和她一起听 (the companion window's desk:audio-dance-sample frames: energy numbers, never sound), while a source's
 *    dance is on; off sends one null at once.
 * Never a frame, a picture or audio. Her reactions' own reading (MoodView.pose) already travels in the mood view her page gets.
 * Her facts about these (a gaze moment, a song reaction, the music verdict and tier) go back on one request, the kinds below only; while
 * she is out the companion window's facts of these kinds are not taken, so each line is written once.
 */
import type { AudioReadingSource } from '../voice';

/** The host's events for these (electron/unbound/sense-bridge.ts; her facts go back on UNBOUND_REQUESTS.herFact, shared/unbound/scene.ts). */
export const UNBOUND_SENSE_EVENTS = Object.freeze({
  /** Where pose sensing says you are, relative to her Unbound window (UserGazeReading), or null: sensing went off, forget at once. */
  userGaze: 'unbound:user-gaze',
  /** One music sample frame (AudioDanceFrame) while a source's dance is on, or null: the dance went off, stop at once. */
  dance: 'unbound:dance',
  /** 惊喜 / 害羞 from the character page's preview buttons (desk:expression-preview; every window's stage plays it on its own model). */
  expressionPreview: 'unbound:expression-preview',
  /**
   * 2026-11-24 (docs/claude/2026-11-24-music-nod-window.md): the user's music settings ("让她一直跟着跳", 音乐律动强度; MusicSettings, two
   * plain values), sent before the first music frame to a window she is newly shown in and on every change: her full-screen music follows
   * the same settings as the companion window.
   */
  musicSettings: 'unbound:music-settings',
} as const);

/**
 * What her page may tell of hers (the companion window's noteJournalFact kinds 'gaze', 'music-reaction', 'music-verdict', noteMusicTier, and
 * since 2026-11-24 noteStageState: 'stage-state', what her body does to the sound, the one value the next turn's line says).
 */
export const HER_FACT_KINDS = Object.freeze(['gaze', 'music-reaction', 'music-verdict', 'music-tier', 'stage-state'] as const);
export type HerFactKind = typeof HER_FACT_KINDS[number];
export const isHerFactKind = (value: unknown): value is HerFactKind => typeof value === 'string' && (HER_FACT_KINDS as readonly string[]).includes(value);

/** While she is out, a fact of these kinds from the companion window is not taken (her full-screen page tells it): each line once. */
export function companionFactAllowed(kind: unknown, out: boolean): boolean {
  return !(out && isHerFactKind(kind));
}

/** The sources whose dance is on in a capture state (desk:audio-capture-state: slots with `dance: true`); anything malformed: none. */
export function danceSources(state: unknown): ReadonlySet<AudioReadingSource> {
  const on = new Set<AudioReadingSource>();
  const slots = state && typeof state === 'object' ? (state as { slots?: unknown }).slots : null;
  if (!slots || typeof slots !== 'object') return on;
  for (const source of ['system-audio', 'microphone'] as const) {
    const slot = (slots as Record<string, unknown>)[source];
    if (slot && typeof slot === 'object' && (slot as { dance?: unknown }).dance === true) on.add(source);
  }
  return on;
}
