/**
 * I-154 batch 2: her face in the companion window on Unbound's engine (docs/claude/2026-11-20-unbound-window-batch2.md; coverage table rows
 * 18, 19, 20, 21, 24, 36 in docs/claude/2026-11-19-unbound-in-window.md).
 *
 * The companion's own face layers, unchanged, with the companion's own gates, answering the same stage calls:
 *  - 心情的脸 (row 20) and 摸头 (row 21): MoodFeedback (src/mood/mood-feedback.ts): the smile and the troubled brow from her mood
 *    and its numbers, the touch reaction (her head following your hand, her enjoyed half-closed eyes, a long comfortable pat closing
 *    them almost shut, a serious mood never smiling into a pat), her small head motions and eye lifts, the mood's blush cue;
 *  - 说话时的脸 (row 18): SpeechFaceStage (src/voice/speech-face/): sparse accents on the eyes, brows and head while she speaks, from the
 *    voice's levels or the shown text; it never writes a mouth shape (lip-sync keeps the mouth) and gives way to a touch;
 *  - 等回复时思考 (row 19): ReplyThinking (src/brain/reply-thinking-stage.ts): a glance up and aside or a tilt, then a second pose;
 *  - 脸红 (row 24): BlushFollow (a flush rises and fades), painted on her face (ProceduralBlush, built by the stage) or the model's own
 *    blush morph, following the capability card exactly as the companion does;
 *  - 困了的脸 (row 36): FatiguePresentation (the tired lids) and DrowsyExpression (troubled brows, half lids, the chin down a little).
 *
 * What is different, on purpose: nothing here writes a bone or a morph. Every frame hands goals to the figure (window-body.ts): the
 * expression slots and named shapes through the intent layer's eased springs, the head through its head spring, the lids through the
 * window's critically damped lids, the look through the eye-head coordinator. So a layer that resets (a new conversation, a lost scope,
 * another model) can never make her face jump: what shows walks to the new goal. The one exception is the blush preview, which shows
 * the slider's value at once, as the companion's does (it is a setting preview, not her face).
 *
 * Plus the one small entry 「边说边演」 will drive: show(name) (window-expression.ts).
 * Pure: no DOM, no three.js objects; the stage feeds it, tests run it on the real frame loop.
 */
import { EMPTY_CONTACT, MoodFeedback, type MoodContact } from '../../mood';
import { ReplyThinking } from '../../brain';
import { SpeechFaceStage, speechFaceContext } from '../../voice';
import { BlushFollow, BlushSeen, DROWSY_PHASES, DrowsyExpression, FatiguePresentation, NEUTRAL_FATIGUE_FRAME, type BlushStageState, type CapabilityPreviewFrame, type FatigueFrame } from '../../stage';
import { previewClosure, previewMouth } from './window-capability';
import { capabilityEnabled, deriveModelCapabilities, type ModelCapabilities } from '../../../shared/stage';
import type { MoodView } from '../../../shared/mood';
import type { MorphSlot } from '../../../shared/actions';
import { uiText } from '../../foundation/ui-language';
import type { Rot } from '../motion/generator';
import { WindowExpressions, type ShowExpressionOptions, type ShowExpressionResult } from './window-expression';
import { WindowBeats } from './window-beats';
import { speechBeatGatesOf } from '../speech-beat-player';
import type { HandTargets } from '../arm-reach';
import { NO_FACE_BLOCKS, type FaceBlocks, type WindowFaceRig } from './window-face-rig';
import { WindowPinch } from './window-pinch';
import { dominantExpression } from './mouth-reading-log';
import type { MouthReadingWord } from '../../../shared/stage';

