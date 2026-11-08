/**
 * Model lab analysis (docs/claude/2026-11-02-model-lab.md): one PMX in, one
 * plain report out. Every decision comes from the app's own code:
 * - the profile and collision proxy from the stage adapter
 *   (src/stage/model-profile.ts `StageModelProfile`, as a model that is not the
 *   host-verified Gene), fed by the MMDLoader-equivalent mesh of pmx-mesh.ts;
 * - the retarget plan from src/stage/motion-retarget.ts `StageMotionRetarget`
 *   (Gene source rig, same rig key), and each bundled motion through
 *   shared/motion-fit.ts `adaptMotion`, which is what the stage's VMD parser
 *   hook calls for catalog motions; motions are parsed with the stage's
 *   `createVmdParser` (header repair, default-track strip).
 * The lab only adds read-only diagnostics on the result: the arm clearance of
 * every check sample (`armClearance`, 1 is the line) and, for hidden motions,
 * the flagged sample times (`fitSamples`). No file or network access here.
 */
import { createHash } from 'node:crypto';
import bundledAssets from '../../shared/bundled-assets.json';
import catalogData from '../../shared/motion-catalog.json';
import type { MotionCatalog } from '../../shared/motion-library';
import {
  CORE_BONES, MODEL_PROFILE_VERSION, MORPH_SLOTS, buildModelProfile, profileBindings, standardBoneOfName,
  type ModelProfile, type ModelProfileInput, type ModelProfileSummary, type MorphSlot, type SlotPolicy, type StandardBone,
} from '../../shared/model-profile';
import { COLLISION_PROXY_VERSION, classifyProxyBones, type ProxySegment } from '../../shared/collision-proxy';
import { contactFor } from '../../shared/motion-contact';
import { RETARGET_VERSION, tracksOnRig, vlength, vsub, type RetargetPlan, type RetargetReport, type VmdLike } from '../../shared/motion-retarget';
import {
  adaptMotion, armClearance, fitFrames, fitSamples, usesFittedBody, type AdaptedMotion, type FitIssue, type MotionFitStatus,
} from '../../shared/motion-fit';
import { StageModelProfile, modelProfileInput } from '../../src/stage/model-profile';
import { GENE_SOURCE_RIG, StageMotionRetarget } from '../../src/stage/motion-retarget';
import { createVmdParser } from '../../src/stage/vmd';
import type { VmdTrackData, VmdTrackReport } from '../../src/stage/vmd-tracks';
import { labMesh, readPmx, type LabMesh, type PmxConversion } from './pmx-mesh';

export const MODEL_LAB_VERSION = 1;
const catalog = catalogData as MotionCatalog;
export const BUNDLED_GENE_SHA256 = bundledAssets.model.sha256;

// ---------------------------------------------------------------- motions

export interface LabMotion {
  packId: string;
  motionId: string;
  name: string;
  category: string;
  sha256: string;
  /** Parsed and default-stripped exactly as the stage's parser hook receives it. */
  vmd: VmdTrackData;
  durationFrames: number;
}
export const motionKey = (motion: { packId: string; motionId: string }) => `${motion.packId}/${motion.motionId}`;
export interface CatalogMotionFile { packId: string; motionId: string; name: string; category: string; sha256: string; relativePath: string }

/** Catalog entries with their bundled path (relative to the repository root) and pinned sha256. */
export function catalogMotionFiles(): CatalogMotionFile[] {
  return catalog.packs.flatMap(pack => pack.motions.map(motion => ({ packId: pack.id, motionId: motion.id, name: motion.name, category: motion.category,
    sha256: motion.sha256, relativePath: `assets/bundled/${pack.source}/${pack.id}/${pack.revision}/${motion.relativePath}` })));
}

/** Parses one bundled VMD the way the stage does; the bytes must match the catalog (the app only retargets catalog motions). */
export function labMotion(entry: CatalogMotionFile, bytes: Uint8Array): LabMotion {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== entry.sha256) throw new Error(`${motionKey(entry)}: bytes do not match the catalog sha256`);
  let durationFrames = 0;
  const parser = createVmdParser((report: VmdTrackReport) => { durationFrames = report.durationFrames; }) as
    { parseVmd(buffer: ArrayBuffer, leftToRight: boolean): VmdTrackData };
  const vmd = parser.parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, true);
  return { packId: entry.packId, motionId: entry.motionId, name: entry.name, category: entry.category, sha256, vmd, durationFrames };
}

