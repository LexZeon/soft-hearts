// I-071 v2 第三步: one conversion at a time, in the background, cancellable until it
// starts saving. The order keeps the user's data safe:
//   0. (fix 8) write this conversion's marker (staging/<job>/job.json, naming its backup) before anything else, so an interruption
//      at any later point is found and cleaned at the next start;
//   1. back up the shared files the save will touch (characters.json, settings.json, memories.jsonl, memory-scopes.json);
//   2. read the source's memories (read only, snapshot.ts);
//   3. translate on the user's own Claude Code (translate.ts / model.ts) and build the new card's data (build.ts) in memory and in a
//      staging folder; a cancel or a failure here deletes the staging folder and that backup: nothing outside them was touched;
//   4. save, new card's own files first and the card itself last (the commit point: until the card exists nothing else can see
//      them). A failure while saving rolls every part back; an interruption (the app quit or crashed) is rolled back at the next
//      start from the marker in the staging folder. Fix 8 (Codex T-240): a marker is removed only after everything it guards was
//      really removed; a part that could not be removed keeps it (the message says so) and the next start tries again.
// The source card, her memories, diary, profile, familiarity and notes are never written: every write names the new id and scope.
// No Electron import: tests drive it with real stores and a fake Claude.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateCharacterDraft, type CardLanguage, type CharacterDraft } from '../../../shared/cards/character-cards';
import {
  CONVERSION_LIMITS, CONVERSION_NOT_COPIED, CONVERSION_UNTOUCHED_NOTE, CONVERSION_STEPS, MAX_LEFT_OUT_LISTED, canConvert, conversionCopiedLines, conversionCostText, conversionTargetOf,
  checkConversionExtra, conversionCappedItems, resolveConversionAliases, resolveConversionNames, validateConversionRequest,
  type ConversionExtraName, type ConversionLeftOutItem, type ConversionJobView, type ConversionPreview, type ConversionRequest, type ConversionStepId,
} from '../../../shared/cards/character-convert';
import { cardLanguageOf } from '../../../shared/foundation/character-card';
import { conversionSettingsLines } from '../../../shared/cards/character-convert';
import { MAX_TTS_STYLE_BINDINGS, type TtsStyleBinding } from '../../../shared/voice';
import { userProfileScopeId } from '../../memory';
import { ReviewStore } from '../../memory';
import { buildConversion, conversionItems, nameMap, type CarrierRecord, type ConversionBundle } from './build';
import { personaCorpus, personaExcerpt, readSourceSnapshot, sourceCorpus, type ConversionSourcePorts, type SourceSnapshot } from './snapshot';
import { PERSONA_FIELD_LABELS, plannedCalls, translateMemories, translatePersona, type ConversionModel, type PersonaField } from './translate';

export const CONVERSION_FOLDER = 'character-convert';
/** The shared files a save may change; copied first (the source's own files are only read, so they need no copy). */
export const CONVERSION_BACKUP_FILES = ['characters.json', 'settings.json', 'memories.jsonl', 'memory-scopes.json'] as const;
const KEEP_BACKUPS = 3;

export interface ConversionCommitPorts {
  /** Adds the card with this id (not made current). The commit point. */
  addCard(id: string, draft: CharacterDraft, model: { modelPath: string; modelName?: string } | null): Promise<void>;
  /** Rollback only: removes the card if it exists. */
  removeCard(id: string): Promise<void>;
  hasCard(id: string): boolean;
  relationship: { adopt(id: string, data: ConversionBundle['relationship']): Promise<void>; forget(id: string): Promise<void>; file(id: string): string };
  profiles: {
    restoreScope(scope: { characterId: string; providerScope: string }, stored: unknown, keepReplaced: (current: unknown) => Promise<void>, options?: { keepRecording?: boolean }): Promise<void>;
    forgetScope(scope: { characterId: string; providerScope: string }): Promise<boolean>;
  } | null;
  memory: {
    restoreRecords(records: readonly unknown[], owner: { characterId: string; providerScope: string }): Promise<number>;
    forgetScope(scope: { characterId: string; providerScope: string }): Promise<number>;
  };
  /** Fix 8: `add` never drops another character's binding; it answers how many of these it could not add (the shared list is full). */
  voice: { add(bindings: readonly TtsStyleBinding[]): Promise<{ skipped: number } | void>; remove(characterId: string): Promise<void> };
}

