// C3 用角色卡文件原地更新, host side (docs/claude/2026-11-03-card-update-in-place.md). A card file updates an existing card in place: same id, same model link and picture, so her
// chats, diary and profile, familiarity and nickname, her own life, little needs, match counts and mood state (all kept
// by id) stay hers. characters.json is copied aside before the one write; a failed copy writes nothing. No Electron here.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  planCharacterCardUpdate,
  type CharacterCardFileContent, type CharacterCardUpdatePreview, type CharacterCardUpdateSummary,
} from '../shared/character-card-update';
import { CHARACTER_CARD_FORMAT, type CharacterCardState } from '../shared/character-cards';
import { CHARACTER_RESPONSE_CARD_VERSION, parseCharacterResponseImport } from '../shared/character-response-portable';
import type { CharacterResponseState } from '../shared/character-response';
import { parseCharacterCardText, type CharacterCardStore } from './character-cards';
import type { CharacterResponseStore } from './character-response';

/** Every format the card import reads (soft hearts v1–v3, Tavern V2 and older Tavern text cards), with the same checks. */
export function readCharacterCardFile(text: string): CharacterCardFileContent {
  const unwrapped = parseCharacterResponseImport(text); // Version 3: the base card plus its response profile.
  const base = parseCharacterCardText(unwrapped.baseText);
  return isVersion3(text)
    ? { format: 'soft-hearts-v3', draft: base.draft, response: unwrapped.profile }
    : { format: base.format, draft: base.draft, response: null };
}
/** Only after parseCharacterResponseImport accepted the text: was it a version 3 envelope? */
function isVersion3(text: string): boolean {
  try {
    const value = JSON.parse(text.replace(/^﻿/, '')) as { format?: unknown; version?: unknown };
    return value.format === CHARACTER_CARD_FORMAT && value.version === CHARACTER_RESPONSE_CARD_VERSION;
  } catch { return false; }
}

/** `characters.before-update-2026-11-03T06-25-30Z.json`, then `…-2.json`, `…-3.json`: an earlier backup is never overwritten. */
export function updateBackupName(file: string, at: Date, attempt: number): string {
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  const stem = path.basename(file, path.extname(file));
  return `${stem}.before-update-${stamp}${attempt > 1 ? `-${attempt}` : ''}${path.extname(file)}`;
}

/**
 * Copies `<directory>/<name>` aside before an update. Returns the backup's path, or null when there is no such file
 * yet (nothing to keep). Throws when the copy fails, so the caller writes nothing.
 */
