/**
 * Unbound v1 step 2: her mouth moves with the voice while she is out. The same signal the companion's stage uses: the voice output's
 * "she is speaking" flag (the host forwards it, electron/unbound/host.ts speaking), run through the same hold (a stream's short
 * stalls are one utterance, the last syllable eases shut: src/voice/speech-hold.ts) and the same flap (0.23 + |sin(12 t)| × 0.45
 * of the model's open-mouth morph, damped at 16 /s: src/stage/MmdStage.ts). Only the mouth: the companion's richer speaking face
 * (speech accents, mouth shapes) is a later step.
 *
 * The morph is written after her frame and put back before the next one, so a model whose motion animates the same morph is not
 * left changed. A flag that never comes back false (the report was lost) ends by itself after STUCK_S seconds: an open mouth must
 * not flap on forever.
 *
 * I-175 (shared/behaviors/part-mix/mouth.ts):
 * the flap opens on top of her expression's base shape. With a `face` (the figure) the flap reads the base her face wrote this frame: its
 * amplitude is scaled by talkThroughMouth (exactly 0.6 under a full base, 1 with none, never 0 while she speaks) and it opens the vowel the
 * base leans to (a pout → う/お, a smile → い/え, else あ; a vowel the model lacks falls back to あ). The mouth's eased "lip-sync owns the
 * opening" goes back to the figure (setMouthTalk) so the expression's own open mouth and closed-mouth shapes give way to the flap.
 *
 * 2026-11-22: a smile
 * leaned the flap fully onto い, which on One parts the lips by nothing at all, so she talked with her mouth shut while a smile beat held. Now the
 * lean is a blend (mostly あ), a smile cuts the amplitude less than a pout, and a floor keeps the lips parting at least flapFloor of an ordinary
 * flap, measured on the model's own lips (mouth-geometry.ts). The same measurement calibrates each model ("也要防止嘴太小" / "嘴长得太大"): the
 * flap's peak parts the lips about flapPeakGap of her eye-to-mouth distance on every model, never more than flapGapCeiling.
 */
import type { Mesh, SkinnedMesh } from 'three';
// Direct, not through src/voice/index.ts: the Unbound window is its own bundle, and the page would pull every voice panel into it.
import { SpeechHold } from '../voice/speech-hold';
import { damp } from '../stage/procedural'; // direct, not via ../stage: the Unbound window does not take the stage page (docs/claude/2026-11-16-overhaul-parts-4.md)
import { legacyMorphIndices } from '../stage/model-profile';
import { MouthScale } from '../../shared/voice'; // 2026-11-20: her short sounds in a call (the same scale as the companion's stage)
import { MORPH_ALIASES } from '../../shared/foundation/universal-skeleton';
import { FLAP_PEAK, TalkEase, flapCalibration, talkThroughMouth, vowelOpenings } from '../../shared/behaviors/part-mix/mouth';
import { PART_MIX_KNOBS, type PartMixKnobs } from '../../shared/behaviors/part-mix/knobs';
import type { MouthGapProfile } from '../../shared/behaviors/part-mix/mouth-gap';
import { mouthGapForMesh } from './mouth-geometry';
import { VOWELS, type MouthBase, type Vowel, type VowelWeights } from '../../shared/behaviors/part-mix/interface';

/** What the flap reads of her face and hands back (the figure, figure.ts): the base shape written this frame, and the talk weight for the next. */
export interface MouthFace { readonly mouthBase: MouthBase; setMouthTalk(talk: number): void }

/** The vowel morphs of a mesh by the universal aliases (exact, case-insensitive); -1 for a vowel it lacks. あ also by the companion's old names. */
export function vowelIndices(dictionary: Record<string, number> | undefined): Record<Vowel, number> {
  const keys = Object.keys(dictionary ?? {}), out = { a: -1, i: -1, u: -1, e: -1, o: -1 } as Record<Vowel, number>;
  for (const vowel of VOWELS) for (const alias of MORPH_ALIASES[vowel]) {
    const key = keys.find(k => k.toLowerCase() === alias.toLowerCase());
    if (key !== undefined) { out[vowel] = dictionary![key]; break; }
  }
  const legacy = legacyMorphIndices(dictionary).mouth;
  if (legacy >= 0) out.a = legacy; // the same あ the flap always opened
  return out;
}

/** One frame's opening as shown (lastReading). */
export interface MouthReading { readonly aa: number; readonly floored: boolean; readonly capped: boolean }

export const STUCK_S = 90;
/** A short sound of hers never lasts this long: a lost "ended" report ends by itself (a reply's STUCK_S would hold the mouth far too long). */
export const FILLER_STUCK_S = 6;

/** The flap's target for one frame (0..~0.68): nothing while she is not speaking, the moving mouth scaled by the hold's flap otherwise. */
export function mouthTarget(held: { mouth: boolean; flap: number }, seconds: number, scale = 1): number {
  return held.mouth ? (0.23 + Math.abs(Math.sin(seconds * 12)) * (FLAP_PEAK - 0.23)) * held.flap * scale : 0;
}

