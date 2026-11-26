// 感知's wiring, 她听 (docs/claude/2026-11-17-split-senses-wiring.md; moved from electron/wiring/senses-wiring.ts, which keeps
// wireSenses, the needs and the register entry; before that from electron/main.ts, docs/claude/2026-11-16-wiring-step-4c.md). The
// statements are the ones senses-wiring.ts had.
// 她听: the computer's sound (SystemAudioRuntime), the old ambient listening and its comments, 读取音频 (audio capture and reading),
//   一起听 / 一起看 (made by initAmbientAudio, a ready-chain step), the pause guards (2026-11-06 朗读过后听不见了), and their 20 handlers.
//   The privacy gates of the computer's sound and 读取音频 are here (tests/senses-privacy-gates.test.ts, tests/audio-reading-app-wiring.test.ts).
// - wireListen runs first inside wireSenses; everything it makes only stores its ports on construction.
// - State other parts read is module-level here and exported (senses-wiring.ts exports it again, so electron/main.ts and the other parts
//   import it from there): ambientStore, audioCapture, audioReading, ambientAudio, ambientComments, listenTogether, watchTogether,
//   lastAmbientSpeech (written by 声音 through setLastAmbientSpeech).
// - What it reads from 看 and 语音输入, made after it, is kept below by keepLookForListen / keepVoiceForListen and read when called.
// - register() runs inside the agent channel's recorder (senses-wiring.ts's register hands it on as registrar).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RuntimeState } from '../../shared/foundation/runtime-state';
import { listenSwitchOn, listenWordsOn, parseAudioReadingPcm, type AmbientAudioView, type AmbientLanguage } from '../../shared/senses';
import { parseAudioDanceIntent } from '../../shared/senses/audio-dance';
import { ambientCallSystem, audioReadingPurposes, audioReadingSources, characterTtsConfig, parseAudioReadingIntent } from '../../shared/voice';
import type { PauseStuckKind } from '../../shared/memory';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { cardLanguageOf, compileCharacterPersona } from '../../shared/cards';
import { LookTurns, ScreenSnapshots, UserGazeHost } from '../senses';
import { AmbientAsrRoute, AmbientAudioRuntime, AmbientComments, AudioCaptureHost, ForegroundAsr, ListenTally, ListenTogether, PauseGuard,
  refusedReadingAck, SystemAudioRuntime, type AmbientCommentSession, type AmbientCommentsLike } from '../senses';
import { prepareWatchFrame } from '../senses/watch-notes/frame-picture';
import { MediaRuntime, type MediaOwner } from '../senses/media-runtime';
import { WatchTogether, watchHearingOf } from '../senses/watch-notes/wiring';
import { noteWatchOffCause, offCauseOfIntent, onWatchUserOff } from '../senses/watch-off-notice';
import { WatchContinuity, type WatchFactsOutcome } from '../senses/watch-continuity';
import { streamClaude } from '../brain';
import { quickLineWithClaude } from '../initiative';
import { AudioReadingArchive, AudioReadingHostBroker, characterSpeechPersona, SpeakingOwners, type AudioReadingPublicationTicket } from '../voice';
import { composeSpeechConfig } from '../mood';
import type { ReplyProofSurface } from '../unbound';
import { sanitizeFillerShape } from '../../shared/voice'; // 2026-11-20: her short sounds in a call move the Unbound mouth
import { PROFILE_FOLDER } from '../profile';
import { settledScope } from '../foundation/settled-scope';
import type { PartIpc } from './ipc-wiring';
import { proactiveChatFor } from './proactive-chat-wiring';
import { broadcast, ownerFor } from './shell-wiring';
import { unbound } from './unbound-wiring';
import { relayDance } from './unbound-senses-wiring';
import type { SensesNeeds, SensesProvides } from './senses-wiring';
import { localAsr } from './senses-wiring';
import { userInputUntil } from './senses-look-wiring';
import { asrTask, readingInputSpeech } from './senses-voice-input-wiring';

