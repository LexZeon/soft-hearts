import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import definition from '../../shared/cards/presets/gene-balanced-card.json';
import englishDefinition from '../../shared/cards/presets/gene-english-card.json';
import oneDefinition from '../../shared/cards/presets/one-card.json';
import oneEnglishDefinition from '../../shared/cards/presets/one-english-card.json';
import mumiDefinition from '../../shared/cards/presets/mumi-card.json';
import mumiEnglishDefinition from '../../shared/cards/presets/mumi-english-card.json';
import { validateCharacterDraft, type CharacterDraft } from '../../shared/cards/character-cards';
import { atomicWriteFile, type AtomicFileWriter } from '../foundation/atomic-file';

export const GENE_PRESET_KEY = 'soft-hearts:gene-balanced';
export const GENE_PRESET_DEFINITION_SHA256 = 'ec6ef6cc44435ca4263a14dc3228438eec7d8abd2cff8ae4d988eacb17381a01';
export const GENE_PRESET_FILE = 'gene-preinstalled-card.json';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function preinstalledGeneDraft(): CharacterDraft {
  return validateCharacterDraft(structuredClone(definition.card));
}
/**
 * I-071 v2: the second preinstalled card, "Gene (English)": a card of its own (own preset key, own installation record, own id, so its
 * own chats, diary and memory). Chinese Gene above is untouched.
 */
export const GENE_ENGLISH_PRESET_KEY = 'soft-hearts:gene-balanced-en';
export const GENE_ENGLISH_PRESET_DEFINITION_SHA256 = '644f536b62f623e228d2b571d70eae66ac9d8b683ed215ccb9be1123127ef4f7';
export const GENE_ENGLISH_PRESET_FILE = 'gene-english-preinstalled-card.json';
export function preinstalledGeneEnglishDraft(): CharacterDraft {
  return validateCharacterDraft(structuredClone(englishDefinition.card));
}
/** What differs between the two preinstalled Genes; the installation machinery is the same. */
export interface GenePreset { key: string; file: string; sha256: string; draft(): CharacterDraft; /** The bundled model key and name the card is bound to (default: the factory Gene). */ modelKey?: string; modelName?: string }
export const GENE_PRESET: GenePreset = { key: GENE_PRESET_KEY, file: GENE_PRESET_FILE, sha256: GENE_PRESET_DEFINITION_SHA256, draft: preinstalledGeneDraft };
export const GENE_ENGLISH_PRESET: GenePreset = { key: GENE_ENGLISH_PRESET_KEY, file: GENE_ENGLISH_PRESET_FILE, sha256: GENE_ENGLISH_PRESET_DEFINITION_SHA256, draft: preinstalledGeneEnglishDraft };
/**
 * 0.2.0: One and Mumi are preinstalled the same way, each in Chinese and English, each a card
 * of its own bound to its own bundled model (shared/cards/bundled-characters.ts). The sha256 here is the identity of the shipped definition
 * (the file's bytes when it was added), never recomputed.
 */
const presetOf = (definition: { card: unknown }, sha256: string, key: string, file: string, modelKey: string, modelName: string): GenePreset =>
  ({ key: `soft-hearts:${key}`, file, sha256, modelKey, modelName, draft: () => validateCharacterDraft(structuredClone(definition.card)) });
