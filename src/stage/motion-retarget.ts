/**
 * Stage side of motion retargeting (shared/motion-retarget.ts) and the quality
 * check (shared/motion-fit.ts). Imports only Three core, never the MMD loader,
 * so it runs in tests without `three/examples`.
 *
 * - Every catalog motion is reviewed on the bundled Gene, so a VMD whose bytes
 *   match a catalog sha256 has Gene as its source rig. Other VMDs (the user's
 *   own) pass through untouched, as before.
 * - The host-verified Gene (`reviewed`) gets no transform at all: its load path
 *   is byte-for-byte the old one. Any other model gets a plan from both rigs; a
 *   numerically identical rig still plans as identity.
 * - Results are cached in memory per (motion sha256, every rig input the
 *   conversion and its fit read: retargetInputKey): switching models or
 *   reloading a motion does not redo the work, and two models with one
 *   skeleton but another profile (collision, mapping) never share (X-322).
 * - Universal skeleton step 1: the scores (not the converted data) are also stored per model content by the host
 *   (shared/motion-fit-record.ts, electron/motion-fit-store.ts). The first load scores every library motion once; the same
 *   model's next load starts from the stored scores and its scan skips them. Playing a motion still converts it (in memory).
 */
import { Matrix4, Vector3, type SkinnedMesh } from 'three';
import catalogData from '../../shared/motion-catalog.json';
import { sha256Hex } from '../../shared/sha256-sync';
import type { MotionCatalog, MotionPackId } from '../../shared/motion-library';
import type { ModelProfile } from '../../shared/model-profile';
import { RETARGET_ALGORITHM_VERSION, RETARGET_VERSION, STANDARD_SOURCE_RIG, buildRetargetRig, planRetarget, type RetargetPlan, type RetargetRig, type RigBone, type VmdLike } from '../../shared/motion-retarget';
import { adaptMotion, type MotionFit, type MotionFitStatus } from '../../shared/motion-fit';
import { contactFor } from '../../shared/motion-contact';
import { MOTION_FIT_RECORD_VERSION, MOTION_SCORE_STAMP, acceptMotionFitRecord, type MotionFitRecord } from '../../shared/motion-fit-record';
import { standardPartOfTrack, type FingerSlot, type StandardBone } from '../../shared/universal-skeleton';

const catalog = catalogData as MotionCatalog;
/** Gene's rig, the source of every library motion: the universal skeleton's standard pose. */
export const GENE_SOURCE_RIG: RetargetRig = STANDARD_SOURCE_RIG;
interface CatalogEntry { packId: string; motionId: string; name: string }
const CATALOG_BY_SHA = new Map<string, CatalogEntry>(catalog.packs.flatMap(pack =>
  pack.motions.map(motion => [motion.sha256, { packId: pack.id, motionId: motion.id, name: motion.name }] as const)));
export const CATALOG_MOTION_COUNT = CATALOG_BY_SHA.size;

/**
 * One catalog motion on this model. T-213 keeps the layers apart: `status` is how it looks (the quality check), `basis` what
 * that rests on ('sampled' on this model, or 'source': played exactly as on the reviewed Gene, nothing sampled), `samples` how
 * many poses were checked, `lost` the standard/finger tracks that bind to nothing here (it plays without them).
 */
