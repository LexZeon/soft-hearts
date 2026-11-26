// 感知's wiring, 语音输入 (docs/claude/2026-11-17-split-senses-wiring.md; moved from electron/wiring/senses-wiring.ts, which keeps
// wireSenses, the needs and the register entry; before that from electron/main.ts, docs/claude/2026-11-16-wiring-step-4c.md). The
// statements are the ones senses-wiring.ts had.
// 语音输入: the recognizer route (VoiceRoute), the foreground recognizer and asrTask, R33's continuous voice (VoiceChatHost) and its four
//   capture handlers, the microphone's chat slot following voice input (syncAudioCapture, readingInputSpeech), and 听's sync and save
//   steps. Its gates (only the window that turned voice input on opens a capture or asks for words) are here.
// - wireVoiceInput runs after wireListen inside wireSenses; everything it makes only stores its ports on construction.
// - asrTask and readingInputSpeech are module-level here and exported (senses-wiring.ts exports them again).
// - The sync step and save steps are top-level functions (electron/main.ts's step lists name them; the wiring golden expands their bodies
//   in place); they call the part's functions through the bindings below, set by wireVoiceInput.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app } from 'electron';
import { memoryConnectionChanged } from '../../shared/foundation/memory-connection';
import path from 'node:path';
import type { AppSettings } from '../../shared/contracts';
import type { RuntimeState } from '../../shared/foundation/runtime-state';
import { characterTtsConfig, speechRecognitionNote, VOICE_OPEN_AFTER_REPLY, type VoiceCancelReason } from '../../shared/voice';
import { cardLanguageOf } from '../../shared/foundation/character-card';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { ForegroundAsr, transcribeWav, voiceLegLook, voiceSegmentSenses, VoiceRoute, type LookAttachments } from '../senses';
import { senseRouter } from './initiative-wiring'; // I-040's router (read when called; made by 主动's wiring)
import { callFrameNote, callPastGlancesNote } from '../../shared/brain';
import { MediaRuntime, type MediaOwner } from '../senses/media-runtime';
import { CallOffers, characterSpeechPersona, herVoiceFrom } from '../voice';
import { composeSpeechConfig } from '../mood';
import { resolveVoiceInputKey, type SettingsStore } from '../settings';
import { PROFILE_FOLDER } from '../profile';
import { recordReplyCut, speechBeatsFor } from '../brain'; // 边说边演
import type { SeeAndSayPart } from './see-and-say-wiring'; // I-166 her closer look
import { gateEnabled } from './channel-gates-wiring';
import type { PartIpc } from './ipc-wiring';
import { broadcast, ownerFor, windows } from './shell-wiring';
import { VoiceChatHost, type VoiceAppCapture } from './voice-wiring';
import type { SensesNeeds } from './senses-wiring';
import { localAsr } from './senses-wiring';
import { ambientAudio, ambientComments, audioCapture, keepVoiceForListen, type ListenPart } from './senses-listen-wiring';
import { voiceprint, voiceprintGate } from './senses-voiceprint-wiring';
import { registerVoiceprintControls } from '../senses/voiceprint/electron-wiring';

// 语音输入's state (other parts read it; senses-wiring.ts exports it again).
export let readingInputSpeech = false;
export let asrTask: { owner: MediaOwner; controller: AbortController } | null = null;

// 听's sync step and save steps call these (set by wireVoiceInput).
let voiceHost!: VoiceChatHost;
let voiceCurrent!: (capture: VoiceAppCapture) => boolean;
let revokeVoice!: (reason: VoiceCancelReason) => void;
let stopSystemAudio!: () => void;
let speechScope!: () => string;
let memoryProviderScope!: (provider: AppSettings['provider']) => string;
function keepForHearingSteps(host: VoiceChatHost, current: typeof voiceCurrent, revoke: typeof revokeVoice, stop: () => void, scope: () => string,
  providerScope: typeof memoryProviderScope): void {
  voiceHost = host; voiceCurrent = current; revokeVoice = revoke; stopSystemAudio = stop; speechScope = scope; memoryProviderScope = providerScope;
}

