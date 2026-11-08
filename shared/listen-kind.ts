// I-016 一起听、一起看 (docs/claude/2026-11-03-listen-watch-plan.md): what is playing on the computer right now, as one
// shared contract between the two halves of the work.
//  - Producer (the "is it music" half): the stage's beat regularity plus the local recognizer's sound tags, smoothed over
//    30–60 s, set through ListenKindHost.set(). The recognizer's tags alone are unreliable (docs/claude/2026-11-03-ambient-local-asr.md:
//    the same music was tagged bgm under Chinese speech and speech under English), so beats lead and tags only confirm.
//  - Consumers (the "listen together" half, I-017's state line, her dancing): read current() or subscribe().
// No audio, no text and no user data ever pass through here: only the kind, how sure, and since when.

export const LISTEN_KINDS = ['music', 'show', 'talk', 'quiet', 'unsure'] as const;
/**
 * music: a song (steady beat; lyrics or not). show: a show or video (a segment that had music, a theme song or laughter;
 * dialogue without music later in the same segment stays "show"). talk: voices with no music from start to finish (a call,
 * a meeting, a podcast, a class; not kept by default). quiet: nothing playing.
 * unsure: not decided yet.
 */
export type ListenKind = typeof LISTEN_KINDS[number];

export interface ListenKindView {
  kind: ListenKind;
  /** 0..1 */
  confidence: number;
  /** Epoch ms when this kind began (a segment boundary for the listen-together half). */
  since: number;
  /** Increases on every change; a late or repeated value with an older revision is ignored. */
  revision: number;
}

export function isListenKind(value: unknown): value is ListenKind {
  return typeof value === 'string' && (LISTEN_KINDS as readonly string[]).includes(value);
}

export const QUIET_LISTEN_VIEW: Readonly<ListenKindView> = Object.freeze({ kind: 'quiet', confidence: 1, since: 0, revision: 0 });

/** Host-side holder. The producer calls set(); consumers call current() or subscribe(). Changes are never replayed. */
export class ListenKindHost {
  private view: ListenKindView = { ...QUIET_LISTEN_VIEW };
  private readonly listeners = new Set<(view: ListenKindView) => void>();

  current(): ListenKindView { return { ...this.view }; }

  /** Accepts a new view only when its revision is newer; returns whether it was taken. */
  set(next: ListenKindView): boolean {
    if (!isListenKind(next.kind) || !(next.revision > this.view.revision)
      || !Number.isFinite(next.confidence) || next.confidence < 0 || next.confidence > 1 || !Number.isFinite(next.since)) return false;
    const changed = next.kind !== this.view.kind;
    this.view = { kind: next.kind, confidence: next.confidence, since: next.since, revision: next.revision };
    if (changed) for (const listener of [...this.listeners]) { try { listener(this.current()); } catch { /* a consumer's problem stays its own */ } }
    return true;
  }

  subscribe(listener: (view: ListenKindView) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
