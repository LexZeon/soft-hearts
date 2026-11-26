/**
 * The options the wiring gives a stage when it makes it (both windows): callbacks out of the stage, and the few settings it needs at
 * construction. Moved here out of the deleted old stage (src/stage/MmdStage.ts, I-176 step 3, docs/claude/2026-11-23-i176-delete.md)
 * unchanged, except that the I-031 colour-block hook is gone with its log. Types only: no runtime import.
 */
import type { CameraConfig } from '../../shared/foundation/settings';
import type { MusicTaste } from '../../shared/foundation/character-card';
import type { GazeAttentionEvent } from '../../shared/senses';
import type { ModelPhysicsState, MouthReadingSentence } from '../../shared/stage';
import type { MotionFitView } from '../actions';
import type { BlushStageState } from './blush-seen';
import type { MotionGlitchReport } from './motion-glitch';
import type { MusicVerdictFlip } from './music-likeness';
import type { SongMemoryPort } from './music-react/stage';
import type { SleepMurmur } from './sleep-body';

export interface StageOptions {
  /** I-078 (sleep-body.ts): a rare silent "zzz…" while she sleeps, for the ordinary bubble (no voice). */
  onSleepMurmur?: (murmur: SleepMurmur) => void;
  onSurprisePreviewState?: (state:'playing'|'partial'|'idle'|'unsupported')=>void;
  transparent?: boolean;
  onCameraChange?: (camera: CameraConfig) => void;
  onFramingStateChange?: () => void;
  onCameraEditChange?: (enabled: boolean) => void;
  onFaceAnchor?: (point: { x: number; y: number; visible: boolean; radius?: number; raisedHand?: { x: number; y: number; elbowX: number; elbowY: number } }) => void;
  onStatus?: (message: string) => void;
  onError?: (message: string) => void;
  onPhysicsState?: (state: ModelPhysicsState) => void;
  onMotionFit?: (view: MotionFitView | null) => void;
  /** Her window only: CSS px from the canvas top where UI reacts (the expanded toolbar and its reveal margin); framing keeps the model below it. */
  framingTop?: () => number;
  /** Her window only: the never-framed default camera is replaced by full framing as soon as a model is shown (P4). */
  frameUnframed?: boolean;
  /** 体验记录 (E2): her music tier changed, with its score (once per change). */
  onMusicTier?: (tier: 'none' | 'nod' | 'dance', score: number | null) => void;
  /** I-053: the fast layer's verdict flipped (numbers and a closed reason only; 体验记录). */
  onMusicVerdict?: (flip: MusicVerdictFlip) => void;
  /** I-077: a music reaction started; the host makes it a small, gated mood moment. */
  onMusicReaction?: (intent: 'lift' | 'settle' | 'enjoy' | 'moved' | 'recognize', scale: number) => void;
  /** I-081: her attention to you changed (closed words only). */
  onGazeAttention?: (event: GazeAttentionEvent) => void;
  /** I-077 step 2: the card's music taste (undefined: neutral), the host's song memory (her window; numbers only). */
  musicTaste?: () => Readonly<MusicTaste> | undefined;
  songMemory?: SongMemoryPort;
  /** 动作跳变记录 (motion-glitch.ts): a guard catch or a physics kick, with what she was doing (her window; host journals it). */
  onMotionGlitch?: (glitch: MotionGlitchReport) => void;
  /** 嘴型记录 (mouth-reading-log.ts): one reply read aloud (her window; host journals it). */
  onMouthReading?: (reading: { sentences: MouthReadingSentence[] }) => void;
  /** 体验记录: a blush cue reached the stage; could it show (blush-seen.ts). */
  onBlushCue?: (stage: BlushStageState) => void;
  /** 体验记录: her first fade-in finished (app start -> she is there). */
  onFirstShown?: () => void;
}
