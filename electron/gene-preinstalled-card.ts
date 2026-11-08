import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import definition from '../shared/presets/gene-balanced-card.json';
import { validateCharacterDraft, type CharacterDraft } from '../shared/character-cards';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';

export const GENE_PRESET_KEY = 'soft-hearts:gene-balanced';
export const GENE_PRESET_DEFINITION_SHA256 = '0292629cd5ca03c9c8038857e1b9e4bb1aa2807cc2cd02cfabd7606c114c8bc8';
export const GENE_PRESET_FILE = 'gene-preinstalled-card.json';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function preinstalledGeneDraft(): CharacterDraft {
  return validateCharacterDraft(structuredClone(definition.card));
}
export interface GeneInstallation {
  version: 1;
  presetKey: typeof GENE_PRESET_KEY;
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
  constructor(directory: string, private readonly writeAtomic: AtomicFileWriter = atomicWriteFile) {
    this.file = path.join(directory, GENE_PRESET_FILE);
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
        || value.version !== 1 || value.presetKey !== GENE_PRESET_KEY
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
    const record: GeneInstallation = { version: 1, presetKey: GENE_PRESET_KEY, definitionVersion: 1,
      definitionSha256: GENE_PRESET_DEFINITION_SHA256, cardId, status: 'pending', initialDefault, firstModelPending: initialDefault, cardsBeforeSha256 };
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
    && entry.name !== GENE_PRESET_FILE && entry.name !== 'qa-text-isolation.json');
  let priorInstall = false;
  try { const record = await new GeneInstallationStore(directory).read(); priorInstall = !!record && (record.status === 'installed' || !record.initialDefault); }
  catch { priorInstall = true; } // Unreadable provenance never authorizes a fresh default.
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