export interface ConversionServiceOptions {
  profileDirectory: string;
  source: ConversionSourcePorts;
  commit: ConversionCommitPorts;
  model: ConversionModel;
  /** The Claude 助手's model and effort (named in the cost line). */
  modelChoice(): { model: string; effort: 'low' | 'medium' | 'high' };
  /** The import check (shared/cards/character-card-lint.ts) on the new card: reminders only. */
  lint(draft: CharacterDraft, existingNames: readonly string[]): string[];
  /** The names of the cards there are now (the import check warns about a name that is taken). */
  cardNames(): string[];
  /** Every view change (the Claude 助手 panel shows it; the channel reads it). */
  emit?(view: ConversionJobView): void;
  now?(): number;
  id?(): string;
}

interface Job { view: ConversionJobView; controller: AbortController; done: Promise<void>; committing: boolean }

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const fixed = (error: unknown, fallback: string) => error instanceof Error && error.message && error.message.length <= 300 && !/[A-Za-z]:[\\/]|\/Users\/|\/home\//.test(error.message)
  ? error.message : fallback;

export class ConversionService {
  private job: Job | null = null;
  private last: ConversionJobView | null = null;
  private recovering: Promise<number> | null = null;
  constructor(private readonly options: ConversionServiceOptions) {}

  /** The new scope's look-back file is written and rolled back by its own small store (the app's one only learns it when that card is opened). */
  private reviewStore(): ReviewStore { return new ReviewStore(path.join(this.options.profileDirectory, 'user-profiles'), { recording: () => true, now: () => this.now() }); }
  private get root(): string { return path.join(this.options.profileDirectory, CONVERSION_FOLDER); }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** What a conversion would carry (read only). Throws a fixed message for a card that cannot be converted to `target`. */
  async preview(characterId: string, target?: CardLanguage): Promise<ConversionPreview> {
    const snapshot = await readSourceSnapshot(characterId, this.options.source);
    const from = cardLanguageOf(snapshot.card), to = target ?? conversionTargetOf(from);
    if (!canConvert(snapshot.card, to)) throw new Error(`「${snapshot.card.name}」已经是${to === 'en' ? '英文' : '中文'}角色了；转换只能转成另一种语言。`);
    return this.previewOf(snapshot, to);
  }

  private previewOf(snapshot: SourceSnapshot, target: CardLanguage): ConversionPreview {
    const calls = plannedCalls(conversionItems(snapshot));
    const choice = this.options.modelChoice();
    // Fix 5: name only the style texts she has (the fourth test's popup said "rewritten" for an empty one).
    const styles = [snapshot.voice.bindings.some(binding => binding.instruction.trim()) ? '百炼的风格文字' : '', snapshot.voice.bindings.some(binding => binding.fishActingStyle?.trim()) ? 'Drama 3 的表演提示' : ''].filter(Boolean);
    const voice = !snapshot.voice.bindings.length ? '她没有自己的朗读设置：新卡用全局的声音（系统声音会自动选这种语言的）'
      : `同一个模型的朗读设置带过去，${styles.length ? `${styles.join('、')}按新语言改写` : '她没有风格文字或表演提示，没有要改写的'}；${snapshot.voice.bindings.some(binding => binding.fishVoiceId) ? 'Drama 3 的声音编号不带（那是原来语言的声音），新卡先用 Drama 3 全局的声音，之后可以在朗读设置里给新卡换；' : ''}密钥和每月上限都不碰`;
    return {
      source: { id: snapshot.card.id, name: snapshot.card.name, language: cardLanguageOf(snapshot.card) }, target,
      names: structuredClone(snapshot.names), counts: { ...snapshot.counts }, copied: conversionCopiedLines(snapshot.counts, target), settings: conversionSettingsLines(snapshot.profile?.recording === true, snapshot.recordingSource),
      notCopied: [...CONVERSION_NOT_COPIED], voice, calls, cost: conversionCostText(calls, choice.model, choice.effort), persona: personaExcerpt(snapshot.card), candidates: structuredClone(snapshot.candidates),
    };
  }

