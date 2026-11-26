// Motion-model spike (docs/claude/2026-11-14-motion-model-spike.md, round 2): the idle sources and two references, each as
// layer-2 targets through Gene's real Unbound frame loop (MMDLoader, CCD IK, gait and contact owner, intent-layer springs, the
// round-2 hip and arm residuals; tests/helpers/unbound-gene.ts), at 60 and 30 fps.
//   rest       nothing added (Unbound today)
//   people     the 20 curated idle takes, as recorded (held out of training): the human reference
//   procedural / matching (over the round-2 training set) / model (round 2, calibrated) / model+events (the quick-move layer)
// Measures the noise floor, the unexpected step, the centre of mass, foot slide, how much and how fast the head, chest and arms
// move, how often the head holds still, and the channels' own spread against the people's; plus latency, parity and diversity.
//   node scripts/dev/heavy.mjs --label "idle compare" -- node node_modules/tsx/dist/cli.mjs scripts/ml/idle-compare.ts [--seconds 60] [--activity 0.5]
// Needs the files under .local/ml/ (idle-data.ts). Writes JSON to .local/unbound-night/motion-model/.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Quaternion } from 'three';
import { runGene, surpriseAngles, stepAngles, rootSurprises, ankleSurprises, plantedDrift, TRACKED, type Shown } from '../../tests/helpers/unbound-gene';
import { IdleGenerator, IDLE_CHANNELS, IDLE_DIM, type ContinuousIdleSource, type IdleSource } from '../../src/unbound/motion/idle-channels';
import { ProceduralIdle } from '../../src/unbound/motion/idle-procedural';
import { MatchingIdle } from '../../src/unbound/motion/idle-matching';
import { IdleModel, ModelIdle } from '../../src/unbound/motion/idle-model';
import { IdleEvents } from '../../src/unbound/motion/idle-events';
import { REST_TARGETS, type BodySense } from '../../src/unbound/motion/generator';
import { loadIdleDatabase, loadIdleEvents, loadIdleModel, mlRoot } from './idle-data';
import { firstExceed, headOnChest, pauseRuns, yawRates } from './idle-measures';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const SECONDS = Number(opt('--seconds', '60'));
const ACTIVITY = Number(opt('--activity', '0.5'));
const EVENT_RATE = Number(opt('--event-rate', '9'));
const LEASH_S = Number(opt('--leash', '12'));
const ONLY = opt('--groups', '') ? opt('--groups', '').split(',') : null;
const FPS = opt('--fps', '60,30').split(',').map(Number);
const MODEL_FILE = opt('--model', path.join(mlRoot(), 'out2', 'idle-vae.json'));
// StayStill round (docs/claude/2026-11-14-staystill-idle.md): a second model and event library, and a choice of human reference
// (default: the 100STYLE curated takes as before; e.g. --people work-ss-test for StayStill's held-out test subjects).
const SS_MODEL_FILE = opt('--ss-model', '');
const SS_EVENTS_DIR = opt('--ss-events', '');
const SS_EVENT_RATE = Number(opt('--ss-event-rate', '1'));
const PEOPLE_DIR = opt('--people', 'work2-curated');
const TAG = opt('--tag', '');
const OUT = path.resolve(mlRoot(), '..', 'unbound-night', 'motion-model');
mkdirSync(OUT, { recursive: true });

const db = loadIdleDatabase();
const people = loadIdleDatabase(path.isAbsolute(PEOPLE_DIR) ? PEOPLE_DIR : path.join(mlRoot(), PEOPLE_DIR));
const events = loadIdleEvents();
const weights = loadIdleModel(MODEL_FILE);
const model = new IdleModel(weights);
const ssModel = SS_MODEL_FILE ? new IdleModel(loadIdleModel(SS_MODEL_FILE)) : null;
const ssEvents = SS_EVENTS_DIR ? loadIdleEvents(SS_EVENTS_DIR) : null;
const GROUPS = ['rest', 'people', 'procedural', 'matching', 'model', 'model+events', 'model-raw', 'model-raw+events', 'ss-model', 'ss-model+events', 'ss-model-raw', 'ss-model-raw+events'] as const;
type Group = (typeof GROUPS)[number];
const LATENCY_GROUPS: Group[] = ['procedural', 'matching', 'model', 'model+events', 'model-raw+events', ...(ssModel ? ['ss-model' as const] : []), ...(ssModel ? ['ss-model-raw' as const] : []), ...(ssModel && ssEvents ? ['ss-model+events' as const, 'ss-model-raw+events' as const] : [])];
/**
 * The people, all of them: every curated standing stretch once, in order, as recorded. At each join the difference between the
 * end of one stretch and the start of the next (value and velocity) dies away like matching's inertialization (half-life 0.25 s),
 * so no cut shows and nothing is searched or generated.
 */
