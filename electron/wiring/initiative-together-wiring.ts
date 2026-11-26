// 主动's wiring, what she does with you and gives you (split from electron/wiring/initiative-wiring.ts,
// docs/claude/2026-11-17-split-initiative-memory-wiring.md): G1 猜拳, I-019 喂食认图 (its line is hers; the recognition itself is
// 感知's module), I-051 带我去, I-050 her folder and its keepsakes, I-059 special days (记忆's module, made beside the keepsakes as
// before), I-086 递东西, I-087 牵手. The statements are the ones wireInitiative had, in its order; wireInitiative calls
// wireInitiativeTogether after wireInitiativeLook and then registers the four stores made here (猜拳, 牵手拉钩, 我们的小东西, 留给你的)
// with the data map (registerPrivacyStores('initiative', …), still in initiative-wiring.ts).
// No module-level side effects: nothing here runs on import.
import { dialog, shell } from 'electron';
import { t } from '../../shared/foundation/ui-language';
import { baseCardName, cardLanguageOf, compileCharacterPersona, personalizeLanguageContext } from '../../shared/cards';
import { HerFolderHost, quickLineWithClaude, TakeMeThere } from '../initiative';
import { createRps } from '../initiative/rps/wiring';
import { createKeepsake } from '../initiative/her-folder/keepsake-wiring';
import { createGive } from '../initiative/give/wiring';
import { createHands } from '../initiative/hands/wiring';
import { chatAvailability, claudeCallsInFlight } from '../brain';
import { localDateKey, type SpecialDayHost } from '../memory';
import { createSpecialDay, recycleSingle, recycleStores, takeOurThing, upcoming, userProfileManagement, userProfiles } from './memory-wiring';
import { createFeedRecognition, userActivity } from './senses-wiring';
import { broadcast, showControls, windows } from './shell-wiring';
import { proactiveSpeechGate, readStageLine, type InitiativeNeeds } from './initiative-wiring';
import { proactiveChatFor } from './proactive-chat-wiring';
import { impulse, innerLoopHost } from './initiative-inner-loop-wiring';
import { createGameLines, herPlay, playShown, sendPlay } from './unbound-games-wiring'; // batch B: out in full-screen Unbound her games go to her window there
import { connectUnboundGames, unboundCloseOn } from './unbound-wiring';

// ---- state other parts read (re-exported by initiative-wiring.ts; live bindings) ----
export let rps!: ReturnType<typeof createRps>;
export let feeding!: ReturnType<typeof createFeedRecognition>;
export let takeMeThere!: TakeMeThere;
export let herFolder!: HerFolderHost;
export let keepsake!: ReturnType<typeof createKeepsake>;
export let specialDay!: SpecialDayHost;
export let give!: ReturnType<typeof createGive>;
export let hands!: ReturnType<typeof createHands>;
/** Her game lines out in full-screen Unbound (electron/unbound/game-line.ts): held in her bubble, read by the companion window. */
let gameLines!: ReturnType<typeof createGameLines>;

// Set by its wire function (called by wireInitiative while electron/main.ts is evaluated, before anything below runs).
let needs!: InitiativeNeeds;

