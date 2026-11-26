// no-pet-ok-file: reads the companion window handle and drag state other parts name this way
// 2026-11-24 (续, docs/claude/2026-11-24-watch-turns-off.md): her one immediate turn after the screen share for 「和她一起看」 was lost. The logic is
// electron/senses/watch-continuity/ (facts, the state machine, the turn); this only gives the turn the same ports the sense router's second line has
// (electron/wiring/initiative-look-wiring.ts): free, delivery at home or into her Unbound bubble, speech style, one archive.
// No module-level side effects: nothing is made before wireInitiativeLook calls it.
import { cardLanguageOf, compileCharacterPersona, personalizeLanguageContext } from '../../shared/cards';
import { chatAvailability } from '../brain';
import { WatchFactsTurn, deliverSenseLine, senseLineFree, senseLineWithClaude } from '../senses';
import { broadcast } from './shell-wiring';
import { userInputUntil } from './senses-wiring';
import { rps } from './initiative-together-wiring';
import { unbound } from './unbound-wiring';
import { proactiveChatFor } from './proactive-chat-wiring';
import { proactiveSpeechGate, type InitiativeNeeds } from './initiative-wiring';

export function createWatchFactsTurn(needs: () => InitiativeNeeds): WatchFactsTurn {
  const { speechScope, replySpeechBusy, beginInitiativeSpeech } = needs();
  const recentChat = proactiveChatFor(() => ({ companion: needs().companion, characterCards: needs().characterCards }));
  const turn: WatchFactsTurn = new WatchFactsTurn({
    chatModel: () => needs().store.current.provider.kind === 'claude' ? needs().store.current.provider.model : null,
    character: () => { const card = needs().characterCards.getActive(); return { id: card.id, persona: compileCharacterPersona(card), language: personalizeLanguageContext(needs().personalizeLanguage?.effectiveProfile(card.id)), speech: cardLanguageOf(card) }; },
    mood: () => needs().companion?.mood.chatContext() ?? '',
    recentChat,
    identity: () => { try { return speechScope(); } catch { return ''; } },
    available: () => chatAvailability.isAvailable(),
    line: (prompt, model, signal) => senseLineWithClaude(prompt, model, signal),
    // She can be seen and heard now (the companion window shown, or out in Unbound with her bubble able to show) and nothing of hers going on: the sense router's rule.
    free: () => { const { petWindowDrag, ambientSpeakingOwners, pending, herOnScreen } = needs(); // read when called
      return senseLineFree({ herOnScreen: herOnScreen(), dragging: !!petWindowDrag?.active, replySpeechBusy: replySpeechBusy(), ambientSpeaking: ambientSpeakingOwners.size > 0,
        proactiveBusy: proactiveSpeechGate.busy, chatPending: [...pending.values()].some(task => task.kind === 'chat'), gameActive: rps.host.active, userInputUntil, now: Date.now() }); },
    // Out in full-screen Unbound the line goes into her bubble once (the companion window only remembers and reads it); at home as the sense line.
    publish: message => deliverSenseLine({ homeShown: () => { const { pet } = needs(); return !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized(); },
      hold: (id, text) => unbound?.holdLine(id, text).held === true,
      sendCompanion: (line, held) => { const { pet } = needs(); if (!pet || pet.isDestroyed()) return false; pet.webContents.send('desk:sense-line', held ? { ...line, held: true } : line); return true; },
      shownOut: id => { turn.done(true, { id, shown: true }); } }, message),
    speechStyle: id => { const { pet } = needs(); if (pet && !pet.isDestroyed()) beginInitiativeSpeech(pet.webContents.id, id); },
    archive: async (message, current, owner) => { await needs().companion.memory.appendInitiative(needs().companion.ownerScope(owner), // I-209 step 2: into the memory of the one whose turn it was
      { id: message.id, text: message.text, at: message.origin.at, origin: message.origin }, () => current() && !needs().exiting);
      broadcast('desk:vision-initiative-delivered', message); broadcast('desk:memory-changed', undefined); },
  });
  return turn;
}
