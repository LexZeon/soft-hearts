// Unbound step 6 「一整天的稳定」, the pure parts of the per-interaction probe (scripts/unbound/step6-probe.mjs runs the app).
// No Electron, no processes, no clock: readings to per-step rows, per-kind summaries, long-frame attribution, heap-snapshot
// aggregation and diff, the report text. Tested in tests/step6-probe.test.mjs. Docs: docs/claude/2026-11-23-unbound-step6.md.
// Importing this module starts nothing.
import { median, theilSenSlope } from '../dev/soak-lib.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 1) => finite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;

/** The kinds of scripted use the probe knows. Companion-window ones, then Unbound ones (`ub-*` happen while she is out), then control experiments (`x-*`). */
export const PROBE_KINDS = Object.freeze(['chat', 'pat', 'pinch', 'pull', 'hide', 'ub-enter', 'ub-chat', 'ub-click', 'ub-pull', 'x-spawn', 'x-spawn-pat', 'x-idle', 'x-ipc', 'x-send', 'x-newchat']);

/**
 * Flattens one reading of the app into numbers. `reading`: { main: { heapUsedMB, rssMB, externalMB, arrayBuffersMB, resources: {type: n} },
 * metrics: [{ type, role, privateMB, workingSetMB }], pages: { role: { heapMB, nodes, listeners, documents } }, handles }.
 * Keys: main.private, main.heap, main.rss, main.external, gpu.private, <role>.private, <role>.heap, <role>.nodes, <role>.listeners,
 * main.handles, main.res.<type> (active Node resources).
 */
export function flattenReading(reading) {
  const out = {};
  const put = (key, value) => { if (finite(value)) out[key] = value; };
  const main = reading?.main ?? {};
  put('main.heap', main.heapUsedMB); put('main.heapTotal', main.heapTotalMB);
  for (const [space, mb] of Object.entries(main.spaces ?? {})) put(`main.space.${space}`, mb);
  // What the main process holds outside V8's heap and its ArrayBuffers (Chromium, Electron, Node natives): rss - heapTotal - external.
  if (finite(main.rssMB) && finite(main.heapTotalMB) && finite(main.externalMB)) put('main.native', main.rssMB - main.heapTotalMB - main.externalMB); put('main.rss', main.rssMB); put('main.external', main.externalMB); put('main.arrayBuffers', main.arrayBuffersMB);
  for (const [type, count] of Object.entries(main.resources ?? {})) put(`main.res.${type}`, count);
  put('main.windows', main.windows); put('main.webContents', main.webContents); put('main.ipcListeners', main.ipcListeners); put('main.companionArea', main.companionArea);
  for (const row of reading?.metrics ?? []) {
    const role = row.role ?? row.type;
    put(`${role}.private`, (out[`${role}.private`] ?? 0) + (row.privateMB ?? 0));
  }
  for (const [role, page] of Object.entries(reading?.pages ?? {})) {
    put(`${role}.heap`, page?.heapMB); put(`${role}.nodes`, page?.nodes); put(`${role}.listeners`, page?.listeners); put(`${role}.documents`, page?.documents);
    put(`${role}.textures`, page?.textures); put(`${role}.geometries`, page?.geometries); put(`${role}.programs`, page?.programs);
  }
  put('main.handles', reading?.handles);
  return out;
}

/** One step: what changed between the readings before and after, the frames during it and the main event loop. */
export function probeStep({ kind, round: index, ok = true, note = '', ms = 0, before, after, frames = null, loop = null }) {
  const a = flattenReading(before), b = flattenReading(after), delta = {};
  const newPrograms = {};
  for (const [role, page] of Object.entries(after?.pages ?? {})) { const was = new Set(before?.pages?.[role]?.programNames ?? []); const fresh = (page?.programNames ?? []).filter(name => !was.has(name)); if (fresh.length && before?.pages?.[role]) newPrograms[role] = fresh; }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (finite(a[key]) && finite(b[key])) delta[key] = round(b[key] - a[key], 2);
  return { kind, round: index, ok, note, ms: Math.round(ms), after: b, delta, ...(Object.keys(newPrograms).length ? { newPrograms } : {}), frames: frames ? summarizeFrames(frames) : null,
    loopMaxMs: loop && finite(loop.maxMs) ? round(loop.maxMs, 1) : null };
}

/**
 * Frames recorded in a page while a step ran: `{ intervals: [ms...] (animation-frame gaps), loaf: [{ start, duration, blocking, scripts: [...] }] }`.
 * Returns counts over 50 / 100 / 250 ms, p95 / p99 of the gaps, and the long animation frames (>= 100 ms) with their attribution.
 */
