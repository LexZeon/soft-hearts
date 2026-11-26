/**
 * Unbound showcase page (docs/claude/2026-11-14-lapwing-showcase.md): her Unbound body (figure.ts: gait, contact, intent layer,
 * arm reach) behind the screen-camera, performing a choreography Claude writes live (performer.ts → the procedural generator's
 * 'showcase' intent → her springs). Record mode draws a soft background and records the canvas (WebM); live mode is transparent
 * over the desktop (the host makes the window click-through). Talks to its host only through window.showcase.
 */
import { AmbientLight, CanvasTexture, DirectionalLight, Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, SRGBColorSpace, Scene, Vector3, WebGLRenderer } from 'three';
import { fileOrderRenderer } from '../../foundation/draw-order';
import './api';
import { addStageLights } from '../../stage/model-loading';
import { StageModelProfile } from '../../stage/model-profile';
import { LocalModelPhysics } from '../../stage/model-physics';
import { normalizeModelPhysicsSettings } from '../../../shared/stage/model-physics'; // direct, not via ../../../shared/stage: through the page rollup moves the stage's shared modules into the chunk the Unbound window loads too (docs/claude/2026-11-16-overhaul-parts-4.md)
import { MORPH_SLOTS, type MorphSlot } from '../../../shared/foundation/universal-skeleton'; // direct, not via the actions page: the Unbound window does not take that page (docs/claude/2026-11-16-overhaul-parts-4.md)
import { applyWorldCamera, nearPlaneFor, NEAR_DEFAULT_M, WorldCamera } from '../camera';
import { UNITS_PER_M, UnboundFigure, loadClip, loadModel } from '../figure';
import { measureBodyCapsules, capsuleEnds } from '../../foundation/body-capsules';
import { ProceduralGenerator } from '../motion/procedural';
import { setShowcaseIdle, setShowcaseSlotGain } from '../motion/showcase-motion';
import { createLearnedIdle } from '../motion/learned-idle';
import { lensView } from '../motion/lens-align';
import { ShowcasePerformer, setLivelierQuiet, setStillWindows } from './performer';
import { setSlowBlush } from './blush-envelope';
import { blushPath, fitModel, resolveSlotMorphs } from './model-fit';
import { ProceduralBlush, probeBlushAnchors } from '../../stage/procedural-blush';
import { DEFAULT_BLUSH_CALIBRATION } from '../../../shared/mood/blush';
import { proceduralBlushDepth } from '../../../shared/behaviors/blush/choose';
import { beatPeak } from '../../../shared/unbound/showcase';
import type { ShowcasePlan } from './api';

const api = window.showcase!;
const root = document.getElementById('stage')!;
// Recording draws an opaque canvas (a transparent one lets the window show through her semi-transparent materials: a pale veil).
const opaque = new URLSearchParams(location.search).get('opaque') === '1';
// Development (round 9): quietOld=1 plays round 8's quiet holds, for a before/after comparison.
setLivelierQuiet(new URLSearchParams(location.search).get('quietOld') !== '1');
// Development (round 10): stillOld=1 plays round 9's quiet holds (no still windows), for a before/after comparison.
setStillWindows(new URLSearchParams(location.search).get('stillOld') !== '1');
// Development (round 15): blushOld=1 plays the old blush (the shy expression's onset, 2x), for a before/after comparison.
setSlowBlush(new URLSearchParams(location.search).get('blushOld') !== '1');
const renderer = fileOrderRenderer(new WebGLRenderer({ alpha: !opaque, antialias: true, preserveDrawingBuffer: true }));
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.outputColorSpace = SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
root.append(renderer.domElement);
const scene = new Scene();
/**
 * The showcase's light (round 2; the companion's lights read pale and flat here). Chosen from a sweep of six setups on the same frame
 * (docs/claude/2026-11-14-lapwing-showcase-iterations.md): MMD materials carry their own ambient as emissive, which washes the
 * picture out whatever the lights do, so it is turned down (×0.6) and the lights carry the shading: less ambient, a warm key from
 * the front left and above, a faint cool fill, a soft rim from behind. A brighter warm key alone (tried first) only blew the hair out.
 */
const EMISSIVE_SCALE = 0.6;
/**
 * Round 3, 'night' (the default for recordings): a warm, dim room at night, as in the lapwing clips. A dark amber-brown background
 * with a soft lighter patch behind her, a vignette over everything, a warm key on her face, a warm rim from behind, little
 * ambient, and her materials' own glow lower still so white hair and the white jacket do not bloom.
 */
