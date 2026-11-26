/**
 * Unbound U1: the Unbound window's page (docs/claude/2026-11-12-unbound-u1-part1.md).
 *
 * Her world drawn through the screen-camera, her body (figure.ts) with the companion's idle motion and breath, the cursor test that
 * switches click-through only over her, a reply bubble, and the developer overlay. It talks to the host only through
 * window.unbound (electron/unbound/preload-api.ts).
 */
import { SRGBColorSpace, Scene, WebGLRenderer } from 'three';
import { fileOrderRenderer } from '../foundation/draw-order';
import type { UnboundApi } from '../../electron/unbound/preload-api';
import { InteractiveToggle } from '../../shared/unbound/hit-test';
import { FigureCatch } from './catch-region';
import { StagePixelProbe } from '../stage';
import { summarize, type UnboundScene } from '../../shared/unbound/scene';
import { addStageLights } from '../stage/model-loading';
import { configureFigurePhysics, physicsSettingsFor, syncFigurePhysics } from './figure-physics'; // her hair and chest physics
import type { VmdDataTransform } from '../foundation/vmd';
import { pixelsPerUnit, placeholderWorld, WorldCamera } from './camera';
import { FloorFraming } from './floor-framing'; // the floor follows her (2026-11-21)
import { UNITS_PER_M, UnboundFigure, loadModel } from './figure';
import { applyBody, clipsFor, keyOfFigure, keyOfMotion } from './figure-scene';
import { DebugOverlay } from './overlay';
import { ReplyBubble, SaidLine, SensesLight } from './bubbles'; // Unbound v1 step 2: the reply bubble, the user's line, the senses light
import { UnboundMouth } from './mouth';
import { MouthJournal } from './mouth-journal';
import { sanitizeFillerShape } from '../../shared/voice'; // 2026-11-20: her short sounds in a call
import { dropFigureBody, loadFigureBody } from './model/figure-body';
import type { StandardBody } from './model/standard-body';
import { ShownReporter } from './shown-reporter'; // read-aloud: tells the host which reply text the bubble has painted
import { ClickReporter } from './click-reporter';
import { UnboundPull } from './pull-input'; // step 5: pulling her
import { createPullDot } from './pull-dot';
import { routePointer } from './pointer-router';
import { STICK_KNOBS } from '../../shared/unbound/pull-stick';
import { NearReturn, nearBodyOf, nearStations } from './pull-near'; // I-159 E: pulled near, the face and eyes stations
import { parsePullAnswer } from '../../shared/unbound/pull';
import { followClamps, startPlacement } from './her-spot'; // I-212: screen terms
import { LoadReporter } from './load-progress'; // the entry waits while her first load moves forward (shared/unbound/entry-wait.ts)
import { BodyMeter } from './body-meter';
import { BodyHit } from './body-hit'; // her silhouette: hit test, click part, nearest point (I-164: a VRM's from its own meshes)
import { NEAR_DEFAULT_M, lensSoftnessPx, nearPlaneFor } from './camera';
import { Director, type DirectorWorld } from './director/director';
import { PEEK_LENS } from './director/peek-lens';
import { closeMomentAction } from './director/close-moment';
import { SpeechBeat, SpeechBubbleGate } from './director/speech-beat';
import { actionNow, endForPull, type ActionOwners } from './action-now'; // 2026-11-23: the one interruption arbiter, the page's side
import { ProceduralGenerator } from './motion/procedural';
import { axisOffset, lensView } from './motion/lens-align';
import { parsePeekSideCommand, type PeekCommand } from '../../shared/unbound/director';
import { parseDirectorPlan } from '../../shared/unbound/close-moments';
import { ActPlayer, type ActEnd } from './director/acts';
import { unboundSpeechBeats } from './speech-beat-player'; // 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md)
import { PerfManager } from './perf';
import { gpuOfContext, unboundGlOptions } from './gl-options';
import { keepLast, startStatsReport } from './stats-report';
import { bubbleLink } from './bubble-link';
import { HeadLocator } from './head-spot'; // where her head is on the window (split out 2026-11-18)
import { overlayText } from './debug-lines';
import { PeekMetrics } from './peek-metrics';
import { createProbe } from './probe'; // window.__unboundProbe
import { UnboundIdleLayer, idleWanted } from './motion/unbound-idle'; // the StayStill idle under everything else
import { createBundledIdle, loadBundledIdle } from './motion/bundled-idle';
import { perfKey, type PerfTier } from '../../shared/unbound/perf-tiers';
import { LifePlayer } from './life/player'; // step 4: her own life (docs/claude/2026-11-17-unbound-step4.md)
import { LIFE_ACTION_IDS } from '../../shared/unbound/life/registry';
import { HerOut, herGazeDebug, herTouchable, measureWindowModel } from './her'; // I-154 follow-up: her face, touch-head by mood, pinch, the snack mouth from the shared set
import { StagePage } from './company/stage-page'; // I-209
import type { OwnInvolvement } from '../../shared/unbound/company/extra-pace';
import './her/games.css'; // batch B: the companion window's game overlays on this page (their own style sheets)