  /** The names the assistant found in the persona, checked against this card (each must occur in it or her memories; totals bounded). */
  async checkExtra(characterId: string, extra: readonly ConversionExtraName[]): Promise<ConversionExtraName[]> {
    const snapshot = await readSourceSnapshot(characterId, this.options.source);
    return checkConversionExtra(snapshot.names, extra, sourceCorpus(snapshot), personaCorpus(snapshot.card));
  }

  /**
   * Fix 8 (Codex T-240 F01): the other written forms of each name the user leaves for later in this request, as the conversion will
   * take them out (the popup shows them). Read only; the same closure the conversion computes again on its fresh read.
   */
  async leftOutForms(raw: unknown): Promise<{ of: string; forms: string[] }[]> {
    const request = validateConversionRequest(raw);
    const snapshot = await readSourceSnapshot(request.characterId, this.options.source);
    const names = resolveConversionNames(snapshot.names, request.names);
    const extra = checkConversionExtra(snapshot.names, request.extra ?? [], sourceCorpus(snapshot), personaCorpus(snapshot.card));
    return structuredClone(nameMap(snapshot, names, resolveConversionAliases(snapshot.names, request.names, extra)).leftOutForms ?? []);
  }

  /** The running conversion, else the last one this run (null when none). */
  view(): ConversionJobView | null { return structuredClone(this.job?.view ?? this.last); }
  get running(): boolean { return !!this.job; }
  /** Waits for the running conversion (tests, quitting). */
  async idle(): Promise<void> { await this.job?.done; }

  /**
   * Starts a conversion after the user's yes (the caller's popup). Checks again that every name has the user's choice and that
   * the card still converts; resolves at once with the running view.
   */
  async start(raw: unknown): Promise<ConversionJobView> {
    const request: ConversionRequest = validateConversionRequest(raw);
    await this.ensureRecovered();
    if (this.job) throw new Error('已经有一个转换在进行，等它完成或先取消。');
    const snapshot = await readSourceSnapshot(request.characterId, this.options.source);
    if (!canConvert(snapshot.card, request.language)) throw new Error(`「${snapshot.card.name}」已经是这种语言的角色了。`);
    const names = resolveConversionNames(snapshot.names, request.names);
    const extra = checkConversionExtra(snapshot.names, request.extra ?? [], sourceCorpus(snapshot), personaCorpus(snapshot.card));
    const aliases = resolveConversionAliases(snapshot.names, request.names, extra);
    if (this.job) throw new Error('已经有一个转换在进行，等它完成或先取消。');
    const id = (this.options.id ?? randomUUID)();
    const view: ConversionJobView = { id, sourceId: snapshot.card.id, sourceName: snapshot.card.name, target: request.language, state: 'running',
      steps: CONVERSION_STEPS.map(step => ({ id: step, status: 'waiting' })), startedAt: this.now(), cancellable: true };
    const controller = new AbortController();
    const job: Job = { view, controller, done: Promise.resolve(), committing: false };
    this.job = job;
    this.emit();
    job.done = this.run(job, snapshot, request.language, names, aliases);
    return structuredClone(view);
  }

  /** 「取消」: true when it will stop; false once saving began (then it finishes or rolls back by itself). */
  cancel(id?: unknown): boolean {
    const job = this.job;
    if (!job || (id !== undefined && id !== job.view.id) || job.committing) return false;
    job.controller.abort(new Error('cancelled'));
    return true;
  }

  /**
   * At start: a conversion the app did not finish (quit or crash). One that had begun saving and has no card yet is rolled back
   * part by part from its commit marker; one that never began saving has its backup removed (fix 8: its job marker names it). A
   * marker goes only when what it guards is really gone; otherwise it stays for the next start.
   */
  ensureRecovered(): Promise<number> { return (this.recovering ??= this.recover().catch(() => 0)); }

