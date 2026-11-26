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
} from "../../shared/cards/character-cards";
import { DEFAULT_REALER_DURATION, isRealerDuration, realerUntil, type RealerDuration } from '../../shared/mood';
import { validateMoodParameters, type MoodParameters } from '../../shared/foundation/mood';
import { slowWarmUpOf } from '../../shared/foundation/character-card';
import { minimalCharacterDraft, sameModelReference, type CharacterModelCard, type CharacterModelDecision } from '../../shared/cards/character-model';
import { atomicWriteFile, type AtomicFileWriter } from '../foundation/atomic-file';
import { GeneInstallationStore, GENE_PRESET, GENE_ENGLISH_PRESET, PREINSTALLED_PRESETS, presetModel, type GenePreset, type GeneInstallation } from './gene-preinstalled-card';
import { bundledModelName, isBundledModelKey } from '../../shared/cards/bundled-characters';
import { KeptFields, splitUnknownFields, type KnownFields } from '../foundation/unknown-fields';
import { normalizeCharacterVoice, portableCharacterVoice, sameCharacterVoice, type CharacterVoice } from '../../shared/foundation/character-voice';

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
      ...(Object.hasOwn(value, 'language') ? { language: value.language } : {}),
      ...(Object.hasOwn(value, 'sleepHabit') ? { sleepHabit: value.sleepHabit } : {}), // I-078 第 3 步 睡相
      ...(Object.hasOwn(value, 'musicTaste') ? { musicTaste: value.musicTaste } : {}),
      ...(Object.hasOwn(value, 'slips') ? { slips: value.slips } : {}), // 小毛病
      ...(Object.hasOwn(value, 'voice') ? { voice: value.voice } : {}), // I-162 her default voice (normalized: never a key or a path)
      ...(Object.hasOwn(value, 'milestone') ? { milestone: value.milestone } : {}), // I-207 the card's milestone words
      ...(Object.hasOwn(value, 'object') ? { object: value.object } : {}), // I-208 the card's object (name and fixed entries; her margin notes are not here)
    },
  );
}
/** I-162: a preset's identity is its persona and switches; her voice is local (like the model link), so it never makes a preset "changed". */
function presetFields(value: Record<string, unknown>): CharacterDraft { const { voice: _voice, ...rest } = draftFields(value); return rest; }
/** I-172: a preset card carries its own voice (Gene: Drama 3), but the voice is no part of its identity, so the preset's draft is compared without it too. */
const presetIdentity = (preset: GenePreset): CharacterDraft => presetFields(preset.draft() as unknown as Record<string, unknown>);
function knownFields(value: Record<string, unknown>, allowed: readonly string[], message: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(message);
}
const textFields = Object.keys(CHARACTER_TEXT_LIMITS);
/**
 * What this version knows in characters.json (docs/claude/2026-11-04-keep-unknown-fields.md). Anything else a newer version
 * wrote, on the file or on a card, is kept aside and written back with it, never read: not in publicState, getActive,
 * export, the fingerprint or the roster. Before, such a file was refused and the app could not start. The mood template
 * is one whole value: its parameters stay strict (shared/foundation/mood.ts validateMoodParameters). Card files someone imports are
 * not stored files: parseCharacterCardText still refuses unknown fields.
 */