export class UnboundMouth {
  private readonly hold = new SpeechHold();
  private raw = false;
  private sinceTrue = 0;
  /** A short sound of hers (call fillers) is sounding, as its mouth scale; null: none. A second source, so a reply's end never clears it. */
  private filler: number | null = null;
  private fillerSince = 0;
  private readonly scale = new MouthScale();
  private value = 0;
  private elapsed = 0;
  /** What the flap's frame overwrote (index, value), put back before her next frame. */
  private readonly saved: { index: number; value: number }[] = [];
  private held = false;
  /** I-175: the vowel morphs (index of あ is `index`), the eased talk weight, and the last frame's openings per vowel. */
  private readonly vowels: Record<Vowel, number>;
  private readonly talkEase = new TalkEase();
  private readonly shares: VowelWeights = { a: 0, i: 0, u: 0, e: 0, o: 0 };
  private scaleNow = 1;
  /** 2026-11-22: this model's lips (null: not measured, the flap uncalibrated), its calibration, and the last frame's reading. */
  readonly gap: MouthGapProfile | null;
  private readonly gain: number;
  private readonly gapCap: number;
  private readonly knobs: PartMixKnobs;
  private reading: MouthReading = { aa: 0, floored: false, capped: false };

  constructor(private readonly influences: number[], private readonly index: number, vowels: Partial<Record<Vowel, number>> = {},
    options: { gap?: MouthGapProfile | null; knobs?: PartMixKnobs } = {}) {
    this.vowels = { a: index, i: vowels.i ?? -1, u: vowels.u ?? -1, e: vowels.e ?? -1, o: vowels.o ?? -1 };
    this.knobs = options.knobs ?? PART_MIX_KNOBS;
    this.gap = options.gap ?? null;
    const calibration = flapCalibration(this.gap?.fullGap, this.knobs);
    this.gain = calibration.gain; this.gapCap = calibration.gapCap;
  }

  /** The mouth of a mesh, found by the same names the companion falls back to; null when the model has none. */
  static forMesh(mesh: Pick<Mesh, 'morphTargetDictionary' | 'morphTargetInfluences'>): UnboundMouth | null {
    const vowels = vowelIndices(mesh.morphTargetDictionary), index = vowels.a; // the old names first, then the universal aliases (aa, Fcl_MTH_A …; T-258 C03)
    if (!(index >= 0) || !mesh.morphTargetInfluences) return null;
    return new UnboundMouth(mesh.morphTargetInfluences, index, vowels, { gap: mouthGapForMesh(mesh as SkinnedMesh, vowels) }); // her own lips, measured once
  }

  /** The voice started or stopped. */
  speaking(on: boolean): void {
    this.raw = on === true;
    if (this.raw) { this.hold.note(true); this.sinceTrue = 0; }
  }
  /** A short sound began (its scale 0..1) or ended (null). */
  fillerSound(shape: number | null): void {
    this.filler = shape === null ? null : (Number.isFinite(shape) && shape > 0 ? Math.min(1, shape) : 0.5);
    this.scale.setFiller(this.filler);
    if (this.filler !== null) { this.hold.note(true); this.fillerSince = 0; }
  }
  get isSpeaking(): boolean { return this.raw || this.filler !== null; }
  /** The held "she is speaking" (a stream's short stalls are one utterance), as of her last frame: the window face's speaking accents start only while it holds. */
  get voiced(): boolean { return this.held; }
  /** Her mouth, 0..1, as last written. */
  get open(): number { return this.value; }

  /** Before her frame: the morphs as her motion left them. */
  restore(): void {
    for (let k = this.saved.length - 1; k >= 0; k--) this.influences[this.saved[k].index] = this.saved[k].value;
    this.saved.length = 0;
  }

