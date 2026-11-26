// Development (round 12, QA): a glitch scan of a showcase run through the real frame loop (the bundled Gene, the learned idle on as
// on the page, the run's own seed and liveliness). Every frame is checked for:
//  - pop:       a bone's step that stands out from its neighbours (a one-frame jump), or any step past the hard cap;
//  - morph:     an expression shape jumping more than 0.25 in one frame (blinks are crisp by design and are left out);
//  - blink-pop: a blink moving while a closed-eye expression already holds the lids (the lids would flick);
//  - fight:     a smile and a pout (or an open mouth and a pout) both high at once;
//  - hand:      fingers inside her surface (clearance < 0);
//  - eye:       eyes more than 15° off the middle of the head;
//  - rise:      a morph rising from under `low` to over `high` within `withinS` (round 15: a blush spread over a few frames popped in
//               without any single frame stepping far; the blush may never do it, other morphs can get their own rules).
// Consecutive frames of the same finding are merged (start, end, worst value, beats on). The showcase draws no bubble or text.
//   node node_modules/tsx/dist/cli.mjs scripts/unbound/showcase-glitch-scan.ts <choreography.json> [fps]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Quaternion, type SkinnedMesh } from 'three';
import { MORPH_ALIASES } from '../../shared/foundation/universal-skeleton';

export interface ScanFrame {
  t: number; beats: readonly string[];
  /** Tracked bones' world rotations (any objects with angleTo), in the same order every frame. */
  rotations: readonly Quaternion[];
  /** Eyes against the head (degrees, as the figure reports them). */
  eyeInHead: readonly { yaw: number; pitch: number }[];
  clearance: number | null;
  /** Morph weights by name this frame. */
  morphs: Readonly<Record<string, number>>;
}
export interface GlitchHit { kind: 'pop' | 'morph' | 'blink-pop' | 'fight' | 'hand' | 'eye' | 'rise'; from: number; to: number; name: string; worst: number; beats: string[] }
/** A morph that may not rise from under `low` to over `high` within `withinS` seconds (the finding's value: how long it took). */
export interface RiseRule { label: string; match: (morph: string) => boolean; low: number; high: number; withinS: number }
export interface ScanOptions { fps: number; boneNames: readonly string[]; /** Default: the blush rule alone. */ rise?: readonly RiseRule[] }

const DEG = 180 / Math.PI;
/** A bone's turn changing by more than this from one 60 fps frame to the next (deg; scaled by the frame time) is a pop. */
const POP_DEG = 3;
const has = (aliases: readonly string[]) => (name: string) => aliases.some(a => a.toLowerCase() === name.toLowerCase());
const isBlink = has(MORPH_ALIASES.blink), isSmileEyes = has(MORPH_ALIASES.smileEyes), isSmile = has(MORPH_ALIASES.mouthSmile);
const isPout = (name: string) => has(MORPH_ALIASES.mouthPucker)(name) || has(MORPH_ALIASES.u)(name);
const isOpen = has(MORPH_ALIASES.a);
/** Round 15: a blush rises over a second or two; it never goes from under 0.1 to over 0.6 within 0.3 s. */
export const BLUSH_RISE: RiseRule = Object.freeze({ label: 'blush', match: has(MORPH_ALIASES.shy), low: 0.1, high: 0.6, withinS: 0.3 });