export const ONE_PRESET = presetOf(oneDefinition, '8d59b83d790ffe90e252d67db6518511df935715ae1b9c889d295072182ac8ed', 'one', 'one-preinstalled-card.json', 'bundled:one', 'One');
export const ONE_ENGLISH_PRESET = presetOf(oneEnglishDefinition, '70f93825826365f6ffba99e908210f34ccb9dcd24e930b3e48fe7f7533e976b9', 'one-en', 'one-en-preinstalled-card.json', 'bundled:one', 'One');
export const MUMI_PRESET = presetOf(mumiDefinition, '8c7ebfbc6f710674289a4ad3a15caf20bed8f8d2fc9e8e686ccbd3ee772398a3', 'mumi', 'mumi-preinstalled-card.json', 'bundled:mumi', 'Mumi');
export const MUMI_ENGLISH_PRESET = presetOf(mumiEnglishDefinition, '35ce6c89390a2bc61426cd357c9079c36aff988f269be9163883920a0e4e7863', 'mumi-en', 'mumi-en-preinstalled-card.json', 'bundled:mumi', 'Mumi');
/** The six preinstalled cards, the two Genes first. */
export const PREINSTALLED_PRESETS: readonly GenePreset[] = [GENE_PRESET, GENE_ENGLISH_PRESET, ONE_PRESET, ONE_ENGLISH_PRESET, MUMI_PRESET, MUMI_ENGLISH_PRESET];
/** The model key and name a preset card is bound to. */
export const presetModel = (preset: GenePreset): { modelPath: string; modelName: string } => ({ modelPath: preset.modelKey ?? 'bundled:gene', modelName: preset.modelName ?? 'Gene' });
export interface GeneInstallation {
  version: 1;
  presetKey: string;
  definitionVersion: number;
  definitionSha256: string;
  cardId: string;
  status: 'pending' | 'installed';
  initialDefault: boolean;
  firstModelPending: boolean;
  cardsBeforeSha256: string | null;
}
/** One host preset identity only. No renderer IPC, name lookup or portable fields. */
export class GeneInstallationStore {
  private readonly file: string;
  constructor(directory: string, private readonly writeAtomic: AtomicFileWriter = atomicWriteFile, readonly preset: GenePreset = GENE_PRESET) {
    this.file = path.join(directory, preset.file);
  }
  async read(): Promise<GeneInstallation | null> {
    let bytes: string;
    try {
      if ((await stat(this.file)).size > 4096) throw Error('oversize');
      bytes = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw Error('Gene 预装来源记录无法读取，原文件已保留。');
    }
    try {
      const value = JSON.parse(bytes) as GeneInstallation;
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('|') !== ['version','presetKey','definitionVersion','definitionSha256','cardId','status','initialDefault','firstModelPending','cardsBeforeSha256'].sort().join('|')
        || value.version !== 1 || value.presetKey !== this.preset.key
        || !Number.isSafeInteger(value.definitionVersion) || value.definitionVersion < 1 || value.definitionVersion > 1024
        || typeof value.definitionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.definitionSha256)
        || typeof value.cardId !== 'string' || !uuid.test(value.cardId)
        || !['pending','installed'].includes(value.status) || typeof value.initialDefault !== 'boolean'
        || typeof value.firstModelPending !== 'boolean' || (!value.initialDefault && value.firstModelPending)
        || (value.cardsBeforeSha256 !== null && (typeof value.cardsBeforeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.cardsBeforeSha256)))) throw Error('invalid');
      return value;
    } catch { throw Error('Gene 预装来源记录不正确，原文件已保留。'); }
  }
  async reserve(existingIds: ReadonlySet<string>, initialDefault: boolean, cardsBeforeSha256: string | null): Promise<GeneInstallation> {
    let cardId = randomUUID();
    for (let tries = 0; existingIds.has(cardId); tries++) {
      if (tries >= 15) throw Error('Gene 预装编号冲突，现有角色保持不变。');
      cardId = randomUUID();
    }
    const record: GeneInstallation = { version: 1, presetKey: this.preset.key, definitionVersion: 1,
      definitionSha256: this.preset.sha256, cardId, status: 'pending', initialDefault, firstModelPending: initialDefault, cardsBeforeSha256 };
    await this.writeAtomic(this.file, JSON.stringify(record, null, 2));
    return record;
  }
  async complete(record: GeneInstallation): Promise<void> {
    await this.writeAtomic(this.file, JSON.stringify({ ...record, status: 'installed' }, null, 2));
  }
}

const historicalFiles = ['settings.json','characters.json','mood-state.json','memories.jsonl',
  'character-response-settings.json','physics-settings.json','music-settings.json','blush-calibrations.json',
  'emotional-voice-settings.json','codex-tasks.json','system-audio-transcripts.json'];
async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** Capture before initialization writes: Chromium caches and the QA marker are not persona data. */
export async function inspectGeneProfile(directory: string): Promise<{ fresh: boolean; legacySystemPrompt?: string }> {
  const present = new Set<string>();
  for (const name of historicalFiles) if (await exists(path.join(directory, name))) present.add(name);
  const historyDirectory = await exists(path.join(directory, 'chat'));
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  const otherSavedData = entries.some(entry => entry.isFile() && /\.jsonl?(?:$|\.)/i.test(entry.name)
    && !PREINSTALLED_PRESETS.some(preset => preset.file === entry.name) && entry.name !== 'qa-text-isolation.json');
  let priorInstall = false;
  for (const preset of PREINSTALLED_PRESETS) {
    try { const record = await new GeneInstallationStore(directory, atomicWriteFile, preset).read(); if (record && (record.status === 'installed' || !record.initialDefault)) priorInstall = true; }
    catch { priorInstall = true; } // Unreadable provenance never authorizes a fresh default.
  }
  let legacySystemPrompt: string | undefined;
  if (present.has('settings.json') && !present.has('characters.json')) {
    try {
      const file = path.join(directory, 'settings.json');
      if ((await stat(file)).size <= 8_000_000) {
        const old = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        if (old && typeof old === 'object' && typeof old.persona !== 'string' && typeof old.systemPrompt === 'string')
          legacySystemPrompt = old.systemPrompt;
      }
    } catch { /* The existing settings source stays untouched; it is still an existing profile. */ }
  }
  return { fresh: present.size === 0 && !historyDirectory && !otherSavedData && !priorInstall,
    ...(legacySystemPrompt !== undefined ? { legacySystemPrompt } : {}) };
}
