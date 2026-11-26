// 主动's wiring, her looking (split from electron/wiring/initiative-wiring.ts, docs/claude/2026-11-17-split-initiative-memory-wiring.md):
// I-040 看一眼、听一下 (the sense router, evaluated by the reactions' haiku call) and I-085 her own look (its timer starts in
// initiative-wiring.ts's early()). The statements are the ones wireInitiative had, in its order; wireInitiative calls wireInitiativeLook
// right after it made the proactive-speech gate. Both read the camera and screen switches and captureSharedCamera (the 感知 privacy
// mutations that point at 主动 are here: scripts/dev/mutations/senses.json).
// No module-level side effects: nothing here runs on import.
import { judgedSenses, listenWordsOn } from '../../shared/senses';
import { cardLanguageOf, compileCharacterPersona, personalizeLanguageContext } from '../../shared/cards';
import { createSelfLook } from '../initiative/self-look/wiring';
import { chatAvailability } from '../brain';
import { audioReading, createSenseRouter, listenTogether, userActivity, userInputUntil } from './senses-wiring';
import { broadcast, ownerFor, windows } from './shell-wiring';
import { proactiveSpeechGate, type InitiativeNeeds } from './initiative-wiring';
import { rps } from './initiative-together-wiring';
import { unbound } from './unbound-wiring';
import { deliverSenseLine, senseLineFree, type WatchFactsTurn } from '../senses';
import { attachWatchSpeaker } from './senses-wiring';
import { createWatchFactsTurn } from './watch-facts-turn-wiring';
import { wireStageChat } from './brain-stage-chat-wiring';

// ---- state other parts read (re-exported by initiative-wiring.ts; live bindings) ----
export let senseRouter!: ReturnType<typeof createSenseRouter>;
export let selfLook!: ReturnType<typeof createSelfLook>;
let watchFactsTurn: WatchFactsTurn | null = null; // 2026-11-24 (续): her one turn after a lost share (electron/wiring/watch-facts-turn-wiring.ts)

// Set by its wire function (called by wireInitiative while electron/main.ts is evaluated, before anything below runs).
let needs!: InitiativeNeeds;

