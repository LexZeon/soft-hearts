/**
 * I-154 / I-176: Unbound's engine drawing her in the companion window and in the control window's preview (docs/claude/2026-11-19-unbound-in-window.md,
 * docs/claude/2026-11-23-i176-delete.md). Since I-176 step 3 it is the only stage: the old one (src/stage/MmdStage.ts) and the developer switch that chose
 * between them are deleted; the wiring (src/wiring/stage-wiring.ts createStage) makes this in both windows.
 *
 * What is the same as the companion's own stage, on purpose:
 *  - the canvas (class mmd-canvas, transparent, pixel ratio ≤ 1.5), the lights, the camera from settings.camera and its framing
 *    (stage-framing.ts), so she stands where she stood. Unbound's body puts her soles on its floor (figure.floorUnits up); the
 *    camera is lifted by the same amount, so the picture does not move;
 *  - click-through: the same pixel probe (StagePixelProbe), read after each render, so pointer-passthrough.ts works unchanged;
 *  - her face anchor (the reply bubble, the game buttons) and the head region (pats) are measured the companion's way.
 * What is Unbound's: her body (figure.ts), its idle layer, its mouth and its personal-feel filter (window-body.ts). She never walks
 * here, and nothing reaches the host but host-ports.ts. Not here yet: not-yet.ts. This file only wires; which file holds what (each batch's
 * layers, the stage members in window-stage-games.ts and window-stage-motions.ts, model loading in window-model.ts) is in README.md here.
 */
import { Scene, SRGBColorSpace, WebGLRenderer, type Bone } from 'three';
import { fileOrderRenderer } from '../../foundation/draw-order';
import { addStageLights, clamp, isChatGestureTrack, loadLivelinessForEngine, loadMusicForEngine, PointerKeys, probeHeadContact,
  StageContextRecovery, StagePixelProbe, readStageFlags, stageDiagnosticsForced, type BlushAnchors, type PaceReason, type ShowCapabilities, type StageOptions, type StageSurface } from '../../stage';
import { standardHeadContact } from '../model/standard-contact';
import { standardFaceOf, standardSleepBones } from '../model/standard-face';
import { uiText } from '../../foundation/ui-language';
import { getMotionLayerAssets, type CollisionProxy } from '../../../shared/actions';
import { PRESENCE_FADE_IN_MS, PRESENCE_FADE_OUT_MS } from '../../../shared/stage';
import type { AppSettings, CameraConfig } from '../../../shared/foundation/settings';
import type { VmdDataTransform } from '../../foundation/vmd';
import { loadClip } from '../figure';
import { isRestPose } from '../rest-pose';
import { loadBundledIdle, type BundledIdle } from '../motion/bundled-idle';
import { WindowStageEnv } from './window-stage-env';
import { WindowReadouts, type ReadoutSources } from './window-readouts';
import { windowMotionClips } from './window-pose-layers';
import { WindowGames } from './window-games';
import { WindowMotions } from './window-motions';
import { WindowReactions } from './window-reactions';
import { WindowBody, unboundPageBeside } from './window-body';
import { WindowCameraEdit } from './window-camera';
import { WindowPull } from './window-pull';
import { WindowPhysics } from './window-physics';
import { WindowPace } from './window-pace';
import { WindowFace } from './window-face';
import { faceBlocks, motionBlocks, NO_FACE_BLOCKS, NO_MOTION_BLOCKS, showCapabilitiesOf, windowFaceRig, type MotionBlocks, type WindowFaceRig } from './window-face-rig';
import { pinchCheeks, WindowBlushState } from './window-blush';
import type { WindowStageHost } from './host-ports';
import { DEFAULT_CAMERA, WindowView, type HeadContact } from './window-view';
import { defaultPoseChecks, eyeBones, hasNeck, loadWindowModel } from './window-model';
import { WindowLiveliness } from './window-liveliness';
import { windowOwnLifeFor, type WindowOwnLife } from './window-own-life';
import { WindowStageTools } from './window-stage-tools';
import type { WindowPreviewGrants } from './preview-port';
import type { WindowPreviewStage } from './window-previews';
import { unboundGlOptions } from '../gl-options'; // 2026-11-24: the high-performance chip (docs/claude/2026-11-24-stage-smooth.md)

type S = StageSurface;
const PRESENCE_IN_MS = PRESENCE_FADE_IN_MS, PRESENCE_OUT_MS = PRESENCE_FADE_OUT_MS; // the old stage's numbers (shared/stage/presence-times.ts)

