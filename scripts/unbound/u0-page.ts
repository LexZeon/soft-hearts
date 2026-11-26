// Unbound U0 probe page (docs/claude/2026-11-12-unbound-u0.md): a minimal Three.js MMD scene with the bundled Gene model.
// Not the real stage (no Ammo physics, no VMD, no toon outline pass): it measures overlay, canvas size and skinning/fill cost.
import * as THREE from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';

type Config = { mode: 'bench' | 'closeup'; name: string; seconds: number; framing: 'pet' | 'corner' | 'face'; idle: boolean };
const query = new URLSearchParams(location.search);
const config: Config = JSON.parse(query.get('config') ?? '{}');
const w = window as unknown as Record<string, unknown>;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const closeup = config.mode === 'closeup';
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: closeup, powerPreference: 'high-performance' });
const dpr = closeup ? 1 : window.devicePixelRatio || 1;
renderer.setPixelRatio(dpr);
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(-0.5, 1, 1.2); scene.add(sun);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 500);
const FOV = THREE.MathUtils.degToRad(32);

let mesh: THREE.SkinnedMesh;
const bones: Record<string, THREE.Bone | undefined> = {};
let modelH = 20, headY = 17, faceH = 3;
const find = (name: string) => mesh.skeleton.bones.find(b => b.name === name);

function size(width: number, height: number) {
  renderer.setSize(width, height, false);
  camera.aspect = width / height; camera.updateProjectionMatrix();
}

/** Camera looking down -z at (cx, cy) with `visibleH` world units visible vertically at the model's depth. */
function frame(cx: number, cy: number, visibleH: number) {
  const d = visibleH / 2 / Math.tan(FOV / 2);
  camera.position.set(cx, cy, d); camera.lookAt(cx, cy, 0); camera.updateMatrixWorld();
}

function placeFor(framing: Config['framing'], width: number, height: number) {
  mesh.position.set(0, 0, 0);
  if (framing === 'pet') { frame(0, modelH * 0.5, modelH * 1.12); return; }
  if (framing === 'corner') {
    // Body about 500 CSS px tall, standing in the bottom-right corner (a companion-window-sized rectangle).
    const bodyPx = Math.min(500, height * 0.9), visibleH = modelH * height / bodyPx, perPx = visibleH / height;
    frame(0, visibleH / 2 - 8 * perPx, visibleH); // feet 8 px above the bottom
    mesh.position.x = (width / 2 - 220) * perPx; // centre of the body 220 px from the right edge
    return;
  }
  // 'face': the head (faceH tall) fills about half of the screen height.
  frame(0, headY, faceH / 0.5);
}

function setMorph(name: string, value: number) {
  const i = mesh.morphTargetDictionary?.[name]; if (i !== undefined) mesh.morphTargetInfluences![i] = value;
}

const base = new Map<THREE.Bone, THREE.Quaternion>();
function pose(t: number, idle: boolean) {
  const e = new THREE.Euler(), q = new THREE.Quaternion();
  const apply = (bone: THREE.Bone | undefined, x: number, y: number, z: number) => {
    if (!bone) return; const b = base.get(bone)!;
    q.setFromEuler(e.set(x, y, z)); bone.quaternion.copy(b).multiply(q);
  };
  const breath = Math.sin(t * 2 * Math.PI / 4.2) * 0.012;
  apply(bones.spine, breath, idle ? 0 : Math.sin(t * 0.7) * 0.06, 0);
  apply(bones.neck, -breath, idle ? 0 : Math.sin(t * 0.9 + 1) * 0.08, 0);
  apply(bones.head, 0, idle ? 0 : Math.sin(t * 0.55) * 0.18, idle ? 0 : Math.sin(t * 0.4) * 0.05);
  if (!idle) {
    setMorph('まばたき', (t % 3.1) < 0.14 ? 1 : 0);
    setMorph('にこり', (Math.sin(t * 0.5) + 1) / 4);
    apply(bones.armL, 0, 0, Math.sin(t * 0.8) * 0.05); apply(bones.armR, 0, 0, -Math.sin(t * 0.8) * 0.05);
  }
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] ?? 0 };
};

