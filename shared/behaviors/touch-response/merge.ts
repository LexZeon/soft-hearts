/**
 * I-136: touches close together are one thing ("连着拉的合成一件"). The same kind and part (and place) within knobs.mergeMs of the
 * previous one join its episode and add to its count; anything else starts a new episode. A pull's "still holding" report and its
 * end are one pull, not two. Pure bookkeeping: no clock of its own.
 */
import type { TouchEvent, TouchPart, TouchPlace } from '../../mood/touch';
import type { TouchEpisode, TouchEpisodeKind } from './interface';
import { TOUCH_RESPONSE_KNOBS, type TouchResponseKnobs } from './knobs';

export interface TouchNote {
  readonly kind: TouchEpisodeKind;
  readonly part: TouchPart | null;
  readonly side: 'left' | 'right' | null;
  readonly where: TouchPlace;
  readonly at: number;
  readonly strength?: number;
  readonly heldMs?: number;
  readonly ended?: TouchEvent['ended'];
  readonly response?: TouchEvent['response'];
  readonly steps?: number;
}

/** A TouchEvent as one note. */
export const noteOfTouch = (event: TouchEvent): TouchNote => ({ kind: event.kind, part: event.part, side: event.side, where: event.where, at: event.at,
  ...(event.strength !== undefined ? { strength: event.strength } : {}), ...(event.heldMs !== undefined ? { heldMs: event.heldMs } : {}),
  ...(event.ended !== undefined ? { ended: event.ended } : {}), ...(event.response !== undefined ? { response: event.response } : {}),
  ...(event.steps !== undefined ? { steps: event.steps } : {}) });

const KEEP = 16;

export class TouchMerger {
  private readonly episodes: TouchEpisode[] = [];
  private serial = 0;
  constructor(private readonly knobs: Pick<TouchResponseKnobs, 'mergeMs'> = TOUCH_RESPONSE_KNOBS, private readonly makeId?: () => string) {}

  /** Adds one touch. `fresh`: it started a new episode. `counted`: the count went up (a pull's end after its "holding" report does not). */
  note(characterId: string, touch: TouchNote): { episode: TouchEpisode; fresh: boolean; counted: boolean } {
    const at = Number.isFinite(touch.at) ? touch.at : 0;
    const open = [...this.episodes].reverse().find(item => item.characterId === characterId && item.kind === touch.kind && item.part === touch.part
      && item.where === touch.where && at - item.lastAt >= -1_000 && at - item.lastAt <= this.knobs.mergeMs);
    if (open) {
      // One drag sends "holding" and then its end: still the same pull.
      const counted = !(touch.kind === 'pull' && open.ended === 'holding');
      if (counted) open.count++;
      open.lastAt = Math.max(open.lastAt, at);
      if (touch.strength !== undefined) open.strength = Math.max(open.strength, touch.strength);
      if (touch.heldMs !== undefined) open.heldMs = Math.max(open.heldMs, touch.heldMs);
      if (touch.ended !== undefined) open.ended = touch.ended;
      if (touch.response !== undefined && open.response !== 'pulled-back') open.response = touch.response;
      if (touch.steps !== undefined) open.steps = Math.max(open.steps ?? 0, touch.steps);
      return { episode: open, fresh: false, counted };
    }
    const episode: TouchEpisode = { id: this.makeId?.() ?? `t${Math.floor(at).toString(36)}-${(++this.serial).toString(36)}`, kind: touch.kind, part: touch.part,
      side: touch.side, where: touch.where, characterId, firstAt: at, lastAt: at, count: 1, strength: touch.strength ?? 0, heldMs: touch.heldMs ?? 0, ended: touch.ended ?? null,
      ...(touch.response !== undefined ? { response: touch.response } : {}), ...(touch.steps !== undefined ? { steps: touch.steps } : {}) };
    this.episodes.push(episode);
    while (this.episodes.length > KEEP) this.episodes.shift();
    return { episode, fresh: true, counted: true };
  }

  /** The episodes of this character newer than `since`, newest first. */
  recent(characterId: string, since: number): TouchEpisode[] {
    return this.episodes.filter(item => item.characterId === characterId && item.lastAt >= since).sort((a, b) => b.lastAt - a.lastAt);
  }

  get(id: string): TouchEpisode | null { return this.episodes.find(item => item.id === id) ?? null; }
}
