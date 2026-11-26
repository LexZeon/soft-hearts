// E1 eye-head screenshots (docs/claude/2026-11-14-eye-head-fix.md): the bundled Gene in her Unbound body, the same scenes as
// tests/helpers/eye-head-scenes.ts, stepped at a fixed 60 fps (no animation frames: the run is the same every time), then drawn
// once at the chosen frame from the viewer's eye with a narrow lens on her face (what you would see, magnified).
import { PerspectiveCamera, Quaternion, SRGBColorSpace, Scene, Vector3, WebGLRenderer } from 'three';
import { addStageLights } from '../../src/stage/model-loading';
import { UNITS_PER_M, UnboundFigure, loadClip, loadModel } from '../../src/unbound/figure';
import { Director } from '../../src/unbound/director/director';
import { PEEK_LENS } from '../../src/unbound/director/peek-lens';
import { ProceduralGenerator } from '../../src/unbound/motion/procedural';
import { lensView, type LensView } from '../../src/unbound/motion/lens-align';
import { eyeHeightFor, eyePosition, windowFrustum, type DisplayFacts, type WorldView } from '../../shared/unbound/world';
import { planPeek, type MoodReading } from '../../shared/unbound/director';

type SceneName = 'edge' | 'walk' | 'peek-back' | 'peek-hold';
interface Config { scene: SceneName; model: string; stand: string; frame?: number }
interface Result { scene: SceneName; frame: number; t: number; phase: string | null; eyes: { yaw: number; pitch: number }[]; faceDeg: number; heading: number }
declare global { interface Window { __run: () => Promise<Result> } }

const FPS = 60;
const LAPTOP: DisplayFacts = { bounds: { x: 0, y: 0, width: 2560, height: 1600 }, workArea: { x: 0, y: 0, width: 2560, height: 1520 }, scaleFactor: 1.5, internal: true };
const screenFacts = { widthM: 0.34, heightM: 0.2125, source: 'measured' as const, detail: 'test' };
const view: WorldView = { screen: screenFacts, display: LAPTOP.bounds, viewerDistanceM: 0.55, eyeHeightM: eyeHeightFor(screenFacts, LAPTOP, 0.55) };
const lens: LensView = lensView(eyePosition(view), windowFrustum(view, LAPTOP.workArea, 0.05, 400));
const CURIOUS: MoodReading = { D: 75, O: 62, E: 55, N: 50, C: 45, A: 0.2, B: 40, M: 10 };
const config = JSON.parse(new URLSearchParams(location.search).get('config') ?? '{}') as Config;

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = SRGBColorSpace;
renderer.setClearColor(0xf2eee8, 1);
renderer.setSize(innerWidth, innerHeight, false);
document.body.append(renderer.domElement);
const scene = new Scene();
addStageLights(scene);

const DEG = 180 / Math.PI;
const eyesOf = (figure: UnboundFigure) => figure.eyeInHead();

async function makeFigure(xM: number, depthM: number) {
  const { mesh, textures } = await loadModel(config.model);
  const figure = new UnboundFigure(mesh, { xM, depthM });
  figure.setClips({ pose: await loadClip(config.stand, mesh), gesture: null, expression: null }, false);
  figure.setBreath(0.5);
  await Promise.race([textures, new Promise(resolve => setTimeout(resolve, 8_000))]);
  scene.add(mesh);
  return figure;
}

/** How far her face is turned from you (degrees): her head's forward against the line from her head to your eye. */
function faceAngle(figure: UnboundFigure): number {
  const head = figure.head!, at = head.getWorldPosition(new Vector3()), eye = eyePosition(view);
  const toYou = new Vector3(eye.x * UNITS_PER_M, eye.y * UNITS_PER_M, eye.z * UNITS_PER_M).sub(at).normalize();
  const forward = new Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
  return forward.angleTo(toYou) * DEG;
}

