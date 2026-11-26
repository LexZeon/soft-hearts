// 角色卡's ready-chain steps and save step (wiring rewrite step 5, docs/claude/2026-11-17-wiring-step-5.md), moved from electron/main.ts
// unchanged: the card stores, made in the ready chain where they were (the wiring golden expands each step in place, so the ready chain
// is identical), the card stickers, the reaction profiles and personalised language, the language research (its own Claude call: a chat
// call, never writable) and the save step that compiles the persona. The stores are live bindings electron/main.ts and the parts read.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app, type BrowserWindow } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AppSettings } from '../../shared/contracts';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { compileCharacterPersona } from '../../shared/cards';
import { followedVoice, voicesToSettle } from '../../shared/voice';
import { broadcast } from './shell-wiring';
import { CharacterAvatarStore, CharacterCardStore, CharacterResponseService, CharacterResponseStore, CharacterStickerHost, CharacterStickerStore, createConversionQuitGate, PersonalizeAuthoring, PersonalizeLanguageStore,
  type inspectGeneProfile } from '../cards';
import { streamClaude } from '../brain';
import type { SettingsStore } from '../settings';
import type { CardsNeeds } from './cards-wiring';
import { uiLanguage } from './settings-wiring';
import { blushCalibrations } from './mood-wiring';
import { startUnit, startUnitSync } from './parts-wiring';
import { singleEmojiContext, singleEmojiCues } from './stage-wiring';
import { reserveCompanionAuthoring } from './brain-wiring';
import { ASSISTANT_NAME } from '../../shared/foundation/assistant-name';

// ---- 角色卡's stores (wiring rewrite step 5): made in the ready chain by the steps below, in the order the ready chain had them (the
// wiring golden expands each step in place); live bindings electron/main.ts and the other parts read. ----
export let characterCards: CharacterCardStore;
/** C2 角色页: each card's small picture, on this computer only. */
export let characterAvatars: CharacterAvatarStore | null = null;
export let characterResponses: CharacterResponseStore;
export let characterResponseService: CharacterResponseService;
export let personalizeLanguage: PersonalizeLanguageStore | undefined;
export let languageAuthoring: PersonalizeAuthoring | undefined;
export let characterStickerHost: CharacterStickerHost | null = null;
// Set by wireCards (while electron/main.ts is evaluated, before any ready step runs): what the steps read when used.
let cardsNeeds!: Pick<CardsNeeds, 'controls' | 'speechScope'>;
// The language research's identity reads 声音's speech scope by its old name (its line is the old one word for word).
let speechScope!: () => string;
export function wireCardsReady(needs: Pick<CardsNeeds, 'controls' | 'speechScope'>): void { cardsNeeds = needs; speechScope = () => needs.speechScope(); }

/** Ready-chain step (角色卡): the cards, right after the settings and the interface language (an English interface starts with English Gene). */
export async function startCardStore(store: SettingsStore, geneProfile: Awaited<ReturnType<typeof inspectGeneProfile>>, hasSavedSettings: boolean): Promise<void> {
  characterCards = new CharacterCardStore(store.directory, geneProfile.legacySystemPrompt ?? store.current.persona);
  characterAvatars = new CharacterAvatarStore(store.directory);
  await characterCards.load({ preinstalledGene: true, freshProfile: !hasSavedSettings && geneProfile.fresh, uiLanguage: uiLanguage.current.language }); // I-071 v2: an English interface starts with English Gene
  await settleCharacterVoices(store); // I-162: each card keeps the voice she has now; the global setting becomes the default for new characters
}
/** Ready-chain step (角色卡): the card stickers, after the single emoji's settings they show through. */
export async function startCardStickers(store: SettingsStore): Promise<void> {
  await startUnit('cards', 'stickers', async () => { // overhaul step 7: this unit's start, through the part runner
  const stickerStore=new CharacterStickerStore(store.directory);await stickerStore.load().catch(()=>console.warn('角色贴图库暂不可读；原文件保留。'));
  characterStickerHost=new CharacterStickerHost({
    context:singleEmojiContext,store:stickerStore,
    identity:async()=>{const model=store.current.model,context=singleEmojiContext();if(!model||store.current.provider.kind!=='claude')return null;const modelKey=await blushCalibrations.keyForModel(model.path);if(context!==singleEmojiContext()||model.url!==store.current.model?.url)return null;return{context,modelUrl:model.url,binding:{characterId:characterCards.getActive().id,modelKey}};},
    publish:value=>{const { controls } = cardsNeeds; /* read when called */ if(controls&&!controls.isDestroyed())controls.webContents.send('desk:character-stickers',value);},
    preview:async assetId=>{const view=await characterStickerHost!.get(),asset=view.saved.find(a=>a.id===assetId);return !!asset&&!!singleEmojiCues?.offer('sticker-preview-'+randomUUID(),asset.intent,singleEmojiContext());},
    // No transport: native pre-dispatch input/read and save-domain proof is not granted.
  });
  });
}
/** Ready-chain step (角色卡): each card's reaction profile and personalised language. */
export async function startCardResponses(store: SettingsStore): Promise<void> {
  // Overhaul step 7: the reaction profiles are core (her conversation reads them from its first turn); the personalised language is its own unit.
  characterResponses = new CharacterResponseStore(store.directory, () => characterCards.publicState().cards.map(card => card.id));
  await characterResponses.load();
  characterResponseService = new CharacterResponseService(characterCards, characterResponses);
  await startUnit('cards', 'personalize-language', async () => {
  personalizeLanguage = new PersonalizeLanguageStore(store.directory, () => characterCards.publicState().cards.map(card => card.id));
  await personalizeLanguage.load();
  });
}
/**
 * Ready-chain step (角色卡): the language research. Its Claude call is a chat call on the current Claude connection, never writable and
 * without tools; it borrows the chat's one lease (大脑's reserveCompanionAuthoring), so it never runs beside a reply.
 */