export class UnboundWindowStage extends WindowStageEnv implements StageSurface {
  readonly pixelProbe = new StagePixelProbe();
  protected readonly renderer: WebGLRenderer;
  protected readonly scene = new Scene();
  /** Batch 4: 猜拳, 递东西, 牵手 (window-games.ts); their stage members are window-stage-games.ts. */
  protected readonly games = new WindowGames(this.scene);
  /** Batch 5: her own motions (window-motions.ts), her reactions and the shows (window-reactions.ts); stage members: window-stage-motions.ts. */
  protected readonly motions: WindowMotions;
  protected readonly reactions = new WindowReactions();
  /** Batch 6: her own life, music and tears (window-own-life.ts); the music's stage members: window-stage-music.ts. */
  protected readonly ownLife: WindowOwnLife;
  /** What the picked motions hold for her own motions (window-face-rig.ts motionBlocks). */
  protected blocks: MotionBlocks = NO_MOTION_BLOCKS;
  protected lastLids = 0;
  /** The profile's collision proxy (the game's raised hand keeps clear of her body by it). */
  protected proxy: CollisionProxy | null = null;
  /** The companion's camera and framing, lifted with her, and the screen projections (window-view.ts). */
  protected readonly view: WindowView;
  private get camera() { return this.view.camera; }
  private readonly resizeObserver: ResizeObserver;
  private readonly pointerKeys = new PointerKeys();
  protected readonly cameraEdit: WindowCameraEdit;
  private readonly idle: Promise<BundledIdle | null>;
  protected settings: AppSettings | null = null;
  protected body: WindowBody | null = null;
  protected head: Bone | null = null;
  private eyes: Bone[] = [];
  private contact: HeadContact | null = null;
  /** The bone the head contact was measured against (the figure's head; for a VRM, the model's own head). */
  private contactHead: Bone | null = null;
  /** Batch 3 (row 22): the profile's estimate of her cheeks, for the pinch where the blush probe found none. */
  private cheekFallback: BlushAnchors | null = null;
  protected modelUrl = '';
  private motionKey = '';
  protected modelGeneration = 0;
  private settingsGeneration = 0;
  protected pendingModel: Promise<void> = Promise.resolve();
  private styleValue: number;
  protected disposed = false;
  private frameId = 0;
  /** Batch 2: her face (window-face.ts), the painted blush on this model, and what the blush is bound to now. */
  protected readonly face = new WindowFace();
  protected faceRig: WindowFaceRig | null = null;
  protected readonly blush = new WindowBlushState();
  protected readonly physics = new WindowPhysics();
  protected readonly pace = new WindowPace();
  protected readonly pull = new WindowPull({
    figure: () => this.body?.figure ?? null,
    view: () => ({ camera: this.camera, width: this.container.clientWidth, height: this.container.clientHeight }),
    shown: () => !this.disposed && this.hostVisible && !document.hidden,
    mood: () => this.moodView,
    handBusy: () => this.games.hands.active,
  });
  protected presence = 0;
  private presenceTarget = 0;
  private presenceRate = 1 / PRESENCE_IN_MS;
  protected firstShown = false;
  /** Batch 3: procedural life, the sleep pose and body, who she looks at with pose sensing; one frame composed (window-liveliness.ts). */
  protected readonly lively: WindowLiveliness;
  /** Batch 7: 试一下, the control window's preview mode (with `grants` only) and the diagnostics (window-stage-tools.ts); members: window-stage-previews.ts. */
  protected readonly tools: WindowStageTools;
  protected loaded: ReturnType<WindowPreviewStage['model']> = null;
  /** I-176: the canvas readouts the pretrial and the smokes poll (window-readouts.ts). */
  private readonly readouts: WindowReadouts;

