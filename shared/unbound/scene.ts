/**
 * Unbound U1: what the host and the Unbound window say to each other, and what the control window may ask for
 * (docs/claude/2026-11-12-unbound-u1-part1.md). Types, channel names and the strict parsing of every input.
 *
 * The Unbound window never gets a file path, a key or a general channel: only opaque mmd-asset:// URLs the host already
 * registered for the companion, a few numbers about the screen, and her reply text.
 */
import type { ModelPhysicsSettings } from '../stage';
import { DEPTH_RANGE_M, VIEWER_DISTANCE_RANGE_M, type PhysicalScreen, type Placement, type Rect } from './world';
import type { LookSpot } from './screen-terms';
import { PEEK_KNOB_RANGES, type PeekView } from './director';
import { tierOf, type PerfTierId } from './perf-tiers';
import type { UnboundSenses } from './senses';
import { parseLifePatch, type LifePatch, type LifeView } from './life/view';
import { LIFE_ACTION_IDS } from './life/registry';
import type { SpeechBeatsEvent } from '../brain'; // 边说边演 (shared/behaviors/speech-beats/, through the brain's page)

/** The only IPC the Unbound window has (electron/unbound/preload-api.ts). Requests go host-ward; events come window-ward. */
export const UNBOUND_REQUESTS = Object.freeze({
  getScene: 'unbound:get-scene',
  ready: 'unbound:ready',
  /** How far her first load has got (shared/unbound/entry-wait.ts LoadProgress): the entry waits while it moves forward. */
  loading: 'unbound:loading',
  interactive: 'unbound:interactive',
  stats: 'unbound:stats',
  /** U2: where a peek is now (shared/unbound/director.ts PeekReport). */
  peekReport: 'unbound:peek-report',
  /** Step 2: she was clicked (part, side, where her head is; shared/unbound/typing.ts). */
  touch: 'unbound:touch',
  /** Step 2: the answer to "where is your head" (the typing shortcut has no click to read it from). */
  anchor: 'unbound:anchor',
  /** Read-aloud (docs/claude/2026-11-15-unbound-read-aloud.md): exactly which reply text her bubble has painted (shared/unbound/shown.ts). */
  shown: 'unbound:shown',
  /** Step 4: where her own action is now (shared/unbound/life/types.ts LifeReport). */
  lifeReport: 'unbound:life-report',
  /** Step 5c: a pull began, or its "still holding" / end report and where she stands (shared/unbound/pull.ts). */
  pull: 'unbound:pull',
  /** Her mood view now (the companion window's getMood; electron/unbound/mood-bridge.ts). */
  getMood: 'unbound:get-mood',
  /** A direct touch's mood input (a pat, a pinch, a snack; the companion window's moodInteraction, from the shown window only). */
  moodInteraction: 'unbound:mood-interaction',
  /** The current model's capability record (the companion window's getModelCapabilities, read only): her face follows your choices on the character page. */
  getModelCard: 'unbound:get-model-card',
  /** Batch A (docs/claude/2026-11-21-unbound-full-ACH.md): the shown model's blush calibration (the companion window's getBlushCalibration, read only). */
  getBlushCalibration: 'unbound:get-blush-calibration',
  /** Batch C: her motions as the companion window's stage reads them, each only from the window she is shown in (electron/unbound/motion-bridge.ts). */
  resolveChatGesture: 'unbound:resolve-chat-gesture',
  resolveHerAction: 'unbound:resolve-her-action',
  reportHerAction: 'unbound:report-her-action',
  bodyPlan: 'unbound:body-plan',
  resolveBody: 'unbound:resolve-body',
  resolveBehaviorMotion: 'unbound:resolve-behavior-motion',
  /** Batches D, F: one fact of hers ({ kind, value }, shared/unbound/sense-relay.ts HER_FACT_KINDS), from the shown window only (electron/unbound/sense-bridge.ts). */
  herFact: 'unbound:her-fact',
} as const);
export const UNBOUND_EVENTS = Object.freeze({
  scene: 'unbound:scene',
  bubble: 'unbound:bubble',
  /** U2: start or cancel a peek (shared/unbound/director.ts PeekCommand). */
  peek: 'unbound:peek',
  /** Step 2: the line the user just sent (shown briefly), the host's question "where is your head", and whether a voice is sounding (her mouth follows it). */
  said: 'unbound:said',
  typing: 'unbound:typing',
  /** Step 2: the senses in use changed (the small light). Also in the scene, for the first one. */
  senses: 'unbound:senses',
  speaking: 'unbound:speaking',
  /** 2026-11-20: one of her short sounds in a call sounds (its mouth scale 0..1) or ended (null): her mouth follows it. */
  fillerMouth: 'unbound:filler-mouth',
  /** Step 4: start or ease out one of her own actions, and whether her gaze is yours (shared/unbound/life/types.ts LifeCommand). */
  life: 'unbound:life',
  /** Her mood view as the companion window gets it (desk:mood), while this window is hers. */
  mood: 'unbound:mood',
  /** A capability record changed (desk:model-capabilities: your choice on the character page, a finished check). */
  modelCard: 'unbound:model-card',
  /** Batch A: the blush calibration changed (desk:blush-calibration). */
  blushCalibration: 'unbound:blush-calibration',
  /** Batch A: her voice's facts for her speaking face (a heard segment starts, its loudness, a stop; shared/voice/speech-face-cue.ts), read only. */
  speechFace: 'unbound:speech-face',
  /** Batch C: one of her actions (desk:her-action) while she is out; her answer goes back by reportHerAction. */
  herAction: 'unbound:her-action',
} as const);