export interface WindowFaceEnv {
  /** She is on screen (the window shown, the page visible, a model drawn). */
  shown: boolean;
  /** A camera adjust or a pull holds her: the face's own motions step aside (the companion's "window / camera adjust"). */
  adjusting: boolean;
  /** The held "she is speaking" (her mouth's hold: a stream's short stall is one utterance). */
  voiced: boolean;
  /** Any source says she is speaking now. */
  speaking: boolean;
  /** A pull or a held hand owns her arms: a beat's hand gives way (and none starts). */
  armsHeld?: boolean;
  /** Batch 3: her height (m), for the pinch's shifts; absent: 1.6. */
  heightM?: number;
  /** Batch 3: the blush her procedural life would show (window-proc-life.ts); it rises and fades through the same follower. */
  lifeBlush?: number;
  /** Batch 7 (row 42 试一下): this frame's capability preview amounts (window-capability.ts); absent: none. */
  capability?: CapabilityPreviewFrame;
}
export interface WindowFaceGaze {
  /** How much of the cursor's pull on her look remains (a touch draws her attention; a thinking look replaces it). */
  pull: number;
  /** A look offset in the cursor's units (-1..1, y up): her thinking glance. */
  x: number; y: number;
  /** Tired: a weaker, slower look; asleep: none. */
  strength: number; allowed: boolean;
  /** The mood's own small eye motions (rad, + = her left / down). */
  eyeYaw: number; eyePitch: number;
}
export interface WindowFaceFrame {
  /** Expression slot goals 0..1 (calibrated), eased by the figure's slot springs. */
  expr: Partial<Record<MorphSlot, number>>;
  /** Named shapes outside the slots (an expression's extras), eased the same way. */
  exprNamed: Record<string, number>;
  /** Added to her head goal (rad, PoseTargets' frame). */
  head: Rot;
  /** Added to her upper body goal (a beat's lean; she never walks here). */
  torso: Rot;
  /** Batch 3: added to her neck goal (the pinch carrying her head; the sleep pose's droop), and her hips (the pinch, m); absent: none. */
  neck?: Rot;
  pelvis?: { lateral: number; forward: number; vertical: number };
  /** Batch 3 (row 23 喂食): the snack's mouth and how much it owns the mouth (composed with the speaking mouth, mouth.ts); absent: none. */
  mouth?: { value: number; owner: number } | null;
  /** Batch 3: a pinch (or the sleep body) holds her: her learned idle steps aside as it does for a pat. */
  performing?: boolean;
  /** A beat's hand at her cheek or a V, for the figure's arm reach; null: none (the reach eases back). */
  hands: HandTargets | null;
  gaze: WindowFaceGaze;
  /** An enjoyed closure (a pat): natural blinks wait while it holds. */
  lids: number;
  /** A soft closure (tired lids, a thinking look down, an accent): natural blinks go on over it. */
  softLids: number;
  /** Batch 4 (慢慢眨眼): a performed blink, shown over the natural one (no natural one starts while it shows); absent: none. */
  blink?: number;
  /** The mood answers a pat (smile, lids, head): the window's simple pat steps aside. */
  ownsPat: boolean;
  /** The blush to paint this frame (0..1, before the paint's depth curve) and how it is shown. */
  blush: number;
  blushPath: 'painted' | 'morph' | 'none';
  blushSize: number;
}
export const NEUTRAL_GAZE: Readonly<WindowFaceGaze> = Object.freeze({ pull: 1, x: 0, y: 0, strength: 1, allowed: true, eyeYaw: 0, eyePitch: 0 });
/** How long a "speech is about to start" lasts without a word (a lost "idle" never holds the mouth for long), s. */
export const PREPARE_HOLD_S = 15;
/** How long the blush slider's preview shows (s), as the companion's. */
export const BLUSH_PREVIEW_S = 3;

const ZERO_ROT: Rot = Object.freeze({ pitch: 0, yaw: 0, roll: 0 }) as Rot;
const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;

export class WindowFace {
  private rig: WindowFaceRig | null = null;
  private generation = 0;
  private view: MoodView | null = null;
  private contact: MoodContact = { ...EMPTY_CONTACT };
  private card: ModelCapabilities | null = null;
  private derived: { profile: WindowFaceRig['profile']; card: ModelCapabilities | null } | null = null;
  private blocks: FaceBlocks = NO_FACE_BLOCKS;
  private painted = false;
  private t = 0;
  private prepare = { local: -Infinity, remote: -Infinity };
  private previewUntil = -Infinity;
  private readonly feedback = new MoodFeedback();
  private readonly fatigue = new FatiguePresentation();
  private readonly drowsy = new DrowsyExpression();
  private readonly follow = new BlushFollow();
  /** 体验记录 (I-176 prep, audit row 6): told once per blush cue, whether her blush could be shown (the old stage's, src/stage/blush-seen.ts); set by the stage. */
  private readonly blushSeen = new BlushSeen();
  onBlushCue: ((state: BlushStageState) => void) | null = null;
  /** Row 22 捏脸 (window-pinch.ts). */
  private readonly pinch = new WindowPinch();
  readonly expressions = new WindowExpressions();
  /** 边说边演: her reply's beats, through the showcase performer (window-beats.ts). */
  readonly beats = new WindowBeats();
  private mouthWordNow: MouthReadingWord = 'none';
  /** The expression holding her face on the last frame (an asked one or her reply's beats; 'none'), for the mouth-reading log. */
  get mouthWord(): MouthReadingWord { return this.mouthWordNow; }
  private thinking?: ReplyThinking;
  private speech?: SpeechFaceStage;
  private fatigueFrame: FatigueFrame = NEUTRAL_FATIGUE_FRAME;
  private last: WindowFaceFrame | null = null;