declare global { interface Window { unbound?: UnboundApi; __unboundProbe?: unknown } }

const PRESENCE_IN_MS = 450;
const PRESENCE_OUT_MS = 300;

const api = window.unbound;
const root = document.getElementById('unbound')!;
// Quality tier (docs/claude/2026-11-23-unbound-quality-tier.md); busy: no self-test then; ?perf=, ?perfquiet=0 are for the measuring script.
const pageParams = new URLSearchParams(location.search);
const perfPin = pageParams.get('perf');
const perf = new PerfManager({
  storage: (() => { try { return window.localStorage; } catch { return null; } })(),
  onTier: tier => applyTier(tier),
  pin: perfPin === 'high' || perfPin === 'medium' || perfPin === 'low' ? perfPin : null,
  quiet: pageParams.get('perfquiet') !== '0', pace: pageParams.get('pace') !== '0', onPixel: fitPixels,
  busy: () => loading || speech.active || speechGate.holding > 0 || bubble.shown || said.shown || (mouth?.isSpeaking ?? false) || Object.values(current?.senses ?? {}).some(Boolean),
});
const renderer = fileOrderRenderer(new WebGLRenderer(unboundGlOptions(perf.startTier.antialias)));
perf.gpu = gpuOfContext(renderer.getContext()); fitPixels();
renderer.outputColorSpace = SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
renderer.domElement.className = 'unbound-stage';
root.append(renderer.domElement);
const scene = new Scene();
addStageLights(scene);
const camera = new WorldCamera();
const bubble = new ReplyBubble(root);
const shownReport = new ShownReporter(report => { void api?.shown(report).catch(() => {}); }); // read-aloud (docs/claude/2026-11-15-unbound-read-aloud.md)
document.addEventListener('visibilitychange', () => shownReport.reset()); // hidden and shown again: the host forgot; say it once more
const said = new SaidLine(root);
const lights = new SensesLight(root);
let mouth: UnboundMouth | null = null, speakingNow = false, fillerNow: number | null = null;
const mouthLog = new MouthJournal(api ? e => api.stageMouth(e) : null);
const debug = new DebugOverlay(scene, root);

let current: UnboundScene | null = null;
let figure: UnboundFigure | null = null;
/** I-152 step 2: the standard body when she is a VRM (the figure drives its skeleton), else null. */
let standard: StandardBody | null = null;
let figureKey = '';
let motionKey = '';
let physicsKey = '';
let transform: VmdDataTransform | undefined;
const silhouette = new BodyHit(); // her silhouette (body-hit.ts; a VRM's from its own meshes)
const framing = new FloorFraming(camera);
let frustum = framing.apply(placeholderWorld(innerWidth, innerHeight));
const headLocator = new HeadLocator(camera, () => figure, () => frustum);
const headSpot = () => headLocator.spot(), headOnWindow = () => headLocator.onWindow();
// I-154 (src/unbound/her/): touch and snacks only at her body.
const her = new HerOut(root, api ?? null, { camera, pixels: (units, ahead) => units * pixelsPerUnit(frustum, innerHeight, ahead),
  canTouch: () => herTouchable({ peekForcing: false, presence, hidden: document.hidden }), bodyDistance: (x, y) => silhouette.distance(x, y), notice: message => said.showNotice(message), scene, bubble, head: headSpot, home: () => current?.world.placement ?? null }); // B, G
let loadGeneration = 0;
const loadReport = new LoadReporter(progress => api?.loading(progress));
/** Canvas presence 0..1 (fades, never pops); target and the rate it moves at per ms. */
let presence = 0, presenceTarget = 0, presenceRate = 1 / PRESENCE_IN_MS;
let clicks = 0;
const meter = new BodyMeter();