/** Sync step (声音): a voice turn that belongs to another conversation or provider ends. */
export function syncVoiceScope(s: AppSettings): void {
  if (voiceHost.history) {
    try { if (voiceHost.history.scope !== speechScope() || voiceHost.history.providerScope !== memoryProviderScope(s.provider)) voiceHost.history = null; }
    catch { voiceHost.history = null; }
  }
  if (voiceHost.capture && !voiceCurrent(voiceHost.capture)) revokeVoice('scope-change');
}
/** Save step (感知): another connection stops the computer's sound (I-222: another chat model alone does not; memory-connection.ts). */
export function saveProviderStopsAudio(next: AppSettings, _baseline: unknown, store: SettingsStore): void {
  if (memoryConnectionChanged(store.current.provider, next.provider)) stopSystemAudio();
}
/** Save step (感知): voice input keeps its key; another voice input setting stops what was being heard. */
export function saveVoiceInputKey(next: AppSettings, _baseline: unknown, store: SettingsStore): void {
  next.voiceInput = resolveVoiceInputKey(
    next.voiceInput!,
    store.current.voiceInput!,
  );
  if (
    JSON.stringify(next.voiceInput) !==
    JSON.stringify(store.current.voiceInput)
  ) {
    asrTask?.controller.abort(); stopSystemAudio();
  }
}

// 看's switches, which the lines below read when they are called (set by wireLook, which runs right after wireVoiceInput).
let media!: MediaRuntime;
let mediaChanged!: (previous: RuntimeState) => void;
/** I-161: the typed chat's look (decision first, then the capture, tickets and admit), which voice segments use too. */
let lookAttachments: LookAttachments | undefined;
/** I-166: her own closer look around her chat stream, and her paragraph about what she sees (electron/wiring/see-and-say-wiring.ts). */
let seeAndSay: SeeAndSayPart | null = null;
export function keepLookForVoice(look: { media: MediaRuntime; mediaChanged: (previous: RuntimeState) => void; lookAttachments?: LookAttachments; seeAndSay?: typeof seeAndSay }): void {
  media = look.media; mediaChanged = look.mediaChanged; lookAttachments = look.lookAttachments; seeAndSay = look.seeAndSay ?? null;
}