/**
 * Round 4: the room stays warm and dim, but *her* light keeps her own colours (silver-white hair, white jacket, yellow lining,
 * natural skin): a near-neutral key, a cool rim that lifts the silver hair off the brown room, more of her materials' own glow
 * (0.75; round 3's 0.5 under amber light turned her beige and orange). Chosen from a sweep on one frame (iteration log).
 * 'night3' keeps round 3's light for before/after replays.
 */
const NIGHT_EMISSIVE_SCALE = 0.75, NIGHT3_EMISSIVE_SCALE = 0.5;
function addNightLights(target: Scene, round3 = false): void {
  if (round3) {
    target.add(new AmbientLight(0xffe4cc, 0.42));
    const key = new DirectionalLight(0xffd2a6, 1.3); key.position.set(-12, 20, 24); target.add(key);
    const fill = new DirectionalLight(0xc8d4ff, 0.12); fill.position.set(18, 6, 12); target.add(fill);
    const rim = new DirectionalLight(0xffb27a, 0.75); rim.position.set(10, 16, -26); target.add(rim);
    return;
  }
  target.add(new AmbientLight(0xffffff, 0.7));
  const key = new DirectionalLight(0xfff4ea, 1.2); key.position.set(-12, 20, 24); target.add(key);
  const rim = new DirectionalLight(0xd6e4ff, 0.8); rim.position.set(10, 16, -26); target.add(rim);
}
function nightBackground(): CanvasTexture {
  const c = document.createElement('canvas'); c.width = 512; c.height = 320;
  const g = c.getContext('2d')!, grad = g.createRadialGradient(230, 120, 10, 256, 160, 330);
  grad.addColorStop(0, '#6b4a33'); grad.addColorStop(0.45, '#3d2a1f'); grad.addColorStop(1, '#160e0a');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 320);
  // A couple of out-of-focus warm lights far behind her (a lamp, a window across the room).
  for (const [x, y, r, a] of [[90, 70, 60, 0.18], [430, 110, 45, 0.12]] as const) {
    const glow = g.createRadialGradient(x, y, 0, x, y, r); glow.addColorStop(0, `rgba(255,190,120,${a})`); glow.addColorStop(1, 'rgba(255,190,120,0)');
    g.fillStyle = glow; g.fillRect(0, 0, 512, 320);
  }
  const texture = new CanvasTexture(c); texture.colorSpace = SRGBColorSpace;
  return texture;
}
/** A soft vignette drawn over the picture (a second pass, recording only). */
function vignettePass(): { scene: Scene; camera: OrthographicCamera } {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d')!, grad = g.createRadialGradient(128, 118, 60, 128, 128, 182);
  grad.addColorStop(0, 'rgba(12,6,3,0)'); grad.addColorStop(0.6, 'rgba(12,6,3,0.18)'); grad.addColorStop(1, 'rgba(12,6,3,0.62)');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  const texture = new CanvasTexture(c); texture.colorSpace = SRGBColorSpace;
  const scene = new Scene(); scene.add(new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false })));
  return { scene, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1) };
}
let vignette: { scene: Scene; camera: OrthographicCamera } | null = null;
function draw(): void {
  if (!vignette) { renderer.render(scene, camera); return; }
  renderer.autoClear = false; renderer.clear(); renderer.render(scene, camera); renderer.render(vignette.scene, vignette.camera); renderer.autoClear = true;
}
function addShowcaseLights(target: Scene): void {
  target.add(new AmbientLight(0xffffff, 0.6));
  const key = new DirectionalLight(0xfff0e0, 1.4); key.position.set(-10, 22, 24); target.add(key);
  const fill = new DirectionalLight(0xd4e2ff, 0.2); fill.position.set(18, 6, 12); target.add(fill);
  const rim = new DirectionalLight(0xfff0f6, 0.8); rim.position.set(8, 16, -26); target.add(rim);
}
const camera = new WorldCamera();

function softBackground([top, bottom]: [string, string]): CanvasTexture {
  const c = document.createElement('canvas'); c.width = 16; c.height = 512;
  const g = c.getContext('2d')!, grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, top); grad.addColorStop(1, bottom);
  g.fillStyle = grad; g.fillRect(0, 0, 16, 512);
  const texture = new CanvasTexture(c); texture.colorSpace = SRGBColorSpace;
  return texture;
}