// ---------------------------------------------------------------- report shape

export interface Clearance {
  /** Arm axis distance over the capsule radius, over its penetration depth: below 1 is flagged as penetration. */
  value: number;
  side: 'Left' | 'Right';
  /** Torso capsule (pelvis/abdomen/chest/neck, or "torso" for the rough body) or "head". */
  segment: string;
  frame: number;
  seconds: number;
}
export interface LabMotionResult {
  key: string;
  packId: string;
  motionId: string;
  name: string;
  category: string;
  seconds: number;
  status: MotionFitStatus;
  /** Still failing (hidden only), and what failed before the automatic correction. */
  issues: FitIssue[];
  before: FitIssue[];
  adjustments: string[];
  /** Check samples (0: identity plan, the app does not check a rig equal to Gene's). */
  samples: number;
  /** Tightest arm clearance over the check samples, after any correction (null: no arm, or no such capsule). */
  margin: { torso: Clearance | null; head: Clearance | null };
  retarget: Pick<RetargetReport, 'renamed' | 'folded' | 'droppedBones' | 'droppedMorphs' | 'mappedMorphs' | 'bakedLegIk'>;
  ms: number;
}
export interface WatchMoment {
  motion: string;
  status: MotionFitStatus;
  reason: string;
  /** Sample times worth a screenshot on the real app, seconds (worst first). */
  seconds: number[];
}
export interface ModelReport {
  tool: { name: 'soft-hearts model-lab'; version: number; profileVersion: number; collisionProxyVersion: number; retargetVersion: number };
  model: { id: string; file: string; path: string; bytes: number; sha256: string; bundledGene: boolean; name: { japanese: string; english: string } | null };
  /** In-memory conversion before parsing, as the app's mmd-asset protocol does it (UTF-8 text, PMX 2.1 → 2.0, additional-UV morph offsets
   * left out); null when the file is parsed as it is
   * or does not parse (`error` then names any conversion that was made). */
  conversion: PmxConversion | null;
  ok: boolean;
  error: string | null;
  counts: LabMesh['counts'] | null;
  profile: null | {
    summary: ModelProfileSummary;
    bones: { mapped: Partial<Record<StandardBone, string>>; missing: StandardBone[]; missingCore: StandardBone[];
      ambiguous: { bone: StandardBone; names: string[] }[]; features: ModelProfile['bones']['features'] };
    morphs: Record<MorphSlot, { name: string | null; index: number; policy: SlotPolicy; amplitude: number; scale: number; rejected: { name: string; reason: string }[] }>;
    /** What the stage writes for lip-sync, blink, smile and troubled brows (morph names), with calibrated scales by morph name. */
    bindings: { blink: string | null; blinkPartner: string | null; mouth: string | null; smile: string | null; sad: string | null; scales: Record<string, number> };
    restPose: { pose: ModelProfile['proportions']['restPose']; armDeg: number | null; alignedToGeneDeg: RetargetPlan['alignedDeg'] };
    proportions: { height: number; headSize: number; headsTall: number; shoulderWidth: number | null; armLength: number | null; legLength: number | null;
      eyeLine: ModelProfile['proportions']['eyeLineSource']; mouth: ModelProfile['proportions']['mouth']['source'] };
    /** This model over Gene (the motions' source). `translation` is the factor applied to root/center/IK moves. */
    relativeToGene: { height: number; legLength: number | null; armLength: number | null; shoulderWidth: number | null; headSize: number; translation: number | null };
  };
  collision: null | {
    /** The motion check uses these capsules (else its rough body: one torso capsule and a head sphere). */
    usedByCheck: boolean;
    capsules: { segment: ProxySegment; bone: StandardBone; radius: number; length: number; vertices: number }[];
    missing: ProxySegment[];
    /** Excluded hair/skirt/accessory/physics bones, grouped by the topmost excluded bone of each chain. */
    excluded: { bones: number; vertices: number; roots: { name: string; bones: number }[] };
  };
  retarget: null | { identity: boolean; scale: number; bakeLegIk: boolean; dropped: string[]; folded: string[] };
  motions: LabMotionResult[];
  totals: { motions: number; ok: number; adjusted: number; hidden: number; usable: number };
  tightest: { torso: (Clearance & { motion: string }) | null; head: (Clearance & { motion: string }) | null };
  watch: WatchMoment[];
  timings: { parseMs: number; meshMs: number; profileMs: number; planMs: number; motionsMs: number; diagnosticsMs: number; totalMs: number;
    perMotionMs: { median: number; max: number; slowest: string | null } };
}