  private async recover(): Promise<number> {
    const staging = path.join(this.root, 'staging');
    let names: string[] = [];
    try { names = await readdir(staging); } catch { return 0; }
    let recovered = 0;
    for (const name of names) {
      if (!/^[A-Za-z0-9-]{1,80}$/.test(name) || name === this.job?.view.id) continue; // never the conversion running now
      const folder = path.join(staging, name);
      const commit = await readMarker(path.join(folder, 'commit.json'));
      if (commit && typeof commit.newId === 'string' && typeof commit.providerScope === 'string') {
        // It began saving. With its card there it finished (only the marker was left); else every part goes, the backup stays.
        if (!this.options.commit.hasCard(commit.newId)) {
          const left = await this.rollback(commit.newId, commit.providerScope);
          if (left.length) continue; // the marker stays: the next start tries again
          recovered++;
        }
        await this.removeMarker(folder);
        continue;
      }
      // It never began saving (the app quit while backing up or translating): its backup goes, then the marker.
      const started = await readMarker(path.join(folder, 'job.json')), backup = started && backupOf(this.root, started);
      if (backup && !await this.dropBackup(backup)) continue; // its backup is still there: keep the marker
      if (await this.removeMarker(folder) && backup) await this.dropFolders(backup);
    }
    return recovered;
  }

  /** The marker folder goes (true when it is really gone), then the staging folder itself when nothing else is in it. */
  private async removeMarker(folder: string): Promise<boolean> {
    try { await rm(folder, { recursive: true, force: true }); } catch { return false; }
    await rmdir(path.join(this.root, 'staging')).catch(() => {});
    return true;
  }

  private emit(): void {
    const view = this.job?.view ?? this.last;
    if (view) try { this.options.emit?.(structuredClone(view)); } catch { /* status only */ }
  }

  private step(job: Job, id: ConversionStepId, status: 'running' | 'done' | 'skipped', progress?: { done: number; total: number }): void {
    const step = job.view.steps.find(item => item.id === id)!;
    step.status = status;
    if (progress) { step.done = progress.done; step.total = progress.total; }
    this.emit();
  }

