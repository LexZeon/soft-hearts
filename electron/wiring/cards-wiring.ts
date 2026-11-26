// 角色卡's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-3.md):
// the card handlers (cards, responses, personalised language, switching, the roster, avatars, deleting into the recycle bin, import /
// export / in-place update, the understanding talk, stickers) and the C1 model-card helpers, moved from electron/main.ts unchanged.
// What they read from the rest of the app comes through CardsNeeds (getters electron/main.ts gives, read when used). The handlers
// register in electron/main.ts registerIPC, after the recycle host exists and inside the agent channel's recorder (the wiring golden
// checks both). syncCharacter, the fan-out of a character change to every part, is here too (from electron/main.ts, step 5).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { dialog, nativeImage, type BrowserWindow } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { t } from '../../shared/foundation/ui-language';
import { compileCharacterPersona, effectiveCardModel, effectiveCharacterMood, isBundledModelKey, sameModelReference, uniqueCharacterName, type CharacterModelDecision, type CharacterResponseState, type LanguageState } from '../../shared/cards';
import type { CharacterCard, CharacterCardState } from '../../shared/cards';
import { activateCardCommitted, avatarBytesFromDataUrl, backupBeforeUpdate, buildCharacterRoster, CharacterCardUpdater, CharacterSwitchGate, CharacterUnderstandingHost, characterUnderstandingHandlers,
  bundledReferenceForPath, resolveBundledCharacterModel, planCardForModel, readModelIdentity, registerCharacterStickerControls, saveCharacterVoice, splitCardFromModelAtStartup, withCardLint } from '../cards';
import type { CharacterAvatarStore, CharacterCardStore, CharacterCardUpdateResult, CharacterResponseService, CharacterResponseStore, CharacterStickerHost, PersonalizeAuthoring, PersonalizeLanguageStore } from '../cards';
import { realerEmotionsRequest } from '../mood';
import { companionChangeStops, streamClaude, type CompanionService } from '../brain';
import type { UserProfileManagement } from '../memory';
import type { MotionLibrary } from '../actions';
import type { AssetRegistry } from '../foundation/assets';
import { memoryProviderScope } from '../foundation/memory-provider-scope';
import { settledScope } from '../foundation/settled-scope';
import type { SettingsStore } from '../settings';
import type { PartIpc } from './ipc-wiring';
import type { PartHandle } from './parts-wiring';
import { registerPrivacyStores } from './memory-wiring';
import { broadcast } from './shell-wiring';
import type { SensesProvides } from './senses-wiring';
import type { VoiceProvides } from './voice-wiring';
import { wireCardsReady } from './cards-ready-wiring';
import { MODEL_DIALOG_EXTENSIONS, isModelFileExtension } from '../../shared/foundation/model-format'; // I-152