  constructor(private readonly container: HTMLElement, protected readonly options: StageOptions, private readonly host: WindowStageHost,
    style = 0, private readonly random: () => number = Math.random, grants: WindowPreviewGrants | null = null) {
    super();
    this.motions = new WindowMotions(host, () => this.motionEnv());
    this.motions.mouth.talkingFace = (name, holdS) => this.showExpression(name, { holdS, onset: 'quick' }).ok; // I-175: a pout while she speaks
    this.ownLife = windowOwnLifeFor(options, this.face, () => this.motions.gatesChanged(true, false)); // batch 6; the dance starts: an automatic body motion hands back
    this.face.onBlushCue = state => this.options.onBlushCue?.(state); // 体验记录 'blush-stage': the old stage's wiring (stage-wiring.ts onBlushCue)
    this.styleValue = style;
    this.renderer = fileOrderRenderer(new WebGLRenderer(unboundGlOptions(true)));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    const canvas = this.renderer.domElement;
    canvas.className = 'mmd-canvas';
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;opacity:0;';
    canvas.dataset.windowEngine = 'unbound'; // the isolated screenshot check reads which engine drew her
    // A lost WebGL context comes back by itself (src/stage/context-recovery.ts); the message only when it stays lost.
    this.contextRecovery = new StageContextRecovery(canvas, { restored: () => { this.pixelProbe.forgetContext(); this.tools?.contextBack(); },
      stuck: () => this.options.onError?.(uiText('显卡上下文已丢失，请重新打开窗口恢复模型。')), recovered: () => this.options.onStatus?.(uiText('模型已就绪')) });
    container.append(canvas);
    addStageLights(this.scene);
    this.idle = (() => { const page = unboundPageBeside(location.href); return page ? loadBundledIdle(page) : Promise.resolve(null); })();
    this.lively = new WindowLiveliness(event => { try { this.options.onGazeAttention?.(event as never); } catch { /* a record only */ } }, random);
    void loadLivelinessForEngine().then(lib => { if (!this.disposed) { this.lively.life.load(lib); this.lively.sleep.load(lib); this.ownLife.herLife.load(lib); } }, () => { /* she stays without them */ });
    void loadMusicForEngine().then(lib => { if (!this.disposed) this.ownLife.music.load(lib); }, () => { /* no music then */ });
    this.view = new WindowView(container, options, { cameraSet: camera => this.cameraEdit?.setCamera(camera) });
    this.cameraEdit = new WindowCameraEdit(canvas, DEFAULT_CAMERA, { apply: camera => this.view.setCamera(camera), changed: camera => this.options.onCameraChange?.(camera),
      mode: enabled => this.options.onCameraEditChange?.(enabled), reset: () => { this.frame('full'); }, canEdit: () => !this.disposed && this.hostVisible && !document.hidden });
    this.view.setCamera(DEFAULT_CAMERA);
    // Batch 7: the control window's preview gets the grants (preview-port.ts); the companion window none (its authoring previews answer false).
    this.tools = new WindowStageTools(this.scene, grants, this.previewStage(), options.onMotionGlitch, () => this.moodView?.developerMode === true);
    this.physics.previewOnly = !!grants; // the old stage's previewOnly: no physics runs in the preview
    this.readouts = new WindowReadouts(canvas, () => this.diagnosticsOn(), this.readoutSources());
    const visual = this.tools.preview?.visual;
    if (visual) this.motions.setPreview({ plan: () => visual.plan(), resolveFor: (id, token) => visual.resolveFor(id, token), failed: () => visual.failed(),
      protectedMorphs: () => [this.faceRig?.slots.blink ?? -1, this.faceRig?.slots.a ?? -1, this.face.blushMorph()].filter(index => index >= 0) });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    this.frameId = requestAnimationFrame(this.tick);
  }

  protected gameView() { return { camera: this.camera, width: this.container.clientWidth, height: this.container.clientHeight, shown: !this.disposed && this.hostVisible && !document.hidden }; }
  protected pictureParts() {
    return this.body ? { renderer: this.renderer, scene: this.scene, camera: this.camera, head: this.head, height: this.view.bounds.height, centerX: this.view.bounds.centerX } : null;
  }
  // Batch 5 (window-stage-motions.ts): what her motions, reactions and shows read of the stage.
  protected motionOwner(): object | null { return this.body?.figure.mesh ?? null; }
  protected lifeOn(): boolean { return this.lively.life.on; }
  protected musicView() { return this.moodView; }
  protected wakePace(reason: PaceReason): void { this.pace.wake(reason); }
  protected showCapabilities(): ShowCapabilities | null {
    return this.body && !this.disposed ? showCapabilitiesOf(this.faceRig, { head: !!this.head, upperBody: this.body.paceBones[1] !== null, eyes: this.eyes.length > 0,
      blush: !!this.blush.painter || this.face.blushMorph() >= 0 }) : null;
  }
  /** Batch 7: the preview pauses while its window is hidden (the model let go; loaded again when shown), as the old stage's control window. */
  private syncPreviewPause(shown: boolean): void {
    const mode = this.tools.preview;
    if (!mode || this.disposed || shown === !mode.suspended) return;
    mode.suspended = !shown;
    if (shown) { if (this.settings) void this.applySettings(this.settings); return; }
    this.settingsGeneration++; this.modelGeneration++; this.clearModel(); this.modelUrl = this.motionKey = ''; this.pendingModel = Promise.resolve();
    this.renderer.clear(); this.options.onStatus?.(uiText('预览已暂停 · 重开窗口自动恢复'));
  }
  protected visibilityChanged(visible: boolean): void { if (!visible) this.tools.modelGone(); this.syncPreviewPause(visible && !document.hidden); }
  /** The personal-feel strength (the developer switch's slider), applied in place. */
  setStyle(value: number): void { this.styleValue = Number.isFinite(value) ? clamp(value, 0, 1) : 0; this.body?.setStyle(this.styleValue); }

