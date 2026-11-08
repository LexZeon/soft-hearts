/**
 * R29b scenario harness: the real Stage frame loop (MmdStage.prototype.frameTick)
 * on the bundled public Gene, its reviewed Stand VMD through the real
 * MMDLoader / MMDAnimationHelper / CCDIKSolver path, real procedural life and
 * mood feedback, at a fixed display rate. Every rendered frame records the
 * displayed world rotation of the bones a viewer reads as "the body" and the
 * eyelid / smile morphs, so a hand-off can be measured frame by frame.
 *
 * No renderer, texture, physics engine or IPC: those are inert stand-ins.
 * Hair and chest physics are excluded from the measurement (their bones are
 * excluded from the continuity guard too and only follow these anchors).
 */
import { readFile } from 'node:fs/promises';
import { Box3, Euler, PerspectiveCamera, Quaternion, Scene, Vector3, type AnimationClip, type Bone, type Object3D, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import catalog from '../../shared/motion-catalog.json';
import { BEHAVIOR_RECIPES } from '../../shared/behavior-recipes';
import { BODY_START_AGE_MS, type BodyMotionCue, type BodyMotionPlan, type BodyMotionResource, type BodyRecipeId } from '../../shared/body-motion';
import { createFatigue, fatigueSnapshot } from '../../shared/fatigue';
import { MmdStage } from '../../src/stage/MmdStage';
import { LayeredMmdAnimation } from '../../src/stage/motion-layers';
import { parseVmdWith } from '../../src/stage/vmd';
import { withKeyframeInterpolation } from '../../src/stage/keyframe-interpolation';
import { StageModelProfile } from '../../src/stage/model-profile';
import { StageMotionRetarget, meshRigBones } from '../../src/stage/motion-retarget';
import { ProceduralLife, lifeRig } from '../../src/stage/procedural-life';
import { probeHeadContact } from '../../src/stage/head-contact';
import { MoodFeedback, EMPTY_CONTACT, type MoodContact } from '../../src/stage/mood-feedback';
import { MusicDance, type MusicEnergySample } from '../../src/stage/music-dance';
import { CheekPinchMotion } from '../../src/stage/cheek-pinch-feedback';
import { ChatGesturePlayer } from '../../src/stage/chat-gesture';
import { HerActionPlayer } from '../../src/stage/her-action';
import { FaceExclusive } from '../../src/stage/face-exclusive';
import { HER_ACTION_CUE_MS, HER_ACTION_PACK, HER_ACTION_SPECS, type HerActionCue, type HerActionId, type HerActionOutcome, type HerActionResource } from '../../shared/her-actions';
import { relaxedArmRoll } from '../../src/stage/procedural';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { DEFAULT_BLUSH_CALIBRATION } from '../../shared/blush';
import { normalizeModelPhysicsSettings } from '../../shared/model-physics';
import { normalizeMusicSettings } from '../../shared/music-settings';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../../shared/mood';
import { loadPublicGeneForTargets } from '../public-gene-fixture';

const GENE_ROOT = '../../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/';
/** Bones whose displayed motion is the visible pose (head, neck, torso, shoulders, arms). */
export const TRACKED_BONES = ['センター', '上半身', '上半身2', '首', '頭', '左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ'] as const;
/**
 * R29d: bones the MMD helper derives after the mixer (Gene's grant children and
 * IK links), recorded separately so the R29b/R29c measures stay as they were.
 */
export const DERIVED_BONES = ['右肩連', '左腕捩連', '右腕捩連', '左手捩連', '右手捩連', '右腕xca', '前クローク2_1xca'] as const;

/** Bundled bytes of a catalog motion (the host serves the same bytes over mmd-asset://). */
export function catalogMotionFile(packId: string, motionId: string): URL {
  const pack = catalog.packs.find(value => value.id === packId)!;
  const motion = pack.motions.find(value => value.id === motionId)!;
  return new URL(`../../assets/bundled/${pack.source}/${pack.id}/${pack.revision}/${motion.relativePath}`, import.meta.url);
}
export const catalogSha = (packId: string, motionId: string) =>
  catalog.packs.find(value => value.id === packId)!.motions.find(value => value.id === motionId)!.sha256;
/** A selected-layer AssetRef for a catalog motion, loaded by the Stage's own loadMotions from local bytes. */
export function catalogAsset(packId: string, motionId: string) {
  const url = catalogMotionFile(packId, motionId).href;
  return { path: `${motionId}.vmd`, url, name: `${motionId}.vmd` };
}

const frameTick = (MmdStage.prototype as unknown as { frameTick(this: object, time: number): void }).frameTick;
/** 她的动作: the live cues (as the host keeps them) and the stages' answers, shared by every harness stage of a test process. */
const actionCues = new Map<string, HerActionCue>(), actionReports: HerActionOutcome[] = [];

export interface ShownFrame {
  /** Seconds since the harness started. */
  t: number;
  /** World quaternion per tracked bone, as displayed (continuity offset included). */
  world: Quaternion[];
  /** Eyelid (まばたき) and smile (笑い) weights as displayed. */
  blink: number;
  smile: number;
  /** R29c: the drowsy brow (困る) and eye-shape (じと目) weights as displayed. */
  brow: number;
  jitome: number;
  /** R29d: the shown lip-sync mouth (あ) weight and the derived bones' world rotations (DERIVED_BONES order). */
  mouth: number;
  derived: Quaternion[];
  /** R29d: the display guard's jump count so far and the property it last caught (a jump = a one-frame cut it had to absorb). */
  guardJumps: number;
  guardLast: string | null;
  /** R29f: world rotations of GeneStageOptions.extraBones (empty when none). */
  extra: Quaternion[];
  /** Skeleton step 4: world positions of GeneStageOptions.extraBones, as displayed (model space is world space here). */
  extraAt: Vector3[];
  /** T-215 (GeneStageOptions.recordAll): every morph influence, then every bone's local quaternion and position, as displayed. */
  all: Float64Array | null;
}

/** A deterministic stand-in for a song: steady 120 BPM kick with a moving mid band. */
export function songSample(frame: number, rate = 30): MusicEnergySample {
  const beat = Math.round(rate / 2), kick = frame % beat === 0;
  return { time: frame / rate, rms: kick ? 0.4 : 0.14, low: kick ? 0.8 : 0.1, mid: 0.2 + Math.sin(frame / 20) * 0.1, high: 0.1 };
}

export interface GeneStageOptions {
  fps?: number;
  /** Load the reviewed Stand VMD as the pose layer (the default motion of the bundled card). */
  stand?: boolean;
  music?: boolean;
  /** R29c: a drowsy fatigue view on the verified Gene, so the drowsy face profile (drowsy-expression.ts) is admitted. */
  drowsy?: boolean;
  /** Mood label for the snapshot (default '满足', or 'calm' for drowsy runs). */
  primary?: string;
  /**
   * R29c: one automatic body motion through the real BodyMotionController and
   * BehaviorBodyPlayer (idle-scheduler plan, bundled VMD read from disk instead
   * of the mmd-asset protocol). geneStage resolves once it is playing.
   */
  body?: { recipe: BodyRecipeId; strength?: number };
  /**
   * R29d: the host's chat-gesture grant (resolveChatGesture) for one catalog
   * gesture; the Stage's own playChatGesture loads its bundled bytes.
   */
  chatGesture?: { packId: 'genea-2022-gestures' | 'mpi-embm-gestures'; motionId: 'speaking-gesture-2' | 'conversation-joy' };
  /**
   * R29d: selected layers loaded through the Stage's own loadMotions before the
   * first frame (nothing shown yet, so no bridge), instead of the Stand clip.
   * `retarget` runs first, e.g. to install a fit check.
   */
  layers?: { pose: AssetLike | null; gesture: AssetLike | null; expression: AssetLike | null };
  beforeLayers?(stage: any): void;
  /** 她自己的生活: the host's grant for the pinned Gene motions (resolveHerLifeMotion); the stage's own loader reads their bundled bytes. */
  herLife?: boolean;
  /**
   * R29f: the display's refresh rate. Unset, every tick is one rendered frame at `fps` (the R29 measures).
   * Set, each tick is one requestAnimationFrame callback at this rate and the stage's own frame clock
   * (acceptStageFrame with settings.pet.fps = fps) decides which ones render, as on a real screen;
   * `refreshes` then records, per callback, which rendered frame the screen shows.
   */
  refreshHz?: number;
  /** R29f: deterministic jitter (ms, ±) added to each callback's timestamp, like a real compositor's vsync times. */
  jitterMs?: number;
  /** R29f: extra bones recorded per rendered frame (`ShownFrame.extra`), e.g. the eyes. */
  extraBones?: readonly string[];
  /** I-016: the capture's samples (default songSample), e.g. analyserSamples of a synthetic clip; past its end, silence. */
  samples?: readonly MusicEnergySample[];
  /** 她的动作 (T-211): the host's resolveHerAction for the cues `playAction` makes; the stage's own loader reads the bundled bytes. */
  herActions?: boolean;
  /** T-215: false leaves the stage without its face exclusive (as before T-215); default: the stage's own, per mesh. */
  faceExclusive?: boolean;
  /** T-215: record ShownFrame.all (every morph and bone as displayed) for exact comparisons. */
  recordAll?: boolean;
  /** Skeleton step 2: Gene with some morphs under other names (a "renamed Gene"), before its profile is built. Bytes on disk untouched. */
  renameMorphs?: Readonly<Record<string, string>>;
  /**
   * Skeleton step 3: Gene as another model whose rest skeleton is edited in memory (e.g. hands rolled about the forearm; the
   * skin is re-bound, so the mesh itself does not move). It is no longer the reviewed Gene: every library motion, the stand
   * included, goes through the stage's own retarget (StageMotionRetarget with a profile built from this mesh).
   */
  restEdit?: (bones: { name: string; parent: number; position: [number, number, number] }[]) => void;
  /** Skeleton step 5: as restEdit, and the edit also gets the mesh so the skin can move with the bones (body-variants.ts meshFollows). */
  restEditSkin?: (bones: { name: string; parent: number; position: [number, number, number] }[], mesh: SkinnedMesh) => void;
  /**
   * I-038: Gene with some bones under other names (e.g. English), before its profile and retarget are made. It is then another
   * model to the stage (no reviewed profile; every library motion goes through the retarget). The harness's own lookups (tracked
   * bones, head, eyes) follow the new names, so frames compare one to one with Gene's.
   */
  renameBones?: Readonly<Record<string, string>>;
  /** I-038: the stage was not told this is the reviewed Gene (bodyTargetSupported false, as for any other model), from the start. */
  notReviewed?: boolean;
}
type AssetLike = { path: string; url: string; name: string };

/** Bundled file for a body recipe's registered motion (the host serves the same bytes over mmd-asset://). */
function bodyMotionFile(recipe: BodyRecipeId): URL {
  const { packId, motionId } = BEHAVIOR_RECIPES[recipe];
  return catalogMotionFile(packId, motionId);
}

export async function geneStage(options: GeneStageOptions = {}) {
  const fps = options.fps ?? 60;
  const keys = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const body = options.body;
  const cue: { -readonly [K in keyof BodyMotionCue]: BodyMotionCue[K] } | null = body ? { id: 'r29c-body', token: 'gene_token', recipeId: body.recipe, at: 0,
    expiresAt: 0, durationMs: BEHAVIOR_RECIPES[body.recipe].durationMs, strength: body.strength ?? 0.3 } : null;
  const plan: BodyMotionPlan = cue ? { mode: 'idle-scheduler', reason: 'idle-issued', observationEpoch: 'r29c-epoch', cue }
    : { mode: 'closed', reason: 'normal-pool-closed', cue: null };
  // The cue is issued when the stage first asks for the plan, as the host would, so loading Gene
  // (slow when the whole suite runs in parallel) never counts against the cue's start age ("late").
  const issueCue = () => {
    if (!cue || cue.at) return;
    cue.at = Date.now(); cue.expiresAt = cue.at + cue.durationMs + BODY_START_AGE_MS;
  };
  Object.assign(globalThis, {
    document: { hidden: false },
    window: { devicePixelRatio: 1, desktop: {
      getBehaviorBodyPlan: async () => { issueCue(); return plan; },
      resolveBehaviorBody: async (): Promise<BodyMotionResource> => {
        if (!cue) throw Error('This harness grants no body resource.');
        const recipe = BEHAVIOR_RECIPES[cue.recipeId];
        return { cueId: cue.id, recipeId: cue.recipeId, packId: recipe.packId as BodyMotionResource['packId'],
          motionId: recipe.motionId as BodyMotionResource['motionId'], sha256: recipe.sha256, maskId: recipe.mask as BodyMotionResource['maskId'],
          durationMs: recipe.durationMs, url: `mmd-asset://${'a'.repeat(32)}/${recipe.motionId}.vmd` };
      },
      ...(options.chatGesture ? { resolveChatGesture: async (cueId: string) => {
        const { packId, motionId } = options.chatGesture!;
        const entry = catalog.packs.find(value => value.id === packId)!.motions.find(value => value.id === motionId)!;
        // Unrounded, as the host grants it (electron/chat-gesture.ts: conversation-joy is 2933.333 ms): a rounded-down
        // duration ends before the clip's last key and the player refuses every track.
        return { cueId, intent: 'explain', packId, motionId, sha256: entry.sha256, durationMs: entry.durationFrames / 30 * 1000,
          url: `mmd-asset://${'b'.repeat(32)}/${motionId}.vmd` };
      } } : {}),
      ...(options.herLife ? { resolveHerLifeMotion: async (motionId: string) => ({ motionId, sha256: catalogSha('gene', motionId), durationMs: 10_000,
        url: `mmd-asset://${'c'.repeat(32)}/${motionId}.vmd` }) } : {}),
      ...(options.herActions ? {
        resolveHerAction: async (cueId: string): Promise<HerActionResource> => {
          const live = actionCues.get(cueId);
          if (!live) throw Error('这个动作已经结束或失效。');
          return { cueId, action: live.action, packId: HER_ACTION_PACK, motionId: live.action, sha256: HER_ACTION_SPECS[live.action].sha256,
            durationMs: HER_ACTION_SPECS[live.action].durationFrames / 30 * 1000, url: `mmd-asset://${'d'.repeat(32)}/${live.action}.vmd` };
        },
        reportHerAction: async (outcome: HerActionOutcome) => { actionReports.push(outcome); },
      } : {}),
    } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  });
  // The Stage's own loaders (MMDLoader + createVmdParser + its checks) run unchanged; only the byte fetch is local:
  // file: URLs (selected layers), the body grant and the chat-gesture grant.
  type VmdLoader = { loadVMD(url: string, onLoad: (vmd: unknown) => void, onProgress?: unknown, onError?: (error: unknown) => void): void; _getParser(): { parseVmd(buffer: ArrayBuffer, leftToRight: boolean): unknown } };
  const loaderPrototype = MMDLoader.prototype as unknown as VmdLoader, loadVMD = loaderPrototype.loadVMD;
  const localFile = (url: string): URL => {
    if (url.startsWith('file:')) return new URL(url);
    if (body && url === `mmd-asset://${'a'.repeat(32)}/${BEHAVIOR_RECIPES[body.recipe].motionId}.vmd`) return bodyMotionFile(body.recipe);
    if (options.chatGesture && url === `mmd-asset://${'b'.repeat(32)}/${options.chatGesture.motionId}.vmd`)
      return catalogMotionFile(options.chatGesture.packId, options.chatGesture.motionId);
    const herLife = /^mmd-asset:\/\/c{32}\/(thinking|sleepy)\.vmd$/.exec(url);
    if (options.herLife && herLife) return catalogMotionFile('gene', herLife[1]);
    const action = /^mmd-asset:\/\/d{32}\/([a-z-]+)\.vmd$/.exec(url);
    if (options.herActions && action) return catalogMotionFile(HER_ACTION_PACK, action[1]);
    throw Error(`unexpected VMD URL ${url}`);
  };
  loaderPrototype.loadVMD = function (this: VmdLoader, url, onLoad, _progress, onError) {
    Promise.resolve().then(() => readFile(localFile(url))).then(bytes => {
      onLoad(this._getParser().parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, true));
    }).catch(error => onError?.(error));
  };
  const gene = await loadPublicGeneForTargets();
  const mesh = gene.mesh as SkinnedMesh;
  if (options.renameMorphs) {
    for (const target of mesh.geometry.morphAttributes.position ?? []) if (Object.hasOwn(options.renameMorphs, target.name)) target.name = options.renameMorphs[target.name];
    mesh.updateMorphTargets();
  }
  if (options.renameBones) for (const value of mesh.skeleton.bones as Bone[]) if (Object.hasOwn(options.renameBones, value.name)) value.name = options.renameBones[value.name];
  mesh.updateWorldMatrix(true, true);
  let motionRetarget: StageMotionRetarget | null = null;
  if (options.restEdit || options.restEditSkin || options.renameBones) {
    const rest = meshRigBones(mesh);
    if (options.restEditSkin) options.restEditSkin(rest, mesh); else options.restEdit?.(rest);
    mesh.skeleton.bones.forEach((value: Bone, index: number) => {
      const own = rest[index].position, parent = rest[index].parent, base = parent >= 0 ? rest[parent].position : [0, 0, 0];
      value.position.set(own[0] - base[0], own[1] - base[1], own[2] - base[2]);
    });
    mesh.updateMatrixWorld(true);
    mesh.skeleton.calculateInverses();
    motionRetarget = new StageMotionRetarget(mesh, new StageModelProfile(mesh, { reviewed: false }).profile, { reviewed: false });
  }
  const animation = new LayeredMmdAnimation(mesh);
  if (options.stand !== false && !options.layers) {
    const bytes = await readFile(new URL(`${GENE_ROOT}motions/pose/stand.vmd`, import.meta.url));
    const vmd = parseVmdWith(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, motionRetarget?.transform);
    // R29f: the stage builds every clip with keyframe interpolation (withKeyframeInterpolation); so does this stand-in for its default motion.
    const builder = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(vmd: unknown, mesh: SkinnedMesh): AnimationClip } }).animationBuilder;
    const clip = builder.build(vmd, mesh);
    clip.duration = Math.max(clip.duration, 120 / 30);
    animation.setClips({ pose: clip, gesture: null, expression: null });
  }
  const bone = (name: string) => mesh.skeleton.bones.find((value: Bone) => value.name === (options.renameBones?.[name] ?? name)) as Bone;
  const bounds = new Box3().setFromObject(mesh);
  const height = Math.max(1, bounds.max.y - bounds.min.y);
  const profile = new StageModelProfile(mesh, { reviewed: !options.renameBones });
  const head = bone('頭'), eyes = [bone('左目'), bone('右目')];
  profile.attachHead(head);
  const chest = mesh.skeleton.bones.find((value: Bone) => ['上半身2', '上半身', 'spine', 'Spine', 'Chest'].includes(value.name));
  const arms = (['左腕', '右腕'] as const).map(name => {
    const arm = bone(name), child = arm.children.find((node: Object3D) => (node as Bone).isBone) as Bone;
    return { bone: arm, roll: relaxedArmRoll(child.position.x, child.position.y) };
  });
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.pet.fps = fps; settings.pet.followMouse = true;
  const camera = new PerspectiveCamera(32, 400 / 560, 0.1, 3000);
  camera.position.set(0, height * 0.55, height * 1.6); camera.lookAt(0, height * 0.55, 0); camera.updateMatrixWorld(true);
  // Drowsy runs use a calm mood: a content smile would (rightly) keep the drowsy eye shape out.
  const snapshot = { ...getMoodSnapshot(createMoodState(0)), primary: options.primary ?? (options.drowsy ? 'calm' : '满足') };
  const fatigue = options.drowsy
    ? { ...fatigueSnapshot(createFatigue({ monotonicMs: 0, localMinute: 900 }, { A: 0.9, F: 0.8, phase: 'drowsy' })), sleepEntryReady: true }
    : undefined;
  const shown: ShownFrame[] = [];
  const tracked = TRACKED_BONES.map(name => bone(name)), derived = DERIVED_BONES.map(name => bone(name));
  const extra = (options.extraBones ?? []).map(name => bone(name));
  /** R29f: per display callback (refreshHz mode), its time and the index in `shown` of the frame on screen (-1: none yet). */
  const refreshes: { t: number; frame: number }[] = [];
  const blinkIndex = profile.indices.blink, smileIndex = profile.indices.smile, browIndex = profile.indices.sad, mouthIndex = profile.indices.mouth;
  const jitomeIndex = mesh.morphTargetDictionary?.['じと目'] ?? -1;
  const scratch = new Quaternion();
  let now = 1000, t = 0;
  const renderer = { domElement: { dataset: {} as Record<string, string> }, render() {
    mesh.updateMatrixWorld(true);
    const influences = mesh.morphTargetInfluences ?? [];
    shown.push({ t, world: tracked.map((value: Bone) => value.getWorldQuaternion(scratch).clone()),
      blink: influences[blinkIndex] ?? 0, smile: influences[smileIndex] ?? 0, brow: influences[browIndex] ?? 0, jitome: influences[jitomeIndex] ?? 0,
      mouth: influences[mouthIndex] ?? 0, derived: derived.map((value: Bone) => value.getWorldQuaternion(scratch).clone()),
      guardJumps: stage.continuity?.getState().jumps ?? 0, guardLast: stage.continuity?.getState().lastJump?.property ?? null,
      extra: extra.map((value: Bone) => value.getWorldQuaternion(scratch).clone()), extraAt: extra.map((value: Bone) => value.getWorldPosition(new Vector3())),
      all: options.recordAll ? everything() : null });
  } };
  const everything = () => {
    const influences = mesh.morphTargetInfluences ?? [], bones = mesh.skeleton.bones, out = new Float64Array(influences.length + bones.length * 7);
    influences.forEach((value: number, index: number) => { out[index] = value; });
    bones.forEach((value: Bone, index: number) => { const o = influences.length + index * 7; value.quaternion.toArray(out, o); value.position.toArray(out, o + 4); });
    return out;
  };
  const statuses: string[] = [];
  const stage = Object.create(MmdStage.prototype) as any;
  Object.assign(stage, { surprisePending: null, surprisePreview: null });
  Object.assign(stage, {
    modelUrl: '', blushCalibrationModelUrl: '', blushCalibration: structuredClone(DEFAULT_BLUSH_CALIBRATION),
    scene: new Scene(), mesh, camera, settings, options: { transparent: true, onStatus: (message: string) => statuses.push(message) }, container: { clientWidth: 400, clientHeight: 560 },
    controls: { interacting: false, update() {}, setEnabled() {} }, renderer,
    animation, motionTransition: null, behaviorMotion: null, chatGesturePlayer: options.chatGesture ? new ChatGesturePlayer(mesh) : null,
    herAction: options.herActions ? new HerActionPlayer(mesh) : null, herActionGeneration: 0, herActionInfo: null,
    faceExclusive: options.faceExclusive === false ? null : new FaceExclusive(mesh), faceActionGeneration: 0, faceSpeech: null, lidHeld: 0,
    head, eyes, chest, center: bone('センター'), arms, height, modelProfile: profile,
    headContactProfile: probeHeadContact(mesh, head, eyes, height, profile.contactEyes),
    life: new ProceduralLife<Bone>(), lifeEnabled: true, lifeRig: lifeRig(mesh, profile, chest),
    elapsed: 0, previousFrame: 0, frameId: 0, disposed: false, hostVisible: true, hasRenderedModel: false,
    pointer: { x: 0.1, y: -0.05 }, gaze: { x: 0, y: 0 }, eyeGaze: { x: 0, y: 0 }, gazeOrigin: new Vector3(), eyePoint: new Vector3(), facePoint: new Vector3(),
    rotation: new Euler(), offset: new Quaternion(), nextBlink: 2.5, blinkStart: -10, naturalBlink: 0, finalEyeClosure: 0, speaking: false, mouth: 0,
    blinkIndex, mouthIndex: profile.indices.mouth, smileIndex, sadIndex: profile.indices.sad, blushChannel: null, boneLayers: [], morphLayers: [],
    restPose: mesh.skeleton.bones.map((value: Bone) => ({ bone: value, position: value.position.clone(), quaternion: value.quaternion.clone() })),
    moodFeedback: new MoodFeedback(), moodContact: { ...EMPTY_CONTACT }, moodView: null,
    moodFaceBlocked: false, moodHeadBlocked: false, moodMouthBlocked: false,
    musicDance: new MusicDance(), musicEnabled: false, musicSettings: normalizeMusicSettings(undefined), musicSuppressed: false, musicManualHeadBlocked: false,
    musicCameraEditing: false, musicBlockReason: null, musicFrameSerial: 0,
    musicPose: { sway: 0, bounce: 0, chestRoll: 0, headRoll: 0, headPitch: 0 }, musicPoint: new Vector3(),
    cheekMotion: new CheekPinchMotion(), cheekAnchors: null,
    proceduralBlush: null, blushPreviewUntil: 0, blushPreviewing: false, behaviorBlocked: false, typing: false, bodyReady: true, bodyTargetSupported: !!body && options.notReviewed !== true, bodyMotion: null,
    bodyConsumedIds: new Set(), bodyManualPose: false, bodyManualGesture: false, bodyDynamicPose: false, bodyWaitingForReply: false, bodyInputBlocked: false,
    bodyCameraEditing: false, chatGestureGeneration: 0, chatGestureBlocked: false, chatGestureIds: new Set(),
    tearsVerifiedGene: options.drowsy === true, tearLayer: null, tears: null, cryingTimeline: null, cryingFrame: null, drowsyPendingSettings: 0, drowsySuppressed: false,
    modelGeneration: 1,
    physicsSettings: normalizeModelPhysicsSettings(undefined), physicsSupport: null, physicsError: '',
    localPhysics: { restore() {}, frame() {}, setVisible() {}, getState: () => ({ support: null, running: false }), getDiagnostics: () => null },
    visualPreview: null, bodyPreview: null, bodyPersonalize: null, headFrameClaim: null, deferredAutoHead: [],
    // R29d: real constructor fields used by loadMotions and playChatGesture.
    motionClips: new Map(), defaultPoseChecks: new Map(), chatGestureClips: new Map(), motionGeneration: 0, qaStandCommit: null,
    chatGestureResource: null, chatGestureError: '', chatGestureBlockReason: null, motionRetarget,
  });
  // Real constructor field: the life layer writes only through the stage's own writers.
  stage.lifePort = { rotate: (b: Bone, x: number, y: number, z: number) => stage.rotateBone(b, x, y, z),
    head: (x: number, y: number, z: number) => stage.rotateAutomaticHead(x, y, z), morph: (index: number, weight: number) => stage.applyMorph(index, weight) };
  stage.setMood({ characterId: 'gene', token: 'gene_token', revision: 1, developerMode: false, expressions: true,
    parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), snapshot, gesture: null, ...(fatigue ? { fatigue } : {}) });
  let songFrame = 0, clipStart: number | null = null, clipIndex = 0, clipTail = 0;
  if (options.music) stage.setMusicEnabled(true);
  options.beforeLayers?.(stage);
  if (options.layers) await stage.loadMotions(options.layers, false);
  /** One display frame (or, with refreshHz, one display callback); music samples arrive at 30 Hz like the capture path. */
  const rate = options.refreshHz ?? fps, jitter = options.jitterMs ?? 0;
  let callback = 0;
  // R29f: a fixed pseudo-random sequence (no Math.random), so two runs of one scenario see the same vsync times.
  const wobble = () => { const x = Math.sin(++callback * 12.9898) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
  const tick = () => {
    now += 1000 / rate; t += 1 / rate;
    // M1: samples arrive while she hears music, whatever she decides to do about it (the dance, a nod or nothing).
    const listening = stage.musicEnabled || stage.musicHearing;
    if (options.samples) {
      // I-016: the clip's own sample times, from the moment the capture started; after its end, silence at 30 Hz.
      const clip = options.samples;
      if (listening) {
        clipStart ??= t;
        const elapsed = t - clipStart, base = clip[0]?.time ?? 0;
        while (clipIndex < clip.length && clip[clipIndex]!.time - base <= elapsed + 1e-9) { stage.setMusicSample({ ...clip[clipIndex]!, time: 1000 + clip[clipIndex]!.time - base }); clipIndex++; }
        if (clipIndex >= clip.length && elapsed - (clip.at(-1)!.time - base) >= (clipTail + 1) / 30) { clipTail++; stage.setMusicSample({ time: 1000 + clip.at(-1)!.time - base + clipTail / 30, rms: 0, low: 0, mid: 0, high: 0 }); }
      }
    } else if (listening && Math.floor(t * 30) > songFrame - 1) stage.setMusicSample(songSample(songFrame++));
    stage.tick(jitter ? now + wobble() * jitter : now);
    if (options.refreshHz) refreshes.push({ t, frame: shown.length - 1 });
  };
  const run = (seconds: number, each?: (time: number) => void) => {
    const frames = Math.round(seconds * rate);
    for (let i = 0; i < frames; i++) { each?.(t); tick(); }
  };
  stage.tick = (time: number) => frameTick.call(stage, time);
  const close = () => {
    loaderPrototype.loadVMD = loadVMD;
    stage.bodyMotion?.dispose(); animation.dispose(); gene.close();
    keys.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  };
  if (body) {
    // Plan read, resource, VMD bytes and the player's start are all real asynchronous steps.
    for (let i = 0; i < 200 && !stage.bodyMotion?.getState().active; i++) await new Promise(resolve => setTimeout(resolve, 2));
    if (!stage.bodyMotion?.getState().active) { close(); throw Error(`body motion did not start: ${JSON.stringify(stage.bodyMotion?.getState())}`); }
  }
  /** 她的动作: a host cue for `action`, played through the stage's own playHerAction (resolve, load, checks, start). */
  const prefix = `act${Math.random().toString(36).slice(2, 8)}`; let actionSerial = 0;
  const playAction = async (action: HerActionId): Promise<HerActionOutcome | undefined> => {
    const at = Date.now(), cueValue: HerActionCue = { id: `${prefix}${++actionSerial}`, action, at, expiresAt: at + HER_ACTION_CUE_MS };
    actionCues.set(cueValue.id, cueValue);
    await stage.playHerAction(cueValue);
    return actionReports.find(report => report.cueId === cueValue.id);
  };
  /** I-006: a live host cue that is not sent (electron/her-action-host.ts issue): it rides on a pose reaction instead. */
  const grantAction = (cueValue: HerActionCue) => { actionCues.set(cueValue.id, cueValue); };
  return { stage, mesh, shown, refreshes, run, tick, fps, rate, close, time: () => t, statuses, playAction, actionReports, grantAction };
}