export function summarizeFrames(frames) {
  const gaps = (frames.intervals ?? []).filter(finite).sort((x, y) => x - y);
  const q = p => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : null;
  const long = (frames.loaf ?? []).filter(entry => finite(entry.duration) && entry.duration >= 100);
  return { count: gaps.length, over50: gaps.filter(g => g > 50).length, over100: gaps.filter(g => g > 100).length, over250: gaps.filter(g => g > 250).length,
    p95: round(q(0.95), 1), p99: round(q(0.99), 1), max: round(gaps.at(-1) ?? null, 1), hiddenGaps: frames.hidden ?? 0,
    longFrames: long.map(entry => ({ duration: round(entry.duration, 0), blocking: round(entry.blocking, 0), page: entry.page ?? null, top: topScripts(entry.scripts) })) };
}

/** The scripts that took the most of one long animation frame, as "invoker | function @ file" with their time. */
export function topScripts(scripts, limit = 3) {
  return (scripts ?? []).filter(s => finite(s.duration)).sort((x, y) => y.duration - x.duration).slice(0, limit)
    .map(s => ({ ms: round(s.duration, 0), what: `${s.invoker || s.invokerType || '?'} | ${s.sourceFunctionName || '(anonymous)'} @ ${shortUrl(s.sourceURL)}${finite(s.sourceCharPosition) && s.sourceCharPosition >= 0 ? `:${s.sourceCharPosition}` : ''}` }));
}
const shortUrl = url => { const text = String(url ?? ''); const cut = text.split(/[\\/]/u); return cut.slice(-2).join('/') || '?'; };

/** The keys whose growth matters most for "memory grows a step with each interaction". */
export const WATCH_KEYS = Object.freeze(['main.private', 'main.heap', 'main.heapTotal', 'main.native', 'main.space.code_space', 'main.space.old_space', 'main.space.new_space', 'main.space.large_object_space', 'main.rss', 'main.external', 'main.handles', 'gpu.private', 'companion.private', 'companion.heap', 'companion.nodes', 'companion.listeners',
  'controls.private', 'controls.heap', 'controls.nodes', 'controls.listeners', 'unbound.private', 'unbound.heap', 'companion.textures', 'companion.geometries', 'companion.programs', 'unbound.textures', 'unbound.geometries', 'ub-input.private', 'utility.private', 'main.arrayBuffers', 'main.windows', 'main.webContents', 'main.ipcListeners', 'main.companionArea']);

/**
 * Per kind (the first round of each kind left out: it loads code and caches once): the median change per step for each watched key,
 * the sum, and the Theil-Sen slope of the value after each step against the round number (per round). A key that grows every round shows a
 * positive median AND a positive slope; a one-time step shows only in the left-out first round.
 */
export function summarizeKinds(steps, keys = WATCH_KEYS) {
  const groups = new Map();
  for (const step of steps) { if (!groups.has(step.kind)) groups.set(step.kind, []); groups.get(step.kind).push(step); }
  return [...groups].map(([kind, all]) => {
    const list = all.slice(1);
    const rows = {};
    for (const key of keys) {
      const deltas = list.map(s => s.delta[key]).filter(finite);
      if (!deltas.length) continue;
      const slope = theilSenSlope(list.map(s => ({ x: s.round, y: s.after[key] })));
      rows[key] = { median: round(median(deltas), 2), sum: round(deltas.reduce((x, y) => x + y, 0), 2), perRound: round(slope, 2) };
    }
    const frames = list.map(s => s.frames).filter(Boolean);
    return { kind, steps: list.length, firstRound: all[0] ? { delta: pick(all[0].delta, keys) } : null, failed: all.filter(s => !s.ok).length, rows,
      over100: frames.reduce((x, f) => x + f.over100, 0), over250: frames.reduce((x, f) => x + f.over250, 0), stepsWithOver250: frames.filter(f => f.over250 > 0).length,
      p99Max: round(Math.max(0, ...frames.map(f => f.p99 ?? 0)), 1), loopMaxMs: round(Math.max(0, ...list.map(s => s.loopMaxMs ?? 0)), 1) };
  });
}
const pick = (object, keys) => Object.fromEntries(keys.filter(key => finite(object?.[key])).map(key => [key, object[key]]));

