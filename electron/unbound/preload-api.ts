/**
 * Unbound U1: the whole API the Unbound window gets (`window.unbound`), built from a minimal IPC surface so a test can check it
 * with a fake (tests/unbound-preload.test.ts). A whitelist of requests and events on fixed `unbound:` channels (U2 added
 * the peek's report and command), plain values in and out. No Node, no file paths, no keys, no general invoke or send, and
 * listeners never see the IPC event object.
 */
import { UNBOUND_EVENTS, UNBOUND_REQUESTS, type UnboundBubble, type UnboundInteractiveAck, type UnboundReady, type UnboundScene, type UnboundStats } from '../../shared/unbound/scene';
import type { PeekCommand, PeekReport } from '../../shared/unbound/director';
import type { ChatCloseAnswer, CloseBeatAsk, FrameBeatAsk } from '../../shared/unbound/close-moments';
import type { GoBeatAnswer, GoBeatAsk } from '../../shared/unbound/her-position';
import type { UnboundAnchorReport, UnboundTouchReport } from '../../shared/unbound/typing';
import type { UnboundSenses } from '../../shared/unbound/senses';
import type { UnboundShownReport } from '../../shared/unbound/shown';
import type { LifeCommand, LifeReport } from '../../shared/unbound/life/types';
import type { UnboundPullMessage } from '../../shared/unbound/pull';
import type { LoadProgress } from '../../shared/unbound/entry-wait';
import type { MoodInput, MoodView } from '../../shared/mood/mood-runtime';
import type { BlushCalibrationView } from '../../shared/mood';
import type { SpeechFaceCue } from '../../shared/voice';
import type { BehaviorMotionResource, BodyMotionPlan, BodyMotionResource, BodyStageObservation, ChatGestureResource, HerActionOutcome,
  HerActionResource } from '../../shared/actions';
import { createUnboundGamesApi, type UnboundGamesApi } from './games-preload-api'; // batch B: her games out here
import { createUnboundSenseApi, type UnboundSenseApi } from './sense-preload-api'; // batches D, F: her senses out here (read only)
import { createUnboundCompanyApi, type UnboundCompanyApi } from './company/preload-api'; // I-209 step 1: the others on stage

export interface UnboundIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
}

export interface UnboundApi extends UnboundGamesApi, UnboundSenseApi, UnboundCompanyApi {
  getScene(): Promise<UnboundScene>;
  /** Her model is on screen (or it failed): the host may now show this window and hide the companion. */
  ready(report: UnboundReady): Promise<void>;
  /** How far her first load has got (numbers and a step name only; the host keeps waiting while it moves forward). */
  loading(progress: LoadProgress): Promise<void>;
  /** The cursor is on her (true) or not (false): the host switches click-through. */
  setInteractive(on: boolean): Promise<UnboundInteractiveAck>;
  /** Numbers only, for the developer view. */
  report(stats: UnboundStats): Promise<void>;
  /** U2: where a peek is now (the host parses it). I-185: or "her reply reached a kiss / hug": the host answers play or lighter. */
  peekReport(report: PeekReport | CloseBeatAsk | GoBeatAsk | FrameBeatAsk): Promise<ChatCloseAnswer | GoBeatAnswer | void>; // I-185 kiss/hug, I-193 go, I-203 frames
  /** Step 2: she was clicked (a single click, checked by the page): where on her, and where her head is. */
  touch(report: UnboundTouchReport): Promise<void>;
  /** Step 2: the answer to the host's "where is your head". */
  anchor(report: UnboundAnchorReport): Promise<void>;
  /** Read-aloud: which text the reply bubble has painted (docs/claude/2026-11-15-unbound-read-aloud.md). */
  shown(report: UnboundShownReport): Promise<void>;
  onScene(callback: (scene: UnboundScene) => void): () => void;
  onBubble(callback: (bubble: UnboundBubble) => void): () => void;
  /** U2: the host starts or cancels a peek. */
  onPeek(callback: (command: PeekCommand) => void): () => void;
  /** Step 2: the line the user sent (shown briefly), the host's question, the senses in use, and whether a voice is sounding. */
  onSaid(callback: (text: string | { notice: string }) => void): () => void;
  onTyping(callback: (command: { type: 'where'; id: string }) => void): () => void;
  onSenses(callback: (senses: UnboundSenses) => void): () => void;
  onSpeaking(callback: (on: boolean) => void): () => void;
  /** 2026-11-20: a short sound of hers in a call sounds (its mouth scale) or ended (null). */
  onFillerMouth(callback: (shape: number | null) => void): () => void;
  /** Step 4: where her own action is now (the host parses it). */
  lifeReport(report: LifeReport): Promise<void>;
  /** Step 4: the host starts or eases out one of her own actions, or gives her gaze to you. */
  onLife(callback: (command: LifeCommand) => void): () => void;
  /** Step 5c: a pull began, or its report (shared/unbound/pull.ts; the host parses it). */
  pull(message: UnboundPullMessage): Promise<{ accepted: boolean; stance?: unknown; sleepy?: number } | void>;
  /** I-154 follow-up (docs/claude/2026-11-20-unbound-full-shares.md): her mood view, the same one the companion window gets (her face reads it). */
  getMood(): Promise<MoodView>;
  onMood(callback: (view: MoodView) => void): () => void;
  /** A direct touch on her own body (a pat, a pinch, a snack at her mouth) as the companion window sends it; the host takes it only from the shown window. */
  moodInteraction(input: MoodInput): Promise<MoodView>;
  /** The current model's capability record and its updates (read only; the page derives the card as the companion window does). */
  getModelCard(): Promise<unknown>;
  onModelCard(callback: (update: unknown) => void): () => void;
  /** Batch A (docs/claude/2026-11-21-unbound-full-ACH.md): the shown model's blush calibration and its changes (read only, as the companion window gets them). */
  getBlushCalibration(): Promise<BlushCalibrationView>;
  onBlushCalibration(callback: (view: BlushCalibrationView) => void): () => void;
  /** Batch A: her voice's facts for her speaking face (a heard segment starts, its loudness, a stop), read only. */
  onSpeechFace(callback: (cue: SpeechFaceCue) => void): () => void;
  /**
   * Batch C: her motions as the companion window's stage reads them (src/unbound/window-mode/host-ports.ts): a chat gesture's, one of her actions'
   * and a behaviour face's granted bytes, the automatic body motion's plan and bytes, her answer to an action, and the action itself. The host
   * takes each only from the window she is shown in (electron/unbound/motion-bridge.ts).
   */
  resolveChatGesture(cueId: string, token: string): Promise<ChatGestureResource>;
  resolveHerAction(cueId: string): Promise<HerActionResource>;
  reportHerAction(outcome: HerActionOutcome): Promise<void>;
  bodyPlan(token: string, observation?: BodyStageObservation): Promise<BodyMotionPlan>;
  resolveBody(cueId: string, token: string): Promise<BodyMotionResource>;
  resolveBehaviorMotion(cueId: string, token: string): Promise<BehaviorMotionResource>;
  onHerAction(callback: (cue: unknown) => void): () => void;
}