  // ---- settings, model and motions --------------------------------------------------------------------------------------------
  async applySettings(settings: AppSettings): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.settingsGeneration;
    this.settings = settings;
    if (this.tools.preview && (!this.hostVisible || document.hidden)) { this.syncPreviewPause(false); return; } // batch 7: paused while hidden
    this.body?.figure.setBreath(settings.pet.breath ?? 0.5);
    const url = settings.model?.url ?? '';
    if (this.view.differs(settings.camera) && !this.cameraEdit.interacting) { this.view.setCamera(settings.camera); if (url === this.modelUrl) this.frameIfUnframed(); }
    if (url !== this.modelUrl) { this.modelUrl = url; this.motionKey = ''; this.pendingModel = this.loadModel(url); }
    await this.pendingModel;
    if (this.disposed || generation !== this.settingsGeneration || url !== this.modelUrl) return;
    const picked = getMotionLayerAssets(settings), pickedLegacy = !settings.motionLayers;
    const motion = JSON.stringify([pickedLegacy, picked.pose?.url, picked.gesture?.url, picked.expression?.url]);
    const body = this.body;
    if (body && motion !== this.motionKey) {
      this.motionKey = motion;
      try {
        // No pose picked: her default stand, as in full-screen (window-pose-layers.ts; docs/claude/2026-11-21-window-idle-pose.md).
        const { clips, legacy, rest, pose } = await windowMotionClips(settings, this.host, url => loadClip(url, body.figure.mesh, this.transform));
        // Batch 5: the reviewed bundled stand is not "a picked pose" for her own motions; one rule with full-screen (I-174: ../rest-pose.ts).
        const reviewedDefault = await isRestPose({ picked: rest ? null : pose?.url ?? null, injected: rest }, this.defaultPose);
        if (this.body === body && this.motionKey === motion) {
          // Not on screen yet (before she fades in): her first motions are simply there, as full-screen's before her first frame.
          body.figure.setClips(clips, legacy, { unseen: this.presence === 0 && this.presenceTarget === 0 });
          // A picked expression motion owns her face, a picked head motion her head: the mood's steps aside (the companion's rules).
          const face = faceBlocks(clips, legacy, body.figure.mesh, this.faceRig?.slots.a ?? -1, this.head?.name ?? null);
          this.face.setBlocks(face);
          this.blocks = motionBlocks(clips, reviewedDefault, face, isChatGestureTrack);
          this.motions.gatesChanged(true, this.blocks.chatGesture); // a motion change: an automatic one hands back, as on the old stage
        }
      } catch (error) { this.options.onError?.(uiText('动作载入失败：{0}', error instanceof Error ? error.message : String(error))); }
    }
    if (this.body === body) { this.reveal(); this.frameIfUnframed(); }
  }

  private readonly defaultPose = defaultPoseChecks();
  private transform?: VmdDataTransform;

  private async loadModel(url: string): Promise<void> {
    const generation = ++this.modelGeneration;
    if (this.body) { this.presenceTarget = 0; this.presenceRate = 1 / PRESENCE_OUT_MS; await new Promise(resolve => setTimeout(resolve, PRESENCE_OUT_MS + 30)); }
    if (this.disposed || generation !== this.modelGeneration) return;
    this.clearModel();
    if (!url) { this.options.onStatus?.(uiText('请选择 PMX / PMD / VRM 模型')); return; }
    this.options.onStatus?.(uiText('正在加载模型与纹理…'));
    try {
      // Loaded, measured at rest and made into her figure and body (window-model.ts loadWindowModel); null: dropped as stale.
      const current = () => !this.disposed && generation === this.modelGeneration;
      const grants = this.tools.preview?.grants; // batch 7: the control window's preview runs the fit check with the host's stored scores
      const fits = grants ? { save: grants.saveMotionFits, changed: (view: Parameters<NonNullable<StageOptions['onMotionFit']>>[0]) => { if (current()) this.options.onMotionFit?.(view); },
        cache: () => grants.getModelProfile().then(v => v && typeof v.modelKey === 'string' && v.modelUrl === url ? { modelKey: v.modelKey, motionFits: v.motionFits ?? null } : null) } : null;
      const model = await loadWindowModel(url, { host: this.host, current, idle: this.idle, random: this.random, breath: this.settings?.pet.breath ?? 0.5, fits });
      if (!model) return;
      const { mesh, textures, standard, reviewed, bounds, transform, retarget, profile, painter, figure, body, rest } = model;
      this.loaded = { generation, url, mesh, reviewed, retarget, rest }; // batch 7: what the control window's previews read
      this.view.bounds = bounds; this.transform = transform; this.cheekFallback = profile?.cheekAnchors ?? null; this.proxy = profile?.profile?.collision ?? null;
      body.setStyle(this.styleValue);
      body.setSpeaking(this.speakingSources.size > 0);
      this.body = body;
      // Her face on this model: its slots (the profile's, or a VRM's standard face), the card from the host comes again for it.
      this.face.setCard(null); this.face.setBlocks(NO_FACE_BLOCKS);
      this.faceRig = windowFaceRig(figure.mesh, profile, reviewed && !standard, figure.head, standard); // I-164: a VRM's own card
      this.face.attach(this.faceRig);
      this.blush.attach(painter);
      this.refreshBlush();
      this.pull.forget();
      void this.physics.attach(figure, standard?.springs ?? null); // the saved switches and the lab's values, on this figure (window-physics.ts; a VRM's own springs)
      this.view.lift = figure.floorUnits;
      this.head = figure.head;
      this.eyes = eyeBones(mesh);
      this.lively.sleep.attach({ mesh: figure.mesh, profile: profile ?? (standard ? standardSleepBones(standard) : null), baseY: bounds.baseY, hasNeck: hasNeck(figure.mesh, figure.head) }); // row 35 on this model (I-164: a VRM on its standard skeleton)
      this.motions.attach({ figure, mesh: figure.mesh, reviewed, retarget, transform, profile, standard: !!standard, standardFace: standard ? standardFaceOf(standard) : null }); // batch 5: her own motions (I-164: a VRM's face shapes)
      this.reactions.reset();
      this.ownLife.attachModel(figure, this.motions.clips, this.host, () => this.moodView?.token ?? null, transform, retarget); // batch 6: held pose, dance
      if (standard) {
        body.settle(); // her arms come down on the first frame: the framing and the scalp are measured standing
        this.view.bounds = standard.measureShown();
        ({ contact: this.contact, head: this.contactHead } = standardHeadContact(standard, this.view.bounds.height));
      } else {
        this.contactHead = this.head;
        this.contact = this.head ? probeHeadContact(mesh, this.head, this.eyes, this.view.bounds.height) : null;
      }
      this.scene.add(mesh);
      this.tools.preview?.placeGrid(this.view.bounds.baseY + this.view.lift);
      if (retarget) this.tools.preview?.scanFits(retarget, () => current() && this.loaded?.retarget === retarget);
      this.view.applyCamera();
      await Promise.race([textures, new Promise(resolve => setTimeout(resolve, 8_000))]);
      if (!current()) return;
      body.settle();
      this.renderer.render(this.scene, this.camera); // shaders compiled before she fades in
      this.options.onStatus?.(uiText('模型已就绪'));
      // Revealed once her motions are in (applySettings); this covers a settings pass that never gets there.
      setTimeout(() => { if (current()) this.reveal(); }, 3_000);
    } catch (error) {
      if (generation === this.modelGeneration) this.options.onError?.(uiText('模型载入失败：{0}', error instanceof Error ? error.message : String(error)));
    }
  }

  private clearModel(): void {
    void this.physics.attach(null); this.pull.forget(); this.motions.attach(null); this.ownLife.attach(null); this.reactions.reset(); this.blocks = NO_MOTION_BLOCKS;
    this.blush.clear(); this.faceRig = null; this.face.attach(null); this.cheekFallback = null; this.proxy = null; this.lively.sleep.attach(null); this.lively.gaze.forget();
    this.body?.dispose(); this.body = null; this.mouthLog.reset();
    this.head = null; this.eyes = []; this.contact = null; this.contactHead = null; this.view.lift = 0;
    this.presence = 0; this.presenceTarget = 0; this.renderer.domElement.style.opacity = '0';
    this.options.onFaceAnchor?.({ x: 0, y: 0, visible: false });
    this.loaded = null; this.tools.modelGone(); this.options.onMotionFit?.(null); // batch 7: 试一下 and previews end; the card's model is gone (as the old stage)
  }
  private reveal(): void { if (this.body) { this.presenceTarget = 1; this.presenceRate = 1 / PRESENCE_IN_MS; } }

  /** 拖动调镜头 (I-154): the companion's own camera controls on this canvas. */
  setCameraEditMode(enabled: boolean): void { this.cameraEdit.set(enabled); }
  // ---- camera and framing (the companion's own) -------------------------------------------------------------------------------------
  frame(preset: 'full' | 'portrait'): CameraConfig | null {
    if (!this.body || this.disposed) return null;
    return this.view.frame(preset, this.settings?.camera.fov ?? 32);
  }
  private frameIfUnframed(): void {
    if (this.body && !this.disposed && this.view.unframed()) this.frame('full');
  }
  getFramingView(): ReturnType<S['getFramingView']> {
    return this.view.framingView({ modelGeneration: this.modelGeneration, modelUrl: this.settings?.model?.url ?? '', ready: !this.disposed && !!this.body });
  }
  private resize(): void {
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight);
    this.view.resize(width, height);
    this.renderer.setSize(width, height, false);
    if (!this.disposed && this.visible) this.render(); // resizing clears the buffer: present the same picture now
  }

  // ---- what the wiring tells her: window-stage-inputs.ts (the pointer, speaking, a touch, shown, mood, the pull members) ------
  // Her face's members (speaking, thinking, the card, the blush, the 「边说边演」 entries) are in window-stage-face.ts.
  protected faceShown(): boolean { return !this.disposed && this.hostVisible && !document.hidden; }
  protected armsHeldNow(): boolean { return this.games.armsHeld(this.pull.engaged); }
  getInteractionRegion(): ReturnType<S['getInteractionRegion']> {
    if (!this.head || !this.body || !this.contact || !this.hostVisible) return null;
    // Batch 3 (row 22 捏脸): the cheeks too, the companion's rule (window-blush.ts pinchCheeks).
    const cheeks = pinchCheeks(this.blush.painter?.cheeks ?? null, this.cheekFallback, this.faceRig?.reviewed === true, this.blush.calibrationFor(this.modelUrl));
    const region = this.view.interactionRegion({ head: this.head, contact: this.contact, contactHead: this.contactHead, cheeks });
    if (!region) return null;
    this.renderer.domElement.dataset.interactionRegion = JSON.stringify(region);
    return region;
  }

  // ---- every frame ------------------------------------------------------------------------------------------------------------
  protected get visible(): boolean { return this.hostVisible && !document.hidden && this.container.clientWidth > 0 && this.container.clientHeight > 0; }
  private readonly tick = (now: number): void => {
    if (this.disposed) return;
    this.frameId = requestAnimationFrame(this.tick);
    // The old stage's frame clock and pace (window-pace.ts): the fps setting is the ceiling; away or asleep and still, fewer frames.
    const frame = this.pace.accept(now, this.settings?.pet.fps, { hostVisible: this.hostVisible, documentHidden: document.hidden,
      width: this.container.clientWidth, height: this.container.clientHeight }, this.moodView?.fatigue?.phase === 'asleep');
    this.readouts.decided(frame, now);
    if (!frame.render) { if (frame.reason !== 'throttled') { this.pixelProbe.cancel(); this.physics.setShown(false); this.motions.notShown(); this.ownLife.notShown(this.blush.painter); this.tools.notShown(); } return; }
    this.physics.setShown(true);
    const { delta, physicsDelta } = frame;
    this.speechOwner.frame(delta, this.speakingSources.size > 0); // I-174 item 8: the held value her motion gates read this frame
    this.stepPresence(physicsDelta * 1000);
    this.cameraEdit.update(delta);
    const body = this.body;
    // Batch 4: the game, an offer, her reach for your mouse (window-games.ts): their clocks, then their arms as the reach's targets.
    // Batch 6 (window-own-life.ts): the music and her own life's activity, the base the games' faces lay over.
    const env = this.motionEnv(), own = this.ownLife.frame(delta, { owner: body?.figure.mesh ?? null, env, lifeGates: this.motions.lifeGates(env),
      reactionHoldsBody: this.reactions.holdsBody, armsHeld: this.games.armsHeld(false), nowMs: Date.now() });
    const games = this.games.frame(delta, { mesh: body?.figure.mesh ?? null, pointer: this.pointer, follow: this.settings?.pet.followMouse ?? true, camera: this.camera, proxy: this.proxy,
      base: own.activity });
    const cap = this.tools.beforeBody(delta, body?.figure.mesh ?? null, env, this.motions.bodyGates(env)); // batch 7: 试一下, the previews' gates and weights
    this.motions.frame(); // batch 5: the gates of her own motions for this frame (they play inside her body's frame), a face shape's writes off
    if (body) {
      const pointer = this.pointerKeys.frame(delta, this.pointer.x, this.pointer.y), ownLife = this.ownLifeFrame(delta, body); // I-174 item 1

      // Her face, procedural life, sleep and who she looks at, composed and handed to her body (window-liveliness.ts).
      const face = this.lively.frame(delta, body, this.face, { view: this.moodView, rig: this.faceRig, pointer, eyes: this.view.eyesOnWindow(this.eyes, this.head),
        env: { shown: true, adjusting: this.cameraEdit.interacting || this.pull.engaged, voiced: body.mouth?.voiced === true,
          speaking: this.speakingSources.size > 0, armsHeld: this.games.armsHeld(this.pull.engaged), capability: cap },
        follow: this.settings?.pet.followMouse ?? true, pat: this.pat, breath: this.settings?.pet.breath ?? 0.5, pulled: this.pull.engaged, // no-pet-ok: settings.pet is the stored settings key
        handHeld: this.games.busy, games, adjusting: this.cameraEdit.interacting, thinking: this.face.thinkingActive, typing: this.typing,
        camera: this.camera, lift: this.view.lift, width: this.container.clientWidth, height: this.container.clientHeight, scene: this.scene,
        reactions: this.reactionFrame(delta, body), music: own.music, ownLife }, physicsDelta);
      this.lastLids = face.lids;
      this.mouthLog.frame(delta, body.mouth?.voiced === true, body.mouth?.lastReading, this.face.mouthWord); // 2026-11-22 嘴型记录
      this.ownLife.tears(delta, this.blush.painter, { view: this.moodView, adjusting: this.behaviorBlocked || this.cameraEdit.interacting, faceBlocked: this.face.owners().face, nowMs: Date.now(), preview: cap }); // row 25 (batch 7: 试一下 能流泪)
      this.motions.afterBody(delta); // a face shape (她的动作) over every other face writer
      for (const murmur of this.lively.takeMurmurs()) { try { this.options.onSleepMurmur?.(murmur); } catch { /* the bubble's own */ } } // 梦话
      this.blush.painter?.update(face.blushPath === 'painted' ? face.blush : 0, face.blushSize);
      if (this.blush.previewing && !this.face.previewing) { this.blush.previewing = false; this.refreshBlush(true); }
      this.view.reportFaceAnchor(now, this.head);
      this.games.after(this.camera); // the offer's prop in her hand, the click target on her hand
    }
    this.render();
    const physicsBones = body ? this.physicsBones(body) : [], clips = this.motions.clips;
    this.tools.afterRender({ mesh: body?.figure.mesh ?? null, camera: this.camera, height: this.view.bounds.height, gl: this.renderer.getContext() as WebGL2RenderingContext,
      canvas: this.renderer.domElement, physicsBones: this.physics.outputBones(), fps: delta > 0 ? Math.round(1 / delta) : null, frameMs: physicsDelta * 1000,
      props: () => this.lively.sleep.propCorners(), env, playing: { chat: clips?.chat.getState().active === true, action: clips?.action.active === true,
        body: (clips?.bodyTracks().length ?? 0) > 0, herLife: !!this.moodView?.herLife?.activity && this.moodView.herLife.activity !== 'company', transition: false } }); // row 45
    this.physics.publish(this.options.onPhysicsState, this.disposed); // the control window's physics form (support, switches, status)
    this.readouts.drawn();
    this.pace.drawn(now, physicsDelta, { touch: this.pat || this.pull.engaged, camera: this.cameraEdit.interacting, speaking: this.speakingSources.size > 0,
      fading: this.presence !== this.presenceTarget, stepping: body?.figure.moving === true || this.lively.moving || this.games.busy || this.motions.moving
        || this.reactions.active || this.reactions.showing || this.ownLife.moving || this.tools.busy || this.arbiter.active, body: body?.paceBones ?? [],
      physics: physicsBones });
  };
  /** The canvas readouts are written for developer mode, the URL's diagnostics flag (the smokes and the pretrial) or a test that asks, as the old stage's were. */
  private diagnosticsOn(): boolean { return stageDiagnosticsForced() || this.moodView?.developerMode === true || (this.flags ??= readStageFlags(typeof location === 'undefined' ? '' : location.search)).diagnostics; }
  private flags: ReturnType<typeof readStageFlags> | null = null;
  /** What the readouts read of the stage's parts (window-readouts.ts), each only in developer mode. */
  private readoutSources(): ReadoutSources {
    return { presence: () => this.presence, guard: () => this.tools.guard, mood: () => this.face.moodReadout, pinch: () => this.face.pinchReadout, clips: () => this.motions.readouts(),
      clock: () => ({ speaking: this.speakingSources.size > 0, waitingForReply: this.face.thinkingActive, inputBlocked: this.inputBlocked, pace: this.pace.getState() }),
      blink: () => { const slot = this.faceRig?.slots.blink, mesh = this.body?.figure.mesh; return slot !== undefined && mesh ? mesh.morphTargetInfluences?.[slot] ?? 0 : 0; },
      closure: () => { const rig = this.faceRig, influences = this.body?.figure.mesh.morphTargetInfluences; return rig && influences ? Math.min(1, (['blink', 'smileEyes', 'jitome'] as const).reduce((sum, slot) => sum + (rig.slots[slot] !== undefined ? influences[rig.slots[slot]!] ?? 0 : 0), 0)) : 0; },
      physics: () => this.physics.readout(this.camera, { width: this.container.clientWidth, height: this.container.clientHeight }),
      crying: () => ({ frame: this.ownLife.crying.latest as Record<string, unknown> | null, support: this.blush.painter?.tearsReason ?? '', surface: this.blush.painter?.tearsSurface ?? null }),
      poseTime: () => performance.now() / 1000, proceduralLife: () => this.lively.life.diagnostics(performance.now()), herLife: () => this.ownLife.herLife.diagnostics(performance.now()),
      rps: () => this.games.rpsState() };
  }
  /** I-174 item 1: what the window knows for her own small things, and the player's goals this frame (window-arbiter.ts). */
  private ownLifeFrame(delta: number, body: WindowBody) {
    this.arbiter.situation({ shown: this.visible && this.presence > 0, typing: this.typing, waiting: this.face.thinkingActive, speaking: this.speakingSources.size > 0,
      playing: this.games.busy, view: this.moodView });
    this.arbiter.start();
    return this.arbiter.frame(delta, { sense: null, heightM: body.figure.heightM }, this.lively.lastSleep?.performing === true || this.pull.engaged || this.cameraEdit.interacting);
  }
  /** The bones physics moves now, for the pace (cached until the switches or the model change). */
  private physicsBones(body: WindowBody): readonly Bone[] {
    const from = this.physics.outputBones();
    if (!from) return this.physics.springBones() ?? []; // a VRM: its spring bones (I-152 step 3)
    if (this.paceBonesOf?.from !== from || this.paceBonesOf.body !== body) this.paceBonesOf = { from, body, bones: from.map(index => body.figure.mesh.skeleton.bones[index]).filter(Boolean) };
    return this.paceBonesOf.bones;
  }
  private paceBonesOf: { from: readonly number[]; body: WindowBody; bones: Bone[] } | null = null;
  private render(): void {
    this.renderer.render(this.scene, this.camera);
    if (!this.pixelProbe.idle) this.pixelProbe.afterRender(this.renderer.getContext() as WebGL2RenderingContext, this.renderer.domElement);
  }
  private stepPresence(ms: number): void {
    if (this.presence === this.presenceTarget) return;
    const step = ms * this.presenceRate;
    this.presence = this.presenceTarget > this.presence ? Math.min(this.presenceTarget, this.presence + step) : Math.max(this.presenceTarget, this.presence - step);
    this.renderer.domElement.style.opacity = this.presence >= 1 ? '1' : this.presence.toFixed(4);
    if (this.presence >= 1 && !this.firstShown) { this.firstShown = true; try { this.options.onFirstShown?.(); } catch { /* a record only */ } }
  }
  private readonly onVisibility = () => { if (document.hidden) { this.physics.setShown(false); this.pixelProbe.cancel(); this.tools.modelGone(); } this.syncPreviewPause(this.hostVisible && !document.hidden); };
  private readonly contextRecovery: StageContextRecovery;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cameraEdit.dispose();
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.contextRecovery.dispose();
    this.clearModel();
    this.motions.dispose();
    this.arbiter.halt();
    this.ownLife.music.dispose();
    this.games.dispose();
    this.pixelProbe.dispose();
    this.tools.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