class PeopleInOrder implements IdleSource {
  readonly id = 'people';
  private i = 0;
  private readonly offset = new Float64Array(IDLE_DIM);
  private readonly offsetVelocity = new Float64Array(IDLE_DIM);
  private readonly prev = new Float64Array(IDLE_DIM);
  private readonly prevVelocity = new Float64Array(IDLE_DIM);
  private readonly out = new Float32Array(IDLE_DIM);
  private readonly starts = new Set(people.segments.map(s => s.start));
  reset(): void { this.i = 0; this.offset.fill(0); this.offsetVelocity.fill(0); }
  next(): Float32Array {
    const f = people.frames, n = people.activity.length, i = this.i % n, w = 2 * Math.LN2 / 0.25, dt = 1 / 30, e = Math.exp(-w * dt);
    if (this.i > 0 && this.starts.has(i)) for (let c = 0; c < IDLE_DIM; c++) {
      // The next shown value should continue the last one; the decay below is applied once before it shows (close enough here).
      this.offset[c] = this.prev[c] + this.prevVelocity[c] * dt - f[i * IDLE_DIM + c];
      this.offsetVelocity[c] = this.prevVelocity[c] - (f[(i + 1) * IDLE_DIM + c] - f[i * IDLE_DIM + c]) * 30;
    }
    for (let c = 0; c < IDLE_DIM; c++) {
      const j = this.offsetVelocity[c] + w * this.offset[c];
      this.offset[c] = e * (this.offset[c] + j * dt);
      this.offsetVelocity[c] = e * (this.offsetVelocity[c] - j * w * dt);
      const v = f[i * IDLE_DIM + c] + this.offset[c];
      this.prevVelocity[c] = (v - this.prev[c]) * 30; this.prev[c] = v; this.out[c] = v;
    }
    this.i++;
    return this.out;
  }
}
const PEOPLE_SECONDS = Math.floor(people.activity.length / 30);
const makeSource = (group: Group, seed: number): IdleSource | ContinuousIdleSource | null =>
  group === 'procedural' ? new ProceduralIdle(seed) : group === 'matching' ? new MatchingIdle(db, { seed }) : group === 'model' ? new ModelIdle(model, { seed, leashS: LEASH_S })
    : group === 'model+events' ? new IdleEvents(new ModelIdle(model, { seed, leashS: LEASH_S }), events, { seed: seed + 100, rateScale: EVENT_RATE })
    : group === 'model-raw' ? new ModelIdle(model, { seed, calibrated: false, leashS: LEASH_S })
    : group === 'model-raw+events' ? new IdleEvents(new ModelIdle(model, { seed, calibrated: false, leashS: LEASH_S }), events, { seed: seed + 100, rateScale: EVENT_RATE })
    : group === 'ss-model' ? (ssModel ? new ModelIdle(ssModel, { seed, leashS: LEASH_S }) : null)
    : group === 'ss-model-raw' ? (ssModel ? new ModelIdle(ssModel, { seed, calibrated: false, leashS: LEASH_S }) : null)
    : group === 'ss-model+events' ? (ssModel && ssEvents ? new IdleEvents(new ModelIdle(ssModel, { seed, leashS: LEASH_S }), ssEvents, { seed: seed + 100, rateScale: SS_EVENT_RATE }) : null)
    : group === 'ss-model-raw+events' ? (ssModel && ssEvents ? new IdleEvents(new ModelIdle(ssModel, { seed, calibrated: false, leashS: LEASH_S }), ssEvents, { seed: seed + 100, rateScale: SS_EVENT_RATE }) : null)
      : group === 'people' ? new PeopleInOrder() : null;

