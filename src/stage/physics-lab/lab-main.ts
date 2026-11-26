/**
 * R01 物理调参台 (docs/claude/2026-11-17-physics-lab.md): the developer lab page. It shows the active model (the companion's own
 * mmd-asset:// grant, never a path), runs the companion's own physics code on it (LocalModelPhysics, the same Ammo, the same rig plan) under
 * fixed test motions, shows the meter's numbers, and saves a per-model tuning through the host. Sandboxed, no Node: everything it
 * asks for goes through window.physicsLab (electron/stage/physics-lab-preload-api.ts).
 * Writer order, as on the companion: restore → final pose (rest + test motion) → I-147 jelly layers → physics frame (after the final pose, never before).
 */
import { AmbientLight, Color, DirectionalLight, GridHelper, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type SkinnedMesh } from 'three';
import { fileOrderRenderer } from '../../foundation/draw-order';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { normalizeModelPhysicsSettings, type ModelPhysicsSettings } from '../../../shared/stage/model-physics';
import { DEFAULT_SUBSTEP_HZ, COLLISIONS_DEFAULT, defaultGroupTuning, normalizeModelPhysicsTuning, type ModelPhysicsTuning } from '../../../shared/stage/physics-tuning';
import type { PhysicsLabApi } from '../../../shared/stage/physics-lab';
import { loadAmmo } from '../ammo-runtime';
import { LocalModelPhysics } from '../model-physics';
import { buildPhysicsRigPlan, physicsRigSignature } from '../physics-rig';
import { otherPhysicsGroups, physicsGroups } from './groups';
import { PhysicsMeter, meterColliders } from './meter';
import { TEST_MOTIONS, TEST_MOTION_LABELS, TEST_MOTION_PERIOD, applyTestMotion, motionRig, stillFor, type TestMotion } from './test-motions';
import { LabPanel, type PanelGroup, type PanelState } from './lab-panel';
import { JellyPanel, ensureJelly } from './jelly-panel';
import { StageJelly, physicsOwnership } from '../jelly/stage-jelly';
import { findSoftRegions } from '../jelly/soft-regions';
import { dropForeignPresets, usablePresetSlots } from './preset-store';
import { SOFT_REGIONS, type SoftRegion } from '../../../shared/stage/jelly-tuning';

const api = (window as unknown as { physicsLab: PhysicsLabApi }).physicsLab;
const view = document.getElementById('view')!, side = document.getElementById('side')!, overlay = document.getElementById('overlay')!, status = document.getElementById('status')!;

const renderer = fileOrderRenderer(new WebGLRenderer({ antialias: true }));
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
view.prepend(renderer.domElement);
const scene = new Scene(); scene.background = new Color('#1b1d24');
scene.add(new AmbientLight(0xffffff, 1.6));
const sun = new DirectionalLight(0xffffff, 1.4); sun.position.set(-8, 20, 14); scene.add(sun);
scene.add(new GridHelper(30, 30, 0x444a5a, 0x2c303b));
const camera = new PerspectiveCamera(30, 1, 0.5, 400);
const controls = new OrbitControls(camera, renderer.domElement);

let mesh: SkinnedMesh | null = null, physics: LocalModelPhysics | null = null, meter: PhysicsMeter | null = null, panel: LabPanel | null = null;
/** I-147: the companion's own jelly layers (the same class); always present here, it does nothing while the tuning turns none on. */
let jelly: StageJelly | null = null, jellyPanel: JellyPanel | null = null;
/** Display rate cap (60 or 30, as the companion's settings allow) and the last frame's cost, for the look script and the status line. */
let fpsCap = 60, renderedAt = 0, frameMs = 0;
let rig: ReturnType<typeof motionRig> | null = null, rest: { p: Vector3; q: import('three').Quaternion }[] = [];
let motion: TestMotion = 'headTurn', speed = 1, paused = false, time = 0, loopIndex = -1, height = 20;
let state: PanelState | null = null, applyTimer = 0, pendingNotice = '';
const presets: Partial<Record<'A' | 'B', PanelState>> = {};

function say(text: string, error = false): void { if (panel) panel.say(text, error); else status.textContent = text; }

function resize(): void {
  const width = Math.max(1, view.clientWidth), heightPx = Math.max(1, view.clientHeight);
  renderer.setSize(width, heightPx, false); camera.aspect = width / heightPx; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);

function cameraPreset(name: 'front' | 'side' | 'back'): void {
  const target = new Vector3(0, height * 0.62, 0), distance = height * 1.5;
  const direction = name === 'front' ? new Vector3(0, 0.05, 1) : name === 'side' ? new Vector3(1, 0.05, 0) : new Vector3(0, 0.05, -1);
  camera.position.copy(target).addScaledVector(direction.normalize(), distance); controls.target.copy(target); controls.update();
}