// 听's state (made by initAmbientAudio, a ready-chain step, or written as she listens).
export let ambientStore: AudioReadingArchive;
export let audioCapture: AudioCaptureHost | null = null;
export let audioReading: AudioReadingHostBroker | null = null;
export let ambientAudio: AmbientAudioRuntime | null = null;
export let ambientComments: AmbientCommentsLike | null = null; export let listenTogether: ListenTogether | null = null; // I-016: electron/senses/listen-together/
export let watchContinuity: WatchContinuity | null = null; // 2026-11-24 (续): 一起看 paused and resumed with her window, the facts of a lost share (electron/senses/watch-continuity/)
export let watchTogether: WatchTogether | null = null; // I-048 / I-049: 和她一起看's timeline, watch notes and keyword recall (electron/senses/watch-notes/)
/** 系统声音's line being read now (声音 reads and clears it: electron/wiring/voice-wiring.ts VoiceNeeds.lastAmbientSpeech). */
export let lastAmbientSpeech: { owner: number; id: string; text: string; presentation: ReplyProofSurface } | null = null;
export function setLastAmbientSpeech(value: typeof lastAmbientSpeech): void { lastAmbientSpeech = value; }

// 看's switches and look, and 语音输入's foreground recognizer, which the lines below read when they are called (set by wireLook and
// wireVoiceInput, which run right after wireListen, while electron/main.ts is evaluated; nothing here calls them before).
let media!: MediaRuntime;
let mediaChanged!: (previous: RuntimeState) => void;
let lookTurns!: LookTurns;
let lookState!: SensesProvides['lookState'];
let screenSnapshots!: ScreenSnapshots;
let userGaze!: UserGazeHost;
let foregroundAsr!: ForegroundAsr;
export function keepLookForListen(look: { media: MediaRuntime; mediaChanged: (previous: RuntimeState) => void; lookTurns: LookTurns; lookState: SensesProvides['lookState'];
  screenSnapshots: ScreenSnapshots; userGaze: UserGazeHost }): void {
  media = look.media; mediaChanged = look.mediaChanged; lookTurns = look.lookTurns; lookState = look.lookState; screenSnapshots = look.screenSnapshots; userGaze = look.userGaze;
}
let offWatchUserOff: (() => void) | undefined;
let watchSpeaker: ((facts: string, characterId: string | null) => Promise<WatchFactsOutcome>) | null = null;
/** 主动's wiring hands in her one immediate turn (electron/wiring/watch-facts-turn-wiring.ts) once it exists; until then a lost share's facts wait for her next turn. */
export function attachWatchSpeaker(speak: typeof watchSpeaker): void { watchSpeaker = speak; }
export function keepVoiceForListen(foreground: ForegroundAsr): void { foregroundAsr = foreground; }