export interface MotionFitEntry {
  packId: string; motionId: string; name: string; status: MotionFitStatus; issues: string[]; adjustments: string[];
  /** lost: standard part ids (bones or finger joints, e.g. wristRight, index1Right), never a model's own names. */
  basis: 'source' | 'sampled'; samples: number; lost: (StandardBone | FingerSlot)[];
}
/** Plain, path-free summary for `data-motion-fit`, the dev panel and the agent channel ("32 个动作里 28 个可用"). */
export interface MotionFitSummary {
  model: 'reviewed' | 'adapted' | 'unavailable';
  total: number;
  checked: number;
  usable: number;
  ok: number;
  adjusted: number;
  hidden: number;
  hiddenMotions: string[];
  adjustedMotions: string[];
  /** T-213: checked motions that play here without some of their standard or finger tracks (see MotionFitEntry.lost). */
  partial: number;
  partialMotions: string[];
  /** T-213: body bones hanging elsewhere than in Gene's skeleton (e.g. "head under center, not neck"); motions pulling them apart are hidden. */
  structure: string[];
  scan: 'none' | 'running' | 'done' | 'stopped';
  /** Rest arm alignment applied (A/T pose difference), degrees. */
  armAlignDeg: number | null;
  scale: number | null;
}
export interface MotionFitView { summary: MotionFitSummary; motions: Record<string, MotionFitStatus> }
export const motionFitKey = (packId: string, motionId: string) => `${packId}/${motionId}`;

// ---------------------------------------------------------------- cache

interface CachedMotion { vmd: VmdLike; fit: MotionFit }
export const RETARGET_CACHE_LIMIT = 96;
const cache = new Map<string, CachedMotion>();
export const retargetCacheStats = { hits: 0, misses: 0 };
export function clearRetargetCache(): void { cache.clear(); retargetCacheStats.hits = retargetCacheStats.misses = 0; }
export const retargetCacheSize = () => cache.size;
function cached(key: string, compute: () => CachedMotion): CachedMotion {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); retargetCacheStats.hits++; return hit; }
  retargetCacheStats.misses++;
  const value = compute();
  cache.set(key, value);
  while (cache.size > RETARGET_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return value;
}

/** The source tracks a motion plays without, as standard part ids (Gene's 右人指１ → index1Right), once each, bounded. */
function lostParts(names: readonly string[] | undefined): (StandardBone | FingerSlot)[] {
  const out = new Set<StandardBone | FingerSlot>();
  for (const name of names ?? []) { const part = standardPartOfTrack(name); if (part) out.add(part); if (out.size >= 64) break; }
  return [...out];
}

/**
 * The stage's two hooks to the host's stored scores for the model it loads (`cache`: what requestModelProfileCache returned):
 * the stored record to start from, and a save naming this model's content key (the host refuses it once the model changed).
 */
export function motionFitStorage(cache: { modelKey: string; motionFits?: unknown } | null | undefined,
  desktop: { saveMotionFits?: (modelKey: string, record: unknown) => Promise<boolean> } | undefined): { stored?: unknown; persist?: (record: MotionFitRecord) => void } {
  if (!cache || typeof cache.modelKey !== 'string') return {};
  return { stored: cache.motionFits ?? null, persist: record => { try { void desktop?.saveMotionFits?.(cache.modelKey, record)?.catch(() => {}); } catch { /* never breaks loading */ } } };
}

// ---------------------------------------------------------------- rig from the loaded mesh

/** Rest hierarchy in model space, as read once while the skeleton is still at rest (same frame as the profile). */
export function meshRigBones(mesh: SkinnedMesh): RigBone[] {
  const bones = mesh.skeleton?.bones ?? [];
  const order = new Map<object, number>(bones.map((bone, index) => [bone, index]));
  mesh.updateMatrixWorld(true);
  const toModel = new Matrix4().copy(mesh.matrixWorld).invert();
  return bones.map(bone => {
    const point = bone.getWorldPosition(new Vector3()).applyMatrix4(toModel);
    return { name: bone.name, parent: bone.parent ? order.get(bone.parent) ?? -1 : -1, position: [point.x, point.y, point.z] };
  });
}

export function meshMorphNames(mesh: SkinnedMesh): string[] {
  const names: string[] = [];
  for (const [name, index] of Object.entries(mesh.morphTargetDictionary ?? {})) if (Number.isInteger(index) && index >= 0 && index < 65_536) names[index] = name;
  return Array.from(names, name => name ?? '');
}