/** Steps a scene; `pick` sees each frame and returns true at the one to draw (or null to keep going). */
async function simulate(pick: (frame: number, t: number, phase: string | null, figure: UnboundFigure) => boolean): Promise<Result | null> {
  const scene_ = config.scene;
  const start = scene_ === 'edge' ? { x: 0.25, d: 0.2 } : scene_ === 'walk' ? { x: 0.2, d: 1 } : { x: 0.25, d: 3 };
  const figure = await makeFigure(start.x, start.d);
  const generator = new ProceduralGenerator();
  let r = 0.37;
  const random = () => { r = (r * 9301 + 49297) % 233280 / 233280; return r; };
  const plan = planPeek(CURIOUS, random);
  const director = new Director([PEEK_LENS], generator, () => {});
  if (scene_ === 'walk') figure.faceToward({ x: 0, z: 0.55 });
  const seconds = scene_ === 'edge' ? 9 : scene_ === 'walk' ? 22 : 34;
  try {
    for (let frame = 0; frame <= FPS * seconds; frame++) {
      const t = frame / FPS, dt = frame ? 1 / FPS : 0;
      let phase: string | null = null;
      if (scene_ === 'edge') {
        const place = { x: t < 3 ? 0.25 : 0.6, z: -0.2 };
        if (figure.sense) figure.setPoseTargets(generator.generate({ intent: { kind: 'walk', lens, place, speedMps: 0.5 }, t, dt, sense: figure.sense }));
        phase = t < 3 ? 'edge-laptop' : 'edge-wide';
      } else if (scene_ === 'walk') {
        if (frame === FPS) figure.place({ xM: -0.4, depthM: 4 });
        if (frame === FPS * 12) figure.place({ xM: 0.2, depthM: 1 });
        phase = t < 12 ? 'away' : 'return';
      } else {
        if (frame === 30) director.command({ type: 'start', id: 'eye-shot', plan, trial: false, armAfterMs: 0 }, { lens, home: { x: 0.25, z: -3 } });
        director.frame(dt, { lens, home: { x: 0.25, z: -3 } }, figure);
        phase = director.phase;
      }
      figure.frame(dt);
      if (pick(frame, t, phase, figure)) {
        const result: Result = { scene: scene_, frame, t, phase, eyes: eyesOf(figure), faceDeg: faceAngle(figure), heading: figure.heading * DEG };
        // Your eye, a narrow lens on her face (about 30 cm of her fills the picture).
        const head = figure.head!.getWorldPosition(new Vector3()), eye = eyePosition(view);
        head.y += 0.06 * UNITS_PER_M;
        const camera = new PerspectiveCamera(30, innerWidth / innerHeight, 0.002 * UNITS_PER_M, 100 * UNITS_PER_M);
        camera.position.set(eye.x * UNITS_PER_M, eye.y * UNITS_PER_M, eye.z * UNITS_PER_M);
        const distance = camera.position.distanceTo(head);
        camera.fov = 2 * Math.atan(0.16 * UNITS_PER_M / distance) * DEG;
        camera.updateProjectionMatrix();
        camera.lookAt(head);
        renderer.render(scene, camera);
        return result;
      }
    }
    return null;
  } finally { /* the window is closed after the capture */ }
}

window.__run = async () => {
  if (config.frame !== undefined) {
    const result = await simulate(frame => frame === config.frame);
    if (!result) throw new Error('frame not reached');
    return result;
  }
  // First pass: the worst frame of the scene with her face not turned away from you (within 110°: a profile counts); the second pass draws it.
  let best = { frame: -1, score: -1 };
  const holdAt = { start: -1 };
  await simulate((frame, t, phase, figure) => {
    const yaw = Math.max(...eyesOf(figure).map(e => Math.abs(e.yaw)));
    if (config.scene === 'edge') { if (Math.abs(t - 8) < 0.5 / FPS) best = { frame, score: yaw }; return false; }
    if (config.scene === 'peek-hold') { if (phase === 'hold' && holdAt.start < 0) holdAt.start = frame; if (holdAt.start >= 0 && frame === holdAt.start + 90) best = { frame, score: yaw }; return false; }
    const inScene = config.scene === 'walk' ? t > 1 && t < 12 : phase === 'back' || phase === 'settle';
    if (inScene && faceAngle(figure) < 110 && yaw > best.score + 0.01) best = { frame, score: yaw };
    return false;
  });
  for (const mesh of [...scene.children]) if ((mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh) scene.remove(mesh);
  const result = await simulate(frame => frame === best.frame);
  if (!result) throw new Error('no frame picked');
  return result;
};