// ---- U2: the director (docs/claude/2026-11-12-unbound-peek.md) -----------------------------------------------------------------
// E3 (docs/claude/2026-11-14-unbound-night-e3-speech.md): the opening beat before she speaks; its gate holds her bubble during the turn.
const speech = new SpeechBeat();
const director: Director = new Director([PEEK_LENS, closeMomentAction({ near: () => pullNear(), ...her.closeHooks() })], new ProceduralGenerator(), report => { void api?.peekReport(report).catch(() => {}); }, speech);
const speechGate = new SpeechBubbleGate(speech, value => { bubble.receive(value); beats.receive(value); }); // 边说边演: a beat follows the words as the bubble lets them out
let nearM = NEAR_DEFAULT_M, softPx = 0;
// U2 E2 (docs/claude/2026-11-14-unbound-night-e2-autonomy.md): her own acts, only the preview probe starts one (`timeScale` slows her clock there).
const acts = new ActPlayer(new ProceduralGenerator(), end => { lastActEnd = end; });
const beats = unboundSpeechBeats(new ProceduralGenerator(), her, api); // 边说边演 (I-175 waiting mouths; I-185 kiss/hug ask the host)
const life = new LifePlayer(LIFE_ACTION_IDS, report => { void api?.lifeReport(report).catch(() => {}); }, () => idleLayer.quickBusy);
her.yieldLife = () => life.yieldNow(); // B, G: a game or her sleep: her own life gives way
let lastActEnd: ActEnd | null = null, probeTimeScale = 1;
// Her idle (docs/claude/2026-11-14-staystill-idle.md「接进 Unbound」): the shipped model, read once; unreadable: the procedural idle.
const bundledIdle = loadBundledIdle(location.href);
const idleFor = async (heightM: number) => createBundledIdle(heightM, await bundledIdle, 1 + Math.floor(Math.random() * 1e6));
const idleLayer = new UnboundIdleLayer(idleFor);
const stage = new StagePage({ api: api ?? null, figure: () => figure, scene: () => current, faceM: () => framing.faceHeightM, dipM: () => director.cameraDipM, closing: () => director.active,
  pulled: () => pulls.active, occupied: () => director.active || pulls.active || life.walking || acts.active || beats.active || nearReturn.busy, unitsPerM: UNITS_PER_M, involvement });
const peekMetrics = new PeekMetrics(); // preview metrics (Codex T-246a metrics.md M2 / M5), peek-metrics.ts
/** 2026-11-23: what a press on her meets now, and what a large pull ends (src/unbound/action-now.ts). */
const owners: ActionOwners = { director, speech, acts, beats, life };
function directorWorld(): DirectorWorld | null {
  if (!current) return null;
  const k = UNITS_PER_M, place = current.world.placement;
  return { lens: lensView({ x: camera.position.x / k, y: camera.position.y / k, z: camera.position.z / k }, frustum), home: { x: place.xM, z: -place.depthM } };
}
function onPeek(value: PeekCommand): void {
  const world = directorWorld();
  if (!world || !value || typeof value !== 'object') return;
  if (value.type !== 'start') { const side = parsePeekSideCommand(value); if (side) director.command(side, world); return; } // a cancel, or (I-203) a frame of her reply
  if (typeof value.id !== 'string') return;
  const plan = parseDirectorPlan(value.plan);
  if (!plan || !figure) return;
  director.command({ type: 'start', id: value.id.slice(0, 40), plan, trial: value.trial === true, armAfterMs: Math.min(5_000, Math.max(0, Number(value.armAfterMs) || 0)) }, world);
  catching.reset();
  peekMetrics.start(peekBones(), figure.mesh.morphTargetInfluences ?? []);
}
const peekBones = () => figure ? ['頭', '左目', '右目'].map(name => figure!.mesh.skeleton.bones.find(bone => bone.name === name)).filter((bone): bone is NonNullable<typeof bone> => !!bone) : [];
let peekWasActive = false;
/** After her frame: the near plane follows her nearest point, the lens softness her eye's distance (the knob), the preview's metrics. */
function peekFrame(raw: number): void {
  if (!figure || !current) return;
  const next = nearPlaneFor(silhouette.ends, silhouette.radii(), camera.position.z);
  if (Math.abs(next - nearM) > 1e-5) { nearM = next; frustum = framing.apply(current.world, nearM); }
  const world = directorWorld(), sense = figure.sense;
  const eyes = sense ? [sense.eyes.left, sense.eyes.right].filter((p): p is NonNullable<typeof p> => !!p) : [];
  const offsets = world ? eyes.map(eye => axisOffset(world.lens, eye)).sort((a, b) => a.off - b.off) : [];
  // Lens to her nearer eye (the visible one, on its surface), sorted by how near the axis it is.
  peekMetrics.eyeDistanceM = offsets[0]?.along ?? null; peekMetrics.eyeOffM = offsets[0]?.off ?? null;
  const px = Math.round(lensSoftnessPx(director.active ? peekMetrics.eyeDistanceM : null, current.peekSoftness ?? 0) * 20) / 20;
  if (px !== softPx) { softPx = px; renderer.domElement.style.filter = px > 0 ? `blur(${px}px)` : ''; }
  peekMetrics.track(director.active, director.phase, peekBones, figure.mesh.morphTargetInfluences ?? [], raw);
}