const stats = { eye: [] as number[], clearance: [] as number[], frameMs: [] as number[], beatsSeen: new Set<string>(), blinks: 0 };
let lastCloseLog = -1;
const quantile = (v: number[], q: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : null; };

(async () => {
  const plan: ShowcasePlan = await api.plan();
  const night = plan.lighting === 'night' || plan.lighting === 'night3';
  if (plan.lighting === 'stage') addStageLights(scene); else if (night) addNightLights(scene, plan.lighting === 'night3'); else addShowcaseLights(scene);
  if (night && plan.background) { scene.background = nightBackground(); vignette = vignettePass(); }
  else if (plan.background) scene.background = softBackground(plan.background);
  const resize = () => renderer.setSize(Math.max(1, innerWidth), Math.max(1, innerHeight), false);
  resize(); addEventListener('resize', resize);

  const { mesh, textures } = await loadModel(plan.modelUrl);
  const figure = new UnboundFigure(mesh, { xM: plan.xM, depthM: plan.depthM });
  figure.setGaitLook(false);  figure.setBreath(0.55);
  figure.setClips({ pose: await loadClip(plan.standUrl, mesh), gesture: null, expression: null }, false);
  const map: Partial<Record<MorphSlot, number>> = {};
  let profileMouth: Vector3 | null = null;
  try {
    // The model's own verified expression slots (the 17 universal ones); missing slots are skipped.
    const stageProfile = new StageModelProfile(mesh, { reviewed: true }), profile = stageProfile.profile;
    for (const slot of MORPH_SLOTS) { const entry = profile?.morphs[slot]; if (entry) map[slot] = entry.index; }
    profileMouth = stageProfile.mouthLocal ?? null;
  } catch { /* the universal aliases by name */ }
  // Round 16: the model fits itself from what it measures (model-fit.ts): the stand-off from the lens follows the head's size,
  // weak expression shapes are strengthened (capped), and a model without a blush shape gets the companion's painted cheek blush.
  const fit = fitModel(mesh, map);
  const paintedBlush = blushPath(resolveSlotMorphs(mesh, map), new URLSearchParams(location.search).get('blush') === 'procedural') === 'procedural';
  if (paintedBlush) map.shy = -1; // no blush shape drives the cheeks; the painted one does
  figure.setSlotMorphs(map);
  if (new URLSearchParams(location.search).get('fitOff') !== '1') setShowcaseSlotGain(fit.slotGain); // development: fitOff=1 plays without the fit
  let blush: ProceduralBlush | null = null;
  if (paintedBlush) {
    const find = (...names: string[]) => mesh.skeleton.bones.find(b => names.includes(b.name));
    const probe = probeBlushAnchors(mesh, find('頭'), ['左目', '右目'].map(n => find(n)).filter((b): b is NonNullable<typeof b> => !!b), find('口', 'あご', '顎'), DEFAULT_BLUSH_CALIBRATION, profileMouth);
    if (probe.supported && probe.anchors && find('頭')) { blush = new ProceduralBlush(find('頭')!, probe.anchors, mesh); if (!blush.getState().supported) blush = null; }
    api.log({ blush: blush ? 'painted' : `none (${probe.reason})` });
  }
  api.log({ fit: { headExtentM: +fit.headExtentM.toFixed(4), distanceScale: fit.distanceScale, slotGain: fit.slotGain } });
  await Promise.race([textures, new Promise(r => setTimeout(r, 8_000))]);
  scene.add(mesh);
  if (plan.lighting !== 'stage') for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as unknown as { emissive?: { multiplyScalar(k: number): void } }[]) m.emissive?.multiplyScalar(plan.lighting === 'night' ? NIGHT_EMISSIVE_SCALE : plan.lighting === 'night3' ? NIGHT3_EMISSIVE_SCALE : EMISSIVE_SCALE);
  figure.faceToward({ x: 0, z: plan.world.viewerDistanceM });
  figure.frame(0);
  // Her eyes level with yours, a little above (the camera is your eye; she stands behind the screen).
  const eyeBone = mesh.skeleton.bones.find(b => b.name === '左目');
  const eyeY = eyeBone ? eyeBone.getWorldPosition(new Vector3()).y / UNITS_PER_M : 1.4;
  const world = { ...plan.world, eyeHeightM: eyeY - 0.03 };
  let nearM = NEAR_DEFAULT_M;
  let frustum = applyWorldCamera(camera, world, nearM);
  const capsules = measureBodyCapsules(mesh), ends: Vector3[] = [];
  if (plan.physics) {
    try {
      const { loadAmmo } = await import('../../stage/ammo-runtime');
      const ammo = await loadAmmo();
      figure.attachPhysics(new LocalModelPhysics(mesh, ammo, normalizeModelPhysicsSettings({ hair: { enabled: true, strength: 0.7 }, chest: { enabled: false, strength: 0 } } as never)));
    } catch (error) { api.log({ physics: String(error) }); }
  }
  const lens = () => lensView({ x: camera.position.x / UNITS_PER_M, y: camera.position.y / UNITS_PER_M, z: camera.position.z / UNITS_PER_M }, frustum);
  const home = { x: plan.xM, z: -plan.depthM };
  const performer = new ShowcasePerformer(home, plan.liveliness, plan.seed, plan.opening, { distanceScale: new URLSearchParams(location.search).get('fitOff') === '1' ? 1 : fit.distanceScale, viewerM: plan.world.viewerDistanceM });
  // Round 7: the learned idle under quiet holds and her own world, when the host turned it on.
  const idle = plan.idle;
  setShowcaseIdle(idle ? () => createLearnedIdle({ heightM: figure.heightM, seed: Math.floor(plan.seed * 1e6) + 1, weights: idle.weights, events: idle.events }) : null);
  const generator = new ProceduralGenerator();
  if (idle) api.log({ idle: idle.weights ? (idle.events ? 'model+events' : 'model') : 'procedural (no weights)' });
  let noMore = false, recorder: MediaRecorder | null = null, startedRecording = false, recordStart = 0, finished = false;
  const stillsLeft = [...plan.stills].sort((a, b) => a - b);
  // Round 6: one still per beat at its peak (named by beat), recording only; queued as beats arrive (both segments).
  const beatStills: { at: number; name: string }[] = [], queued = new Set<unknown>();
  const pending: Parameters<ShowcasePerformer['append']>[0][] = [];
  api.onSegment(beats => pending.push(beats));
  api.onNoMore(() => { noMore = true; });
  draw();
  renderer.domElement.style.opacity = '1';
  await api.ready();
  // Development: a lighting sweep (a still per setup, then done). SHOWCASE_LIGHT_PROBE on the host.
  if (new URLSearchParams(location.search).get('lightProbe') === '1') {
    const lights = () => scene.children.filter(c => (c as { isLight?: boolean }).isLight);
    const emissive = new Map<unknown, { r: number; g: number; b: number }>();
    const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as unknown as { emissive?: { r: number; g: number; b: number; setRGB(r: number, g: number, b: number): void } }[];
    for (const m of materials) if (m.emissive) emissive.set(m, { r: m.emissive.r, g: m.emissive.g, b: m.emissive.b });
    // Round 4: candidates on the night room (run with --lighting stage so the materials start as the app has them).
    scene.background = nightBackground(); vignette = vignettePass();
    const setups: [string, number, () => void][] = [
      ['A-app-stage', 1, () => addStageLights(scene)],
      ['N2-round3', 0.5, () => { scene.add(new AmbientLight(0xffe4cc, 0.42)); const k = new DirectionalLight(0xffd2a6, 1.3); k.position.set(-12, 20, 24); scene.add(k); const r = new DirectionalLight(0xffb27a, 0.75); r.position.set(10, 16, -26); scene.add(r); }],
      ['N3', 0.75, () => { scene.add(new AmbientLight(0xffffff, 0.7)); const k = new DirectionalLight(0xfff4ea, 1.2); k.position.set(-12, 20, 24); scene.add(k); const r = new DirectionalLight(0xd6e4ff, 0.8); r.position.set(10, 16, -26); scene.add(r); }],
      ['N4', 0.85, () => { scene.add(new AmbientLight(0xfff8f2, 0.8)); const k = new DirectionalLight(0xfff1e4, 1); k.position.set(-12, 20, 24); scene.add(k); const r = new DirectionalLight(0xdfe8ff, 0.9); r.position.set(10, 16, -26); scene.add(r); }],
      ['N5', 0.7, () => { scene.add(new AmbientLight(0xffffff, 0.6)); const k = new DirectionalLight(0xfff0e2, 1.4); k.position.set(-12, 20, 24); scene.add(k); const r = new DirectionalLight(0xd6e4ff, 1); r.position.set(10, 16, -26); scene.add(r); }],
      ['N6', 0.9, () => { scene.add(new AmbientLight(0xffffff, 0.9)); const k = new DirectionalLight(0xfff2e6, 0.9); k.position.set(-12, 20, 24); scene.add(k); const r = new DirectionalLight(0xd8e6ff, 1); r.position.set(10, 16, -26); scene.add(r); }],
    ];
    await new Promise(r => setTimeout(r, 1200)); // the canvas fades in first (a still during the fade reads as a pale veil)
    for (const [name, k, add] of setups) {
      for (const l of lights()) scene.remove(l);
      add();
      for (const [m, c] of emissive) (m as { emissive: { setRGB(r: number, g: number, b: number): void } }).emissive.setRGB(c.r * k, c.g * k, c.b * k);
      for (let i = 0; i < 3; i++) { figure.frame(1 / 60); renderer.render(scene, camera); await new Promise(r => requestAnimationFrame(r)); }
      draw(); await api.still(`light-${name}`);
    }
    await api.done({ reason: 'light-probe' });
    return;
  }

  const startRecording = () => {
    if (plan.mode !== 'record' || startedRecording) return;
    startedRecording = true;
    const stream = renderer.domElement.captureStream(60);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    // ?vbr=: a lower bitrate for a copy small enough to send to a phone (development; default 9 Mbit/s).
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Number(new URLSearchParams(location.search).get('vbr')) || 9_000_000 });
    recorder.ondataavailable = event => { if (event.data.size) void event.data.arrayBuffer().then(buffer => api.chunk(buffer)); };
    recorder.start(1000);
    recordStart = performance.now();
  };
  const finish = async (reason: string) => {
    if (finished) return; finished = true;
    if (recorder) { const stopped = new Promise(r => { recorder!.onstop = r; }); recorder.stop(); await stopped; await new Promise(r => setTimeout(r, 400)); }
    else { renderer.domElement.style.opacity = '0'; await new Promise(r => setTimeout(r, 800)); }
    await api.done({
      reason, seconds: performer.clock, startOffset: performer.startOffset, played: performer.played, blinks: performer.blinkTimes.length,
      eyeInHeadDeg: { p95: quantile(stats.eye, 0.95), max: stats.eye.length ? Math.max(...stats.eye) : null },
      handClearanceCm: stats.clearance.length ? Math.min(...stats.clearance) * 100 : null,
      frameMs: { p50: quantile(stats.frameMs, 0.5), p95: quantile(stats.frameMs, 0.95), max: stats.frameMs.length ? Math.max(...stats.frameMs) : null },
      recordedS: startedRecording ? (performance.now() - recordStart) / 1000 : 0,
    });
  };

  // Development: a contact sheet, 10 frames a second over a stretch of the performance (SHOWCASE_SHEET="start,seconds").
  const sheetSpec = (new URLSearchParams(location.search).get('sheet') ?? '').split(',').map(Number);
  const sheet = sheetSpec.length === 2 && sheetSpec.every(Number.isFinite) ? { start: sheetSpec[0], dur: sheetSpec[1], canvas: document.createElement('canvas'), n: 0, next: sheetSpec[0], done: false } : null;
  const SHEET_COLS = 6, THUMB_W = 320, THUMB_H = 200;
  if (sheet) { const rows = Math.ceil(sheet.dur * 10 / SHEET_COLS); sheet.canvas.width = SHEET_COLS * THUMB_W; sheet.canvas.height = rows * THUMB_H; }
  let last = 0;
  const tick = (now: number) => {
    if (finished) return;
    requestAnimationFrame(tick);
    const raw = last ? (now - last) / 1000 : 0; last = now;
    const dt = Math.min(0.1, Math.max(0, raw));
    if (raw > 0) stats.frameMs.push(raw * 1000);
    resize();
    const t = performer.clock;
    // Segments: the first one after her opening (recording: as the camera rolls); later ones as they come.
    if (pending.length && (t >= plan.prerollS || performer.startOffset !== null)) { performer.append(pending.shift()!); }
    if (t >= plan.prerollS - 0.25 && performer.startOffset !== null) startRecording();
    const out = performer.frame(dt, lens());
    blush?.update(proceduralBlushDepth(out.intent.face.blush), 50, camera); // painted cheeks (a model without a blush shape)
    const sense = figure.sense;
    if (sense) figure.setPoseTargets(generator.generate({ intent: out.intent, t, dt, sense }));
    figure.frame(dt, raw);
    capsuleEnds(mesh, capsules, ends);
    const near = nearPlaneFor(ends, capsules.map(c => c.r), camera.position.z);
    if (Math.abs(near - nearM) > 1e-5) { nearM = near; frustum = applyWorldCamera(camera, world, nearM); }
    draw();
    if (performer.startOffset !== null) {
      stats.eye.push(Math.max(0, ...figure.eyeInHead().map(e => Math.hypot(e.yaw, e.pitch))));
      const c = figure.handClearance; if (c !== null) stats.clearance.push(c);
      // Round 9: say when (performance seconds) the fingers come within 3 mm of her surface, at most ten times a second.
      if (c !== null && c < 0.003 && performer.clock - lastCloseLog > 0.1) { lastCloseLog = performer.clock; api.log({ close: { t: +(performer.clock - performer.startOffset).toFixed(2), cm: +(c * 100).toFixed(2), beats: out.beats } }); }
      for (const b of out.beats) stats.beatsSeen.add(b);
    }
    // Stills at performance seconds (from when the first segment began).
    const p = performer.startOffset !== null ? t - performer.startOffset : -1;
    if (sheet && !sheet.done && p >= sheet.next) {
      const g = sheet.canvas.getContext('2d')!, src = renderer.domElement;
      // The middle of the picture (her face), scaled down.
      const cw = src.width * 0.5, ch = cw * THUMB_H / THUMB_W, sx = (src.width - cw) / 2, sy = src.height * 0.12;
      g.drawImage(src, sx, sy, cw, ch, (sheet.n % SHEET_COLS) * THUMB_W, Math.floor(sheet.n / SHEET_COLS) * THUMB_H, THUMB_W, THUMB_H);
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect((sheet.n % SHEET_COLS) * THUMB_W, Math.floor(sheet.n / SHEET_COLS) * THUMB_H, 60, 20);
      g.fillStyle = '#fff'; g.font = '14px sans-serif'; g.fillText(p.toFixed(1) + 's', (sheet.n % SHEET_COLS) * THUMB_W + 6, Math.floor(sheet.n / SHEET_COLS) * THUMB_H + 15);
      sheet.n++; sheet.next += 0.1;
      if (sheet.next >= sheet.start + sheet.dur) { sheet.done = true; void api.saveImage(`sheet-${sheet.start}s`, sheet.canvas.toDataURL('image/png')); }
    }
    if (plan.mode === 'record' && performer.startOffset !== null) {
      for (const b of performer.played) if (!queued.has(b)) {
        queued.add(b);
        const peak = beatPeak(b);
        if (peak !== null) beatStills.push({ at: b.playedAt + Math.max(0, peak), name: `beat-${String(Math.round(b.at * 10)).padStart(3, '0')}-${b.kind}${b.name ? '-' + b.name : ''}${b.where ? '-' + b.where : ''}${b.size ? '-' + b.size : ''}` });
      }
      beatStills.sort((x, y) => x.at - y.at);
      while (beatStills.length && t >= beatStills[0].at) { const s = beatStills.shift()!; void api.still(s.name); }
    }
    if (stillsLeft.length && p >= stillsLeft[0]) { const s = stillsLeft.shift()!; void api.still(`still-${String(Math.round(s * 10)).padStart(3, '0')}-${out.beats.join('+') || 'idle'}`); }
    const end = performer.endsAt;
    if (end !== null && noMore && !pending.length && t > end + 1.2) void finish('end');
    // Nothing came (Claude could not be reached): she stays in her own world a little, then leaves.
    if (end === null && noMore && !pending.length && t > 6) void finish('no-choreography');
    if (t > plan.capS) void finish('cap');
  };
  requestAnimationFrame(tick);
  setInterval(() => api.log({ t: performer.clock.toFixed(1), eyeP95: quantile(stats.eye, 0.95), clearanceMinCm: stats.clearance.length ? Math.min(...stats.clearance) * 100 : null }), 5_000);
})().catch(error => { api.log({ error: String(error?.stack ?? error) }); void api.done({ reason: 'error', error: String(error) }); });
