// no-pet-ok-file: reads the companion window handle and drag state other parts name this way
// I-209 step 4 (docs/claude/2026-11-24-i209-step4.md): on the full-screen stage everyone hears, everyone records, and the characters decide
// who answers. The logic is electron/brain/stage-chat/ (hearing, the chime-in round, her two calls); this only gives it the app's ports:
//  - who is on stage: the stage coordinator's card ids (electron/unbound/company/stage.ts ids(); [] alone or at home);
//  - her memory: CompanionService.ownerScope (her own archive), the chat memory's appendStageLine; the memory tells every said line here
//    (brain-wiring.ts hands `stageLine` to companion.memory.onStageLine);
//  - her calls: the chat model setting, her card, her mood, her archive's window (names in it), haiku for the decision (model.ts);
//  - her voice and bubble: the stage owns her line (her window, the floor), the first host holds it (the read-aloud proof); once her page has
//    painted it the companion window reads it held in her card's voice (beginInitiativeSpeech with her card; stage voice: the line's own
//    guard lets it play, initiative-wiring readStageLine; the user's turn talking over her ends it, cutStageLine);
//  - free: the sense line's rule; the switch: 「三人同框（Beta）」 and 「她们都能接话」 (channel gates); the journal: one closed row per decision.
// No module-level side effects: nothing is made before wireStageChat runs.
import { cardLanguageOf, compileCharacterPersona, personalizeLanguageContext } from '../../shared/cards';
import { chimeInOrigin } from '../../shared/senses';
import { ChimeIn, ChimeTurns, StageHearing, chatAvailability, chimeDecisionWithClaude, chimeLineWithClaude, historyText, type HeardEvent } from '../brain';
import { longChatHistory } from '../brain/long-chat/host';
import { senseLineFree } from '../senses';
import { gateEnabled } from './channel-gates-wiring';
import { userActivity, userInputUntil } from './senses-wiring';
import { cutStageLine, proactiveSpeechGate, readStageLine, type InitiativeNeeds } from './initiative-wiring';
import { rps } from './initiative-together-wiring';
import { onUnboundModeChanged, unbound, unboundStage } from './unbound-wiring';
import { LONG_CHAT } from './brain-wiring';

let hearing: StageHearing | null = null;
/** The chime-in round (diagnostics, tests). */
export let chimeIn: ChimeIn | null = null;

/** The chat memory's listener (brain-wiring.ts): every said line and every turn the user began. */
export function stageLine(event: HeardEvent): void { hearing?.event(event); }

/** Everyone on stage now as card ids ([] alone or not out). */
export function stageIds(): string[] { try { return unboundStage()?.ids() ?? []; } catch { return []; } }

export function wireStageChat(needs: () => InitiativeNeeds): void {
  const name = (id: string) => { try { return needs().characterCards.getCard(id).name; } catch { return ''; } };
  const turns = new ChimeTurns({
    chatModel: () => needs().store.current.provider.kind === 'claude' ? needs().store.current.provider.model : null,
    character: id => { const card = needs().characterCards.getCard(id); return { persona: compileCharacterPersona(card), language: personalizeLanguageContext(needs().personalizeLanguage?.effectiveProfile(id)), speech: cardLanguageOf(card) }; },
    mood: id => needs().companion.mood.chatContext({ characterId: id }),
    history: id => { const { companion, characterCards } = needs(); const window = longChatHistory({ knobs: { ...LONG_CHAT, enabled: true }, archives: [companion.memory], scope: companion.ownerScope(id), language: cardLanguageOf(characterCards.getCard(id)) }); return window ? historyText(window, name(id)) : ''; },
    available: () => chatAvailability.isAvailable(),
    decide: (prompt, signal) => chimeDecisionWithClaude(prompt, signal),
    line: (prompt, model, signal) => chimeLineWithClaude(prompt, model, signal),
    free: () => { const { petWindowDrag, ambientSpeakingOwners, pending, herOnScreen, replySpeechBusy } = needs(); // read when called (the sense line's rule)
      return senseLineFree({ herOnScreen: herOnScreen(), dragging: !!petWindowDrag?.active, replySpeechBusy: replySpeechBusy(), ambientSpeaking: ambientSpeakingOwners.size > 0,
        proactiveBusy: proactiveSpeechGate.busy, chatPending: [...pending.values()].some(task => task.kind === 'chat'), gameActive: rps.host.active, userInputUntil, now: Date.now() }); },
    onStage: id => stageIds().includes(id),
    // Her window and the floor (the stage owns the line), held by the first host (its read-aloud proof); read by the companion window in her
    // voice once her page painted it (stage voice: what is said is what was shown), under the line's own guard.
    show: (id, lineId, text) => { const stage = unboundStage();
      if (!stage || !unbound) return false;
      stage.own(lineId, id);
      if (unbound.holdLine(lineId, text).held !== true) { stage.release(lineId); return false; }
      return true; },
    proven: (lineId, text) => !!unbound && unbound.readAloud.currentId === lineId && unbound.readAloud.isPresentationCurrent(text),
    voice: (id, lineId, text) => { const { pet, beginInitiativeSpeech } = needs();
      if (!pet || pet.isDestroyed() || !unbound) return false;
      const proof = unbound.readAloud; beginInitiativeSpeech(pet.webContents.id, lineId, id);
      readStageLine(pet.webContents.id, lineId, { canSpeak: line => line === lineId && proof.currentId === lineId && proof.isPresentationCurrent(text) && stageIds().includes(id) });
      pet.webContents.send('desk:sense-line', { id: lineId, text, origin: chimeInOrigin(lineId, Date.now()), held: true, voice: id }); // `voice`: whose card the window reads it with
      return true; },
    cut: lineId => { cutStageLine(lineId); },
    speaking: () => needs().replySpeechBusy() || needs().speechPlaybackActivity?.busy === true,
    release: lineId => { unboundStage()?.release(lineId); },
    archive: (id, lineId, text, at, current) => needs().companion.memory.appendStageLine(needs().companion.ownerScope(id), { id: lineId, text, at, role: 'assistant' }, () => current() && !needs().exiting),
  });
  chimeIn = new ChimeIn({
    enabled: () => gateEnabled('threeOnStage') && gateEnabled('chimeIn'),
    present: stageIds, name,
    ask: (id, facts, signal) => turns.ask(id, facts, signal),
    speak: (id, facts, signal) => turns.speak(id, facts, signal),
    user: () => { const state = userActivity?.view()?.state; return { busy: state === 'busy' ? true : null, away: state === 'away' ? true : null }; },
    journal: row => { needs().appJournal.record({ type: 'chime-in', ...row }); },
    clock: () => Date.now(),
  });
  hearing = new StageHearing({
    present: stageIds,
    scopeOf: id => { try { return needs().companion.ownerScope(id); } catch { return null; } },
    speaker: id => ({ characterId: id, name: name(id) }),
    append: (scope, line) => needs().companion.memory.appendStageLine(scope, line, () => !needs().exiting),
    heard: line => chimeIn?.heard(line),
    userSpoke: at => chimeIn?.userSpoke(at),
  });
  onUnboundModeChanged(state => { if (state !== 'unbound') chimeIn?.stop(); }); // leaving full screen: no round goes on, nothing said there carries into the next time
}