/** What the card wiring reads from the rest of the app (electron/main.ts gives getters; each is read when it is used). */
export interface CardsNeeds {
  readonly store: SettingsStore;
  readonly controls: BrowserWindow | null;
  readonly characterCards: CharacterCardStore;
  readonly characterAvatars: CharacterAvatarStore | null;
  readonly characterResponses: CharacterResponseStore;
  readonly characterResponseService: CharacterResponseService;
  readonly personalizeLanguage: PersonalizeLanguageStore | undefined;
  readonly languageAuthoring: PersonalizeAuthoring | undefined;
  readonly characterStickerHost: CharacterStickerHost | null;
  readonly companion: CompanionService;
  readonly userProfileManagement: UserProfileManagement | undefined;
  /** The factory Gene (electron/actions/bundled-assets.ts BundledAssets): its model (the C1 helpers read its path; syncCharacter loads it). */
  readonly bundledAssets: { readonly directory: string; getDefaultAssets(): Promise<{ readonly model: NonNullable<SettingsStore['current']['model']> }> };
  readonly motionLibrary: MotionLibrary;
  readonly assets: AssetRegistry;
  /** The recycle bin (electron/memory/recycle-wiring.ts RecycleHost): a character is deleted into it. */
  readonly recycleHost: { deleteCharacter(characterId: string, forgetMemories: boolean, removeCard: () => Promise<void>): Promise<{ readonly failed: readonly unknown[] }> } | null;
  readonly pending: ReadonlyMap<string, { readonly kind: string; readonly controller: AbortController; readonly characterId?: string }>;
  readonly speechPlaybackActivity: { readonly busy: boolean };
  readonly ambientSpeakingOwners: { readonly size: number };
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  activateUserProfile(): Promise<void>;
  // What syncCharacter (the fan-out of a character change to every part) stops, clears and tells.
  readonly moodModel: string | null;
  readonly voiceHost: SensesProvides['voiceHost'];
  readonly ambientComments: { clear(): void } | null;
  readonly proactiveSpeechGate: { cancel(reason: 'character'): void };
  readonly speechRuntime: VoiceProvides['speechRuntime'];
  readonly appJournal: { characters(state: CharacterCardState): void };
  revokeVoice: SensesProvides['revokeVoice'];
  stopSystemAudio: SensesProvides['stopSystemAudio'];
  clearVisionContext: SensesProvides['clearVisionContext'];
  setVisionSupported(value: boolean): void;
  refreshVisionContext: SensesProvides['refreshVisionContext'];
  publishVisionState: SensesProvides['publishVisionState'];
  clearReplySpeech: VoiceProvides['clearReplySpeech'];
  sync(exclude?: number): void;
  replySpeechBusy(): boolean;
  /** A model change makes motion selections made for the old model stale (actions). */
  noteModelSelection(): void;
  /** I-014 三方互通 on (the click is the consent; the explanation is shown once). */
  agentInterconnected(): boolean;
  /** 声音: the speech scope (the language research's identity). */
  speechScope(): string;
}
/** What the rest of the app uses from the cards part. */
export interface CardsProvides {
  /** C1, at start-up before anything reads the current card. */
  splitCharacterFromModelAtStartup(): Promise<void>;
  /** C1, after a model is loaded or imported: the model picks its card. */
  adoptCharacterForModel(model: { path: string } | null | undefined): Promise<string | undefined>;
  /** The agent channel's import_character_card and update_character_card run these (after their own dialog). */
  importCharacterCardContent(content: string): Promise<CharacterCardState>;
  updateCharacterCardContent(id: string, content: string, expected: string, options?: { useFileVoice?: boolean }): Promise<{ state: CharacterCardState; summary: CharacterCardUpdateResult['summary']; notice?: string }>;
  planCharacterCardUpdate(id: string, content: string): ReturnType<CharacterCardUpdater['plan']>;
  /** After any card change (activation, edits, model links): every part catches up with the active card (see the function). */
  syncCharacter(applyModel: boolean, previousCard: CharacterCard, hint?: string): Promise<CharacterCardState>;
}