const STORED_CARD_FIELDS = ['id', ...textFields, 'mood', 'slowWarmUp', 'realerEmotions', 'realerEmotionsUntil', 'realerEmotionsExpired', 'understandingNotes', 'language', 'sleepHabit', 'musicTaste', 'slips', 'voice', 'milestone', 'object', 'modelPath', 'modelName'];
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
/** Which card file a text was: soft hearts v1 / v2 (v3 is unwrapped first, shared/cards/character-response-portable.ts), Tavern V2 or an older Tavern text card. */
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
    knownFields(data, [...textFields, ...(parsed.version === CHARACTER_CARD_VERSION ? ['mood', 'slowWarmUp', 'realerEmotions', 'understandingNotes', 'language', 'sleepHabit', 'musicTaste', 'slips', 'voice', 'milestone', 'object'] : [])],'角色卡包含未知字段；不能导入路径、连接、权限或私人状态。');
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
/** I-112 B: the local timer state of "更真实的情绪" travels with the stored card and the public card, never with a draft or an export. */
const realerTimerFields = (card: Pick<CharacterCard, 'realerEmotions' | 'realerEmotionsUntil' | 'realerEmotionsExpired'>): Pick<CharacterCard, 'realerEmotionsUntil' | 'realerEmotionsExpired'> => ({
  ...(card.realerEmotions === true && typeof card.realerEmotionsUntil === 'number' && Number.isFinite(card.realerEmotionsUntil) && card.realerEmotionsUntil > 0 ? { realerEmotionsUntil: card.realerEmotionsUntil } : {}),
  ...(card.realerEmotions !== true && card.realerEmotionsExpired === true ? { realerEmotionsExpired: true as const } : {}),
});
const publicCard = (card: CharacterRecord): CharacterCard => ({
  id: card.id,
  ...draftFields(card as unknown as Record<string, unknown>),
  ...realerTimerFields(card),
  ...(card.modelName ? { modelName: card.modelName } : {}),
});
const modelName = (value: string) =>
  path.basename(path.win32.basename(value)).slice(0, 160);
