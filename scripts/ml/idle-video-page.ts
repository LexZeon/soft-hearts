// Motion-model spike round 2: the video page (docs/claude/2026-11-14-motion-model-spike.md「第 2 轮」). Gene in her real Unbound
// body (UnboundFigure: stand VMD, gait and contact owner, intent-layer springs, hip and arm residuals), one figure per group, each
// driven by its idle source as layer-2 targets. Only her own canvas is recorded (a 2D canvas that copies the WebGL one and writes
// the group's name on it), on a soft opaque background, with MediaRecorder; the host pulls the webm out in slices.
//   'side':     the groups side by side, all at once, whole body
//   'sequence': one group after another, head and shoulders, the same camera
// Each frame steps every shown group by the wall-clock time since the last frame (the same for all), so nothing plays slowed.
import { Box3, Color, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer, type Bone } from 'three';
import { UnboundFigure, loadClip, loadModel } from '../../src/unbound/figure';
import { addStageLights } from '../../src/stage/model-loading';
import { IdleGenerator } from '../../src/unbound/motion/idle-channels';
import { REST_TARGETS, type BodySense } from '../../src/unbound/motion/generator';
import { GROUP_LABELS, STAYSTILL_GROUPS, fetchGroupData, makeGroupIdle, makeGroupSource, type GroupData, type IdleGroup } from './idle-groups';
import type { LearnedIdle } from '../../src/unbound/motion/learned-idle';

const w = window as unknown as Record<string, unknown>;
const W = 1280, H = 720;
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = SRGBColorSpace;
renderer.setClearColor(new Color(0xf3ede6), 1);
renderer.setSize(W, H);
const composite = document.createElement('canvas');
composite.width = W; composite.height = H;
composite.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh';
document.body.append(composite);
const g2 = composite.getContext('2d')!;
const scene = new Scene();
addStageLights(scene);
const camera = new PerspectiveCamera(26, W / H, 0.5, 600);
const DUMMY = { root: { x: 0, z: 0, heading: 0 }, moving: false, eyes: { left: null, right: null }, head: null, frame: null, offsets: { lateral: 0, forward: 0, up: 0 }, eyeSizeM: null, tiptoeRise: 0 } as BodySense;

interface Actor { group: IdleGroup; figure: UnboundFigure; generator: IdleGenerator | null; idle: LearnedIdle | null }
let data: GroupData | null = null;
let actors: Actor[] = [];

async function addActor(group: IdleGroup, xM: number, seed: number): Promise<Actor> {
  const { mesh, textures } = await loadModel('idlep://gene/model/gene.pmx');
  const stand = await loadClip('idlep://gene/motions/pose/stand.vmd', mesh);
  await Promise.race([textures, new Promise(r => setTimeout(r, 8000))]);
  const figure = new UnboundFigure(mesh, { xM, depthM: 3 });
  figure.setClips({ pose: stand, gesture: null, expression: null }, false);
  figure.setBreath(0.5);
  scene.add(mesh);
  const source = makeGroupSource(group, seed, data!);
  const generator = source ? new IdleGenerator(source, { heightM: figure.heightM }) : null;
  const idle = makeGroupIdle(group, seed, data!, figure.heightM);
  if (!generator && !idle) figure.setPoseTargets({ ...REST_TARGETS });
  figure.frame(0);
  return { group, figure, generator, idle };
}

function step(actor: Actor, dt: number, activity: number) {
  if (actor.idle) actor.figure.setPoseTargets(actor.idle.frame(dt, activity));
  else if (actor.generator) actor.figure.setPoseTargets(actor.generator.generate({ intent: { kind: 'idle', activity }, t: 0, dt, sense: actor.figure.sense ?? DUMMY }));
  actor.figure.frame(dt);
}