// ---------------------------------------------------------------- helpers

const round = (value: number, digits = 4) => { const factor = 10 ** digits; return Math.round(value * factor) / factor; };
const roundOrNull = (value: number | null, digits = 4) => value === null || !Number.isFinite(value) ? null : round(value, digits);
const ratio = (value: number | null, reference: number | null) => value !== null && reference ? round(value / reference, 3) : null;
/** The last frame retargeting and the check use: the latest bone or morph key (as shared/motion-retarget.ts retargetTracks counts it). */
function lastFrameOf(vmd: VmdLike): number {
  let last = 0;
  for (const frame of vmd.motions) if (Number.isInteger(frame.frameNum) && frame.frameNum > last) last = frame.frameNum;
  for (const frame of vmd.morphs) if (Number.isInteger(frame.frameNum) && frame.frameNum > last) last = frame.frameNum;
  return last;
}
/** shared/collision-proxy.ts classifies excluded (hair/skirt/accessory/physics) bones as -2; cross-checked against the proxy's own count. */
const EXCLUDED_CLASS = -2;
const timer = () => { const start = performance.now(); return () => round(performance.now() - start, 1); };
const WATCH_TIGHTEST = 5, WATCH_TIMES = 8;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A report with nothing analysed yet (`error` set: a model that could not even be read). */
export function emptyReport(model: ModelReport['model'], error: string | null = null): ModelReport {
  return { tool: { name: 'soft-hearts model-lab', version: MODEL_LAB_VERSION, profileVersion: MODEL_PROFILE_VERSION, collisionProxyVersion: COLLISION_PROXY_VERSION,
    retargetVersion: RETARGET_VERSION }, model, conversion: null, ok: false, error, counts: null, profile: null, collision: null, retarget: null, motions: [],
  totals: { motions: 0, ok: 0, adjusted: 0, hidden: 0, usable: 0 }, tightest: { torso: null, head: null }, watch: [],
  timings: { parseMs: 0, meshMs: 0, profileMs: 0, planMs: 0, motionsMs: 0, diagnosticsMs: 0, totalMs: 0, perMotionMs: { median: 0, max: 0, slowest: null } } };
}

// ---------------------------------------------------------------- analysis

export interface AnalyzeInput { id: string; file: string; path: string; bytes: Uint8Array }

