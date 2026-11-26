/**
 * I-154 batch 5 (docs/claude/2026-11-20-unbound-window-batch5.md): her own motions in the companion window on Unbound's engine, the
 * companion's rules (src/stage/mmd/gesture.ts, body.ts, face.ts) on this engine's state:
 *  - row 30 聊天手势: a chat gesture the host grants for a reply (MoodView.gesture) plays through the figure's clip layer (window-clips.ts);
 *  - row 31 她的动作: one of her one-shot actions (a test command's cue). A body action plays through the clip layer, a face shape through
 *    the face exclusive (src/stage/face-exclusive.ts), written over every other face writer for its short while. Every cue gets her answer
 *    (played / missing / unfit / busy / failed) through the host port's reportHerAction, as the companion's stage gives it;
 *  - row 32 自动身体动作: the host's automatic body motion plan (MoodView.body) through the companion's BodyMotionController and
 *    BehaviorBodyPlayer in the figure's own mixer, and the behaviour faces (MoodView.behavior) through BehaviorMotionPlayer.
 * "禁止" only stops a new one starting: what plays gives way smoothly (window-clips.ts hands the pose back; her actions and the faces fade by
 * their own clocks). The user's touch, pull and window moves come first. Hidden, or the model going away: everything stops at once.
 * Only the host port (host-ports.ts) reaches the host. The maintainer QA stand (a developer check of the old stage) is not here.
 */