export interface UnboundMotion {
  pose: string | null; gesture: string | null; expression: string | null; legacy: boolean;
  /** Her default stand when the companion has no pose layer (the bundled stand pose; electron/unbound/source.ts withRestPose). */
  rest?: string;
}
/** Her body's knobs (part 2): how fast and how long her steps are when she walks somewhere, and standing on both feet or one. */
export type UnboundStance = 'both' | 'left' | 'right';
export interface UnboundBody { walkSpeedMps: number; stepLengthM: number; stance: UnboundStance }
export const UNBOUND_BODY_DEFAULTS: Readonly<UnboundBody> = Object.freeze({ walkSpeedMps: 0.7, stepLengthM: 0.3, stance: 'both' });
export const UNBOUND_BODY_RANGES = Object.freeze({ walkSpeedMps: Object.freeze([0.3, 1.4] as const), stepLengthM: Object.freeze([0.15, 0.5] as const) });
export interface UnboundWorld {
  screen: PhysicalScreen;
  display: Rect;
  workArea: Rect;
  /** The Unbound window's bounds (DIP, screen coordinates). */
  window: Rect;
  /** physical: the window is a true window into her world; fit: the whole screen's view scaled into the window (preview). */
  mapping: 'physical' | 'fit';
  viewerDistanceM: number;
  eyeHeightM: number;
  placement: Placement;
}
export interface UnboundScene {
  /** Bumped on every change, so the window can tell an old answer from a new one. */
  revision: number;
  modelUrl: string | null;
  /** The reviewed bundled Gene (motions play as authored); any other model gets the stage's own motion fitting. */
  reviewed: boolean;
  motion: UnboundMotion;
  /** The companion's 呼吸 setting (0..1). */
  breath: number;
  physics: ModelPhysicsSettings | null;
  world: UnboundWorld;
  /**
   * I-212: an entry's start in screen terms (shared/unbound/screen-terms LookSpot), present until the page has reported her height: the page
   * places her first frame by it with her measured height (src/unbound/start-place.ts); the host then works out the same placement.
   */
  start?: LookSpot;
  body: UnboundBody;
  /** Developer overlay: her floor grid and where she stands. */
  debug: boolean;
  /** U2: the lens softness during the extreme close-up (0..1; shared/unbound/director.ts PeekKnobs.softness). */
  peekSoftness?: number;
  /** E3 (on by default in Unbound since step 2; present only when on): before she speaks she looks at you, holds half a beat, and nods as the bubble shows. */
  speechBeat?: true;
  /** Step 2: which senses are in use now (the small light near her); absent: none. */
  senses?: UnboundSenses;
}
/** Her reply as it streams (control window chat): a small bubble near her head. */
export interface UnboundBubble {
  id: string; type: 'delta' | 'done' | 'error' | 'beats'; text: string;
  /** Read-aloud: the host's revision of this bubble's text after this event (the page echoes it in its shown report). */
  rev?: number;
  /** On 'done': how long the finished bubble stays (ms, once her voice has read it out), decided by the host (shared/behaviors/reply-linger/); the page does not time it itself. */
  lingerMs?: number;
  /** I-165: on an empty 'delta' only: her reply's bubble goes up showing "……"; its text follows as her voice reaches it (no revision). */
  hold?: true;
  /** 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md): on a 'beats' event only; the bubble itself ignores it. */
  speechBeats?: SpeechBeatsEvent;
}
/** The window has her on screen (model loaded, first frame drawn) or could not. */
export interface UnboundReady { ok: boolean; error?: string; modelHeightM?: number }
export interface UnboundInteractiveAck { interactive: boolean }
export interface LatencySummary { n: number; p50: number; p95: number; max: number }
/** What the window measured, for the developer view: click-through switch round trips (ms) and frames per second. */
export interface UnboundStats {
  toggles: number; roundTripMs: LatencySummary | null; fps: number | null; hitTestMs: LatencySummary | null;
  /** Step 1B: the quality tier, whether the quiet frame rate is on, frame intervals at the full rate (ms) and how many tiers this session dropped. */
  perf?: { tier: PerfTierId; quiet: boolean; frameMs: LatencySummary | null; drops: number } | null;
}