export function startLanguageAuthoring(store: SettingsStore): void {
  startUnitSync('cards', 'personalize-language', () => { // overhaul step 7: this unit's start, through the part runner
  languageAuthoring = new PersonalizeAuthoring({
    context: () => ({ characterId: characterCards.getActive().id, codex: store.current.provider.kind === 'claude',
      identity: createHash('sha256').update(JSON.stringify([speechScope(), store.current.provider, compileCharacterPersona(characterCards.getActive())])).digest('hex') }),
    savedRevision: id => personalizeLanguage!.get(id).revision,
    reserve: (owner,id,controller)=>reserveCompanionAuthoring(owner,id,controller,'language-authoring'),
    stream: async (prompt, signal, append) => {
      const provider = { ...store.current.provider };
      if (provider.kind !== 'claude') throw Error(`语言研究仅使用当前 ${ASSISTANT_NAME} 文字连接。`);
      await streamClaude({ kind: 'chat', model: provider.model, workingDirectory: path.join(store.directory, 'chat'),
        writable: false, prompt, imageDataUrls: [] }, signal, (type, text) => { if (type === 'delta') append(text); });
    },
  });
  });
}
/** Save step (角色卡): the persona is compiled from the current card (wireSaveSettings in electron/main.ts gives the order). */
export function saveCardPersona(next: AppSettings, _baseline?: unknown, store?: SettingsStore): void {
  next.persona = compileCharacterPersona(characterCards.getActive());
  if (store) followSavedVoice(next, store); // I-162: a voice choice saved for her now moves her card's voice along
}
/**
 * I-162: the voice panel, the system voice list and the agent channel's voice tools still save settings (step 2 brings the card's own voice
 * editor). When such a save changes the active character's choice, her card's voice follows (shared/voice/character-voice-settle.ts); the
 * other characters keep theirs. The card write runs on the card store's own queue; the windows get the new cards when it is written.
 */
function followSavedVoice(next: AppSettings, store: SettingsStore): void {
  const card = characterCards.getActive(), voice = followedVoice(store.current, next, card);
  if (!voice) return;
  void characterCards.setVoices(new Map([[card.id, voice]])).then(state => broadcast('desk:characters', state),
    error => console.warn('I-162 角色声音：没有写进角色卡。', error instanceof Error ? error.message : error));
}
/** I-162 (part of the card store's ready step): every card without a voice of her own gets the one she speaks with now (the migration). */
async function settleCharacterVoices(store: SettingsStore): Promise<void> {
  const state = characterCards.publicState(), links = new Map(characterCards.rosterCards().map(card => [card.id, card.modelPath]));
  const voices = voicesToSettle(store.current, state.cards.map(card => ({ id: card.id, voice: card.voice, modelPath: links.get(card.id) })),
    { id: state.activeId, modelPath: store.current.model?.path ?? '' });
  if (voices.size) await characterCards.setVoices(voices).catch(error => console.warn('I-162 角色声音：启动时没有写进角色卡。', error instanceof Error ? error.message : error));
}
/** Window step (角色卡, step 5b; electron/main.ts's wireWindowEvents gives the order): the closed window's language research ends. */
export function closeLanguageAuthoring(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  languageAuthoring?.close(windowId);
}

// ---- quit (step 5b; electron/main.ts's wireQuit gives the order, electron/wiring/quit-wiring.ts)
let conversionQuit!: ReturnType<typeof createConversionQuitGate>;
/** electron/main.ts hands over the agent channel's running conversion (I-071 v2 第三步) while it is evaluated. */
export function wireCardsQuit(appConversion: Parameters<typeof createConversionQuitGate>[0]): void {
  conversionQuit = createConversionQuitGate(appConversion, () => app.quit()); // Codex X-435: quitting cancels a running conversion like 取消 (its claude -p ends) and waits for it (≤3 s)
}
/** Quit step: a running conversion is cancelled the way 取消 does; the quit resumes once it ended. */
export function holdForConversion(event: { preventDefault(): void }): void {
  if (conversionQuit.hold()) event.preventDefault(); // electron/cards/character-convert/quit.ts: cancelled the way 取消 does; the quit resumes once it ended (≤3 s)
}
/** Flush step: a conversion still saving ends before the stores flush. */
export async function conversionEnded(): Promise<void> {
  await conversionQuit.ended(); // a conversion still saving ends (or its 3 s pass, counted from the same start) before the stores flush
}