import { AnimationClip, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { BehaviorBodyPlayer, BehaviorMotionPlayer, BodyMotionController, FACE_EXCLUSIVE_START_WAIT_S, FaceExclusive, bodyMotionTarget, faceTracksByName,
  faceWriteTracks, resolveFaceMorphs, universalTarget, withKeyframeInterpolation, type BodyStageGates, type HerLifeStageGates, type StageModelProfile } from '../../stage';
import type { StageMotionRetarget } from '../../actions';
import { smoothCapturedClip } from '../../senses';
import { createVmdParser, type VmdDataTransform } from '../../foundation/vmd';
import { HER_ACTION_DETAILS, HER_ACTION_PART_NAMES, HER_ACTION_SPECS, canonicalVmdClipDuration, herActionMissing, isHerActionCue,
  type BodyMotionResource, type ChatGestureCue, type HerActionCue, type HerActionMode, type HerActionSpec, type HerActionStatus,
  type StandardBone } from '../../../shared/actions';
import { calibratedWeight, profileBoneState, profileFingerCount, profileFingerNames } from '../../../shared/stage';
import type { MoodView } from '../../../shared/mood';
import { isChatGestureTrack } from '../../stage';
import type { UnboundFigure } from '../figure';
import type { WindowStageHost } from './host-ports';
import { CLOSED_BODY_GATES, WindowClips } from './window-clips';
import type { MotionBlocks } from './window-face-rig';
import type { VisualPreviewPlan } from './window-previews';
import type { BehaviorMotionResource } from '../../../shared/actions';
import { MouthActions } from './window-mouth-actions';
import { closedMouthMayStart, closedMouthMustWait } from '../../../shared/behaviors/part-mix/closed-mouth';

/** What the stage says about her and the user now (window-stage.ts motionEnv). */
export interface WindowMotionEnv {
  /** Drawn now: not hidden, the window has a size, not disposed. */
  shown: boolean;
  typing: boolean; behaviorBlocked: boolean; inputBlocked: boolean;
  /** The camera is being adjusted. */
  adjusting: boolean;
  /** A pat, a snack at her mouth, the pointer over her, a pinch. */
  pat: boolean; feeding: boolean; hover: boolean; pinch: boolean;
  pulled: boolean;
  /** The sleep body holds her. */
  asleep: boolean;
  rps: boolean; give: boolean; hands: boolean;
  speaking: boolean; preparing: boolean; thinking: boolean;
  view: MoodView | null;
  blocks: MotionBlocks;
  /** A 惊喜 / 害羞 show plays (a preview owner). */
  showing: boolean;
  /** A reaction to your pose plays (face shapes give way). */
  reacting: boolean;
  /** Her lids held closed now (a pat's enjoyed closure, the sleep pose), and a natural blink in progress (0..1). */
  lidsHeld: number; blink: number;
  /** The capability card's mouth / closing the eyes switched off. */
  mouthOff: boolean; eyesOff: boolean;
  /** Batch 6 (row 37): she dances to music, or the dance eases out (the old stage's musicEnabled || releasing). */
  music?: boolean;
  /** Full-screen Unbound (batch C, src/unbound/her/out-motions.ts): she walks; no automatic body motion starts and a playing one is handed back. The window never sets it. */
  walking?: boolean;
  /** I-175: read-aloud off and the bubble is in the middle of a sentence (a closed-mouth shape waits for its end). Absent: false. */
  sentenceOpen?: boolean;
}

export interface WindowMotionModel {
  figure: UnboundFigure;
  mesh: SkinnedMesh;
  /** The host said this is the reviewed Gene. */
  reviewed: boolean;
  retarget: StageMotionRetarget | null;
  transform: VmdDataTransform | undefined;
  profile: StageModelProfile | null;
  /** A VRM on the standard skeleton (its face is presented after the frame). */
  standard: boolean;
  /**
   * I-164 (docs/claude/2026-11-20-vrm-gaps.md): a VRM's face for her face shapes (src/unbound/model/standard-face.ts standardFaceOf): the face
   * exclusive writes the standard morphs over this face, then present() shows what it wrote. Absent on a VRM: face shapes report failed.
   */
  standardFace?: { mesh: ConstructorParameters<typeof FaceExclusive>[0]; present(): void } | null;
}

/** What happened to the last cue (diagnostics and tests). */
export interface HerActionInfo { cueId: string; action: string; status: HerActionStatus; missing: string[]; detail: string }

const UNFIT = '这个动作不适合当前模型';
const loadVmd = (url: string): Promise<{ morphs?: { morphName: string; frameNum: number; weight: number }[] }> => {
  const loader = new MMDLoader() as unknown as { parser: object; loadVMD(url: string, onLoad: (vmd: never) => void, onProgress?: unknown, onError?: (error: unknown) => void): void };
  loader.parser = createVmdParser();
  return new Promise((resolve, reject) => loader.loadVMD(url, resolve, undefined, reject));
};
/** A library VMD as a clip for this mesh, the stage's way (keyframe interpolation, the retarget); `frames` hears its source length. */
export function loadLibraryClip(url: string, mesh: SkinnedMesh, transform: VmdDataTransform | undefined, frames?: (count: number) => void): Promise<AnimationClip> {
  const loader = withKeyframeInterpolation(new MMDLoader());
  loader.parser = createVmdParser(report => frames?.(report.durationFrames), transform);
  return new Promise((resolve, reject) => loader.loadAnimation(url, mesh, value => resolve(value as AnimationClip), undefined, reject));
}

export class WindowMotions {
  private model: WindowMotionModel | null = null;
  clips: WindowClips | null = null;
  private face: FaceExclusive | null = null;
  private readonly faceLayers: { index: number; value: number }[] = [];
  private view: MoodView | null = null;
  private behaviorToken = '';
  private readonly chatIds = new Set<string>();
  private chatGeneration = 0;
  private readonly chatClips = new Map<string, Promise<AnimationClip>>();
  private readonly actionIds = new Set<string>();
  private actionGeneration = 0;
  private readonly actionClips = new Map<string, Promise<AnimationClip>>();
  private readonly faceClips = new Map<string, Promise<{ morphs?: { morphName: string; frameNum: number; weight: number }[] }>>();
  private readonly bodyConsumed = new Set<string>();
  info: HerActionInfo | null = null;
  /** 哈欠捂嘴: the P1 yawn offered with the hand as one local cue on the same clock (window-reactions.ts reads it). */
  yawnCue: { id: string; at: number } | null = null;
  private disposed = false;
  /** I-175: a pout while she speaks talks through; a cheek puff waits for a pause (window-mouth-actions.ts). The stage sets `mouth.talkingFace`. */
  readonly mouth = new MouthActions();

  constructor(private readonly host: WindowStageHost, private readonly env: () => WindowMotionEnv, private readonly now: () => number = Date.now) {}

  private scopeKey(view = this.view): string { return `${view?.characterId ?? ''}\u0000${view?.token ?? ''}`; }
  private unfit(sha256: string | null | undefined): boolean { return !!sha256 && this.model?.retarget?.fitOf(sha256)?.status === 'hidden'; }

  /** A new model (or none): the old one's clips stop at once (it is going away); this one gets its own players. */
  attach(model: WindowMotionModel | null): void {
    this.clips?.dispose(); this.model?.figure.setMotionLayer(null);
    this.face?.cut('model'); this.restoreFace(); this.mouth.cancel();
    this.clips = null; this.face = null; this.model = model;
    this.chatClips.clear(); this.actionClips.clear(); this.faceClips.clear();
    this.chatGeneration++; this.actionGeneration++; this.yawnCue = null;
    if (!model || this.disposed) return;
    const clips = this.clips = new WindowClips(model.mesh, this.now);
    model.figure.setMotionLayer(clips);
    const unfit = (sha: string) => this.unfit(sha);
    clips.behavior = new BehaviorMotionPlayer(model.mesh, {
      targetSupported: model.reviewed, universal: () => this.model === model ? universalTarget(model.retarget) : null, // I-038
      resolve: (cueId, token) => this.preview?.resolveFor(cueId, token) ?? this.host.resolveBehaviorMotion(cueId, token), // batch 7: a visual preview's own grant
      load: (resource, mesh) => loadLibraryClip(resource.url, mesh, model.transform).then(clip => { if (unfit(resource.sha256)) throw new Error(UNFIT); return clip; }),
      suits: sha => !unfit(sha),
    });
    const target = bodyMotionTarget(model.reviewed, model.retarget); // I-038: any model the retarget maps
    const player = new BehaviorBodyPlayer({ ...model.figure.behaviorBodyBindings({ allowBaseProjection: true }), standardName: target.standardName });
    clips.bodyTracks = () => { const state = player.getState(); return state.active ? state.trackNames : []; };
    clips.body = new BodyMotionController(model.mesh, {
      targetSupported: target.supported, consumedIds: this.bodyConsumed, player, now: this.now,
      getPlan: (token, observation) => this.host.getBehaviorBodyPlan(token, observation),
      resolve: (cueId, token) => this.host.resolveBehaviorBody(cueId, token),
      load: (resource, mesh) => this.loadBodyClip(resource, mesh, model.transform),
      // R29c: a revoked motion hands the pose it showed back to the running base (window-clips.ts), never a cut.
      release: (tracks, stop) => clips.handOff(tracks, stop),
    });
    this.face = new FaceExclusive(model.standardFace?.mesh ?? model.mesh);
    this.update();
  }

  private loadBodyClip(resource: BodyMotionResource, mesh: SkinnedMesh, transform: VmdDataTransform | undefined): Promise<AnimationClip> {
    let frames = -1;
    return loadLibraryClip(resource.url, mesh, transform, count => { frames = count; }).then(clip => {
      if (this.unfit(resource.sha256)) throw new Error(UNFIT);
      // R19: the parser's frames/30 is the one duration on both sides.
      if (canonicalVmdClipDuration(clip, frames) !== resource.durationMs) throw new Error('Body source duration mismatch.');
      return clip;
    });
  }

  /** The mood view: a new character or conversation hands everything back; a chat gesture granted for it starts. */
  setMood(view: MoodView | null): void {
    const previous = this.view;
    const changed = !!previous && (!view || previous.characterId !== view.characterId || previous.token !== view.token);
    if (changed) { this.actionGeneration++; this.clips?.yieldChat(); this.clips?.body?.cancel(); }
    if (previous?.gesture && !view?.gesture) this.clips?.yieldChat();
    this.view = view;
    this.update();
    if (view?.gesture) void this.playChatGesture(view.gesture, view.token);
  }

  /** A gate changed between frames (typing, a window move, a touch, input focus): what must give way does, the plans are re-read. */
  gatesChanged(cancelBody: boolean, yieldChat: boolean): void {
    if (cancelBody) this.clips?.body?.cancel();
    if (yieldChat) this.clips?.yieldChat();
    this.update();
  }

  /** The automatic body motion's gates (the companion's bodyGates, on this engine's state). */
  bodyGates(env = this.env()): BodyStageGates {
    const view = env.view, clips = this.clips;
    if (!clips || !this.model) return CLOSED_BODY_GATES;
    return {
      ready: view?.body?.mode !== 'maintainer-qa', // the QA stand is the old stage's developer check
      enabled: !!view?.expressions && (view.snapshot?.intensity?.posture ?? 0) > 0,
      visible: env.shown,
      manualPose: env.blocks.manualPose, manualGesture: env.blocks.manualGesture, manualExpression: env.blocks.face,
      manualHead: env.blocks.head && (env.blocks.manualPose || env.blocks.manualGesture), dynamicPose: env.blocks.dynamicPose || env.walking === true,
      cameraOrWindow: env.behaviorBlocked || env.adjusting,
      inputBlocked: env.behaviorBlocked || env.inputBlocked || env.typing,
      directContact: env.pat || env.feeding || env.pinch || env.hover || env.pulled || (!!view && view.snapshot?.phase !== 'idle'),
      music: env.music === true, speaking: env.speaking, waitingForReply: env.thinking,
      chatGesture: clips.chat.getState().active || !!view?.gesture || clips.action.active,
    };
  }

  /**
   * Row 34: the owners her reactions to your pose give way to (the old stage's HerLifeStage gates): the user here (typing, speaking, a
   * reply, a touch, a window or camera move, a chat gesture, a show), a higher owner of her body, her sleep.
   */
  lifeGates(env = this.env()): HerLifeStageGates {
    const view = env.view, phase = view?.fatigue?.phase, gates = this.bodyGates(env), clips = this.clips;
    const bodyMotion = !!clips && clips.bodyTracks().length > 0;
    return {
      expressive: view?.expressions === true,
      engaged: env.typing || env.speaking || env.thinking || gates.directContact || env.behaviorBlocked || env.adjusting || !!clips?.chat.getState().active
        || !!view?.gesture || env.showing || env.music === true,
      bodyOwned: env.blocks.manualPose || env.blocks.manualGesture || env.blocks.dynamicPose || gates.manualHead || bodyMotion || clips?.action.active === true,
      asleep: env.asleep || view?.fatigue?.sleeping === true || phase === 'falling-asleep' || phase === 'asleep' || phase === 'micro-awake',
      posture: view?.snapshot?.intensity?.posture ?? 0,
    };
  }

  /** The chat gesture gives way this frame (the companion's chatGestureFrameBlocked; asleep here is the sleep body). */
  chatBlocked(env = this.env()): boolean {
    const view = env.view;
    return env.give || env.hands || env.behaviorBlocked || env.typing || env.adjusting || env.blocks.chatGesture || !view?.expressions
      || view.snapshot?.intensity?.posture === 0 || env.pat || env.feeding || env.hover || env.asleep || env.pulled;
  }

  /** Who holds her for a body action now, in the note's words (empty: free). A higher owner wins; the action does not queue. */
  actionBusy(mode: HerActionMode, env = this.env()): string {
    if (!env.shown) return HER_ACTION_DETAILS.hidden;
    if (env.pat || env.feeding || env.pinch || env.hover || env.pulled) return HER_ACTION_DETAILS.contact;
    if (env.behaviorBlocked || env.adjusting) return HER_ACTION_DETAILS.adjusting;
    if (env.rps) return HER_ACTION_DETAILS.game;
    if (mode === 'arms' ? env.blocks.chatGesture : env.blocks.head && (env.blocks.manualPose || env.blocks.manualGesture)) return HER_ACTION_DETAILS.manual;
    if (env.showing) return HER_ACTION_DETAILS.preview;
    if (this.clips?.action.active) return HER_ACTION_DETAILS.previous;
    return '';
  }

  /** Who holds the mouth or the lids for a face shape now (the companion's faceActionBusy). */
  faceBusy(scope: 'mouth' | 'eyelids', env = this.env()): string {
    if (!env.shown) return HER_ACTION_DETAILS.hidden;
    if (env.pat || env.feeding || env.pinch) return HER_ACTION_DETAILS.contact;
    if (env.blocks.face || env.blocks.mouth) return HER_ACTION_DETAILS.manualFace;
    if (env.rps) return HER_ACTION_DETAILS.game;
    if (env.showing) return HER_ACTION_DETAILS.preview;
    if (env.reacting) return HER_ACTION_DETAILS.reaction;
    if (scope === 'mouth' && (env.speaking || env.preparing)) return HER_ACTION_DETAILS.speaking;
    if (scope === 'eyelids' && (env.lidsHeld > 0.02 || env.view?.fatigue?.sleeping === true || env.asleep)) return HER_ACTION_DETAILS.eyesClosed;
    if (this.face?.busy(scope)) return HER_ACTION_DETAILS.previousFace;
    return '';
  }

  /** The plans read again with the gates as they are now (the body motion and the behaviour faces). */
  private update(env = this.env()): void {
    const clips = this.clips, view = this.view;
    if (!clips) return;
    clips.bodyGates = this.bodyGates(env);
    clips.body?.update(view?.body, view?.token ?? '', clips.bodyGates);
    const gates = {
      enabled: !!view?.expressions && (view.snapshot?.intensity?.expression ?? 0) > 0, visible: env.shown, faceBlocked: env.blocks.face,
      directContact: env.pat || env.feeding || env.hover, windowAdjusting: env.behaviorBlocked, cameraAdjusting: env.adjusting,
      protectedMorphIndices: [] as number[], naturalBlink: env.blink,
    };
    // Batch 7 (row 43): the control window's visual preview plays instead of the mood's faces (window-previews.ts).
    const plan = this.preview?.plan() ?? null, preview = plan?.kind === 'cue' ? plan : null;
    if (plan?.kind === 'composition') {
      if (!clips.behavior) return;
      const preview = plan;
      this.behaviorToken = preview.token;
      if (!preview.resource) { clips.behavior.update(null, preview.token, gates); return; } // its grant is still on the way
      if (preview.strength <= 0) { this.preview?.failed(); return; } // no mood view: refused, as on the old stage
      // Easing out: the gates that made it end do not cut it (it fades from where it is); the composition's own checks stay.
      const shown = preview.fading ? { ...gates, faceBlocked: false, directContact: false, windowAdjusting: false, cameraAdjusting: false } : gates;
      const value = preview.strength * preview.weight;
      if (value <= 1e-4) clips.behavior.update(null, preview.token, shown);
      else if (!clips.behavior.setComposition(preview.resource, preview.token, { ...shown, protectedMorphIndices: this.preview?.protectedMorphs() ?? [] }, value)) this.preview?.failed();
      return;
    }
    // Behaviour faces: a new conversation's token waits until the old faces have faded (the player cuts on a token change).
    const token = preview ? preview.token : view?.token ?? '';
    const holdOld = token !== this.behaviorToken && clips.behavior?.getState().active === true;
    if (!holdOld) this.behaviorToken = token;
    if (preview && !holdOld) clips.behavior?.consumeSuppressed(view?.behavior ?? null);
    clips.behavior?.update(holdOld ? null : preview ? preview.plan as never : view?.behavior ?? null, this.behaviorToken, gates);
  }

  /** Batch 7 (row 43): the control window's visual preview (window-previews.ts) for the behaviour-face player; null: none. */
  private preview: { plan(): VisualPreviewPlan | null; resolveFor(cueId: string, token: string): Promise<BehaviorMotionResource> | null; failed(): void;
    protectedMorphs(): number[] } | null = null;
  setPreview(source: WindowMotions['preview']): void { this.preview = source; }
  /** The plans read again now (a preview started or ended). */
  refreshFaces(): void { this.update(); }

  /** Each frame, before her body's frame: the gates for what plays, and the face shape's writes taken off (it writes last). */
  frame(): void {
    this.restoreFace();
    const clips = this.clips;
    if (!clips) return;
    const env = this.env();
    if (!env.shown) { if (clips.moving) clips.stopAll(); clips.actionGate = { yield: false, cut: true }; return; }
    if (clips.chat.getState().active && this.chatBlocked(env)) clips.yieldChat();
    const mode = clips.action.getState().mode ?? 'arms';
    clips.actionGate = { cut: false, yield: env.pat || env.feeding || env.pinch || env.hover || env.behaviorBlocked || env.adjusting || env.rps || env.give
      || env.hands || (mode === 'arms' ? env.blocks.chatGesture : env.blocks.head && (env.blocks.manualPose || env.blocks.manualGesture)) || env.showing };
    this.update(env);
  }

  /** Nothing is drawn (hidden, minimised, no size): what plays stops at once and nothing resumes later (the old stage's notRendering). */
  notShown(): void {
    const clips = this.clips;
    if (clips && (clips.moving || clips.behavior?.getState().active)) clips.stopAll();
    if (this.faceActive) this.face?.cut('hidden');
  }

  /** After her body's frame (her mouth included): a face shape writes its group over every other face writer. */
  afterBody(delta: number): void {
    const face = this.face, mesh = this.model?.mesh;
    if (!face || !mesh) return;
    this.startWaitingMouth(face);
    const live = face.active('mouth') || face.active('eyelids');
    let cancel: Partial<Record<'mouth' | 'eyelids', string | null>> | undefined;
    if (live) {
      const env = this.env(), manual = env.blocks.face || env.blocks.mouth, preview = env.showing;
      cancel = {
        mouth: env.speaking || env.preparing ? 'speech' : env.feeding ? 'feeding' : manual ? 'manual' : preview ? 'preview' : null,
        eyelids: env.lidsHeld > 0.02 || env.pat || env.pinch ? 'closure' : manual ? 'manual' : preview ? 'preview' : env.view?.fatigue?.sleeping === true ? 'sleep' : null,
      };
      if (cancel.mouth === 'speech') this.mouth.speechTakes(face.getState().mouth?.id ?? null, this.now()); // I-175: a pout carries on as the expression
    }
    face.frame(delta, { key: this.scopeKey(), cancel }, mesh.morphTargetInfluences, this.faceLayers);
    if (this.faceLayers.length) this.model?.standardFace?.present(); // I-164: a VRM shows what the face shape wrote this frame
  }
  /**
   * I-175: a closed-mouth shape that waited for a pause starts now if it may: never while the held "she is speaking" is on (or she is about
   * to), never mid-sentence with read-aloud off, only when every other owner of her mouth lets it (closedMouthMayStart, part-mix).
   */
  private startWaitingMouth(face: FaceExclusive): void {
    if (!this.mouth.queue.size) return;
    const env = this.env(), held = env.speaking || env.preparing;
    // `free`: the other owners only (speech is `held`, asked by the rule itself), so the rule alone decides about speech.
    const world = { held, sentenceOpen: env.sentenceOpen === true, free: this.faceBusy('mouth', { ...env, speaking: false, preparing: false }) === '' };
    const next = this.mouth.queue.frame(this.now() / 1000, world);
    if (!next || !closedMouthMayStart(world)) return;
    if (next.face !== face || next.request.key !== this.scopeKey()) return; // another model or conversation since: not played
    if (face.request(next.request) === true) next.played();
  }

  /** I-175: a cancelled reply, a new reply or a new conversation: the closed-mouth shapes still waiting never play. */
  dropWaitingMouth(): void { this.mouth.cancel(); }

  /** The face shape's writes put back (before anything else writes her face this frame). */
  private restoreFace(): void {
    const influences = this.model?.mesh.morphTargetInfluences;
    if (influences) for (let k = this.faceLayers.length - 1; k >= 0; k--) influences[this.faceLayers[k].index] = this.faceLayers[k].value;
    this.faceLayers.length = 0;
  }

  // ---- row 30: the chat gesture ------------------------------------------------------------------------------------------------
  async playChatGesture(cue: ChatGestureCue, token: string): Promise<void> {
    if (this.chatIds.has(cue.id)) return;
    this.chatIds.add(cue.id);
    if (this.chatIds.size > 256) this.chatIds.delete(this.chatIds.values().next().value!);
    const model = this.model, clips = this.clips, generation = ++this.chatGeneration;
    clips?.body?.cancel();
    const allowed = () => {
      const env = this.env(), view = env.view;
      return !this.disposed && this.model === model && this.clips === clips && this.chatGeneration === generation && env.shown && view?.token === token
        && view.gesture?.id === cue.id && this.now() < cue.expiresAt && !this.chatBlocked(env) && !env.pinch && !clips?.action.active; // her action showing: dropped, not queued
    };
    if (!model || !clips || !allowed() || this.now() - cue.at > 1_500) return;
    try {
      const resource = await this.host.resolveChatGesture(cue.id, token);
      if (!allowed()) return;
      let pending = this.chatClips.get(resource.sha256);
      if (!pending) {
        pending = loadLibraryClip(resource.url, model.mesh, model.transform).then(clip => {
          // Pretrial 2026-11-03: the captured gestures' frame-to-frame jitter is low-passed once, in memory (capture-smoothing.ts).
          clip.duration = resource.durationMs / 1000; smoothCapturedClip(clip, isChatGestureTrack); return clip;
        });
        this.chatClips.set(resource.sha256, pending);
        const held = pending;
        void held.catch(() => { if (this.chatClips.get(resource.sha256) === held) this.chatClips.delete(resource.sha256); });
      }
      const clip = await pending;
      if (!allowed() || this.now() - cue.at > 1_500 || this.unfit(resource.sha256)) return;
      clips.chat.play({ id: cue.id, clip, strength: cue.strength });
    } catch { /* not granted or not loaded: her motion stays as it was */ }
  }

  // ---- row 31: her actions -------------------------------------------------------------------------------------------------------
  /**
   * 她的动作 (T-211): one cue from the host, played once on this model. A missing part, a motion the fit check hides here, a moment a higher
   * owner holds her: she says so (reportHerAction) and does not queue it.
   */
  async playHerAction(value: unknown): Promise<void> {
    if (!isHerActionCue(value) || this.disposed || this.now() > value.expiresAt) return;
    const cue = value;
    if (this.actionIds.has(cue.id)) return;
    this.actionIds.add(cue.id);
    if (this.actionIds.size > 64) this.actionIds.delete(this.actionIds.values().next().value!);
    const spec = HER_ACTION_SPECS[cue.action];
    const report = (status: HerActionStatus, missing: string[] = [], detail = '') => {
      this.info = { cueId: cue.id, action: cue.action, status, missing, detail };
      void this.host.reportHerAction({ cueId: cue.id, status, missing, detail })?.catch?.(() => {});
    };
    if (spec.mode === 'face') { await this.playFaceAction(cue, spec, report); return; }
    const model = this.model, clips = this.clips, generation = ++this.actionGeneration, key = this.scopeKey();
    if (!model || !clips) { report('failed', [], HER_ACTION_DETAILS.noModel); return; }
    // X-321: a body action starts only in the character and conversation it arrived in.
    const stale = () => this.disposed || this.model !== model || this.clips !== clips || this.actionGeneration !== generation || this.scopeKey() !== key || this.now() > cue.expiresAt;
    const profile = model.profile?.profile ?? null;
    const has = (slot: StandardBone) => { const state = profileBoneState(profile, slot); return state === true ? !!model.profile?.bone(slot) : state; };
    const before = herActionMissing(spec, has, undefined, profileFingerCount(profile));
    if (before.length) { report('missing', before); return; }
    const busy = this.actionBusy(spec.mode);
    if (busy) { report('busy', [], busy); return; }
    try {
      const resource = await this.host.resolveHerAction(cue.id);
      if (stale()) return;
      if (resource?.action !== cue.action || resource.sha256 !== spec.sha256 || typeof resource.url !== 'string') { report('failed', [], HER_ACTION_DETAILS.resource); return; }
      let pending = this.actionClips.get(resource.sha256);
      if (!pending) {
        pending = loadLibraryClip(resource.url, model.mesh, model.transform).then(clip => { clip.duration = spec.durationFrames / 30; return clip; });
        this.actionClips.set(resource.sha256, pending);
        const held = pending;
        void held.catch(() => { if (this.actionClips.get(resource.sha256) === held) this.actionClips.delete(resource.sha256); });
      }
      const clip = await pending;
      if (stale()) return;
      if (this.unfit(resource.sha256)) {
        // T-213: which part, when the fit check held it back because this skeleton hangs a body part elsewhere.
        const structure = model.retarget?.fitOf(resource.sha256)?.issues.some(issue => issue.startsWith('structure:')) === true;
        const parts = structure ? (model.retarget?.plan?.structure ?? []).map(row => HER_ACTION_PART_NAMES[row.bone] ?? row.bone) : [];
        report('unfit', parts, parts.length ? HER_ACTION_DETAILS.structure : UNFIT); return;
      }
      const names = new Set(clips.action.bindable(clip, spec.durationFrames / 30));
      const bound = (slot: StandardBone) => { const bone = model.profile?.bone(slot); return !!bone && names.has(`.bones[${bone.name}].quaternion`); };
      const fingers = { left: 0, right: 0 }, joints = profileFingerNames(profile);
      for (const name of names) { const side = joints.get(/^\.bones\[(.+)\]\.quaternion$/.exec(name)?.[1] ?? ''); if (side) fingers[side]++; }
      const after = herActionMissing(spec, has, bound, fingers);
      if (after.length) { report('missing', after); return; }
      const still = this.actionBusy(spec.mode);
      if (still) { report('busy', [], still); return; }
      // One upper-body overlay at a time: a chat gesture in flight hands back first (R29d), then the action fades in over it.
      if (clips.chat.getState().active) clips.yieldChat();
      if (!clips.action.play({ id: cue.id, clip, mode: spec.mode, durationS: spec.durationFrames / 30, rate: spec.rate, strength: spec.strength })) {
        report('failed', [], HER_ACTION_DETAILS.noTracks); return;
      }
      // 哈欠捂嘴: the hand is the action; the yawn itself (mouth, lids, chin) is the P1 one, started on the same clock (window-reactions.ts).
      if (spec.companion === 'yawn') this.yawnCue = { id: `yawn-${cue.id.slice(0, 60)}`, at: this.now() };
      report('played');
    } catch {
      if (!stale()) report('failed', [], HER_ACTION_DETAILS.load);
    }
  }

  /** T-215: a face shape goes to the face exclusive (its own lease on the mouth or the eyelids), never the body clips. */
  private async playFaceAction(cue: HerActionCue, spec: HerActionSpec, report: (status: HerActionStatus, missing?: string[], detail?: string) => void): Promise<void> {
    const model = this.model, face = this.face, key = this.scopeKey(), faceSpec = spec.face!, scope = faceSpec.scope;
    if (!model || !face) { report('failed', [], HER_ACTION_DETAILS.noModel); return; }
    if (model.standard && !model.standardFace) { report('failed', [], HER_ACTION_DETAILS.noTracks); return; } // a VRM without its face view (I-164)
    const stale = () => this.disposed || this.model !== model || this.face !== face || this.scopeKey() !== key || this.now() > cue.expiresAt;
    const env = this.env();
    if (scope === 'mouth' ? env.mouthOff : env.eyesOff) { report('failed', [], scope === 'mouth' ? HER_ACTION_DETAILS.mouthOff : HER_ACTION_DETAILS.eyesOff); return; }
    const profile = model.profile?.profile ?? null, mesh = model.mesh;
    const resolved = resolveFaceMorphs(faceSpec, { names: mesh.morphTargetDictionary, count: mesh.morphTargetInfluences?.length ?? 0,
      slot: slot => profile ? profile.morphs[slot]?.index ?? -1 : null, displaces: index => face.displaced(index).length > 0 });
    if (resolved.missing.length) { report('missing', resolved.missing); return; }
    const busy = this.faceBusy(scope);
    // I-175: while she speaks, a pout talks through (her face shows it, lip-sync opens on top); a closed-mouth shape loads and waits for a pause.
    // Read-aloud off, mid-sentence (T-258 C01): nobody holds the mouth, but a closed-mouth shape still waits for the sentence end.
    const speaking = this.mouthWaits(scope, busy, env) ? this.mouth.kind(cue.action) : null;
    if (speaking === 'talk-through') { this.talkThrough(cue.action, spec, report); return; }
    if (busy && speaking !== 'closed') { report('busy', [], busy); return; }
    try {
      const resource = await this.host.resolveHerAction(cue.id);
      if (stale()) return;
      if (resource?.action !== cue.action || resource.sha256 !== spec.sha256 || typeof resource.url !== 'string') { report('failed', [], HER_ACTION_DETAILS.resource); return; }
      let pending = this.faceClips.get(resource.sha256);
      if (!pending) {
        pending = loadVmd(resource.url); // morph keys only: no clip is built, nothing binds to the mixer
        this.faceClips.set(resource.sha256, pending);
        const held = pending;
        void held.catch(() => { if (this.faceClips.get(resource.sha256) === held) this.faceClips.delete(resource.sha256); });
      }
      const vmd = await pending;
      if (stale()) return;
      const tracks = faceWriteTracks(resolved.writes, faceTracksByName(vmd.morphs ?? []));
      if (!tracks.length) { report('failed', [], HER_ACTION_DETAILS.noTracks); return; }
      const still = this.faceBusy(scope), kind = this.mouthWaits(scope, still, this.env()) ? this.mouth.kind(cue.action) : null;
      if (kind === 'talk-through') { this.talkThrough(cue.action, spec, report); return; }
      // A natural blink in progress: the lids' shape waits for it to open (at most the companion's wait).
      const delay = scope === 'eyelids' && this.env().blink > 0 ? 0.2 : 0;
      const scales = model.profile?.scales, duration = spec.durationFrames / 30;
      const request = { id: cue.id, scope, key, duration, tracks, delay, calibrate: (index: number, value: number) => calibratedWeight(scales, index, value) };
      if (kind === 'closed') { // I-175: waits for the next pause or the end of the reading (window-mouth-actions.ts); dropped 3 s after, or with a cancelled reply
        this.mouth.queue.push({ request, face, played: () => this.mouth.granted(cue.id, cue.action, this.now() + duration * 1000) }, this.now() / 1000);
        report('played', [], HER_ACTION_DETAILS.queued); return;
      }
      if (still) { report('busy', [], still); return; }
      if (delay > FACE_EXCLUSIVE_START_WAIT_S) { report('busy', [], HER_ACTION_DETAILS.blinking); return; }
      const granted = face.request(request);
      if (granted === true) { this.mouth.granted(cue.id, cue.action, this.now() + duration * 1000); report('played', [], resolved.approximations.length ? HER_ACTION_DETAILS.approximate : ''); }
      else report(granted === 'busy' ? 'busy' : 'failed', [], granted === 'busy' ? HER_ACTION_DETAILS.previousFace : HER_ACTION_DETAILS.noTracks);
    } catch {
      if (!stale()) report('failed', [], HER_ACTION_DETAILS.load);
    }
  }

  /** Speaking (the face gate says so) or, read-aloud off, mid-sentence with nobody else holding the mouth: a mouth shape goes by the speaking rules. */
  private mouthWaits(scope: 'mouth' | 'eyelids', busy: string, env: WindowMotionEnv): boolean {
    return scope === 'mouth' && (busy === HER_ACTION_DETAILS.speaking || (busy === '' && closedMouthMustWait({ held: false, sentenceOpen: env.sentenceOpen === true })));
  }

  /** I-175: a pout while she speaks plays as her face's pout expression (lip-sync opens on top); refused only when her face cannot show it. */
  private talkThrough(action: string, spec: HerActionSpec, report: (status: HerActionStatus, missing?: string[], detail?: string) => void): void {
    if (this.mouth.talkThrough(action, spec.durationFrames / 30)) report('played');
    else report('busy', [], HER_ACTION_DETAILS.speaking);
  }

  /** A face shape holds the mouth or the lids now (the stage's face gives way through its own compositors elsewhere). */
  get faceActive(): boolean { return this.face?.active('mouth') === true || this.face?.active('eyelids') === true; }
  /** Something of hers is moving (the frame pace stays full). */
  get moving(): boolean { return this.clips?.moving === true || this.faceActive || this.clips?.behavior?.getState().active === true; }

  /** The developer readouts of her clips (window-readouts.ts): the chat gesture (and why it is blocked), the behaviour faces, the automatic body motion, the bridge. */
  readouts(): { chat: Record<string, unknown> | null; behavior: unknown; body: unknown; bridge: unknown } {
    const clips = this.clips;
    if (!clips) return { chat: null, behavior: null, body: null, bridge: null };
    const blocked = this.chatBlocked();
    return { chat: { ...clips.chat.getState(), blocked }, behavior: clips.behavior?.getState() ?? null,
      body: clips.body?.getState() ?? { active: false, pending: false, mode: 'closed' }, bridge: clips.bridgeState() };
  }

  dispose(): void { if (this.disposed) return; this.attach(null); this.disposed = true; }
}