/** wireInitiative calls this once, after wireInitiativeLook: 猜拳, 喂食, 带我去, her folder, keepsakes, special days, 递东西, 牵手. */
export function wireInitiativeTogether(given: InitiativeNeeds): void {
  needs = given;
  const { speechScope, journalCharacterId, replySpeechBusy, beginInitiativeSpeech } = given;
  // no-pet-ok: needs.pet is the existing field name of InitiativeNeeds (the companion window)
  gameLines = createGameLines({ companion: () => needs.pet, chatBusy: () => [...needs.pending.values()].some(task => task.kind === 'chat'), voiceOn: () => needs.store.current.voice.enabled,
    begin: beginInitiativeSpeech, guard: (owner, id, canSpeak) => readStageLine(owner, id, { canSpeak }), skipped: (id, why) => { queueMicrotask(() => { rps.host.respond({ id, action: 'skipped', unread: why }); }); }, /* after the view that carried the line has been published */ unread: why => rps.host.lineUnread(why) });
  // G1 猜拳 (electron/initiative/rps/): the match lives here so the companion window never sees her hand before the reveal.
  rps = createRps({ directory: () => needs.store.directory, mood: () => needs.companion?.mood.get() ?? null, persona: () => compileCharacterPersona(needs.characterCards.getActive()),
    visible: () => playShown(needs.pet), recording: () => !!userProfiles?.view().enabled,
    send: view => { if (sendPlay(needs.pet, 'rps', view, win => win.webContents.send('desk:rps', view)) && herPlay(needs.pet).surface === 'unbound') gameLines.view(view); }, // no-pet-ok: needs.pet, the existing field name. Out in Unbound her line is held in her bubble and read by the companion window (after the view, so her page has the line first)
    moodEvent: (event, id) => needs.companion.mood.event(event, id), interacted: id => { needs.companion.herLife.interact(id); },
    chatBusy: () => [...needs.pending.values()].some(task => task.kind === 'chat'), speaking: () => replySpeechBusy() || needs.speechPlaybackActivity.busy,
    quick: async (prompt, systemPrompt, signal) => (await quickLineWithClaude(prompt, systemPrompt, signal)).text, available: () => chatAvailability.isAvailable(), localDate: localDateKey,
    language: () => personalizeLanguageContext(needs.personalizeLanguage?.effectiveProfile(needs.characterCards.getActive().id)), speechLanguage: () => cardLanguageOf(needs.characterCards.getActive()), speechStyle: id => { const { pet } = needs; /* read when called */ if (pet && !pet.isDestroyed()) beginInitiativeSpeech(pet.webContents.id, id); },
    journal: (id, entry) => { needs.appJournal.rps(id, entry); if (entry.event === 'accept' || entry.event === 'decline') impulse.inviteAnswered(id, entry.event === 'accept'); if (entry.event === 'result' && entry.result && (entry.rounds ?? 0) > 0) { needs.moodJudge.host.note({ kind: 'game', characterId: id, result: entry.result, rounds: entry.rounds ?? 0 }); if (typeof hands!=='undefined') hands.host.gameEnded(entry.result); } }, router: needs.moduleRouter, // I-087: a won match → a high five
    budget: () => needs.companion?.budget ?? null }); // I-010: invite again after the user's interactions, not 2 h / 1 h / 2 a day; her game lines draw from the budget
  // I-019 喂食认图 (electron/senses/feed-recognition/): the accepted snack's picture → the small model looks → her line in the chat model's words.
  feeding = createFeedRecognition({ directory: () => needs.store.directory, petSender: () => needs.pet && !needs.pet.isDestroyed() ? needs.pet.webContents.id : null,
    mood: () => needs.companion?.mood ?? null, identity: () => speechScope(), available: () => chatAvailability.isAvailable(), recording: () => !!userProfiles?.view().enabled,
    character: () => { const card = needs.characterCards.getActive(); return { id: card.id, persona: compileCharacterPersona(card), language: personalizeLanguageContext(needs.personalizeLanguage?.effectiveProfile(card.id)), speech: cardLanguageOf(card) }; },
    chatModel: () => needs.store.current.provider.kind === 'claude' ? needs.store.current.provider.model : null,
    // Her answer to the user's own act: not held back by the 15 s after an interaction, only by what would talk over her.
    free: () => { const { pet, petWindowDrag, ambientSpeakingOwners, pending } = needs; // read when called (AppPorts.feedingFree, word for word)
      return !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized() && !petWindowDrag?.active && !replySpeechBusy() && ambientSpeakingOwners.size === 0
      && !proactiveSpeechGate.busy && ![...pending.values()].some(task => task.kind === 'chat') && !rps.host.active; },
    send: message => { const { pet } = needs; /* read when called */ if (!pet || pet.isDestroyed()) return false; pet.webContents.send('desk:feed-line', message); return true; },
    speechStyle: id => { const { pet } = needs; /* read when called */ if (pet && !pet.isDestroyed()) beginInitiativeSpeech(pet.webContents.id, id); }, broadcast: view => broadcast('desk:feed-recognition', view),
    archive: async (message, current) => { await needs.companion.memory.appendInitiative(needs.companion.currentScope(), { id: message.id, text: message.text, at: message.origin.at, origin: message.origin }, () => current() && !needs.exiting);
      broadcast('desk:vision-initiative-delivered', message); broadcast('desk:memory-changed', undefined); },
    journal: (id, entry) => needs.appJournal.feed(id, entry),
    keep: entry => { void give.host.keepFed(entry).catch(() => false); } }); // I-086: a recognised snack goes into 我们的小东西 (only with 「允许记录」 on)
  // I-051 the "take me there" button: it only opens a control-window page (electron/initiative/take-me-there.ts).
  takeMeThere = new TakeMeThere({ characterName: () => baseCardName(needs.characterCards.getActive().name), send: (owner, view) => windows().find(win => win.webContents.id === owner)?.webContents.send('desk:take-me-there', view),
    open: destination => { showControls(); needs.controls?.webContents.send('desk:control-navigate', { destination }); } });
  // I-050 她的文件夹 (electron/initiative/her-folder/): off until the user picks a folder in the native dialog; her chat stays tool-free and the host writes her one checked text file.
  herFolder = new HerFolderHost({ profileDirectory: () => needs.store ? needs.store.directory : null, characterId: () => journalCharacterId(), journal: input => { needs.appJournal.record(input); },
    pickFolder: async defaultPath => { const picked = await dialog.showOpenDialog(needs.controls!, { title: t("选择她的文件夹"), defaultPath: defaultPath ?? undefined, properties: ["openDirectory", "createDirectory"] }); return picked.canceled ? null : picked.filePaths[0] ?? null; },
    openPath: folder => shell.openPath(folder), broadcast: view => { const { controls } = needs; /* read when called */ if (controls && !controls.isDestroyed()) controls.webContents.send('desk:her-folder', view); },
    sendNote: (owner, view) => windows().find(win => win.webContents.id === owner)?.webContents.send('desk:her-folder-note', view) });
  // I-050 第 2 步 (electron/initiative/her-folder/keepsake.ts): special days (only with 「允许记录」 on) and now and then one more thing; her light line goes through the opening choice and the inner loop.
  keepsake = createKeepsake({ folder: herFolder, moment: (kind, id, key) => { needs.companion?.mood.moments.note(kind, id, key); }, directory: () => needs.store ? needs.store.directory : null, characterId: () => needs.companion.mood.get().characterId,
    profile: () => userProfileManagement?.get() ?? null, speechLanguage: () => cardLanguageOf(needs.characterCards.getActive()), persona: () => compileCharacterPersona(needs.characterCards.getActive()), mood: () => needs.companion.mood.get(), talk: () => needs.store?.current.proactiveTalk,
    model: () => needs.store.current.provider.kind === 'claude' ? needs.store.current.provider.model : '',
    calm: () => { const { exiting, pending } = needs; // read when called (AppPorts.keepsakeCalm, word for word)
      return !exiting && !innerLoopHost.loop.asleep() && userActivity?.view()?.state !== 'busy' && userActivity?.presence().interrupt !== 'no' && !proactiveSpeechGate.busy && ![...pending.values()].some(task => task.kind === 'chat') && claudeCallsInFlight() === 0 && chatAvailability.isAvailable(); } });
  // I-059 (electron/memory/special-day/): the user's birthday or an anniversary, only while her folder is off: one hint on the first daytime turn, or one line of her own before the user has talked.
  specialDay = createSpecialDay({ folder: herFolder, directory: () => needs.store ? needs.store.directory : null, characterId: () => journalCharacterId(), profile: () => userProfileManagement?.get() ?? null,
    persona: () => compileCharacterPersona(needs.characterCards.getActive()), recentChat: proactiveChatFor(() => needs), mood: () => needs.companion.mood.get(), model: () => needs.store.current.provider.kind === 'claude' ? needs.store.current.provider.model : '',
    calm: () => { const { exiting, pending } = needs; // read when called (AppPorts.specialDayCalm, word for word)
      return !exiting && !innerLoopHost.loop.asleep() && userActivity?.view()?.state !== 'busy' && userActivity?.presence().interrupt !== 'no' && !proactiveSpeechGate.busy && ![...pending.values()].some(task => task.kind === 'chat') && claudeCallsInFlight() === 0 && chatAvailability.isAvailable(); },
    language: () => cardLanguageOf(needs.characterCards.getActive()), journal: input => { needs.appJournal.record({ type: 'special-day', ...input }); }, moment: (id, key) => { needs.companion?.mood.moments.note('special-day', id, key); } }); // 心情第二批: she spoke of the day (D, O a little up)
  // I-086 她也照顾你 (electron/initiative/give/): one more candidate in her opening choice (same cue, interval and hourly caps; ≤ 3 offers a day); her own line, then the stage hands it over.
  give = createGive({ directory: () => needs.store ? needs.store.directory : null, petSender: () => needs.pet && !needs.pet.isDestroyed() ? needs.pet.webContents.id : null, removeThroughBin: (characterId, id, remove) => recycleSingle(() => takeOurThing(recycleStores(), characterId, id), remove, view => !view.items.some(item => item.id === id)), // I-144b: 「删掉」 into the recycle bin first
    characterId: () => needs.companion?.mood.get().characterId ?? '', enabled: () => !!needs.store && needs.store.current.innerLoop !== false && !!needs.companion && needs.companion.mood.get().expressions,
    mood: characterId => { const view = needs.companion?.mood.get(); if (!view || view.characterId !== characterId) return null;
      return { values: { ...view.snapshot.values }, baseline: { ...view.parameters.baseline }, evidence: view.parameters.evidence?.level, longing: view.snapshot.longing, A: typeof view.fatigue?.A === 'number' ? view.fatigue.A : null }; },
    user: () => { const { companion } = needs; /* read when called */ const now = new Date(), view = companion?.mood.get(), at = view?.snapshot.lastInteractionAt;
      return { localMinute: now.getHours() * 60 + now.getMinutes(), tired: !!view && companion.userState.current(view.characterId)?.state === 'tired',
        stillMinutes: typeof at === 'number' && Number.isFinite(at) ? Math.max(0, (Date.now() - at) / 60_000) : null }; },
    specialDay: () => specialDay.isSpecialToday(), recording: () => !!userProfiles?.view().enabled,
    send: event => sendPlay(needs.pet, 'give', event, win => win.webContents.send('desk:give', event)),
    moment: (characterId, key) => { needs.companion?.mood.moments.note('gave-taken', characterId, key); },
    journal: entry => { needs.appJournal.record(entry); },
    broadcast: view => { const { controls } = needs; /* read when called */ if (controls && !controls.isDestroyed()) controls.webContents.send('desk:our-things', view); },
    folder: { enabled: () => herFolder.enabled(), syncText: (name, content) => herFolder.syncText(herFolder.beginKeepsake(), name, content),
      keepPicture: (stem, png) => herFolder.keepPicture(herFolder.beginKeepsake(), stem, png), language: () => cardLanguageOf(needs.characterCards.getActive()) === 'en' ? 'en' : 'zh-CN' },
    saveDialog: async name => { const { controls, pet } = needs; /* read when called */ const target = controls && !controls.isDestroyed() && controls.isVisible() ? controls : pet && !pet.isDestroyed() ? pet : null;
      const picked = target ? await dialog.showSaveDialog(target, { title: t('存下来'), defaultPath: name }) : await dialog.showSaveDialog({ title: t('存下来'), defaultPath: name });
      return picked.canceled ? null : picked.filePath ?? null; } });
  // I-087 牵手、拉钩、击掌 (electron/initiative/hands/): her hand reaches for your mouse; one click holds hands, makes a pinky promise or a high five.
  hands = createHands({ directory: () => needs.store ? needs.store.directory : null, petSender: () => needs.pet && !needs.pet.isDestroyed() ? needs.pet.webContents.id : null,
    characterId: () => needs.companion?.mood.get().characterId ?? '', enabled: () => !!needs.store && needs.store.current.innerLoop !== false && !!needs.companion && needs.companion.mood.get().expressions,
    free: () => !needs.exiting && !!needs.companion && playShown(needs.pet) && !needs.petWindowDrag?.active && !innerLoopHost.loop.asleep()
      && userActivity?.view()?.state !== 'busy' && needs.companion.mood.get().snapshot.phase === 'idle' && !rps.host.active && !give.host.current(),
    closeOn: () => unboundCloseOn(), // 2026-11-25: no new reach while she is coming up to the lens, kissing or hugging
    mood: characterId => { const { companion } = needs; /* read when called */ const view = companion?.mood.get(); if (!view || view.characterId !== characterId) return null;
      return { values: { ...view.snapshot.values }, baseline: { ...view.parameters.baseline }, evidence: view.parameters.evidence?.level, A: typeof view.fatigue?.A === 'number' ? view.fatigue.A : null }; },
    send: event => sendPlay(needs.pet, 'hands', event, win => win.webContents.send('desk:hands', event)),
    moment: (kind, characterId, key) => { needs.companion?.mood.moments.note(kind, characterId, key); },
    journal: entry => { needs.appJournal.record(entry); }, recording: () => !!userProfiles?.view().enabled,
    keepFirstHold: (characterId, at) => give.host.keepFirstHold(characterId, at), recentPlans: since => upcoming?.recentPlanIds(since) ?? [] });
  // Batch B: out in full-screen Unbound, her window answers through the same host methods (electron/unbound/games-bridge.ts checks the window).
  connectUnboundGames({ rps: { view: () => rps.host.view(), throwHand: value => rps.host.throwHand(value), respond: value => rps.host.respond(value) },
    give: { answer: value => give.host.answer(true, value) }, hands: { answer: value => hands.host.answer(true, value), request: value => hands.host.request(true, value) },
    playing: () => rps.host.active || !!give.host.current() || hands.host.active, surfaceChanged: () => { rps.host.cancel(); give.host.cancel(); hands.host.cancel(); },
    armsOn: () => ({ game: rps.host.active, give: !!give.host.current(), hand: hands.host.active }), dropHand: () => hands.host.cancel() }); // 2026-11-25: her hand reach yields to a kiss / hug she wrote
}