const DUMMY_SENSE = { root: { x: 0, z: 0, heading: 0 }, moving: false, eyes: { left: null, right: null }, head: null, frame: null, offsets: { lateral: 0, forward: 0, up: 0 }, eyeSizeM: null, tiptoeRise: 0 } as BodySense;
const UPPER = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => !/足|ひざ/.test(name)).map(([, i]) => i);
const HEAD = TRACKED.indexOf('頭'), CHEST = TRACKED.indexOf('上半身2'), ARMS = [TRACKED.indexOf('左腕'), TRACKED.indexOf('右腕')], ELBOWS = [TRACKED.indexOf('左ひじ'), TRACKED.indexOf('右ひじ')];
const pct = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : 0; };
const std = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length)); };
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const maxOf = (v: readonly number[]) => v.reduce((a, b) => (b > a ? b : a), -Infinity);
const minOf = (v: readonly number[]) => v.reduce((a, b) => (b < a ? b : a), Infinity);
/** Channel families (for the spread against the people). */
const FAMILIES: Record<string, number[]> = { pelvis: [0, 1, 2], torso: [3, 4, 5], neck: [6, 7, 8], head: [9, 10, 11], hips: [12, 13, 14], arms: [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26] };
// The people's typical spread: the median over their stretches of each stretch's own spread (a few fidgety takes do not set it).
const peopleStd = Array.from({ length: IDLE_DIM }, (_, c) => { const v = people.segments.map(s => std(Array.from({ length: s.length }, (_, i) => people.frames[(s.start + i) * IDLE_DIM + c]))).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; });

async function run(group: Group, fps: number, seed = 1) {
  let generator: IdleGenerator | null = null;
  const channels: number[][] = Array.from({ length: IDLE_DIM }, () => []);
  const sourceMs: number[] = [];
  const result = await runGene(fps, group === 'people' ? PEOPLE_SECONDS : SECONDS, (t, figure) => {
    if (!generator) return;
    const a = performance.now();
    const targets = generator.generate({ intent: { kind: 'idle', activity: ACTIVITY }, t, dt: t === 0 ? 0 : 1 / fps, sense: figure.sense ?? DUMMY_SENSE });
    sourceMs.push(performance.now() - a);
    figure.setPoseTargets(targets);
    for (let c = 0; c < IDLE_DIM; c++) channels[c].push(generator.last[c]);
  }, { setup: figure => {
    const source = makeSource(group, seed);
    generator = source ? new IdleGenerator(source, { heightM: figure.heightM }) : null;
    if (!generator) figure.setPoseTargets({ ...REST_TARGETS });
  } });
  const frames = result.frames, warm = Math.round(2 * fps), shown = frames.slice(warm);
  const surprise = surpriseAngles(frames, warm, UPPER);
  const angleFrom = (bone: number) => { const ref = shown[0].rotations[bone]; return shown.map(f => (f.rotations[bone] as Quaternion).angleTo(ref) * 180 / Math.PI); };
  const speedOf = (bone: number) => shown.slice(1).map((f, i) => (f.rotations[bone] as Quaternion).angleTo(shown[i].rotations[bone]) * 180 / Math.PI * fps);
  const com = shown.map(f => f.com).filter(Boolean) as { x: number; z: number }[];
  const margins = shown.map(f => f.comMargin).filter((m): m is number => m !== null);
  const restAnkleY = (frames[0].feet[0].ankle.y + frames[0].feet[1].ankle.y) / 2;
  const drift = plantedDrift(shown, restAnkleY);
  const src = sourceMs.slice(warm);
  const head = speedOf(HEAD), arm = ARMS.flatMap(speedOf);
  const ch = channels.map(v => v.slice(warm));
  return {
    group, fps, seed, heightM: result.heightM,
    noiseFloorDeg: { p50: r3(pct(surprise, 0.5)), p95: r3(pct(surprise, 0.95)), max: r3(maxOf(surprise)) },
    maxStepDeg: r3(maxOf(stepAngles(frames, warm).filter((_, i) => UPPER.includes(i % TRACKED.length)))),
    rootSurpriseMaxCm: r3(maxOf(rootSurprises(shown))), ankleSurpriseMaxCm: r3(maxOf(ankleSurprises(shown))),
    footDriftCm: { ankle: r3(drift.drift), toe: r3(drift.toeDrift), sink: r3(drift.sink) },
    steps: frames.at(-1)!.steps - frames[warm].steps,
    com: { lateralStdCm: r3(std(com.map(c => c.x)) * 100), forwardStdCm: r3(std(com.map(c => c.z)) * 100), minMarginCm: r3(minOf(margins) * 100) },
    body: {
      headP95Deg: r3(pct(angleFrom(HEAD), 0.95)), chestP95Deg: r3(pct(angleFrom(CHEST), 0.95)),
      armP95Deg: r3(pct(ARMS.flatMap(angleFrom), 0.95)), elbowP95Deg: r3(pct(ELBOWS.flatMap(angleFrom), 0.95)),
      headSpeed: { p50: r3(pct(head, 0.5)), p90: r3(pct(head, 0.9)), p95: r3(pct(head, 0.95)), p99: r3(pct(head, 0.99)) },
      headStillShare: r3(head.filter(v => v < 1).length / head.length),
      // Codex X-518: continuous pauses (≥ 0.3 s under 1°/s) and how the head's yaw follows the chest's.
      headPauses: (({ perMinute, medianS, share }) => ({ perMinute: r3(perMinute), medianS: r3(medianS), share: r3(share) }))(pauseRuns(head, fps, 1, 0.3)),
      headOnChestYaw: (({ slope, corr }) => ({ slope: r3(slope), corr: r3(corr) }))(headOnChest(yawRates(shown.map(f => f.rotations[HEAD] as Quaternion), fps), yawRates(shown.map(f => f.rotations[CHEST] as Quaternion), fps))),
      armSpeed: { p50: r3(pct(arm, 0.5)), p95: r3(pct(arm, 0.95)) },
    },
    // Codex X-518: the first visible motion, not the compute time: seconds from the idle's start (frame 0, before the warm-up is cut)
    // until the head is 0.5° / 1° away from where it was then (the rest group gives the body's own settling for comparison).
    firstVisibleS: (() => { const ref = frames[0].rotations[HEAD] as Quaternion, from = frames.map(f => (f.rotations[HEAD] as Quaternion).angleTo(ref) * 180 / Math.PI); return { head05: firstExceed(from, fps, 0.5), head1: firstExceed(from, fps, 1) }; })(),
    // The channels as handed to the body, against the people's own spread (1 = as much as the people).
    spreadVsPeople: Object.fromEntries(Object.entries(FAMILIES).map(([name, idx]) => [name, r3(idx.reduce((s, c) => s + std(ch[c]) / Math.max(1e-9, peopleStd[c]), 0) / idx.length)])),
    channelStd: Object.fromEntries(IDLE_CHANNELS.map((name, c) => [name, r3(std(ch[c]) * (c < 3 ? 1000 : 180 / Math.PI))])),
    sourceMsPerFrame: src.length ? { mean: r3(src.reduce((a, b) => a + b, 0) / src.length), p99: r3(pct(src, 0.99)), max: r3(maxOf(src)) } : null,
    frames: undefined as unknown as Shown[],
  };
}