/** Content key of a rig (names and rest positions): the model's identity, independent of paths. Not enough for the cache alone (X-322). */
export function rigKey(bones: readonly RigBone[], morphNames: readonly string[]): string {
  const round = (value: number) => Math.round(value * 1e5) / 1e5;
  return `rig:${sha256Hex(JSON.stringify([bones.map(bone => [bone.name, bone.parent, bone.position.map(round)]), morphNames]))}`;
}

/** JSON with object keys sorted, so equal content always gives the same text (a profile read back from disk may order keys differently). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * X-322 (Codex, T-213 retest): the identity of everything a conversion and its fit read, the cache key's model half. The
 * plan is a pure function of its two rigs, so both are digested whole: bones and rest positions, the standard-bone and
 * finger slots (the profile's mapping), proportions, morph slots and names, the collision proxy, and any field a rig
 * carries later. The rigKey alone left the profile out: two models with one skeleton but another collision profile shared
 * the first one's conversion and verdict.
 */
export function retargetInputKey(plan: Pick<RetargetPlan, 'source' | 'target'>): string {
  return `fit:${sha256Hex(canonicalJson({ source: plan.source, target: plan.target }))}`;
}

// ---------------------------------------------------------------- per loaded model

export type VmdTransform = <T extends VmdLike>(vmd: T, buffer: ArrayBuffer) => T;

export class StageMotionRetarget {
  /** null for the reviewed Gene, or when no plan could be made (motions then pass through as before). */
  readonly plan: RetargetPlan | null = null;
  readonly rig: RetargetRig | null = null;
  readonly reviewed: boolean;
  /** Parser hook; undefined for the reviewed Gene so its VMD path stays exactly as it was. */
  readonly transform: VmdTransform | undefined;
  /** retargetInputKey of the plan, taken once the plan is made (the cache key's model half); '' without a plan. */
  private readonly inputKey: string = '';
  private readonly fits = new Map<string, MotionFitEntry>();
  private readonly bySha = new Map<string, MotionFitEntry>();
  private scanState: MotionFitSummary['scan'] = 'none';
  /** Each score as last stored (by motion sha256), and whether this session scored anything new since. */
  private readonly stored = new Map<string, string>();
  private dirty = false;
  private readonly persist: ((record: MotionFitRecord) => void) | undefined;

  constructor(mesh: SkinnedMesh, profile: ModelProfile | null, options: { reviewed: boolean; onChange?: (view: MotionFitView) => void; source?: RetargetRig;
    /** The host's stored scores for this model (getModelProfile's motionFits); used only when made for this very plan and check. */
    stored?: unknown;
    /** Called with the scores once a scan scored something new (the host stores them for the next load). */
    persist?: (record: MotionFitRecord) => void }) {
    this.reviewed = options.reviewed === true;
    this.onChange = options.onChange;
    if (!this.reviewed && profile) {
      try {
        const bones = meshRigBones(mesh), morphNames = meshMorphNames(mesh);
        this.rig = buildRetargetRig({ key: rigKey(bones, morphNames), profile, bones, morphNames });
        this.plan = planRetarget(options.source ?? GENE_SOURCE_RIG, this.rig);
        this.inputKey = retargetInputKey(this.plan);
      } catch { this.rig = null; this.plan = null; this.inputKey = ''; }
    }
    this.transform = this.plan ? (<T extends VmdLike>(vmd: T, buffer: ArrayBuffer): T => this.adapt(vmd, buffer)) : undefined;
    this.persist = this.plan ? options.persist : undefined;
    if (this.plan && options.stored !== undefined && options.stored !== null) this.restore(options.stored);
  }

  /** Takes the stored scores made for this plan and check, for the motions the library still has under the same id. */
  private restore(stored: unknown): void {
    const record = acceptMotionFitRecord(stored, { stamp: MOTION_SCORE_STAMP, input: this.inputKey });
    if (!record) return;
    for (const row of record.motions) {
      const entry = CATALOG_BY_SHA.get(row.sha256);
      if (!entry || entry.packId !== row.pack || entry.motionId !== row.motion) continue; // the library changed: scored again
      const value: MotionFitEntry = { ...entry, status: row.status, issues: [...row.issues], adjustments: [...row.adjustments], basis: row.basis,
        samples: row.samples, lost: [...row.lost] };
      this.fits.set(motionFitKey(entry.packId, entry.motionId), value); this.bySha.set(row.sha256, value);
      this.stored.set(row.sha256, JSON.stringify(value));
    }
  }

