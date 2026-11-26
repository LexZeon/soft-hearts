// Soak test, the pure parts (scripts/dev/soak.mjs runs the app; docs/claude/2026-11-18-soak.md says why and what the numbers meant).
// No Electron, no processes, no clock: slopes, frame histograms, thresholds, the verdict and the report text.
// Tested in tests/soak.test.mjs. Importing this module starts nothing.
import { descendants, processType, ticksToSeconds } from './baseline.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const MB = 1024 * 1024;
const round = (value, digits = 1) => finite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;

/**
 * First guesses (2026-11-18), to be tightened after the first real long runs. Each has `watch` (look at it) and `fail` (do not leave her
 * open all day with this). Growth is per hour after the warm-up. Why these numbers: docs/claude/2026-11-18-soak.md.
 * Idle baseline of the packaged app (overhaul baseline, 11-17): about 1.46 GB private in total and 22 % of one core.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  memoryTotalMBPerHour: { watch: 25, fail: 75 },     // all processes, private bytes. 75 MB/h is 1.8 GB over a whole day.
  memoryRendererMBPerHour: { watch: 15, fail: 50 },  // the page processes (companion, control, Unbound)
  memoryGpuMBPerHour: { watch: 10, fail: 40 },       // the GPU process (dedicated usage when Windows shows it, else its private bytes)
  memoryMainMBPerHour: { watch: 8, fail: 30 },       // the main (Node) process
  jsHeapMBPerHour: { watch: 10, fail: 40 },          // JS heap of the companion and control pages
  handlesPerHour: { watch: 50, fail: 250 },          // Windows handles, whole tree
  idleCpuDriftPercentPerHour: { watch: 1.5, fail: 5 }, // percent of ONE core per hour, from the 20 s idle probes
  stallsOver250msPerHour: { watch: 3, fail: 15 },    // companion-window animation frames that took longer than 250 ms
  frameP95Ms: { watch: 34, fail: 50 },               // companion-window frame interval, 95th percentile, median over the 5-minute windows
  frameP95DriftPercent: { watch: 25, fail: 60 },     // last third of the run against the first third
  journalMBPerHour: { watch: 1, fail: 5 },           // the experience journal on disk
  processGrowth: { watch: 2, fail: 6 },              // processes in the tree beyond the first sample (a leak of helper processes)
  chatFirstCharDriftMs: { watch: 400, fail: 1500 },  // fake-Claude chat: first visible character, last third against first third
});

/** Samples before this many hours are the app settling (model, caches, JIT) and are left out of the slopes: a quarter of the run, at most 30 minutes. */
export function warmupHours(totalHours) { return Math.min(0.5, Math.max(0, totalHours) * 0.25); }

/** Least-squares slope (y per x). null with fewer than 3 points or no spread in x. */
export function olsSlope(points) {
  const rows = points.filter(point => finite(point.x) && finite(point.y));
  if (rows.length < 3) return null;
  const mx = rows.reduce((sum, p) => sum + p.x, 0) / rows.length, my = rows.reduce((sum, p) => sum + p.y, 0) / rows.length;
  let num = 0, den = 0;
  for (const p of rows) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  return den > 0 ? num / den : null;
}

/** Median of all pairwise slopes: one spike (a GC, a scripted interaction) does not move it. null with fewer than 3 points. */
export function theilSenSlope(points) {
  const rows = points.filter(point => finite(point.x) && finite(point.y));
  if (rows.length < 3) return null;
  const slopes = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (rows[j].x !== rows[i].x) slopes.push((rows[j].y - rows[i].y) / (rows[j].x - rows[i].x));
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const mid = slopes.length >> 1;
  return slopes.length % 2 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;
}

