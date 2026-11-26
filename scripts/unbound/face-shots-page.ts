// Development: a face close-up sheet of one PMX (rest pose, front view) with chosen morph weights and the stage's own procedural blush,
// for comparing expressions and checking where the blush lands. Runs in the page that face-shots.mjs opens in a hidden window.
// Not the stage: plain three.js lights and the real MMDLoader; the blush is the stage's own ProceduralBlush and probe.
import { AmbientLight, DirectionalLight, MathUtils, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type Bone, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { StageModelProfile } from '../../src/stage/model-profile';
import { ProceduralBlush, probeBlushAnchors, type BlushAnchors } from '../../src/stage/procedural-blush';
import { proceduralBlushDepth } from '../../shared/behaviors/blush/choose';
import { DEFAULT_BLUSH_CALIBRATION } from '../../shared/mood/blush';

export interface FaceShot { label: string; morphs?: Record<string, number>; blush?: number; mark?: boolean; /** visible height in eye-bone distances (default 9) and the view centre below the eyes in the same unit (default 1.3) */ zoom?: number; below?: number }
interface Loaded { mesh: SkinnedMesh; head: Bone; eyes: Bone[]; blush: ProceduralBlush | null; anchors: BlushAnchors | null; reason: string }
const w = window as unknown as Record<string, unknown>;
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
document.body.style.margin = '0'; document.body.appendChild(renderer.domElement);
let loaded: Loaded | null = null;

w.__load = async (url: string) => {
  const mesh = await new Promise<SkinnedMesh>((resolve, reject) => new MMDLoader().load(url, resolve as never, undefined, reject));
  const find = (name: string) => mesh.skeleton.bones.find(b => b.name === name);
  const head = find('頭')!, eyes = [find('左目'), find('右目')].filter((b): b is Bone => !!b);
  const profile = new StageModelProfile(mesh, { reviewed: false }); profile.attachHead(head);
  mesh.updateWorldMatrix(true, true); mesh.skeleton.update();
  const probe = probeBlushAnchors(mesh, head, eyes, undefined, DEFAULT_BLUSH_CALIBRATION, profile.mouthLocal);
  const blush = probe.supported && probe.anchors ? new ProceduralBlush(head, probe.anchors, mesh) : null;
  loaded = { mesh, head, eyes, blush, anchors: probe.anchors, reason: probe.reason };
  await new Promise(resolve => setTimeout(resolve, 2500)); // textures arrive after the mesh
  return { reason: probe.reason, morphs: Object.keys(mesh.morphTargetDictionary ?? {}), anchors: probe.anchors };
};

/** One sheet: a column count, a size per picture; returns a PNG data URL. */
w.__sheet = async (shots: FaceShot[], cols: number, size: number) => {
  if (!loaded) throw new Error('no model');
  const { mesh, head, eyes } = loaded;
  renderer.setSize(size, size);
  const scene = new Scene(); scene.add(mesh);
  scene.add(new AmbientLight(0xffffff, 0.9)); const sun = new DirectionalLight(0xffffff, 1.1); sun.position.set(0.3, 1, 2); scene.add(sun);
  const out = document.createElement('canvas'), rows = Math.ceil(shots.length / cols), pad = 22;
  out.width = cols * size; out.height = rows * (size + pad);
  const g = out.getContext('2d')!; g.fillStyle = "#cfcbc4"; g.fillRect(0, 0, out.width, out.height);
  const names = mesh.morphTargetDictionary ?? {}, influences = mesh.morphTargetInfluences ?? [];
  for (const [k, shot] of shots.entries()) {
    influences.fill(0);
    for (const [name, weight] of Object.entries(shot.morphs ?? {})) { if (names[name] === undefined) throw new Error(`no morph ${name}`); influences[names[name]] = weight; }
    loaded.blush?.update(proceduralBlushDepth(shot.blush ?? 0), 50, camera(mesh, head, eyes, shot));
    const cam = camera(mesh, head, eyes, shot);
    renderer.setClearColor(0x6f7b88, 1); renderer.render(scene, cam);
    const x = (k % cols) * size, y = Math.floor(k / cols) * (size + pad);
    g.drawImage(renderer.domElement, x, y + pad);
    if (shot.mark && loaded.anchors) {
      const a = loaded.anchors;
      for (const [label, p, color] of [['L', a.leftCheek, '#0a0'], ['R', a.rightCheek, '#0a0'], ['eyeL', a.leftEye, '#00f'], ['eyeR', a.rightEye, '#00f'], ['mouth', a.mouth, '#f0f']] as const) {
        const v = new Vector3(...p).applyMatrix4(head.matrixWorld).project(cam);
        const px = x + (v.x * 0.5 + 0.5) * size, py = y + pad + (-v.y * 0.5 + 0.5) * size;
        g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); g.arc(px, py, 6, 0, Math.PI * 2); g.stroke(); g.fillStyle = color; g.font = '11px sans-serif'; g.fillText(label, px + 8, py + 4);
      }
    }
    g.fillStyle = '#111'; g.font = '14px sans-serif'; g.fillText(shot.label, x + 6, y + 16);
  }
  scene.remove(mesh);
  return out.toDataURL('image/png');
};

function camera(mesh: SkinnedMesh, head: Bone, eyes: Bone[], shot: FaceShot): PerspectiveCamera {
  mesh.updateWorldMatrix(true, true); mesh.skeleton.update();
  const p = eyes.map(b => b.getWorldPosition(new Vector3()));
  const e = p[0].distanceTo(p[1]), mid = p[0].clone().add(p[1]).multiplyScalar(0.5);
  const centre = mid.clone().addScaledVector(new Vector3(0, 1, 0), -(shot.below ?? 1.3) * e), visible = (shot.zoom ?? 9) * e, fov = 14;
  const cam = new PerspectiveCamera(fov, 1, 0.01, 1000);
  cam.position.set(centre.x, centre.y, centre.z + visible / (2 * Math.tan(MathUtils.degToRad(fov / 2))));
  cam.lookAt(centre); cam.updateMatrixWorld(true); void head;
  return cam;
}
w.__ready = true;
