/**
 * C1 角色和模型分开 (docs/claude/2026-11-03-character-model.md): which character card goes with a model.
 *
 * A card could carry a model
 * (switching to the card loaded its model), but loading another model left the card where it was, so one
 * character's persona and memories ended up on someone else's model. From now on a loaded model picks its card:
 *   1. a card already linked to this model: switch to it (the current card stays when it is one of them);
 *   2. an unlinked card whose name matches the model (PMX name, folder or file name): link it, then switch;
 *   3. otherwise a new card for this model: its own name, a one-line persona, the balanced mood template.
 * The preinstalled Gene card goes with the preinstalled Gene (`bundled:gene`) only, never with another model.
 *
 * Pure: no Node, DOM or Electron. The host reads the model's names (electron/character-model-link.ts).
 */
import {
  BUNDLED_CHARACTER_MODEL, CHARACTER_TEXT_LIMITS, defaultCharacterMoodTemplate, validateCharacterDraft, type CharacterDraft,
} from './character-cards';

/** What the decision needs from a card: its id, name and (host-only) model link. */
export interface CharacterModelCard { id: string; name: string; modelPath?: string }

export type CharacterModelDecision =
  /** The current card already goes with this model. */
  | { kind: 'keep'; id: string }
  /** Rule 1: another card is linked to this model. */
  | { kind: 'switch'; id: string }
  /** Rule 2: an unlinked card with a matching name; link it (and switch, when it is not the current card). */
  | { kind: 'bind'; id: string }
  /** Rule 3: a new card for this model. */
  | { kind: 'create'; name: string };

export interface CharacterModelInput {
  cards: readonly CharacterModelCard[];
  activeId: string;
  /** The preinstalled Gene card (its installation record), or null when there is none. */
  presetGeneId: string | null;
  /** `bundled:gene` for the preinstalled Gene, otherwise the model file's absolute path. */
  reference: string;
  /** The names this model goes by: PMX/PMD model names, the folder name, the file name (any may be empty). */
  names: readonly string[];
  /** The name a new card gets (characterNameForModel). */
  newName: string;
}

