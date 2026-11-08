import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  BUNDLED_CHARACTER_MODEL,
  CHARACTER_CARD_FORMAT,
  CHARACTER_CARD_VERSION,
  CHARACTER_TEXT_LIMITS,
  MAX_CHARACTER_CARDS,
  validateCharacterDraft,
  defaultCharacterMoodTemplate,
  effectiveCharacterMood,
  type CharacterCard,
  type CharacterCardState,
  type CharacterDraft,
} from "../shared/character-cards";
import { validateMoodParameters, type MoodParameters } from '../shared/mood';
import { minimalCharacterDraft, sameModelReference, type CharacterModelCard, type CharacterModelDecision } from '../shared/character-model';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';
import { GeneInstallationStore, GENE_PRESET_DEFINITION_SHA256, preinstalledGeneDraft } from './gene-preinstalled-card';
import { KeptFields, splitUnknownFields, type KnownFields } from './unknown-fields';

interface CharacterRecord extends CharacterCard {
  modelPath?: string;
}
interface StoredCards {
  version: 1;
  revision?: number;
  cards: CharacterRecord[];
  activeId: string;
}
export interface BundledGeneBindingResult {
  state: CharacterCardState;
  changed: boolean;
}
/** C1: what adopting a model did to the cards (one write at most). */
export interface ModelAdoptionResult {
  state: CharacterCardState;
  /** The card that now goes with the model and is the current card. */
  id: string;
  kind: CharacterModelDecision['kind'];
  /** Whether characters.json was written. */
  changed: boolean;
}
export const PRESET_GENE_MODEL_ERROR = '预装的 Gene 卡只跟预装 Gene 模型走；想给别的模型用这套人设，可以先复制一张再关联。';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("角色卡 JSON 格式不正确。");
  return value as Record<string, unknown>;
}
function draftFields(value: Record<string, unknown>): CharacterDraft {
  return validateCharacterDraft(
    {
      ...Object.fromEntries(Object.keys(CHARACTER_TEXT_LIMITS).map((key) => [
        key,
        value[key] === undefined ? "" : value[key],
      ])),
      ...(Object.hasOwn(value, 'mood') ? { mood: value.mood } : {}),
      ...(Object.hasOwn(value, 'slowWarmUp') ? { slowWarmUp: value.slowWarmUp } : {}),
      ...(Object.hasOwn(value, 'realerEmotions') ? { realerEmotions: value.realerEmotions } : {}),
      ...(Object.hasOwn(value, 'understandingNotes') ? { understandingNotes: value.understandingNotes } : {}),
    },
  );
}
function knownFields(value: Record<string, unknown>, allowed: readonly string[], message: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(message);
}
const textFields = Object.keys(CHARACTER_TEXT_LIMITS);
/**
 * What this version knows in characters.json (docs/claude/2026-11-04-keep-unknown-fields.md). Anything else a newer version
 * wrote, on the file or on a card, is kept aside and written back with it, never read: not in publicState, getActive,
 * export, the fingerprint or the roster. Before, such a file was refused and the app could not start. The mood template
 * is one whole value: its parameters stay strict (shared/mood.ts validateMoodParameters). Card files someone imports are
 * not stored files: parseCharacterCardText still refuses unknown fields.
 */
const STORED_CARD_FIELDS = ['id', ...textFields, 'mood', 'slowWarmUp', 'realerEmotions', 'understandingNotes', 'modelPath', 'modelName'];
const CARD_KNOWN_FIELDS: KnownFields = Object.fromEntries(STORED_CARD_FIELDS.map(key => [key, true]));
const CARDS_FILE_KNOWN_FIELDS: KnownFields = { version: true, revision: true, cards: true, activeId: true };
const tavernFields = [...textFields, 'first_mes', 'mes_example', 'system_prompt',
  'creator_notes', 'tags', 'creator', 'character_version', 'post_history_instructions', 'alternate_greetings', 'extensions'];