// ---- click-through only over her ----------------------------------------------------------------------------------------------
const roundTrips: number[] = [], hitTimes: number[] = [];
let toggles = 0;
const toggle = new InteractiveToggle(on => {
  toggles++;
  const started = performance.now();
  api?.setInteractive(on).then(() => { keepLast(roundTrips, performance.now() - started); }, () => { /* refused: stays as the host left it */ });
});
const pointer = { x: -1, y: -1, buttons: 0, inside: false };
// Her capsules say "near her"; one block of the drawn frame says "her" (catch-region.ts). The senses light and the game controls take it directly.
const pixelProbe = new StagePixelProbe();
const catching = new FigureCatch({ toggle, pointer, available: () => !!figure && !document.hidden && presence >= 0.5, probe: (x, y, signal) => pixelProbe.request(x, y, signal),
  bodyDistance: (x, y) => { const t = performance.now(); const d = silhouette.distance(x, y); keepLast(hitTimes, performance.now() - t); return d; },
  otherDistance: (x, y) => { const light = lights.distance(x, y); lights.hover(light <= 0); return Math.min(light, her.play?.distance(x, y) ?? Infinity); } });
function hitTest(): void { if (!pointer.inside) lights.hover(false); catching.move(pointer.x, pointer.y, pointer.buttons); }
// Step 2: a single click on her is reported once (the host reports the touch and opens the small input box); what she does is hers.
const clicks2 = new ClickReporter({
  nearest: (x, y) => silhouette.nearest(x, y), names: index => silhouette.names(index), head: () => headSpot() ?? null,
  eligible: () => toggle.interactive && presence >= 0.5 && !document.hidden,
  send: report => { void api?.touch(report).catch(() => {}); }, clock: () => performance.now(),
});
// Step 5 (pull-input.ts): a press on her that moves or is held is a pull (a quick one stays the click above); she may walk along.
const nearReturn = new NearReturn();
const pullNear = () => { const world = directorWorld(), body = figure ? nearBodyOf(figure) : null; return world && body ? nearStations(world.lens, body) : null; };
const pulls = new UnboundPull({
  near: pullNear, viewerDistanceM: () => current?.world.viewerDistanceM ?? 0.55, nearEnd: (outcome, face) => nearReturn.begin(outcome, face, performance.now()),
  figure: () => figure, view: () => ({ camera, width: window.innerWidth, height: window.innerHeight }),
  eligible: () => toggle.interactive && presence >= 0.5 && !document.hidden,
  action: () => actionNow(owners), endAction: kind => { endForPull(kind, owners); }, // 2026-11-23: a small press only sways her; a large one ends what she does
  send: async message => { const answer = await api?.pull(message); return message.phase === 'start' ? parsePullAnswer(answer) : undefined; },
  ...followClamps(() => current, () => figure, () => pullNear()?.eyeDepthM),
  clock: () => performance.now(), refuse: group => her.pullRefused(group), // B: holding hands
  dot: createPullDot(document, STICK_KNOBS.deadZonePx), holdTouch: () => { clicks2.hold(); }, // I-196 the joystick's dot; I-194 a press held still is a touch
});
// 2026-11-23: the mouse moving never ends anything; a press on her goes to the pull (a tug while she acts).
const readPointer = (event: MouseEvent) => {
  const moved = event.type !== 'mousemove' || event.clientX !== pointer.x || event.clientY !== pointer.y;
  pointer.x = event.clientX; pointer.y = event.clientY; pointer.buttons = event.buttons; pointer.inside = true;
  if (moved) lastPointerAt = performance.now();
  hitTest();
  routePointer(event, { clicks: clicks2, pulls, pagePress: (run, target) => her.pagePress(run, target), pressTaken: () => nearReturn.cancel() }); // pointer-router.ts
};
window.addEventListener('wheel', event => { lastPointerAt = performance.now(); pulls.wheel(event.clientX, event.clientY, event.deltaY, event.deltaMode); }, { passive: true }); // I-196
window.addEventListener('mousemove', readPointer, { passive: true });
window.addEventListener('mousedown', readPointer, { passive: true });
window.addEventListener('mouseup', readPointer, { passive: true });
document.documentElement.addEventListener('mouseleave', () => { pointer.inside = false; lights.hover(false); catching.reset(); });
window.addEventListener('click', () => {
  if (!toggle.interactive) return;
  clicks++;
  // U2: a click on her after a peek is an answer to it (the host checks the window and the time).
  if (director.lastId) void api?.peekReport({ id: director.lastId, phase: director.phase ?? 'done', clicked: true }).catch(() => {});
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { clicks2.cancel(); pulls.cancel(); lights.hover(false); catching.reset(); } }); // I-174: covered is not gone

