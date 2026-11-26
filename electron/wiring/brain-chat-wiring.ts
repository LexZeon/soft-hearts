// 大脑's chat turn (wiring rewrite step 4h, docs/claude/2026-11-17-wiring-step-4h.md): one typed message from a window to her reply, and
// its cancel. Moved from electron/main.ts's registerIPC; the statements are the ones main.ts had. electron/wiring/brain-wiring.ts's
// register calls registerChatTurn inside the agent channel's recorder, where registerIPC registered them.
// - The reply runs as one task (launchTask, brain-wiring.ts): one chat at a time; a stopped reply finishes 'stopped', never 'complete'.
// - Her Claude Code chat process gets a chat task: kind 'chat', writable false, no tools (electron/brain/claude-session.ts refuses anything
//   else; electron/brain/claude.ts starts it without tools). A result is written (voice history, the reply's voice and emoji, R20, the
//   vision support) only while its scope, its provider and its task are still current.
// - What the turn reads from the rest of the app: the other parts' live bindings (imported from their wiring files) and BrainNeeds
//   (`const { … } = needs; // read when called`, at the start of each message).
// No module-level side effects: nothing here runs on import.
import path from 'node:path';
import { app } from 'electron';
import { scanBreathRequest } from '../../shared/actions';
import { scanFramingRequest } from '../../shared/stage';
import { characterTtsConfig, scanStopReadoutRequest } from '../../shared/voice';
import type { CompanionCommandIntentInput } from '../../shared/settings';
import { lookOfferTarget } from '../../shared/senses';
import { lookOfferFor, perceptionTurnLine, perceptionTurnState } from '../../shared/brain/perception-rule';
import { PROFILE_FOLDER } from '../profile';
import { DraftOnlyReplyError, admitHandedLine, buildCodexChatPrompt, chatAvailability, interconnectTurnLine, sharedSight, stageTurn, textFirstTurn, type OnceLine } from '../brain';
import { stageIds } from './brain-stage-chat-wiring';
import { memoryProviderScope, type CompanionTurn } from '../brain/companion';
import { longChatMessages } from '../brain/long-chat/host';
import { classifyCompanionCommand, createCommandDialogueTurn, formatCompanionCommandReceipt, validateChatRequest, type CompanionCommandTicket } from '../settings';
import { UserProfileReplyCollector, joinHintLines, textMemorialReplyContext, type TextMemorialHumanTurn, type TextMemorialTurn, type UserProfileAcceptance } from '../memory';
import { NO_LISTEN_ASK, ambientContextText, faceTurnFor, type VisualSelfLease } from '../senses';
import { composeSpeechConfig, freezeTurnSpeechStyle } from '../mood';
import { characterSpeechPersona } from '../voice';
import type { PartIpc } from './ipc-wiring';
import { flushSettled } from './quiet-wiring';
import { broadcast, ownerFor, send, windows } from './shell-wiring';
import { gateEnabled } from './channel-gates-wiring';
import { speechBeatsFor } from '../brain/speech-beats/host'; // 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md)
import { ambientAudio, ambientComments, ambientStore, faceCheck, listenTogether, seeAndSay, setVisionStatus, setVisionSupported, watchTogether } from './senses-wiring';
import { moodJudge, reactions } from './mood-wiring';
import { hands, herFolder, momentsChatTurn, momentsReplyDone, proactiveSpeechGate, r20ProactiveOffers, rps, selfLook, senseRouter, specialDay, takeMeThere } from './initiative-wiring';
import { acceptProfileMessage, currentProfileMessage, textInvitationMemory, textMemorialHost, upcoming, userProfileContext, userProfileManagement, userProfileSource,
  userProfiles } from './memory-wiring';
import { milestoneReplyDone, milestoneTurnLine } from './card-milestone-wiring';
import { objectReplyDone, objectTurnText } from './card-objects-wiring';
import { singleEmojiContext, singleEmojiCues } from './stage-wiring';
import { unboundNoticedLine, unboundOutsideTurnLine, unboundPlaceMarks } from './unbound-wiring';
import { LONG_CHAT, chatIncidents, chatSettings, claudeChat, companion, i139Chat, launchTask, longChatNote, moduleRouter, pauseTalk, pending, replyLatency,
  replyRhythm, type BrainNeeds } from './brain-wiring';

