/**
 * I-154 follow-up (docs/claude/2026-11-20-unbound-full-shares.md): her capability card out in full-screen Unbound, so her face follows your
 * choices on the character page (能脸红, 能流泪, 能闭眼, 困的脸… turned off stay off out here too). The card is derived exactly as the
 * companion window's ModelCapabilitySync derives it (src/stage/model-capability-sync.ts): the names' profile of this load, your choices
 * from the host's record, and haiku's checked matches only once the record is matched to this model. Unlike the companion window this page
 * never asks haiku anything (the companion window's check does that, once per model); it only reads the record and its updates.
 */
import { acceptCachedProfile, deriveModelCapabilities, type ModelCapabilities, type ModelCapabilityView, type ModelProfile } from '../../../shared/stage';

/** What the card reads of this load's profile (src/stage/model-profile.ts StageModelProfile). */
export interface CardProfile { readonly namedProfile: ModelProfile | null; identity(): { vertices: number; bones: readonly string[]; morphs: readonly string[] } | null }

/** The record this page holds for the model shown: which model it belongs to and whether it is matched to this load. */
export interface HeldRecord { modelKey: string | null; matched: boolean; record: ModelCapabilityView['record'] }

/** The host's view (getModelCapabilities) for this load, or null when it is not one (junk, no profile). */
export function holdView(view: unknown, profile: CardProfile | null): HeldRecord | null {
  if (!view || typeof view !== 'object' || !profile?.namedProfile) return null;
  const value = view as Partial<ModelCapabilityView>, identity = profile.identity();
  const modelKey = typeof value.modelKey === 'string' ? value.modelKey : null;
  return { modelKey, matched: !!modelKey && !!identity && !!acceptCachedProfile(value.profile, identity), record: value.record ?? null };
}

/** A broadcast update (desk:model-capabilities) for the record held, or null when it is another model's. */
export function heldUpdate(held: HeldRecord | null, update: unknown): HeldRecord | null {
  if (!held || !update || typeof update !== 'object') return null;
  const value = update as { modelKey?: unknown; record?: unknown };
  if (typeof value.modelKey !== 'string' || value.modelKey !== held.modelKey || !value.record || typeof value.record !== 'object') return null;
  return { ...held, record: structuredClone(value.record) as ModelCapabilityView['record'] };
}

/** The card: this load's names, your choices, haiku's matches once matched (null without a profile). */
export function cardOf(held: HeldRecord | null, profile: CardProfile | null): ModelCapabilities | null {
  const named = profile?.namedProfile ?? null;
  if (!named) return null;
  try { return deriveModelCapabilities(named, held?.record?.choices ?? {}, held?.matched ? held.record?.haiku ?? {} : {}); } catch { return null; }
}
