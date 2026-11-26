/**
 * Unbound U4 preview page (docs/claude/2026-11-14-unbound-night-e4-surfaces.md): her body (UnboundFigure, the same code as Unbound),
 * the screen camera in 'fit' mapping (the whole 1920x1080 display scaled into a 960x540 canvas), and SYNTHETIC windows: boards
 * drawn beneath the canvas, with the canvas clipped to the glass that no window covers (that is how the real Unbound canvas, which is
 * above every window, would hide her behind them). The preview's main script drives it through window.__u4. No real window is read.
 */
import { PerspectiveCamera, SRGBColorSpace, Scene, Vector3, WebGLRenderer } from 'three';
import { addStageLights } from '../../src/stage/model-loading';
import { applyWorldCamera } from '../../src/unbound/camera';
import { UNITS_PER_M, UnboundFigure, loadClip, loadModel } from '../../src/unbound/figure';
import { surfaceTargets } from '../../src/unbound/surfaces/targets';
import { eyeHeightFor, placementAcross, projectToDip, DEFAULT_VIEWER_DISTANCE_M, type DisplayFacts, type Placement, type WorldView } from '../../shared/unbound/world';
import type { UnboundWorld } from '../../shared/unbound/scene';
import { maskRects } from '../../shared/unbound/surfaces/geometry';
import { occlusion } from '../../shared/unbound/surfaces/body';
import { planBetween, planLeanOn, planPeek, type PlanBase } from '../../shared/unbound/surfaces/plan';
import { sanitizeWindows, SyntheticWindowSource, type SurfaceWindow } from '../../shared/unbound/surfaces/windows';

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
const SCALE = 0.5; // DIP → preview pixels
const facts: DisplayFacts = { bounds: DISPLAY, workArea: { ...DISPLAY, height: 1040 }, scaleFactor: 1, internal: true };
const screen = { widthM: 0.34, heightM: 0.34 * 1080 / 1920, source: 'measured' as const, detail: 'preview' };
const viewerDistanceM = DEFAULT_VIEWER_DISTANCE_M;
const eyeHeightM = eyeHeightFor(screen, facts, viewerDistanceM);
const view: WorldView = { screen, display: DISPLAY, viewerDistanceM, eyeHeightM };
const world: UnboundWorld = { screen, display: DISPLAY, workArea: facts.workArea, window: DISPLAY, mapping: 'fit', viewerDistanceM, eyeHeightM, placement: placementAcross(view, 0.78, 8) };