  /** The scores as the host stores them: standard part words and numbers only, by motion content hash. */
  storedRecord(): MotionFitRecord | null {
    if (!this.plan || !this.inputKey) return null;
    const head = { version: MOTION_FIT_RECORD_VERSION, stamp: MOTION_SCORE_STAMP, input: this.inputKey } as const;
    const motions = [...this.bySha].map(([sha256, entry]) => ({ sha256, pack: entry.packId, motion: entry.motionId, status: entry.status, basis: entry.basis,
      samples: entry.samples, issues: [...entry.issues], adjustments: [...entry.adjustments], lost: [...entry.lost] }))
      // Only what the host accepts: a score whose text it would refuse is simply scored again next time.
      .filter(motion => acceptMotionFitRecord({ ...head, motions: [motion] }) !== null);
    return { ...head, motions };
  }
  private save(): void {
    if (!this.dirty || !this.persist) return;
    const record = this.storedRecord();
    if (!record) return;
    this.dirty = false;
    for (const motion of record.motions) this.stored.set(motion.sha256, JSON.stringify(this.bySha.get(motion.sha256)));
    try { this.persist(record); } catch { /* storing never breaks loading */ }
  }
  private readonly onChange: ((view: MotionFitView) => void) | undefined;

  /**
   * The parser hook that also reports which library motion (sha256) the bytes
   * were, once its fit is recorded, so the Stage can judge the loaded clip by
   * it (R29d: a selected layer that does not suit this model is held).
   * undefined exactly when `transform` is.
   */
  transformFor(report: (sha256: string) => void): VmdTransform | undefined {
    return this.plan ? (<T extends VmdLike>(vmd: T, buffer: ArrayBuffer): T => this.adapt(vmd, buffer, report)) : undefined;
  }

  /** Retargets a catalog motion (cached) and records its fit; anything else is returned as is. */
  adapt<T extends VmdLike>(vmd: T, buffer: ArrayBuffer, report?: (sha256: string) => void): T {
    const plan = this.plan;
    if (!plan) return vmd;
    let sha: string;
    try { sha = sha256Hex(buffer); } catch { return vmd; }
    const entry = CATALOG_BY_SHA.get(sha);
    if (!entry) return vmd;
    // X-322: keyed by everything the conversion and fit read (both rigs whole, profile included), not the rigKey alone.
    const result = cached(`${sha}|${this.inputKey}|v${RETARGET_VERSION}.${RETARGET_ALGORITHM_VERSION}`, () => {
      // Skeleton step 4: a motion whose hands touch (鼓掌, 比心) carries its contact annotation; every other motion gets none.
      const adapted = adaptMotion(vmd, plan, { contact: contactFor(sha) });
      return { vmd: adapted.vmd, fit: adapted.fit };
    });
    this.record(sha, entry, result.fit);
    try { report?.(sha); } catch { /* a reporting observer never breaks loading */ }
    return result.vmd as T;
  }

  private record(sha: string, entry: CatalogEntry, fit: MotionFit): void {
    const value: MotionFitEntry = { ...entry, status: fit.status, issues: fit.issues.map(issue => `${issue.check}: ${issue.where}`), adjustments: [...fit.adjustments],
      basis: fit.basis ?? (fit.samples > 0 ? 'sampled' : 'source'), samples: fit.samples, lost: lostParts(fit.lost) };
    const key = motionFitKey(entry.packId, entry.motionId), previous = this.fits.get(key);
    this.fits.set(key, value); this.bySha.set(sha, value);
    if (this.stored.get(sha) !== JSON.stringify(value)) this.dirty = true;
    if (previous?.status !== value.status) this.notify();
  }
  private notify(): void { try { this.onChange?.(this.view()); } catch { /* observers never break loading */ } }
  /** Publishes the current view once (on model load). */
  announce(): void { this.notify(); }