  // ---- what the stage tells it ------------------------------------------------------------------------------------------------
  /** A model was loaded (or none): its slots. Nothing of the old model's face carries over (what shows eases to the new goals). */
  attach(rig: WindowFaceRig | null): void {
    this.rig = rig; this.generation++; this.derived = null; this.painted = false;
    this.feedback.reset(); this.fatigue.reset(); this.drowsy.reset(); this.expressions.reset(); this.speech?.reset(); this.beats.release(); this.pinch.reset();
  }
  /** The stage built (or dropped) the painted blush for this model. */
  setPainted(on: boolean): void { this.painted = on === true; }
  setMood(view: MoodView | null): void {
    const before = this.view;
    const context = !!before && !!view && (before.characterId !== view.characterId || before.token !== view.token);
    if (context) {
      // Another conversation or character: the old face's layers start over, an unplayed accent or expression is dropped (never
      // played later), and what shows eases to the new goals.
      this.feedback.reset(); this.fatigue.reset(); this.drowsy.reset(); this.speech?.cancel('new-scope'); this.expressions.release();
      this.beats.release(); this.pinch.reset(); this.contact = { ...EMPTY_CONTACT }; // the companion's: a new conversation drops the old touch
      this.previewUntil = -Infinity;
      if (before.characterId !== view.characterId) this.thinking?.set(null);
    }
    this.view = view;
  }
  setContact(contact: MoodContact | null): void { this.contact = contact ? { ...contact } : { ...EMPTY_CONTACT }; }
  /** I-024: the model's capability card from the host (null: derived from the profile until it comes). */
  setCard(card: ModelCapabilities | null): void { this.card = card ?? null; }
  setBlocks(blocks: FaceBlocks): void { this.blocks = blocks; }
  /** T-215: speech is about to start (or no longer), from this window or the other one. */
  setPreparing(active: boolean, source: 'local' | 'remote' = 'local'): void { this.prepare[source === 'remote' ? 'remote' : 'local'] = active === true ? this.t : -Infinity; }
  /** I-073 part 3: a fact from the voice output or the bubble. Malformed ones are ignored (SpeechFaceStage checks). */
  speechCue(cue: unknown): void { (this.speech ??= new SpeechFaceStage()).cue(cue); }
  /** Batch 6 (row 37): the speaking-accent layer the song reactions perform on (made on first use, as on the old stage), and whether it exists. */
  musicFace(): SpeechFaceStage { return (this.speech ??= new SpeechFaceStage()); }
  get hasSpeechFace(): boolean { return !!this.speech; }
  /** X1: the accepted reply still waiting for its first word, or null. */
  setThinking(key: string | null): void { if (key === null && !this.thinking) return; (this.thinking ??= new ReplyThinking()).set(key); }
  /** Trusted scope loss: no view, nothing of it comes back; what shows eases away. */
  invalidate(): void {
    this.view = null; this.contact = { ...EMPTY_CONTACT };
    this.feedback.reset(); this.fatigue.reset(); this.drowsy.reset(); this.speech?.cancel('scope-lost'); this.expressions.release();
    this.beats.release(); this.pinch.reset(); this.previewUntil = -Infinity;
  }
  /** The window was hidden (nothing is drawn): accents and the thinking look are dropped, as the companion's; nothing replays later. */
  hide(): void { this.speech?.reset(); this.thinking?.hide(); this.beats.release(); }
  /** The blush slider's preview: false when it cannot show now (the companion's rules). */
  previewBlush(): boolean {
    const view = this.view;
    if (!this.rig || !view?.expressions || !view.parameters.blush.enabled || this.blocks.face) return false;
    this.previewUntil = this.t + BLUSH_PREVIEW_S; return true;
  }
  clearBlushPreview(): void { this.previewUntil = -Infinity; }
  /** 边说边演: one word of her reply, now (window-beats.ts); false when it is not shown here or cannot start now. */
  speechBeat(word: string, shown = true, armsHeld = false, span: boolean | 'line' = false): boolean {
    const card = this.capabilities(); // I-185: a hug brings her arms only on a model with arms (the capability card's 能做手势)
    return this.beats.play(word, speechBeatGatesOf(this.view, shown && !!this.rig, armsHeld), span, card ? { arms: card.gesture.enabled } : null);
  }
  /** 边说边演: her speaking of this reply is over (or cancelled, or a new reply began): the beats that stayed up fall now. */
  speechBeatsRelease(): void { this.beats.releaseSpan(); }
  /** I-175: a 'line' beat's sentence reached its pause ("只带这一句"): only the beats held to the line fall. */
  speechBeatsLine(): void { this.beats.releaseLine(); }
  /** 「边说边演」's entry: show this expression now, eased (window-expression.ts). */
  show(name: string, options: ShowExpressionOptions = {}, shown = true): ShowExpressionResult {
    return this.expressions.show(name, options, { shown: shown && !!this.rig, asleep: this.view?.fatigue?.sleeping === true, faceOwned: this.blocks.face });
  }