// ---- her ----------------------------------------------------------------------------------------------------------------------
/** A tier takes effect: the canvas is redrawn at its pixel ratio on the next frame; her physics changes budget in place. */
function fitPixels(): void { renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, perf.pixelTier.pixelRatioCap)); } // 三人同框别卡: one tier lower while she is an idle extra
function applyTier(tier: PerfTier): void {
  fitPixels();
  if (figure && current) configureFigurePhysics(figure, physicsSettingsFor(current, tier));
}
function syncPhysics(target: UnboundFigure, s: UnboundScene): void { physicsKey = JSON.stringify(s.physics); void syncFigurePhysics(target, s, () => perf.tier, () => figure === target); }

/** Loads her (first time, or a different model): fades the old one out first. Reports ready to the host on the first load. */
async function loadFigure(s: UnboundScene, first: boolean): Promise<void> {
  const generation = ++loadGeneration;
  loading = true; // step 1B: the frame-rate governor draws at the full rate while she loads or fades
  figureKey = keyOfFigure(s); motionKey = keyOfMotion(s);
  if (!s.modelUrl) throw new Error('还没有选模型。');
  const step = (name: Parameters<LoadReporter['step']>[0]) => { if (first) loadReport.step(name); };
  step('model');
  if (!first) { presenceTarget = 0; presenceRate = 1 / PRESENCE_OUT_MS; await new Promise(resolve => setTimeout(resolve, PRESENCE_OUT_MS + 50)); }
  const loaded = await loadFigureBody(s.modelUrl, url => loadModel(url, first ? (bytes, total) => loadReport.bytes('model', bytes, total) : undefined)), { mesh, textures, standard: nextStandard } = loaded; // I-152 step 2: MMD or VRM
  if (generation !== loadGeneration) { dropFigureBody(loaded); return; }
  step('parsed');
  // Measured before her body ever moves (the window's measure): the motion transform (a VRM's, or the retarget of a model that is not the
  // reviewed Gene; none: motions as authored), her face's profile and the painted blush (her/out-page.ts).
  const measured = measureWindowModel(mesh, nextStandard ?? null, s.reviewed);
  transform = measured.transform;
  const next = new UnboundFigure(mesh, startPlacement(s, mesh));
  next.setBreath(s.breath);
  applyBody(next, s);
  step('motion');
  const clips = await clipsFor(next, s.motion, transform);
  next.setClips(clips, s.motion.legacy);
  step('textures');
  await Promise.race([textures, new Promise(resolve => setTimeout(resolve, 8_000))]);
  if (generation !== loadGeneration) { next.dispose(); nextStandard?.dispose(); return; }
  mouth?.reset(); mouth = UnboundMouth.forMesh(mesh); mouth?.speaking(speakingNow); mouth?.fillerSound(fillerNow); // Step 2: a new model gets its own mouth
  figure?.dispose(); standard?.dispose();
  figure = next; standard = nextStandard;
  idleLayer.attach(next, next.heightM);
  her.attach(next, measured, { reviewed: s.reviewed, url: s.modelUrl }, nextStandard ?? null); her.setClips(clips, s.motion.legacy, s.motion.pose); // at rest: her scalp is measured
  scene.add(mesh);
  silhouette.measure(mesh);
  next.frame(0); standard?.present();
  step('draw');
  void syncPhysics(next, s);
  updateCapsules();
  renderer.render(scene, camera); // shaders compiled, first frame drawn before the window is shown
  presenceTarget = 1; presenceRate = 1 / PRESENCE_IN_MS;
  loading = false;
  perf.pause(performance.now()); // a load is not a slow machine
  modelSignature = `${mesh.geometry.attributes.position?.count ?? 0}:${mesh.skeleton.bones.length}`;
  perf.setKey(perfKey(innerWidth, innerHeight, window.devicePixelRatio || 1, modelSignature));
}
let modelSignature = '';
// A different display (size or pixel density) means the machine is tested again, from the current tier down (never up).
window.addEventListener('resize', () => { if (modelSignature) perf.setKey(perfKey(innerWidth, innerHeight, window.devicePixelRatio || 1, modelSignature)); });

