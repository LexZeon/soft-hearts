// Motion-model spike preview page (docs/claude/2026-11-14-motion-model-spike.md): Gene in her real Unbound body (UnboundFigure:
// stand VMD, gait and contact owner, intent-layer springs) driven by one idle source as layer-2 targets. The host (idle-preview-
// main.ts) steps it deterministically (fixed 1/60 s frames, no wall clock), so every group is shown at exactly the same times.
import { Box3, Color, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer, type Bone } from 'three';
import { UNITS_PER_M, UnboundFigure, loadClip, loadModel } from '../../src/unbound/figure';
import { addStageLights } from '../../src/stage/model-loading';
import { IdleGenerator } from '../../src/unbound/motion/idle-channels';
import { fetchGroupData, makeGroupSource, type GroupData, type IdleGroup } from './idle-groups';
import { REST_TARGETS, type BodySense } from '../../src/unbound/motion/generator';

const w = window as unknown as Record<string, unknown>;
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = SRGBColorSpace;
renderer.setClearColor(new Color(0xf3ede6), 1);
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const scene = new Scene();
addStageLights(scene); // the stage's own lights, so she looks as she does in the app
const camera = new PerspectiveCamera(28, innerWidth / innerHeight, 0.05 * UNITS_PER_M, 50 * UNITS_PER_M);

const DUMMY = { root: { x: 0, z: 0, heading: 0 }, moving: false, eyes: { left: null, right: null }, head: null, frame: null, offsets: { lateral: 0, forward: 0, up: 0 }, eyeSizeM: null, tiptoeRise: 0 } as BodySense;
let groupData: GroupData | null = null;
let figure: UnboundFigure | null = null, generator: IdleGenerator | null = null, clock = 0;
const ACTIVITY = 0.5;

async function data() { groupData ??= await fetchGroupData(); }

/** A fresh Gene for one group (the same start for every group). */
w.__setup = async (group: string, seed: number) => {
  await data();
  if (figure) { figure.dispose(); figure = null; }
  const { mesh, textures } = await loadModel('idlep://gene/model/gene.pmx');
  const stand = await loadClip('idlep://gene/motions/pose/stand.vmd', mesh);
  await Promise.race([textures, new Promise(r => setTimeout(r, 8000))]);
  figure = new UnboundFigure(mesh, { xM: 0, depthM: 3 });
  figure.setClips({ pose: stand, gesture: null, expression: null }, false);
  figure.setBreath(0.5);
  scene.add(mesh);
  const source = makeGroupSource(group as IdleGroup, seed, groupData!);
  generator = source ? new IdleGenerator(source, { heightM: figure.heightM }) : null;
  if (!generator) figure.setPoseTargets({ ...REST_TARGETS });
  clock = 0;
  figure.frame(0);
  fixed = null;
  paths.head.length = 0; paths.hips.length = 0;
  frameCamera('body'); // the camera is placed from her first frame (the same stand pose for every group)
  return { heightM: figure.heightM };
};

/** Steps her (fixed 1/60 s) until `t`, then frames and draws her. `view`: 'body' (whole figure) or 'bust' (head and shoulders). */
w.__advance = (t: number, view: 'body' | 'bust') => {
  const f = figure!, dt = 1 / 60;
  while (clock + dt / 2 < t) {
    if (generator) f.setPoseTargets(generator.generate({ intent: { kind: 'idle', activity: ACTIVITY }, t: clock, dt, sense: f.sense ?? DUMMY }));
    f.frame(dt);
    clock += dt;
    record();
  }
  frameCamera(view);
  renderer.render(scene, camera);
  return { t: clock };
};

/** Head and hip paths seen from the front (her lateral and vertical, cm from where they started), one point per frame. */
const paths: { head: [number, number][]; hips: [number, number][] } = { head: [], hips: [] };
const tmp = new Vector3();
function record() {
  if (!fixed) return;
  const side = new Vector3(fixed.forward.z, 0, -fixed.forward.x); // her left... or right: the same for every group
  for (const [key, name] of [['head', '頭'], ['hips', '下半身']] as const) {
    const bone = find(name); if (!bone) continue;
    bone.getWorldPosition(tmp).divideScalar(UNITS_PER_M);
    paths[key].push([tmp.dot(side) * 100, tmp.y * 100]);
  }
}
const overlay = document.createElement('canvas');
overlay.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none';
document.body.append(overlay);
/** Draws (or clears) both paths, magnified, in a box in the corner: the shape of how she moves over the whole run. */
w.__drawTrace = (show: boolean, label: string) => {
  overlay.width = innerWidth; overlay.height = innerHeight;
  const g = overlay.getContext('2d')!;
  g.clearRect(0, 0, overlay.width, overlay.height);
  if (!show) return;
  const box = { x: 12, y: 12, w: 200, h: 200 }, scale = 40; // px per cm (a 5 cm square)
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(box.x, box.y, box.w, box.h);
  g.strokeStyle = '#999'; g.strokeRect(box.x, box.y, box.w, box.h);
  g.font = '12px sans-serif'; g.fillStyle = '#333'; g.fillText(`${label}: 头(红) 胯(蓝) 路径 0–${Math.round(clock)}s，方框边长 5 cm`, box.x, box.y + box.h + 16);
  for (const [key, color] of [['head', '#d33'], ['hips', '#36c']] as const) {
    const p = paths[key]; if (!p.length) continue;
    const [x0, y0] = p[0];
    g.strokeStyle = color; g.lineWidth = 1; g.beginPath();
    p.forEach(([x, y], i) => { const px = box.x + box.w / 2 + (x - x0) * scale, py = box.y + box.h / 2 - (y - y0) * scale; if (i) g.lineTo(px, py); else g.moveTo(px, py); });
    g.stroke();
  }
};

const find = (name: string) => figure!.mesh.skeleton.bones.find(b => b.name === name) as Bone | undefined;
/** The camera in front of her (her forward from her head toward her eyes), fixed per group at the first call. */
let fixed: { target: Vector3; forward: Vector3; height: number } | null = null;
w.__resetCamera = () => { fixed = null; };
function frameCamera(view: 'body' | 'bust') {
  const mesh = figure!.mesh;
  mesh.updateMatrixWorld(true);
  if (!fixed) {
    const head = find('頭')!.getWorldPosition(new Vector3()), eyes = ['左目', '右目'].map(n => find(n)?.getWorldPosition(new Vector3())).filter(Boolean) as Vector3[];
    const forward = eyes.length === 2 ? eyes[0].clone().add(eyes[1]).multiplyScalar(0.5).sub(head).setY(0).normalize() : new Vector3(0, 0, 1);
    const box = new Box3().setFromObject(mesh);
    fixed = { target: new Vector3((box.min.x + box.max.x) / 2, 0, (box.min.z + box.max.z) / 2), forward, height: box.max.y - box.min.y };
  }
  const { target, forward, height } = fixed;
  const fov = (camera.fov * Math.PI) / 180;
  const visible = view === 'body' ? height * 1.12 : height * 0.32, cy = view === 'body' ? height * 0.5 : height * 0.86;
  const d = visible / 2 / Math.tan(fov / 2);
  // A little to her left of straight on (a three-quarter view shows lean and shift better than a flat front).
  const side = new Vector3(forward.z, 0, -forward.x).multiplyScalar(0.35);
  const dir = forward.clone().add(side).normalize();
  camera.position.set(target.x + dir.x * d, cy, target.z + dir.z * d);
  camera.lookAt(target.x, cy, target.z);
  camera.updateMatrixWorld();
}

w.__ready = true;