  // ---- what it reads back -----------------------------------------------------------------------------------------------------
  get preparing(): boolean { return this.t - this.prepare.local < PREPARE_HOLD_S || this.t - this.prepare.remote < PREPARE_HOLD_S; }
  get thinkingActive(): boolean { return this.thinking?.active === true; }
  /** The blush slider's preview is showing. */
  get previewing(): boolean { return this.previewUntil > this.t; }
  /** The card in use: the host's, else derived from this model's profile (no user choices); null without either. */
  capabilities(): ModelCapabilities | null {
    if (this.card) return this.card;
    if (this.rig?.card) return this.rig.card; // I-164: a VRM's own card (window-face-rig.ts)
    const profile = this.rig?.profile ?? null;
    if (!profile) return null;
    if (this.derived?.profile !== profile) { let card: ModelCapabilities | null = null; try { card = deriveModelCapabilities(profile); } catch { card = null; } this.derived = { profile, card }; }
    return this.derived.card;
  }
  /** 'off': the user turned 能脸红 off; otherwise the morph her blush is shown on (-1: painted, or none). */
  blushOff(): boolean { return this.capabilities()?.blush?.choice === 'off'; }
  /** The model's own blush morph this model shows: the card's (another model with 能脸红 on), else the old channel; -1 when none or off. */
  cardBlush(): number {
    const rig = this.rig;
    return rig && !rig.reviewed && rig.shy >= 0 && capabilityEnabled(this.capabilities(), 'blush') ? rig.shy : -1;
  }
  /** Whether the stage should paint the blush on her face (not when it is off or the card picked her own morph). */
  wantsPainted(): boolean { return !!this.rig && !this.blushOff() && this.cardBlush() < 0; }
  /** The morph the `shy` slot is bound to (the stage rebinds when it changes). */
  blushMorph(): number {
    if (!this.rig || this.blushOff()) return -1;
    const card = this.cardBlush();
    return card >= 0 ? card : this.painted ? -1 : this.rig.blushChannel;
  }
  fatigueEyelidsAllowed(): boolean {
    const rig = this.rig, card = this.capabilities();
    if (!rig) return false;
    return rig.reviewed ? card?.closeEyes?.choice !== 'off' : capabilityEnabled(card, 'closeEyes') && rig.slots.blink !== undefined;
  }
  drowsyFaceAllowed(): boolean {
    const rig = this.rig, card = this.capabilities();
    if (!rig) return false;
    return rig.reviewed ? card?.drowsyFace?.choice !== 'off' : capabilityEnabled(card, 'drowsyFace');
  }
  /** The developer line of what her face cannot show here (getMoodDegradation). */
  degradation(blushSupport: string, tearsReason = ''): string {
    const rig = this.rig, view = this.view;
    if (!rig) return uiText('当前模型缺少可识别头骨');
    const notes = [
      this.blocks.head ? uiText('手选头部动作保持播放，自动情绪姿态让位；直接 rua 附加仍保留') : '',
      this.blocks.face ? uiText('手选表情优先，自动面部让位') : !rig.smile ? uiText('未识别到笑意 morph，使用眼神和姿态') : '',
      this.blushOff() ? uiText('角色页关了"能脸红"：脸红不开') : this.blushMorph() < 0 && !this.painted ? blushSupport : '',
      view?.fatigue && !this.fatigueEyelidsAllowed() ? uiText('体检卡没开"能闭眼"：疲倦眼皮不开') : '',
      view?.fatigue?.phase === 'drowsy' && !this.drowsyFaceAllowed() ? uiText('体检卡没开"困的脸"：困的脸不开') : '',
      tearsReason || uiText('泪水定位尚未就绪'), // batch 6: why tears show or not on this model (window-blush.ts)
    ];
    return notes.filter(Boolean).join('；');
  }
  /**
   * Batch 3: her face's owners now, for procedural life and the sleep layers (window-liveliness.ts): a direct touch (with the pinch
   * easing back, as the companion's residual), a hand on her head or cheek, the picked face / head / mouth, the tired frame of the last
   * frame, the card's 能做睡姿, and whether a snack owns her mouth.
   */
  owners(): { contact: boolean; touched: boolean; face: boolean; head: boolean; mouth: boolean; gazeAllowed: boolean; fatigueFace: boolean; sleepCapable: boolean; feeding: boolean } {
    const c = this.contact, pinching = c.pinch?.pinching === true;
    return { contact: c.contact || c.feeding || pinching || this.pinchShown || (c.hover ?? 0) > 0 || this.feedback.patHolding, touched: c.contact || pinching,
      face: this.blocks.face, head: this.blocks.head, mouth: this.blocks.mouth, gazeAllowed: this.fatigueFrame.gazeAllowed !== false,
      fatigueFace: this.fatigueFrame.eyelids > 0.01 || this.drowsy.active, sleepCapable: !!this.rig && capabilityEnabled(this.capabilities(), 'sleepPose'),
      feeding: (this.last?.mouth?.owner ?? 0) > 0.01 };
  }
  private pinchShown = false;
  getState(): Record<string, unknown> {
    const frame = this.last;
    return { view: !!this.view, blocks: this.blocks, preparing: this.preparing, thinking: this.thinking?.getState() ?? null, speech: this.speech?.getState() ?? null,
      fatigue: this.fatigueFrame, drowsy: this.drowsy.active, shows: this.expressions.names, blush: frame?.blush ?? 0, blushPath: frame?.blushPath ?? 'none',
      expr: frame?.expr ?? {}, lids: frame?.lids ?? 0, softLids: frame?.softLids ?? 0 };
  }