/** Profile, proxy and the whole motion library on one model. Never throws: a model the app could not load is reported as such. */
export function analyzeModel(input: AnalyzeInput, motions: readonly LabMotion[]): ModelReport {
  const total = timer();
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const report = emptyReport({ id: input.id, file: input.file, path: input.path, bytes: input.bytes.byteLength, sha256, bundledGene: sha256 === BUNDLED_GENE_SHA256, name: null });
  let lab: LabMesh | null = null;
  try {
    let clock = timer();
    const { data, conversion } = readPmx(input.bytes);
    report.conversion = conversion;
    report.timings.parseMs = clock();
    clock = timer();
    lab = labMesh(data);
    report.timings.meshMs = clock();
    report.model.name = lab.name; report.counts = lab.counts;

    clock = timer();
    const stage = new StageModelProfile(lab.mesh, { reviewed: false });
    report.timings.profileMs = clock();
    const profile = stage.profile;
    if (!profile) {
      // The stage falls back silently; rebuild once to name the cause.
      let reason = 'profile unavailable';
      try { buildModelProfile(modelProfileInput(lab.mesh)); } catch (error) { reason = `profile failed: ${errorText(error)}`; }
      report.error = `${reason} (the app falls back to plain name lookups and plays motions untransformed)`;
      return finish(report, total);
    }
    describeProfile(report, profile, stage, modelProfileInput(lab.mesh));

    clock = timer();
    const retarget = new StageMotionRetarget(lab.mesh, profile, { reviewed: false });
    report.timings.planMs = clock();
    const plan = retarget.plan;
    if (!plan) {
      report.error = 'no retarget plan (the app plays the library untransformed on this model)';
      return finish(report, total);
    }
    describePlan(report, plan);

    let motionsMs = 0, diagnosticsMs = 0;
    const adaptedByKey = new Map<string, AdaptedMotion<VmdTrackData>>();
    for (const motion of motions) {
      clock = timer();
      const adapted = adaptMotion(motion.vmd, plan, { contact: contactFor(motion.sha256) });
      const ms = clock();
      motionsMs += ms;
      adaptedByKey.set(motionKey(motion), adapted);
      clock = timer();
      report.motions.push(diagnose(motion, adapted, plan, ms));
      diagnosticsMs += clock();
    }
    summarizeMotions(report);
    clock = timer();
    report.watch = watchMoments(report, motions, adaptedByKey, plan);
    diagnosticsMs += clock();
    report.timings.motionsMs = round(motionsMs, 1); report.timings.diagnosticsMs = round(diagnosticsMs, 1);
    report.ok = true;
  } catch (error) {
    report.error = errorText(error);
  } finally {
    lab?.dispose();
  }
  return finish(report, total);
}

function finish(report: ModelReport, total: () => number): ModelReport {
  report.timings.totalMs = total();
  return report;
}

function describeProfile(report: ModelReport, profile: ModelProfile, stage: StageModelProfile, input: ModelProfileInput): void {
  const map = profile.bones.map, p = profile.proportions;
  const mapped: Partial<Record<StandardBone, string>> = {};
  for (const [slot, entry] of Object.entries(map) as [StandardBone, { name: string }][]) mapped[slot] = entry.name;
  const morphs = {} as NonNullable<ModelReport['profile']>['morphs'];
  for (const slot of MORPH_SLOTS) {
    const entry = profile.morphs[slot];
    morphs[slot] = { name: entry.name, index: entry.index, policy: entry.policy, amplitude: round(entry.amplitude), scale: round(entry.scale, 3),
      rejected: entry.rejected.map(row => ({ name: row.name, reason: row.reason })) };
  }
  // The stage's bindings (the same call StageModelProfile makes for a model that is not the reviewed Gene), named.
  const bindings = profileBindings(profile, false);
  const morphName = (index: number) => index >= 0 ? input.morphs[index]?.name ?? String(index) : null;
  const scales: Record<string, number> = {};
  for (const [index, scale] of bindings.scales) scales[morphName(index)!] = round(scale, 3);
  report.profile = {
    summary: stage.summary,
    bones: { mapped, missing: [...profile.bones.missing], missingCore: CORE_BONES.filter(bone => profile.bones.missing.includes(bone)),
      ambiguous: profile.bones.ambiguous.map(entry => ({ bone: entry.bone, names: [...entry.names] })), features: { ...profile.bones.features } },
    morphs,
    bindings: { blink: morphName(bindings.blink), blinkPartner: morphName(bindings.blinkPartner), mouth: morphName(bindings.mouth), smile: morphName(bindings.smile),
      sad: morphName(bindings.sad), scales },
    restPose: { pose: p.restPose, armDeg: roundOrNull(p.restArmDeg, 1), alignedToGeneDeg: {} },
    proportions: { height: round(p.height), headSize: round(p.headSize), headsTall: round(p.headsTall, 2), shoulderWidth: roundOrNull(p.shoulderWidth),
      armLength: roundOrNull(p.armLength), legLength: roundOrNull(p.legLength), eyeLine: p.eyeLineSource, mouth: p.mouth.source },
    relativeToGene: { height: round(p.height / GENE_SOURCE_RIG.height, 3), legLength: ratio(p.legLength, GENE_SOURCE_RIG.legLength),
      armLength: ratio(p.armLength, GENE_SOURCE_RIG.armLength), shoulderWidth: ratio(p.shoulderWidth, GENE_SOURCE_RIG.shoulderWidth),
      headSize: round(p.headSize / GENE_SOURCE_RIG.headSize, 3), translation: null },
  };
  const proxy = profile.collision;
  if (!proxy) return;
  // Excluded chains by their topmost excluded bone, from the classification the fit itself used.
  const slots: Partial<Record<StandardBone, number>> = {};
  for (const [slot, entry] of Object.entries(map) as [StandardBone, { index: number }][]) slots[slot] = entry.index;
  const excluded = classifyProxyBones({ bones: input.bones, slots, slotOfName: standardBoneOfName }).map(value => value === EXCLUDED_CLASS);
  const roots: { name: string; bones: number }[] = [];
  if (excluded.filter(Boolean).length === proxy.excluded.bones) {
    const rootOf = (index: number) => {
      let at = index;
      for (let guard = 0; guard < input.bones.length && input.bones[at].parent >= 0 && excluded[input.bones[at].parent]; guard++) at = input.bones[at].parent;
      return at;
    };
    const counts = new Map<number, number>();
    excluded.forEach((value, index) => { if (value) { const root = rootOf(index); counts.set(root, (counts.get(root) ?? 0) + 1); } });
    for (const [index, bones] of [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])) roots.push({ name: input.bones[index].name, bones });
  }
  report.collision = {
    usedByCheck: false,
    capsules: proxy.capsules.map(capsule => ({ segment: capsule.segment, bone: capsule.bone, radius: round(capsule.radius),
      length: round(vlength(vsub(capsule.b, capsule.a))), vertices: capsule.vertices })),
    missing: [...proxy.missing],
    excluded: { bones: proxy.excluded.bones, vertices: proxy.excluded.vertices, roots: roots.slice(0, 40) },
  };
}

