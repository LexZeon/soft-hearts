/**
 * I-185 第 3 条 (docs/claude/2026-11-22-i185-words-kiss-hug.md): what she can do right now, for her turn's one short line about the marker
 * words she cannot use (shared/behaviors/speech-beats/availability.ts). The wiring (electron/wiring/unbound-wiring.ts) gives the readers;
 * each turn reads them once (electron/brain/speech-beats/host.ts situate). Only "possible now" and "this model can": never her character.
 *
 * The capability card is read in the background (the model check's read is async) and kept: a turn uses the last card read, and the first
 * turn before any read leaves nothing out for the model.
 */
import { deriveModelCapabilities, type ModelCapabilityView } from '../../shared/stage';
import { speechBeatSituationOf, type SituationCard, type SituationView, type SpeechBeatSituation } from '../../shared/brain';

export interface BeatSituationReads {
  /** 'unbound' while she is out in full-screen. */
  state(): string;
  /** The companion window's 显示桌宠 (out in full-screen she is always shown: a full-screen program never hides her, I-199). */
  companionShown(): boolean;
  view(): SituationView | null;
  asleep(): boolean;
  /** A game, an offer or her reach holds her arms. */
  armsHeld(): boolean;
  inCall(): boolean;
  /** The model check's read for the current model (async). */
  card?(): Promise<unknown>;
  /** 2026-11-23: full-screen only, why a kiss / hug could not walk up right now ('pulled', 'busy', 'typing'), or null. */
  closeNow?(): unknown;
}

/** The card as this reads it: "能做手势" (her arm bones, and the user's choice). No profile yet: null (not known; nothing left out). */
export function beatCardOf(value: unknown): SituationCard | null {
  const view = value as Partial<ModelCapabilityView> | null | undefined;
  if (!view || typeof view !== 'object' || !view.profile) return null;
  try {
    const card = deriveModelCapabilities(view.profile, view.record?.choices ?? {}, view.record?.haiku ?? {});
    return { gesture: { enabled: card.gesture.enabled === true } };
  } catch { return null; }
}

const safe = <T>(read: () => T, fallback: T): T => { try { const value = read(); return value ?? fallback; } catch { return fallback; } };

export class BeatSituation {
  private card: SituationCard | null = null;
  constructor(private readonly reads: BeatSituationReads) {}

  /** Starts a read of the card (kept for the next turn). */
  refresh(): void {
    const read = this.reads.card;
    if (!read) return;
    try { void Promise.resolve(read()).then(value => { this.card = beatCardOf(value); }, () => {}); } catch { /* the model check is not ready */ }
  }

  /** Now (and a fresh read of the card for the next turn). */
  now(): SpeechBeatSituation {
    this.refresh();
    const full = safe(() => this.reads.state(), 'normal') === 'unbound';
    return speechBeatSituationOf({
      surface: full ? 'full' : 'window',
      shown: full || safe(() => this.reads.companionShown(), true),
      view: safe(() => this.reads.view(), null), asleep: safe(() => this.reads.asleep(), false),
      armsHeld: safe(() => this.reads.armsHeld(), false), inCall: safe(() => this.reads.inCall(), false), card: this.card,
      closeNow: full ? safe(() => this.reads.closeNow?.() ?? null, null) : null,
    });
  }
}