  // ---- every frame ------------------------------------------------------------------------------------------------------------
  frame(delta: number, env: WindowFaceEnv): WindowFaceFrame {
    const dt = Number.isFinite(delta) ? clamp(delta, 0, 0.1) : 0;
    this.t += dt;
    const rig = this.rig, view = rig ? this.view : null, blocks = this.blocks;
    const pinching = this.contact.pinch?.pinching === true;
    // 捏脸 (row 22): the companion's pinch layer, its frame as goals; while any of it still shows it counts as a touch (the companion's residual).
    const pinch = this.pinch.frame(dt, this.contact, view, env.heightM ?? 1.6, blocks);
    this.pinchShown = pinch.active;
    const direct = this.contact.contact || this.contact.feeding || pinching || pinch.active || (this.contact.hover ?? 0) > 0 || this.feedback.patHolding;
    const sleeping = view?.fatigue?.sleeping === true;
    const s = view?.snapshot;

    // 心情的脸 and 摸头: the companion's mood feedback, with the same inputs.
    const contact = this.contact.pinch ? { ...this.contact, contact: false, hover: 0 } : this.contact;
    const fb = view && s ? this.feedback.frame(dt, contact, { mood: s.primary, companion: s.companion, phase: s.phase,
      expressive: view.expressions, face: s.intensity.expression, posture: s.intensity.posture,
      gaze: sleeping ? 0 : s.intensity.gaze, playful: s.companion === 'playful' ? s.intensity.playful : 0,
      context: s.context, trend: s.trend, fast: s.fast, event: s.event, blush: s.blush,
      fastThreshold: view.parameters.fastThreshold, trendResponse: view.parameters.evidence.trend,
      attention: s.cue?.kind === 'look' || s.cue?.kind === 'motion', gesture: view.idleGesture, feed: view.feedCue,
      responding: !!s.cue && s.cue.kind !== 'speech', values: s.values, longing: s.longing }, blocks.face, !sleeping && !blocks.head, blocks.mouth) : null;

    // 困了: the tired lids (the card decides for another model) and the drowsy face.
    this.fatigueFrame = view ? this.fatigue.frame(view.fatigue, dt, { verifiedGene: rig!.reviewed, eyelids: this.fatigueEyelidsAllowed(),
      expressions: view.expressions === true, faceBlocked: blocks.face, contact: this.contact.contact === true || pinching }) : (this.fatigue.reset(), NEUTRAL_FATIGUE_FRAME);
    const fatigue = this.fatigueFrame;
    const drowsy = this.drowsyFrame(dt, env, fb, direct);
    const fatigueFace = fatigue.eyelids > 0.01 || drowsy.active;

    // 等回复时思考: the companion's gates (only in the idle phase, not while she speaks, is touched, adjusted, tired past looking, asleep).
    const thinking = this.thinking;
    if (thinking) {
      const shown = !!view && view.expressions === true && s?.phase === 'idle' && env.shown && !env.voiced && !env.adjusting && !direct
        && fatigue.gazeAllowed !== false && !sleeping;
      thinking.frame(dt, { owner: rig, character: view ? { seedKey: view.characterId, weights: view.parameters?.weights, intensity: s?.intensity, companion: s?.companion } : null,
        gates: { head: shown && !blocks.head && !drowsy.active, gaze: shown && !blocks.face, face: shown && !blocks.face && !(fatigue.eyelids > 0.01) } });
    }
    const think = thinking?.out;

    // 说话时的脸: accents on eyes, brows and head; never a mouth shape; they yield to a touch, an adjust, a picked face or head.
    const blushPath: WindowFaceFrame['blushPath'] = !rig || this.blushOff() ? 'none' : this.blushMorph() >= 0 ? 'morph' : this.painted ? 'painted' : 'none';
    let accent = { smileEyes: 0, browUp: 0, jitome: 0, blush: 0, headX: 0, headZ: 0, eyeWide: 0, lidSoft: 0 };
    if (this.speech && rig) {
      const face = speechFaceContext(this.speech, view, false)!;
      const ok = (slot: MorphSlot) => { const index = rig.slots[slot]; return index !== undefined && !rig.mouthShapes.includes(index); };
      const expressive = !!view && view.expressions === true;
      const out = face.frame(dt, { face: env.shown && expressive && !blocks.face && !direct && !env.adjusting, head: env.shown && expressive && !blocks.head && !direct && !env.adjusting && !sleeping,
        speaking: env.voiced, available: { smileEyes: ok('smileEyes'), browUp: ok('browUp'), jitome: !fatigueFace && ok('jitome'), blush: blushPath !== 'none', head: true,
          eyeWide: ok('surprise'), lidSoft: !fatigueFace } });
      accent = { smileEyes: out.smileEyes, browUp: out.browUp, jitome: out.jitome, blush: out.blush, headX: out.headX, headZ: out.headZ, eyeWide: out.eyeWide ?? 0, lidSoft: out.lidSoft ?? 0 };
    }

    // An expression asked for (「边说边演」): its mouth shapes step aside while she speaks or is about to.
    const shows = this.expressions.frame(dt, env.speaking || env.voiced || this.preparing);
    // 边说边演: her reply's beats (their mouth shapes step aside for speech the same way).
    const beat = this.beats.frame(dt, { armsHeld: env.armsHeld === true, asleep: sleeping, speaking: env.speaking || env.voiced || this.preparing }); // I-185: a kiss's pucker waits for the pause
    this.expressions.yieldMouth(beat.slots, beat.named);
    this.mouthWordNow = dominantExpression(shows.face, this.beats.lastFace); // 2026-11-22 嘴型记录: which expression holds her face

    // 脸红: every natural blush passes the follower (rises and fades like a flush); the slider preview shows at once.
    const size = view?.parameters.blush.size ?? 50;
    const preview = this.previewUntil > this.t && !!view?.expressions && view.parameters.blush.enabled && !blocks.face;
    const natural = this.follow.frame(blocks.face ? 0 : Math.max(fb?.blush ?? 0, accent.blush, shows.face.blush, beat.blush, env.lifeBlush ?? 0), dt);
    const cap = env.capability;
    // 试一下 能脸红 (batch 7): the preview's own envelope, unless 能脸红 is off (blushPath 'none' then).
    const blush = blushPath === 'none' ? 0 : Math.max(size === 0 ? 0 : preview ? clamp((view?.parameters.blush.intensity ?? 0) / 100, 0, 1) : natural, cap?.blush ?? 0);
    const seen = this.blushSeen.observe(s?.blush?.id, { path: blushPath === 'painted' ? 'procedural' : blushPath, faceBlocked: blocks.face, off: this.blushOff(), size });
    if (seen) { try { this.onBlushCue?.(seen); } catch { /* a record only */ } }

    // The goals. Mood and accents and expressions add up per slot (max, accents on top as the companion's), then the profile's calibration.
    const raw: Partial<Record<MorphSlot, number>> = {};
    const put = (slot: MorphSlot | null, value: number, add = false) => {
      if (!slot || !rig || rig.slots[slot] === undefined || !(value > 0)) return;
      raw[slot] = add ? (raw[slot] ?? 0) + value : Math.max(raw[slot] ?? 0, value);
    };
    if (fb && rig) {
      put(rig.smile, Math.max(fb.smile, pinch.smile)); // the companion's: the pinch's picked smile and the mood's, the larger
      put('sad', Math.max(fb.sadness, drowsy.brow));
    } else put('sad', drowsy.brow);
    put('jitome', drowsy.eyeShape);
    for (const [slot, value] of Object.entries(shows.slots) as [MorphSlot, number][]) if (slot !== 'shy') put(slot, value);
    for (const [slot, value] of Object.entries(beat.slots) as [MorphSlot, number][]) if (slot !== 'shy') put(slot, value);
    const named = { ...shows.named };
    for (const [name, value] of Object.entries(beat.named)) named[name] = Math.max(named[name] ?? 0, value);
    put('smileEyes', accent.smileEyes, true); put('browUp', accent.browUp, true); put('jitome', accent.jitome, true); put('surprise', accent.eyeWide, true);
    const expr: Partial<Record<MorphSlot, number>> = {};
    for (const [slot, value] of Object.entries(raw) as [MorphSlot, number][]) {
      const index = rig!.slots[slot]!;
      expr[slot] = clamp(value * (rig!.scales.get(index) ?? 1), 0, 1);
    }
    if (blushPath === 'morph' && blush > 0) expr.shy = clamp(blush, 0, 1);

    const frame: WindowFaceFrame = {
      expr, exprNamed: named,
      head: fb || think || accent.headX || accent.headZ || drowsy.headX || beat.head.pitch || beat.head.yaw || beat.head.roll || pinch.active ? {
        pitch: (fb?.headX ?? 0) + (think?.headX ?? 0) + accent.headX + drowsy.headX + beat.head.pitch + pinch.head.pitch,
        yaw: (fb?.headY ?? 0) + (think?.headY ?? 0) + beat.head.yaw + pinch.head.yaw,
        roll: -((fb?.headZ ?? 0) + (think?.headZ ?? 0) + accent.headZ) + beat.head.roll + pinch.head.roll,
      } : ZERO_ROT,
      torso: pinch.active ? { pitch: beat.torso.pitch + pinch.torso.pitch, yaw: beat.torso.yaw + pinch.torso.yaw, roll: beat.torso.roll + pinch.torso.roll } : beat.torso,
      hands: beat.hands,
      neck: pinch.neck, pelvis: pinch.pelvis, performing: pinch.active,
      // 喂食 (row 23): the companion's snack mouth (open as it nears, the "mm" chew after the bite) and its owner weight.
      mouth: cap ? previewMouth(cap, fb && (fb.mouth > 0 || fb.mouthOwner > 0) ? { value: fb.mouth, owner: fb.mouthOwner } : null)
        : fb && (fb.mouth > 0 || fb.mouthOwner > 0) ? { value: fb.mouth, owner: fb.mouthOwner } : null, // batch 7: 试一下 有口型 through the same channel
      gaze: { pull: (fb?.gazeScale ?? 1) * (1 - (think?.gazeBlend ?? 0)) * (1 - beat.gaze.away), x: think?.gazeX ?? 0, y: think?.gazeY ?? 0,
        strength: fatigue.gazeStrength, allowed: fatigue.gazeAllowed,
        eyeYaw: (fb?.eyeYaw ?? 0) + beat.gaze.yaw + beat.gaze.away * beat.gaze.awayYaw, eyePitch: (fb?.eyePitch ?? 0) + beat.gaze.pitch + beat.gaze.away * beat.gaze.awayPitch },
      // the pinch's squint is an enjoyed closure, as the companion's lid compositor takes it; 试一下 能闭眼 (batch 7) the same way
      lids: Math.max(fb?.eyelids ?? 0, pinch.lids, cap ? previewClosure(cap, this.capabilities()) : 0),
      softLids: Math.max(fatigue.eyelids, think?.lidSoft ?? 0, accent.lidSoft, beat.softLids), blink: beat.blink, // batch 4: 慢慢眨眼
      ownsPat: !!fb,
      blush, blushPath, blushSize: size,
    };
    this.last = frame;
    this.moodReadout = view && s && fb ? { phase: s.phase, primary: s.primary, companion: s.companion, head: [fb.headX, fb.headY, fb.headZ], hover: this.contact.hover ?? 0,
      contact: fb.contact, activeContact: this.contact.contact, eyelids: fb.eyelids, smile: fb.smile, mouth: fb.mouth, blush, blushSize: size, blushPath,
      faceBlocked: blocks.face, mouthBlocked: blocks.mouth, headBlocked: blocks.head } : null;
    return frame;
  }
  /** The cheek pinch layer's last frame and input (the developer readout, window-readouts.ts). */
  get pinchReadout(): Record<string, unknown> | null { return this.pinch.latest; }
  /** The mood feedback of the last frame, for the developer readout (window-readouts.ts); null without a mood view. */
  moodReadout: Record<string, unknown> | null = null;