/** The exact key set, for the test and for anyone reading the preload. */
export const UNBOUND_API_KEYS = Object.freeze(['getScene', 'ready', 'loading', 'setInteractive', 'report', 'peekReport', 'touch', 'anchor', 'shown', 'onScene', 'onBubble', 'onPeek', 'onSaid', 'onTyping', 'onSenses', 'onSpeaking', 'lifeReport', 'onLife', 'pull', 'getMood', 'onMood', 'moodInteraction', 'getModelCard', 'onModelCard', 'onFillerMouth',
  'getBlushCalibration',
  'onBlushCalibration',
  'onSpeechFace',
  'resolveChatGesture',
  'resolveHerAction',
  'reportHerAction',
  'bodyPlan',
  'resolveBody',
  'resolveBehaviorMotion',
  'onHerAction',
  // Batch B (games-preload-api.ts UNBOUND_GAMES_API_KEYS): her games out here.
  'rpsGet',
  'rpsEvents',
  'rpsThrow',
  'rpsRespond',
  'onGive',
  'giveAnswer',
  'onHands',
  'handsAnswer',
  'handsRequest',
  // Batches D, F (sense-preload-api.ts UNBOUND_SENSE_API_KEYS): her senses out here, read only, and her facts about them.
  'onUserGaze',
  'onDance',
  'onExpressionPreview',
  'onMusicSettings',
  'herFact',
  // I-209 (company/preload-api.ts UNBOUND_COMPANY_API_KEYS): the frame-cost guard; step 3: her body on the shared stage, the shared world.
  'companyGuard',
  'stageBody',
  'stageLeft',
  'stageFrames', // 2026-11-24: her frame times once a minute (docs/claude/2026-11-24-stage-smooth.md)
  'stageMouth', // 2026-11-25: her mouth while she read one reply (docs/claude/2026-11-25-stage-mouth-height.md)
  'onStage',
] as const);