  /** Fit of a loaded motion by its sha256 (chat gestures carry the host's hash). */
  fitOf(sha256: string): MotionFitEntry | undefined { return this.bySha.get(sha256); }
  statusOf(packId: string, motionId: string): MotionFitStatus | undefined {
    return this.reviewed ? 'ok' : this.fits.get(motionFitKey(packId, motionId))?.status;
  }

  summary(): MotionFitSummary {
    const entries = [...this.fits.values()];
    const count = (status: MotionFitStatus) => entries.filter(entry => entry.status === status).length;
    const align = this.plan ? Object.values(this.plan.alignedDeg) : [];
    const base = { total: CATALOG_MOTION_COUNT, armAlignDeg: align.length ? Math.max(...align) : null, scale: this.plan ? Math.round(this.plan.scale * 1000) / 1000 : null,
      structure: (this.plan?.structure ?? []).map(row => `${row.bone} under ${row.actual ?? 'root'}, not ${row.expected ?? 'root'}`) };
    if (this.reviewed) return { model: 'reviewed', ...base, checked: CATALOG_MOTION_COUNT, usable: CATALOG_MOTION_COUNT, ok: CATALOG_MOTION_COUNT, adjusted: 0, hidden: 0,
      hiddenMotions: [], adjustedMotions: [], partial: 0, partialMotions: [], scan: 'none' };
    const partial = entries.filter(entry => entry.lost.length);
    return { model: this.plan ? 'adapted' : 'unavailable', ...base, checked: entries.length, usable: count('ok') + count('adjusted'), ok: count('ok'),
      adjusted: count('adjusted'), hidden: count('hidden'), hiddenMotions: entries.filter(entry => entry.status === 'hidden').map(entry => motionFitKey(entry.packId, entry.motionId)),
      adjustedMotions: entries.filter(entry => entry.status === 'adjusted').map(entry => motionFitKey(entry.packId, entry.motionId)),
      partial: partial.length, partialMotions: partial.map(entry => motionFitKey(entry.packId, entry.motionId)), scan: this.scanState };
  }
  view(): MotionFitView {
    const motions: Record<string, MotionFitStatus> = {};
    for (const [key, entry] of this.fits) motions[key] = entry.status;
    return { summary: this.summary(), motions };
  }

  /**
   * Checks every catalog motion on this model, one at a time, yielding between
   * motions. `resolve` grants a motion's URL (controls window only), `read`
   * fetches its bytes and `parse` runs the real VMD parser with this transform.
   */
  async scan(deps: { resolve(packId: MotionPackId, motionId: string): Promise<string>; read(url: string): Promise<ArrayBuffer>; parse(buffer: ArrayBuffer): unknown;
    current(): boolean; pause?(): Promise<void> }): Promise<MotionFitSummary> {
    if (!this.plan || this.scanState === 'running') return this.summary();
    this.scanState = 'running'; this.notify();
    try {
      for (const pack of catalog.packs) for (const motion of pack.motions) {
        if (!deps.current()) { this.scanState = 'stopped'; return this.summary(); }
        if (this.fits.has(motionFitKey(pack.id, motion.id))) continue;
        try {
          const url = await deps.resolve(pack.id, motion.id);
          if (!deps.current()) { this.scanState = 'stopped'; return this.summary(); }
          deps.parse(await deps.read(url));
        } catch { /* a motion that cannot be read stays unchecked */ }
        await (deps.pause?.() ?? new Promise(resolve => setTimeout(resolve, 16)));
      }
      this.scanState = 'done';
    } finally {
      if (this.scanState === 'running') this.scanState = 'stopped';
      this.save();
      this.notify();
    }
    return this.summary();
  }
}