const stage = document.getElementById('stage')!;
const boards = document.getElementById('boards')!;
const caption = document.getElementById('caption')!;
const marks = document.getElementById('marks')!;
const renderer = new WebGLRenderer({ alpha: true, antialias: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
renderer.setSize(960, 540, false);
renderer.domElement.id = 'canvas';
stage.append(renderer.domElement);
const scene = new Scene();
addStageLights(scene);
const camera = new PerspectiveCamera();
const frustum = applyWorldCamera(camera, world);
void frustum;
let figure: UnboundFigure | null = null;
let into = 0, intoTarget = 0, intoRate = 0.5; // per second
let current: (PlanBase & { kind: 'peek' | 'lean' | 'between' }) | null = null;
let lastFrame = 0;
let source = new SyntheticWindowSource([]);

function tick(now: number): void {
  requestAnimationFrame(tick);
  const raw = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  const delta = Math.min(0.1, Math.max(0, raw));
  if (figure) {
    if (into !== intoTarget) { const step = intoRate * delta; into = intoTarget > into ? Math.min(intoTarget, into + step) : Math.max(intoTarget, into - step); }
    if (current) figure.setPoseTargets(surfaceTargets(current, into));
    figure.frame(delta, raw);
  }
  renderer.render(scene, camera);
}

const her = () => ({ placement: figure!.placement as Placement, heightM: figure!.heightM });
const px = (r: { x: number; y: number; width: number; height: number }) => ({ left: r.x * SCALE, top: r.y * SCALE, width: r.width * SCALE, height: r.height * SCALE });
const COLORS = ['#cfe3f7', '#f7e6cf', '#d9f0d4', '#eadcf5'];

function drawWindows(windows: readonly SurfaceWindow[]): void {
  boards.replaceChildren();
  windows.forEach((w, i) => {
    const el = document.createElement('div'), r = px(w.rect);
    el.className = 'board'; el.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:${w.z};background:${COLORS[i % COLORS.length]}`;
    const bar = document.createElement('div'); bar.className = 'bar'; bar.textContent = `窗口 ${w.id}（合成）`;
    el.append(bar); boards.append(el);
  });
  // The canvas shows only where no window is.
  const hole = maskRects(windows.map(w => w.rect));
  const path = `M0 0H960V540H0Z ${hole.map(p => { const r = px(p); return `M${r.left} ${r.top}h${r.width}v${r.height}h${-r.width}Z`; }).join(' ')}`;
  renderer.domElement.style.clipPath = `path(evenodd, '${path}')`;
}
function drawMarks(plan: (PlanBase & { kind: string; edge?: { side: string; at: number; span: readonly [number, number] } }) | null): void {
  marks.replaceChildren();
  if (!plan) return;
  const dot = (x: number, y: number, color: string, size = 8) => { const d = document.createElement('div'); d.className = 'dot'; d.style.cssText = `left:${x * SCALE - size / 2}px;top:${y * SCALE - size / 2}px;width:${size}px;height:${size}px;background:${color}`; marks.append(d); };
  const head = projectToDip(view, plan.head);
  if (head) dot(head.x, head.y, '#e0245e'); // planned head centre
  if (plan.edge) {
    const line = document.createElement('div'); line.className = 'edge';
    const [a, b] = plan.edge.span;
    line.style.cssText = plan.edge.side === 'top' ? `left:${a * SCALE}px;top:${plan.edge.at * SCALE}px;width:${(b - a) * SCALE}px;height:2px` : `left:${plan.edge.at * SCALE}px;top:${a * SCALE}px;width:2px;height:${(b - a) * SCALE}px`;
    marks.append(line);
  }
}
function setCaption(text: string): void { caption.textContent = text; }

const measure = () => {
  if (!figure) return null;
  const sense = figure.sense, head = sense?.head ? projectToDip(view, sense.head) : null;
  const o = occlusion(view, source.read(), { placement: figure.placement, heightM: figure.heightM }, { leanRad: 0, riseM: 0 });
  return { place: figure.placement, head: head ? { x: head.x, y: head.y } : null, moving: figure.moving, intentIdle: figure.intentIdle, into,
    uprightHidden: o ? Object.fromEntries(o.parts.map(p => [p.name, +p.hidden.toFixed(3)])) : null };
};

const api = {
  async init(urls: { model: string; stand: string }, startAcross: number, depthM: number) {
    const { mesh, textures } = await loadModel(urls.model);
    const start = placementAcross(view, startAcross, depthM);
    const next = new UnboundFigure(mesh, start);
    next.setBreath(0.5);
    next.setClips({ pose: await loadClip(urls.stand, mesh), gesture: null, expression: null }, false);
    next.faceToward({ x: 0, z: viewerDistanceM });
    await Promise.race([textures, new Promise(resolve => setTimeout(resolve, 8_000))]);
    figure = next; scene.add(mesh); next.frame(0); renderer.render(scene, camera);
    requestAnimationFrame(tick);
    return { heightM: next.heightM, eyeHeightM, unitsPerM: UNITS_PER_M, display: DISPLAY, screen };
  },
  /** Sets the synthetic layout (through the source interface and its sanitizer, like a real source would). */
  layout(windows: SurfaceWindow[]) { source = new SyntheticWindowSource(windows); drawWindows(sanitizeWindows(source.read(), DISPLAY)); },
  /** Leaves her where she is, upright, with no surface plan. */
  rest() { current = null; into = 0; intoTarget = 0; figure?.clearPoseTargets(); drawMarks(null); },
  walkTo(placement: Placement) { current = null; figure?.place(placement); },
  caption: setCaption,
  plan(kind: 'peek' | 'lean' | 'between', options: Record<string, unknown> = {}) {
    if (!figure) return null;
    const windows = sanitizeWindows(source.read(), DISPLAY);
    const p = kind === 'peek' ? planPeek(view, windows, her(), options) : kind === 'lean' ? planLeanOn(view, windows, her(), options) : planBetween(view, windows, her(), options);
    return p;
  },
  /** Take the plan: she walks to its place (into = 0), then `intoTarget` 1 leans her into the pose over 1 / rate seconds. */
  take(plan: PlanBase & { kind: 'peek' | 'lean' | 'between' }, target: number, rate = 0.6) {
    current = plan; intoTarget = target; intoRate = rate; drawMarks(plan as never);
  },
  measure,
  /** The same boards without her (for the screenshot of the bare layout). */
  hideHer(hidden: boolean) { renderer.domElement.style.visibility = hidden ? 'hidden' : 'visible'; },
  /** The planned head point against the head she actually has, display DIP. */
  headError(plan: PlanBase) {
    const m = measure(), planned = projectToDip(view, plan.head);
    return m?.head && planned ? { planned: { x: planned.x, y: planned.y }, actual: m.head, dxDip: m.head.x - planned.x, dyDip: m.head.y - planned.y } : null;
  },
  /** Her bounding box on the display now, upright (DIP): the preview places its windows relative to it. */
  box: () => (figure ? occlusion(view, [], her(), { leanRad: 0, riseM: 0 })?.box ?? null : null),
  vec: () => new Vector3().toArray(),
};
(window as unknown as { __u4: typeof api }).__u4 = api;