/** The chat turn ('chat') and its cancel ('cancel'); `needs` is 大脑's (brain-wiring.ts). */
export function registerChatTurn(ipc: PartIpc, needs: BrainNeeds): void {
  const { scopedHost } = ipc;
  scopedHost(
    "chat",
    (sender, value) => {
      const { lookAttachments, lookTurns, revokeVoice, noteVisionUserActivity, journalCharacterId, cameraLookJournal, media, store, completedReplySpeech, companionCommandContext,
        companionCommands, agentInterconnected, roughForTurn, lookState, appJournal, lookScope, herState, turnAwareness, speechScope, replySpeechStyles, characterCards,
        completedFatigueFeeling, personalizeLanguage, chatContextData, voiceHost, visionSupport, publishVisionState, suspendAmbientSpeech, cancelReplyStyle, visualSelfRuntime,
        refreshVisualSelfContext, speechRuntime, clearReplySpeech } = needs; // read when called
      const request = validateChatRequest(value);
      const handed = admitHandedLine(request.line); // 2026-11-23: a full-screen line goes out only while the box still holds it open (refused once taken back); sent below, once accepted
      // 关掉之后的旧帧: a frame the host took for this message is dropped once its sharing was turned off (or off and on again) or the
      // vision context was cleared; the turn then goes out as text without a picture. Asked again right before Claude gets it.
      const turnFrames = lookAttachments.admit(request.attachments); request.attachments = turnFrames.current();
      // I-209 step 2: whose turn this is, read once here and carried to her archive; step 3: the one you clicked on stage, else the desktop companion.
      const currentId = (() => { try { return companion.currentScope().characterId; } catch { return undefined; } })(), owner = stageTurn.owner(request.line, currentId), ownerCard = () => { try { return characterCards.getCard(owner!); } catch { return characterCards.getActive(); } };
      // What her turn is accepted under (electron/brain/turn-owner ownerSpeechScope): the desktop companion's is the voice's speechScope, as before; someone else's on stage her own ('' once she left).
      const ownerScopeNow = () => !owner || owner === companion.currentScope().characterId ? speechScope() : (() => { try { return companion.speechScopeOf(owner); } catch { return ''; } })();
      const moodNow = () => (owner && companion.moodOf?.(owner) || companion.mood.get()).snapshot;
      lookTurns.userTurn(); // Any message answers her "要我凑近看看吗", also a local control that skips sharedAttachments (Codex T-112 round 030).
      // A local readout control is still a trusted human chat turn, but must not
      // inherit ordinary new-chat voice/capture cleanup or media attachment work.
      const readoutControl = turnFrames.asked().length === 0 // I-036: 「发图片」's small frame does not count
        && (scanStopReadoutRequest(request.messages.at(-1)?.content) !== 'none'
          || scanFramingRequest(request.messages.at(-1)?.content) !== 'none'
          || scanBreathRequest(request.messages.at(-1)?.content).kind !== 'none');
      let commandTicket: CompanionCommandTicket | null = null;
      let commandIntent: CompanionCommandIntentInput | null = null;
      let commandAdmissionFailed = false;
      let profileAcceptance: UserProfileAcceptance | null = null;
      let profileCollector: UserProfileReplyCollector | null = null;
      let profileSourceEligible = false;
      let visualSelfLease: VisualSelfLease | null = null;
      let memorialInput: TextMemorialHumanTurn | null = null;
      let memorialIdentity = '';
      let memorialTurn: TextMemorialTurn | null = null;
      if (!readoutControl) { singleEmojiCues?.invalidate(); r20ProactiveOffers?.cancel(); revokeVoice('stop-generation'); noteVisionUserActivity('message'); }
      // G1 猜拳: asking to play gets one private context line (she agrees or puts it off); any other message ends an open game.
      if (!readoutControl) moduleRouter.userTurn(request.id, request.messages.at(-1)?.content); // I-023: haiku in the background, never awaited here
      // F7 停停说说: haiku in the background, never awaited; the line is her earlier reply's unsaid part (only when the user cut in). Off: null, nothing runs.
      const pauseBackground = readoutControl ? null : pauseTalk.userTurn(request.id, request.messages.at(-1)?.content, request.pauseCut, () => owner ?? journalCharacterId() ?? '');
      if (!readoutControl) moodJudge.host.userText(request.id, request.messages.at(-1)?.content); // I-027: kept (cut short) for the next batch, only while the switch is on
      if (!readoutControl) reactions.userTurn(request.id, request.messages.at(-1)?.content); // I-037: haiku in the background (after startDelayMs), only while the switch is on
      if (!readoutControl) { const sensed = senseRouter.userTurn(request.id, request.messages.at(-1)?.content, reactions.host.asking(request.id), turnFrames.asked(), request.messages); // I-040: rides on that haiku call
        cameraLookJournal.turn(request.id, { frames: media.sharesCameraFrames(), via: turnFrames.cameraVia(), small: turnFrames.cameraGlance(), held: media.state.cameraHeld === true, screenSharing: media.state.screenSharing === true, miss: turnFrames.cameraMiss(), text: request.messages.at(-1)?.content }, sensed); // I-084; 2026-11-21: why an asked-for picture did not come
      } else senseRouter.cancel();
      const rpsContext = readoutControl ? null : rps.host.chatTurn(request.id, request.messages.at(-1)?.content);
      const settings = stageTurn.settings(structuredClone(store.current), owner, currentId, id => characterCards.getCard(id)), basePersona = settings.persona; // I-209 step 3: her own card
      launchTask(request.id, "chat", sender, async (signal, emit) => {
        const task = pending.get(request.id); if (task) task.characterId = owner; // I-209 step 2: a switch away from someone else stops only hers (set before anything awaits)
        if (!readoutControl) replyLatency.begin(request.id, settings.provider.kind, request.sentAt, { pauseTalk: settings.voice.pauseTalk === true, carried: !!pauseBackground, ...(request.waits ? { waits: request.waits } : {}), ...(owner !== currentId ? { characterId: owner } : {}) }); // 2026-11-22: where the window spent its send
        await flushSettled(); // 2026-11-25: you cut in; a change that waited for her to finish (a new connection) goes first
        let turn: CompanionTurn | undefined;
        let acceptedSpeechScope: string | undefined;
        let acceptedEmojiContext: string | undefined;
        let voiceContextBody = '';
        let speechCommitFence:object|null=null;
        let completedSpeechText = '';
        let speechTextTooLong = false;
        let profileContextLease: string | null = null;
        // 边说边演: her markers leave the stream before anything else sees it (also with the switch off); beats go to the windows only while it is on.
        const speechBeats = speechBeatsFor(store.directory), beatTurn = speechBeats.begin(gateEnabled('speechBeats'), event => send(sender, { id: request.id, kind: 'chat', type: 'beats', text: '', speechBeats: event }), true);
        try {
          const goTurn = takeMeThere.beginTurn(request.messages.at(-1)?.content);
          const settingTurn = chatSettings.beginTurn(request.messages.at(-1)?.content); // A new message makes older cards inert.
          const folderTurn = await herFolder.beginTurn(request.messages.at(-1)?.content), folderHint = folderTurn ? null : herFolder.beginHint(request.messages.at(-1)?.content), specialHint = specialDay.beginHint(request.messages.at(-1)?.content); // I-050: only a message about her folder, while it is on; otherwise null and nothing new. I-056: never turned on and asked to write or keep something: one optional line, a few times at most
          const relaxedTurn = i139Chat.relaxed(); const faceTurn = await faceTurnFor(faceCheck, turnFrames.asked().find(frame => frame.source === 'camera')?.dataUrl, i139Chat.stranger(relaxedTurn)); // I-135: a photo is checked on the spot (<= 1.5 s); no photo, no wait
          turn = await companion.begin(request.id, request.messages.at(-1)?.content ?? '', settings.persona, (type, text) => {
            if (type === 'delta') {
              beatTurn.shown(text); // 边说边演: the beats before these shown words go out first
              replyLatency.delta(request.id, text);
              pauseTalk.delta(request.id, text); // F7: the same visible text the windows get (kept only while the switch is on)
              reactions.firstChar(request.id); senseRouter.firstChar(request.id); // I-037 (and I-040's own judgment): without a ready warm haiku (or knobs.warmParallel off), the reaction judge starts after her first character
              if (speechCommitFence) completedReplySpeech.append(speechCommitFence, text); // R02: speak complete sentences while the rest streams
              if (!speechTextTooLong) {
                completedSpeechText = (completedSpeechText + text).slice(0, 6001);
                speechTextTooLong = completedSpeechText.length > 6000;
              }
              voiceContextBody += text;
              if (voiceContextBody.length > 16000) voiceContextBody = voiceContextBody.slice(0, 4000)
                + '\n[此前回复中段较长，语音上下文已省略]\n' + voiceContextBody.slice(-11000);
            }
            emit(type, text);
          }, {textMemorial:!!memorialInput, settingProposal: settingTurn, herFolder: folderTurn, herFolderHint: joinHintLines(folderHint?.line, specialHint?.line), speaker: faceTurn.visitor ? 'visitor' : undefined, characterId: owner}); // I-059: the special day's line rides in the same one-line hint slot
          if (faceTurn.visitor) { profileCollector?.cancel(); profileCollector = null; memorialInput = null; } // I-135: a visitor's words are not the user's facts
          if(memorialInput && textMemorialHost) {
            memorialTurn=textMemorialHost.accept(memorialInput,memorialIdentity);
            if(memorialTurn)turn.persona+=textMemorialReplyContext(await memorialTurn.result);
          } else if (!readoutControl) textMemorialHost?.cancel();
          if (commandAdmissionFailed) {
            turn.push('delta', '这条桌宠操作未能确认，请重新描述。');
            await turn.finish('complete'); return;
          }
          if (commandTicket && commandIntent) {
            signal.throwIfAborted();
            const intent = commandIntent, ticket = commandTicket;
            let commandFinished = false;
            const dialogue = createCommandDialogueTurn({ classify: classifyCompanionCommand,
              formatReceipt: formatCompanionCommandReceipt, signal,
              turn: { push: (type, text) => turn!.push(type, text), finish: async status => {
                commandFinished = true; await turn!.finish(status);
              } },
              isCurrent: () => pending.get(request.id)?.controller.signal === signal
                && companionCommandContext(sender) === intent.contextId,
              host: async candidate => {
                // The adapter's proposal cannot select or execute an action; only this private ticket can.
                const view = await companionCommands!.run(ticket);
                if (!view) throw new Error('这条操作已过期，没有重新执行。');
                if (candidate.kind === 'explicit') {
                  if (!view.receipt) throw new Error('尚未取得保存结果。');
                  return view.receipt;
                }
                return view.receipt ? { ...view, prompt: view.receipt.message } : view;
              } });
            const outcome = await dialogue.handle(intent);
            if (outcome === 'stale' && !commandFinished) await turn.finish('stopped');
            return;
          }
          await ambientComments?.acceptUserTurn(request.id, request.messages.at(-1)?.content ?? '');
          proactiveSpeechGate.cancel('user');
          const audioSession = ambientAudio?.currentSession();
          if (audioSession) turn.persona += ambientContextText(ambientStore.context(audioSession.scope, { sessionId: audioSession.sessionId }));
          const listenAsk = listenTogether?.askTurn(request.messages.at(-1)?.content, companion?.conversationId ?? '', media.state.screenSharing === true) ?? NO_LISTEN_ASK; // I-016: a question about what she heard brings its note (local, no await)
          turn.persona += listenAsk.block; // I-021: checked again where the message is written (listenAsk.current): what the user deleted meanwhile is not sent
          if (rpsContext) turn.persona += '\n\n' + rpsContext;
          const planAsk = readoutControl || typeof upcoming === 'undefined' ? null : upcoming?.ask?.askTurn(request.messages.at(-1)?.content ?? ''); // P-001 step 2: one line when a plan's time has come (the same turn's private context)
          if (planAsk) turn.persona += '\n\n' + planAsk.line;
          const reminderLine = readoutControl || typeof momentsChatTurn !== 'function' ? '' : momentsChatTurn(request.messages.at(-1)?.content); if (reminderLine) turn.persona += '\n\n' + reminderLine; // I-188 #13: "提醒我…" noted / "不用提醒了" cancelled, told to her as information (the typeof guard keeps tests that lift this turn out working)
          const milestoneLine = readoutControl || typeof milestoneTurnLine !== 'function' ? '' : await milestoneTurnLine(ownerCard(), companion.relationship); if (milestoneLine) turn.persona += '\n\n' + milestoneLine; // I-207: a card's milestone, one information line ('' for a card without one)
          const objectText = readoutControl || typeof objectTurnText !== 'function' ? '' : await objectTurnText(ownerCard(), companion.relationship, request.messages.at(-1)?.content); if (objectText) turn.persona += '\n\n' + objectText; // I-208: her object: one line, plus what the words touch
          if (pauseBackground) turn.persona += '\n\n' + pauseBackground; // F7 停停说说: this turn only; whether she mentions it is hers to decide
          // 识图第 1 步: what she can perceive on this turn, one line (shared/brain/perception-rule.ts); sharing on and no frame: she may offer to look.
          if (faceTurn.line) turn.persona += '\n\n' + faceTurn.line; // I-135: clearly not the user: her one private line (also kept when the frames are composed again)
          const interconnectLine = interconnectTurnLine(agentInterconnected, relaxedTurn); turn.persona += '\n\n' + interconnectLine; // I-137: one fact line every turn: is 三方互通 on (I-139: said once per Claude process, onceLines below)
          if (beatTurn.on) turn.persona += '\n\n' + beatTurn.sentence(); // 边说边演: only while the switch is on (off: not one character more); before sightBase, so a recomposed persona keeps it
          const rough = roughForTurn(); // 屏幕只读大概: roughly what the user does, from memory (no wait)
          request.attachments = turnFrames.current(); // again: nothing waits between here and the call that hands them to Claude
          const selfSeen = selfLook.hint(request.messages.at(-1)?.content, request.attachments, turnFrames.cameraGlance()), firstTurn = textFirstTurn({ textFirst: lookAttachments.textFirst, watching: lookAttachments.watching, screenHeld: lookTurns.refusedIn(lookState()), // I-085 第 3 步: text instead of a picture
            sight: sharedSight(watchTogether?.session, turn.scope.characterId, currentId, stageIds()), /* I-209 step 4: one description for everyone on stage */ now: Date.now(), frames: turnFrames, cameraOn: media.sharesCameraFrames() && !!media.state.cameraOwner, cameraHeld: media.state.cameraHeld === true, selfSeen });
          if (firstTurn.row) appJournal.record({ type: 'look-turn', characterId: turn.scope.characterId, ...firstTurn.row }); // closed words only
          selfLook.afterMessage(request.messages.at(-1)?.content, request.attachments, turnFrames.cameraGlance(), lookAttachments.textFirst); // I-085 第 5 节: no look for 10 minutes → one in the background for her next turn (this one does not wait)
          const sight = perceptionTurnState(media.state, request.attachments, request.messages.at(-1)?.content, { rough, cameraGlance: turnFrames.cameraGlance(), screenSmall: turnFrames.screenGlance(), ...firstTurn.glance }), sightScope = lookScope();
          const sightBase = turn.persona, hearing = herState.chatTurn(turn.persona, request.messages.at(-1)?.content); // I-017: and what she hears, does, was just done to her
          const aware = turnAwareness.line({ text: request.messages.at(-1)?.content, listening: !!hearing?.hearing.source || !!hearing?.hearing.transcript, screenSharing: media.state.screenSharing === true, scope: sightScope }) + senseRouter.hint(request.id, !!listenAsk.block) + selfSeen + unboundOutsideTurnLine() + unboundNoticedLine(i139Chat.cardLanguage(), owner) + (seeAndSay?.line() ?? ''); // I-159 B: out in Unbound, the senses are all on (one fact line); I-040: one sentence while a sense is on; Unbound step 4: what she noticed of you while out (facts only)
          turn.persona += '\n\n' + perceptionTurnLine(sight, hearing) + (relaxedTurn && aware ? '\n' : '') + aware;
          const sightAgain = (left: typeof request.attachments) => sightBase + '\n\n' + perceptionTurnLine(perceptionTurnState(media.state, left, request.messages.at(-1)?.content, { rough, cameraGlance: turnFrames.cameraGlance(), screenSmall: turnFrames.screenGlance(), ...firstTurn.glance }), hearing) + (relaxedTurn && aware ? '\n' : '') + aware;
          signal.throwIfAborted();
          acceptedSpeechScope = ownerScopeNow();
          acceptedEmojiContext = singleEmojiContext();
          replySpeechStyles.begin(sender, request.id, acceptedSpeechScope, owner !== currentId ? owner : undefined); // I-209 stage voice: her reading, her voice
          if(settings.provider.kind==='claude'){speechCommitFence=completedReplySpeech.beginCommit(sender,request.id,acceptedSpeechScope,{mode:settings.voice.firstChunk==='comma'?'comma':'sentence',voice:settings.tts?.provider}); // I-029: this reply's first piece, frozen at acceptance
            const fence = speechCommitFence; beatTurn.onHold = () => completedReplySpeech.breakHere(fence); // 2026-11-23: words before a kiss / hug are read before it
            const cutScope = turn.scope; beatTurn.onCut = (cut, event, text) => speechBeats.fileCut(cutScope, request.id, cut, event, text); // I-203: an interrupted kiss / hug: its cut record (archived once, whole) and her one immediate turn's facts
            // R02: freeze this turn's voice now (persona + current mood) so the first sentence can speak during streaming.
            const card=ownerCard();freezeTurnSpeechStyle(replySpeechStyles,{owner:sender,replyId:request.id,scope:acceptedSpeechScope,mood:moodNow(),persona:characterSpeechPersona(card),
              fatigue:completedFatigueFeeling(acceptedSpeechScope,card.id),config:characterTtsConfig(store.current, card)});
            // F7: this reply's pace, from the same frozen mood and fatigue as its voice; the first bubble is never delayed.
            replyRhythm.freeze(()=>({replyId:request.id,characterId:card.id,snapshot:moodNow(),fatigue:completedFatigueFeeling(acceptedSpeechScope??'',card.id)?.phase??null,
              userText:request.messages.at(-1)?.content??'',userState:companion.userState.current(card.id)?.state??null,developerMode:companion.mood.isDeveloperMode()}));}
          settings.persona = turn.persona;
          const profileOwner = pending.get(request.id);
          if (profileSourceEligible && currentProfileMessage(request.profile) && profileOwner?.controller.signal === signal) profileContextLease = userProfileContext?.begin(
            request.messages.at(-1)?.content ?? '', () => {
              if (pending.get(request.id)?.controller !== profileOwner.controller) return false;
              profileOwner.controller.abort(); return profileOwner.controller.signal.aborted;
            }, request.messages, { memes: turn.relationshipMemes !== false }) ?? null;
          emit("status", "正在连接模型…");
          if (settings.provider.kind === "claude") {
            const languageProfile = personalizeLanguage?.effectiveProfile(turn.scope.characterId);
            const chatMessages = !stageTurn.ownHistory(LONG_CHAT.enabled, owner, currentId, companion.onStage?.bind(companion)) ? request.messages : longChatMessages({ knobs: LONG_CHAT, archives: [speechBeats.longChatArchive(companion.memory, beatTurn.on), textInvitationMemory], scope: turn.scope, turnId: request.id, labels: i139Chat.labels(), language: i139Chat.cardLanguage(), current: { content: request.messages.at(-1)?.content ?? '', createdAt: () => companion.memory.turnStartedAt(turn!.scope, request.id) } }) ?? (owner !== currentId ? request.messages.slice(-1) : request.messages); // I-134: her archive's window (off or unreadable: the renderer's 24); I-209 step 3: hers, never the mixed list
            const prompt = buildCodexChatPrompt(settings.persona, chatMessages, undefined, languageProfile);
            await (seeAndSay ? seeAndSay.stream(claudeChat) : claudeChat.stream.bind(claudeChat))( // I-166: her closer look continues this same reply (one bubble, archived once)
            {
              kind: "chat",
              model: settings.provider.model,
              workingDirectory: path.join(store.directory, "chat"),
              writable: false,
              // The adapter reads this only at stdin dispatch, after async preparation; a frame dropped by then leaves the perception line too.
              // I-021: and a note deleted while the message waited is not in it (turn.withCurrentRecall, Codex T-222 E04), nor a 一起听 note or raw text (listenAsk.current).
              get prompt() { const data = chatContextData(profileContextLease, visualSelfLease), persona = listenAsk.current(turn!.withCurrentRecall(turnFrames.recompose(request.attachments, settings.persona, sightAgain)));
                return data || persona !== settings.persona ? buildCodexChatPrompt(persona, chatMessages, data, languageProfile) : prompt; },
              // 关掉之后的旧帧: read again where the adapter writes the message (after a process start or a previous turn's drain).
              get imageDataUrls() { return turnFrames.current().map(attachment => attachment.dataUrl); },
              // I-166: small frames stay in her warm process like a call's (electron/brain/call-glances.ts); any other picture still retires it.
              ...(seeAndSay ? { callGlance: seeAndSay.glanceMark(turnFrames) } : {}),
              imageTemporaryRoot: path.join(
                app.getPath("temp"),
                PROFILE_FOLDER,
                "chat",
              ),
              replyId: request.id, session: { key: acceptedSpeechScope ?? '', owner: turn.scope.characterId, basePersona, get persona() { return listenAsk.current(turn!.withCurrentRecall(turnFrames.recompose(request.attachments, settings.persona, sightAgain))); }, openingContext: turn.relationshipOpening, openingKey: turn.relationshipTag, messages: chatMessages, ...(LONG_CHAT.enabled ? { openingNote: longChatNote(turn.scope) } : {}), ...(relaxedTurn ? { relaxed: relaxedTurn, openingMemory: LONG_CHAT.enabled ? i139Chat.openingMemory(turn.scope) : null, onceLines: (): OnceLine[] => { const left = turnFrames.current(); return [{ key: 'interconnect', text: interconnectLine }, i139Chat.perceptionOnce(left.length === request.attachments.length ? sight : perceptionTurnState(media.state, left, request.messages.at(-1)?.content, { rough, cameraGlance: turnFrames.cameraGlance(), screenSmall: turnFrames.screenGlance(), ...firstTurn.glance }), hearing, !!listenAsk.block)]; } } : {}), // I-139: layers 1 and 2, the new headers, the lines said once per Claude process
                language: languageProfile, data: () => chatContextData(profileContextLease, visualSelfLease),
                // 首字: the session records her reply as shown (a cut draft too), so the next message stays on this process.
                shown: () => beatTurn.historyText(turn?.shownReply?.() ?? null) }, // 边说边演: with the switch on, her reply as she wrote it
              // I-134 step 4: refused or empty with nothing shown: once more at once with the renderer's short window (no long window, no note); something shown: kept.
              ...(LONG_CHAT.enabled ? { refusalFallback: { prompt: () => buildCodexChatPrompt(listenAsk.current(turn!.withCurrentRecall(turnFrames.recompose(request.attachments, settings.persona, sightAgain))), request.messages, chatContextData(profileContextLease, visualSelfLease), languageProfile),
                visible: () => !!voiceContextBody.trim(), current: () => !signal.aborted && acceptedSpeechScope === ownerScopeNow(), noted: (kind: 'refusal-fallback' | 'refusal-kept') => { chatIncidents.record(kind); } } } : {}),
            },
            signal,
              beatTurn.input(turn.push, signal), // 边说边演: the earliest point; the protocol, bubble, voice, archive and memory see clean text only
            );
            if (!signal.aborted) await beatTurn.end(turn.push); // 2026-11-23: her words after a kiss / hug come once it is done (full-screen Unbound); archived once, whole
          }
          signal.throwIfAborted();
          await turn.finish('complete');
          // The reply was only an internal draft and the filter removed all of it: fail like any other chat error (her own line), never an empty bubble.
          if (turn.emptyReply?.()) throw chatAvailability.quietFailure(new DraftOnlyReplyError());
          if (signal.aborted) beatTurn.cancel(); // stopped while archiving: no grey line, no more beats
          const beatOutcome = beatTurn.complete(turn.shownReply?.() ?? voiceContextBody); // once, after the one archive: the grey line, her history
          if (beatOutcome.beats.length && !signal.aborted) void speechBeats.archive.record(turn.scope, request.id, beatOutcome);
          const alarmNote = signal.aborted || acceptedSpeechScope !== ownerScopeNow() || typeof momentsReplyDone !== 'function' ? null : momentsReplyDone(beatTurn.alarmMarkers()); if (alarmNote) send(sender, { id: request.id, kind: 'chat', type: 'beats', text: '', speechBeats: { note: alarmNote } }); // I-195: her own alarm marker (already out of her text) is read; the grey line only, never what she wrote
          if (!signal.aborted && acceptedSpeechScope === ownerScopeNow() && typeof milestoneReplyDone === 'function') void milestoneReplyDone(ownerCard(), companion.relationship, beatTurn.alarmMarkers()); // I-207: her hidden milestone marker (already out of her text), recorded once; no grey line
          if (!signal.aborted && acceptedSpeechScope === ownerScopeNow() && typeof objectReplyDone === 'function') void objectReplyDone(ownerCard(), companion.relationship, beatTurn.alarmMarkers()); // I-208: her hidden note markers, kept with the date
          if (!signal.aborted && acceptedSpeechScope === ownerScopeNow() && typeof unboundPlaceMarks === 'function') unboundPlaceMarks(beatTurn.alarmMarkers(), owner); // I-212: her ⟪keep-place⟫ / ⟪clear-place⟫ in her reply to your message (full screen only)
          planAsk?.done(); // P-001 step 2: her reply is complete, so the plan counts as asked
          senseRouter.replyDone(request.id, true, voiceContextBody); // I-040: her short line may follow now, never during her reply
          const offerTo = turn.lookOffer?.() ? lookOfferFor(sight, lookOfferTarget(voiceContextBody)) : null; // she asked "要我凑近看看吗" (I-084: or "要我看看你吗？" with 「发图片」 on)
          if (offerTo) lookTurns.noteOffer(sightScope, lookScope(), offerTo);
          rps.host.chatDone(request.id, true); // G1: an accepted request starts the match right after her reply
          if (typeof hands!=='undefined') hands.host.chatDone(request.id, true); // I-087: "做完了!" gets a high five after her reply
          replyLatency.complete(request.id);
          signal.throwIfAborted();
          specialDay.hintDone(specialHint, voiceContextBody); // I-059: her shown reply touched the day, or the chances ran out
          const folderTaken = herFolder.offer(folderTurn, sender, turn.herFileProposal?.()); // I-050: her one file block of this turn, checked and written by the host
          takeMeThere.offer(herFolder.hintDone(folderHint, voiceContextBody) && !goTurn.destination ? { ...goTurn, destination: 'her-folder' } : goTurn, sender, !!chatSettings.offer(settingTurn.ticket, sender, request.id, turn.settingProposal?.()) || folderTaken);
          memorialTurn?.complete(turn.profileReplyAccepted?.()===true,turn.textMemorialProposal?.());
          if (!turnFrames.asked().length && settings.provider.kind === 'claude' && acceptedSpeechScope === ownerScopeNow()
            && JSON.stringify(settings.provider) === JSON.stringify(store.current.provider))
            r20ProactiveOffers?.noteCompleted(request.id, request.messages.at(-1)?.content ?? '', voiceContextBody);
          if (profileCollector) {
            const outcome = await profileCollector.finish(turn, 'complete');
            if (outcome.status === 'saved') userProfileManagement?.publishCurrent();
          }
          signal.throwIfAborted();
          if (acceptedSpeechScope === ownerScopeNow() && JSON.stringify(settings.provider) === JSON.stringify(store.current.provider))
            voiceHost.history = { scope: acceptedSpeechScope, providerScope: memoryProviderScope(settings.provider),
              messages: [...request.messages, { role: 'assistant', content: beatTurn.historyText(voiceContextBody) ?? '' }] }; // 边说边演: as in her chat process
          if (request.attachments.length && JSON.stringify(settings.provider) === JSON.stringify(store.current.provider)) {
            visionSupport.noteImageSuccess(settings.provider);
            setVisionSupported(true);
            setVisionStatus('');
            publishVisionState();
          }
          const mood = turn.speechMood();
          if (mood && acceptedSpeechScope === ownerScopeNow()) {
            if (acceptedEmojiContext === singleEmojiContext())
              singleEmojiCues?.offerReply('reply-' + request.id, mood, acceptedEmojiContext);
            const card = ownerCard();
            const config = characterTtsConfig(store.current, card);
            const style = composeSpeechConfig(config, mood, characterSpeechPersona(card), completedFatigueFeeling(acceptedSpeechScope, card.id));
            if (replySpeechStyles.complete(sender, request.id, acceptedSpeechScope, mood, style) && store.current.voice.enabled && !beatOutcome.performanceOnly) { // 边说边演: nothing to read
              if(settings.provider.kind==='claude'){
                if(speechCommitFence)completedReplySpeech.record(sender,request.id,acceptedSpeechScope,completedSpeechText,{prefix:true,fence:speechCommitFence});
              }else completedReplySpeech.record(sender, request.id, acceptedSpeechScope, completedSpeechText);
              suspendAmbientSpeech();
            }
          }
          if(speechCommitFence)completedReplySpeech.cancelPending(speechCommitFence);
        } catch (error) {
          beatTurn.cancel(); // 边说边演: a stopped, failed or stale reply sends no more beats (the windows drop what was not played)
          profileCollector?.cancel();
          cancelReplyStyle(request.id, signal.aborted ? 'stop' : 'error');
          pauseTalk.cancel(request.id); // F7: a stopped or failed reply's plan is dropped
          await turn?.finish(signal.aborted ? 'stopped' : 'error');
          throw error;
        } finally {
          rps.host.chatDone(request.id, false);
          if (typeof hands!=='undefined') hands.host.chatDone(request.id, false); // I-087
          replyLatency.end(request.id, signal.aborted);
          senseRouter.replyDone(request.id, false, ''); // I-040: a stopped or failed reply ends its look (no-op after a complete one)
          memorialTurn?.cancel();
          profileCollector?.cancel();
          userProfileContext?.release(profileContextLease);
          visualSelfRuntime.cancel(visualSelfLease);
          if (profileAcceptance) userProfiles?.releaseAcceptance(profileAcceptance);
          broadcast('desk:memory-changed', undefined);
        }
      }, () => {
        handed?.(); // the turn is accepted: the box's line is sent (electron/brain/handed-line-gate.ts)
        const user = request.messages.at(-1);
        // This host admission is used only by the accepted ordinary human-chat route;
        // provider completions, shared frames and history never mint a command ticket.
        try {
          commandIntent = { requestId: request.id, contextId: companionCommandContext(sender),
            text: user?.content ?? '', currentValue: store.current.pet.alwaysOnTop,
            currentVisible: store.current.pet.visible, currentFollowMouse: store.current.pet.followMouse,
            currentBreath: store.current.pet.breath, currentReadoutVolume: store.current.voice.volume };
          commandTicket = companionCommands!.admit({ requestId: request.id, owner: sender,
            window: ownerFor(sender), text: user?.content ?? '', source: 'current-human',
            currentVisible: store.current.pet.visible, currentFollowMouse: store.current.pet.followMouse,
            currentBreath: store.current.pet.breath, currentReadoutVolume: store.current.voice.volume });
        }
        catch { commandAdmissionFailed = true; }
        if (readoutControl) {
          for (const win of windows()) win.webContents.send('desk:chat-started', {
            id: request.id, messages: request.messages, owner: ownerFor(sender), readoutControl: true,
          });
          return;
        }
        let profileScope: string | null = null;
        try { profileScope = companion.currentSpeechScope(); } catch { /* Transition is not a literal-source certificate. */ }
        profileSourceEligible = userProfileSource.observe(profileScope, request.messages);
        if(user?.role==='user' && profileSourceEligible && user.content.trim() && user.content.length<=3000 && turnFrames.asked().length===0) {
          memorialInput={requestId:request.id,messageId:request.id,text:user.content,acceptedAt:Date.now(),source:'text'};
          try{memorialIdentity=speechScope();}catch{memorialInput=null;}
        }
        if (user?.role === 'user') profileAcceptance = acceptProfileMessage(request.id, user.content, 'text', request.profile);
        if (user?.role === 'user' && typeof hands!=='undefined') hands.host.userSaid(request.id, user.content); // I-087: only whether it says you finished something (a local check; the words are not kept)
        if (profileAcceptance && userProfiles) {
          if (!profileSourceEligible) userProfiles.releaseAcceptance(profileAcceptance);
          else {
            try { profileCollector = UserProfileReplyCollector.create({ store: userProfiles, acceptance: profileAcceptance,
              requestId: request.id, userText: user!.content }); }
            catch { userProfiles.releaseAcceptance(profileAcceptance); }
          }
        }
        noteVisionUserActivity('message'); // a new message of yours: a line of hers ends (I-174 item 3)
        refreshVisualSelfContext();
        visualSelfLease = visualSelfRuntime.accept('user-message', request.id, request.attachments, Date.now() + 60_000);
        speechRuntime.stop();
        clearReplySpeech();
        for (const win of windows()) win.webContents.send("desk:chat-started", {
          id: request.id, messages: request.messages, owner: ownerFor(sender), ...(owner && owner !== currentId ? { speaker: ownerCard().name, speakerId: owner } : {}), // I-209 step 4: her name in the chat list
        });
      });
    },
    false,
  );
  scopedHost(
    "cancel",
    (sender, id: unknown) => {
      const { companionCommands, voiceHost, revokeVoice, cancelReplyStyle, speechRuntime } = needs; // read when called
      if (typeof id !== "string") throw new Error("请求编号不正确。");
      const task = pending.get(id);
      companionCommands?.invalidate(id);
      if (task && task.kind !== "chat" && task.owner !== sender)
        throw new Error("此任务属于另一个窗口。");
      task?.controller.abort();
      if (task?.kind === 'chat' && voiceHost.capture) revokeVoice('stop-generation');
      if (cancelReplyStyle(id, 'stop')) speechRuntime.stop();
      companion.mood.cancelChatGesture(id);
    },
    false,
  );
}
