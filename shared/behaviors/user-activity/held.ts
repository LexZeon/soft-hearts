/**
 * I-066 留着的话：你不在（或拿不准、在开会）时她想开口，不说出来，也不调模型，只记下"她想说哪一类"（不是文字）。
 * 只留 1 件：更重要的，一样重要就留最新的；最多留 heldMinutes（knobs.ts presence.heldMinutes），过了就算了，不补。
 * 你回来（或者又"可以打扰"）时，下一次能开口的机会先说这一件；用的还是当初那一次开口的配额（主机不退回它，过期或被换掉才退回）。
 *
 * 纯逻辑：没有计时器、没有文件；只在内存里。
 */
import { USER_ACTIVITY_KNOBS, type UserActivityKnobs } from './knobs';

/** What she wanted to bring up: a keepsake or special-day line she holds, a small need, or just wanting to talk to you. */
export const HELD_KINDS = ['keepsake', 'need', 'talk'] as const;
export type HeldKind = typeof HELD_KINDS[number];
const WEIGHT: Readonly<Record<HeldKind, number>> = { keepsake: 3, need: 2, talk: 1 };

export interface HeldIntent {
  readonly kind: HeldKind;
  readonly characterId: string;
  /** The speech cue whose opportunity (and quota) it carries. */
  readonly cue: { readonly id: string; readonly at: number };
  /** When it was held (wall-clock ms). */
  readonly since: number;
}

const MINUTE = 60_000;

export class HeldIntents {
  private held: HeldIntent | null = null;
  constructor(private readonly knobs: UserActivityKnobs = USER_ACTIVITY_KNOBS) {}

  /**
   * Hold one. Returns what it replaced or refused (that one's quota goes back), or null when nothing was dropped.
   * The new one is kept when there is nothing, the old one expired, belongs to another character, or is not more important.
   */
  hold(intent: HeldIntent, now: number): HeldIntent | null {
    const old = this.expired(now) ?? this.held;
    if (old && old !== this.held) { this.held = intent; return old; }
    if (!old) { this.held = intent; return null; }
    if (old.characterId !== intent.characterId || WEIGHT[intent.kind] >= WEIGHT[old.kind]) { this.held = intent; return old; }
    return intent;
  }

  /** The one held now (an expired one is not returned; call `expired` to collect it). */
  peek(now: number): HeldIntent | null {
    const held = this.held;
    return held && now >= held.since && now - held.since < this.knobs.presence.heldMinutes * MINUTE ? held : null;
  }

  /** An expired one, removed and returned once (its quota goes back; the journal says it expired). */
  expired(now: number): HeldIntent | null {
    const held = this.held;
    if (!held || (now >= held.since && now - held.since < this.knobs.presence.heldMinutes * MINUTE)) return null;
    this.held = null;
    return held;
  }

  /** Taken to be said now. */
  take(now: number): HeldIntent | null {
    const held = this.peek(now);
    if (held) this.held = null;
    return held;
  }

  /** Dropped (a character switch, the switch off): returned so its quota can go back. */
  clear(): HeldIntent | null { const held = this.held; this.held = null; return held; }
}