/** The scan (pure: frames in, merged findings out). */
export function scanShowcase(frames: readonly ScanFrame[], options: ScanOptions): GlitchHit[] {
  const raw: { kind: GlitchHit['kind']; t: number; name: string; value: number; beats: readonly string[] }[] = [];
  const k = 60 / options.fps; // per-frame thresholds scale with the frame time
  const step = (i: number, b: number) => i > 0 ? frames[i].rotations[b].angleTo(frames[i - 1].rotations[b]) * DEG : 0;
  // How far this frame's turn departs from the last frame's (a smooth motion changes its turn a little each frame; a one-frame jump
  // departs sharply going out and again coming back).
  const qa = new Quaternion(), qb = new Quaternion(), qi = new Quaternion();
  const surprise = (i: number, b: number) => {
    if (i < 2) return 0;
    const r0 = frames[i].rotations[b], r1 = frames[i - 1].rotations[b], r2 = frames[i - 2].rotations[b];
    qa.copy(r0).multiply(qi.copy(r1).invert()); qb.copy(r1).multiply(qi.copy(r2).invert());
    return qa.angleTo(qb) * DEG;
  };
  const riseRules = options.rise ?? [BLUSH_RISE];
  /** Per rule and morph: the last time it was under the rule's low mark. */
  const lowAt = riseRules.map(() => new Map<string, number>());
  if (frames.length) riseRules.forEach((r, k) => { for (const [n, v] of Object.entries(frames[0].morphs)) if (r.match(n) && v < r.low) lowAt[k].set(n, frames[0].t); });
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i], p = frames[i - 1];
    riseRules.forEach((r, k) => {
      for (const [n, v] of Object.entries(f.morphs)) {
        if (!r.match(n)) continue;
        if (v < r.low) { lowAt[k].set(n, f.t); continue; }
        const since = lowAt[k].get(n);
        if (v > r.high && since !== undefined && f.t - since <= r.withinS + 1e-9) { raw.push({ kind: 'rise', t: f.t, name: n, value: f.t - since, beats: f.beats }); lowAt[k].delete(n); }
      }
    });
    // A one-frame jump (its turn departs sharply from the last frame's), or a step past the hard cap.
    for (let b = 0; b < f.rotations.length; b++) {
      const s = step(i, b), jolt = surprise(i, b);
      if (jolt > POP_DEG * k || s > 16 * k) raw.push({ kind: 'pop', t: f.t, name: options.boneNames[b] ?? String(b), value: Math.max(jolt, s > 16 * k ? s : 0), beats: f.beats });
    }
    const lidsHeld = Object.entries(p.morphs).some(([n, v]) => isSmileEyes(n) && v > 0.6);
    for (const [name, v] of Object.entries(f.morphs)) {
      const d = Math.abs(v - (p.morphs[name] ?? 0));
      if (isBlink(name)) { if (lidsHeld && d > 0.25) raw.push({ kind: 'blink-pop', t: f.t, name, value: d, beats: f.beats }); }
      else if (d > 0.25) raw.push({ kind: 'morph', t: f.t, name, value: d, beats: f.beats });
    }
    const top = (pred: (n: string) => boolean) => Math.max(0, ...Object.entries(f.morphs).filter(([n]) => pred(n)).map(([, v]) => v));
    const smile = top(isSmile), pout = top(isPout), open = top(isOpen);
    if (pout > 0.5 && (smile > 0.5 || open > 0.5)) raw.push({ kind: 'fight', t: f.t, name: smile > 0.5 ? 'smile+pout' : 'open+pout', value: Math.min(pout, Math.max(smile, open)), beats: f.beats });
    if (f.clearance !== null && f.clearance < 0) raw.push({ kind: 'hand', t: f.t, name: 'fingers', value: f.clearance * 100, beats: f.beats });
    const eye = Math.max(0, ...f.eyeInHead.map(e => Math.hypot(e.yaw, e.pitch)));
    if (eye > 15) raw.push({ kind: 'eye', t: f.t, name: 'eye-in-head', value: eye, beats: f.beats });
  }
  // Merge the same finding over consecutive frames (within two frame times).
  const hits: GlitchHit[] = [];
  const gap = 2.01 / options.fps;
  for (const r of raw) {
    const last = [...hits].reverse().find(h => h.kind === r.kind && h.name === r.name);
    const worse = (a: number, b: number) => r.kind === 'hand' || r.kind === 'rise' ? Math.min(a, b) : Math.max(a, b);
    if (last && r.t - last.to <= gap) { last.to = r.t; last.worst = worse(last.worst, r.value); for (const x of r.beats) if (!last.beats.includes(x)) last.beats.push(x); }
    else hits.push({ kind: r.kind, from: r.t, to: r.t, name: r.name, worst: r.value, beats: [...r.beats] });
  }
  return hits.map(h => ({ ...h, worst: +h.worst.toFixed(3), from: +h.from.toFixed(3), to: +h.to.toFixed(3) }));
}

