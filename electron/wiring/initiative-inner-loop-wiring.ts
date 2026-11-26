// 主动's wiring, her speaking first (split from electron/wiring/initiative-wiring.ts, docs/claude/2026-11-17-split-initiative-memory-wiring.md):
// L1 the inner loop (with the opening choice its speech cues go through), 松绑 her urge, and R20 offers (off: PROACTIVE_TASK_OFFERS).
// The statements are the ones wireInitiative had, in its order; wireInitiative calls wireInitiativeInnerLoop after it registered 主动's
// stores with the data map, and hands initR20ProactiveOffers on as a ready-chain step (initiative.provides; startMemory runs it).
// No module-level side effects: nothing here runs on import.
import { app } from 'electron';
import path from 'node:path';
import { INNER_LOOP_PROFILE_QUERY } from '../../shared/initiative';
import { cardLanguageOf, compileCharacterPersona, personalizeLanguageContext } from '../../shared/cards';
import { buildR20OfferPrompt, createInnerLoopHost, openingBudget, R20ProactiveOffers } from '../initiative';
import { createImpulseHost } from '../initiative/impulse/wiring';
import { chatAvailability, streamClaude } from '../brain';
import { combineTellPorts } from '../memory';
import { ambientContextText } from '../senses';
import { memoryProviderScope } from '../foundation/memory-provider-scope';
import { PROFILE_FOLDER } from '../profile';
import { diaryWriter, upcoming, userProfileContext, userProfiles } from './memory-wiring';
import { ambientAudio, ambientStore, audioReading, userActivity, userInputUntil, visionGeneration } from './senses-wiring';
import { unbound, unboundNoticedPrompt } from './unbound-wiring';
import { broadcast, windows } from './shell-wiring';
import { proactiveSpeechGate, type InitiativeNeeds } from './initiative-wiring';
import { selfLook } from './initiative-look-wiring';
import { proactiveChatFor } from './proactive-chat-wiring';
import { give, keepsake, rps, specialDay } from './initiative-together-wiring';
import { herHereNow } from './stage-wiring'; // I-174: shown or only covered
import { moments } from './initiative-moments-wiring';

/** R20 round 1: a task is offered only when the user asks in chat; Claude-generated proactive offers stay off. */
const PROACTIVE_TASK_OFFERS = false;
// ---- state other parts read (re-exported by initiative-wiring.ts; live bindings) ----
export let innerLoopHost!: ReturnType<typeof createInnerLoopHost>;
export let impulse!: ReturnType<typeof createImpulseHost>;
export let r20ProactiveOffers: R20ProactiveOffers | null = null;
let innerProfileLease: string | null = null;

// Set by its wire function (called by wireInitiative while electron/main.ts is evaluated, before anything below runs).
let needs!: InitiativeNeeds;

/** R20: an offer may be shown now (off while PROACTIVE_TASK_OFFERS is false). */
function r20OfferPresentable(): boolean {
  return PROACTIVE_TASK_OFFERS && !needs.exiting && !!needs.store && needs.store.current.provider.kind === 'claude' && !!needs.companion
    && !!needs.pet && !needs.pet.isDestroyed() && needs.pet.isVisible() && !needs.pet.isMinimized() && !!needs.petReply
    && !needs.petWindowDrag?.active && needs.companion.mood.get().expressions
    && needs.companion.mood.get().snapshot.phase === 'idle'
    && !needs.replySpeechBusy() && needs.ambientSpeakingOwners.size === 0 && !ambientAudio?.getState().active && !needs.readingActive()
    && ![...needs.pending.values()].some(task => task.kind === 'chat');
}

