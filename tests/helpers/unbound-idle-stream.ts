// Unbound's bundled idle (docs/claude/2026-11-14-staystill-idle.md「接进 Unbound」) in Gene's real Unbound frame loop, measured as it
// streams (no per-frame history kept, so a 30-minute run fits in memory): the unexpected step of the upper body (R29c/R29d), the root's
// and the ankles' unexpected steps, planted-foot drift, steps, the centre of mass to the support edge, the head's deviation from where
// it stood after the warm-up, the idle's head-chain channels, NaN and the heap. The layer (src/unbound/motion/unbound-idle.ts) sits
// exactly where the Unbound page has it: after the "director" (here a script), before her frame.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Quaternion, Vector3 } from 'three';
import { UNITS_PER_M } from '../../src/unbound/figure';
import { UnboundIdleLayer } from '../../src/unbound/motion/unbound-idle';
import { UNBOUND_IDLE_MODEL, createBundledIdle, loadBundledIdle, type BundledIdle } from '../../src/unbound/motion/bundled-idle';
import type { PoseTargets } from '../../src/unbound/motion/generator';
import { geneFigure, TRACKED } from './unbound-gene';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The built page's URL inside this checkout (the loader resolves assets/bundled/ from it, as in the app). */
export const BUILT_PAGE = new URL(`file:///${ROOT.replace(/\\/g, '/')}/dist/src/unbound/index.html`).href;
/** Reads the checkout's files for the loader (the page's XMLHttpRequest stands in). */
export const readLocal = async (url: string) => { const b = await readFile(fileURLToPath(url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
let shipped: Promise<BundledIdle | null> | null = null;
/** The shipped model, read through the same loader the page uses. */
export const shippedIdle = () => (shipped ??= loadBundledIdle(BUILT_PAGE, readLocal));

const DEG = 180 / Math.PI;
const UPPER = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => !/足|ひざ/.test(name)).map(([, i]) => i);
const HEAD = TRACKED.indexOf('頭');

export interface IdleStreamOptions {
  fps: number;
  seconds: number;
  /** null: no files (the procedural fallback). Default: the shipped model. */
  bundled?: BundledIdle | null;
  seed?: number;
  /** Seconds not measured at the start (the first settling). Default 2. */
  warmS?: number;
  /** Per frame, before the layer: whether the idle is wanted (default true), and targets a "director" hands in (undefined: none this frame). */
  script?: (t: number) => { wanted?: boolean; owner?: PoseTargets };
  /** Called once a simulated minute (for a progress line). */
  onMinute?: (minute: number, partial: IdleStreamResult) => void;
}

export interface IdleStreamResult {
  fps: number; seconds: number; source: string | null;
  /** Upper-body unexpected step (deg): p95, max, and the max per minute (to see accumulation). */
  jolt: { p95: number; max: number; perMinuteMax: number[] };
  rootSurpriseMaxCm: number; ankleSurpriseMaxCm: number;
  footDriftCm: { ankle: number; toe: number }; rootFromStartCm: number; steps: number;
  comMinMarginCm: number;
  /** The idle's channels on the frame the margin was smallest (to see what took her there), and that frame's time (s). */
  comMinAt: { t: number; channels: number[] } | null;
  /** Head deviation from its pose after the warm-up (deg): p95 overall, max, p95 per minute. */
  head: { p95: number; max: number; perMinuteP95: number[] };
  /** The idle's head chain (torso + neck + head yaw, deg) as handed to the body: largest |value| and mean per minute. */
  chainYaw: { maxAbs: number; perMinuteMean: number[] };
  /** Each idle channel's largest |value| as handed to the body (rad; the pelvis per meter of height). */
  channelMaxAbs: number[];
  weight: { min: number; max: number };
  nonFinite: number;
  heapMb: { start: number; end: number; max: number };
  msPerFrame: number;
}

/** Fixed-size histogram for p95 over very long runs (0.01° bins up to 180°). */
class Hist {
  private readonly bins: Uint32Array; n = 0; max = 0;
  constructor(private readonly step: number, top: number) { this.bins = new Uint32Array(Math.ceil(top / step) + 1); }
  add(v: number): void { this.n++; if (v > this.max) this.max = v; this.bins[Math.min(this.bins.length - 1, Math.max(0, Math.floor(v / this.step)))]++; }
  p(q: number): number { let k = Math.ceil(q * this.n); for (let i = 0; i < this.bins.length; i++) { k -= this.bins[i]; if (k <= 0) return (i + 1) * this.step; } return this.max; }
}

export async function runIdleStream(options: IdleStreamOptions): Promise<IdleStreamResult> {
  const { fps, seconds } = options, warm = Math.round((options.warmS ?? 2) * fps);
  const bundled = options.bundled === undefined ? await shippedIdle() : options.bundled;
  const { fixture, figure } = await geneFigure();
  const layer = new UnboundIdleLayer(async h => createBundledIdle(h, bundled, options.seed ?? 7));
  layer.attach(figure, figure.heightM);
  await new Promise(resolve => setImmediate(resolve)); // the idle is built (the page waits the same way, a frame or two)
  const director = layer.wrap(figure);
  const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
  const m = 1 / UNITS_PER_M;
  const rot = [bones.map(() => new Quaternion()), bones.map(() => new Quaternion()), bones.map(() => new Quaternion())];
  const step = new Quaternion(), last = new Quaternion(), inv = new Quaternion();
  const root = [new Vector3(), new Vector3(), new Vector3()];
  const ankles = [[new Vector3(), new Vector3()], [new Vector3(), new Vector3()], [new Vector3(), new Vector3()]];
  const jolt = new Hist(0.0005, 30), headHist = new Hist(0.01, 180);
  let joltMinute = 0, headMinute = new Hist(0.01, 180), chainSum = 0, chainN = 0;
  const out: IdleStreamResult = { fps, seconds, source: null, jolt: { p95: 0, max: 0, perMinuteMax: [] }, rootSurpriseMaxCm: 0, ankleSurpriseMaxCm: 0,
    footDriftCm: { ankle: 0, toe: 0 }, rootFromStartCm: 0, steps: 0, comMinMarginCm: Infinity, comMinAt: null, head: { p95: 0, max: 0, perMinuteP95: [] },
    chainYaw: { maxAbs: 0, perMinuteMean: [] }, channelMaxAbs: [], weight: { min: Infinity, max: -Infinity }, nonFinite: 0, heapMb: { start: 0, end: 0, max: 0 }, msPerFrame: 0 };
  const heap = () => process.memoryUsage().heapUsed / 2 ** 20;
  out.heapMb.start = out.heapMb.max = heap();
  const headRef = new Quaternion(), rootStart = new Vector3(), q = new Quaternion();
  const anchors: { ankle: Vector3 | null; toe: Vector3 | null }[] = [{ ankle: null, toe: null }, { ankle: null, toe: null }];
  let stepsAtWarm = 0, restAnkleY = 0;
  const frames = Math.round(fps * seconds), began = performance.now();
  try {
    for (let frame = 0; frame <= frames; frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      const cue = options.script?.(t) ?? {};
      if (cue.owner) director.setPoseTargets(cue.owner);
      layer.frame(dt, cue.wanted ?? true);
      figure.frame(dt);
      const report = figure.report!;
      // Three frames kept: [0] this one, [1] the one before, [2] the one before that (the oldest buffer is reused for this one).
      const recycle = <T>(ring: T[]) => { const oldest = ring[2]; ring[2] = ring[1]; ring[1] = ring[0]; ring[0] = oldest; return oldest; };
      const r0 = recycle(rot), p0 = recycle(root), a0 = recycle(ankles);
      bones.forEach((b, i) => b.getWorldQuaternion(r0[i]));
      p0.copy(fixture.mesh.position).multiplyScalar(m);
      report.feet.forEach((f, k) => a0[k].copy(f.ankle).multiplyScalar(m));
      for (const v of r0) if (![v.x, v.y, v.z, v.w].every(Number.isFinite)) out.nonFinite++;
      if (frame === 0) restAnkleY = (a0[0].y + a0[1].y) / 2;
      if (frame === warm) { headRef.copy(r0[HEAD]); rootStart.copy(p0); stepsAtWarm = report.steps; }
      out.weight.min = Math.min(out.weight.min, layer.weight); out.weight.max = Math.max(out.weight.max, layer.weight);
      if (frame < warm) continue;
      // Unexpected step: this frame's rotation step against the previous one (R29c), the upper body.
      if (frame >= warm + 2) for (const b of UPPER) {
        step.copy(r0[b]).multiply(inv.copy(rot[1][b]).invert());
        last.copy(rot[1][b]).multiply(inv.copy(rot[2][b]).invert());
        const v = step.angleTo(last) * DEG;
        jolt.add(v); if (v > joltMinute) joltMinute = v;
      }
      if (frame >= warm + 2) {
        out.rootSurpriseMaxCm = Math.max(out.rootSurpriseMaxCm, p0.clone().sub(root[1]).sub(root[1].clone().sub(root[2])).length() * 100);
        for (let k = 0; k < 2; k++) out.ankleSurpriseMaxCm = Math.max(out.ankleSurpriseMaxCm, a0[k].clone().sub(ankles[1][k]).sub(ankles[1][k].clone().sub(ankles[2][k])).length() * 100);
      }
      report.feet.forEach((foot, k) => {
        const anchor = anchors[k];
        if (!foot.planted) { anchor.ankle = anchor.toe = null; return; }
        if (foot.toe) { const toe = foot.toe.clone().multiplyScalar(m); anchor.toe ??= toe; out.footDriftCm.toe = Math.max(out.footDriftCm.toe, toe.distanceTo(anchor.toe) * 100); }
        if (foot.pitch > 0) { anchor.ankle = null; return; }
        anchor.ankle ??= a0[k].clone();
        out.footDriftCm.ankle = Math.max(out.footDriftCm.ankle, a0[k].distanceTo(anchor.ankle) * 100);
      });
      out.rootFromStartCm = Math.max(out.rootFromStartCm, p0.distanceTo(rootStart) * 100);
      if (report.comMargin !== null && report.comMargin * 100 < out.comMinMarginCm) { out.comMinMarginCm = report.comMargin * 100; out.comMinAt = { t, channels: Array.from(layer.channels ?? []) }; }
      const head = q.copy(r0[HEAD]).angleTo(headRef) * DEG;
      headHist.add(head); headMinute.add(head);
      const sample = layer.channels;
      if (sample) sample.forEach((v, c) => { out.channelMaxAbs[c] = Math.max(out.channelMaxAbs[c] ?? 0, Math.abs(v)); });
      if (sample) { const yaw = (sample[4] + sample[7] + sample[10]) * DEG; chainSum += yaw; chainN++; out.chainYaw.maxAbs = Math.max(out.chainYaw.maxAbs, Math.abs(yaw)); if (!Number.isFinite(yaw)) out.nonFinite++; }
      if ((frame - warm) % (60 * fps) === 0 && frame > warm) {
        out.jolt.perMinuteMax.push(+joltMinute.toFixed(4)); joltMinute = 0;
        out.head.perMinuteP95.push(+headMinute.p(0.95).toFixed(2)); headMinute = new Hist(0.01, 180);
        out.chainYaw.perMinuteMean.push(+(chainSum / Math.max(1, chainN)).toFixed(2)); chainSum = 0; chainN = 0;
        const h = heap(); out.heapMb.max = Math.max(out.heapMb.max, h);
        options.onMinute?.(out.jolt.perMinuteMax.length, out);
      }
    }
    void restAnkleY;
    out.source = layer.source;
    out.steps = figure.report!.steps - stepsAtWarm;
    out.jolt.p95 = +jolt.p(0.95).toFixed(4); out.jolt.max = +jolt.max.toFixed(4);
    out.head.p95 = +headHist.p(0.95).toFixed(2); out.head.max = +headHist.max.toFixed(2);
    out.heapMb.end = heap(); out.heapMb.max = Math.max(out.heapMb.max, out.heapMb.end);
    out.msPerFrame = (performance.now() - began) / (frames + 1);
    return out;
  } finally { figure.dispose(); fixture.close(); }
}

export { UNBOUND_IDLE_MODEL };