function buttonBar(): void {
  overlay.replaceChildren();
  const make = (text: string, on: () => boolean, action: () => void) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
    button.addEventListener('click', () => { action(); buttonBar(); }); if (on()) button.classList.add('on'); overlay.append(button);
  };
  for (const name of TEST_MOTIONS) make(TEST_MOTION_LABELS[name], () => motion === name, () => { motion = name; time = 0; loopIndex = -1; });
  for (const value of [0.25, 0.5, 1]) make(`${value}×`, () => speed === value, () => { speed = value; });
  make(paused ? '继续' : '暂停', () => paused, () => { paused = !paused; });
  for (const value of [60, 30]) make(`${value} 帧`, () => fpsCap === value, () => { fpsCap = value; });
  make('量帧时间', () => measureFrames, () => { measureFrames = !measureFrames; frameMs = 0; }); // waits for the GPU each frame (slower), so the jelly shader counts
  make('正面', () => false, () => cameraPreset('front')); make('侧面', () => false, () => cameraPreset('side')); make('背面', () => false, () => cameraPreset('back'));
}

function physicsSettings(): ModelPhysicsSettings {
  const s = state!;
  return normalizeModelPhysicsSettings({ hair: { ...s.parts.hair }, chest: { ...s.parts.chest }, quality: s.quality, tuning: s.tuning });
}

/** Knob changes rebuild the worlds a moment later (dragging a slider does not rebuild every pixel); output eases from what is shown. */
function changed(): void {
  window.clearTimeout(applyTimer);
  applyTimer = window.setTimeout(() => { physics?.configure(physicsSettings()); meter?.reset(); }, 150);
  jelly?.configure(state?.tuning); // the jelly layers change in place (no world to rebuild): at once
}

function clone(value: PanelState): PanelState { return structuredClone(value); }

async function load(): Promise<void> {
  physics?.dispose(); physics = null; meter = null; jelly?.dispose(); jelly = null;
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
  mesh = null;
  const model = await api.getModel();
  if (!model.modelUrl) { say('还没有载入模型：先在设置里选一个模型。', true); return; }
  status.textContent = '正在载入模型…';
  const loaded = await new Promise<SkinnedMesh>((resolve, reject) => new MMDLoader().load(model.modelUrl!, resolve, undefined, reject));
  mesh = loaded; scene.add(mesh);
  mesh.updateMatrixWorld(true);
  rest = mesh.skeleton.bones.map(bone => ({ p: bone.position.clone(), q: bone.quaternion.clone() }));
  const plan = buildPhysicsRigPlan(mesh);
  const groups = physicsGroups(mesh, plan), others = otherPhysicsGroups(mesh, plan).length;
  const longest = Math.max(0, ...groups.filter(group => group.part === 'hair').map(group => group.length));
  const panelGroups: PanelGroup[] = groups.map(group => ({ ...group,
    label: `${group.part === 'hair' ? '头发' : '胸部'} · ${group.rootBone >= 0 ? mesh!.skeleton.bones[group.rootBone].name : group.id}`,
    long: group.part === 'hair' && group.length > 3 && group.length === longest }));
  height = Math.max(4, ...mesh.skeleton.bones.map(bone => bone.getWorldPosition(new Vector3()).y)) * 1.05;
  const signature = physicsRigSignature(mesh);
  const saved = model.tuning && model.tuning.rig === signature ? model.tuning : null;
  const tuning: ModelPhysicsTuning = saved ? structuredClone(saved)
    : { version: 1, rig: signature, substepHz: DEFAULT_SUBSTEP_HZ, collisions: { ...COLLISIONS_DEFAULT }, groups: {} };
  for (const group of groups) tuning.groups[group.id] ??= defaultGroupTuning(group.part);
  ensureJelly(tuning);
  state = { tuning, quality: model.settings.quality,
    parts: { hair: { enabled: plan.support.hair.supported, strength: model.settings.hair.strength }, chest: { enabled: plan.support.chest.supported, strength: model.settings.chest.strength } } };
  panel = new LabPanel(side, state, panelGroups, others, {
    changed,
    saveModel: () => { void save(); },
    clearModel: () => { void clear(); },
    storePreset: slot => { presets[slot] = clone(state!); panel!.setPresetAvailable(slot, true); say(`已存到 ${slot}。`); },
    recallPreset: slot => { const preset = presets[slot]; if (!preset) return; Object.assign(state!, clone(preset)); panel!.refresh(); jellyPanel?.refresh(); changed(); say(`现在是 ${slot}。`); },
    reload: () => { void load().catch(error => say(String(error), true)); },
  });
  const softFound = Object.fromEntries(SOFT_REGIONS.map(kind => [kind, 0])) as Record<SoftRegion, number>;
  for (const region of findSoftRegions(mesh, physicsOwnership(mesh).chest)) softFound[region.kind]++;
  jellyPanel = new JellyPanel(side, () => ensureJelly(state!.tuning), changed, softFound);
  jelly = new StageJelly(); jelly.configure(state.tuning);
  dropForeignPresets(presets, tuning.rig);
  for (const slot of usablePresetSlots(presets, tuning.rig)) panel.setPresetAvailable(slot, true); // saving to the model reloads the lab: A/B stay usable
  panel.setSaved(saved ? '这个模型有保存的调参（桌宠和 Unbound 正在用）。' : '这个模型没有保存的调参：桌宠按模型原样。');
  if (pendingNotice) { panel.say(pendingNotice); pendingNotice = ''; }
  const ammo = await loadAmmo();
  physics = new LocalModelPhysics(mesh, ammo, physicsSettings());
  meter = new PhysicsMeter(mesh, groups, meterColliders(mesh, [...new Set([...plan.hair.sourceBodyIndices, ...plan.chest.sourceBodyIndices])]));
  rig = motionRig(mesh);
  time = 0; loopIndex = -1;
  cameraPreset('front'); resize();
  status.textContent = `${groups.length} 组物理`;
}