export function median(values) {
  const rows = values.filter(finite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = rows.length >> 1;
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

/** Slope per hour of `pick(sample)` over the samples after the warm-up: robust (Theil-Sen) for the verdict, least squares next to it. */
export function growth(samples, pick, { warmup = 0 } = {}) {
  const points = samples.filter(sample => sample.tHours >= warmup).map(sample => ({ x: sample.tHours, y: pick(sample) })).filter(point => finite(point.y));
  const robust = theilSenSlope(points), least = olsSlope(points);
  return { perHour: round(robust, 2), olsPerHour: round(least, 2), points: points.length, first: points[0]?.y ?? null, last: points.at(-1)?.y ?? null };
}

/** The first and the last third of the samples: median of `pick` in each, and the change (null when a third is empty). */
export function thirds(samples, pick) {
  const values = samples.map(pick), third = Math.floor(values.length / 3);
  if (third < 1) return { first: null, last: null, change: null, changePercent: null };
  const first = median(values.slice(0, third)), last = median(values.slice(-third));
  return { first: round(first, 2), last: round(last, 2), change: finite(first) && finite(last) ? round(last - first, 2) : null,
    changePercent: finite(first) && finite(last) && first > 0 ? round((last - first) / first * 100, 1) : null };
}

// ---------- frame histogram (the page keeps 1 ms bins up to 1000 ms; the soak reads and resets it every tick) ----------

export const FRAME_BINS = 1001;

/** q-quantile (0..1) of a 1-ms histogram (bin i = intervals in [i, i+1) ms; the last bin holds everything from 1000 ms up). null when empty. */
export function histogramQuantile(bins, q) {
  const total = bins.reduce((sum, count) => sum + count, 0);
  if (!total) return null;
  const target = q * total;
  let seen = 0;
  for (let i = 0; i < bins.length; i++) { seen += bins[i]; if (seen >= target) return i + 0.5; }
  return bins.length - 0.5;
}

/** What one tick's window of frames says: counts, p50/p95/p99, and how many frames took over 100 and 250 ms. */
export function frameSummary(window) {
  if (!window || !Array.isArray(window.bins)) return null;
  const bins = window.bins, frames = bins.reduce((sum, count) => sum + count, 0);
  const over = ms => bins.slice(Math.ceil(ms)).reduce((sum, count) => sum + count, 0);
  return { frames, p50: histogramQuantile(bins, 0.5), p95: histogramQuantile(bins, 0.95), p99: histogramQuantile(bins, 0.99),
    over100: over(100), over250: over(250), longTasks: window.longTasks ?? 0, longTaskMs: round(window.longTaskMs ?? 0, 0), hiddenIntervals: window.hidden ?? 0 };
}

// ---------- process rows -> one sample ----------

/** Win32_Process rows (with HandleCount) -> per process {pid, type, cpuSeconds, workingSet, privateBytes, handles}. */
export function treeSample(rows, rootPid, at) {
  return { at, processes: descendants(rows, rootPid).map(row => ({ pid: row.ProcessId, type: processType(row.CommandLine, row.Name),
    cpuSeconds: ticksToSeconds(Number(row.KernelModeTime) + Number(row.UserModeTime)), workingSet: Number(row.WorkingSetSize), privateBytes: Number(row.PrivatePageCount),
    handles: Number(row.HandleCount) || 0 })) };
}

/** Per type and in total: process count, private MB, working-set MB and handles at one moment. */
export function memoryByType(sample) {
  const out = { total: { count: 0, privateMB: 0, workingSetMB: 0, handles: 0 } };
  for (const p of sample.processes) {
    const group = out[p.type] ??= { count: 0, privateMB: 0, workingSetMB: 0, handles: 0 };
    for (const target of [group, out.total]) { target.count++; target.privateMB += p.privateBytes / MB; target.workingSetMB += p.workingSet / MB; target.handles += p.handles; }
  }
  for (const group of Object.values(out)) { group.privateMB = round(group.privateMB, 1); group.workingSetMB = round(group.workingSetMB, 1); }
  return out;
}

/** CPU % of one core between two samples, per type and in total (processes present in both; the rest cost nothing here). */
export function cpuBetween(before, after) {
  const wall = (after.at - before.at) / 1000;
  const was = new Map(before.processes.map(p => [p.pid, p]));
  const out = { total: 0 };
  if (!(wall > 0)) return out;
  for (const p of after.processes) {
    const earlier = was.get(p.pid);
    const used = earlier ? Math.max(0, p.cpuSeconds - earlier.cpuSeconds) / wall * 100 : 0;
    out.total += used; out[p.type] = (out[p.type] ?? 0) + used;
  }
  for (const key of Object.keys(out)) out[key] = round(out[key], 2);
  return out;
}

// ---------- per-step measurement (2026-11-19: which operation causes the stalls and the main-process memory steps) ----------

/** Two frame windows (the bins readProbe returns) added together; null when both are missing. */
export function mergeFrameWindows(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const bins = a.bins.map((count, i) => count + (b.bins[i] ?? 0));
  return { bins, longTasks: (a.longTasks ?? 0) + (b.longTasks ?? 0), longTaskMs: (a.longTaskMs ?? 0) + (b.longTaskMs ?? 0), hidden: (a.hidden ?? 0) + (b.hidden ?? 0) };
}

/**
 * One scripted step from two readings of the app. A reading: { mainPrivateMB, heapUsedMB, rssMB, externalMB, arrayBuffersMB, spawned }
 * (main-process private bytes from the process tree; Node memory of the main process after a forced GC when the harness could do it; the
 * number of fake-Claude processes started so far). `window`: the companion window's frame bins during the step. `loop`: the main process's
 * event-loop delay during the step ({ maxMs, p99Ms }, null when not read). `tail`: frames in the few seconds after the step ended (where a spare
 * Claude is started once a reply is done); `spawnedInStep`: Claude processes started when the step itself ended (the rest of `spawned` came in the tail);
 * `measure`: frames while the harness itself was sampling the process tree (to tell the sampler's own stalls from the app's).
 */
export function stepRecord({ kind, ok = true, note = '', tHours = 0, warmup = false, ms = 0, before, after, window = null, loop = null, tail = null, measure = null, spawnedInStep = null }) {
  const frames = frameSummary(window);
  const diff = key => finite(before?.[key]) && finite(after?.[key]) ? round(after[key] - before[key], 1) : null;
  return { kind, ok, note, tHours: round(tHours, 4), warmup, ms: Math.round(ms), mainPrivateBefore: before?.mainPrivateMB ?? null, mainPrivateDeltaMB: diff('mainPrivateMB'),
    heapUsedDeltaMB: diff('heapUsedMB'), rssDeltaMB: diff('rssMB'), externalDeltaMB: diff('externalMB'), arrayBuffersDeltaMB: diff('arrayBuffersMB'),
    spawned: finite(before?.spawned) && finite(after?.spawned) ? after.spawned - before.spawned : null,
    frames: frames ? { frames: frames.frames, over100: frames.over100, over250: frames.over250, p95: frames.p95, longTasks: frames.longTasks } : null,
    loopMaxMs: loop && finite(loop.maxMs) ? round(loop.maxMs, 1) : null, loopP99Ms: loop && finite(loop.p99Ms) ? round(loop.p99Ms, 1) : null,
    heapUsedAfterMB: after?.heapUsedMB ?? null, rssAfterMB: after?.rssMB ?? null, heapTotalAfterMB: after?.heapTotalMB ?? null, newSpaceAfterMB: after?.newSpaceMB ?? null,
    spawnedInStep: finite(spawnedInStep) && finite(before?.spawned) ? spawnedInStep - before.spawned : null,
    tailOver250: frameSummary(tail)?.over250 ?? null, measureOver250: frameSummary(measure)?.over250 ?? null };
}

/** Per kind of step (warm-up round left out): how many, frames over 100 / 250 ms, fake-Claude processes started, sum and median of the main private-memory change. */
export function summarizeSteps(steps) {
  const groups = new Map();
  for (const step of steps.filter(s => !s.warmup)) { if (!groups.has(step.kind)) groups.set(step.kind, []); groups.get(step.kind).push(step); }
  return [...groups].map(([kind, list]) => {
    const total = pick => list.reduce((a, s) => a + (finite(pick(s)) ? pick(s) : 0), 0);
    return { kind, count: list.length, failed: list.filter(s => !s.ok).length, over100: total(s => s.frames?.over100), over250: total(s => s.frames?.over250),
      stepsWithOver250: list.filter(s => (s.frames?.over250 ?? 0) > 0).length, tailOver250: total(s => s.tailOver250), measureOver250: total(s => s.measureOver250),
      spawnedInStep: total(s => s.spawnedInStep), spawned: total(s => s.spawned), spawnedPerStep: round(total(s => s.spawned) / list.length, 2),
      privateDeltaSumMB: round(total(s => s.mainPrivateDeltaMB), 1), privateDeltaMedianMB: round(median(list.map(s => s.mainPrivateDeltaMB)), 1),
      heapUsedDeltaSumMB: round(total(s => s.heapUsedDeltaMB), 1), rssDeltaSumMB: round(total(s => s.rssDeltaMB), 1), loopMaxMs: round(Math.max(0, ...list.map(s => s.loopMaxMs ?? 0)), 1) };
  });
}

// ---------- verdict ----------

const STATUS = Object.freeze({ pass: 'pass', watch: 'watch', fail: 'fail', unknown: 'unknown' });
export const VERDICT = Object.freeze({ pass: 'PASS', watch: 'WATCH', fail: 'FAIL', inconclusive: 'INCONCLUSIVE' });

function judge(value, limit, { lowerIsBetter = true } = {}) {
  if (!finite(value) || !limit) return STATUS.unknown;
  const worse = lowerIsBetter ? value : -value;
  if (worse > limit.fail) return STATUS.fail;
  if (worse > limit.watch) return STATUS.watch;
  return STATUS.pass;
}

const sum = values => values.filter(finite).reduce((a, b) => a + b, 0);

/**
 * The report's checks and verdict from the tick samples. `meta`: { durationHours, startProcessCount, mainExited, crashes: [...],
 * interactionFailures: n, claudeDenied: n }. Samples carry the fields soak.mjs writes (tHours, mem{type:{privateMB,handles,count}},
 * gpuDedicatedMB, jsHeapMB, cpuIdle{}, frames{}, errors{pageErrors, consoleErrors, messages}, partOff[], journalBytes, chatFirstCharMs).
 */
export function evaluate(samples, meta, thresholds = DEFAULT_THRESHOLDS) {
  const warmup = warmupHours(meta.durationHours ?? samples.at(-1)?.tHours ?? 0);
  const checks = [];
  const add = (id, label, value, unit, limit, detail = '', status = null) => checks.push({ id, label, value: finite(value) ? round(value, 2) : null, unit, watch: limit?.watch ?? null, fail: limit?.fail ?? null,
    status: status ?? judge(value, limit), detail });
  const after = samples.filter(sample => sample.tHours >= warmup);
  const enough = after.length >= 4;
  const g = (pick, unit, id, label, limit) => { const r = growth(samples, pick, { warmup }); add(id, label, enough ? r.perHour : null, unit, limit, `${r.points} points after warm-up; least squares ${r.olsPerHour ?? 'n/a'}; ${r.first ?? 'n/a'} to ${r.last ?? 'n/a'}`); };

  g(s => s.mem?.total?.privateMB, 'MB/h', 'memory-total', 'Memory, all processes (private)', thresholds.memoryTotalMBPerHour);
  g(s => s.mem?.renderer?.privateMB, 'MB/h', 'memory-renderer', 'Memory, page processes', thresholds.memoryRendererMBPerHour);
  g(s => finite(s.gpuDedicatedMB) ? s.gpuDedicatedMB : s.mem?.gpu?.privateMB, 'MB/h', 'memory-gpu', 'Memory, GPU process', thresholds.memoryGpuMBPerHour);
  g(s => s.mem?.main?.privateMB, 'MB/h', 'memory-main', 'Memory, main process', thresholds.memoryMainMBPerHour);
  g(s => s.jsHeapMB, 'MB/h', 'js-heap', 'JS heap of the pages', thresholds.jsHeapMBPerHour);
  g(s => s.mem?.total?.handles, 'handles/h', 'handles', 'Handles', thresholds.handlesPerHour);
  g(s => s.cpuIdle?.total, '% core/h', 'cpu-drift', 'Idle CPU drift', thresholds.idleCpuDriftPercentPerHour);

  const frames = samples.map(s => s.frames).filter(Boolean);
  const hours = Math.max(meta.durationHours ?? 0, 1e-9);
  const stalls = sum(frames.map(f => f.over250));
  add('stalls', 'Frames over 250 ms', enough && hours >= 0.5 ? stalls / hours : null, 'per hour', thresholds.stallsOver250msPerHour, `${stalls} in ${round(hours, 2)} h; over 100 ms: ${sum(frames.map(f => f.over100))}; long tasks: ${sum(frames.map(f => f.longTasks))}`);
  const p95 = median(frames.map(f => f.p95));
  add('frame-p95', 'Frame interval p95', p95, 'ms', thresholds.frameP95Ms, `p50 median ${round(median(frames.map(f => f.p50)), 1) ?? 'n/a'} ms, p99 median ${round(median(frames.map(f => f.p99)), 1) ?? 'n/a'} ms, p99 worst ${round(Math.max(...frames.map(f => f.p99 ?? 0)), 1)} ms over ${frames.length} windows`);
  const driftThirds = thirds(samples.filter(s => s.frames), s => s.frames.p95);
  add('frame-drift', 'Frame p95, last third vs first', driftThirds.changePercent, '%', thresholds.frameP95DriftPercent, `${driftThirds.first ?? 'n/a'} ms to ${driftThirds.last ?? 'n/a'} ms`);
  const chat = thirds(samples.filter(s => finite(s.chatFirstCharMs)), s => s.chatFirstCharMs);
  add('chat-latency', 'Chat first character, last third vs first', chat.change, 'ms', thresholds.chatFirstCharDriftMs, `${chat.first ?? 'n/a'} ms to ${chat.last ?? 'n/a'} ms (fake Claude)`);
  const journal = growth(samples, s => finite(s.journalBytes) ? s.journalBytes / MB : null, { warmup: 0 });
  add('journal', 'Journal growth', journal.points >= 3 ? journal.perHour : null, 'MB/h', thresholds.journalMBPerHour, `${journal.first ?? 'n/a'} to ${journal.last ?? 'n/a'} MB`);
  const start = meta.startProcessCount ?? samples[0]?.mem?.total?.count ?? null;
  const peak = Math.max(0, ...samples.map(s => s.mem?.total?.count ?? 0));
  add('process-count', 'Processes beyond the start', finite(start) ? peak - start : null, 'processes', thresholds.processGrowth, `start ${start ?? 'n/a'}, peak ${peak}`);

  const pageErrors = sum(samples.map(s => s.errors?.pageErrors));
  add('page-errors', 'Uncaught page errors', pageErrors, 'count', { watch: 0, fail: 0 }, samples.flatMap(s => s.errors?.pageMessages ?? []).slice(0, 3).join(' | '));
  const consoleErrors = sum(samples.map(s => s.errors?.consoleErrors));
  add('console-errors', 'Console errors', consoleErrors, 'count', { watch: 0, fail: 20 }, [...new Set(samples.flatMap(s => s.errors?.messages ?? []))].slice(0, 3).join(' | '));
  const off = samples.flatMap(s => s.partOff ?? []);
  add('parts-off', 'Parts switched off', new Set(off.map(o => `${o.part}/${o.unit}`)).size, 'units', { watch: 0, fail: 0 }, [...new Set(off.map(o => `${o.part}/${o.unit}:${o.reason ?? ''}`))].slice(0, 3).join(' | '));
  const crashes = (meta.crashes ?? []).length + (meta.mainExited ? 1 : 0);
  add('crashes', 'Process crashes or exit', crashes, 'count', { watch: 0, fail: 0 }, [...(meta.crashes ?? []), ...(meta.mainExited ? ['main process exited'] : [])].slice(0, 3).join(' | '));
  add('interactions', 'Scripted interactions that failed', meta.interactionFailures ?? 0, 'count', { watch: 0, fail: 5 }, (meta.interactionNotes ?? []).slice(0, 3).join(' | '));
  add('claude-denied', 'Fake-Claude launches refused (limit)', meta.claudeDenied ?? 0, 'count', { watch: 0, fail: 5 }, 'the smoke interposer allows 256 launches');

  const decided = checks.filter(c => c.status !== STATUS.unknown);
  let verdict;
  if (checks.some(c => c.status === STATUS.fail)) verdict = VERDICT.fail;
  else if (!enough || decided.length < checks.length * 0.6) verdict = VERDICT.inconclusive;
  else if (checks.some(c => c.status === STATUS.watch)) verdict = VERDICT.watch;
  else verdict = VERDICT.pass;
  return { verdict, warmupHours: round(warmup, 2), samplesAfterWarmup: after.length, enough, checks,
    note: enough ? '' : 'Too few samples after the warm-up for slopes (need 4): this run proves the script, it does not judge her.' };
}

// ---------- arguments ----------

/** What --only can name: one kind of scripted use per run (touch = the head stroke). */
export const ONLY_STEPS = Object.freeze(['chat', 'hide', 'touch', 'pinch', 'pull']);

/** Command-line options. `--hours` default 4; `--minutes` replaces it for short runs. */
export function parseSoakArgs(argv, env = {}) {
  const o = { exe: env.MMD_TEST_EXE ?? null, hours: 4, minutes: null, tickSeconds: 300, interactionMinutes: 10, idleProbeSeconds: 20, settleSeconds: 60, out: null, unbound: false, ignoreOccupancy: false, seed: null, only: null, longChat: null, commit: null, engine: 'unbound' };
  const num = (name, value, { integer = false } = {}) => { const n = Number(value); if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw Error(`${name} needs a positive ${integer ? 'whole ' : ''}number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--exe') o.exe = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--hours') o.hours = num(a, argv[++i]);
    else if (a === '--minutes') o.minutes = num(a, argv[++i]);
    else if (a === '--tick-seconds') o.tickSeconds = num(a, argv[++i]);
    else if (a === '--interaction-minutes') o.interactionMinutes = num(a, argv[++i]);
    else if (a === '--idle-probe-seconds') o.idleProbeSeconds = num(a, argv[++i]);
    else if (a === '--settle-seconds') o.settleSeconds = num(a, argv[++i]);
    else if (a === '--seed') o.seed = num(a, argv[++i], { integer: true });
    else if (a === '--only') { o.only = argv[++i]; if (!ONLY_STEPS.includes(o.only)) throw Error('--only needs one of ' + ONLY_STEPS.join(', ')); }
    else if (a === '--long-chat') { o.longChat = argv[++i]; if (o.longChat !== '0' && o.longChat !== '1') throw Error('--long-chat needs 0 or 1'); }
    else if (a === '--commit') o.commit = argv[++i];
    else if (a === '--engine') { o.engine = argv[++i]; if (o.engine !== 'unbound' && o.engine !== 'mmd') throw Error('--engine needs unbound or mmd'); }
    else if (a === '--unbound') o.unbound = true;
    else if (a === '--ignore-occupancy') o.ignoreOccupancy = true;
    else throw Error('Unknown option ' + a);
  }
  if (o.minutes !== null) o.hours = o.minutes / 60;
  if (o.commit && o.exe) throw Error('--commit and --exe name two different builds; give one');
  if (o.idleProbeSeconds * 3 > o.tickSeconds) throw Error('--idle-probe-seconds must be at most a third of --tick-seconds');
  return o;
}

/** A small seeded generator (mulberry32) so a run's interaction jitter can be repeated. */
export function seededRandom(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- report text ----------

const statusMark = { pass: 'ok', watch: 'WATCH', fail: 'FAIL', unknown: 'n/a' };
export function renderSoakMarkdown(report) {
  const e = report.evaluation, lines = [`# Soak ${report.startedAt}`, '',
    `**Verdict: ${e.verdict}**${e.note ? ` (${e.note})` : ''}`, '',
    `- Build: \`${report.exe}\` (${report.exeBytes} bytes, modified ${report.exeModified})`,
    `- Length: ${round(report.durationHours, 2)} h measured, ${report.samples.length} samples every ${report.options.tickSeconds} s, warm-up ${e.warmupHours} h left out of the slopes`,
    `- Machine: ${report.machine.cpu}, ${report.machine.cores} logical cores, ${report.machine.memGB} GB; tray said "${report.presenceAtStart}" at the start`,
    `- Isolation: temp profile, fake Claude only (${report.claude.spawned} launches, ${report.claude.denied} refused); no camera, microphone, screen or system audio`, '',
    '## Checks', '', '| Check | Value | Watch / fail at | Result | Detail |', '|---|---|---|---|---|'];
  for (const c of e.checks) lines.push(`| ${c.label} | ${c.value === null ? 'n/a' : `${c.value} ${c.unit}`} | ${c.watch ?? ''} / ${c.fail ?? ''} | ${statusMark[c.status]} | ${String(c.detail).replace(/\|/gu, '/')} |`);
  lines.push('', '## Samples', '', '| t (h) | private MB | renderer MB | gpu MB | main MB | handles | JS heap MB | idle CPU % | interval CPU % | p50 / p95 ms | >250 ms | chat ms | procs |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of report.samples) lines.push(`| ${round(s.tHours, 2)} | ${s.mem?.total?.privateMB ?? ''} | ${s.mem?.renderer?.privateMB ?? ''} | ${s.gpuDedicatedMB ?? s.mem?.gpu?.privateMB ?? ''} | ${s.mem?.main?.privateMB ?? ''} | ${s.mem?.total?.handles ?? ''} | ${s.jsHeapMB ?? ''} | ${s.cpuIdle?.total ?? ''} | ${s.cpuInterval?.total ?? ''} | ${s.frames ? `${s.frames.p50} / ${s.frames.p95}` : ''} | ${s.frames?.over250 ?? ''} | ${s.chatFirstCharMs ?? ''} | ${s.mem?.total?.count ?? ''} |`);
  if (report.interactions.length) {
    const failed = report.interactions.filter(i => !i.ok);
    lines.push('', '## Scripted interactions', '', `${report.interactions.length} steps, ${failed.length} failed or skipped.`, '');
    for (const f of failed.slice(0, 20)) lines.push(`- t ${round(f.tHours, 2)} h ${f.kind}: ${f.note}`);
  }
  const steps = report.steps ?? [];
  if (steps.length) {
    lines.push('', `## Steps (before and after each scripted step${report.options?.only ? '; only ' + report.options.only : ''})`, '',
      '| Step | Count | Frames >100 ms | Frames >250 ms | Steps with >250 | >250 in the 4 s after | >250 while the harness sampled | Claude started in the step | Claude started incl. the 4 s after (per step) | Main private change, sum / median MB | heapUsed sum MB | rss sum MB | Main loop max ms |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const g of summarizeSteps(steps)) lines.push(`| ${g.kind} | ${g.count} (${g.failed} failed) | ${g.over100} | ${g.over250} | ${g.stepsWithOver250} | ${g.tailOver250} | ${g.measureOver250} | ${g.spawnedInStep} | ${g.spawned} (${g.spawnedPerStep}) | ${g.privateDeltaSumMB} / ${g.privateDeltaMedianMB} | ${g.heapUsedDeltaSumMB} | ${g.rssDeltaSumMB} | ${g.loopMaxMs} |`);
    lines.push('', '| t (h) | step | private change MB | heapUsed change | rss change | external / arrayBuffers change | started | >100 / >250 ms | loop max ms | ms |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const s of steps.slice(0, 80)) lines.push(`| ${s.tHours}${s.warmup ? ' (warm-up)' : ''} | ${s.kind}${s.ok ? '' : ' (failed)'} | ${s.mainPrivateDeltaMB ?? ''} | ${s.heapUsedDeltaMB ?? ''} | ${s.rssDeltaMB ?? ''} | ${s.externalDeltaMB ?? ''} / ${s.arrayBuffersDeltaMB ?? ''} | ${s.spawned ?? ''} | ${s.frames ? s.frames.over100 + ' / ' + s.frames.over250 : ''} | ${s.loopMaxMs ?? ''} | ${s.ms} |`);
  }
  if (report.unbound) lines.push('', '## Unbound', '', report.unbound.note);
  lines.push('', '## Not covered', '', ...report.notCovered.map(text => `- ${text}`));
  return lines.join('\n') + '\n';
}