function legacyDraft(data: Record<string, unknown>): CharacterDraft {
  knownFields(data, tavernFields, '旧文字卡包含未支持字段；路径、连接、权限和运行数据不能导入。');
  if (data.extensions !== undefined && Object.keys(object(data.extensions)).length)
    throw new Error('当前只支持 Tavern 基础文字，不能导入扩展或权限配置。');
  return draftFields({
    name: data.name, description: data.description, personality: data.personality, scenario: data.scenario,
    greeting: data.greeting === undefined ? data.first_mes : data.greeting,
    examples: data.examples === undefined ? data.mes_example : data.examples,
    systemPrompt: data.systemPrompt === undefined ? data.system_prompt : data.systemPrompt,
  });
}
/** Which card file a text was: soft hearts v1 / v2 (v3 is unwrapped first, shared/character-response-portable.ts), Tavern V2 or an older Tavern text card. */
export type CharacterCardTextFormat = 'soft-hearts-v1' | 'soft-hearts-v2' | 'tavern-v2' | 'tavern';
/**
 * The card importer's strict reading of a card file (no paths, links, permissions or private state), shared by
 * import (a new card) and C3's in-place update (the same card). Pure: no files, no store.
 */
export function parseCharacterCardText(text: string): { draft: CharacterDraft; format: CharacterCardTextFormat } {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 1_000_000)
    throw new Error("导入角色卡必须是 1 MB 以内的 JSON 文字。");
  let parsed: Record<string, unknown>;
  try {
    parsed = object(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch {
    throw new Error("角色卡 JSON 无法解析。");
  }
  if (parsed.format !== undefined) {
    knownFields(parsed, ['format', 'version', 'card'], '角色卡文件包含未知字段或私人运行数据。');
    if (parsed.format !== CHARACTER_CARD_FORMAT || ![1, CHARACTER_CARD_VERSION].includes(parsed.version as number))
      throw new Error("不支持此角色卡格式或版本。");
    const data = object(parsed.card);
    // I-018: a version 2 card may carry its 理解说明 (persona text the user confirmed); version 1 never had it.
    knownFields(data, [...textFields, ...(parsed.version === CHARACTER_CARD_VERSION ? ['mood', 'slowWarmUp', 'realerEmotions', 'understandingNotes'] : [])],'角色卡包含未知字段；不能导入路径、连接、权限或私人状态。');
    if (parsed.version === CHARACTER_CARD_VERSION && !Object.hasOwn(data, 'mood')) throw new Error('version 2 角色卡需要完整的 version 1 心情模板。');
    // F6: an exported card may say "更真实的情绪" is on, but a file never turns it on: it needs the user's own consent here.
    const { realerEmotions: _fromFile, ...draft } = draftFields(data);
    return { draft, format: parsed.version === CHARACTER_CARD_VERSION ? 'soft-hearts-v2' : 'soft-hearts-v1' };
  }
  if (parsed.spec !== undefined) {
    knownFields(parsed, ['spec', 'spec_version', 'data'], 'Tavern 文件包含未知字段。');
    if (parsed.spec !== "chara_card_v2" || parsed.spec_version !== "2.0")
      throw new Error("只支持 Tavern V2 JSON 文字卡。");
    return { draft: legacyDraft(object(parsed.data)), format: 'tavern-v2' };
  }
  return { draft: legacyDraft(parsed), format: 'tavern' };
}
const recordFingerprint = (card: CharacterRecord): string => createHash('sha256').update(JSON.stringify(card)).digest('hex');
const publicCard = (card: CharacterRecord): CharacterCard => ({
  id: card.id,
  ...draftFields(card as unknown as Record<string, unknown>),
  ...(card.modelName ? { modelName: card.modelName } : {}),
});
const modelName = (value: string) =>
  path.basename(path.win32.basename(value)).slice(0, 160);
const validModelReference = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 32768 &&
  !value.includes("\0") &&
  (value === BUNDLED_CHARACTER_MODEL || path.isAbsolute(value));

/** Paths originate only from the host's native model selection, never imported JSON. */
export class CharacterCardStore {
  private state: StoredCards = { version: 1, cards: [], activeId: "" };
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private readonly file: string;
  private presetNotice: string | undefined;
  private presetOriginalRecords: { cards: unknown[]; activeId: unknown } | undefined;
  /**
   * Each card as it was last read or written (`record`, normalized) and the exact stored record (`raw`). A write keeps
   * `raw` for every card nothing changed, so a sparse older record stays sparse and only the card that changed is
   * rewritten (T-112 round 009 M02; C3 "除了被更新的那张卡，其他卡逐字节不变").
   */
  private originals = new Map<string, { record: CharacterRecord; raw: unknown }>();
  /** Unknown fields (unknown-fields.ts): the file's own, and each card's by id. Written back, never read. */
  private fileKept = KeptFields.none;
  private cardKept = new Map<string, KeptFields>();
  constructor(
    private readonly directory: string,
    private readonly legacyPersona: string,
    private readonly writeAtomic: AtomicFileWriter = atomicWriteFile,
    private readonly log?: (line: string) => void,
  ) {
    this.file = path.join(directory, "characters.json");
  }
  load(options: { preinstalledGene?: boolean; freshProfile?: boolean } = {}): Promise<CharacterCardState> {
    return this.mutate(() => this.loadFromDisk(options));
  }
  private async loadFromDisk(options: { preinstalledGene?: boolean; freshProfile?: boolean }): Promise<CharacterCardState> {
    this.presetNotice = undefined;
    this.presetOriginalRecords = undefined;
    this.originals = new Map();
    this.fileKept = KeptFields.none;
    this.cardKept = new Map();
    await mkdir(this.directory, { recursive: true });
    let raw: Record<string, unknown>;
    try {
      if ((await stat(this.file)).size > 8_000_000)
        throw new Error("角色卡存储文件过大。");
      raw = object(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "角色卡文件无法读取；原文件已保留，请检查 characters.json。",
        );
      this.state = { version: 1, cards: [], activeId: '' }; this.revision = 0;
      if (options.preinstalledGene && options.freshProfile) {
        await this.installGene(true);
        if (this.state.cards.length) return this.publicState();
      }
      const card: CharacterRecord = {
        id: randomUUID(),
        ...validateCharacterDraft({
          name: "默认伙伴",
          systemPrompt: this.legacyPersona,
          mood: defaultCharacterMoodTemplate(),
        }),
      };
      await this.persist({ version: 1, cards: [card], activeId: card.id });
      if (options.preinstalledGene) await this.tryInstallGene();
      return this.publicState();
    }
    if (
      raw.version !== 1 ||
      !Array.isArray(raw.cards) ||
      !raw.cards.length ||
      raw.cards.length > MAX_CHARACTER_CARDS
    )
      throw new Error("角色卡存储格式不正确，原文件已保留。");
    const fieldOptions = (label: string) => ({ label, ...(this.log ? { log: this.log } : {}) });
    const file = splitUnknownFields(raw, CARDS_FILE_KNOWN_FIELDS, fieldOptions('characters.json'));
    raw = file.known;
    knownFields(raw, Object.keys(CARDS_FILE_KNOWN_FIELDS), '角色卡存储包含未知字段，原文件已保留。');
    const ids = new Set<string>();
    const kept = new Map<string, KeptFields>();
    /** Cards whose stored record had a field that is not kept: rewritten from the normalized card on the next write. */
    const notVerbatim = new Set<unknown>();
    const cards = (raw.cards as unknown[]).map((value, index) => {
      const split = splitUnknownFields(object(value), CARD_KNOWN_FIELDS, fieldOptions(`characters.json 第 ${index + 1} 张卡`));
      const record = split.known;
      knownFields(record, STORED_CARD_FIELDS, '角色卡存档包含未知字段，原文件已保留。');
      if (
        typeof record.id !== "string" ||
        !uuid.test(record.id) ||
        ids.has(record.id)
      )
        throw new Error("角色卡编号不正确或重复。");
      ids.add(record.id);
      const card: CharacterRecord = { id: record.id, ...draftFields(record) };
      if (record.modelPath !== undefined) {
        if (!validModelReference(record.modelPath))
          throw new Error("角色卡模型引用不正确。");
        card.modelPath = record.modelPath;
        card.modelName = modelName(
          typeof record.modelName === "string" && record.modelName
            ? record.modelName
            : record.modelPath === BUNDLED_CHARACTER_MODEL
              ? "Gene"
              : record.modelPath,
        );
      }
      if (!split.kept.empty) kept.set(card.id, split.kept);
      if (split.dropped.length) notVerbatim.add(value);
      return card;
    });
    if (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0)) throw new Error('角色卡修订号不正确。');
    this.revision = (raw.revision as number | undefined) ?? 0;
    this.state = {
      version: 1,
      cards,
      activeId:
        typeof raw.activeId === "string" && ids.has(raw.activeId)
          ? raw.activeId
          : cards[0].id,
    };
    this.fileKept = file.kept;
    this.cardKept = kept;
    // Each card as this version would store it: the exact record, or (when a field of it is not kept) the normalized card.
    const stored = (raw.cards as unknown[]).map((value, index) => notVerbatim.has(value) ? this.storedForm(cards[index]) : value);
    this.presetOriginalRecords = { cards: structuredClone(stored), activeId: raw.activeId };
    this.remember(cards, stored);
    if (options.preinstalledGene) await this.tryInstallGene();
    return this.publicState();
  }
  private async tryInstallGene(): Promise<void> {
    try { await this.installGene(false); }
    catch { this.presetNotice = 'Gene 预装卡安装未完成；现有角色保持，来源文件与已保存内容已保留，下次启动重试。'; }
  }
  /** Runs only inside the store queue. Never edits, activates or rebinds an existing card. */
  private async installGene(initialDefault: boolean): Promise<void> {
    const installation = new GeneInstallationStore(this.directory, this.writeAtomic);
    let record = await installation.read();
    if (record?.status === 'installed') return; // Missing installed ID means the user deleted it.
    const present = record ? this.state.cards.find(card => card.id === record!.cardId) : undefined;
    if (!present && this.state.cards.length >= MAX_CHARACTER_CARDS) {
      this.presetNotice = '角色卡已达上限，Gene 预装卡暂未添加；现有角色保持。'; return;
    }
    const cardsHash = await readFile(this.file).then(bytes => createHash('sha256').update(bytes).digest('hex')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    record ??= await installation.reserve(new Set(this.state.cards.map(card => card.id)), initialDefault, cardsHash);
    if (record.definitionVersion !== 1 || record.definitionSha256 !== GENE_PRESET_DEFINITION_SHA256)
      throw Error('待完成的 Gene 定义已变化；原角色与来源记录保持。');
    const existing = this.state.cards.find(card => card.id === record!.cardId);
    if (existing) {
      if (!isDeepStrictEqual(draftFields(existing as unknown as Record<string, unknown>), preinstalledGeneDraft())
        || existing.modelPath !== BUNDLED_CHARACTER_MODEL || existing.modelName !== 'Gene')
        throw Error('待完成的 Gene 编号内容已变化；不覆盖现有角色。');
    } else {
      if (record.cardsBeforeSha256 !== cardsHash)
        throw Error('待完成预装记录之后角色文件已改变；不重新添加或覆盖角色。');
      const card: CharacterRecord = { id: record.cardId, ...preinstalledGeneDraft(), modelPath: BUNDLED_CHARACTER_MODEL, modelName: 'Gene' };
      const next = { version: 1 as const, cards: [...this.state.cards, card],
        activeId: initialDefault && !this.state.cards.length ? card.id : this.state.activeId };
      if (this.presetOriginalRecords) {
        // Appending a preset must not rewrite existing records via load-time normalization.
        await this.persistPreservingRecords(next, [...this.presetOriginalRecords.cards, card], this.presetOriginalRecords.activeId);
      } else await this.persist(next);
    }
    try { await installation.complete(record); }
    catch { this.presetNotice = 'Gene 预装卡已保存，来源登记尚未完成；保留当前角色，下次启动重试登记。'; }
  }
  /** Only the original, unchanged first preset may resume an interrupted first model setup. */
  needsInitialGeneModel(hasSavedSettings: boolean): Promise<boolean> {
    return this.mutate(async () => {
      const installation = new GeneInstallationStore(this.directory, this.writeAtomic);
      let record;
      try { record = await installation.read(); } catch { return false; }
      if (!record?.initialDefault || !record.firstModelPending) return false;
      const card = this.state.cards.find(value => value.id === record!.cardId);
      const sameFirstCard = this.state.cards.length === 1 && this.state.activeId === record.cardId && !!card
        && card.modelPath === BUNDLED_CHARACTER_MODEL && card.modelName === 'Gene'
        && isDeepStrictEqual(draftFields(card as unknown as Record<string, unknown>), preinstalledGeneDraft())
        && record.definitionVersion === 1 && record.definitionSha256 === GENE_PRESET_DEFINITION_SHA256;
      if (hasSavedSettings || !sameFirstCard) {
        await installation.complete({ ...record, firstModelPending: false });
        return false; // Never overwrite settings or follow a changed/other active card.
      }
      return true;
    });
  }
  /** Called after trusted bundled assets and the first settings commit, before opening UI. */
  completeInitialGeneModel(): Promise<void> {
    return this.mutate(async () => {
      const installation = new GeneInstallationStore(this.directory, this.writeAtomic);
      const record = await installation.read();
      if (record?.initialDefault && record.firstModelPending) {
        await installation.complete({ ...record, firstModelPending: false });
        this.presetNotice = undefined;
      }
    });
  }
  publicState(): CharacterCardState {
    return {
      cards: this.state.cards.map(publicCard),
      activeId: this.state.activeId,
      revision: this.revision,
      ...(this.presetNotice ? { notice: this.presetNotice } : {}),
    };
  }
  getActive(): CharacterRecord {
    return structuredClone(this.find(this.state.activeId));
  }
  private find(id: string): CharacterRecord {
    const card = this.state.cards.find((card) => card.id === id);
    if (!card) throw new Error("角色卡不存在。");
    return card;
  }
  private async persist(next: StoredCards): Promise<CharacterCardState> {
    const cards = this.storedRecords(next.cards);
    await this.writeAtomic(this.file, JSON.stringify(this.fileKept.writeInto({ ...next, cards, revision: this.revision + 1 }), null, 2));
    this.state = next;
    this.revision++;
    this.forgetRemovedCards(next.cards);
    this.remember(next.cards, cards);
    this.presetOriginalRecords = { cards: structuredClone(cards), activeId: next.activeId };
    return this.publicState();
  }
  private async persistPreservingRecords(next: StoredCards, cards: unknown[], activeId: unknown): Promise<CharacterCardState> {
    await this.writeAtomic(this.file, JSON.stringify(this.fileKept.writeInto({ version: 1, revision: this.revision + 1, cards, activeId }), null, 2));
    this.state = next; this.revision++;
    this.forgetRemovedCards(next.cards);
    this.remember(next.cards, cards);
    this.presetOriginalRecords = { cards: structuredClone(cards), activeId };
    return this.publicState();
  }
  /**
   * What a write stores per card: the exact record read or written last when nothing about the card changed since, else
   * the card with its own unknown fields put back (a card someone deleted takes them with it).
   */
  private storedRecords(cards: readonly CharacterRecord[]): unknown[] {
    return cards.map(card => {
      const original = this.originals.get(card.id);
      return original && isDeepStrictEqual(card, original.record) ? structuredClone(original.raw) : this.storedForm(card);
    });
  }
  private storedForm(card: CharacterRecord): CharacterRecord {
    return (this.cardKept.get(card.id) ?? KeptFields.none).writeInto(card);
  }
  private forgetRemovedCards(cards: readonly CharacterRecord[]): void {
    for (const id of [...this.cardKept.keys()]) if (!cards.some(card => card.id === id)) this.cardKept.delete(id);
  }
  private remember(cards: readonly CharacterRecord[], stored: readonly unknown[]): void {
    const raw = new Map(stored.map(value => [(value as { id?: unknown })?.id, value]));
    this.originals = new Map(cards.flatMap(card => raw.has(card.id) ? [[card.id, { record: structuredClone(card), raw: structuredClone(raw.get(card.id)) }] as const] : []));
  }
  private mutate<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async save(draft: CharacterDraft, id?: string): Promise<CharacterCardState> {
    const validated = validateCharacterDraft(draft);
    // 熟悉度: an explicit "off" is stored as no field at all, so a card that never turned it on stays byte-for-byte what it was.
    // F6: "更真实的情绪" never comes from a draft (editor, import, copy): it stays what the card has, and a new card starts off.
    const { slowWarmUp, realerEmotions: _draftRealer, understandingNotes, ...rest } = validated;
    const warm = slowWarmUp === true ? { slowWarmUp: true as const } : {};
    // I-018 理解说明: a draft without the field (the card editor's) keeps the card's own; a draft with it sets it ('' clears it).
    const notesGiven = Object.hasOwn(draft as object, 'understandingNotes');
    const notes = (value: string | undefined) => value ? { understandingNotes: value } : {};
    return this.mutate(async () => {
      const next = structuredClone(this.state);
      if (id !== undefined) {
        const existing = this.find(id);
        const { slowWarmUp: before, realerEmotions: realer, understandingNotes: notesBefore, ...kept } = existing;
        next.cards[next.cards.findIndex((card) => card.id === id)] = {
          ...kept,
          ...(slowWarmUp === undefined && before === true ? { slowWarmUp: true as const } : {}),
          ...rest,
          ...warm,
          ...notes(notesGiven ? understandingNotes : notesBefore),
          ...(realer === true ? { realerEmotions: true as const } : {}),
        };
      } else {
        if (next.cards.length >= MAX_CHARACTER_CARDS)
          throw new Error(`最多保存 ${MAX_CHARACTER_CARDS} 张角色卡。`);
        next.cards.push({ id: randomUUID(), ...rest, ...warm, mood: validated.mood ?? defaultCharacterMoodTemplate(), ...notes(understandingNotes) });
      }
      return this.persist(next);
    });
  }
  /** Migrate only missing legacy templates, preserving an already tuned private profile. */
  ensureMoodTemplates(resolve: (id: string) => MoodParameters | undefined): Promise<CharacterCardState> {
    return this.mutate(async () => {
      const next = structuredClone(this.state);
      let changed = false;
      for (const card of next.cards) {
        if (card.mood !== undefined) continue;
        const saved = resolve(card.id);
        card.mood = saved === undefined ? defaultCharacterMoodTemplate() : { version: 1, parameters: validateMoodParameters(saved) };
        changed = true;
      }
      return changed ? this.persist(next) : this.publicState();
    });
  }
  /** Update template parameters only; activation, runtime values and memories remain independent. */
  saveMoodParameters(id: string, parameters: unknown): Promise<CharacterCardState> {
    const mood = { version: 1 as const, parameters: validateMoodParameters(parameters) };
    return this.mutate(async () => {
      this.find(id);
      const cards = this.state.cards.map(card => card.id === id ? { ...card, mood } : card);
      return this.persist({ ...this.state, cards });
    });
  }
  /** 熟悉度: only this card's "关系慢慢升温" changes (chat settings card, card editor); text, mood and model stay. */
  setSlowWarmUp(id: string, value: boolean): Promise<CharacterCardState> {
    if (typeof value !== 'boolean') throw new Error('“关系慢慢升温”只能是开或关。');
    return this.mutate(async () => {
      this.find(id);
      if ((this.find(id).slowWarmUp === true) === value) return this.publicState();
      const cards = this.state.cards.map(card => {
        if (card.id !== id) return card;
        const { slowWarmUp: _before, ...rest } = card;
        return value ? { ...rest, slowWarmUp: true as const } : rest;
      });
      return this.persist({ ...this.state, cards });
    });
  }
  /**
   * F6 "更真实的情绪": only this card's switch changes; text, mood and model stay. Off is stored as no field at all (an off card
   * stays byte for byte what it was). Host only: turning it on is reached only after the user agreed in the consent dialog
   * (electron/realer-emotions-host.ts, or the agent channel's confirm tier for the chat settings card).
   */
  setRealerEmotions(id: string, value: boolean): Promise<CharacterCardState> {
    if (typeof value !== 'boolean') throw new Error('“更真实的情绪”只能是开或关。');
    return this.mutate(async () => {
      if ((this.find(id).realerEmotions === true) === value) return this.publicState();
      const cards = this.state.cards.map(card => {
        if (card.id !== id) return card;
        const { realerEmotions: _before, ...rest } = card;
        return value ? { ...rest, realerEmotions: true as const } : rest;
      });
      return this.persist({ ...this.state, cards });
    });
  }
  activate(id: string): Promise<CharacterCardState> {
    return this.mutate(async () => {
      this.find(id);
      return this.persist({ ...this.state, activeId: id });
    });
  }
  remove(id: string): Promise<CharacterCardState> {
    return this.mutate(async () => {
      this.find(id);
      if (this.state.cards.length === 1)
        throw new Error("至少保留一张角色卡。");
      const installation = new GeneInstallationStore(this.directory, this.writeAtomic);
      let preset;
      try { preset = await installation.read(); } catch { /* Unreadable provenance already blocks any automatic installation. */ }
      if (preset?.cardId === id && (preset.status === 'pending' || preset.firstModelPending))
        await installation.complete({ ...preset, firstModelPending: false }); // Failure keeps the original card.
      const cards = this.state.cards.filter((card) => card.id !== id);
      const next: StoredCards = {
        version: 1,
        cards,
        activeId:
          this.state.activeId === id ? cards[0].id : this.state.activeId,
      };
      if (preset?.cardId === id && this.presetOriginalRecords)
        return this.persistPreservingRecords(next,
          this.presetOriginalRecords.cards.filter(value => (value as { id: string }).id !== id),
          this.state.activeId === id ? next.activeId : this.presetOriginalRecords.activeId);
      return this.persist(next);
    });
  }
  async bindModel(
    id: string,
    modelPath: string | null,
    name?: string,
  ): Promise<CharacterCardState> {
    if (modelPath !== null && !validModelReference(modelPath))
      throw new Error("模型引用必须来自已选择的本地模型。");
    if (name !== undefined && (typeof name !== "string" || name.includes("\0")))
      throw new Error("模型名称格式不正确。");
    return this.mutate(async () => {
      this.find(id);
      // C1: the preinstalled Gene card never goes with another model. Removing its link is allowed (older
      // profiles did) and changes nothing: it still brings the preinstalled Gene (shared/character-model.ts).
      if (modelPath !== null && modelPath !== BUNDLED_CHARACTER_MODEL && id === await this.readPresetGeneId()) throw new Error(PRESET_GENE_MODEL_ERROR);
      const cards = this.state.cards.map((card) => {
        if (card.id !== id) return card;
        const { modelPath: _path, modelName: _name, ...text } = card;
        return modelPath === null
          ? text
          : {
              ...text,
              modelPath,
              modelName: modelName(
                name ||
                  (modelPath === BUNDLED_CHARACTER_MODEL ? "Gene" : modelPath),
              ),
            };
      });
      return this.persist({ ...this.state, cards });
    });
  }
  /**
   * Host maintenance only: the caller must first verify the legacy default ID.
   * Stored names, card order, the active card and the current stage model do not
   * identify that default. Fill only a missing local binding; never activate or
   * replace a user's existing binding, including an explicit different model.
   */
  ensureBundledGeneBinding(id: string): Promise<BundledGeneBindingResult> {
    return this.mutate(async () => {
      const target = this.find(id);
      if (target.modelPath !== undefined)
        return { state: this.publicState(), changed: false };
      const cards = this.state.cards.map((card) =>
        card.id === id
          ? { ...card, modelPath: BUNDLED_CHARACTER_MODEL, modelName: "Gene" }
          : card,
      );
      return {
        state: await this.persist({ ...this.state, cards }),
        changed: true,
      };
    });
  }
  /** C1: the preinstalled Gene card's id while that card exists (its installation record), else null. */
  presetGeneId(): Promise<string | null> {
    return this.mutate(() => this.readPresetGeneId());
  }
  private async readPresetGeneId(): Promise<string | null> {
    let record;
    try { record = await new GeneInstallationStore(this.directory, this.writeAtomic).read(); } catch { return null; }
    return record && this.state.cards.some(card => card.id === record!.cardId) ? record.cardId : null;
  }
  /** C2, host only: what the card wall needs per card (the model path never leaves the host). */
  rosterCards(): { id: string; name: string; description: string; personality: string; modelPath?: string; modelName?: string }[] {
    return this.state.cards.map(card => ({ id: card.id, name: card.name, description: card.description, personality: card.personality,
      ...(card.modelPath ? { modelPath: card.modelPath, modelName: card.modelName } : {}) }));
  }
  /** C1, host only: each card's id, name and model link for the model decision (shared/character-model.ts). */
  modelCards(): CharacterModelCard[] {
    return this.state.cards.map(card => ({ id: card.id, name: card.name, ...(card.modelPath ? { modelPath: card.modelPath } : {}) }));
  }
  /**
   * C1: apply a model decision in one write. `switch` makes the linked card current; `bind` links the unlinked card
   * whose name matched and makes it current; `create` adds a minimal card for the model and makes it current.
   * Nothing is deleted and no other card's text, mood or link changes.
   */
  adoptModel(decision: CharacterModelDecision, link: { modelPath: string; modelName: string }): Promise<ModelAdoptionResult> {
    if (!validModelReference(link.modelPath)) throw new Error("模型引用必须来自已选择的本地模型。");
    return this.mutate(async () => {
      if (decision.kind === 'keep') return { state: this.publicState(), id: this.find(decision.id).id, kind: 'keep', changed: false };
      const next = structuredClone(this.state);
      let id: string;
      if (decision.kind === 'switch') {
        const card = this.find(decision.id);
        if (!sameModelReference(card.modelPath ?? (card.id === await this.readPresetGeneId() ? BUNDLED_CHARACTER_MODEL : undefined), link.modelPath))
          throw new Error('这张角色卡已经不再关联这个模型，请重新载入模型。');
        id = card.id;
      } else if (decision.kind === 'bind') {
        const card = this.find(decision.id);
        if (card.modelPath !== undefined || card.id === await this.readPresetGeneId()) throw new Error('这张角色卡已经关联了别的模型，请重新载入模型。');
        id = card.id;
        next.cards = next.cards.map(value => value.id === id ? { ...value, modelPath: link.modelPath, modelName: modelName(link.modelName) } : value);
      } else {
        if (next.cards.length >= MAX_CHARACTER_CARDS) throw new Error(`最多保存 ${MAX_CHARACTER_CARDS} 张角色卡；请先删除一张，再给这个模型建角色卡。`);
        id = randomUUID();
        next.cards.push({ id, ...minimalCharacterDraft(decision.name), modelPath: link.modelPath, modelName: modelName(link.modelName) });
      }
      if (next.activeId === id && decision.kind === 'switch') return { state: this.publicState(), id, kind: decision.kind, changed: false };
      next.activeId = id;
      return { state: await this.persist(next), id, kind: decision.kind, changed: true };
    });
  }
  async import(text: string): Promise<CharacterCardState> {
    return this.save(parseCharacterCardText(text).draft);
  }
  /** C3, host only: an opaque fingerprint of one card as stored (text, mood, model link); a confirmation is tied to it. */
  cardFingerprint(id: string): string {
    return recordFingerprint(this.find(id));
  }
  /**
   * C3 用角色卡文件原地更新 (docs/claude/2026-11-03-card-update-in-place.md): the same card, the same id. Only the
   * persona text, the mood template and "关系慢慢升温" become `draft`'s (a draft without a mood keeps the card's own
   * template); the id and the model link stay, so everything kept by id (chats, diary and profile, familiarity, her own
   * life, little needs, match counts, mood state, picture) still belongs to her. `expected` is cardFingerprint() from
   * when the change was shown: a card changed since is not updated. `backup` runs inside this queue right before the
   * one write; when it throws, nothing is written.
   */
  updateInPlace(id: string, draft: CharacterDraft, options: { expected: string; backup(): Promise<unknown> }): Promise<{ state: CharacterCardState; changed: boolean }> {
    const validated = validateCharacterDraft(draft);
    return this.mutate(async () => {
      const existing = this.find(id);
      if (recordFingerprint(existing) !== options.expected)
        throw new Error('这张角色卡在确认之后又改过了，没有更新；请重新选择角色卡文件。');
      const { slowWarmUp, mood, realerEmotions: _fileRealer, ...text } = validated;
      const record: CharacterRecord = {
        id: existing.id,
        ...text,
        ...(mood !== undefined ? { mood } : existing.mood !== undefined ? { mood: existing.mood } : {}),
        // 熟悉度: "off" is no field at all, exactly like the editor's save.
        ...(slowWarmUp === true ? { slowWarmUp: true as const } : {}),
        // F6: the user's own choice stays; a card file never turns "更真实的情绪" on or off.
        ...(existing.realerEmotions === true ? { realerEmotions: true as const } : {}),
        ...(existing.modelPath !== undefined ? { modelPath: existing.modelPath, modelName: existing.modelName } : {}),
      };
      if (isDeepStrictEqual(record, existing)) return { state: this.publicState(), changed: false };
      await options.backup();
      const cards = this.state.cards.map(card => card.id === id ? record : card);
      return { state: await this.persist({ ...this.state, cards }), changed: true };
    });
  }
  export(id: string): string {
    const card = this.find(id);
    // 熟悉度: "关系慢慢升温" travels with the card, only when it is on (an off card exports exactly as before).
    // F6: "更真实的情绪" too, only when on (an importer never turns it on by itself: parseCharacterCardText).
    const { slowWarmUp, realerEmotions, ...fields } = draftFields(card as unknown as Record<string, unknown>);
    return JSON.stringify(
      {
        format: CHARACTER_CARD_FORMAT,
        version: CHARACTER_CARD_VERSION,
        card: { ...fields, mood: { version: 1, parameters: effectiveCharacterMood(card) }, ...(slowWarmUp === true ? { slowWarmUp: true } : {}),
          ...(realerEmotions === true ? { realerEmotions: true } : {}) },
      },
      null,
      2,
    );
  }
}
