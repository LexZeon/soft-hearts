// Private character cards for the fidelity suite (`--card-file [label=]path`, repeatable) and the private output folder (`--out`).
// The card file is read with the app's own importer (a soft hearts card, version 1 / 2 / 3, or Tavern text) and its strict validation;
// anything it refuses is refused here. The text of a card never leaves memory except into the run's own artifacts in `--out`: only the
// label and a short hash are ever logged. Nothing here is a fixture or a snapshot.
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCharacterCardText } from '../../electron/cards/character-cards';
import { compileCharacterPersona, effectiveCharacterMood } from '../../shared/cards/character-cards';
import { parseCharacterResponseImport } from '../../shared/cards/character-response-portable';
import { assertPrivateRoot } from './private-root.mjs';
import { ALL_CARDS, type FidelityCard } from './fidelity-scenarios';

/** One run of card files plus a private card never asks for more than this many requests unless `--max-requests` says so. */
export const CARD_FILE_MAX_REQUESTS = 30;

export interface CardFileSpec { label: string; file: string }
export interface LoadedCardFile { card: FidelityCard; label: string; hash: string }

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u;

/** `label=path` or just `path` (the label is then the file name without its extension). */
export function parseCardFileSpec(spec: string): CardFileSpec {
  const split = spec.indexOf('=');
  const hasLabel = split > 0 && !/[\\/:]/u.test(spec.slice(0, split));
  const file = hasLabel ? spec.slice(split + 1) : spec;
  const label = hasLabel ? spec.slice(0, split) : path.basename(file).replace(/\.[^.]*$/u, '');
  if (!file) throw new Error('--card-file 需要一个文件路径。');
  if (!LABEL.test(label)) throw new Error('--card-file 的标签只能用字母、数字、点、下划线和短横线（最长 32 个字符）；可以写成 标签=路径。');
  return { label, file };
}

export async function loadCardFile(spec: CardFileSpec): Promise<LoadedCardFile> {
  let text: string;
  try { text = await readFile(path.resolve(spec.file), 'utf8'); } catch { throw new Error(`读不到角色卡文件（标签 ${spec.label}）。`); }
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 8);
  let draft: ReturnType<typeof parseCharacterCardText>['draft'];
  // The app's importer: a version 3 file is first reduced to its base card, then read as every other file is. A file turns nothing on (realerEmotions is dropped).
  try { draft = parseCharacterCardText(parseCharacterResponseImport(text).baseText).draft; }
  catch (error) { throw new Error(`角色卡文件 ${spec.label} 不是有效的角色卡：${error instanceof Error ? error.message : '无法读取'}`); }
  return { label: spec.label, hash, card: { id: spec.label, name: spec.label, persona: compileCharacterPersona(draft), mood: effectiveCharacterMood(draft) } };
}

export async function loadCardFiles(specs: readonly string[]): Promise<LoadedCardFile[]> {
  const parsed = specs.map(parseCardFileSpec);
  const labels = parsed.map(spec => spec.label);
  if (new Set(labels).size !== labels.length) throw new Error('--card-file 的标签不能重复。');
  const taken = labels.find(label => ALL_CARDS.some(card => card.id === label));
  if (taken) throw new Error(`--card-file 的标签 ${taken} 和内置卡重名，请换一个。`);
  const loaded: LoadedCardFile[] = [];
  for (const spec of parsed) loaded.push(await loadCardFile(spec));
  return loaded;
}

/** `--out`: required with any card file; never inside OneDrive or the repository (the same guard as scripts/experience/lib.mjs). */
export async function resolveOutDir(out: string, hasCardFiles: boolean, environment: Record<string, string | undefined> = process.env): Promise<string | null> {
  if (!out) {
    if (hasCardFiles) throw new Error('用 --card-file 时必须给 --out <文件夹>：私人卡的回复不能写进仓库里的 .local/。');
    return null;
  }
  const real = await assertPrivateRoot(out, environment);
  await mkdir(real, { recursive: true });
  return real;
}

/** Planned-request ceiling: `--max-requests`, or 30 for a run with card files; absent otherwise. */
export function requestCeiling(option: string, hasCardFiles: boolean): number | null {
  if (option) {
    const value = Number(option);
    if (!Number.isInteger(value) || value < 1) throw new Error('--max-requests 必须是正整数。');
    return value;
  }
  return hasCardFiles ? CARD_FILE_MAX_REQUESTS : null;
}