  private async run(job: Job, snapshot: SourceSnapshot, target: CardLanguage, names: ReturnType<typeof resolveConversionNames>, aliases: ReturnType<typeof resolveConversionAliases>): Promise<void> {
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(CONVERSION_LIMITS.jobMs)]);
    const newId = (this.options.id ?? randomUUID)();
    const providerScope = this.options.source.currentProviderScope();
    const staging = path.join(this.root, 'staging', job.view.id);
    let backup: BackupPlan | null = null;
    /** Fix 8: what a failed cleanup left (the message says it; the marker stays for the next start). */
    let leftBehind: string[] = [];
    try {
      // 0. Fix 8 (Codex T-240 F03): the marker first, naming the backup it is about to make: an interruption from here on (even while
      //    the backup is being copied) is found at the next start, which removes that backup.
      this.step(job, 'backup', 'running');
      const plan = backup = await this.planBackup(job.view.id);
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await writeFile(path.join(staging, 'job.json'), JSON.stringify({ backup: plan.name, made: plan.made }));
      // 1. Backup.
      await this.copyBackup(plan);
      this.step(job, 'backup', 'done');
      signal.throwIfAborted();
      // 2. Her memories as they are now (the snapshot read at start, refreshed: she may have chatted since the popup).
      this.step(job, 'read', 'running');
      const fresh = await readSourceSnapshot(snapshot.card.id, this.options.source);
      this.step(job, 'read', 'done');
      // 3. Translate.
      const from = cardLanguageOf(fresh.card), map = nameMap(fresh, names, aliases);
      this.step(job, 'persona', 'running');
      const personaMissing: PersonaField[] = [];
      const persona = await translatePersona(fresh.card, from, target, map, this.options.model, signal, value => {
        validateCharacterDraft({ ...value, name: names['her-name'] ?? value.name, language: target }); // a valid card, or the call is asked again
      }, personaMissing);
      this.step(job, 'persona', 'done');
      this.step(job, 'memories', 'running');
      const items = conversionItems(fresh);
      // Fix 5: an item still wrong after its re-ask is left out (named in the result) unless too many are; then this throws.
      const leftOut: ConversionLeftOutItem[] = [], partial: ConversionLeftOutItem[] = [];
      const translated = items.length
        ? await translateMemories(items, from, target, map, this.options.model, signal, progress => this.step(job, 'memories', 'running', progress), leftOut, partial)
        : new Map();
      this.step(job, 'memories', items.length ? 'done' : 'skipped');
      // 4. Build and check the new card; stage it.
      this.step(job, 'check', 'running');
      const scopeKey = this.options.source.memory.noteScope({ characterId: newId, providerScope });
      const bundle = buildConversion({ snapshot: fresh, target, persona, translated, names, aliases, newId, providerScope, scopeKey, now: this.now(), id: this.options.id,
        leftOut: new Set(leftOut.map(item => item.key)) });
      // Fix 8 (Codex T-240 F05): everything not carried whole is said, each with its reason: the items a re-ask could not fix, persona
      // parts that came back empty, fields that came back missing or cut, what the stores refuse, and what the history caps left.
      const notCarried: ConversionLeftOutItem[] = [
        ...leftOut,
        ...personaMissing.map((field): ConversionLeftOutItem => ({ key: `persona-${field}`, kind: 'persona', title: `人设的「${PERSONA_FIELD_LABELS[field]}」`, reasons: ['missing'] })),
        ...partial, ...(bundle.skipped ?? []), ...conversionCappedItems(fresh.counts),
      ];
      const draft = validateCharacterDraft(bundle.draft);
      job.view.lint = this.options.lint(draft, this.options.cardNames()).slice(0, 3);
      await writeFile(path.join(staging, 'bundle.json'), JSON.stringify({ ...bundle, draft }));
      this.step(job, 'check', 'done');
      signal.throwIfAborted();
      // 5. Save. From here a cancel no longer applies; a failure rolls back.
      job.committing = true; job.view.cancellable = false;
      this.step(job, 'save', 'running');
      await writeFile(path.join(staging, 'commit.json'), JSON.stringify({ newId, providerScope }));
      let saved: { voiceSkipped: number };
      try { saved = await this.commit({ ...bundle, draft }); }
      catch (error) {
        // Fix 8 (Codex T-240 F02): each part that could not be removed is named and keeps the marker (the next start tries again).
        leftBehind = await this.rollback(newId, providerScope);
        throw error;
      }
      this.step(job, 'save', 'done');
      // Fix 8 (Codex T-240 F04): the shared voice list was full: the new card's binding was not added (no other one is dropped).
      const carried = { ...bundle.carried };
      if (saved.voiceSkipped) {
        notCarried.push({ key: 'voice-room', kind: 'voice', title: '朗读设置', reasons: ['no-room'] });
        carried.voice = saved.voiceSkipped >= bundle.voice.length
          ? `朗读设置没有带：所有角色的朗读设置一共最多 ${MAX_TTS_STYLE_BINDINGS} 条，已经满了；为了不挤掉别的角色的，新卡先用全局的声音（删掉不用的以后，可以在朗读设置里给新卡设）`
          : `${carried.voice}；有 ${saved.voiceSkipped} 条朗读设置没有带：一共最多 ${MAX_TTS_STYLE_BINDINGS} 条，已经满了，为了不挤掉别的角色的`;
      }
      const notCarriedView = notCarried.length ? { leftOutCount: notCarried.length,
        leftOut: notCarried.slice(0, MAX_LEFT_OUT_LISTED).map(({ title, kind, reasons }) => ({ title, kind, reasons: [...reasons] })) } : {};
      Object.assign(job.view, { state: 'done', newCardId: newId, newName: draft.name, carried, ...notCarriedView });
    } catch (error) {
      const cancelled = job.controller.signal.aborted && !job.committing;
      job.view.state = cancelled ? 'cancelled' : 'failed';
      if (!cancelled) job.view.error = signal.aborted && !job.committing ? `转换太久了，已经停下。${CONVERSION_UNTOUCHED_NOTE}`
        : job.committing ? saveFailedMessage(error, leftBehind)
        : fixed(error, `转换没能完成。${CONVERSION_UNTOUCHED_NOTE}`);
    } finally {
      await rm(path.join(staging, 'bundle.json'), { force: true }).catch(() => {});
      // Nothing was saved: the backup made for it goes too, so a cancel leaves no trace; once saving began it stays (as before).
      // Fix 8: the marker goes only when what it guards is really gone (else the next start finishes it).
      const done = job.view.state === 'done';
      const backupGone = done || job.committing || !backup || await this.dropBackup(backup);
      if (!leftBehind.length && backupGone) {
        if (await this.removeMarker(staging) && !done && !job.committing && backup) await this.dropFolders(backup);
      } else {
        if (!backupGone && job.view.error) job.view.error = `${job.view.error}（这次的备份文件夹没删掉，下次打开软件时会再删。）`.slice(0, 300);
        this.recovering = null; // the next start() or card click tries again in this run too
      }
      if (done) await this.pruneBackups();
      job.view.cancellable = false;
      job.view.finishedAt = this.now();
      this.last = job.view;
      this.job = null;
      this.emit();
    }
  }

  /** New card's own files first, the card itself last. Each part is checked to have landed. */
  private async commit(bundle: ConversionBundle & { draft: CharacterDraft }): Promise<{ voiceSkipped: number }> {
    const ports = this.options.commit, scope = { characterId: bundle.newId, providerScope: bundle.providerScope };
    if (ports.hasCard(bundle.newId)) throw new Error('新角色的编号撞上了已有的角色，没有保存。');
    await ports.relationship.adopt(bundle.newId, bundle.relationship);
    await stat(ports.relationship.file(bundle.newId)); // the relationship store keeps counting from memory when it cannot write; here it must be on disk
    if (bundle.profile) {
      if (!ports.profiles) throw new Error('用户画像还没准备好，稍后再转换。');
      await ports.profiles.restoreScope(scope, bundle.profile, async () => { throw new Error('新角色已经有画像了，没有覆盖。'); }, { keepRecording: bundle.carried.recording });
    }
    // I-088 第 1 条: her carried look-backs are the new scope's own file beside its profile (written only here, under the new card's scope).
    if (bundle.reviews && !await this.reviewStore().change(bundle.reviews.scopeId, () => structuredClone(bundle.reviews!.data), 'user')) throw new Error('她的回顾没有存上，已经撤回。');
    if (bundle.records.length) {
      const added = await ports.memory.restoreRecords(bundle.records as readonly CarrierRecord[], scope);
      if (added !== bundle.records.length) throw new Error('她记得的事没有全部存上，已经撤回。');
    }
    const voice = bundle.voice.length ? await ports.voice.add(bundle.voice) : undefined;
    await ports.addCard(bundle.newId, bundle.draft, bundle.model);
    return { voiceSkipped: voice?.skipped ?? 0 };
  }

  /**
   * Every part of a new card that may exist goes; each on its own (one that fails does not stop the others). Fix 8 (Codex T-240
   * F02): the parts that could not be removed are returned (empty = all gone); the card and her familiarity file are checked.
   */
  private async rollback(newId: string, providerScope: string): Promise<string[]> {
    const ports = this.options.commit, scope = { characterId: newId, providerScope };
    const left: string[] = [];
    const part = async (label: string, remove: () => Promise<unknown>) => { try { await remove(); } catch (error) { left.push(`${label}${fixed(error, '') ? `（${fixed(error, '').replace(/[。.]+$/u, '')}）` : ''}`); } };
    await part('新角色卡', async () => { await ports.removeCard(newId); if (ports.hasCard(newId)) throw new Error(''); });
    await part('朗读设置', () => ports.voice.remove(newId));
    await part('带过去的记忆', () => ports.memory.forgetScope(scope));
    await part('画像和日记', async () => { await ports.profiles?.forgetScope(scope); });
    await part('回顾', () => this.reviewStore().forget(userProfileScopeId(scope)));
    await part('熟悉度', async () => {
      await ports.relationship.forget(newId);
      if (await stat(ports.relationship.file(newId)).then(() => true, () => false)) throw new Error('');
    });
    return left;
  }

  /** Fix 8: removes this conversion's backup; true when it is really gone (or never was made). */
  private async dropBackup(backup: BackupPlan): Promise<boolean> {
    await rm(backup.folder, { recursive: true, force: true }).catch(() => {});
    return !await stat(backup.folder).then(() => true, () => false);
  }

  /**
   * Fix 5: after a cancelled or failed conversion, the folders it created on the way (`backups/`, `character-convert/`) go, each
   * only while it is empty; folders that were there before are never removed.
   */
  private async dropFolders(backup: BackupPlan): Promise<void> {
    if (backup.made.includes('backups')) await rmdir(path.join(this.root, 'backups')).catch(() => {});
    if (backup.made.includes('root')) await rmdir(this.root).catch(() => {});
  }

  /** Where this conversion's backup goes and which of its folders it creates (checked before, not read from mkdir's answer: on Windows that is a \\?\ path). */
  private async planBackup(jobId: string): Promise<BackupPlan> {
    const name = `${stamp(this.now())}-${jobId.slice(0, 8)}`;
    const there = (dir: string) => stat(dir).then(() => true, () => false);
    const made: BackupPlan['made'] = [];
    if (!await there(this.root)) made.push('root');
    if (!await there(path.join(this.root, 'backups'))) made.push('backups');
    return { name, folder: path.join(this.root, 'backups', name), made };
  }

  private async copyBackup(plan: BackupPlan): Promise<void> {
    await mkdir(plan.folder, { recursive: true, mode: 0o700 });
    for (const name of CONVERSION_BACKUP_FILES) {
      try { await copyFile(path.join(this.options.profileDirectory, name), path.join(plan.folder, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('备份没能做好，转换没有开始。'); }
    }
  }

  /** Only the newest few backups stay. Fix 8: pruned after a finished conversion only (a failed one never costs an older backup). */
  private async pruneBackups(): Promise<void> {
    try {
      const all = (await readdir(path.join(this.root, 'backups'))).filter(name => BACKUP_NAME.test(name)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) await rm(path.join(this.root, 'backups', old), { recursive: true, force: true });
    } catch { /* an old backup left over is harmless */ }
  }
}

/** Fix 8: one conversion's backup: its folder name under `backups/`, and which folders it creates (removed again after a failure when empty). */
interface BackupPlan { name: string; folder: string; made: ('root' | 'backups')[] }
const BACKUP_NAME = /^\d{8}T\d{6}Z-[A-Za-z0-9-]{1,8}$/;

/** A marker file's object; null when it is missing or does not read. */
async function readMarker(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** The backup a job marker names: only a folder name of this conversion's own pattern under backups/ (anything else: none). */
function backupOf(root: string, marker: Record<string, unknown>): BackupPlan | null {
  if (typeof marker.backup !== 'string' || !BACKUP_NAME.test(marker.backup)) return null;
  const made = Array.isArray(marker.made) ? marker.made.filter((item): item is 'root' | 'backups' => item === 'root' || item === 'backups') : [];
  return { name: marker.backup, folder: path.join(root, 'backups', marker.backup), made };
}

/**
 * Fix 8 (Codex T-240 F02): the message after a save that failed: the real reason, and whether every part was taken back. When some
 * part could not be removed it says which, and that the next start removes it (its marker stays); "nothing left" is never claimed then.
 */
function saveFailedMessage(error: unknown, left: readonly string[]): string {
  const reason = fixed(error, '').replace(/[。.]+$/u, '');
  const head = `保存新角色时出错${reason ? `（${reason}）` : ''}`;
  return (left.length ? `${head}。撤回时有 ${left.length} 项没删掉：${left.join('、')}；下次打开软件时会再撤回一次。原角色没有任何改动。`
    : `${head}，已经全部撤回，原角色没有任何改动。`).slice(0, 300);
}