/** 她听, made first (语音输入 and 看 read what it makes). */
export function wireListen(needs: SensesNeeds) {
  // The other parts' functions the moved lines call (electron/main.ts's wrappers read its own functions when called).
  const { syncFatigueActivity, replySurface, herOnScreen, onScreen, publishSenses, journalCharacterId, speechScope, replySpeechBusy, cancelReplyStyle,
    completedFatigueFeeling, recentLines, mutate } = needs;
  // Made before wireSenses runs and never replaced.
  const { appJournal, proactiveSpeechGate, replySpeechStyles, speechRuntime } = needs;
  // ---- 听: what she hears (voice input and its recognizer, the computer's sound and the old ambient listening, 读取音频, 一起听 / 一起看).
  // 2026-11-06 朗读过后听不见了: every "pause listening while she speaks" lets go by itself (leases) and a last guard frees any pause that outlasts speaking.
  function journalStuck(what: PauseStuckKind): void { try { appJournal.record({ type: 'pause-stuck', characterId: journalCharacterId(), what }); } catch { /* the journal never changes listening */ } }
  function noteStuck(what: PauseStuckKind): void { journalStuck(what); suspendAmbientSpeech(); }
  const ambientSpeakingOwners = new SpeakingOwners({ expired: () => noteStuck('speaking-window') });
  const suspendGuard = new PauseGuard(() => journalStuck('ambient-suspend'));
  const readingGuards = { 'system-audio': new PauseGuard(() => journalStuck('listen-pause')), microphone: new PauseGuard(() => journalStuck('listen-pause')) };
  const listenTally = new ListenTally();
  let readingStartedAt = 0, readingReadyAt: number | null = null;
  const readingPaused = { 'system-audio': false, microphone: false };
  const readingLanguages = new Map<string, AmbientLanguage>();
  let ambientRetryAt = 0;
  let ambientLastDispatchAt = 0;
  let ambientDeliveryGeneration = 0;
  const systemAudio = new SystemAudioRuntime();
  // 陪听歌、看剧的转写: the local recognizer only, the sound never leaves the computer (I-016 plan; Codex T-207); 识别方式 = compatible → rhythm only.
  const ambientAsr = new AmbientAsrRoute({ config: () => needs.store.current.voiceInput ?? DEFAULT_SETTINGS.voiceInput!, local: () => localAsr,
    journal: input => { appJournal.record(input); }, characterId: () => journalCharacterId() });
  function stopSystemAudio(): void {
    const { companion } = needs; // read when called
    // no-pet-ok: the companion window handle
    if (needs.pet && onScreen(needs.pet)) watchContinuity?.clear(); // a character or conversation change: the facts of the old one go (her window away is not one)
    // no-pet-ok: the companion window handle
    noteWatchOffCause(!needs.pet || !onScreen(needs.pet) ? 'window-hidden' : 'conversation-change'); // 2026-11-24: if 一起看 ends with this, the journal row says why (the companion window off the screen, or a character or conversation change)
    cancelAmbientPlayback();
    ambientAudio?.clearContext();
    audioReading?.clear(); audioCapture?.setDance(false); audioCapture?.setDance(false, 'microphone'); readingLanguages.clear();
    // While her conversation is switching: every scope's transient pieces go (never a throw here: a switch runs this first; switch lock 2026-11-23).
    if (ambientStore && companion) ambientStore.clearTransient(settledScope(companion) ?? undefined);
    ambientComments?.clear();
    if (!systemAudio.state.active) return;
    broadcast("desk:system-audio", systemAudio.reset()); publishSenses();
  }
  function cancelAmbientPlayback(): void {
    ambientDeliveryGeneration++;
    const previous = lastAmbientSpeech; lastAmbientSpeech = null;
    if (!previous) return;
    speechRuntime.cancelReply(previous.owner, previous.id); cancelReplyStyle(previous.id);
    broadcast('desk:ambient-comment-cancelled', { id: previous.id });
  }

  function ambientAudioView(): AmbientAudioView {
    const { store } = needs; // read when called
    const state = ambientAudio!.getState();
    const input = store.current.voiceInput;
    let destination = '尚未配置转写连接';
    try { if (input?.baseUrl) destination = new URL(input.baseUrl).origin; } catch { /* validated on dispatch */ }
    return { ...state, available: process.platform === 'win32' && ambientAsr.ready(), destination,
      languageNotice: '按服务实际检测标记语言；无可靠元数据时保存原文并标为语言未知。' };
  }
  function suspendAmbientSpeech(): void {
    syncFatigueActivity();
    ambientAudio?.setSuspended(suspendGuard.observe(replySpeechBusy() || ambientSpeakingOwners.size > 0, Date.now()));
    updateReadingPause();
  }
  function updateReadingPause(): void {
    if (audioReading) {
      const busy = replySpeechBusy() || ambientSpeakingOwners.size > 0 || !!asrTask || foregroundAsr.foregroundBusy || ambientAudio?.busy === true;
      for (const source of audioReadingSources) {
        const paused = readingGuards[source].observe(busy || (source === 'microphone' && readingInputSpeech), Date.now());
        if (readingPaused[source] !== paused) {
          readingPaused[source] = paused; audioReading.setPaused(source, paused); audioCapture?.touch(source);
        }
      }
    }
  }
  function readingContextIdentity(): string {
    const { store } = needs; // read when called
    return createHash('sha256').update(JSON.stringify([speechScope(), store.current.model?.path ?? '', store.current.voiceInput])).digest('hex');
  }
  function readingActive(view = audioReading?.getView()): boolean {
    return !!view && audioReadingSources.some(source => audioReadingPurposes.some(p => view.sources[source][p].intent));
  }
  function allowsOwnedMedia(owner: MediaOwner, kind: 'audio' | 'video', manualCamera = false): boolean {
    if (kind === 'video') return media.allowsMedia(owner, kind, manualCamera);
    const capture = audioCapture?.getState().slots.microphone;
    return !!capture && capture.owner === owner && (capture.chat || capture.dance || capture.ambient !== null);
  }
  function currentAmbientSession(): AmbientCommentSession | null {
    const { pet, companion } = needs; // read when called
    const scope = settledScope(companion); // switching (switch lock 2026-11-23): no session, and her mood publish never throws here
    if (!scope) return null;
    if (!readingActive()) return ambientAudio?.currentSession() ?? null;
    if (!pet || pet.isDestroyed()) return null;
    const view = audioReading!.getView();
    return { owner: pet.webContents.id, sessionId: view.scopeId, startedAt: readingStartedAt, captureReadyAt: readingReadyAt,
      mode: audioReadingSources.some(source => view.sources[source].music.intent) ? 'music' : 'movie',
      scope, contextIdentity: speechScope() };
  }
  function initAudioReading(): void {
    audioCapture = new AudioCaptureHost({
      available: owner => { const { pet, controls } = needs; /* read when called: the windows are made after this */ const win = owner === 'pet' ? pet : controls; return !!win && onScreen(win); },
      publish: value => broadcast('desk:audio-capture-state', value),
      lost: (source, owner, token) => {
        if (token) audioReading?.sourceLost(token);
        if (source === 'microphone' && media.state.voiceOwner === owner) {
          const previous = { ...media.state }; media.update({ voiceInput: false }, owner); mediaChanged(previous);
        }
      },
    });
    audioReading = new AudioReadingHostBroker(randomUUID(), {
      acquire: async value => {
        const lease = await audioCapture!.acquire(value);
        if (!value.signal.aborted) readingReadyAt ??= Date.now();
        return lease;
      },
      transcribe: async (input, signal) => {
        const current = () => {
          const capture = audioReading!.currentCapture(input.source);
          return !!capture && capture.captureId === input.captureId && capture.scopeId === input.scopeId && capture.epoch === input.epoch;
        };
        if (ambientAudio?.busy) {
          try { await ambientAudio.pauseAndDrain(); } finally { suspendAmbientSpeech(); }
        }
        audioReading!.reportProcessing(input, 'recognizing');
        const result = await foregroundAsr.runBackground(signal, current, active => ambientAsr.transcribe(input.wav, active)); // 识别方式
        readingLanguages.set(input.segmentId, result.language);
        while (readingLanguages.size > 16) readingLanguages.delete(readingLanguages.keys().next().value!);
        return { text: result.text };
      },
      publicationReady: ticket => { void archiveReading(ticket); return undefined; },
      viewChanged: view => { broadcast('desk:audio-reading-view', view); return undefined; },
      tally: kind => listenTally.add(kind),
    });
  }
  async function archiveReading(ticket: AudioReadingPublicationTicket): Promise<void> {
    // I-016: a piece joins its segment in electron/senses/listen-together/ (raw for the latest few segments, then a note), not the long-term archive
    const language = readingLanguages.get(ticket.segmentId); readingLanguages.delete(ticket.segmentId);
    if (listenTogether) listenTogether.accept(ticket, language); else ticket.discard();
  }

  async function initAmbientAudio(): Promise<void> {
    // Made before the ready chain runs this, and never replaced; the companion window and its drag are made later, so they are read at use.
    const { store, companion, characterCards, pending, listenKind } = needs;
    ambientStore = new AudioReadingArchive(store.directory);
    await ambientStore.load();
    await ambientStore.repairCommentCopies(companion.currentScope(), companion.memory);
    await ambientStore.reconcile(companion.currentScope());
    ambientAudio = new AmbientAudioRuntime({
      store: ambientStore, getScope: () => companion.currentScope(), getContextIdentity: speechScope,
      getVoiceConfig: () => ({ ...store.current.voiceInput!, language: '' }),
      canStart: owner => { const { pet } = needs; // read when called
        return process.platform === 'win32' && !!pet && !pet.isDestroyed()
        && owner === pet.webContents.id && onScreen(pet) /* 2026-11-21: hidden only because she is out in Unbound still counts (stage-cleanup keeps the sound running then) */
        && ambientAsr.ready(); },
      canTranscribe: () => !asrTask && !foregroundAsr.busy && systemAudio.state.active,
      canDispatch: () => Date.now() >= ambientRetryAt && Date.now() - ambientLastDispatchAt >= 2000,
      isSpeaking: () => replySpeechBusy() || ambientSpeakingOwners.size > 0,
      transcribe: async (_config, wav, signal) => {
        ambientLastDispatchAt = Date.now();
        try { return await ambientAsr.transcribe(wav, signal); }
        catch (error) { if (!signal.aborted) ambientRetryAt = Date.now() + 5000; throw error; }
      },
      onState: state => {
        if (!state.active && !readingActive()) ambientComments?.clear();
        broadcast('desk:ambient-state', ambientAudioView()); updateReadingPause();
      },
      onTranscript: record => { ambientComments?.noteTranscript(record); broadcast('desk:ambient-changed', undefined); },
    });
    const watchConditions = () => { const screen = media.state.screenSharing === true && !lookTurns.refusedIn(lookState()); return { screen, watch: screen && !!listenTogether && listenWordsOn(audioReading?.getView()) }; };
    watchContinuity = new WatchContinuity({ now: Date.now, characterId: () => journalCharacterId(), watching: () => watchConditions().watch, screenOpening: () => media.openings.screen,
      screenAllowed: () => watchConditions().screen, userTurnInFlight: () => [...pending.values()].some(task => task.kind === 'chat'),
      journal: row => { appJournal.record({ type: 'watch-change', characterId: journalCharacterId(), ...row }); },
      // Back on through the user's own switch path (the one the Unbound box and the permission bundle use); true only when the dialogue really is on afterwards.
      resume: async () => { const switches = needs.perceptionSwitches; if (!switches) return false; await switches.set('system_audio', true, ['movie'], () => {}); return watchConditions().watch; } });
    watchContinuity.attachSpeaker((facts, characterId) => watchSpeaker ? watchSpeaker(facts, characterId) : Promise.resolve('undelivered'));
    offWatchUserOff?.(); offWatchUserOff = onWatchUserOff(() => watchContinuity?.userOff()); // the user's own off while her window is away: not started again
    watchTogether = new WatchTogether({ directory: store.directory, characterId: () => companion.currentScope().characterId, // I-048 和她一起看: only while the screen and 一起听 are both on
      conditions: watchConditions,
      capture: async signal => { const frame = await screenSnapshots.sampleOnce(signal, why => { if (why === 'capture-failed') watchContinuity?.captureMissed(); }); if (frame) watchContinuity?.captureOk(); return frame?.dataUrl ?? null; }, prepare: prepareWatchFrame,
      readListenNote: id => listenTogether?.core.readNote(id) ?? null, previousLines: recentLines, interest: kind => userGaze.screenInterest(kind), // I-081: how worth watching the screen is, same call
      hearing: () => watchHearingOf(audioReading?.getView()), ended: (why, lastedMs) => { appJournal.record({ type: 'watch-off', characterId: journalCharacterId(), why }); watchContinuity?.ended(why, lastedMs ?? 0); }, began: () => watchContinuity?.began() }); // I-187: the minute tally says why the dialogue did not reach her
    listenTogether = new ListenTogether({ directory: store.directory, kinds: listenKind.host, characterId: () => companion.currentScope().characterId,
      listening: () => listenWordsOn(audioReading?.getView()), quick: async (prompt, system, signal) => (await quickLineWithClaude(prompt, system, signal)).text,
      changed: () => broadcast('desk:listen-together-changed', undefined), budgeted: true, ports: watchTogether.listenPorts() }); // I-010: the opening choice's budget roll is the soft cap
    await listenTogether.load(); listenTogether.start(); watchTogether.start(); // I-016 一起听
    initAudioReading();
    const commentPorts: ConstructorParameters<typeof AmbientComments>[0] = {
      store: ambientStore, gate: proactiveSpeechGate,
      currentSession: currentAmbientSession,
      canComment: () => { const { petWindowDrag } = needs; // read when called
        return herOnScreen()
        && !petWindowDrag?.active && Date.now() >= userInputUntil && companion.mood.get().snapshot.phase === 'idle'
        && !replySpeechBusy() && ambientSpeakingOwners.size === 0
        && ![...pending.values()].some(task => task.kind === 'chat'); },
      persona: () => compileCharacterPersona(characterCards.getActive()), speechLanguage: () => cardLanguageOf(characterCards.getActive()), moodText: () => companion.mood.chatContext(),
      recentChat: proactiveChatFor(() => ({ companion, characterCards })), // I-178: both 系统音频 comments and her 一起听 pause line carry what you two talked about lately
      generate: async (prompt, signal) => {
        const settings = structuredClone(store.current); settings.persona = prompt;
        let text = '';
        const push = (value: string) => { text += value; if (text.length > 4000) throw new Error('系统音频评论过长。'); };
        if (settings.provider.kind === 'claude') await streamClaude({ kind: 'chat', model: settings.provider.model,
          workingDirectory: path.join(store.directory, 'chat'), writable: false,
          prompt, imageDataUrls: [], imageTemporaryRoot: path.join(app.getPath('temp'), PROFILE_FOLDER, 'chat'), ...ambientCallSystem(),
        }, signal, (type, value) => { if (type === 'delta') push(value); });
        return text;
      },
      offer: offer => { const { pet } = needs; /* read when called */ if (pet && !pet.isDestroyed()) pet.webContents.send('desk:ambient-comment-offer', { id: offer.id, sessionId: offer.sessionId, text: offer.text, ...unbound?.holdLine(offer.id, offer.text) }); },
    };
    ambientComments = listenTogether.comments(commentPorts, new AmbientComments(commentPorts), () => companion.mood.get().snapshot); // I-016: her pause-point line shares these ports
  }
  return {
    provides: { ambientSpeakingOwners, readingPaused, listenTally, systemAudio, ambientAsr, noteStuck, stopSystemAudio, cancelAmbientPlayback, suspendAmbientSpeech, readingContextIdentity, readingActive, allowsOwnedMedia, currentAmbientSession, initAmbientAudio },
    /** 语音输入 journals a stuck microphone window through the same pause journal. */
    journalStuck,
    register(registrar: PartIpc): void {
      const { host, scopedHost } = registrar;
      // What the handlers read: set before the ready chain registers (registerIPC) and not replaced later.
      const { pet, companion, controls, store, characterCards, pending } = needs;
      // 听: 读取音频 and audio capture, the audio dance, the computer's sound and the old ambient listening, its transcripts and comments, voice input.
      host('getAudioReadingView', () => audioReading!.getView(), false);
      host('getAudioCaptureState', () => audioCapture!.getState(), false);
      scopedHost('setAudioReadingIntent', async (sender, value) => {
        const intent = parseAudioReadingIntent(value);
        if (!intent) throw Error('音频来源/用途开关不正确。');
        { const cause = offCauseOfIntent(intent, !!needs.pet && onScreen(needs.pet)); if (cause) noteWatchOffCause(cause); } // no-pet-ok: the companion window handle; 2026-11-24: for the one-row journal note: only an off while she is on the screen is the user's (再续)
        if (intent.enabled && (sender !== pet?.webContents.id || !onScreen(pet)))
          throw Error('请在可见桌宠中明确开启读取音频。');
        const refused = intent.enabled ? ambientAsr.blocked('pet') : null; // the local component, or 识别方式 is not local ('not-local')
        if (refused) { if (intent.source === 'system-audio') audioCapture!.setDance(true, 'system-audio'); // I-016: no words yet, the rhythm still on
          pet?.webContents.send('desk:audio-reading-refused', refused); return refusedReadingAck(audioReading!.getView(), intent.source, intent.purpose); }
        const before = audioReading!.getView();
        if (intent.enabled && !readingActive(before)) {
          ambientAudio?.stop(); audioReading!.changeScope(randomUUID());
          readingStartedAt = Date.now(); readingReadyAt = null; readingLanguages.clear();
        }
        const changed = before.sources[intent.source][intent.purpose].intent !== intent.enabled;
        const operationScope = audioReading!.getView().scopeId, context = readingContextIdentity();
        const ack = await audioReading!.setIntent(intent.source, intent.purpose, intent.enabled);
        if (intent.source === 'system-audio') audioCapture!.setDance(listenSwitchOn(audioReading!.getView(), false), 'system-audio'); // I-016: one switch = rhythm (M1) and words
        if (audioReading!.getView().scopeId !== operationScope || readingContextIdentity() !== context) return ack;
        if (changed) {
          audioCapture!.touch(intent.source); ambientStore.clearSourceTransient(companion.currentScope(), intent.source);
          cancelAmbientPlayback(); ambientComments?.clear();
        }
        if (!readingActive()) ambientStore.clearTransient(companion.currentScope());
        suspendAmbientSpeech(); return ack;
      }, false);
      scopedHost('ackAudioCapture', (sender, value) => audioCapture!.ack(ownerFor(sender), value), false);
      scopedHost('setAudioDanceIntent', (sender, enabled) => {
        if (sender !== pet?.webContents.id) throw Error('只有桌宠窗口可开启音频律动。');
        return audioCapture!.setDance(enabled);
      }, false);
      scopedHost('setAudioDanceSourceIntent', (sender, value) => {
        const intent = parseAudioDanceIntent(value);
        if (!intent) throw Error('音频律动来源/开关不正确。');
        if (sender !== pet?.webContents.id) throw Error('请在桌宠中明确选择音频律动来源。');
        return audioCapture!.setDance(intent.enabled, intent.source);
      }, false);
      scopedHost('submitAudioDanceSample', (sender, value) => {
        const frame = audioCapture!.acceptDanceSample(ownerFor(sender), value);
        if (frame) relayDance(frame); // batch F: her full-screen page while she is out (the sense bridge checks the dance is on)
        if (!frame || !pet || pet.isDestroyed() || !pet.isVisible() || pet.isMinimized()) return false;
        pet.webContents.send('desk:audio-dance-sample', frame);
        return true;
      }, false);
      scopedHost('submitAudioReadingPcm', (sender, value) => {
        const input = parseAudioReadingPcm(value);
        if (!input) throw Error('背景音频片段格式不正确。');
        const descriptor = audioCapture!.getState().slots[input.token.source];
        if (!descriptor || descriptor.owner !== ownerFor(sender) || descriptor.id !== input.token.captureId
          || descriptor.revision !== input.captureRevision || !descriptor.ambient
          || descriptor.ambient.epoch !== input.token.epoch || descriptor.ambient.scopeId !== input.token.scopeId)
          return { accepted: false, reason: 'inactive' };
        const end = input.startedAtMs + input.pcm16.byteLength / 32;
        if (input.startedAtMs < readingStartedAt || end > Date.now() + 250) return { accepted: false, reason: 'invalid-time' };
        return audioReading!.submitSegment(input.token, { sequence: input.sequence, startedAtMs: input.startedAtMs, pcm16: input.pcm16 });
      }, false);
      host("getSystemAudioState", () => systemAudio.state, false);
      host('getAmbientAudioState', () => ambientAudioView(), false);
      scopedHost('beginAmbientAudio', (sender, mode) => {
        if (readingActive()) throw Error('请先关闭当前读取音频，再启用旧版声音理解。');
        ambientAudio!.begin(sender, mode); cancelAmbientPlayback(); ambientComments?.clear();
        suspendAmbientSpeech(); return ambientAudioView();
      }, false);
      scopedHost('stopAmbientAudio', (sender, expectedSessionId) => {
        if (expectedSessionId !== undefined && (typeof expectedSessionId !== 'string' || expectedSessionId !== ambientAudio!.getState().sessionId)) return ambientAudioView();
        ambientAudio!.stop(controls?.webContents.id === sender ? undefined : sender);
        cancelAmbientPlayback(); ambientComments?.clear(); return ambientAudioView();
      }, false);
      scopedHost('setAmbientAudioSpeaking', (sender, speaking, fillerShape) => {
        if (typeof speaking !== 'boolean') throw new Error('朗读状态不正确。');
        // 2026-11-20: her short sound in a call (a second argument): only her mouth in Unbound; never a reply's speaking owner, nothing else is held back for it.
        if (fillerShape !== undefined) { needs.voiceCall.addOn.filler(speaking); unbound?.fillerMouth(sanitizeFillerShape(fillerShape)); return; } // I-197: her filler keeps the echo guard while her reply is silent
        if (speaking) ambientSpeakingOwners.add(sender); else ambientSpeakingOwners.delete(sender);
        suspendAmbientSpeech();
        unbound?.speaking(ambientSpeakingOwners.size > 0); // Unbound v1 step 2: her mouth follows the voice while she is out
      }, false);
      scopedHost('submitAmbientAudio', (sender, value) => ambientAudio!.submit(sender, value), false);
      scopedHost('confirmAmbientAudioCapture', (sender, sessionId) => {
        if (!systemAudio.displayStreams(sender, true, true)) throw new Error('系统声音采集尚未授权。');
        ambientAudio!.confirmCapture(sender, sessionId);
      }, false);
      host('listAmbientTranscripts', async query => {
        const scope = companion.currentScope(), context = readingContextIdentity();
        const repair = await ambientStore.repairCommentCopies(scope, companion.memory);
        await ambientStore.reconcile(scope);
        if (readingContextIdentity() !== context) throw Error('音频档案范围已切换，请重新读取。');
        if (repair.copied || repair.deleted) { broadcast('desk:ambient-changed', undefined); broadcast('desk:memory-changed', undefined); }
        return ambientStore.list(scope, query);
      });
      host('readAmbientTranscript', id => {
        const record = ambientStore.read(companion.currentScope(), id);
        if (!record) throw new Error('系统音频文字记录不存在或已经删除。');
        return record;
      });
      host('readAmbientComments', id => ambientStore.comments(companion.currentScope(), id));
      scopedHost('acknowledgeAmbientComment', (sender, id) => mutate(async () => {
        const session = currentAmbientSession();
        if (!session || session.owner !== sender) return null;
        const identity = speechScope();
        const generation = ambientDeliveryGeneration, deadline = Date.now() + 20_000;
        const expressionScope = `${identity}:${companion.mood.get().token}`;
        const awaiting = ambientComments!.awaitingPresentation(sender, id);
        const presentation = replySurface();
        if (!awaiting || !presentation || !await presentation.waitForPresentation(awaiting.offer.text, awaiting.signal)
          || replySurface() !== presentation || !presentation.isPresentationCurrent(awaiting.offer.text)) return null;
        const comment = await ambientComments!.acknowledge(sender, id);
        if (!comment) return null;
        await companion.memory.appendInitiative(session.scope, { id: comment.id, text: comment.text, at: comment.createdAt,
          origin: { kind: 'proactive', id: comment.id, at: comment.createdAt, sources: ['ambient'], labels: ['外部音频资料'] } });
        broadcast('desk:ambient-changed', undefined); broadcast('desk:memory-changed', undefined);
        if (ambientDeliveryGeneration !== generation || Date.now() > deadline || Date.now() < userInputUntil
          || speechScope() !== identity || `${speechScope()}:${companion.mood.get().token}` !== expressionScope
          || currentAmbientSession()?.sessionId !== session.sessionId || replySpeechBusy() || ambientSpeakingOwners.size > 0
          || replySurface() !== presentation || !presentation.isPresentationCurrent(awaiting.offer.text)) return null;
        if ([...pending.values()].some(task => task.kind === 'chat')) return null;
        const card = characterCards.getActive(), snapshot = companion.mood.get().snapshot;
        const mood = { primary: snapshot.primary, context: snapshot.context };
        const config = characterTtsConfig(store.current, card);
        replySpeechStyles.begin(sender, comment.id, identity);
        replySpeechStyles.complete(sender, comment.id, identity, mood, composeSpeechConfig(config, mood, characterSpeechPersona(card), completedFatigueFeeling(identity, card.id)));
        lastAmbientSpeech = { owner: sender, id: comment.id, text: awaiting.offer.text, presentation };
        broadcast('desk:ambient-comment', comment);
        return { comment, context: { replyId: comment.id } };
      }), false);
      scopedHost("setSystemAudioSharing", (sender, enabled) => {
        if (sender !== pet?.webContents.id) throw new Error("只有桌宠窗口可以开启系统音频共享。");
        if (enabled === true && !onScreen(pet)) throw new Error("请先显示桌宠再开启系统音频共享。");
        const state = systemAudio.setSharing(enabled, sender);
        broadcast("desk:system-audio", state); publishSenses();
        return state;
      }, false);
    },
  };
}

export type ListenPart = ReturnType<typeof wireListen>;