/** Morph weights by name of a mesh as posed now. */
export function morphsOf(mesh: SkinnedMesh): Record<string, number> {
  const out: Record<string, number> = {}, dict = mesh.morphTargetDictionary ?? {}, inf = mesh.morphTargetInfluences ?? [];
  for (const [name, index] of Object.entries(dict)) if (inf[index] !== undefined) out[name] = inf[index];
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { runShowcase, SHOWCASE_TRACKED } = await import('../../tests/helpers/unbound-showcase');
  const { validateBeats } = await import('../../shared/unbound/showcase');
  const { loadIdleEvents, loadIdleModel } = await import('../ml/idle-data');
  const v = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { segments: unknown[][]; seed?: number; liveliness?: number };
  const fps = Number(process.argv[3] ?? 60);
  if (process.env.SHOWCASE_BLUSH_OLD) (await import('../../src/unbound/showcase/blush-envelope')).setSlowBlush(false); // round 15: the old blush, for a comparison
  const beats = validateBeats(v.segments.flat(), { from: 0, to: 62 })!.beats;
  let weights = null, events = null;
  try { weights = loadIdleModel(); events = loadIdleEvents(); } catch { /* procedural */ }
  const morphs: Record<string, number>[] = [];
  const run = await runShowcase(fps, Math.max(...beats.map(b => b.at + b.dur)) + 2, beats, { seed: v.seed, liveliness: v.liveliness, idle: { weights, events }, onFrame: mesh => morphs.push(morphsOf(mesh)), modelPath: process.env.SHOWCASE_MODEL || undefined, fit: process.env.SHOWCASE_FIT_OFF ? false : undefined }); // SHOWCASE_MODEL: another PMX (development)
  const frames: ScanFrame[] = run.frames.map((f, i) => ({ ...f, morphs: morphs[i] ?? {} }));
  const hits = scanShowcase(frames.slice(Math.round(fps * 0.5)), { fps, boneNames: SHOWCASE_TRACKED });
  const eyes = frames.slice(Math.round(fps * 0.5)).map(f => Math.max(0, ...f.eyeInHead.map(e => Math.hypot(e.yaw, e.pitch)))).sort((a, b) => a - b);
  const clear = frames.map(f => f.clearance).filter((c): c is number => c !== null);
  // Round 16: a hash of every frame's bones, morphs and clearance (rounded), and of every 300th, to prove a change leaves a model's frames as they were.
  if (process.env.SHOWCASE_DUMP) (await import('node:fs')).writeFileSync(process.env.SHOWCASE_DUMP, JSON.stringify(frames.map(f => f.clearance === null ? null : +(f.clearance * 1000).toFixed(3)))); // per-frame clearance (mm)
  const frameHash = (f: ScanFrame) => createHash('sha1').update(JSON.stringify([f.rotations.map(q => [q.x, q.y, q.z, q.w].map(v => +v.toFixed(5))), Object.entries(f.morphs).map(([n, v]) => [n, +v.toFixed(4)]), f.clearance === null ? null : +f.clearance.toFixed(5)])).digest('hex').slice(0, 10);
  const hashes = frames.map(frameHash), allHash = createHash('sha1').update(hashes.join()).digest('hex').slice(0, 12);
  console.log(JSON.stringify({ file: process.argv[2], fps, frames: frames.length, hash: allHash, sampleHashes: hashes.filter((_, i) => i % 300 === 0), hits: hits.length, eyeP95: +(eyes[Math.floor(0.95 * (eyes.length - 1))] ?? 0).toFixed(2), handMinCm: clear.length ? +(Math.min(...clear) * 100).toFixed(2) : null }));
  for (const h of hits) console.log(JSON.stringify(h));
}