function describePlan(report: ModelReport, plan: RetargetPlan): void {
  report.profile!.restPose.alignedToGeneDeg = { ...plan.alignedDeg };
  report.profile!.relativeToGene.translation = round(plan.scale, 3);
  if (report.collision) report.collision.usedByCheck = usesFittedBody(plan.target);
  const dropped: string[] = [], folded: string[] = [];
  for (const [slot, route] of Object.entries(plan.routes) as [StandardBone, NonNullable<RetargetPlan['routes'][StandardBone]>][]) {
    if (route.kind === 'drop') dropped.push(`${slot}: ${route.reason}`);
    else if (route.kind === 'fold') folded.push(`${slot} → ${route.via.join(' + ')}`);
  }
  report.retarget = { identity: plan.identity, scale: round(plan.scale, 4), bakeLegIk: plan.bakeLegIk, dropped, folded };
}

/** The motion as the model plays it: the written (retargeted, corrected) VMD bound to the target rig by bone name, as MMDLoader binds it. */
const playedTracks = (adapted: AdaptedMotion<VmdTrackData>, plan: RetargetPlan) => tracksOnRig(adapted.vmd, plan.target);

function diagnose(motion: LabMotion, adapted: AdaptedMotion<VmdTrackData>, plan: RetargetPlan, ms: number): LabMotionResult {
  const rig = plan.target, lastFrame = lastFrameOf(motion.vmd), tracks = playedTracks(adapted, plan);
  let torso: Clearance | null = null, head: Clearance | null = null;
  for (const frame of fitFrames(lastFrame)) {
    const clearance = armClearance(rig, tracks, frame);
    for (const side of ['Left', 'Right'] as const) {
      const value = clearance[side];
      if (!value) continue;
      if (Number.isFinite(value.torso) && (!torso || value.torso < torso.value)) torso = { value: value.torso, side, segment: value.segment || 'torso', frame, seconds: frame / 30 };
      if (Number.isFinite(value.head) && (!head || value.head < head.value)) head = { value: value.head, side, segment: 'head', frame, seconds: frame / 30 };
    }
  }
  const tidy = (entry: Clearance | null) => entry && { ...entry, value: round(entry.value, 3), seconds: round(entry.seconds, 2) };
  const { report: retargeted, fit } = adapted;
  return {
    key: motionKey(motion), packId: motion.packId, motionId: motion.motionId, name: motion.name, category: motion.category,
    seconds: round(Math.max(lastFrame, motion.durationFrames) / 30, 2), status: fit.status, issues: fit.issues.map(issue => ({ ...issue })),
    before: fit.before.map(issue => ({ ...issue })), adjustments: [...fit.adjustments], samples: fit.samples,
    margin: { torso: tidy(torso), head: tidy(head) },
    retarget: { renamed: retargeted.renamed, folded: [...retargeted.folded], droppedBones: [...retargeted.droppedBones], droppedMorphs: [...retargeted.droppedMorphs],
      mappedMorphs: { ...retargeted.mappedMorphs }, bakedLegIk: retargeted.bakedLegIk },
    ms,
  };
}