export function wireCards(needs: CardsNeeds): PartHandle<CardsProvides> & { register(ipc: PartIpc): void } {
  wireCardsReady(needs); // the ready steps (electron/wiring/cards-ready-wiring.ts) read the same needs
  // 数据地图 (wiring rewrite step 4d): the stores 角色卡 owns go into her recycle-bin entry with the card (characterForget 'with-card').
  registerPrivacyStores('cards', { recycle: () => ({ cards: needs.characterCards, responses: needs.characterResponses, avatars: needs.characterAvatars }), recordingOff: () => ({}) });
  let provided: { cardUpdates: CharacterCardUpdater; importCharacterCardContent: CardsProvides['importCharacterCardContent']; updateCharacterCardContent: CardsProvides['updateCharacterCardContent'] } | null = null;
  const registered = () => { if (!provided) throw new Error('角色卡尚未就绪。'); return provided; };
  /** C1 角色和模型分开: the hint the control window shows after a model picked (or got) its card. */
  function modelCardHint(kind: CharacterModelDecision['kind'], name: string, sameCard = false): string | undefined {
    if (kind === 'bind' && sameCard) return t('已把这个模型关联到「{0}」。', { 0: name });
    if (kind === 'switch') return t('已换成「{0}」：这个模型关联的是她。', { 0: name });
    if (kind === 'bind') return t('已把这个模型关联到「{0}」，并换成她。', { 0: name });
    if (kind === 'create') return t('给这个模型新建了角色卡「{0}」。可以去「角色」页补人设，或者导入角色卡。', { 0: name });
    return undefined;
  }
  let startupCharacterHint: string | undefined;
  /** The model a card goes with and its names (electron/cards/character-model-link.ts); the factory Gene is `bundled:gene`. */
  async function currentModelIdentity(model: { path: string }) {
    const { bundledAssets } = needs; // read when called
    const factory = await bundledAssets.getDefaultAssets().catch(() => null);
    return readModelIdentity(model.path, { bundled: !!factory && model.path === factory.model.path, bundledKey: bundledReferenceForPath(bundledAssets.directory, model.path) });
  }
  /**
   * C1: after a model is loaded or imported (inside the mutation queue, after it is persisted), it picks its card:
   * a card linked to it, an unlinked card with its name, or a new card (shared/cards/character-model.ts). The current card
   * stays when it already goes with this model.
   */
  async function adoptCharacterForModel(model: { path: string } | null | undefined): Promise<string | undefined> {
    const { characterCards, userProfileManagement, activateUserProfile } = needs; // read when called
    if (!model || !characterCards) return undefined;
    const identity = await currentModelIdentity(model);
    const decision = await planCardForModel(characterCards, identity);
    if (!decision) return undefined; // The current card already goes with this model.
    const previous = characterCards.getActive();
    // Linking the current card itself is no switch: her profile scope (and its "允许记录") stays as it is.
    const switching = !(decision.kind === 'bind' && decision.id === previous.id);
    if (switching) userProfileManagement?.suspendScope();
    try {
      let result;
      try { result = await characterCards.adoptModel(decision, { modelPath: identity.reference, modelName: identity.displayName }); }
      catch (error) {
        // E.g. the card limit: the model is loaded, the cards stay; the control window says why.
        broadcast('desk:characters', { ...characterCards.publicState(), notice: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
      const hint = modelCardHint(result.kind, characterCards.getActive().name, !switching);
      await syncCharacter(false, previous, hint);
      return hint;
    } finally { if (switching) await activateUserProfile(); }
  }
  /**
   * C1 migration, at startup before anything reads the current card: when the current card is linked to another model
   * than the one on stage (e.g. the Gene card with someone else's model), the model picks its card by the same rules.
   * characters.json is copied aside first; only cards are added or the current card changes. Chats with the old card
   * stay with it (not copied). Any failure leaves the cards as they were.
   */
  async function splitCharacterFromModelAtStartup(): Promise<void> {
    const { store, characterCards } = needs; // read when called
    const model = store.current.model;
    if (!model) return;
    try {
      const split = await splitCardFromModelAtStartup(characterCards, await currentModelIdentity(model), store.directory);
      if (!split) return;
      const { result, from } = split, name = characterCards.getActive().name, active = { name: from };
      startupCharacterHint = t(result.kind === 'select' ? '现在的模型和「{0}」分开了：换成了名字对得上的「{1}」。她还没有关联这个模型，可以去「角色」页关联。之前以「{0}」身份聊过的记录留在「{0}」那边。' : result.kind === 'create' ? '现在的模型和「{0}」分开了：给它新建了角色卡「{1}」。之前以「{0}」身份聊过的记录留在「{0}」那边。可以去「角色」页补人设，或者导入角色卡。' : '现在的模型和「{0}」分开了：换成了它关联的「{1}」。之前以「{0}」身份聊过的记录留在「{0}」那边。', { 0: active.name, 1: name });
    } catch (error) {
      console.warn('C1 角色和模型分开：启动时没有改动角色卡。', error instanceof Error ? error.message : error);
    }
  }
  /**
   * After any card change (activation, edits, model links; moved from electron/main.ts, wiring rewrite step 5): a new context (another
   * card, scope, name, greeting, persona or model) revokes her voice, sound, vision, reading and chat first, before any model I/O; then the
   * card's model, the persona, her mood context and profile; the journal and the control window get the new state.
   */
  async function syncCharacter(applyModel: boolean, previousCard: CharacterCard, hint?: string): Promise<CharacterCardState> {
    const { characterCards, companion, store, moodModel, userProfileManagement, voiceHost, ambientComments, proactiveSpeechGate, speechRuntime, pending,
      bundledAssets, assets, motionLibrary, appJournal, revokeVoice, stopSystemAudio, clearVisionContext, setVisionSupported, clearReplySpeech,
      noteModelSelection, sync, activateUserProfile, refreshVisionContext, publishVisionState } = needs; // read when called
    const card = characterCards.getActive();
    const persona = compileCharacterPersona(card);
    const moodParameters = effectiveCharacterMood(card);
    const moodChanged = JSON.stringify(moodParameters) !== JSON.stringify(effectiveCharacterMood(previousCard));
    // Library metadata is not a new active context. Match the renderer's effective
    // card identity too: legacy personas can keep identical text after a rename.
    let scopeChanged = true;
    try {
      const previousScope = companion?.currentScope();
      scopeChanged = !previousScope || previousScope.characterId !== card.id
        || previousScope.providerScope !== memoryProviderScope(store.current.provider);
    } catch { /* An unresolved context fails closed instead of keeping old media. */ }
    const resetContext = applyModel || scopeChanged || previousCard.id !== card.id
      || previousCard.name !== card.name || previousCard.greeting !== card.greeting
      || persona !== store.current.persona || (store.current.model?.path ?? null) !== moodModel;
    if (resetContext) {
      if (scopeChanged) userProfileManagement?.suspendScope();
      else userProfileManagement?.cancelPending();
      voiceHost.history = null;
      revokeVoice('scope-change');
      // Explicit activation and real active changes revoke before any model I/O.
      stopSystemAudio(); ambientComments?.clear(); proactiveSpeechGate.cancel('character');
      clearVisionContext();
      setVisionSupported(false);
      speechRuntime.stop();
      clearReplySpeech();
      for (const task of pending.values()) if (task.kind === 'chat' && companionChangeStops(task.characterId, previousCard.id)) task.controller.abort(); // I-209 step 2: hers only
    }
    let model = store.current.model;
    let notice: string | undefined;
    // C1: the preinstalled Gene card always brings the preinstalled Gene, even when its link was removed earlier.
    const linkedModel = applyModel ? card.modelPath ?? (card.id === await characterCards.presetGeneId() ? 'bundled:gene' : undefined) : undefined;
    if (applyModel && linkedModel) {
      try {
        model = linkedModel === 'bundled:gene'
          ? (await bundledAssets.getDefaultAssets()).model
          : isBundledModelKey(linkedModel) ? await resolveBundledCharacterModel(linkedModel, bundledAssets.directory, assets) : await assets.register(linkedModel);
      } catch { notice = '角色已启用，但关联模型不可用，暂时保留当前模型。'; }
    }
    const modelChanged = model?.path !== store.current.model?.path;
    if (persona !== store.current.persona || modelChanged) {
      if (modelChanged) { noteModelSelection(); motionLibrary.cancel(); }
      await store.persist({ ...store.current, persona, model, ...(modelChanged ? { motion: null, motionLayers: undefined } : {}) });
      sync();
    }
    const state = { ...characterCards.publicState(), ...(notice ? { notice } : {}), ...(hint ? { hint } : {}) };
    if (resetContext || moodChanged) {
      await companion?.context(card.id, store.current.provider, persona, moodParameters);
      await activateUserProfile();
      refreshVisionContext();
      publishVisionState();
    }
    appJournal.characters(state); // 体验记录: activation, edits and model links (ids only)
    broadcast('desk:characters', state);
    return state;
  }
  return {
    id: 'cards',
    units: ['cards', 'responses', 'personalize-language', 'switch', 'roster', 'avatars', 'card-update', 'understanding', 'stickers'],
    /** Plan section 3: the card store is never switched off (overhaul step 7); nor the reaction profiles, read by her conversation from its first turn. */
    core: ['cards', 'responses'],
    ipc: { stickers: ['getCharacterStickers', 'beginCharacterStickerReference', 'acceptCharacterStickerReference', 'generateCharacterSticker', 'saveCharacterSticker', 'previewCharacterSticker', 'retireCharacterStickerReference', 'cancelCharacterSticker'],
      'personalize-language': ['getPersonalizeLanguage', 'openLanguageAuthoring', 'researchLanguage', 'cancelLanguageAuthoring', 'closeLanguageAuthoring', 'savePersonalizeLanguage', 'undoPersonalizeLanguage'] },
    register(ipc: PartIpc): void {
      const { host, scopedHost } = ipc;
      // What the handlers read: each is set before the ready chain registers (registerIPC, after the recycle bin) and not replaced later.
      const { controls, characterCards, characterAvatars, characterResponses, characterResponseService, personalizeLanguage, languageAuthoring, characterStickerHost,
        companion, userProfileManagement, store, bundledAssets, motionLibrary, assets, recycleHost, pending, speechPlaybackActivity, ambientSpeakingOwners,
        mutate, activateUserProfile, replySpeechBusy, noteModelSelection, agentInterconnected } = needs;
      if(characterStickerHost)registerCharacterStickerControls(host,characterStickerHost);
      scopedHost('getCharacterCards', sender => {
        // C1: the startup split's hint reaches the control window once.
        const hint = controls && !controls.isDestroyed() && sender === controls.webContents.id ? startupCharacterHint : undefined;
        if (hint) startupCharacterHint = undefined;
        return { ...characterCards.publicState(), ...(hint ? { hint } : {}) };
      }, false);
      host('getCharacterResponse', id => characterResponseService.get(id));
      host('getPersonalizeLanguage', id => personalizeLanguage!.get(id));
      scopedHost('openLanguageAuthoring', (sender, id, revision) => {
        if (!languageAuthoring) throw Error('语言研究尚未就绪。');
        return languageAuthoring.open(sender, id, revision);
      });
      scopedHost('researchLanguage', (sender, request) => {
        if (!languageAuthoring) throw Error('语言研究尚未就绪。');
        return languageAuthoring.research(sender, request);
      });
      scopedHost('cancelLanguageAuthoring', (sender, id) => languageAuthoring?.close(sender, id));
      scopedHost('closeLanguageAuthoring', (sender, id) => languageAuthoring?.close(sender, id));
      const publishLanguage = (state: LanguageState) => {
        languageAuthoring?.invalidate();
        controls?.webContents.send('desk:personalize-language', state);
        return state;
      };
      host('savePersonalizeLanguage', (id, profile, revision) => mutate(async () =>
        publishLanguage(await personalizeLanguage!.save(id, profile, revision))));
      host('undoPersonalizeLanguage', (id, revision) => mutate(async () =>
        publishLanguage(await personalizeLanguage!.undo(id, revision))));
      const publishResponse = (state: CharacterResponseState) => {
        companion.mood.responseProfileChanged(state.characterId);
        broadcast('desk:character-response', state);
        return state;
      };
      host('saveCharacterResponse', (id, profile, expectedRevision) => mutate(async () =>
        publishResponse(await characterResponseService.save(id, profile, expectedRevision))));
      host('copyCharacterResponse', (sourceId, targetId) => mutate(async () =>
        publishResponse(await characterResponseService.copy(sourceId, targetId))));
      host('saveCharacterCard', (draft, id) => mutate(async () => {
        const previous = characterCards.getActive();
        await characterCards.save(draft, id);
        return syncCharacter(false, previous);
      }));
      // 熟悉度: only "慢慢熟悉" of one card changes; the agent channel's chat setting card reuses this exact handler.
      host('setCharacterSlowWarmUp', (id, value) => mutate(async () => {
        const previous = characterCards.getActive();
        await characterCards.setSlowWarmUp(id, value);
        return syncCharacter(false, previous);
      }));
      // F6 "更真实的情绪" of one card. This operation has no dialog: the agent channel reuses it (set_setting asks first, confirm tier).
      const saveRealerEmotions = (id: string, value: boolean, duration?: Parameters<CharacterCardStore['setRealerEmotions']>[2]) => mutate(async () => {
        const previous = characterCards.getActive();
        await characterCards.setRealerEmotions(id, value, duration ?? undefined);
        return syncCharacter(false, previous);
      });
      host('setCharacterRealerEmotions', (id, value, duration) => saveRealerEmotions(id, value, duration));
      // The card editor's checkbox: turning it on shows what it does first (electron/mood/realer-emotions-host.ts) and saves only on "我知道了，打开".
      host('requestCharacterRealerEmotions', realerEmotionsRequest({ cards: () => characterCards.publicState(), save: saveRealerEmotions,
        confirm: async options => (controls && !controls.isDestroyed() ? await dialog.showMessageBox(controls, options) : await dialog.showMessageBox(options)).response, // I-112 B: the button index (0 declines, 1..4 the durations)
        // I-014 三方互通: the click here is the consent; the explanation is shown once, not waited for.
        interconnected: agentInterconnected, inform: options => { void (controls && !controls.isDestroyed() ? dialog.showMessageBox(controls, options) : dialog.showMessageBox(options)).catch(() => {}); } }));
      // Switch lock (docs/claude/2026-11-23-switch-lock.md): a switch her conversation did not take puts the card store back on the
      // character it is still with (activateCardCommitted), so the 角色页 never shows 「正在陪着你」 for her before the switch commits.
      const activateCard = (id: string) => mutate(async () => {
        const previous = characterCards.getActive();
        userProfileManagement?.suspendScope();
        try {
          return await activateCardCommitted(previous.id, id, { activate: target => characterCards.activate(target), catchUp: () => syncCharacter(true, previous),
            conversationCharacter: () => settledScope(companion)?.characterId ?? null,
            restore: async back => { const failed = characterCards.getActive(); await characterCards.activate(back); await syncCharacter(true, failed); } });
        } finally { await activateUserProfile(); }
      });
      host('activateCharacterCard', id => activateCard(id));
      // C2: the character page's switch runs the same steps (activateCard above).
      // C2 "换成她": waits for her current line (a chat turn or her reply being read aloud), then the same activation.
      const characterSwitch = new CharacterSwitchGate<CharacterCardState>({
        busy: () => [...pending.values()].some(task => task.kind === 'chat') || replySpeechBusy() || speechPlaybackActivity.busy || ambientSpeakingOwners.size > 0,
        activate: activateCard,
        waiting: id => broadcast('desk:characters', { ...characterCards.publicState(), ...(id ? { switchingTo: id } : {}) }),
      });
      host('switchCharacter', async id => {
        if (typeof id !== 'string' || !characterCards.publicState().cards.some(card => card.id === id)) throw new Error('角色卡不存在。');
        return await characterSwitch.request(id) ?? characterCards.publicState();
      });
      host('getCharacterRoster', () => buildCharacterRoster({
        cards: () => characterCards.rosterCards(), activeId: () => characterCards.publicState().activeId,
        revision: () => characterCards.publicState().revision ?? 0, presetGeneId: () => characterCards.presetGeneId(),
        avatar: id => characterAvatars?.read(id) ?? Promise.resolve(null),
        previewImage: async file => { const image = nativeImage.createFromPath(file); if (image.isEmpty()) return null;
          const size = image.getSize(), ratio = Math.min(1, 160 / Math.max(size.width, size.height));
          return image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'good' }).toDataURL(); },
        knownDay: id => companion.relationship.knownDay(id),
        lastChatAt: id => companion.memory.lastActivity({ characterId: id, providerScope: memoryProviderScope(store.current.provider) }),
        pendingSwitchId: () => characterSwitch.pending,
      }));
      // C2 新增角色 · 用现在的模型: a new card that goes with the model on stage, and she becomes the current one.
      host('createCharacterForCurrentModel', () => mutate(async () => {
        const model = store.current.model;
        if (!model) throw new Error('请先载入一个 MMD 模型。');
        const identity = await currentModelIdentity(model), previous = characterCards.getActive();
        const name = uniqueCharacterName(identity.newName, characterCards.publicState().cards.map(card => card.name));
        userProfileManagement?.suspendScope();
        try {
          await characterCards.adoptModel({ kind: 'create', name }, { modelPath: identity.reference, modelName: identity.displayName });
          return await syncCharacter(false, previous, t('给这个模型新建了角色卡「{0}」。可以去「角色」页补人设，或者导入角色卡。', { 0: name }));
        } finally { await activateUserProfile(); }
      }));
      // C2 关联别的模型 / 模型文件不在了，重新选: a model file for this card; the current card also puts it on stage.
      host('bindCharacterModelFile', async id => {
        if (typeof id !== 'string' || !characterCards.publicState().cards.some(card => card.id === id)) throw new Error('角色卡不存在。');
        const selected = await dialog.showOpenDialog(controls!, { title: t('选择模型（MMD 或 VRM，保留同目录纹理）'), properties: ['openFile'],
          filters: [{ name: t('模型（MMD / VRM）'), extensions: [...MODEL_DIALOG_EXTENSIONS] }] }); // I-152: .vrm too
        if (selected.canceled || !selected.filePaths[0]) return null;
        if (!isModelFileExtension(path.extname(selected.filePaths[0]))) throw new Error('不支持的资源格式。');
        const asset = await assets.register(selected.filePaths[0]);
        return mutate(async () => {
          const previous = characterCards.getActive(), active = previous.id === id;
          const factory = await bundledAssets.getDefaultAssets().catch(() => null);
          await characterCards.bindModel(id, factory && asset.path === factory.model.path ? 'bundled:gene' : bundledReferenceForPath(bundledAssets.directory, asset.path), asset.name);
          if (active) { noteModelSelection(); motionLibrary.cancel(); }
          return syncCharacter(active, previous);
        });
      });
      // C2 小头像: the control window's half-body shot of the current card on the model it goes with; kept on this computer only.
      host('saveCharacterAvatar', async (id, modelUrl, dataUrl) => {
        const bytes = avatarBytesFromDataUrl(dataUrl);
        const card = characterCards.getActive(), model = store.current.model;
        if (typeof id !== 'string' || id !== card.id || !model || modelUrl !== model.url) throw new Error('角色或模型已经换了，头像没有保存。');
        const identity = await currentModelIdentity(model);
        if (!sameModelReference(effectiveCardModel(card, await characterCards.presetGeneId()), identity.reference)) throw new Error('这张角色卡没有关联现在的模型，头像没有保存。');
        await characterAvatars!.save(id, bytes);
        broadcast('desk:character-roster', undefined);
        return true;
      });
      host('deleteCharacterCard', id => mutate(async () => {
        const previous = characterCards.getActive();
        const active = previous.id === id;
        if (typeof id !== 'string' || !characterCards.publicState().cards.some(card => card.id === id)) throw new Error('角色卡不存在。');
        if (!recycleHost) throw new Error('回收站还没准备好，什么都没删，稍后再试。');
        if (active) userProfileManagement?.suspendScope();
        try {
          // I-144b: no window calls this any more; like deleteCharacter (card only), the card goes into the recycle bin first.
          let state: CharacterCardState | null = null, notice: string | undefined;
          await recycleHost.deleteCharacter(id, false, async () => { notice = (await characterResponseService.remove(id)).notice; state = await syncCharacter(active, previous); });
          const done = state ?? await syncCharacter(false, previous);
          return notice ? { ...done, notice } : done;
        } finally { if (active) await activateUserProfile(); }
      }));
      host('deleteCharacter', (id, options) => mutate(async () => {
        // C2 角色页: only the card by default; her memories go only when "同时删除她的记忆" was ticked.
        if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)
          || Object.keys(options).some(key => key !== 'forgetMemories') || typeof (options as { forgetMemories?: unknown }).forgetMemories !== 'boolean'))
          throw new Error('删除选项不正确。');
        const forget = (options as { forgetMemories?: boolean } | undefined)?.forgetMemories === true;
        const previous = characterCards.getActive();
        const active = previous.id === id;
        if (typeof id !== 'string' || !characterCards.publicState().cards.some(card => card.id === id)) throw new Error('角色卡不存在。');
        if (!recycleHost) throw new Error('回收站还没准备好，什么都没删，稍后再试。');
        if (active) { userProfileManagement?.suspendScope(); for (const task of pending.values()) if (task.kind === 'chat' && companionChangeStops(task.characterId, id)) task.controller.abort(); }
        try {
          // I-144: the card, its picture and, ticked, all she remembered go into one bin entry first (数据地图: every
          // row of electron/foundation/data-map.ts the bin keeps); she is switched away from before her memories leave their stores.
          let state: CharacterCardState | null = null, notice: string | undefined;
          const outcome = await recycleHost.deleteCharacter(id, forget, async () => {
            notice = (await characterResponseService.remove(id)).notice;
            state = await syncCharacter(active, previous);
          });
          if (outcome.failed.length) notice = t('角色卡已放进回收站；她的一部分记忆没能从原处删掉，回收站里有完整的一份。');
          const done = state ?? await syncCharacter(false, previous);
          broadcast('desk:memory-changed', undefined);
          return notice ? { ...done, notice } : done;
        } finally { if (active) await activateUserProfile(); }
      }));
      host('bindCharacterModel', (id, enabled) => mutate(async () => {
        const previous = characterCards.getActive();
        if (typeof enabled !== 'boolean') throw new Error('模型关联开关不正确。');
        if (enabled && !store.current.model) throw new Error('请先载入一个 MMD 模型。');
        const model = store.current.model;
        const factory = enabled ? await bundledAssets.getDefaultAssets() : null;
        await characterCards.bindModel(id, enabled ? (model!.path === factory!.model.path ? 'bundled:gene' : bundledReferenceForPath(bundledAssets.directory, model!.path)) : null, model?.name);
        return syncCharacter(false, previous);
      }));
      host('importCharacterCard', async () => {
        const result = await dialog.showOpenDialog(controls!, { title: t('导入角色卡 JSON'), properties: ['openFile'], filters: [{ name: t('角色卡 JSON'), extensions: ['json'] }] });
        if (result.canceled || !result.filePaths[0]) return null;
        const file = result.filePaths[0];
        if ((await stat(file)).size > 1_000_000) throw new Error('角色卡文件超过 1 MB。');
        return importCharacterCardContent(await readFile(file, 'utf8'));
      });
      const importCharacterCardContent = (content: string): Promise<CharacterCardState> => mutate(async () => {
          const previous = characterCards.getActive();
          const existingCardNames = characterCards.publicState().cards.map(card => card.name);
          userProfileManagement?.suspendScope();
          try {
            const result = await characterResponseService.import(content);
            const state = await syncCharacter(false, previous);
            const response = characterResponseService.get(result.characterId);
            broadcast('desk:character-response', result.retryProfile
              ? { ...response, pendingProfile: result.retryProfile, notice: result.notice }
              : response);
            return withCardLint(result.notice ? { ...state, notice: result.notice } : state, content, existingCardNames);
          } finally { await activateUserProfile(); }
        });
      host('exportCharacterCard', async id => {
        const content = characterResponseService.export(id);
        const name = characterCards.publicState().cards.find(card => card.id === id)!.name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 70);
        const result = await dialog.showSaveDialog(controls!, { title: t('导出角色卡'), defaultPath: `${name}.json`, filters: [{ name: t('角色卡 JSON'), extensions: ['json'] }] });
        if (result.canceled || !result.filePath) return false;
        await writeFile(result.filePath, content, 'utf8');
        return true;
      });
      // C3 用角色卡文件原地更新 (electron/cards/character-card-update.ts): the same card, the same id, so her chats, diary, profile,
      // familiarity and everything else kept by id stay hers. The 角色页 previews, the user confirms on her tile, then exactly
      // that file updates exactly that card; the agent channel's update_character_card runs the same update after its dialog.
      const cardUpdates = new CharacterCardUpdater({ cards: characterCards, responses: characterResponses, directory: store.directory });
      const applyCardUpdate = async (update: () => Promise<CharacterCardUpdateResult>): Promise<{ state: CharacterCardState; result: CharacterCardUpdateResult }> => {
        const previous = characterCards.getActive();
        const result = await update();
        if (result.response) publishResponse(result.response);
        const state = await syncCharacter(false, previous);
        return { state: result.notice ? { ...state, notice: result.notice } : state, result };
      };
      host('previewCharacterCardUpdate', async id => {
        if (typeof id !== 'string' || !characterCards.publicState().cards.some(card => card.id === id)) throw new Error('角色卡不存在。');
        const result = await dialog.showOpenDialog(controls!, { title: t('用角色卡文件更新'), properties: ['openFile'], filters: [{ name: t('角色卡 JSON'), extensions: ['json'] }] });
        if (result.canceled || !result.filePaths[0]) return null;
        const file = result.filePaths[0];
        if ((await stat(file)).size > 1_000_000) throw new Error('角色卡文件超过 1 MB。');
        return cardUpdates.preview(id, await readFile(file, 'utf8'));
      });
      host('applyCharacterCardUpdate', (token, options) => mutate(async () => (await applyCardUpdate(() => cardUpdates.confirm(token, options))).state));
      // I-162 step 2: her voice from the character page; only her card's voice is written, nothing is spoken or spent.
      host('saveCharacterVoice', (id, voice) => mutate(async () => { const state = await saveCharacterVoice(characterCards, id, voice); broadcast('desk:characters', state); return state; }));
      host('discardCharacterCardUpdate', token => { cardUpdates.discard(token); });
      const updateCharacterCardContent = (id: string, content: string, expected: string, options: { useFileVoice?: boolean } = {}) => mutate(async () => { // I-173: the file's voice on the user's words
        const { state, result } = await applyCardUpdate(() => cardUpdates.update(id, content, expected, { useFileVoice: options.useFileVoice === true }));
        return { state, summary: result.summary, ...(result.notice ? { notice: result.notice } : {}) };
      });
      // I-018 理解讨论 (electron/cards/character-understanding.ts): Claude talks the card over with the user (only this card and this
      // discussion, never her chats); only the user's OK saves, into the same card through the in-place update (backup first).
      const understanding = new CharacterUnderstandingHost({ card: id => characterCards.publicState().cards.find(card => card.id === id),
        fingerprint: id => characterCards.cardFingerprint(id), model: () => store.current.provider.model, stream: streamClaude,
        publish: view => { if (controls && !controls.isDestroyed()) controls.webContents.send('desk:character-understanding', view); },
        save: (id, draft, expected) => mutate(async () => { const previous = characterCards.getActive();
          await characterCards.updateInPlace(id, draft, { expected, backup: () => backupBeforeUpdate(store.directory, 'characters.json') });
          return syncCharacter(false, previous); }) });
      for (const [name, operation] of Object.entries(characterUnderstandingHandlers(understanding))) host(name, operation);
      provided = { cardUpdates, importCharacterCardContent, updateCharacterCardContent };
    },
    provides: {
      splitCharacterFromModelAtStartup,
      adoptCharacterForModel,
      importCharacterCardContent: content => registered().importCharacterCardContent(content),
      updateCharacterCardContent: (id, content, expected, options) => registered().updateCharacterCardContent(id, content, expected, options),
      planCharacterCardUpdate: (id, content) => registered().cardUpdates.plan(id, content),
      syncCharacter,
    },
  };
}