/** The camera in front of the actors (their forward from head toward eyes), framing `part` of their height. */
function frameCamera(view: 'body' | 'bust') {
  const box = new Box3();
  for (const a of actors) { a.figure.mesh.updateMatrixWorld(true); box.expandByObject(a.figure.mesh); }
  const mesh = actors[0].figure.mesh, bones = mesh.skeleton.bones, find = (n: string) => bones.find(b => b.name === n) as Bone | undefined;
  const head = find('頭')!.getWorldPosition(new Vector3()), eyes = ['左目', '右目'].map(n => find(n)?.getWorldPosition(new Vector3())).filter(Boolean) as Vector3[];
  const forward = eyes.length === 2 ? eyes[0].clone().add(eyes[1]).multiplyScalar(0.5).sub(head).setY(0).normalize() : new Vector3(0, 0, 1);
  const height = box.max.y - box.min.y, centre = box.getCenter(new Vector3());
  const fov = camera.fov * Math.PI / 180, width = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const visibleH = view === 'body' ? Math.max(height * 1.1, width * 1.15 / camera.aspect) : height * 0.34;
  const cy = view === 'body' ? box.min.y + height * 0.5 : box.min.y + height * 0.86;
  const d = visibleH / 2 / Math.tan(fov / 2);
  const side = new Vector3(forward.z, 0, -forward.x).multiplyScalar(view === 'body' ? 0 : 0.3);
  const dir = forward.clone().add(side).normalize();
  camera.position.set(centre.x + dir.x * d, cy, centre.z + dir.z * d);
  camera.lookAt(centre.x, cy, centre.z);
  camera.updateMatrixWorld();
}

function label(lines: { text: string; x: number }[], sub: string) {
  g2.drawImage(renderer.domElement, 0, 0);
  g2.font = '600 30px "Microsoft YaHei", "PingFang SC", sans-serif';
  g2.textAlign = 'center';
  for (const { text, x } of lines) {
    const m = g2.measureText(text).width;
    g2.fillStyle = 'rgba(255,255,255,0.82)'; g2.fillRect(x - m / 2 - 14, 18, m + 28, 46);
    g2.fillStyle = '#3a3330'; g2.fillText(text, x, 52);
  }
  g2.font = '18px "Microsoft YaHei", "PingFang SC", sans-serif';
  g2.textAlign = 'left'; g2.fillStyle = 'rgba(58,51,48,0.75)'; g2.fillText(sub, 16, H - 18);
}

const nextFrame = () => new Promise<number>(r => requestAnimationFrame(r));

/** Records `seconds` of the scene; `draw(t)` steps and draws one frame. Returns the webm bytes. */
const frameMs: number[] = [];
async function record(seconds: number, draw: (t: number, dt: number) => void): Promise<Uint8Array> {
  const stream = composite.captureStream(60);
  const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { recorder.onstop = r; });
  recorder.start(1000);
  // The recording's clock is the wall clock: each frame steps her by the time that really passed (so a slow frame never plays
  // back in slow motion), and the frame times are kept for the report.
  let last = await nextFrame(), t = 0;
  frameMs.length = 0;
  while (t < seconds) {
    const now = await nextFrame(), dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    frameMs.push(now - last); last = now; t += dt;
    draw(t, dt);
  }
  recorder.stop();
  await stopped;
  return new Uint8Array(await new Blob(chunks, { type }).arrayBuffer());
}

let video: Uint8Array | null = null;
w.__record = async (mode: 'side' | 'sequence', groups: IdleGroup[], seconds: number, activity: number, warmS: number) => {
  data ??= await fetchGroupData();
  for (const a of actors) a.figure.dispose();
  actors = [];
  const credit = groups.some(g => STAYSTILL_GROUPS.includes(g)) ? '动作数据 100STYLE（Ian Mason, CC BY 4.0）、StayStill（Atxa Landa et al., MIT）' : '动作数据 100STYLE（Ian Mason, CC BY 4.0）';
  const sub = `Gene · 活跃度 ${activity} · 每组 ${seconds} 秒 · 同一个时钟 · ${credit}`;
  if (mode === 'side') {
    const gap = 0.62;
    for (let i = 0; i < groups.length; i++) actors.push(await addActor(groups[i], (i - (groups.length - 1) / 2) * gap, 1));
    for (let i = 0; i < warmS * 60; i++) for (const a of actors) step(a, 1 / 60, activity); // past the first settling, off the record
    frameCamera('body');
    const xs = actors.map(a => { const p = a.figure.mesh.getWorldPosition(new Vector3()).project(camera); return (p.x + 1) / 2 * W; });
    video = await record(seconds, (_t, dt) => {
      for (const a of actors) step(a, dt, activity);
      renderer.render(scene, camera);
      label(actors.map((a, i) => ({ text: GROUP_LABELS[a.group], x: xs[i] })), sub);
    });
  } else {
    // One recording, the groups one after another: every group is a fresh Gene at the same spot, loaded and settled before the
    // recording starts; only the one being shown is visible and steps.
    for (const group of groups) actors.push(await addActor(group, 0, 1));
    for (const a of actors) for (let i = 0; i < warmS * 60; i++) step(a, 1 / 60, activity);
    const show = (k: number) => actors.forEach((a, i) => { a.figure.mesh.visible = i === k; });
    show(0);
    frameCamera('bust');
    video = await record(seconds * groups.length, (t, dt) => {
      const k = Math.min(groups.length - 1, Math.floor(t / seconds));
      show(k);
      step(actors[k], dt, activity);
      renderer.render(scene, camera);
      label([{ text: GROUP_LABELS[groups[k]], x: W / 2 }], sub);
    });
  }
  const sorted = [...frameMs].sort((a, b) => a - b), at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { bytes: video.length, frames: frameMs.length, frameMs: { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 } };
};