async function reloadMotion(s: UnboundScene): Promise<void> {
  const target = figure;
  if (!target) return;
  motionKey = keyOfMotion(s);
  try { const clips = await clipsFor(target, s.motion, transform); if (figure === target && motionKey === keyOfMotion(s)) { target.setClips(clips, s.motion.legacy); her.setClips(clips, s.motion.legacy, s.motion.pose); } }
  catch { /* the previous motion keeps playing */ }
}

function applyScene(s: UnboundScene): void {
  current = s;
  frustum = framing.apply(s.world, nearM);
  debug.setVisible(s.debug);
  speech.enabled = s.speechBeat === true;
  lights.set(s.senses ?? null);
  if (!figure) return;
  if (!director.active && !life.walking && !pulls.active && !nearReturn.busy && !s.start) figure.place(s.world.placement); // a peek, a walk of hers or a pull moves her itself; I-212: a start's placement is the host's guess
  figure.setBreath(s.breath);
  applyBody(figure, s);
  if (keyOfFigure(s) !== figureKey) { void loadFigure(s, false).catch(() => { /* the old one stays until a scene that loads */ }); return; }
  if (keyOfMotion(s) !== motionKey) void reloadMotion(s);
  if (JSON.stringify(s.physics) !== physicsKey) void syncPhysics(figure, s);
}