async function save(): Promise<void> {
  if (!state) return;
  const tuning = normalizeModelPhysicsTuning(state.tuning);
  if (!tuning) { say('调参数据不对，没有保存。', true); return; }
  try { pendingNotice = '已保存为这个模型的设置：桌宠和 Unbound 现在用这套。'; await api.save(tuning); say(pendingNotice); }
  catch (error) { pendingNotice = ''; say(`没有保存：${String(error)}`, true); }
}

async function clear(): Promise<void> {
  try {
    pendingNotice = '已恢复原样：桌宠回到模型原来的物理。';
    const removed = await api.clear();
    if (!removed) { pendingNotice = ''; say('这个模型本来就没有保存的调参。'); }
  } catch (error) { say(`没有恢复：${String(error)}`, true); }
}

let last = performance.now(), numbersAt = 0, springMs = 0;
function frame(now: number): void {
  requestAnimationFrame(frame);
  if (fpsCap < 60 && now - renderedAt < 1000 / fpsCap - 2) return; // the 30 帧 button: draw every other display frame, as the companion's cap does
  renderedAt = now;
  const started = performance.now();
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;
  if (mesh && physics && meter && rig && !paused) {
    time += dt * speed;
    const loop = Math.floor(time / TEST_MOTION_PERIOD[motion]);
    if (loop !== loopIndex) { if (loopIndex >= 0) panel?.numbers(meter.numbers(), meter.avgStepMs, springMs); loopIndex = loop; meter.reset(); }
    physics.restore();
    jelly?.remove();
    mesh.skeleton.bones.forEach((bone, i) => { bone.position.copy(rest[i].p); bone.quaternion.copy(rest[i].q); });
    applyTestMotion(rig, motion, time);
    jelly?.frame(mesh, dt * speed); // I-147 layers 2 and 3: after the final pose, before physics (the meter's base includes layer 2)
    mesh.updateMatrixWorld(true);
    meter.sampleBase();
    const started = performance.now();
    physics.frame(dt * speed);
    const diagnostics = physics.getDiagnostics();
    springMs = diagnostics.hair.springMs + diagnostics.chest.springMs;
    meter.sampleAfter(dt * speed, stillFor(motion, time), performance.now() - started);
    if (now - numbersAt > 500) { numbersAt = now; panel?.numbers(meter.numbers(), meter.avgStepMs, springMs); jellyPanel?.numbers(jelly?.getState() ?? null, frameMs); }
  }
  controls.update();
  renderer.render(scene, camera);
  // The whole frame's cost, the GPU included (finish waits for it): what turning a layer on adds. Read by scripts/dev/jelly-look.mjs.
  if (measureFrames) renderer.getContext().finish();
  frameMs = frameMs * 0.95 + (performance.now() - started) * 0.05;
  (window as unknown as { labFrame?: unknown }).labFrame = { frameMs, fpsCap, measuring: measureFrames, jelly: jelly?.getState() ?? null };
}
/** Set by the look script only (developer tool): wait for the GPU each frame so frameMs includes the vertex shader's cost. */
let measureFrames = false;
(window as unknown as { labMeasure?: (on: boolean) => void }).labMeasure = on => { measureFrames = on; frameMs = 0; };

api.onChanged(() => { void load().catch(error => say(String(error), true)); });
buttonBar();
resize();
requestAnimationFrame(frame);
void load().catch(error => say(`载入失败：${String(error)}`, true));