/** Case, width and spacing do not make two names different ("Ｇｅｎｅ " is "gene"). */
export function normalizeCharacterName(value: string): string {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Windows paths: one file whatever the case or separators. `bundled:gene` only equals itself. */
export function sameModelReference(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  if (a === BUNDLED_CHARACTER_MODEL || b === BUNDLED_CHARACTER_MODEL) return a === b;
  const clean = (value: string) => value.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase();
  return clean(a) === clean(b);
}

/** The model a card goes with: its own link, and the preinstalled Gene always with the preinstalled Gene. */
export function effectiveCardModel(card: CharacterModelCard, presetGeneId: string | null): string | undefined {
  if (presetGeneId !== null && card.id === presetGeneId) return BUNDLED_CHARACTER_MODEL;
  return card.modelPath;
}

export function decideCharacterForModel(input: CharacterModelInput): CharacterModelDecision {
  const { cards, activeId, presetGeneId, reference } = input;
  // Rule 1: the cards already linked to this model; the current one stays when it is among them.
  const linked = cards.filter(card => sameModelReference(effectiveCardModel(card, presetGeneId), reference));
  if (linked.some(card => card.id === activeId)) return { kind: 'keep', id: activeId };
  if (linked.length) return { kind: 'switch', id: linked[0].id };
  // Rule 2: an unlinked card (never the preinstalled Gene) whose name is one of the model's names.
  const names = new Set(input.names.map(normalizeCharacterName).filter(Boolean));
  const unlinked = cards.filter(card => effectiveCardModel(card, presetGeneId) === undefined && names.has(normalizeCharacterName(card.name)));
  const named = unlinked.find(card => card.id === activeId) ?? unlinked[0];
  if (named) return { kind: 'bind', id: named.id };
  // Rule 3.
  return { kind: 'create', name: input.newName };
}

/**
 * Startup migration (existing profiles): only a current card linked to some other model is wrong. A current card
 * without a link keeps the model it is shown with (the old "未关联模型，启用时保留当前 MMD"), so nothing moves for it.
 */
/**
 * The startup migration's own steps (T-112 round 009 M03): it only adds a card or changes which card is current, and
 * never writes to an existing card. Rule 1 and rule 3 are as on load; rule 2 becomes "make that card current" without
 * linking it (she keeps the model she is shown with; the 角色页, or loading this model again, links it).
 */
export type StartupSplitDecision = { kind: 'switch'; id: string } | { kind: 'select'; id: string } | { kind: 'create'; name: string };
export function startupSplitDecision(decision: CharacterModelDecision): StartupSplitDecision | null {
  if (decision.kind === 'keep') return null;
  if (decision.kind === 'bind') return { kind: 'select', id: decision.id };
  return decision;
}
export function startupNeedsModelSplit(card: CharacterModelCard, presetGeneId: string | null, reference: string | null): boolean {
  if (!reference) return false;
  const linked = effectiveCardModel(card, presetGeneId);
  return linked !== undefined && !sameModelReference(linked, reference);
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu;
/** One display line from a model's own name: no control or direction characters, within the card name limit. */
export function cleanModelName(value: string): string {
  const text = String(value ?? '').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  return [...text].slice(0, CHARACTER_TEXT_LIMITS.name).join('').trim();
}

/** A new card's name: the PMX/PMD model name, then the folder, then the file name. */
export function characterNameForModel(input: { modelNames: readonly string[]; folder: string; stem: string }): string {
  for (const value of [...input.modelNames, input.folder, input.stem]) {
    const name = cleanModelName(value);
    if (name) return name;
  }
  return '新角色';
}

/** C2 新增角色 for a model that already has a card: "Gene 2", "Gene 3"… so two cards never look the same. */
export function uniqueCharacterName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing.map(normalizeCharacterName));
  const clean = cleanModelName(base) || '新角色';
  if (!taken.has(normalizeCharacterName(clean))) return clean;
  for (let index = 2; index < 1000; index++) {
    const suffix = ` ${index}`, head = [...clean].slice(0, CHARACTER_TEXT_LIMITS.name - suffix.length).join('');
    if (!taken.has(normalizeCharacterName(head + suffix))) return head + suffix;
  }
  return clean;
}

/** Rule 3's card: the model's name and one plain line; the balanced mood template. The user fills in the rest later. */
export function minimalCharacterDraft(name: string): CharacterDraft {
  const clean = cleanModelName(name) || '新角色';
  return validateCharacterDraft({ name: clean, description: `${clean}，住在用户桌面上的伙伴。`, mood: defaultCharacterMoodTemplate() });
}

/** The names a PMX or PMD file gives itself (local first, then English), or null for anything else. */
export function readMmdModelNames(bytes: Uint8Array): { local: string; universal: string } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  try {
    if (bytes.length >= 4 && ascii(0, 4) === 'PMX ') {
      const globals = view.getUint8(8);
      const encoding = view.getUint8(9);
      if (globals < 1 || (encoding !== 0 && encoding !== 1)) return null;
      const decoder = new TextDecoder(encoding === 0 ? 'utf-16le' : 'utf-8', { fatal: false });
      let offset = 9 + globals;
      const text = (): string => {
        const length = view.getInt32(offset, true); offset += 4;
        if (length < 0 || length > 4096 || offset + length > bytes.length) throw Error('name');
        const value = decoder.decode(bytes.subarray(offset, offset + length)); offset += length;
        return value.replace(/\0+$/u, '');
      };
      const local = text();
      const universal = text();
      return { local, universal };
    }
    if (bytes.length >= 283 && ascii(0, 3) === 'Pmd') {
      // PMD: version float, then 20 bytes of Shift_JIS name (NUL padded) and 256 bytes of comment.
      const raw = bytes.subarray(7, 27);
      const end = raw.indexOf(0);
      let local = '';
      try { local = new TextDecoder('shift_jis').decode(raw.subarray(0, end < 0 ? raw.length : end)); } catch { local = ''; }
      return { local, universal: '' };
    }
  } catch { return null; }
  return null;
}