  /** The companion's drowsy face (src/stage/mmd/mood.ts drowsyFrame), on this model's slots. */
  private drowsyFrame(dt: number, env: WindowFaceEnv, fb: ReturnType<MoodFeedback['frame']> | null, direct: boolean): { headX: number; brow: number; eyeShape: number; active: boolean } {
    const view = this.view, rig = this.rig, none = { headX: 0, brow: 0, eyeShape: 0, active: false };
    // 试一下 困的脸 (batch 7): holds the drowsy phase a moment (then the face eases back out by itself), as the old stage's drowsyFrame.
    const held = env.capability?.drowsy === true, phase = held ? 'drowsy' : view?.fatigue?.phase, F = held ? 0.9 : view?.fatigue?.F;
    if (!rig?.drowsy || !view || !this.drowsyFaceAllowed() || view.expressions !== true || !view.characterId || !view.token
      || typeof F !== 'number' || !Number.isFinite(F) || F < 0 || F > 1 || !DROWSY_PHASES.includes(phase ?? '')
      || (phase !== 'drowsy' && !this.drowsy.active)) { this.drowsy.reset(); return none; }
    const blocks = this.blocks, behavior = view.behavior;
    const authored = !!behavior?.state || !!behavior?.reaction;
    const face = !blocks.face && !direct && !env.adjusting && !authored && (view.snapshot.intensity.expression ?? 0) > 0;
    const head = !blocks.head && !direct && !env.adjusting && !view.gesture && (view.snapshot.intensity.posture ?? 0) > 0;
    const closure = clamp(Math.max(fb?.eyelids ?? 0, this.fatigueFrame.eyelids), 0, 1);
    const frame = this.drowsy.frame(dt, { scope: JSON.stringify([view.characterId, view.token, this.generation]), verified: env.shown, phase: phase ?? null, F,
      headAllowed: head, browAllowed: face && rig.drowsy.brow && (fb?.sadness ?? 0) === 0, eyeAllowed: face && rig.drowsy.eye && (fb?.smile ?? 0) === 0,
      finalClosure: closure });
    return { headX: frame.headX, brow: frame.brow, eyeShape: frame.eyeShape, active: frame.active };
  }
}
