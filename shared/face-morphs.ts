/**
 * The one rule for "which morph of this model is this face action's shape" (T-215, universal skeleton step 1). The stage
 * runs it on the loaded mesh right before a face action plays (src/stage/face-exclusive.ts re-exports it; MmdStage passes the
 * mesh's names and real vertex movement); the model profile runs the same function once per model for the named face shapes
 * (shared/model-profile.ts faceShapes); the card (shared/her-actions.ts herActionSupport) runs it again on what the profile
 * found. So the card can no longer say "能做" for an action the stage will skip for a missing shape.
 * Pure: no Three, no I/O; type-only imports, so it sits below her-actions and the profile without a cycle.
 */
import type { HerFaceMorph } from './her-actions';
import type { MorphSlot } from './universal-skeleton';

/** How a face morph is looked up. `slot` → the profile's vertex-checked index (-1 missing), or null with no profile. */
export interface FaceMorphLookup {
  /** Morph name → index (a Three morphTargetDictionary: a repeated name keeps its last index). */
  names: Readonly<Record<string, number>> | undefined;
  count: number;
  slot(slot: MorphSlot): number | null;
  /** The morph moves at least one vertex (a material or bone morph of the same name does not count). */
  displaces(index: number): boolean;
}
/** Names compared NFKC, lower case, without spaces, "_", "-" and ".". */
export const normalizedMorphName = (name: string) => name.normalize('NFKC').toLowerCase().replace(/[\s_.\-]/g, '');

/** Three's Mesh.updateMorphTargets dictionary for these target names: an empty name is its index, a repeated name keeps the last. */
export function morphDictionary(names: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  names.forEach((name, index) => { out[name || String(index)] = index; });
  return out;
}

type MorphRef = Pick<HerFaceMorph, 'track' | 'slot' | 'aliases'>;
/** The index a morph resolves to on this lookup before the vertex check, or -1. */
function finder(lookup: FaceMorphLookup): (morph: MorphRef) => number {
  const names = lookup.names ?? {};
  const byNormalized = new Map<string, number>();
  for (const [name, index] of Object.entries(names)) {
    if (!Number.isInteger(index) || index < 0 || index >= lookup.count) continue;
    const key = normalizedMorphName(name);
    if (!byNormalized.has(key)) byNormalized.set(key, index);
  }
  return morph => {
    const slotted = morph.slot ? lookup.slot(morph.slot) : null;
    if (slotted !== null) return Number.isInteger(slotted) && slotted >= 0 && slotted < lookup.count ? slotted : -1;
    const exact = names[morph.track];
    if (Number.isInteger(exact) && exact >= 0 && exact < lookup.count) return exact;
    for (const alias of [morph.track, ...morph.aliases]) { const index = byNormalized.get(normalizedMorphName(alias)); if (index !== undefined) return index; }
    return -1;
  };
}

/** One morph write of a face action: the clip track `from`, its keys times `gain`, onto this model's morph `index`. */
export interface FaceWrite { from: string; index: number; gain: number }
/**
 * Skeleton step 2: a face morph this model lacks, played with its own near shapes instead: the missing part and what it is
 * built from (the user's words), and whether it is lighter than the real shape.
 */
export interface FaceApproximation { part: string; using: string[]; lighter: boolean }
export interface ResolvedFaceMorphs {
  /** Each of the clip's morphs the model has: track name → index (written as the clip says). */
  indices: Map<string, number>;
  /** Everything to write: the morphs above (gain 1, in the clip's order), then the stand-ins. */
  writes: FaceWrite[];
  /** Required parts missing (a stand-in's missing required parts follow the morph's own). Empty: it plays. */
  missing: string[];
  /** The morphs played as an approximation (empty: none). */
  approximations: FaceApproximation[];
}

/**
 * The face action's morphs on this model. A morph with a profile slot is the slot's vertex-checked index (no name fallback
 * when the profile says missing); the others by exact name, then the aliases; a shape that moves nothing counts as missing.
 * Skeleton step 2: a missing morph with a stand-in (撅嘴 without 嘟嘴: the model's own "う" lighter, plus the corners; 眨一只眼
 * without that eye's wink: the other eye's) is played with it when every required stand-in part is there, and is reported as
 * an approximation; otherwise a required morph is missing, together with what its stand-in lacked.
 */
export function resolveFaceMorphs(face: { readonly morphs: readonly HerFaceMorph[] }, lookup: FaceMorphLookup): ResolvedFaceMorphs {
  const indices = new Map<string, number>(), writes: FaceWrite[] = [], missing: string[] = [], approximations: FaceApproximation[] = [];
  const find = finder(lookup), found = (morph: MorphRef) => { const index = find(morph); return index >= 0 && lookup.displaces(index) ? index : -1; };
  const absent: HerFaceMorph[] = [];
  for (const morph of face.morphs) {
    const index = found(morph);
    if (index >= 0) { indices.set(morph.track, index); writes.push({ from: morph.track, index, gain: 1 }); }
    else absent.push(morph);
  }
  // Stand-ins after the model's own morphs: a stand-in skipped because the model has what it would add (`unless`) needs them known.
  for (const morph of absent) {
    const parts = morph.standIn ?? [], using: string[] = [], lacking: string[] = [], added: FaceWrite[] = [];
    for (const part of parts) {
      if (part.unless.some(track => indices.has(track))) { using.push(part.words); continue; }
      const index = found(part);
      if (index >= 0) { using.push(part.words); added.push({ from: part.from, index, gain: part.gain }); }
      else if (part.required) lacking.push(part.words);
    }
    if (parts.length && !lacking.length && added.length) {
      writes.push(...added);
      approximations.push({ part: morph.part, using, lighter: added.some(write => write.gain < 1) });
    } else if (morph.required) missing.push(morph.part, ...lacking);
  }
  return { indices, writes, missing, approximations };
}

/** Several shapes found by name (no slot) with the same rule: shape name → index, only those that move vertices. */
export function resolveNamedFaceShapes<K extends string>(shapes: Readonly<Record<K, readonly string[]>>, lookup: FaceMorphLookup): Partial<Record<K, number>> {
  const find = finder(lookup), out: Partial<Record<K, number>> = {};
  for (const track of Object.keys(shapes) as K[]) {
    const index = find({ track, slot: null, aliases: shapes[track] });
    if (index >= 0 && lookup.displaces(index)) out[track] = index;
  }
  return out;
}
