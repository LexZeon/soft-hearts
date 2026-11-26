import { deriveDispositions, type DispositionCard } from '../../../shared/mood';
import { sanitizeSpeechFaceCue } from './cues';
import { SpeechFace } from './layer';

/**
 * I-073 part 3: the stage's side of the speaking accents, kept out of MmdStage (a hot file): cues from either window are
 * checked here, and the character's mood, baseline, fatigue and tendencies are read when the mood view changes.
 * Tendencies: derived from the card (deriveDispositions) for now; the stored I-037 values live in the host and are not on
 * the stage yet (reversible: pass them in the mood view later).
 */
export class SpeechFaceStage extends SpeechFace {
  private view: unknown = null;
  /** Accepts a cue from this window's voice output or the other window (BroadcastChannel); malformed ones are ignored. */
  override cue(value: unknown): void {
    const cue = sanitizeSpeechFaceCue(value);
    if (cue) super.cue(cue);
  }
  /** The mood view changed: re-read her numbers relative to her baseline, her fatigue and tendencies. */
  read(view: SpeechFaceView | null | undefined): void {
    if (view === this.view) return;
    this.view = view ?? null;
    let dispositions = null;
    try { dispositions = view?.parameters ? deriveDispositions(view.parameters as DispositionCard) : null; } catch { dispositions = null; }
    this.setContext({ values: view?.snapshot?.values ?? null, baseline: view?.parameters?.baseline ?? null, fatigue: view?.fatigue ?? null, dispositions });
  }
}
interface SpeechFaceView {
  snapshot?: { values?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> } | null;
  parameters?: { baseline?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> } & Partial<DispositionCard>;
  fatigue?: { phase?: string; F?: number; sleeping?: boolean } | null;
}

/** For the stage's frame: the layer (or null when nothing ever cued it), its context brought up to date. */
export function speechFaceContext(face: SpeechFaceStage | undefined, view: unknown, faceActionBusy: boolean): SpeechFaceStage | null {
  if (!face) return null;
  face.read(view as SpeechFaceView | null);
  face.setBlocked(faceActionBusy);
  return face;
}