/** Base64 of bytes [from, from + n) of the recording. */
w.__slice = (from: number, n: number) => {
  const s = video!.subarray(from, Math.min(video!.length, from + n));
  let bin = '';
  for (let i = 0; i < s.length; i += 0x8000) bin += String.fromCharCode(...s.subarray(i, i + 0x8000));
  return btoa(bin);
};
/** Plays the recording back in a <video>, seeks to `t` seconds and returns that frame as a PNG data URL (checks it decodes). */
w.__poster = async (t: number) => {
  const el = document.createElement('video');
  el.muted = true;
  el.src = URL.createObjectURL(new Blob([video!], { type: 'video/webm' }));
  await new Promise((resolve, reject) => { el.onloadeddata = resolve; el.onerror = () => reject(new Error('the webm does not decode')); });
  el.currentTime = t;
  await new Promise(resolve => { el.onseeked = resolve; });
  const c = document.createElement('canvas');
  c.width = el.videoWidth; c.height = el.videoHeight;
  c.getContext('2d')!.drawImage(el, 0, 0);
  URL.revokeObjectURL(el.src);
  return { png: c.toDataURL('image/png'), width: el.videoWidth, height: el.videoHeight };
};
/**
 * StayStill round: a contact sheet of the recording, decoded back from the webm. `rows` are lists of times (s); each row is drawn
 * left to right at `scale`, a time stamp in the corner. With `onion`, each row also gets one extra tile at its end: all of that
 * row's frames laid over each other at equal weight, so how far she moved in that stretch shows as blur.
 */
w.__sheet = async (rows: { label: string; times: number[] }[], scale: number, onion: boolean) => {
  const el = document.createElement('video');
  el.muted = true;
  el.src = URL.createObjectURL(new Blob([video!], { type: 'video/webm' }));
  await new Promise((resolve, reject) => { el.onloadeddata = resolve; el.onerror = () => reject(new Error('the webm does not decode')); });
  const tw = Math.round(el.videoWidth * scale), th = Math.round(el.videoHeight * scale), head = 22;
  const cols = Math.max(...rows.map(r => r.times.length)) + (onion ? 1 : 0);
  const c = document.createElement('canvas');
  c.width = cols * tw; c.height = rows.length * (th + head);
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
  const seek = async (t: number) => { el.currentTime = t; await new Promise(resolve => { el.onseeked = resolve; }); };
  for (const [r, row] of rows.entries()) {
    const y = r * (th + head);
    g.fillStyle = '#222'; g.font = '15px sans-serif'; g.fillText(row.label, 6, y + 16);
    for (const [k, t] of row.times.entries()) {
      await seek(t);
      g.globalAlpha = 1; g.drawImage(el, k * tw, y + head, tw, th);
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(k * tw, y + head, 58, 18);
      g.fillStyle = '#fff'; g.font = '13px sans-serif'; g.fillText(`${t.toFixed(1)} s`, k * tw + 5, y + head + 14);
      if (onion) { g.globalAlpha = 1 / (k + 1); g.drawImage(el, (cols - 1) * tw, y + head, tw, th); } // running mean
    }
    g.globalAlpha = 1;
    if (onion) { g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect((cols - 1) * tw, y + head, 70, 18); g.fillStyle = '#fff'; g.fillText('叠加', (cols - 1) * tw + 5, y + head + 14); }
  }
  URL.revokeObjectURL(el.src);
  return { png: c.toDataURL('image/png'), width: c.width, height: c.height };
};
w.__ready = true;
