// C1 角色和模型分开, host side: a model file's own names and the one-time backup before the startup split.
// The decision itself is pure (shared/character-model.ts); paths here come only from the host's own model
// selection (assets.register realpaths), never from the renderer.
import { constants } from 'node:fs';
import { copyFile, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { BUNDLED_CHARACTER_MODEL } from '../shared/character-cards';
import {
  characterNameForModel, decideCharacterForModel, readMmdModelNames, startupNeedsModelSplit, startupSplitDecision, uniqueCharacterName,
  type CharacterModelDecision, type StartupSplitDecision,
} from '../shared/character-model';
import type { CharacterCardStore, ModelAdoptionResult } from './character-cards';

export interface ModelIdentity {
  /** `bundled:gene` for the preinstalled Gene, otherwise the model file's path. */
  reference: string;
  /** Every name rule 2 may match: model names, folder, file name. */
  names: string[];
  /** Rule 3's card name. */
  newName: string;
  /** What the card shows as its model. */
  displayName: string;
}

/** The header is all we need: magic, globals and the two name fields (each at most a few hundred bytes). */
const HEADER_BYTES = 16_384;

export async function readModelIdentity(file: string, options: { bundled: boolean }): Promise<ModelIdentity> {
  if (options.bundled) return { reference: BUNDLED_CHARACTER_MODEL, names: ['Gene'], newName: 'Gene', displayName: 'Gene' };
  let header = new Uint8Array(0);
  try {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
      header = new Uint8Array(buffer.subarray(0, bytesRead));
    } finally { await handle.close(); }
  } catch { /* The folder and file names still name it. */ }
  const parsed = readMmdModelNames(header);
  const folder = path.basename(path.dirname(file));
  const stem = path.basename(file, path.extname(file));
  const modelNames = parsed ? [parsed.local, parsed.universal] : [];
  return { reference: file, names: [...modelNames, folder, stem].filter(Boolean), newName: characterNameForModel({ modelNames, folder, stem }),
    displayName: path.basename(file) };
}

export const MODEL_SPLIT_BACKUP = 'characters.before-model-split.json';

/**
 * Before the startup split changes characters.json the first time, its bytes are copied aside once. An existing
 * backup is never overwritten (it holds the oldest state); a missing characters.json has nothing to keep.
 * Throws when the copy fails, so the caller leaves the cards as they are.
 */
export async function backupCharactersOnce(directory: string): Promise<string | null> {
  const source = path.join(directory, 'characters.json'), target = path.join(directory, MODEL_SPLIT_BACKUP);
  try {
    if (!(await stat(target)).isFile()) throw new Error('角色卡备份位置不是文件，没有改动角色卡。');
    return target;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await stat(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  await copyFile(source, target, constants.COPYFILE_EXCL);
  return target;
}

/** What planning needs from the card store (electron/character-cards.ts). */
export type ModelCardSource = Pick<CharacterCardStore, 'modelCards' | 'publicState' | 'presetGeneId'>;

/** A loaded model's card: null when the current card already goes with it, else the step to take. */
export async function planCardForModel(cards: ModelCardSource, identity: ModelIdentity): Promise<CharacterModelDecision | null> {
  const all = cards.modelCards();
  // A new card never looks like an existing one ("Gene 2" for a copy of Gene's model).
  const decision = decideCharacterForModel({ cards: all, activeId: cards.publicState().activeId, presetGeneId: await cards.presetGeneId(),
    reference: identity.reference, names: identity.names, newName: uniqueCharacterName(identity.newName, all.map(card => card.name)) });
  return decision.kind === 'keep' ? null : decision;
}

/**
 * The startup split: only when the current card is linked to another model than the one on stage. Returns the step
 * (startupSplitDecision: add a card or change the current one, never link an existing card) and the name of the card
 * the model leaves; null leaves everything as it is.
 */
export async function planStartupSplit(cards: ModelCardSource, identity: ModelIdentity): Promise<{ decision: StartupSplitDecision; from: string } | null> {
  const presetGeneId = await cards.presetGeneId(), activeId = cards.publicState().activeId;
  const active = cards.modelCards().find(card => card.id === activeId);
  if (!active || !startupNeedsModelSplit(active, presetGeneId, identity.reference)) return null;
  const planned = await planCardForModel(cards, identity);
  const decision = planned ? startupSplitDecision(planned) : null;
  return decision ? { decision, from: active.name } : null;
}

export interface StartupSplitResult extends Omit<ModelAdoptionResult, 'kind'> { kind: StartupSplitDecision['kind'] }

/**
 * Startup split end to end: plan, back up characters.json once, then one card write that only adds a card or changes
 * the current one. Every existing record stays exactly as stored (CharacterCardStore keeps untouched records as read).
 */
export async function splitCardFromModelAtStartup(cards: ModelCardSource & Pick<CharacterCardStore, 'adoptModel' | 'activate'>, identity: ModelIdentity, directory: string):
  Promise<{ result: StartupSplitResult; from: string } | null> {
  const plan = await planStartupSplit(cards, identity);
  if (!plan) return null;
  await backupCharactersOnce(directory); // A failed copy throws: the cards stay as they are.
  if (plan.decision.kind === 'select')
    return { result: { state: await cards.activate(plan.decision.id), id: plan.decision.id, kind: 'select', changed: true }, from: plan.from };
  const adopted = await cards.adoptModel(plan.decision, { modelPath: identity.reference, modelName: identity.displayName });
  return { result: { ...adopted, kind: plan.decision.kind }, from: plan.from };
}