export function createUnboundApi(ipc: UnboundIpc): UnboundApi {
  const subscribe = <T>(channel: string, callback: (value: T) => void): (() => void) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event: unknown, value: unknown) => callback(value as T);
    ipc.on(channel, listener);
    return () => { ipc.removeListener(channel, listener); };
  };
  const api: UnboundApi = {
    getScene: () => ipc.invoke(UNBOUND_REQUESTS.getScene) as Promise<UnboundScene>,
    ready: report => ipc.invoke(UNBOUND_REQUESTS.ready, report) as Promise<void>,
    loading: progress => ipc.invoke(UNBOUND_REQUESTS.loading, progress) as Promise<void>,
    setInteractive: on => {
      if (typeof on !== 'boolean') return Promise.reject(new TypeError('setInteractive takes true or false'));
      return ipc.invoke(UNBOUND_REQUESTS.interactive, on) as Promise<UnboundInteractiveAck>;
    },
    report: stats => ipc.invoke(UNBOUND_REQUESTS.stats, stats) as Promise<void>,
    peekReport: report => ipc.invoke(UNBOUND_REQUESTS.peekReport, report) as Promise<ChatCloseAnswer | GoBeatAnswer | void>,
    touch: report => ipc.invoke(UNBOUND_REQUESTS.touch, report) as Promise<void>,
    anchor: report => ipc.invoke(UNBOUND_REQUESTS.anchor, report) as Promise<void>,
    shown: report => ipc.invoke(UNBOUND_REQUESTS.shown, report) as Promise<void>,
    onScene: callback => subscribe(UNBOUND_EVENTS.scene, callback),
    onBubble: callback => subscribe(UNBOUND_EVENTS.bubble, callback),
    onPeek: callback => subscribe(UNBOUND_EVENTS.peek, callback),
    onSaid: callback => subscribe(UNBOUND_EVENTS.said, callback),
    onTyping: callback => subscribe(UNBOUND_EVENTS.typing, callback),
    onSenses: callback => subscribe(UNBOUND_EVENTS.senses, callback),
    onSpeaking: callback => subscribe(UNBOUND_EVENTS.speaking, callback),
    onFillerMouth: callback => subscribe(UNBOUND_EVENTS.fillerMouth, callback),
    lifeReport: report => ipc.invoke(UNBOUND_REQUESTS.lifeReport, report) as Promise<void>,
    pull: message => ipc.invoke(UNBOUND_REQUESTS.pull, message) as Promise<{ accepted: boolean; stance?: unknown; sleepy?: number } | void>,
    onLife: callback => subscribe(UNBOUND_EVENTS.life, callback),
    getMood: () => ipc.invoke(UNBOUND_REQUESTS.getMood) as Promise<MoodView>,
    onMood: callback => subscribe(UNBOUND_EVENTS.mood, callback),
    getModelCard: () => ipc.invoke(UNBOUND_REQUESTS.getModelCard),
    onModelCard: callback => subscribe(UNBOUND_EVENTS.modelCard, callback),
    getBlushCalibration: () => ipc.invoke(UNBOUND_REQUESTS.getBlushCalibration) as Promise<BlushCalibrationView>,
    onBlushCalibration: callback => subscribe(UNBOUND_EVENTS.blushCalibration, callback),
    onSpeechFace: callback => subscribe(UNBOUND_EVENTS.speechFace, callback),
    resolveChatGesture: (cueId, token) => ipc.invoke(UNBOUND_REQUESTS.resolveChatGesture, cueId, token) as Promise<ChatGestureResource>,
    resolveHerAction: cueId => ipc.invoke(UNBOUND_REQUESTS.resolveHerAction, cueId) as Promise<HerActionResource>,
    reportHerAction: outcome => ipc.invoke(UNBOUND_REQUESTS.reportHerAction, outcome) as Promise<void>,
    bodyPlan: (token, observation) => ipc.invoke(UNBOUND_REQUESTS.bodyPlan, token, observation) as Promise<BodyMotionPlan>,
    resolveBody: (cueId, token) => ipc.invoke(UNBOUND_REQUESTS.resolveBody, cueId, token) as Promise<BodyMotionResource>,
    resolveBehaviorMotion: (cueId, token) => ipc.invoke(UNBOUND_REQUESTS.resolveBehaviorMotion, cueId, token) as Promise<BehaviorMotionResource>,
    onHerAction: callback => subscribe(UNBOUND_EVENTS.herAction, callback),
    moodInteraction: input => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return Promise.reject(new TypeError('moodInteraction takes one input object'));
      return ipc.invoke(UNBOUND_REQUESTS.moodInteraction, input) as Promise<MoodView>;
    },
    ...createUnboundGamesApi((channel, ...args) => ipc.invoke(channel, ...args), subscribe), // batch B: her games out here
    ...createUnboundSenseApi((channel, ...args) => ipc.invoke(channel, ...args), subscribe), // batches D, F: her senses out here (read only)
    ...createUnboundCompanyApi((channel, ...args) => ipc.invoke(channel, ...args), subscribe), // I-209 step 1
  };
  return Object.freeze(api);
}