// ---- every frame ------------------------------------------------------------------------------------------------------------
let lastFrame = 0, fpsFrames = 0, fpsSince = 0, fps: number | null = null;
function resize(): void {
  const width = Math.max(1, innerWidth), height = Math.max(1, innerHeight);
  const canvas = renderer.domElement;
  if (canvas.width !== Math.round(width * renderer.getPixelRatio()) || canvas.height !== Math.round(height * renderer.getPixelRatio())) renderer.setSize(width, height, false);
}
function updateCapsules(): void {
  silhouette.update(figure?.mesh ?? null, camera, innerWidth, innerHeight, ahead => pixelsPerUnit(frustum, innerHeight, ahead));
}
/** Anything moving or being touched: she walks, a peek or an act runs, she speaks, the pointer is on her or moved lately, a fade runs, a scene loads. */
let lastPointerAt = -1e9, loading = true;
/** 三人同框别卡: what keeps her at full rate on a crowded stage (shared/unbound/company/extra-pace.ts). */
function involvement(): OwnInvolvement {
  return { speaking: speech.active || speechGate.holding > 0 || bubble.shown || said.shown || (mouth?.isSpeaking ?? false) || (mouth?.open ?? 0) > 0, touched: toggle.interactive || pointer.buttons !== 0 || her.busy || pulls.active,
    walking: !!figure && (figure.walking || figure.moving) || acts.active || beats.active || life.walking || her.moving || nearReturn.busy, closing: director.active, dancing: her.face.dancing };
}
function busyNow(now: number): boolean {
  if (loading || !figure || presence !== presenceTarget || life.active || life.attending > 0 || stage.busy || Object.values(involvement()).some(Boolean)) return true;
  if (now - lastPointerAt < 1_500) return true;
  const stance = figure.report?.stance ?? 'both';
  return figure.walking || figure.moving || (stance !== 'both' && stance !== 'holding');
}
const frameLog: number[] = [], MEASURING = new URLSearchParams(location.search).has('perf');
const measuredFrames: { ms: number; quiet: boolean; hx: number; hy: number }[] = [];
function tick(now: number): void {
  requestAnimationFrame(tick);
  shownReport.flush(); // read-aloud: the frame that placed the bubble has been painted by now
  const pace = stage.pace(now); perf.setPace(pace.capFps, pace.lowered); // 三人同框别卡: an idle extra draws at 30 and one tier lower
  if (!perf.admit(now, busyNow(now))) return; // step 1B: the quiet rate and the tier's cap skip ticks; anything that moves draws this very tick
  const raw = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  if (raw > 0) {
    perf.frame(now, raw * 1000); stage.feed(now, raw * 1000, perf.fps, perf.tier.id); // I-209: the frame-cost guard
    if (!perf.quiet) keepLast(frameLog, raw * 1000, 600);
    if (MEASURING && measuredFrames.length < 200_000) { const head = headOnWindow(); measuredFrames.push({ ms: raw * 1000, quiet: perf.quiet, hx: head.x, hy: head.y }); }
  }
  const delta = Math.min(0.1, Math.max(0, raw)) * probeTimeScale; // the stage's MAX_ANIMATION_DELTA
  if (!fpsSince) fpsSince = now;
  fpsFrames++;
  if (now - fpsSince >= 1000) { fps = fpsFrames * 1000 / (now - fpsSince); fpsFrames = 0; fpsSince = now; }
  resize();
  if (presence !== presenceTarget) {
    const step = raw * 1000 * presenceRate;
    presence = presenceTarget > presence ? Math.min(presenceTarget, presence + step) : Math.max(presenceTarget, presence - step);
    renderer.domElement.style.opacity = presence >= 1 ? '1' : presence.toFixed(4);
  }
  if (figure) {
    const world = directorWorld(), owners = her.wrap(idleLayer.wrap(figure)); // her face lays over what these owners ask (her/out-face.ts)
    if (world) director.frame(delta, world, owners); // U2: layer 1 → layer 2 → targets for layer 3 (her springs), before her frame
    speechGate.poll(); // E3: her bubble comes out when the opening beat lets it
    if (acts.active) { if (director.active) acts.cancel(); else acts.frame(delta, owners); } // E2: a peek takes over; the act winds down
    if (world) life.frame(delta, world, owners, { walking: figure.walking, moving: figure.moving, heightM: figure.heightM, placement: figure.placement }, director.active || speech.active || acts.active || beats.active); // step 4
    pulls.frame(); // step 5: after her own life (a pull owns where she walks while you pull her along)
    // 边说边演: after her own life (talking comes first), never over a pull, a peek, an act, her walk back or the opening beat; a step in or out ends where she stood
    if (world && beats.frame(delta, world.lens, world.home, owners, !director.active && !acts.active && !pulls.pulling && !nearReturn.busy && !life.walking && speechGate.holding === 0, her.beatGates()) && current) figure.place(current.world.placement);
    nearReturn.frame(performance.now(), figure.rootM, !!figure.sense?.moving, director.active, point => figure!.followTo(point)); // I-159 E: back to the face station
    if (peekWasActive && !director.active && current && !pulls.pulling) figure.place(current.world.placement); // a pull that took her owns where she stands
    peekWasActive = director.active;
    // Her face (mood, a pat, a pinch, the snack mouth, thinking, the blush, drowsy, tears) over the owners' targets, then to the idle layer.
    const faced = her.frame(delta, idleLayer.wrap(figure), { shown: !document.hidden, adjusting: pulls.active || nearReturn.busy || director.active, voiced: mouth?.voiced === true, speaking: speakingNow, walking: figure.walking, pulled: pulls.active,
      breath: current?.breath, pointer: pointer.inside ? pointer : null }); // batch B, G
    // The idle under them: in while she just stands, out while anything else drives her (never in one frame).
    idleLayer.frame(delta, idleWanted({ performing: director.active || speech.active || acts.active || beats.active || faced.performing, walking: figure.walking, moving: figure.moving, stance: figure.report?.stance ?? 'both' }), life.idleRate);
    mouth?.restore();
    stage.frame(now); // I-209: her goal kept clear of the others, her body to the stage
    figure.frame(delta, raw);
    frustum = stage.camera(delta, framing, current?.world ?? null, figure, nearM, director.cameraDipM) ?? frustum; // her own body; a kiss's dip
    mouth?.apply(delta, faced.mouth, figure); mouthLog.frame(delta, mouth, her.face.face.mouthWord); // I-175; logged
    her.afterBody(delta); // batch C: a face shape of hers over every other face writer
    standard?.present(raw); // I-152: a VRM's pose, face, then its springs (model/standard-body.ts)
    her.after(innerWidth, innerHeight); // B: props, targets, buttons
    const report = figure.report;
    if (report) meter.add({ root: { x: figure.placement.xM, y: 0, z: -figure.placement.depthM }, standing: !figure.walking && report.feet.every(f => f.planted),
      comMargin: report.comMargin, feet: report.feet.map(f => ({ planted: f.planted, toe: f.toe ? { x: f.toe.x / UNITS_PER_M, y: f.toe.y / UNITS_PER_M, z: f.toe.z / UNITS_PER_M } : null })) });
    updateCapsules();
    peekFrame(raw);
    catching.refresh(); // she may move under a still cursor
    const spot = headSpot(), win = { width: innerWidth, height: innerHeight }, seen = presence > 0.5;
    bubble.place(spot, win, seen); said.place(spot, win, seen); lights.place(spot, win, seen); // Step 2: beside her head, whole reply, the user's line, the senses light
    shownReport.observe(bubble.state()); her.shown(bubble.state(), speakingNow); // read-aloud: what this frame paints, sent at the next frame; her speaking accents
    if (debug.visible && current) {
      debug.update(figure.placement.xM * UNITS_PER_M, -figure.placement.depthM * UNITS_PER_M, overlayText(figure, framing.world(current.world), meter, perf, frameLog, { fps, toggles, roundTrips, clicks, interactive: toggle.interactive }));
      debug.drawCapsules(silhouette.shown, innerWidth, innerHeight, toggle.interactive);
      herGazeDebug(debug, delta, figure, her.face.gaze, camera, pointer, innerWidth, innerHeight); // I-169: where she looks (label and dot)
    }
  }
  renderer.render(scene, camera);
  pixelProbe.afterRender(renderer.getContext() as WebGL2RenderingContext, renderer.domElement); // the read waits behind a fence; nothing is read unless a request is out
}

