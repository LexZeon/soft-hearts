/**
 * I-077 step 1: the stage's side of the music reactions, kept out of MmdStage (a hot file). Each frame it reads her mood (relative
 * to her baseline), her tendencies, whether she chooses for herself and whether this is music, then hands the dance and the nod
 * their shape, the speaking-accent layer the face parts and the song's mood tint, and the host each reaction that started.
 */
import { deriveDispositions, type DispositionCard } from '../../../shared/mood';
import { hormoneTemper, NEUTRAL_DISPOSITIONS, NEUTRAL_TEMPER, type Choice, type DispositionTemper, type HormoneTemper } from '../../voice';
import type { Variant } from '../../voice';
import type { MusicLikenessState } from '../music-likeness';
import { isNeutralShape, MusicReact, type DanceShape } from './director';
import type { MusicIntent } from './recipes';
import type { MusicTaste } from '../../../shared/foundation/character-card';
import type { SongSketch } from '../../../shared/senses';

/** The host's song memory as the stage sees it (electron/senses/song-memory.ts behind one IPC call): numbers in, "this one" or nothing out. */
export interface SongMemoryPort {
  match(sketch: SongSketch): Promise<{ id: string } | null>;
  learn(sketch: SongSketch): Promise<unknown>;
}

interface ReactView {
  characterId?: string;
  expressions?: boolean;
  snapshot?: { values?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> } | null;
  parameters?: { baseline?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> } & Partial<DispositionCard>;
  fatigue?: { phase?: string; F?: number; sleeping?: boolean } | null;
}
export interface MusicReactPorts {
  view: unknown;
  /** She chooses for herself (the music settings received, not "一直跟着跳") and hears. */
  choosing: boolean;
  music: boolean;
  /** Her music tier (none / nod / dance) and whether the dance or nod is shown (not yielding). */
  tier: 'none' | 'nod' | 'dance';
  shown: boolean;
  speaking: boolean;
  likeness: MusicLikenessState | null | undefined;
  dance: { setShape(shape: Readonly<DanceShape> | null): void };
  nod: { setShape(shape: Readonly<DanceShape> | null): void } | undefined;
  /** The speaking-accent layer (created on first use). */
  face(): { performPick(pick: Choice, timing: { at: 'now' }, tag: `music-${string}`): unknown; setTint(smileEyes: number, lidSoft: number): void };
  hasFace: boolean;
  /** `scale`: the factor her taste puts on that reaction's mood moment (1 = none). */
  told(intent: MusicIntent, scale: number): void;
  /** Step 2: the card's music taste (undefined: neutral) and the song memory (undefined: not available, nothing is looked up or learned). */
  taste?: Readonly<MusicTaste> | null;
  memory?: SongMemoryPort | null;
}

export class MusicReactStage extends MusicReact {
  private view: unknown = undefined;
  private temper: HormoneTemper = NEUTRAL_TEMPER;
  private dispositions: DispositionTemper = NEUTRAL_DISPOSITIONS;
  private tinted = false;
  /** The character whose song is being measured (a finished song is learned only for her, never for one switched to meanwhile). */
  private songCharacter: string | null = null;

  private read(view: ReactView | null | undefined): void {
    if (view === this.view) return;
    this.view = view;
    this.temper = hormoneTemper(view?.snapshot?.values, view?.parameters?.baseline, view?.fatigue);
    let d = null;
    try { d = view?.parameters ? deriveDispositions(view.parameters as DispositionCard) : null; } catch { d = null; }
    this.dispositions = d ? { ...NEUTRAL_DISPOSITIONS, ...Object.fromEntries(Object.entries(d).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) } : NEUTRAL_DISPOSITIONS;
  }

  step(delta: number, ports: MusicReactPorts): void {
    const view = ports.view as ReactView | null | undefined;
    this.read(view);
    const features = ports.likeness?.features;
    const out = this.frame(delta, { on: ports.choosing && view?.expressions === true, music: ports.music, moving: ports.tier !== 'none' && ports.shown,
      speaking: ports.speaking, temper: this.temper, dispositions: this.dispositions, period: features?.period ?? 0, beatScore: ports.likeness?.last.beat ?? 0,
      taste: ports.taste, memory: !!ports.memory });
    const shape = isNeutralShape(out.shape) ? null : out.shape;
    ports.dance.setShape(shape); ports.nod?.setShape(shape);
    const tint = out.tint.smileEyes > 0 || out.tint.lidSoft > 0;
    if (tint || out.face.length || (this.tinted && ports.hasFace)) {
      const face = ports.face();
      face.setTint(out.tint.smileEyes, out.tint.lidSoft);
      for (const request of out.face) {
        const variant: Variant = Object.freeze({ id: request.id, family: 'face', slider: request.slider, amp: [request.amp, request.amp] as const, keys: request.keys, style: request.style });
        face.performPick(Object.freeze({ variant, amp: request.amp, timeScale: request.timeScale, side: 1 }), { at: 'now' }, `music-${request.id}`);
      }
    }
    this.tinted = tint;
    out.moments.forEach((intent, index) => { try { ports.told(intent, out.scales[index] ?? 1); } catch { /* a report never changes her */ } });
    const memory = ports.memory;
    const character = typeof view?.characterId === 'string' ? view.characterId : null;
    if (memory && out.ask) {
      this.songCharacter = character;
      // The look-up is asked once per song and answered later; an answer for a song that is over is dropped (the token).
      const token = out.askToken;
      memory.match(out.ask).then(found => { if (found && typeof found.id === 'string') this.recognized(token, found.id); }, () => {});
    }
    if (out.learn) {
      const own = this.songCharacter !== null && this.songCharacter === character;
      this.songCharacter = null;
      if (memory && own) memory.learn(out.learn).catch(() => {});
    }
  }
}