/** Source latency outside the body: one 30 Hz frame of each source, many times. */
function latency() {
  const out: Record<string, { perFrameMs: number; perSecondMs: number; worstFrameMs: number }> = {};
  for (const group of LATENCY_GROUPS) {
    const source = makeSource(group, 3)!;
    const times: number[] = [];
    for (let i = 0; i < 30 * 120; i++) {
      const a = performance.now();
      if ('next' in source) source.next(ACTIVITY); else source.at(i / 30, ACTIVITY);
      times.push(performance.now() - a);
    }
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    out[group] = { perFrameMs: r3(mean), perSecondMs: r3(mean * 30), worstFrameMs: r3(maxOf(times.slice(30))) };
  }
  return out;
}

/** Two seeds of the same source and knob: how different (RMS of the head-yaw and torso-roll difference over their spread; √2 ≈ unrelated). */
function diversity() {
  const out: Record<string, number> = {};
  for (const group of LATENCY_GROUPS) {
    const series = [1, 2].map(seed => {
      const s = makeSource(group, seed)!, v: number[][] = [];
      for (let i = 0; i < 30 * 60; i++) v.push(Array.from('next' in s ? s.next(ACTIVITY) : s.at(i / 30, ACTIVITY)));
      return v;
    });
    let num = 0, den = 0;
    for (const c of [5, 10]) for (let i = 0; i < series[0].length; i++) { num += (series[0][i][c] - series[1][i][c]) ** 2; den += series[0][i][c] ** 2 + series[1][i][c] ** 2; }
    out[group] = r3(Math.sqrt(num / Math.max(1e-12, den / 2)));
  }
  return out;
}

const results: unknown[] = [];
type Body = Awaited<ReturnType<typeof run>>['body'];
/**
 * How far a group is from the people at the same frame rate, as one number (0 = the same): the mean |ln(group / people)| over the
 * head and chest offsets (p95), the head speed (p50, p90, p95) and the share of time the head holds still.
 */