/** 语音输入, made after 她听 (it pauses her listening while the user speaks and stops the computer's sound on a settings change). */
export function wireVoiceInput(needs: SensesNeeds, listen: ListenPart) {
  // The other parts' functions the moved lines call (electron/main.ts's wrappers read its own functions when called).
  const { syncFatigueActivity, journalCharacterId, speechScope, clearReplySpeech, completedFatigueFeeling, memoryProviderScope, agentInterconnected,
    longChatHistory } = needs;
  // Made before wireSenses runs and never replaced.
  const { appJournal, proactiveSpeechGate, voiceCall, callStreamingSpeech, replySpeechStyles, speechRuntime, journalExtras, moodJudge, reactions,
    claudeChat, takeMeThere, chatSettings, i139Chat, LONG_CHAT } = needs;
  // 她听's (electron/wiring/senses-listen-wiring.ts).
  const { suspendAmbientSpeech, stopSystemAudio, ambientSpeakingOwners } = listen.provides;
  const { journalStuck } = listen;
  const voiceRoute = new VoiceRoute({ config: () => needs.store.current.voiceInput ?? DEFAULT_SETTINGS.voiceInput!, local: () => localAsr,
    compatible: transcribeWav, journal: input => { appJournal.record(input); }, characterId: () => journalCharacterId() });
  // This promise covers pause/drain, the real recognizer and finally cleanup.
  // An ignored abort does not release it; legacy and grouped input share it.
  const foregroundAsr = new ForegroundAsr({
    pauseAndDrain: () => ambientAudio?.pauseAndDrain(),
    transcribe: async (wav, signal) => {
      const capture = voiceHost.capture;
      try { return await voiceRoute.transcribe(wav, signal); } // 识别方式: the local recognizer or the compatible address
      catch (error) {
        // Its closed category (both windows say it) and the compatible path's validated message stay with this exact capture
        // through its async fault; one journal line, never audio or words (electron/senses/asr/voice-route.ts).
        if (capture && voiceCurrent(capture) && !signal.aborted) voiceRoute.failed(capture, error);
        throw error;
      }
    },
    entered: (owner, controller) => { asrTask = { owner, controller }; suspendAmbientSpeech(); },
    exited: controller => { if (asrTask?.controller === controller) asrTask = null; suspendAmbientSpeech(); },
  });
  // R33 continuous voice: capture scope, per-sentence dispatch over the conversation-scoped
  // Claude process, merging an addition into a reply still being generated, and one
  // archive / appraisal / reading per utterance (electron/voice/voice-chat-host.ts).
  // Unbound v1 step 3: 只认你的声音 before a clip is recognized, and listening for her name after (electron/senses/voiceprint/gate.ts).
  const voiceprintChecks = voiceprintGate({ needs, media: () => media, voiceCall, localRecognition: () => voiceRoute.engine === 'local' && !!localAsr?.ready });
  const voiceHost = new VoiceChatHost({
    // (typeof: tests that evaluate this object alone have no voiceprint checks; then every clip passes as before.)
    screen: (owner, wav) => typeof voiceprintChecks === 'undefined' ? Promise.resolve('pass' as const) : voiceprintChecks.screen(owner, wav),
    wake: (owner, text) => typeof voiceprintChecks === 'undefined' ? Promise.resolve(true) : voiceprintChecks.wake(owner, text),
    // I-204: three recognized characters interrupt her; her echo is judged against what she is reading now (electron/voice/utterance-gate.ts)
    // I-197: from handing her a line until her voice starts she is silent (only her filler keeps the echo guard), and a clear line is added on
    get addOn() { return voiceCall.addOn; }, // read when used, like the other ports
    gate: { herVoice: () => voiceCall.addOn.herVoice(() => herVoiceFrom(ambientSpeakingOwners, speechRuntime, callStreamingSpeech)), herText: () => voiceCall.herText(callStreamingSpeech.readingText()),
      continuous: owner => (voiceCall.on && voiceCall.controller.owner === owner) || voiceCall.wakeOwner() === owner,
      held: (kind, overHer, owner, numbers) => voiceCall.held(kind, overHer, owner, numbers), interrupted: (owner, by, overHer, heard) => { voiceCall.heardOverHer(owner, by, overHer, heard); } },
    broadcast: event => { if (event.type === 'speech') voiceCall.noteSpeech(event.replyId); broadcast('desk:voice-conversation', event); },
    memoryChanged: () => broadcast('desk:memory-changed', undefined),
    windowVisible: sender => {
      const win = windows().find(value => value.webContents.id === sender);
      return !!win && needs.onScreen(win); // Unbound v1 step 3: her companion window hidden only because she is out still hears (as her other senses do)
    },
    media: () => media.state,
    turnOffVoiceInput: owner => { const previous = { ...media.state }; media.update({ voiceInput: false }, owner); mediaChanged(previous); },
    speechScope: () => speechScope(), longChatHistory: groupId => { try { const { companion, textInvitationMemory } = needs; return longChatHistory({ knobs: LONG_CHAT, archives: [companion.cutMarkedWindow?.() ?? companion.memory, textInvitationMemory], scope: companion.currentScope(), turnId: groupId, labels: i139Chat.labels(), language: i139Chat.cardLanguage() }); } catch { return null; } }, // I-134: a voice utterance starts from her archive's window (off: null)
    settings: () => needs.store.current,
    // I-027: a spoken sentence is the user's message too (the same text that goes to her chat).
    companion: () => ({ beginVoiceGroup: (id, text, persona) => { moodJudge.host.userText(id, text, true); reactions.userTurn(id, text); return needs.companion.beginVoiceGroup(id, text, persona); } }),
    ambient: () => ambientComments,
    reserveChat: (replyId, controller, owner) => {
      const { pending } = needs; // read when called
      if ([...pending.values()].some(task => task.kind === 'chat')) return false;
      pending.set(replyId, { controller, owner, kind: 'chat' }); return true;
    },
    releaseChat: replyId => { needs.pending.delete(replyId); },
    userTurn: () => { needs.companionCommands?.invalidate(); syncFatigueActivity(); voiceCall.turn(); },
    turnNote: () => voiceCall.turnNote(cardLanguageOf(needs.characterCards.getActive())), // I-091 / I-204: she was cut mid-reading in a call: where, what she said and meant to say, your line (once, private)
    speechNote: () => speechRecognitionNote(cardLanguageOf(needs.characterCards.getActive())), // I-158: this turn's words came from speech recognition (private, per turn)
    // I-161 (A 像视频通话): each segment's frames by the typed chat's own rules (electron/senses/voice-look.ts)
    look: text => { const look = lookAttachments; return look ? voiceLegLook({ request: (hint, options) => look.request(hint, options), admit: frames => look.admit(frames),
      note: frames => callFrameNote(frames, cardLanguageOf(needs.characterCards.getActive())), looked: ms => journalExtras.callLook.note(ms),
      past: now => callPastGlancesNote(now, cardLanguageOf(needs.characterCards.getActive())), seeAndSay: () => seeAndSay?.line() ?? '' }, text) : null; }, // I-161 A: earlier small frames are past; I-166: her paragraph
    // I-161 semantic look: typed chat's I-040 judgment, riding on the reaction call above; in a call its facts go into her next words
    senses: voiceSegmentSenses({ router: () => senseRouter?.host ?? null, asking: id => reactions.host.asking(id), reactionFirstChar: id => reactions.firstChar(id), journal: fields => journalExtras.callLookLine(fields),
      inCall: owner => (voiceCall.on && voiceCall.controller.owner === owner) || voiceCall.wakeOwner() === owner, language: () => cardLanguageOf(needs.characterCards.getActive()) }),
    callStyle: () => voiceCall.callStyle(), // I-091 step 4: short spoken sentences, every call turn
    callOffers: new CallOffers({ takeMeThere, chatSettings, interconnected: agentInterconnected, relaxed: () => i139Chat.relaxed() }), relaxedChat: () => i139Chat.relaxed(), // I-139: the call's 三方互通 line and its session's opening layers // take-me-there and setting cards in a call: same host modules as typed chat
    callSpeech: { begin: input => callStreamingSpeech.begin({ ...input, owner: input.owner }), delta: (id, text) => callStreamingSpeech.delta(id, text),
      complete: id => callStreamingSpeech.complete(id), cancel: id => callStreamingSpeech.cancel(id),
      refine: (capture, replyId, mood) => { const { store, characterCards } = needs; const card = characterCards.getActive(); replySpeechStyles.complete(capture.sender, replyId, capture.scope, mood,
        composeSpeechConfig(characterTtsConfig(store.current, card), mood, characterSpeechPersona(card), completedFatigueFeeling(capture.scope, card.id))); } },
    // 边说边演 in a call (electron/voice/voice-call/beats.ts): the same turn, switch and file as typed chat; the call's own reading gives the progress
    speechBeats: { begin: (on, send) => speechBeatsFor(needs.store.directory).begin(on, send), enabled: () => gateEnabled('speechBeats'),
      record: (scope, replyId, outcome) => { void speechBeatsFor(needs.store.directory).archive.record(scope as never, replyId, outcome); } },
    cut: (scope, turnId, cut) => { void recordReplyCut(needs.store.directory, scope, turnId, cut); }, // 2026-11-23: her voice was cut: where and why, filed beside the reply (archived once, whole)
    activityChanged: () => syncFatigueActivity(),
    cancelProactive: () => proactiveSpeechGate.cancel('user'),
    claude: { stream: (task, signal, emit, control) => (seeAndSay ? seeAndSay.stream(claudeChat)(task, signal, emit, control) : claudeChat.stream(task, signal, emit, control)), // I-166: her closer look continues the same reply
      regroup: (replyIds, shown) => claudeChat.regroup(replyIds, shown) },
    languageProfile: () => needs.personalizeLanguage?.effectiveProfile(needs.characterCards.getActive().id),
    chatDirectory: () => path.join(needs.store.directory, 'chat'),
    tempDirectory: () => path.join(app.getPath('temp'), PROFILE_FOLDER, 'chat'),
    transcribe: (owner, wav, signal, current) => journalExtras.voiceTime.measure(wav, () => foregroundAsr.run(owner, wav, signal, current)), // 语音输入时间 (journal only)
    toneOf: wav => { const tone = voiceRoute.toneOf(wav); needs.companion?.dayRead.noteTone(tone); return tone; }, // I-089 item 5: also one input to the day's read // I-100: how the user's voice sounded (closed value), a private hint for her turn
    unheard: (failure, peakDb) => voiceRoute.heard(failure, peakDb), // 在听但不出字: a clip with no words is journaled by category and level (2026-11-06)
    stopReading: mode => {
      if (mode === 'sentence') { broadcast('desk:voice-reading-stop', 'sentence'); return; } // the reading window finishes its sentence
      try { journalExtras.readCancel.note('stop'); } catch { /* journal only */ } // the user's own stop word (journal: who cut the reading)
      speechRuntime.stop(); clearReplySpeech(); broadcast('desk:voice-reading-stop', undefined);
    },
    reading: { expect: replyId => journalExtras.readingLedger.expect(replyId), notHanded: by => journalExtras.readingLedger.notHanded(by) }, // 2026-11-24: a reply handed to her voice is expected to be asked for; one not handed over says why (electron/voice/reading-ledger.ts)
    prepareSpeech: (capture, replyId, mood) => {
      const { store, characterCards } = needs; // read when called
      const card = characterCards.getActive(), config = characterTtsConfig(store.current, card);
      replySpeechStyles.begin(capture.sender, replyId, capture.scope);
      replySpeechStyles.complete(capture.sender, replyId, capture.scope, mood, composeSpeechConfig(config, mood, characterSpeechPersona(card), completedFatigueFeeling(capture.scope, card.id)));
    },
  });
  voiceCall.onCut((replyId, cut) => voiceHost.fileCut(replyId, cut)); // 2026-11-23: the call's barge-in files its cut record through the voice host (it knows where the reply sits in the archive)
  const voicePipeline = voiceHost.pipeline;
  function voiceCurrent(capture: VoiceAppCapture): boolean { return voiceHost.current(capture); }
  function revokeVoice(reason: VoiceCancelReason, preserveConsent = false): void { voiceHost.revoke(reason, preserveConsent); }
  function syncAudioCapture(): void {
    if (!audioCapture) return;
    if (media.state.voiceInput && media.state.voiceOwner) audioCapture.setChat(media.state.voiceOwner);
    else { audioCapture.setChat(null); readingInputSpeech = false; }
    suspendAmbientSpeech();
  }
  keepForHearingSteps(voiceHost, voiceCurrent, revokeVoice, stopSystemAudio, speechScope, memoryProviderScope);
  keepVoiceForListen(foregroundAsr);
  return {
    provides: { voiceRoute, foregroundAsr, voiceHost, voiceCurrent, revokeVoice, syncAudioCapture },
    register(registrar: PartIpc): void {
      const { scopedHost, host } = registrar;
      registerVoiceprintControls(host, () => voiceprint(needs)); voiceprint(needs); // Unbound v1 step 3: 只认你的声音 (control window only); made now so its saved switch is read at start
      // What the handlers read: set before the ready chain registers (registerIPC) and not replaced later.
      const { pending } = needs;
      scopedHost('openVoiceCapture', sender => {
        if (!media.state.voiceInput || media.state.voiceOwner !== ownerFor(sender)) throw Error('此窗口未开启语音输入。');
        if ([...pending.values()].some(task => task.kind === 'chat')) throw Error(VOICE_OPEN_AFTER_REPLY); // the window waits and opens it afterwards
        revokeVoice('scope-change', true);
        asrTask?.controller.abort();
        return voiceHost.open(sender, ownerFor(sender));
      }, false);
      scopedHost('submitVoicePcm', (sender, value) => {
        const capture = voiceHost.capture;
        if (!capture || capture.sender !== sender || !voiceCurrent(capture)) throw Error('语音输入上下文已改变。');
        if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'captureSeq,captureSessionId,wav')
          throw Error('语音提交格式不正确。');
        return voicePipeline.submit(sender, value);
      }, false);
      scopedHost('signalVoiceCapture', (sender, sessionId, signal) => {
        const capture = voiceHost.capture;
        if (!capture || sender !== capture.sender || sessionId !== capture.binding.captureSessionId || !voiceCurrent(capture)) return false;
        if (signal === 'speech-start') {
          const accepted = voicePipeline.speechStarted(sender, sessionId);
          if (accepted) { readingInputSpeech = true; suspendAmbientSpeech(); voiceCall.heard(); } return accepted;
        }
        if (signal === 'endpoint') {
          const accepted = voicePipeline.endpoint(sender, sessionId);
          if (accepted) { readingInputSpeech = false; suspendAmbientSpeech(); journalExtras.voiceTime.endpoint(); } return accepted;
        }
        if (signal === 'finish-speaking') {
          const accepted = voicePipeline.finishSpeaking(sender, sessionId);
          if (accepted) { readingInputSpeech = false; suspendAmbientSpeech(); } return accepted;
        }
        if (signal === 'pause-stuck') { journalStuck('mic-window'); return true; } // the window's "she is speaking" outlasted speaking and was dropped there
        if (signal === 'no-sound') { voiceRoute.heard('no-sound'); journalExtras.voiceTime.noSound(); return true; } // the window found a microphone that gives only silence
        if (signal === 'cancel') { revokeVoice('stop-generation'); return true; }
        throw Error('语音控制指令不正确。');
      }, false);
      scopedHost('transcribeAudio', (sender, wav) => {
        const owner = ownerFor(sender);
        if (!media.state.voiceInput || media.state.voiceOwner !== owner) throw Error('此窗口未开启语音输入。');
        if (voiceHost.capture || foregroundAsr.busy) throw Error('已有语音识别正在进行。');
        return foregroundAsr.run(owner, wav, new AbortController().signal,
          () => media.state.voiceInput && media.state.voiceOwner === owner && !voiceHost.capture);
      }, false);
    },
  };
}

export type VoiceInputPart = ReturnType<typeof wireVoiceInput>;
