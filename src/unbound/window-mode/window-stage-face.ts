/**
 * I-154: the stage members of her face (batch 2: speaking, thinking, the card, the blush and its calibration; the 「边说边演」 entries) for the
 * Unbound window stage, between her motions' members (window-stage-motions.ts) and the stage (window-stage.ts). Moved out of window-stage.ts
 * unchanged on 2026-11-20 (batch 5), so the stage file stays a wiring file. Her face itself is WindowFace (window-face.ts).
 */
import type { StageOptions, StageSurface } from '../../stage';
import type { WindowBody } from './window-body';
import type { WindowFace } from './window-face';
import { slotBindings, type WindowFaceRig } from './window-face-rig';
import type { WindowBlushState } from './window-blush';
import type { WindowPace } from './window-pace';
import type { ShowExpressionOptions, ShowExpressionResult } from './window-expression';
import { WindowStageMotions } from './window-stage-motions';
import { windowTearsGate } from './window-tears';
import { ShownSentence } from '../../../shared/behaviors/part-mix/closed-mouth';
import type { SpeechBeatRelease } from '../../../shared/brain';
import { MouthReadingLog } from './mouth-reading-log';

type S = StageSurface;

/** I-175: the bubble's own cue (read-aloud off: `{ kind: 'start', key: '<id>#shown', text, voiced: false }`) is what the bubble shows now. */
export function noteShown(watch: ShownSentence, cue: unknown, now = Date.now() / 1000): void {
  const c = cue as { kind?: unknown; key?: unknown; text?: unknown; voiced?: unknown } | null;
  if (c && c.kind === 'start' && c.voiced !== true && typeof c.key === 'string' && c.key.endsWith('#shown') && typeof c.text === 'string') watch.note(c.text, now);
  else if (c && c.kind === 'stop') watch.reset();
}

export abstract class WindowStageFace extends WindowStageMotions {
  protected abstract readonly face: WindowFace;
  protected abstract readonly blush: WindowBlushState;
  protected abstract readonly pace: WindowPace;
  protected abstract body: WindowBody | null;
  protected abstract faceRig: WindowFaceRig | null;
  protected abstract modelUrl: string;
  protected abstract readonly options: StageOptions;
  /** 2026-11-22 嘴型记录 (mouth-reading-log.ts): per stretch of a reply read aloud, the expression and how far her lips parted; one line per reply to the stage's onMouthReading. */
  protected readonly mouthLog = new MouthReadingLog(entry => this.options.onMouthReading?.(entry));
  /** She is drawn now (not disposed, the window shown, the page visible). */
  protected abstract faceShown(): boolean;
  /** A pull, the game, an offer or her reach holds her arms (a beat's hand word does not start). */
  protected abstract armsHeldNow(): boolean;

  /** T-215: speech is about to start (or no longer): an expression's mouth shapes step aside before the first sound. */
  setSpeechPreparing(active: boolean, source: Parameters<S['setSpeechPreparing']>[1] = 'local'): void { this.face.setPreparing(active, source === 'remote' ? 'remote' : 'local'); if (active) this.pace.wake('speaking'); }
  /** I-073 part 3: a fact from the voice output or the bubble, from this window or the other one. I-175: the bubble's "#shown" text says whether a sentence is still being shown. */
  speechFaceCue(cue: unknown): void { this.face.speechCue(cue); this.pace.wake('speaking'); noteShown(this.shownSentence, cue); }
  /** I-175: read-aloud off, the bubble in the middle of a sentence (a closed-mouth shape waits for its end; window-stage-env.ts motionEnv). */
  protected readonly shownSentence = new ShownSentence();
  /** X1: the reply still waiting for its first word (her thinking look), or null to release it. */
  setReplyThinking(key: string | null): void { this.face.setThinking(key); if (key) this.pace.wake('expression'); }
  /** I-024: the model's capability card (its eyelids, blush, drowsy face follow it as the companion's do). */
  setModelCapabilities(card: Parameters<S['setModelCapabilities']>[0]): void { this.face.setCard(card ?? null); this.refreshBlush(); }
  getMoodDegradation(): string { return this.face.degradation(this.blush.painter?.reason ?? '', this.blush.painter?.tearsReason ?? ''); }
  getBlushSupport(): string { return this.blush.painter?.reason ?? ''; }
  setBlushCalibration(value: Parameters<S['setBlushCalibration']>[0], modelUrl: string): void {
    this.blush.setCalibration(value, modelUrl);
    this.face.clearBlushPreview(); this.blush.previewing = false;
    if (modelUrl === this.modelUrl) this.refreshBlush(true);
  }
  /** The calibration slider's preview: her blush measured with these values, shown at the slider's amount for a moment. */
  previewBlush(value: Parameters<S['previewBlush']>[0]): void {
    const painter = this.blush.painter;
    if (!painter || !this.face.wantsPainted() || !this.face.previewBlush()) return;
    this.face.setPainted(painter.build(value, true, true)); this.blush.previewing = true; this.pace.wake('expression');
  }
  clearBlushPreview(): void { this.face.clearBlushPreview(); if (this.blush.previewing) { this.blush.previewing = false; this.refreshBlush(true); } }
  /**
   * 「边说边演」's entry on this engine (window-expression.ts): show one of the showcase's expressions now, eased in and out by her
   * face's springs. Refused while she is hidden or asleep or a picked expression owns her face; while she speaks its mouth steps aside.
   */
  showExpression(name: string, options: ShowExpressionOptions = {}): ShowExpressionResult {
    const result = this.face.show(name, options, this.faceShown());
    if (result.ok) this.pace.wake('expression');
    return result;
  }
  /**
   * 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md): one word of her reply, as the wiring reaches it; every word through the showcase
   * performer (window-beats.ts). false: not now (hidden, asleep, a hand word while a pull, the game, an offer or her reach holds her arms).
   */
  speechBeat(word: string, span: boolean | 'line' = false): boolean {
    const played = this.face.speechBeat(word, this.faceShown(), this.armsHeldNow(), span); // I-175: 'line' holds to the sentence's pause
    if (played) this.pace.wake('expression');
    return played;
  }
  /**
   * 边说边演: her speaking of this reply is over, or it was cancelled or a new reply began: the beats that stayed up fall now. I-175: a cancelled
   * or new reply also drops the closed-mouth shapes waiting for a pause (never played late); 'line' lets only the beats held to the sentence fall.
   */
  speechBeatsRelease(reason: SpeechBeatRelease = 'ended'): void {
    if (reason === 'line') { this.face.speechBeatsLine(); return; }
    if (reason === 'cancelled' || reason === 'new') this.motions.dropWaitingMouth();
    this.mouthLog.release();
    this.face.speechBeatsRelease();
  }
  /** The blush follows the card: painted on her face, or her own morph, or none (re-measured when the calibration changes); the tears too (batch 6). */
  protected refreshBlush(force = false): void {
    const body = this.body, rig = this.faceRig;
    if (!body || !rig) return;
    this.blush.refresh(this.face, morph => body.bindFace(slotBindings(rig, morph)), this.modelUrl, force);
    this.blush.painter?.setTearsGate(windowTearsGate(rig.reviewed, this.face.capabilities())); // batch 6 (row 25): who may cry follows the card
  }
}