const peopleBody = new Map<number, Body>();
function vsPeople(fps: number, b: Body): number | null {
  const p = peopleBody.get(fps);
  if (!p) return null;
  const pairs: [number, number][] = [[b.headP95Deg, p.headP95Deg], [b.chestP95Deg, p.chestP95Deg], [b.headSpeed.p50, p.headSpeed.p50], [b.headSpeed.p90, p.headSpeed.p90],
    [b.headSpeed.p95, p.headSpeed.p95], [b.headStillShare, p.headStillShare]];
  return r3(pairs.reduce((s, [x, y]) => s + Math.abs(Math.log(Math.max(1e-6, x) / Math.max(1e-6, y))), 0) / pairs.length);
}
for (const fps of FPS) for (const group of GROUPS.filter(g => (!ONLY || ONLY.includes(g) || g === 'people') && (!g.startsWith('ss-') || makeSource(g, 1) !== null))) {
  const r: Awaited<ReturnType<typeof run>> & { vsPeople?: number | null } = await run(group, fps);
  delete (r as { frames?: unknown }).frames;
  if (group === 'people') peopleBody.set(fps, r.body);
  r.vsPeople = vsPeople(fps, r.body);
  results.push(r);
  const b = r.body;
  console.log(`${String(fps).padStart(2)} fps ${group.padEnd(12)} vsPeople ${r.vsPeople} | jolt p95/max ${r.noiseFloorDeg.p95}/${r.noiseFloorDeg.max}° step ${r.maxStepDeg}° drift ${r.footDriftCm.ankle}/${r.footDriftCm.toe} steps ${r.steps} `
    + `COM ${r.com.lateralStdCm}/${r.com.forwardStdCm} margin ${r.com.minMarginCm} | head p95 ${b.headP95Deg}° chest ${b.chestP95Deg}° arm ${b.armP95Deg}° elbow ${b.elbowP95Deg}° `
    + `| first visible ${JSON.stringify(r.firstVisibleS)} | head speed ${b.headSpeed.p50}/${b.headSpeed.p90}/${b.headSpeed.p95}/${b.headSpeed.p99} still ${b.headStillShare} pauses ${JSON.stringify(b.headPauses)} head-on-chest ${JSON.stringify(b.headOnChestYaw)} arm speed ${b.armSpeed.p50}/${b.armSpeed.p95} | spread ${JSON.stringify(r.spreadVsPeople)}`);
}
const lat = latency(), div = diversity();
// The TypeScript decoder and prior against PyTorch's own output for the same inputs (the training script stores one).
const parity = weights.parity ? (() => {
  const p = weights.parity!, got = model.delta(p.z, p.history.flat(), p.activity);
  let worst = maxOf(p.out.map((v, i) => Math.abs(v - got[i])));
  if (p.priorMu && model.hasPrior) {
    const mu = new Float32Array(model.latent), lv = new Float32Array(model.latent);
    model.prior(p.history.flat(), p.activity, mu, lv);
    worst = Math.max(worst, ...p.priorMu.map((v, i) => Math.abs(v - mu[i])), ...p.priorLogvar!.map((v, i) => Math.abs(v - lv[i])));
  }
  return worst;
})() : null;
console.log('TS vs PyTorch (decoder and prior), largest difference', parity);
console.log('latency', JSON.stringify(lat));
console.log('diversity (seed 1 vs 2; √2 ≈ unrelated)', JSON.stringify(div));
const file = path.join(OUT, `compare2${TAG ? `-${TAG}` : ""}-a${ACTIVITY}-e${EVENT_RATE}-l${LEASH_S}${ONLY ? "-some" : ""}.json`);
writeFileSync(file, JSON.stringify({ round: 2, seconds: SECONDS, activity: ACTIVITY, model: path.basename(path.dirname(MODEL_FILE)), modelParameters: model.parameters, parityMaxDiff: parity,
  database: { frames: db.activity.length, segments: db.segments.length, seconds: db.meta.keptSeconds }, people: { frames: people.activity.length, segments: people.segments.length },
  events: { count: events.count, perMinuteByActivityFifth: events.perMinuteByActivityFifth }, peopleDir: PEOPLE_DIR,
  staystill: ssModel ? { model: SS_MODEL_FILE, parameters: ssModel.parameters, events: SS_EVENTS_DIR || null, eventCount: ssEvents?.count ?? null, eventRate: SS_EVENT_RATE } : null,
  results, latency: lat, diversity: div }, null, 1));
console.log(file);