/** wireInitiative calls this once, after the data map registration: the inner loop and her urge; R20 offers are made later (ready chain). */
export function wireInitiativeInnerLoop(given: InitiativeNeeds): { initR20ProactiveOffers(): void } {
  needs = given;
  const { speechScope, companionCanExpress, herOnScreen, replySurface, readingActive, currentAmbientSession, agentInterconnected, openCodexTaskConfirmation } = given;
  // Inner loop (L1, docs/claude/2026-11-02-inner-loop.md): motion cues, and the speech cues the opening choice gives it (I-020 #10); shares the gate,
  // the MoodState speech quota and the visual-initiative bubble/presentation/archive/readout path.
  innerLoopHost = createInnerLoopHost({
    gate: proactiveSpeechGate,
    userActivity: () => userActivity?.view() ?? null, // I-006: 【此刻】's one line and a lean toward 这次不说
    interconnected: agentInterconnected, // I-137: 【此刻】 also says whether 三方互通 is on (a fact only)
    setting: () => !!needs.store && needs.store.current.innerLoop !== false,
    talk: () => needs.store?.current.proactiveTalk, // 她主动找你说话 (少一点 / 适中 / 多一点): only the call rhythm; the card's speech caps are untouched
    expressions: () => !!needs.companion && needs.companion.mood.get().expressions,
    // Background work the user did not ask for waits while Claude is unavailable (electron/brain/chat-availability.ts).
    canExpress: () => companionCanExpress() && chatAvailability.isAvailable(),
    current: () => !!needs.companion && !!needs.store && herOnScreen()
      && !needs.petWindowDrag?.active && Date.now() >= userInputUntil && needs.companion.mood.get().snapshot.phase === 'idle'
      && ![...needs.pending.values()].some(task => task.kind === 'chat'),
    holds: () => !!needs.companion && !!needs.store && herHereNow() && ![...needs.pending.values()].some(task => task.kind === 'chat'), // I-174 item 3: a line out ends only for a clear intent
    needReady: id => needs.companion.herNeeds.hasSpeechChance(id), // I-020 #10: look, don't take (the opening choice weighs her small need)
    leans: id => impulse.leans(id), // 松绑: each "what to say" candidate leans on her urge (the same hormones and mood values)
    give: { peek: id => give.host.peek(id), promptLine: id => give.host.promptLine(id), delivered: (id, claim, text) => give.host.delivered(id, claim, text) }, // I-086 递给你点东西
    keepsake: combineTellPorts(keepsake.port(() => !!needs.store && needs.store.current.innerLoop !== false), specialDay.port(() => !!needs.store && needs.store.current.innerLoop !== false)), // I-050 第 2 步: "给你留点东西" is one more candidate; I-059: the special day's own line is one more 'tell'
    characterId: () => needs.companion.mood.get().characterId,
    gateScope: () => `${speechScope()}:${needs.companion.mood.get().token}`,
    parameters: () => needs.companion.mood.get().parameters,
    fatiguePhase: () => needs.companion.mood.get().fatigue?.phase,
    context: {
      persona: () => compileCharacterPersona(needs.characterCards.getActive()),
      language: () => personalizeLanguageContext(needs.personalizeLanguage?.effectiveProfile(needs.characterCards.getActive().id)),
      cardLanguage: () => cardLanguageOf(needs.characterCards.getActive()), // 2026-11-21: an English card's own words are English
      mood: () => needs.companion.mood.chatContext(),
      recentChat: proactiveChatFor(() => needs), // I-178: what you two talked about lately (her own opening, a touch, a gift, a rest reminder: every speech opportunity)
      lastInteractionAt: () => needs.companion.mood.get().snapshot.lastInteractionAt,
      unanswered: () => needs.companion.mood.unansweredSpeech(), // I-039: one line in her prompt, not a rule
      expression: (id, available) => impulse.expression(id, available), recentEvent: () => impulse.recentEvent(), duePlan: id => impulse.duePlan(id), /* P-001 step 3 */ // 松绑: a real topic, a rare slip, not the same opening
      look: () => selfLook.openingLine(), // I-085 step 2: what she saw just before speaking first, one line
      touch: id => needs.touchBrain.promptLine(id), // I-136: her answer to a touch: what the user did and what she showed
      noticed: id => unboundNoticedPrompt(id), // Unbound step 4: or what she noticed the user do while out (the same speech-cue slot as a touch)
      userState: () => needs.companion.userState.innerLoopContext(needs.companion.mood.get().characterId) || needs.companion.dayRead.innerLoopContext(), // I-089 item 5: her day's read when she has no fresher judgment
      pose: () => needs.companion.pose.innerLoopLine(), // P1 第二阶段: one abstract line while local camera sensing runs ('' otherwise)
      hearing: () => needs.herState.innerLoopLine(readingActive() || !!ambientAudio?.getState().active), activity: () => needs.companion.herLife.view(needs.companion.mood.get().characterId), // I-017
      // 她也会需要你: the one speech chance for a small feeling she has now (read only on a speech opportunity that may speak).
      need: () => needs.companion.herNeeds.speechChance(needs.companion.mood.get().characterId),
      // F6 "更真实的情绪": the current card's switch (its line replaces the inner loop's "想用户的时候…" line).
      realer: () => needs.characterCards.getActive().realerEmotions === true && !needs.safety.yielding(), // I-117 decision 4: it yields while a danger sign or "no energy" is fresh
      profileEnabled: () => !!userProfiles?.view().enabled,
      profilePoints: () => {
        if (innerProfileLease) userProfileContext?.release(innerProfileLease);
        innerProfileLease = userProfileContext?.begin(INNER_LOOP_PROFILE_QUERY, () => { innerLoopHost.loop.cancel(); return true; }) ?? null;
        return userProfileContext?.read(innerProfileLease) ?? '';
      },
      // L3 diary points: '' while recording is off or for another scope; read only while the profile is on.
      diaryPoints: () => diaryWriter?.recentDiaryPoints(needs.companion.currentScope(), Date.now(), 300) ?? '',
      audioReading: () => readingActive() || !!ambientAudio?.getState().active,
      ambientText: () => {
        const session = currentAmbientSession();
        return session ? ambientContextText(ambientStore.context(session.scope, { sessionId: session.sessionId, now: Date.now() })) : '';
      },
    },
    realize: (claim, kind, id) => needs.companion.mood.event({ type: 'attention', id, kind, claimed: { id: claim.id, kind: claim.kind, at: claim.at } }, claim.characterId),
    // I-010: an opportunity that ended unspoken gives its interaction-budget spend back too (once per cue id).
    releaseSpeech: claim => { needs.companion.mood.releaseSpeech({ id: claim.id, at: claim.at }, claim.characterId); needs.companion.budget.refund(claim.characterId, claim.id); },
    offer: message => { const { pet } = needs; /* read when called */ if (!pet || pet.isDestroyed()) return false; pet.webContents.send('desk:vision-initiative', { type: 'offer', message, ...unbound?.holdVisionLine(message), ...(userActivity?.presence().presence === 'meeting' ? { silent: true as const } : {}) }); },
    cancelOffer: id => broadcast('desk:vision-initiative', { type: 'cancel', id }),
    surface: replySurface,
    presentationIdentity: () => { try { return `${speechScope()}:${visionGeneration}`; } catch { return ''; } },
    archive: async (message, owner) => {
      keepsake.noteDelivered(message.id); specialDay.noteDelivered(message.id); // I-050 第 2 步: the light line about a keepsake was really shown; I-059: or her special-day line
      impulse.spoke(message.text, message.id); // 松绑: she spoke first; your answer (or none) comes back to her mood (only how it opens is kept, in memory)
      const { companion } = needs; // read when called
      const scope = companion.ownerScope(owner), acceptedScope = speechScope(); // I-209 step 2: into the memory of the one whose line it was
      await companion.memory.appendInitiative(scope, { id: message.id, text: message.text, at: message.origin.at, origin: message.origin });
      try { if (acceptedScope !== speechScope()) return; } catch { return; }
      broadcast('desk:vision-initiative-delivered', message);
      broadcast('desk:memory-changed', undefined);
    },
    developerMode: () => !!needs.companion?.mood.isDeveloperMode(),
    diagnosticsFile: () => needs.store ? path.join(needs.store.directory, 'dev', 'inner-loop.jsonl') : null,
    restReminderFile: () => needs.store ? path.join(needs.store.directory, 'inner-loop-state.json') : null,
    diagnosticsChanged: () => broadcast('desk:inner-loop', innerLoopHost.view()),
    settled: () => { if (innerProfileLease) userProfileContext?.release(innerProfileLease); innerProfileLease = null; },
    report: chatAvailability,
    journal: (entry, characterId) => { needs.appJournal.innerLoop(entry, characterId); if (entry.decision === 'speak' && entry.result === 'delivered') needs.moodJudge.host.note({ kind: 'her-line', characterId }); },
    // 她自己的生活: "换件事做" inside the motion opportunity's existing call (electron/stage/her-life/host.ts re-checks its own gates).
    herLife: { offer: id => needs.companion.herLifeOffer(id, companionCanExpress()), switch: (id, activity) => needs.companion.herLifeSwitch(id, activity, companionCanExpress()) },
    // G1 猜拳: "邀请玩猜拳" inside the speech opportunity's existing call; the buttons open only after her line was shown.
    play: { eligible: (id, quiet) => rps.host.inviteEligible(id, quiet), invited: id => rps.host.invited(id) },
    // I-188 她认出的时刻: the moment a cue carries (focus 'moment'), its line, and how it ended (electron/wiring/initiative-moments-wiring.ts).
    moment: { current: id => moments?.current(id) ?? null, promptLine: id => moments?.promptLine(id) ?? '', done: (claimId, delivered) => moments?.done(claimId, delivered) },
    // I-010 互动余额: each speech opportunity first asks the budget for room; the one who speaks spends (electron/brain/opening-host.ts).
    budget: openingBudget(() => needs.companion?.budget ?? null),
    // I-066 你现在方便吗 (electron/brain/opening-host.ts): 'no' holds what she wanted to say; on return she brings it up, or may greet.
    presence: { view: () => userActivity?.presence() ?? null, look: () => userActivity?.askLook() ?? false, welcome: () => !!needs.companion?.mood.welcomeAttention() },
    speechCueJournal: entry => { needs.appJournal.record({ type: 'speech-cue', ...entry }); }, // I-066: closed reasons only, never words
  });
  // 松绑 (electron/initiative/impulse/): her urge from her hormones and mood values; on the one-second tick she may think of you and reach out (talk, a glance,
  // humming), within the hard floor and the soft interaction balance. One 'initiative' journal row per reach (closed values only).
  impulse = createImpulseHost({ mood: () => needs.companion?.mood ?? null, budget: () => needs.companion?.budget ?? null, opening: () => innerLoopHost.opening,
    herLife: () => { const { companion } = needs; /* read when called */ return companion ? { offer: (id, canExpress) => companion.herLifeOffer(id, canExpress), switchTo: (id, activity, canExpress) => companion.herLifeSwitch(id, activity, canExpress) } : null; },
    quiet: () => innerLoopHost.loop.quietNow(), presence: () => userActivity?.presence() ?? null,
    enabled: () => !!needs.store && needs.store.current.innerLoop !== false, canExpress: () => companionCanExpress() && chatAvailability.isAvailable(), // hidden, typing, a chat or her speech running: not now
    talk: () => needs.store?.current.proactiveTalk, journal: row => { needs.appJournal.record({ type: 'initiative', ...row }); },
    lookFirst: () => selfLook.beforeSpeaking(), // I-085 step 2: when she has decided to speak first, one look at you first (only with 「发图片」 on and free), then the opportunity
    cardSlips: id => { const card = needs.characterCards?.getActive(); return card && card.id === id ? card.slips : undefined; }, // the active card's slips switch (shared/cards/card-slips.ts)
    plan: () => upcoming?.ask }); // P-001 step 3: a plan whose time has come is one of her topics
  /** Ready-chain step (inside startMemory, after the text memorials): R20 offers (off: PROACTIVE_TASK_OFFERS). */
  function initR20ProactiveOffers(): void {
    r20ProactiveOffers = new R20ProactiveOffers({
      gate: proactiveSpeechGate,
      context: () => { try {
        const { companion, characterCards, store } = needs; // read when called
        const scope = companion.currentScope();
        if (scope.characterId !== characterCards.getActive().id || scope.providerScope !== memoryProviderScope(store.current.provider)) return null;
        return { identity:speechScope(), gateScope:speechScope()+':'+companion.mood.get().token,
          persona:store.current.persona, mood:companion.mood.chatContext(), language:characterCards.getActive().language==='en'?'en':'zh-CN' };
      } catch { return null; } },
      eligible: () => r20OfferPresentable() && Date.now() >= userInputUntil,
      presentable: r20OfferPresentable,
      owner: () => needs.pet && !needs.pet.isDestroyed() ? needs.pet.webContents.id : null,
      humanSender: sender => windows().some(win => !win.isDestroyed() && win.webContents.id === sender),
      surface: () => needs.petReply,
      generate: async (input, signal) => {
        const { store } = needs; // read when called
        if (!PROACTIVE_TASK_OFFERS || store.current.provider.kind !== 'claude') throw Error('当前连接不提供代办提议。');
        const settings = structuredClone(store.current); let raw = '';
        await streamClaude({ kind:'chat', model:settings.provider.model,
          workingDirectory:path.join(store.directory,'chat'), writable:false, prompt:buildR20OfferPrompt(input),
          imageDataUrls:[], imageTemporaryRoot:path.join(app.getPath('temp'),PROFILE_FOLDER,'chat') }, signal,
          (type, text) => { if (type === 'delta') { if (raw.length + text.length > 4000) throw Error('主动提议超出文本上限。'); raw += text; } });
        return raw;
      },
      event: event => broadcast('desk:r20-proactive-offer',event),
      archive: async (offer, at, current) => {
        const { companion } = needs; // read when called
        const identity = speechScope(), scope = companion.currentScope();
        await companion.memory.appendInitiative(scope,{id:offer.id,text:offer.question,at,
          origin:{kind:'proactive',id:offer.id,at,sources:['text'],labels:['本轮对话的帮助提议']}},
          () => current() && !needs.exiting && identity === speechScope());
        broadcast('desk:memory-changed',undefined);
      },
      openTaskConfirmation: openCodexTaskConfirmation,
    });
  }
  return { initR20ProactiveOffers };
}