async function bench() {
  const frameDt: number[] = [], submit: number[] = [];
  const warmEnd = performance.now() + 1500, end = warmEnd + config.seconds * 1000;
  let last = 0, counted = 0, firstCounted = 0, lastCounted = 0;
  const t0 = performance.now();
  await new Promise<void>(resolve => {
    const tick = (now: number) => {
      pose((now - t0) / 1000, config.idle);
      const a = performance.now(); renderer.render(scene, camera); const b = performance.now();
      if (now >= warmEnd) { if (last) frameDt.push(now - last); submit.push(b - a); if (!counted++) firstCounted = now; lastCounted = now; }
      last = now;
      if (now < end) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  // GPU headroom: render + a 1-pixel readback forces the GPU to finish; the time is the real GPU cost per frame, not capped by vsync.
  const gl = renderer.getContext(), px = new Uint8Array(4), gpuMs: number[] = [];
  for (let i = 0; i < 90; i++) {
    pose(i / 60, config.idle); const a = performance.now(); renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); gpuMs.push(performance.now() - a);
    if (i % 15 === 14) await new Promise(r => setTimeout(r, 0));
  }
  const seconds = (lastCounted - firstCounted) / 1000;
  return { name: config.name, windowCss: [innerWidth, innerHeight], pixelRatio: dpr, canvasPx: [canvas.width, canvas.height], frames: counted,
    fps: counted > 1 ? (counted - 1) / seconds : 0, frameMs: stats(frameDt), submitMs: stats(submit), gpuSyncMs: stats(gpuMs),
    framesOver25ms: frameDt.filter(x => x > 25).length, framesOver50ms: frameDt.filter(x => x > 50).length };
}

async function closeups() {
  const out: { name: string; dataUrl: string }[] = [];
  const W = 1280, H = 960; size(W, H);
  await new Promise(r => setTimeout(r, 4000)); // 4096-px textures decode after the model is parsed
  for (let i = 0; i < 3; i++) { renderer.render(scene, camera); await new Promise(r => setTimeout(r, 100)); }
  const shot = (name: string) => {
    renderer.render(scene, camera);
    const gl = renderer.getContext(), px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let lit = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) lit++;
    out.push({ name, dataUrl: canvas.toDataURL('image/png'), litFraction: lit / (W * H), tris: renderer.info.render.triangles, calls: renderer.info.render.calls, err: gl.getError(), lost: gl.isContextLost(), cam: camera.position.toArray(), vis: mesh.visible } as never);
  };
  const levels: [string, number, number][] = [['1-full-body', modelH * 0.5, modelH * 1.12], ['2-upper-body', modelH * 0.74, modelH * 0.42],
    ['3-head-shoulders', headY - faceH * 0.2, faceH * 2.2], ['4-face', headY, faceH * 1.25], ['5-big-head', headY - faceH * 0.15, faceH * 0.8]];
  mesh.position.set(0, 0, 0);
  for (const [n, cy, vis] of levels) { frame(0, cy, vis); shot(n); }
  frame(0, headY - faceH * 0.15, faceH * 0.95);
  const names = Object.keys(mesh.morphTargetDictionary ?? {});
  const want = ['にこり', 'ウィンク', 'ウィンク２', '笑い', 'じと目', '困る', '怒り', '悲しみ', 'あ', 'う', 'お', 'ぺろっ', 'てへぺろ', '涙', '照れ', '赤面', 'はぅ'];
  const available = want.filter(n => names.includes(n));
  shot('6-neutral');
  for (const n of available.slice(0, 8)) { setMorph(n, 1); shot('7-morph-' + n); setMorph(n, 0); }
  return { shots: out, morphCount: names.length, morphNames: names, wantedAvailable: available };
}

(async () => {
  try {
    const url = 'u0://asset/model/gene.pmx';
    mesh = await new Promise<THREE.SkinnedMesh>((res, rej) => new MMDLoader().load(url, m => res(m as THREE.SkinnedMesh), undefined, e => rej(e)));
    scene.add(mesh);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh); modelH = box.max.y - box.min.y;
    bones.head = find('頭'); bones.neck = find('首'); bones.spine = find('上半身'); bones.armL = find('左腕'); bones.armR = find('右腕');
    const hp = new THREE.Vector3(); bones.head?.getWorldPosition(hp);
    headY = hp.y ? hp.y + modelH * 0.045 : modelH * 0.85; faceH = modelH * 0.17;
    for (const b of mesh.skeleton.bones) base.set(b, b.quaternion.clone());
    w.__u0 = { modelH, headY, faceH, bonesFound: Object.entries(bones).map(([k, v]) => [k, !!v]), triangles: (mesh.geometry.index?.count ?? 0) / 3, materials: Array.isArray(mesh.material) ? mesh.material.length : 1, bones: mesh.skeleton.bones.length };
    if (closeup) { w.__u0Result = await closeups(); w.__u0Done = true; return; }
    size(innerWidth, innerHeight); placeFor(config.framing, innerWidth, innerHeight);
    pose(0, config.idle); renderer.render(scene, camera); renderer.getContext().finish(); // compile the shaders before the clock starts
    w.__u0Ready = true;
    while (!w.__u0Go) await new Promise(r => setTimeout(r, 20));
    w.__u0Result = await bench(); w.__u0Done = true;
  } catch (error) { w.__u0Error = String((error as Error)?.stack ?? error); w.__u0Done = true; }
})();