export async function backupBeforeUpdate(directory: string, name: string, at: Date = new Date()): Promise<string | null> {
  const source = path.join(directory, name);
  try { await stat(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  for (let attempt = 1; attempt <= 100; attempt++) {
    const target = path.join(directory, updateBackupName(name, at, attempt));
    try { await copyFile(source, target, constants.COPYFILE_EXCL); return target; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  throw new Error('角色卡备份的名字都被占用了，没有更新。');
}

export interface CharacterCardUpdateResult {
  state: CharacterCardState;
  id: string;
  summary: CharacterCardUpdateSummary;
  /** characters.json was written (false: the file already matched her card). */
  changed: boolean;
  /** The response profile changed (the host republishes it). */
  response: CharacterResponseState | null;
  notice?: string;
}

export interface CharacterCardUpdaterDeps {
  cards: Pick<CharacterCardStore, 'publicState' | 'cardFingerprint' | 'updateInPlace' | 'presetGeneId'>;
  responses: Pick<CharacterResponseStore, 'get' | 'save'>;
  /** The profile folder holding characters.json and character-response-settings.json. */
  directory: string;
  /** Tests replace the copy (e.g. a full disk); the app uses backupBeforeUpdate. */
  backup?: (directory: string, name: string) => Promise<string | null>;
  token?: () => string;
  now?: () => number;
}

interface Pending { token: string; id: string; text: string; expected: string; expires: number }
const PREVIEW_TTL_MS = 10 * 60_000;
const RESPONSE_FILE = 'character-response-settings.json';
const CARDS_FILE = 'characters.json';
const badFile = (error: unknown) => new Error(error instanceof Error && error.message ? error.message : '角色卡文件无法读取。');

/**
 * Two ways in: the 角色页 (preview → the user confirms on her tile → confirm(token)) and the agent channel (plan →
 * the native confirmation → update(id, text, expected)). Both apply only what the user was shown: the host keeps the
 * file's text, and the card must still be exactly the card the change was planned against.
 */
export class CharacterCardUpdater {
  private pending: Pending | null = null;
  constructor(private readonly deps: CharacterCardUpdaterDeps) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** What updating card `id` from this file text would change; nothing is written. `expected` ties a later update to this card state. */
  async plan(id: string, text: string): Promise<{ id: string; summary: CharacterCardUpdateSummary; expected: string }> {
    const card = this.card(id);
    let file: CharacterCardFileContent;
    try { file = readCharacterCardFile(text); } catch (error) { throw badFile(error); }
    const expected = this.deps.cards.cardFingerprint(card.id);
    const plan = planCharacterCardUpdate(card, this.deps.responses.get(card.id).profile, file, { presetGene: card.id === await this.deps.cards.presetGeneId() });
    return { id: card.id, summary: plan.summary, expected };
  }

  /** The control window's first step: the summary for her tile and a one-time token (the latest preview replaces an older one). */
  async preview(id: string, text: string): Promise<CharacterCardUpdatePreview> {
    const planned = await this.plan(id, text);
    const token = (this.deps.token ?? randomUUID)();
    this.pending = { token, id: planned.id, text, expected: planned.expected, expires: this.now() + PREVIEW_TTL_MS };
    return { token, id: planned.id, summary: planned.summary };
  }
  discard(token: unknown): void { if (this.pending?.token === token) this.pending = null; }
  /** The control window's second step: exactly the previewed file on exactly the previewed card. */
  async confirm(token: unknown): Promise<CharacterCardUpdateResult> {
    const pending = this.pending;
    if (!pending || typeof token !== 'string' || pending.token !== token || pending.expires < this.now()) {
      if (pending && pending.expires < this.now()) this.pending = null;
      throw new Error('这次更新已经过期，请重新选择角色卡文件。');
    }
    this.pending = null;
    return this.update(pending.id, pending.text, pending.expected);
  }

  /**
   * Updates card `id` in place from `text`, when the card is still the one `expected` was taken from. characters.json
   * (and, when her reactions change too, character-response-settings.json) is copied aside first; a failed copy
   * changes nothing.
   */
  async update(id: string, text: string, expected: string): Promise<CharacterCardUpdateResult> {
    const card = this.card(id);
    let file: CharacterCardFileContent;
    try { file = readCharacterCardFile(text); } catch (error) { throw badFile(error); }
    const presetGene = card.id === await this.deps.cards.presetGeneId();
    const plan = planCharacterCardUpdate(card, this.deps.responses.get(card.id).profile, file, { presetGene });
    const backup = this.deps.backup ?? ((directory: string, name: string) => backupBeforeUpdate(directory, name));
    const { state, changed } = await this.deps.cards.updateInPlace(card.id, plan.draft, {
      expected,
      backup: async () => {
        await backup(this.deps.directory, CARDS_FILE);
        if (plan.response) await backup(this.deps.directory, RESPONSE_FILE);
      },
    });
    if (!plan.response) return { state, id: card.id, summary: plan.summary, changed, response: null };
    try {
      // When the card text already matched, nothing was copied yet.
      if (!changed) await backup(this.deps.directory, RESPONSE_FILE);
      const response = await this.deps.responses.save(card.id, plan.response);
      return { state, id: card.id, summary: plan.summary, changed, response };
    } catch {
      const notice = '人设已经更新；反应细调没能一起更新，可以在「心情和反应」里再调。';
      return { state: { ...state, notice }, id: card.id, summary: plan.summary, changed, response: null, notice };
    }
  }

  private card(id: unknown) {
    const card = typeof id === 'string' ? this.deps.cards.publicState().cards.find(value => value.id === id) : undefined;
    if (!card) throw new Error('角色卡不存在。');
    return card;
  }
}