export type GeneStage = Awaited<ReturnType<typeof geneStage>>;

/** A pat as PetInteraction reports it: valid scalp hits enter rua at once with hover 1, strokes left-right. */
export function patContact(time: number): MoodContact {
  const x = Math.sin(time * 6) * 0.45, vx = Math.cos(time * 6) * 2.7;
  return { ...EMPTY_CONTACT, contact: true, hover: 1, x, y: -0.25, velocityX: vx, velocityY: 0, speed: Math.abs(vx) };
}

/** Where the user's hand is while patting: the projected scalp, as the pointer gaze sees it. */
export function pointAtScalp(h: GeneStage): void {
  const region = h.stage.getInteractionRegion();
  if (region) h.stage.setPointer({ x: region.x / 200 - 1, y: 1 - region.y / 280 });
}

const DEG = 180 / Math.PI;
/** Per-frame displayed angular step (degrees) of each tracked bone. */
/** Which recorded rotations to measure: the tracked visible bones (default) or R29d's derived bones. */
export type BoneSet = 'world' | 'derived';
const boneCount = (set: BoneSet) => set === 'world' ? TRACKED_BONES.length : DERIVED_BONES.length;
export function steps(frames: readonly ShownFrame[], set: BoneSet = 'world'): number[][] {
  return Array.from({ length: boneCount(set) }, (_, bone) => frames.slice(1).map((frame, i) => frame[set][bone].angleTo(frames[i][set][bone]) * DEG));
}
/**
 * Unexpected motion per frame (degrees): how far this frame's world-space step
 * departs from simply repeating the previous step. Steady or smoothly changing
 * motion stays small; a teleport, a stop dead or a start at full speed is one
 * large value. (Index i belongs to frame i + 2.)
 */