export type UnboundState = 'normal' | 'entering' | 'unbound';
export interface UnboundControlView {
  /** Developer mode is on (the switch only exists there). */
  available: boolean;
  state: UnboundState;
  viewerDistanceCm: number;
  depthM: number;
  body: UnboundBody;
  debug: boolean;
  screen: { widthCm: number; heightCm: number; source: PhysicalScreen['source'] } | null;
  stats: UnboundStats | null;
  /** Why the last attempt failed (plain words), or null. */
  error: string | null;
  /** A full-screen program is in front. Information only (I-199): she stays where she is, drawn, above it. */
  fullscreen: boolean;
  /** U2: the director's peek (knobs, beat, why not now, the last one); null when the host has none. */
  peek?: PeekView | null;
  /** E3: the opening beat's experiment switch (this run only). */
  speechBeat?: boolean;
  /** Step 4: her own life (developer panel only); null when the host has none. */
  life?: LifeView | null;
  /** The normal way in (button, tray item, Ctrl+Alt+U) is on. Off by default in stable until the user switches it on in settings; absent: on. */
  entryAllowed?: boolean;
}
export interface UnboundControlPatch extends LifePatch {
  active?: boolean; viewerDistanceCm?: number; depthM?: number; debug?: boolean;
  walkSpeedMps?: number; stepLengthM?: number; stance?: UnboundStance;
  /** U2: 「试一下：凑到镜头前」 (true only), and the peek's knobs. */
  peekNow?: true; peekIdleSeconds?: number; peekCooldownMinutes?: number; peekPerHour?: number; peekSoftness?: number;
  /** E3: the opening beat's experiment switch. */
  speechBeat?: boolean;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const inRange = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** The control window's request: known keys only, each the right type and in range. Throws in plain words otherwise. */
export function parseUnboundControlPatch(value: unknown): UnboundControlPatch {
  if (!record(value)) throw new Error('Unbound 设置格式不正确。');
  const allowed = ['active', 'viewerDistanceCm', 'depthM', 'debug', 'walkSpeedMps', 'stepLengthM', 'stance', 'peekNow', 'peekIdleSeconds', 'peekCooldownMinutes', 'peekPerHour', 'peekSoftness', 'speechBeat',
    'lifeTry', 'lifeFast', 'lifeKnobs'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || !Object.keys(value).length) throw new Error('Unbound 设置格式不正确。');
  const patch: UnboundControlPatch = { ...parseLifePatch(value, LIFE_ACTION_IDS) }; // step 4: the developer panel's part (shared/unbound/life/view.ts)
  if ('active' in value) { if (typeof value.active !== 'boolean') throw new Error('Unbound 开关格式不正确。'); patch.active = value.active; }
  if ('debug' in value) { if (typeof value.debug !== 'boolean') throw new Error('网格开关格式不正确。'); patch.debug = value.debug; }
  if ('viewerDistanceCm' in value) {
    if (!inRange(value.viewerDistanceCm, VIEWER_DISTANCE_RANGE_M[0] * 100, VIEWER_DISTANCE_RANGE_M[1] * 100)) throw new Error('观看距离要在 30 到 120 厘米之间。');
    patch.viewerDistanceCm = value.viewerDistanceCm;
  }
  if ('depthM' in value) {
    if (!inRange(value.depthM, DEPTH_RANGE_M[0], DEPTH_RANGE_M[1])) throw new Error('她离屏幕的距离要在 0.6 到 25 米之间。');
    patch.depthM = value.depthM;
  }
  const [s0, s1] = UNBOUND_BODY_RANGES.walkSpeedMps, [l0, l1] = UNBOUND_BODY_RANGES.stepLengthM;
  if ('walkSpeedMps' in value) {
    if (!inRange(value.walkSpeedMps, s0, s1)) throw new Error(`走路速度要在 ${s0} 到 ${s1} 米/秒之间。`);
    patch.walkSpeedMps = value.walkSpeedMps;
  }
  if ('stepLengthM' in value) {
    if (!inRange(value.stepLengthM, l0, l1)) throw new Error(`步长要在 ${l0 * 100} 到 ${l1 * 100} 厘米之间。`);
    patch.stepLengthM = value.stepLengthM;
  }
  if ('stance' in value) {
    if (value.stance !== 'both' && value.stance !== 'left' && value.stance !== 'right') throw new Error('站姿格式不正确。');
    patch.stance = value.stance;
  }
  if ('peekNow' in value) { if (value.peekNow !== true) throw new Error('“试一下”格式不正确。'); patch.peekNow = true; }
  if ('speechBeat' in value) { if (typeof value.speechBeat !== 'boolean') throw new Error('“开口前先看你”开关格式不正确。'); patch.speechBeat = value.speechBeat; }
  const knob = (key: 'peekIdleSeconds' | 'peekCooldownMinutes' | 'peekPerHour' | 'peekSoftness', range: readonly [number, number], words: string) => {
    if (!(key in value)) return;
    if (!inRange(value[key], range[0], range[1])) throw new Error(`${words}要在 ${range[0]} 到 ${range[1]} 之间。`);
    patch[key] = value[key] as number;
  };
  knob('peekIdleSeconds', PEEK_KNOB_RANGES.idleSeconds, '没动电脑多久（秒）');
  knob('peekCooldownMinutes', PEEK_KNOB_RANGES.cooldownMinutes, '两次之间至少（分钟）');
  knob('peekPerHour', PEEK_KNOB_RANGES.perHour, '每小时最多');
  knob('peekSoftness', PEEK_KNOB_RANGES.softness, '镜头虚化');
  return patch;
}

/** The window's ready report. Anything else is a failure report. */
export function parseUnboundReady(value: unknown): UnboundReady {
  if (!record(value) || typeof value.ok !== 'boolean') return { ok: false, error: '窗口报告格式不正确。' };
  const out: UnboundReady = { ok: value.ok };
  if (typeof value.error === 'string') out.error = value.error.slice(0, 300);
  if (inRange(value.modelHeightM, 0.05, 20)) out.modelHeightM = value.modelHeightM;
  return out;
}

const summary = (value: unknown): LatencySummary | null => {
  if (!record(value)) return null;
  const { n, p50, p95, max } = value;
  return inRange(n, 0, 1e7) && inRange(p50, 0, 6e4) && inRange(p95, 0, 6e4) && inRange(max, 0, 6e4) ? { n: Math.round(n), p50, p95, max } : null;
};
function parsePerfStats(value: unknown): NonNullable<UnboundStats['perf']> | null {
  if (!record(value) || !tierOf(value.tier) || typeof value.quiet !== 'boolean') return null;
  return { tier: value.tier as PerfTierId, quiet: value.quiet, frameMs: summary(value.frameMs), drops: inRange(value.drops, 0, 1e4) ? Math.round(value.drops) : 0 };
}
/** The window's measurements: numbers only, bounded. */
export function parseUnboundStats(value: unknown): UnboundStats | null {
  if (!record(value)) return null;
  return {
    toggles: inRange(value.toggles, 0, 1e7) ? Math.round(value.toggles) : 0,
    roundTripMs: summary(value.roundTripMs),
    fps: inRange(value.fps, 0, 1000) ? value.fps : null,
    hitTestMs: summary(value.hitTestMs),
    perf: parsePerfStats(value.perf),
  };
}

/** p50 / p95 / max of a list of milliseconds (nearest rank). */
export function summarize(values: readonly number[]): LatencySummary | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}