function summarizeMotions(report: ModelReport): void {
  const count = (status: MotionFitStatus) => report.motions.filter(motion => motion.status === status).length;
  report.totals = { motions: report.motions.length, ok: count('ok'), adjusted: count('adjusted'), hidden: count('hidden'), usable: count('ok') + count('adjusted') };
  for (const part of ['torso', 'head'] as const) {
    const best = report.motions.filter(motion => motion.margin[part]).sort((a, b) => a.margin[part]!.value - b.margin[part]!.value)[0];
    report.tightest[part] = best ? { ...best.margin[part]!, motion: best.key } : null;
  }
  const times = report.motions.map(motion => motion.ms).sort((a, b) => a - b);
  const slowest = report.motions.reduce<LabMotionResult | null>((worst, motion) => !worst || motion.ms > worst.ms ? motion : worst, null);
  report.timings.perMotionMs = { median: times.length ? times[Math.floor(times.length / 2)] : 0, max: slowest?.ms ?? 0, slowest: slowest?.key ?? null };
}

// ---------------------------------------------------------------- moments to compare on the real app

/**
 * Where to look on the real app: every hidden motion at its flagged samples
 * (worst first, on the tracks as played after the attempted correction), and
 * the motions whose arms come closest to the body or head (their tightest sample).
 */
function watchMoments(report: ModelReport, motions: readonly LabMotion[], adapted: ReadonlyMap<string, AdaptedMotion<VmdTrackData>>, plan: RetargetPlan): WatchMoment[] {
  const watch: WatchMoment[] = [];
  for (const result of report.motions.filter(entry => entry.status === 'hidden')) {
    const motion = motions.find(entry => motionKey(entry) === result.key), played = adapted.get(result.key);
    if (!motion || !played) continue;
    const samples = fitSamples(plan.target, playedTracks(played, plan), lastFrameOf(motion.vmd));
    for (const issue of result.issues) {
      const flagged = samples.filter(sample => sample.flags[issue.check])
        .sort((a, b) => b.flags[issue.check]!.value - a.flags[issue.check]!.value || a.frame - b.frame);
      watch.push({ motion: result.key, status: 'hidden', reason: `${issue.check}: ${issue.where} (${issue.samples} samples, worst ${issue.worst})`,
        seconds: flagged.slice(0, WATCH_TIMES).map(sample => round(sample.frame / 30, 2)) });
    }
  }
  const tight = report.motions.filter(entry => entry.status !== 'hidden')
    .flatMap(entry => (['torso', 'head'] as const).flatMap(part => entry.margin[part] ? [{ entry, part, margin: entry.margin[part]! }] : []))
    .sort((a, b) => a.margin.value - b.margin.value).slice(0, WATCH_TIGHTEST);
  for (const { entry, part, margin } of tight)
    watch.push({ motion: entry.key, status: entry.status,
      reason: `tightest ${part === 'head' ? 'hand-to-head' : `arm-to-${margin.segment}`} clearance ${margin.value} (${margin.side.toLowerCase()} arm; 1 is the line)`,
      seconds: [margin.seconds] });
  return watch;
}