export function surprises(frames: readonly ShownFrame[], set: BoneSet = 'world'): number[][] {
  const step = new Quaternion(), last = new Quaternion(), inverse = new Quaternion();
  return Array.from({ length: boneCount(set) }, (_, bone) => {
    const out: number[] = [];
    for (let i = 2; i < frames.length; i++) {
      step.copy(frames[i][set][bone]).multiply(inverse.copy(frames[i - 1][set][bone]).invert());
      last.copy(frames[i - 1][set][bone]).multiply(inverse.copy(frames[i - 2][set][bone]).invert());
      out.push(step.angleTo(last) * DEG);
    }
    return out;
  });
}
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : 0;
}
export const between = (frames: readonly ShownFrame[], from: number, to: number) => frames.filter(frame => frame.t >= from - 1e-9 && frame.t <= to + 1e-9);

export interface HandoffScript {
  /** Seconds of plain running before the event. */
  t0: number;
  /** Seconds the event lasts. */
  hold: number;
  /** Seconds observed after it ends. */
  after?: number;
  /** Runs once before the event (both runs), e.g. moving the pointer to the head. */
  prepare?(h: GeneStage): void | Promise<void>;
  /** May be asynchronous (R29d: a real loadMotions); no frame runs while it settles. */
  start(h: GeneStage): void | Promise<void>;
  during?(h: GeneStage, time: number): void;
  end(h: GeneStage): void | Promise<void>;
  /** Every frame after the event ended (event run only). */
  afterwards?(h: GeneStage, time: number): void;
}
export interface BoneHandoff {
  bone: string;
  /** Largest unexpected step at the start / end hand-off (0.6 s windows) vs the undisturbed run's own largest in the whole span. */
  startSurprise: number;
  endSurprise: number;
  sourceSurprise: number;
  /** Largest per-frame step at either hand-off vs the undisturbed run's p95 step. */
  handoffStep: number;
  sourceStep: number;
  /** Travel while the event holds (after its 0.6 s hand-off), event run vs undisturbed run, degrees. */
  heldTravel: number;
  sourceTravel: number;
  /** Mean distance (degrees) from the undisturbed run over the last 0.5 s: 0 when the motion resumed at the same phase. */
  rejoinGap: number;
}
/** R29c: one displayed morph (weight) around the hand-offs. */
export interface MorphHandoff {
  /** Shown right before the event. */
  before: number;
  /** Largest one-frame change in the start / end windows of the event run. */
  startStep: number;
  endStep: number;
  /** Largest one-frame change of the undisturbed run over the whole span. */
  sourceStep: number;
  /** Shown at the end of the start window (t0 + 0.6 s). */
  afterStart: number;
}