// ---- numbers for the developer view, and for the preview script ---------------------------------------------------------------
startStatsReport(api, () => ({ toggles, roundTripMs: summarize(roundTrips), fps, hitTestMs: summarize(hitTimes), perf: { tier: perf.tier.id, quiet: perf.quiet, frameMs: summarize(frameLog), drops: perf.drops } }));
window.__unboundProbe = createProbe({
  figure: () => figure, mouth: () => mouth, camera, renderer, lights, pointer, headOnWindow, headSpot, toggle, toggles: () => toggles, clicks: () => clicks, fps: () => fps,
  presence: () => presence, capsules2D: () => silhouette.shown, roundTrips, hitTimes, frameLog, measuredFrames, measuring: MEASURING, meter, perf, idleLayer, director, peekMetrics,
  peekForcing: () => false, nearM: () => nearM, softPx: () => softPx, speech, speechGate, acts, lastActEnd: () => lastActEnd,
  previewProbes: new URLSearchParams(location.search).get('probe') === 'preview', setTimeScale: value => { probeTimeScale = value; }, stage,
});

// ---- start --------------------------------------------------------------------------------------------------------------------
/** Read through functions: both change inside callbacks. */
function sceneNow(): UnboundScene | null { return current; }
function figureNow(): UnboundFigure | null { return figure; }
(async () => {
  if (!api) return;
  api.onBubble(bubbleLink({ director, gate: speechGate, her, beats })); // src/unbound/bubble-link.ts
  api.onPeek(value => onPeek(value));
  api.onLife(value => life.command(value)); // step 4: her own actions, and her gaze when it is yours
  // Step 2: the user's own line (shown briefly), the host asking where her head is (the typing shortcut), the senses light, her voice.
  api.onSaid(text => { if (typeof text === 'string') { said.show(text); her.userSaid(); } else if (typeof text?.notice === 'string') said.showNotice(text.notice); }); // I-159 D: the entry's one line (what was turned on)
  api.onTyping(command => { if (command?.type === 'where' && typeof command.id === 'string') void api.anchor({ id: command.id, head: headSpot() }).catch(() => {}); });
  api.onSenses(senses => lights.set(senses ?? null));
  api.onFillerMouth(shape => { fillerNow = sanitizeFillerShape(shape); mouth?.fillerSound(fillerNow); }); // 2026-11-20: her short sounds in a call move her mouth too
  api.onSpeaking(on => { speakingNow = on === true; mouth?.speaking(speakingNow); bubble.voiceSounding(speakingNow); }); // read-aloud: a finished bubble waits while she reads it
  const newer = (next: UnboundScene) => { const shown = sceneNow(); return !shown || next.revision >= shown.revision; };
  api.onScene(next => { if (newer(next)) applyScene(next); });
  try {
    loadReport.step('page');
    const first = await api.getScene();
    if (newer(first)) applyScene(first);
    resize();
    await loadFigure(sceneNow()!, true);
    applyScene(sceneNow()!); // anything that changed while she loaded
    requestAnimationFrame(tick);
    loadReport.finish();
    stage.start(); // I-209
    await api.ready({ ok: true, modelHeightM: figureNow()?.heightM });
  } catch (error) {
    loadReport.finish();
    await api.ready({ ok: false, error: `她没能出现：${error instanceof Error ? error.message : String(error)}`.slice(0, 300) }).catch(() => {});
  }
})();