/** wireInitiative calls this once, after the proactive-speech gate: the sense router, then her own look. */
export function wireInitiativeLook(given: InitiativeNeeds): void {
  needs = given;
  const { speechScope, journalCharacterId, replySpeechBusy, beginInitiativeSpeech, cameraLookJournal, lookState } = given;
  // I-040 看一眼、听一下 (electron/senses/sense-router/): on the reaction judge's haiku call, whether a message needs the camera, the screen or the heard words;
  // a needed sense the user has on gives one look (memory only) and she adds one short line after her reply. Never turns anything on.
  watchFactsTurn = createWatchFactsTurn(() => needs); attachWatchSpeaker((facts, characterId) => watchFactsTurn!.say(facts, characterId));
  wireStageChat(() => needs); // I-209 step 4: on the full-screen stage everyone hears, everyone records, the characters decide who answers
  senseRouter = createSenseRouter({ lineDone: (fromWindow, value) => watchFactsTurn?.done(fromWindow, value) ?? false, identity: () => { try { return speechScope(); } catch { return ''; } }, conversation: () => needs.companion?.conversationId ?? '', cameraLook: (id, result, detail) => cameraLookJournal.sensed(id, result, detail),
    lookLine: fields => { needs.appJournal.record({ type: 'voice-call', characterId: journalCharacterId(), event: 'look', ...fields }); }, // 2026-11-21: a chat message's look line (closed words)
    // I-166 "不需要haiku": camera and screen leave the haiku look judgment (SEE_AND_SAY.haikuLook off; she decides by her marker); hearing stays.
    on: () => judgedSenses({ camera: needs.media.sharesCameraFrames() && !!needs.media.state.cameraOwner && needs.media.state.cameraHeld !== true, screen: needs.media.state.screenSharing === true && !needs.lookTurns.refusedIn(lookState()), transcript: !!listenTogether && listenWordsOn(audioReading?.getView()) }),
    capture: async (sense, signal, miss) => { const { media, lookTurns, screenSnapshots, captureSharedCamera } = needs; // read when called
      if (sense === 'screen') return media.state.screenSharing && !lookTurns.refusedIn(lookState()) ? (await screenSnapshots.sampleOnce(signal))?.dataUrl ?? null : null;
      // 2026-11-21: why no frame came (closed words) goes to the camera-look line; the small kept frame below still counts as a look.
      const owner = windows().find(win => ownerFor(win.webContents.id) === media.state.cameraOwner); if (media.sharesCameraFrames() && owner) { const frame = await captureSharedCamera(owner.webContents.id, signal, miss); if (frame) return frame.dataUrl; } else miss?.('no-window'); return media.cameraAttachment()?.dataUrl ?? null; },
    heard: () => listenTogether?.recentHeard() ?? null, watch: { open: (text, scope) => listenTogether?.watchOpen(text, scope), summary: (facts, scope) => listenTogether?.watchSummary(facts, scope) }, mood: () => needs.companion?.mood.chatContext() ?? '', chatModel: () => needs.store.current.provider.kind === 'claude' ? needs.store.current.provider.model : null,
    character: () => { const card = needs.characterCards.getActive(); return { id: card.id, persona: compileCharacterPersona(card), language: personalizeLanguageContext(needs.personalizeLanguage?.effectiveProfile(card.id)), speech: cardLanguageOf(card) }; },
    // 2026-11-21: free means she can be seen and heard now (herOnScreen: the companion window shown, or out with her Unbound bubble able to show), not the companion window itself.
    free: () => { const { petWindowDrag, ambientSpeakingOwners, pending, herOnScreen } = needs; // read when called (AppPorts.senseRouterFree, with herOnScreen)
      return senseLineFree({ herOnScreen: herOnScreen(), dragging: !!petWindowDrag?.active, replySpeechBusy: replySpeechBusy(), ambientSpeaking: ambientSpeakingOwners.size > 0,
        proactiveBusy: proactiveSpeechGate.busy, chatPending: [...pending.values()].some(task => task.kind === 'chat'), gameActive: rps.host.active, userInputUntil, now: Date.now() }); },
    petSender: () => needs.pet && !needs.pet.isDestroyed() ? needs.pet.webContents.id : null,
    // Out in full-screen Unbound the line goes into her bubble once (the companion window only remembers and reads it, never shows it); at home as before.
    send: message => deliverSenseLine({ homeShown: () => { const { pet } = needs; /* read when called */ return !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized(); },
      hold: (id, text) => unbound?.holdLine(id, text).held === true,
      sendCompanion: (line, held) => { const { pet } = needs; /* read when called */ if (!pet || pet.isDestroyed()) return false; pet.webContents.send('desk:sense-line', held ? { ...line, held: true } : line); return true; },
      shownOut: id => { senseRouter.host.done(true, { id, shown: true }); } }, message),
    speechStyle: id => { const { pet } = needs; /* read when called */ if (pet && !pet.isDestroyed()) beginInitiativeSpeech(pet.webContents.id, id); },
    archive: async (message, current) => { await needs.companion.memory.appendInitiative(needs.companion.currentScope(), { id: message.id, text: message.text, at: message.origin.at, origin: message.origin }, () => current() && !needs.exiting);
      broadcast('desk:vision-initiative-delivered', message); broadcast('desk:memory-changed', undefined); } });
  // I-085 第 1 步 她想看才看 (electron/initiative/self-look/): about once a minute, from her mood and how long the user has been quiet, whether she wants to look;
  // with 「发图片」 on and no "别看", one frame and one haiku line (memory only, 10 minutes, this character and conversation), given to her next turn as text.
  selfLook = createSelfLook({ enabled: () => needs.store?.current.selfLook !== false, camera: () => ({ frames: needs.media.sharesCameraFrames() && !!needs.media.state.cameraOwner, held: needs.media.state.cameraHeld === true }),
    characterId: journalCharacterId, conversationId: () => needs.companion?.conversationId ?? null, mood: () => { try { return needs.companion?.mood.get() ?? null; } catch { return null; } },
    present: () => needs.herOnScreen() && chatAvailability.isAvailable() /* 2026-11-21: seen in the companion window or out in Unbound */, idleSeconds: () => userActivity?.idleSeconds() ?? null,
    typing: () => Date.now() < userInputUntil || [...needs.pending.values()].some(task => task.kind === 'chat'),
    capture: async signal => { const { media, captureSharedCamera } = needs; /* read when called */ const owner = windows().find(win => ownerFor(win.webContents.id) === media.state.cameraOwner);
      if (media.sharesCameraFrames() && owner) { try { const frame = await captureSharedCamera(owner.webContents.id, signal); if (frame) return frame.dataUrl; } catch { /* the small kept frame below */ } } return media.cameraAttachment()?.dataUrl ?? null; },
    journal: row => { needs.appJournal.record({ type: 'self-look', characterId: journalCharacterId(), ...row }); },
    eye: () => { const { pet } = needs; /* read when called */ if (pet && !pet.isDestroyed()) pet.webContents.send('desk:self-look'); }, // I-085 step 4a: the little eye mark
    tag: tag => { needs.companion?.dayRead.noteLook(tag); }, // I-089 item 5: the look's closed tag, one input to the day's read of you (memory only)
    moment: kind => { needs.companion?.mood.moments.note(kind); } }); // I-085 step 4b: the look's closed tag, as a small mood moment (its own caps)
}