  /**
   * After her frame: this frame's mouth on top of whatever the motion has. `compose` (I-154 batch 3, the companion window's feeding): the
   * speaking mouth → what shows (part-mix composeFeedMouth: lip-sync fades under the snack by the snack's eased owner weight; a snack opens
   * あ); null: the speaking mouth as it is. `face` (I-175): the figure, whose base shape scales the flap and picks its vowel, and which gets
   * the eased talk weight back; null: the flap as before (あ, full amplitude).
   */
  apply(delta: number, compose: ((speaking: number) => number) | null = null, face: MouthFace | null = null): void {
    const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.25) : 0;
    this.elapsed += dt;
    if (this.raw) { this.sinceTrue += dt; if (this.sinceTrue > STUCK_S) this.raw = false; }
    if (this.filler !== null) { this.fillerSince += dt; if (this.fillerSince > FILLER_STUCK_S) { this.filler = null; this.scale.setFiller(null); } }
    this.scale.setReply(this.raw);
    const held = this.hold.frame(dt, this.raw || this.filler !== null);
    this.held = held.mouth;
    this.value = damp(this.value, mouthTarget(held, this.elapsed, held.mouth ? this.scale.frame(dt, this.value) : 1), 16, dt);
    if (this.value < 0.002) this.value = 0;
    // I-175: lip-sync owns the opening while the held mouth is on (eased); the expression's open mouth gives way to it next frame.
    face?.setMouthTalk(this.talkEase.frame(dt, held.mouth));
    const talking = face ? talkThroughMouth(face.mouthBase, vowel => this.vowels[vowel] >= 0, this.knobs, this.gap?.openness ?? null) : null;
    this.scaleNow = talking ? talking.scale : 1;
    // Calibrated to her own lips; never parting them past the ceiling (relative: how far this vowel mix parts them against あ).
    const relative = talking ? talking.open / talking.scale : 1;
    let speaking = this.value * this.scaleNow * this.gain, capped = false;
    if (this.gap && Number.isFinite(this.gapCap)) {
      const cap = this.gapCap / (this.gap.fullGap * Math.max(relative, 1e-3));
      if (speaking > cap) { speaking = cap; capped = true; }
    }
    speaking = Math.min(1, speaking);
    this.reading = { aa: speaking * relative, floored: !!talking?.floored && this.value > 0.002, capped };
    this.shown = compose ? compose(speaking) : speaking;
    if (this.shown < 0.002) { this.shown = 0; this.shares.a = this.shares.i = this.shares.u = this.shares.e = this.shares.o = 0; return; }
    // A snack at her mouth opens あ (the companion's feeding mouth); otherwise the shares the base leans to.
    if (talking && !compose) vowelOpenings(this.shown, talking, this.shares);
    else { this.shares.a = this.shown; this.shares.i = this.shares.u = this.shares.e = this.shares.o = 0; }
    for (const vowel of VOWELS) {
      const index = this.vowels[vowel], value = this.shares[vowel];
      if (index < 0 || !(value > 0)) continue;
      const before = this.influences[index] ?? 0;
      if (!this.saved.some(entry => entry.index === index)) this.saved.push({ index, value: before });
      this.influences[index] = Math.max(before, value);
    }
  }
  /** What the mouth showed on her last frame (the speaking mouth, or composed with a snack), all vowels together. */
  get shownOpen(): number { return this.shown; }
  private shown = 0;
  /** I-175: the last frame's opening per vowel, and the amplitude scale the base gave it (1: no base). */
  get vowelShares(): Readonly<VowelWeights> { return this.shares; }
  get talkScale(): number { return this.scaleNow; }
  /**
   * 2026-11-22: what her lips did on the last frame: `aa` how far they parted as a share of this model's own あ at full (0..~1.2; the
   * journal's mouth-reading peaks), and whether the floor or the ceiling held it.
   */
  get lastReading(): Readonly<MouthReading> { return this.reading; }
  /** The calibration gain the flap runs at (1: not measured). */
  get flapGain(): number { return this.gain; }
  /** I-175: the eased "lip-sync owns the opening" (0..1). */
  get talk(): number { return this.talkEase.talk; }

  /** The window went away or another model came: nothing carries over. */
  reset(): void {
    this.restore(); this.hold.reset(); this.scale.reset(); this.talkEase.reset(); this.raw = false; this.filler = null; this.held = false; this.value = 0; this.shown = 0;
    this.shares.a = this.shares.i = this.shares.u = this.shares.e = this.shares.o = 0; this.scaleNow = 1;
    this.reading = { aa: 0, floored: false, capped: false };
  }
}

/**
 * I-174 item 8 (docs/claude/2026-11-21-i174-parity-fixes.md; survey docs/claude/2026-11-21-i175-layering-survey.md): one "is she speaking"
 * for the motion gates of both Unbound stages, the held value.
 *
 * Streamed reading turns the raw "she is speaking" flag off for 50–150 ms several times a second (src/voice/speech-hold.ts). The old stage's
 * owners read the held value (MmdStage speechOwned = SpeechHold.owner); the window's motion gates read the raw flag, so a pout or a cheek
 * puff passed in a gap and was cancelled 'speech' a frame later, fading out in 0.25 s before anyone saw it. Full-screen read the mouth's shorter hold. Both now read this: the same SpeechHold's `owner` (a gap under 0.4 s is one utterance,
 * below the host's 500 ms quiet window for a waiting mouth shape), true on the same frame speech starts. Pure, allocation-free.
 */
export class SpeechOwner {
  private readonly hold = new SpeechHold();
  private held = false;

  /** The raw flag changed between frames (a flicker shorter than a frame still counts). */
  note(raw: boolean): void { this.hold.note(raw); }
  /** Once per drawn frame, with the raw flag now; returns the held value. */
  frame(delta: number, raw: boolean): boolean { this.held = this.hold.frame(delta, raw).owner; return this.held; }
  /** What the motion gates read: speaking now, or still inside one utterance. */
  speaking(raw: boolean): boolean { return raw || this.held; }
  /** Nothing on screen or another model: no hold carries over. */
  reset(): void { this.hold.reset(); this.held = false; }
}