const validModelReference = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 32768 &&
  !value.includes("\0") &&
  (isBundledModelKey(value) || path.isAbsolute(value));

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
    private readonly clock: () => number = Date.now,
  ) {
    this.file = path.join(directory, "characters.json");
  }
  /** `uiLanguage` (I-071 v2): on a fresh profile the card in that language is the default and the other preinstalled Gene comes along. Omitted: only Chinese Gene, as before. */
  load(options: { preinstalledGene?: boolean; freshProfile?: boolean; uiLanguage?: 'zh-CN' | 'en' } = {}): Promise<CharacterCardState> {
    // I-112 B: a card whose "更真实的情绪" ran out while the app was closed is off before anything else reads the cards.
    return this.mutate(() => this.loadFromDisk(options)).then(async state => (await this.expireRealerEmotions()).length ? this.publicState() : state);
  }
  private async loadFromDisk(options: { preinstalledGene?: boolean; freshProfile?: boolean; uiLanguage?: 'zh-CN' | 'en' }): Promise<CharacterCardState> {
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
        const english = options.uiLanguage === 'en';
        const first = english ? GENE_ENGLISH_PRESET : GENE_PRESET;
        await this.installGene(true, first);
        if (this.state.cards.length) {
          // 0.2.0: the other preinstalled cards (the other Gene, One and Mumi in both languages) go in next to the first one, never as the default; only for a profile's very first start.
          if (options.uiLanguage) for (const other of PREINSTALLED_PRESETS) if (other !== first) await this.installGene(false, other).catch(() => {});
          return this.publicState();
        }
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
      const card: CharacterRecord = { id: record.id, ...draftFields(record), ...realerTimerFields(record as unknown as CharacterCard) };
      if (record.modelPath !== undefined) {
        if (!validModelReference(record.modelPath))
          throw new Error("角色卡模型引用不正确。");
        card.modelPath = record.modelPath;
        card.modelName = modelName(
          typeof record.modelName === "string" && record.modelName
            ? record.modelName
            : isBundledModelKey(record.modelPath) ? bundledModelName(record.modelPath) : record.modelPath,
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
    // A preinstalled card whose first install was interrupted (its record exists, not finished) is finished here; an existing profile never gets a new one.
    for (const preset of PREINSTALLED_PRESETS.slice(1)) {
      try { const record = await new GeneInstallationStore(this.directory, this.writeAtomic, preset).read(); if (record && record.status !== 'installed') await this.installGene(false, preset); }
      catch { /* retried at the next start */ }
    }
  }
  /** Runs only inside the store queue. Never edits, activates or rebinds an existing card. */
  private async installGene(initialDefault: boolean, preset: GenePreset = GENE_PRESET): Promise<void> {
    const installation = new GeneInstallationStore(this.directory, this.writeAtomic, preset);
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
    if (record.definitionVersion !== 1 || record.definitionSha256 !== preset.sha256)
      throw Error('待完成的 Gene 定义已变化；原角色与来源记录保持。');
    const existing = this.state.cards.find(card => card.id === record!.cardId);
    if (existing) {
      if (!isDeepStrictEqual(presetFields(existing as unknown as Record<string, unknown>), presetIdentity(preset))
        || existing.modelPath !== presetModel(preset).modelPath || existing.modelName !== presetModel(preset).modelName)
        throw Error('待完成的 Gene 编号内容已变化；不覆盖现有角色。');
    } else {
      if (record.cardsBeforeSha256 !== cardsHash)
        throw Error('待完成预装记录之后角色文件已改变；不重新添加或覆盖角色。');
      const card: CharacterRecord = { id: record.cardId, ...preset.draft(), ...presetModel(preset) };
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
      const found = await this.firstModelRecord();
      if (!found) return false;
      const { installation, record, preset } = found;
      const card = this.state.cards.find(value => value.id === record.cardId);
      // The cards are the first preset alone, or (I-071 v2) it together with the other preinstalled Gene, unchanged.
      const twins = new Map<string, GenePreset>(); // 0.2.0: and with the other preinstalled cards (One, Mumi, the other Gene)
      for (const other of PREINSTALLED_PRESETS) { const found = other === preset ? null : await new GeneInstallationStore(this.directory, this.writeAtomic, other).read().catch(() => null); if (found) twins.set(found.cardId, other); }
      const othersAreItsTwin = this.state.cards.every(value => value.id === record.cardId || (twins.has(value.id)
        && isDeepStrictEqual(presetFields(value as unknown as Record<string, unknown>), presetIdentity(twins.get(value.id)!))));
      const sameFirstCard = othersAreItsTwin && this.state.activeId === record.cardId && !!card
        && card.modelPath === BUNDLED_CHARACTER_MODEL && card.modelName === 'Gene'
        && isDeepStrictEqual(presetFields(card as unknown as Record<string, unknown>), presetIdentity(preset))
        && record.definitionVersion === 1 && record.definitionSha256 === preset.sha256;
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
      const found = await this.firstModelRecord();
      if (found) {
        await found.installation.complete({ ...found.record, firstModelPending: false });
        this.presetNotice = undefined;
      }
    });
  }
  /** The preinstalled Gene (either one) whose first model setup is still waiting. Unreadable records read as none. */
  private async firstModelRecord(): Promise<{ installation: GeneInstallationStore; record: GeneInstallation; preset: GenePreset } | null> {
    for (const preset of [GENE_PRESET, GENE_ENGLISH_PRESET]) {
      const installation = new GeneInstallationStore(this.directory, this.writeAtomic, preset);
      let record: GeneInstallation | null;
      try { record = await installation.read(); } catch { if (preset === GENE_PRESET) return null; continue; }
      if (record?.initialDefault && record.firstModelPending) return { installation, record, preset };
    }
    return null;
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
  /** I-209 step 2: one card by id (a turn of someone on stage reads her own card, not the active one). Throws when there is none. */
  getCard(id: string): CharacterRecord {
    return structuredClone(this.find(id));
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
    // 熟悉度: on unless the card saved an explicit false, so "off" is stored as false (a missing field means on).
    // A draft that names it sets it; a card that never named it stays without the field.
    // F6: "更真实的情绪" never comes from a draft (editor, import, copy): it stays what the card has, and a new card starts off.
    const { slowWarmUp, realerEmotions: _draftRealer, understandingNotes, musicTaste, slips, ...rest } = validated;
    const warm = slowWarmUp !== undefined ? { slowWarmUp } : {};
    // I-077 step 2: a draft that names a taste sets it (all 50 clears it); a draft without the key keeps the card's own.
    const tasteGiven = Object.hasOwn(draft as object, 'musicTaste');
    const taste = (value: typeof musicTaste) => value ? { musicTaste: value } : {};
    // 小毛病: like the taste, a draft that names it sets it ('default' clears it); a draft without the key keeps the card's own.
    const slipsGiven = Object.hasOwn(draft as object, 'slips');
    const slipsField = (value: typeof slips) => value ? { slips: value } : {};
    // I-018 理解说明: a draft without the field (the card editor's) keeps the card's own; a draft with it sets it ('' clears it).
    const notesGiven = Object.hasOwn(draft as object, 'understandingNotes');
    const notes = (value: string | undefined) => value ? { understandingNotes: value } : {};
    return this.mutate(async () => {
      const next = structuredClone(this.state);
      if (id !== undefined) {
        const existing = this.find(id);
        const { slowWarmUp: before, realerEmotions: realer, realerEmotionsUntil: _untilBefore, realerEmotionsExpired: _expiredBefore, understandingNotes: notesBefore, musicTaste: tasteBefore, slips: slipsBefore, ...kept } = existing;
        next.cards[next.cards.findIndex((card) => card.id === id)] = {
          ...kept,
          ...(slowWarmUp === undefined && before !== undefined ? { slowWarmUp: before } : {}),
          ...rest,
          ...warm,
          ...notes(notesGiven ? understandingNotes : notesBefore),
          ...taste(tasteGiven ? musicTaste : tasteBefore),
          ...slipsField(slipsGiven ? slips : slipsBefore),
          ...(realer === true ? { realerEmotions: true as const } : {}),
          ...realerTimerFields(existing),
        };
      } else {
        if (next.cards.length >= MAX_CHARACTER_CARDS)
          throw new Error(`最多保存 ${MAX_CHARACTER_CARDS} 张角色卡。`);
        next.cards.push({ id: randomUUID(), ...rest, ...warm, mood: validated.mood ?? defaultCharacterMoodTemplate(), ...notes(understandingNotes), ...taste(musicTaste), ...slipsField(slips) });
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
  /** I-162: set (undefined: clear) some cards' default voice in one write; text, mood and model stay. Unknown ids are skipped. */
  setVoices(voices: ReadonlyMap<string, CharacterVoice | undefined>): Promise<CharacterCardState> {
    return this.mutate(async () => {
      let changed = false;
      const cards = this.state.cards.map(card => {
        const voice = normalizeCharacterVoice(voices.get(card.id));
        if (!voices.has(card.id) || sameCharacterVoice(card.voice, voice)) return card;
        changed = true;
        const { voice: _before, ...rest } = card;
        return voice ? { ...rest, voice } : rest;
      });
      return changed ? this.persist({ ...this.state, cards }) : this.publicState();
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
  /** 熟悉度: only this card's "慢慢熟悉" changes (chat settings card, card editor); text, mood and model stay. */
  setSlowWarmUp(id: string, value: boolean): Promise<CharacterCardState> {
    if (typeof value !== 'boolean') throw new Error('“慢慢熟悉”只能是开或关。');
    return this.mutate(async () => {
      this.find(id);
      // an explicit choice is saved either way (a missing field means on), so "off" survives a restart and an update.
      if (slowWarmUpOf(this.find(id)) === value && this.find(id).slowWarmUp !== undefined) return this.publicState();
      const cards = this.state.cards.map(card => card.id === id ? { ...card, slowWarmUp: value } : card);
      return this.persist({ ...this.state, cards });
    });
  }
  /**
   * F6 "更真实的情绪": only this card's switch changes; text, mood and model stay. Off is stored as no field at all (an off card
   * stays byte for byte what it was). Host only: turning it on is reached only after the user agreed in the consent dialog
   * (electron/mood/realer-emotions-host.ts, or the agent channel's confirm tier for the chat settings card).
   */
  setRealerEmotions(id: string, value: boolean, duration: RealerDuration = DEFAULT_REALER_DURATION): Promise<CharacterCardState> {
    if (typeof value !== 'boolean') throw new Error('“更真实的情绪”只能是开或关。');
    if (!isRealerDuration(duration)) throw new Error('“更真实的情绪”开多久只能是一天、一周、一个月或一直开。');
    return this.mutate(async () => {
      const existing = this.find(id);
      // Same switch value: nothing changes, except that an "已到期关闭" note goes away once the user turns it off by hand.
      if ((existing.realerEmotions === true) === value && !(value === false && existing.realerEmotionsExpired === true)) return this.publicState();
      // I-112 B: every change of the switch by the user clears the old end time and the "expired" note; on stores the new end time.
      const until = value ? realerUntil(duration, this.clock()) : null;
      const cards = this.state.cards.map(card => {
        if (card.id !== id) return card;
        const { realerEmotions: _before, realerEmotionsUntil: _until, realerEmotionsExpired: _expired, ...rest } = card;
        return value ? { ...rest, realerEmotions: true as const, ...(until !== null ? { realerEmotionsUntil: until } : {}) } : rest;
      });
      return this.persist({ ...this.state, cards });
    });
  }
  /**
   * I-112 B: turns off every card whose end time has passed (no field left but the "已到期关闭" note). One write, only when
   * something expired. Returns the ids that expired. Called at load (so before the first chat turn) and by the running app's timer.
   */
  expireRealerEmotions(now: number = this.clock()): Promise<string[]> {
    return this.mutate(async () => {
      const due = this.state.cards.filter(card => card.realerEmotions === true && typeof card.realerEmotionsUntil === 'number' && card.realerEmotionsUntil <= now).map(card => card.id);
      if (!due.length) return [];
      const cards = this.state.cards.map(card => {
        if (!due.includes(card.id)) return card;
        const { realerEmotions: _on, realerEmotionsUntil: _until, ...rest } = card;
        return { ...rest, realerEmotionsExpired: true as const };
      });
      await this.persist({ ...this.state, cards });
      return due;
    });
  }
  /** The earliest end time among the cards that are on, for the running app's timer; null when none will expire. */
  nextRealerExpiry(): number | null {
    const times = this.state.cards.flatMap(card => card.realerEmotions === true && typeof card.realerEmotionsUntil === 'number' ? [card.realerEmotionsUntil] : []);
    return times.length ? Math.min(...times) : null;
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
  /**
   * I-144 回收站: a card exactly as stored (its record in characters.json and its place), or null. Nothing changes. The model binding is
   * part of the record, so it comes back with it.
   */
  recycleCopy(id: string): { at: number; card: CharacterRecord; stored: unknown } | null {
    const at = this.state.cards.findIndex(card => card.id === id);
    if (at < 0) return null;
    const card = this.state.cards[at]!;
    return { at, card: structuredClone(card), stored: structuredClone(this.storedRecords([card])[0]) };
  }
  /** I-144: the card comes back under the same id, at its place, written as it was stored. It does not become the current one. */
  recycleRestore(id: string, part: unknown): Promise<CharacterCardState> {
    return this.mutate(async () => {
      const value = part as { at?: unknown; card?: CharacterRecord; stored?: unknown } | null;
      if (!value || !Number.isInteger(value.at) || !value.card || value.card.id !== id || !uuid.test(id) || (value.stored as { id?: unknown } | null)?.id !== id)
        throw new Error('回收站里这一项的数据不完整，原文件已保留。');
      if (this.state.cards.some(card => card.id === id)) throw new Error('这个角色已经在了。');
      if (this.state.cards.length >= MAX_CHARACTER_CARDS) throw new Error('角色卡已经满了，先删掉一张再找回。');
      draftFields(value.card as unknown as Record<string, unknown>); // throws for a card that would not load
      const card: CharacterRecord = { ...structuredClone(value.card), id };
      if (card.modelPath !== undefined && !validModelReference(card.modelPath)) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
      const split = splitUnknownFields(object(structuredClone(value.stored)), CARD_KNOWN_FIELDS, { label: '回收站里的角色卡' });
      if (!split.kept.empty) this.cardKept.set(id, split.kept);
      const cards = [...this.state.cards];
      cards.splice(Math.max(0, Math.min(cards.length, value.at as number)), 0, card);
      // Remembered as stored, so the write below puts the very same record back.
      this.originals.set(id, { record: structuredClone(card), raw: structuredClone(value.stored) });
      return this.persist({ ...this.state, cards });
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
      // profiles did) and changes nothing: it still brings the preinstalled Gene (shared/cards/character-model.ts).
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
                  (isBundledModelKey(modelPath) ? bundledModelName(modelPath) : modelPath),
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
  rosterCards(): { id: string; name: string; description: string; personality: string; modelPath?: string; modelName?: string; language?: string }[] {
    return this.state.cards.map(card => ({ id: card.id, name: card.name, description: card.description, personality: card.personality,
      ...(card.language ? { language: card.language } : {}),
      ...(card.modelPath ? { modelPath: card.modelPath, modelName: card.modelName } : {}) }));
  }
  /** C1, host only: each card's id, name and model link for the model decision (shared/cards/character-model.ts). */
  modelCards(): CharacterModelCard[] {
    return this.state.cards.map(card => ({ id: card.id, name: card.name, ...(card.language ? { language: card.language } : {}), ...(card.modelPath ? { modelPath: card.modelPath } : {}) }));
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
  /**
   * I-071 v2 转换 (electron/cards/character-convert/): adds the converted card under the id its memories were saved for, with the same
   * model link as the card it came from. Not made current. "更真实的情绪" never comes along (it needs the user's own yes on this
   * card). Refuses an id that exists and a full card list.
   */
  addConverted(id: string, draft: CharacterDraft, model: { modelPath: string; modelName?: string } | null): Promise<CharacterCardState> {
    const validated = validateCharacterDraft(draft);
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error('新角色的编号不正确。');
    if (model !== null && (!validModelReference(model.modelPath) || (model.modelName !== undefined && (typeof model.modelName !== 'string' || model.modelName.includes('\0')))))
      throw new Error('模型引用必须来自已选择的本地模型。');
    const { slowWarmUp, realerEmotions: _realer, understandingNotes, musicTaste, slips, ...rest } = validated;
    return this.mutate(async () => {
      if (this.state.cards.some(card => card.id === id)) throw new Error('这个编号的角色卡已经存在。');
      if (this.state.cards.length >= MAX_CHARACTER_CARDS) throw new Error(`最多保存 ${MAX_CHARACTER_CARDS} 张角色卡；请先删除一张再转换。`);
      const next = structuredClone(this.state);
      next.cards.push({ id, ...rest, ...(slowWarmUp !== undefined ? { slowWarmUp } : {}), mood: validated.mood ?? defaultCharacterMoodTemplate(),
        ...(understandingNotes ? { understandingNotes } : {}),
        ...(musicTaste ? { musicTaste } : {}),
        ...(slips ? { slips } : {}),
        ...(model ? { modelPath: model.modelPath, modelName: modelName(model.modelName || (isBundledModelKey(model.modelPath) ? bundledModelName(model.modelPath) : model.modelPath)) } : {}) });
      return this.persist(next);
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
   * persona text, the mood template and "慢慢熟悉" become `draft`'s (a draft without a mood keeps the card's own
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
      const { slowWarmUp, mood, realerEmotions: _fileRealer, musicTaste, slips, ...text } = validated;
      const record: CharacterRecord = {
        id: existing.id,
        ...text,
        ...(mood !== undefined ? { mood } : existing.mood !== undefined ? { mood: existing.mood } : {}),
        // 熟悉度: stored like the editor's save (an explicit false stays false; planCharacterCardUpdate already kept her choice when the file has none).
        ...(slowWarmUp !== undefined ? { slowWarmUp } : {}),
        // F6: the user's own choice stays; a card file never turns "更真实的情绪" on or off.
        ...(existing.realerEmotions === true ? { realerEmotions: true as const } : {}),
        ...realerTimerFields(existing),
        // I-077 step 2: planCharacterCardUpdate already decided (a file with a taste brings it, one without keeps hers).
        ...(musicTaste ? { musicTaste } : {}),
        ...(slips ? { slips } : {}), // 小毛病: planCharacterCardUpdate already decided (a file with it brings it, one without keeps hers)
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
    // 熟悉度: "慢慢熟悉" travels with the card as its effective value, so an off card stays off and a card without the field exports as on.
    // F6: "更真实的情绪" too, only when on (an importer never turns it on by itself: parseCharacterCardText).
    // I-162: her voice leaves only as provider, voice id, pace and description (portableCharacterVoice): never a key, a path or a link.
    const { slowWarmUp, realerEmotions, voice: ownVoice, ...fields } = draftFields(card as unknown as Record<string, unknown>);
    const voice = portableCharacterVoice(ownVoice);
    return JSON.stringify(
      {
        format: CHARACTER_CARD_FORMAT,
        version: CHARACTER_CARD_VERSION,
        card: { ...fields, ...(voice ? { voice } : {}), mood: { version: 1, parameters: effectiveCharacterMood(card) }, slowWarmUp: slowWarmUpOf({ slowWarmUp }),
          ...(realerEmotions === true ? { realerEmotions: true } : {}) },
      },
      null,
      2,
    );
  }
}