/** Groups every long animation frame of a run by its biggest script, so a hitch's cause reads as one line with how often it came. */
export function longFrameCauses(steps) {
  const causes = new Map();
  for (const step of steps) for (const frame of step.frames?.longFrames ?? []) {
    const key = `${frame.page ?? '?'} :: ${frame.top[0]?.what ?? '(no script: style, layout, paint or the GPU)'}`;
    const row = causes.get(key) ?? { cause: key, count: 0, worstMs: 0, kinds: new Set() };
    row.count++; row.worstMs = Math.max(row.worstMs, frame.duration ?? 0); row.kinds.add(step.kind);
    causes.set(key, row);
  }
  return [...causes.values()].map(row => ({ ...row, kinds: [...row.kinds] })).sort((x, y) => y.count - x.count || y.worstMs - x.worstMs);
}

// ---------- heap snapshots ----------

/**
 * Aggregates one V8 heap snapshot (the parsed .heapsnapshot JSON) by node type and name: { "object:Foo": { count, bytes } }. Strings and
 * numbers are grouped by type only (their names are their contents). Works for the main process (v8.writeHeapSnapshot) and pages (CDP).
 */
export function aggregateSnapshot(snapshot) {
  const meta = snapshot.snapshot.meta, fields = meta.node_fields, types = meta.node_types[0];
  const width = fields.length, typeAt = fields.indexOf('type'), nameAt = fields.indexOf('name'), sizeAt = fields.indexOf('self_size');
  const nodes = snapshot.nodes, strings = snapshot.strings, out = {};
  for (let i = 0; i < nodes.length; i += width) {
    const type = types[nodes[i + typeAt]];
    const name = ['string', 'concatenated string', 'sliced string', 'number', 'heap number', 'bigint'].includes(type) ? '' : String(strings[nodes[i + nameAt]] ?? '').slice(0, 80);
    const key = `${type}:${name}`;
    const row = out[key] ??= { count: 0, bytes: 0 };
    row.count++; row.bytes += nodes[i + sizeAt];
  }
  return out;
}

/** The groups that grew most between two aggregated snapshots (by count, then by bytes), for the report. */
export function diffSnapshots(before, after, limit = 25) {
  const rows = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key] ?? { count: 0, bytes: 0 }, b = after[key] ?? { count: 0, bytes: 0 };
    if (b.count === a.count && b.bytes === a.bytes) continue;
    rows.push({ key, count: b.count - a.count, bytes: b.bytes - a.bytes, countAfter: b.count });
  }
  const grew = rows.filter(row => row.count > 0 || row.bytes > 0).sort((x, y) => y.bytes - x.bytes || y.count - x.count).slice(0, limit);
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  return { totalBytes: total, grew };
}

// ---------- report ----------

export function renderProbeMarkdown(run) {
  const lines = [`# Step 6 probe ${run.label ?? ''}`.trim(), '', `- build: ${run.commit ?? '?'} (${run.engine ?? '?'} engine in the companion window); rounds: ${run.rounds}; kinds: ${run.kinds.join(', ')}`,
    `- started ${run.startedAt}, ended ${run.endedAt ?? '-'}; presence at start: ${run.presence ?? '?'}${run.error ? `; ERROR: ${run.error}` : ''}`, ''];
  lines.push('## Per kind (first round of each kind left out)', '');
  for (const kind of run.summary ?? []) {
    lines.push(`### ${kind.kind}: ${kind.steps} steps, ${kind.failed} failed; frames >100 ms ${kind.over100}, >250 ms ${kind.over250} (in ${kind.stepsWithOver250} steps), worst p99 ${kind.p99Max} ms; main loop max ${kind.loopMaxMs} ms`, '');
    lines.push('| reading | median per step | sum | slope per round | first round |', '|---|---|---|---|---|');
    for (const [key, row] of Object.entries(kind.rows)) lines.push(`| ${key} | ${row.median} | ${row.sum} | ${row.perRound ?? '-'} | ${kind.firstRound?.delta?.[key] ?? '-'} |`);
    lines.push('');
  }
  const causes = run.causes ?? [];
  lines.push('## Long animation frames (>= 100 ms) by their biggest script', '');
  if (!causes.length) lines.push('None.');
  for (const cause of causes.slice(0, 20)) lines.push(`- ${cause.count}x, worst ${cause.worstMs} ms, during ${cause.kinds.join('/')}: ${cause.cause}`);
  for (const [label, diff] of Object.entries(run.snapshots ?? {})) {
    lines.push('', `## Heap snapshot diff: ${label} (${round(diff.totalBytes / 1048576, 2)} MB net)`, '', '| group | count | bytes |', '|---|---|---|');
    for (const row of diff.grew) lines.push(`| ${row.key.replaceAll('|', '/')} | ${row.count >= 0 ? '+' : ''}${row.count} (${row.countAfter}) | ${row.bytes >= 0 ? '+' : ''}${row.bytes} |`);
  }
  return lines.join('\n') + '\n';
}