/** Two identical runs, one with the event, measured against each other. */
export async function measureHandoff(options: GeneStageOptions, script: HandoffScript) {
  const after = script.after ?? 1.5, runs: GeneStage[] = [];
  try {
    for (const withEvent of [false, true]) {
      const h = await geneStage(options);
      runs.push(h);
      h.run(script.t0 - 1);
      await script.prepare?.(h);
      h.run(1);
      if (withEvent) await script.start(h);
      h.run(script.hold, time => { if (withEvent) script.during?.(h, time); });
      if (withEvent) await script.end(h);
      h.run(after, time => { if (withEvent) script.afterwards?.(h, time); });
    }
    const [control, event] = runs, { t0, hold } = script, edge = 2 / control.fps;
    const span = between(control.shown, t0 - 1, t0 + hold + after);
    const startWindow = between(event.shown, t0 - edge, t0 + 0.6), endWindow = between(event.shown, t0 + hold - edge, t0 + hold + 0.8);
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    const tailFrom = t0 + hold + after - 0.5;
    const tailEvent = between(event.shown, tailFrom, Infinity), tailSource = between(control.shown, tailFrom, Infinity);
    const morphStep = (frames: readonly ShownFrame[], key: 'brow' | 'jitome' | 'mouth') =>
      Math.max(0, ...frames.slice(1).map((frame, i) => Math.abs(frame[key] - frames[i][key])));
    const shownBefore = event.shown.filter(frame => frame.t <= t0 + 1e-6).at(-1)!; // the last frame before the event
    const morph = (key: 'brow' | 'jitome' | 'mouth'): MorphHandoff => ({ before: shownBefore[key], startStep: morphStep(startWindow, key),
      endStep: morphStep(endWindow, key), sourceStep: morphStep(span, key), afterStart: startWindow.at(-1)![key] });
    const morphs = { brow: morph('brow'), jitome: morph('jitome'), mouth: morph('mouth') };
    const measure = (set: BoneSet, names: readonly string[]): BoneHandoff[] => {
      const sourceSurprises = surprises(span, set), sourceSteps = steps(span, set);
      const startS = surprises(startWindow, set), endS = surprises(endWindow, set), startSteps = steps(startWindow, set), endSteps = steps(endWindow, set);
      const heldEvent = steps(between(event.shown, t0 + 0.6, t0 + hold), set), heldSource = steps(between(control.shown, t0 + 0.6, t0 + hold), set);
      return names.map((bone, i) => ({
        bone, startSurprise: Math.max(...startS[i]), endSurprise: Math.max(...endS[i]), sourceSurprise: Math.max(...sourceSurprises[i]),
        handoffStep: Math.max(...startSteps[i], ...endSteps[i]), sourceStep: percentile(sourceSteps[i], 0.95),
        heldTravel: sum(heldEvent[i]), sourceTravel: sum(heldSource[i]),
        rejoinGap: sum(tailEvent.map((frame, k) => frame[set][i].angleTo(tailSource[k][set][i]) * DEG)) / Math.max(1, tailEvent.length),
      }));
    };
    // R29d: the derived bones (grant children, IK links) are measured the same way, separately.
    const bones = measure('world', TRACKED_BONES), derived = measure('derived', DERIVED_BONES);
    // R29d: what the display guard had to catch around the start hand-off (event run) and over the same span undisturbed.
    const caught = (frames: readonly ShownFrame[]) => ({ jumps: frames.length ? frames.at(-1)!.guardJumps - frames[0].guardJumps : 0,
      properties: [...new Set(frames.slice(1).filter((frame, i) => frame.guardJumps > frames[i].guardJumps).map(frame => frame.guardLast ?? ''))] });
    // From the last frame shown before the event: what the event itself left to catch.
    const caughtAtStart = caught(between(event.shown, t0, t0 + 0.6)), caughtUndisturbed = caught(span);
    return { bones, derived, morphs, statuses: event.statuses, caughtAtStart, caughtUndisturbed, guard: JSON.parse(event.stage.renderer.domElement.dataset.poseContinuity ?? 'null'), musicReason: event.stage.musicBlockReason as string | null };
  } finally { for (const run of runs) run.close(); }
}
