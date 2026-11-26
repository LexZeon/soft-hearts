// 声音's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-4b.md):
// her reading voice (the speech runtime, the frozen reply styles, the reply's sentence-by-sentence plan and its display proofs, the
// read-aloud cancel paths, the speech scope), the voice call (I-091: its host, its VAD bridge I-099, a call's sentence-by-sentence
// reading), the Drama 3 monthly budget (I-070), the developer speech log (R02) and the playback lease that keeps her awake while she speaks.
// Moved from electron/main.ts; the statements are the ones main.ts had.
// - wireVoice runs where main.ts made the voice call (before the chat's Claude process is made: it reads the call's timing), while main.ts
//   is evaluated; everything it makes is side-effect free on construction (moving speechRuntime and friends up changes nothing).
// - What the lines read from the rest of the app comes through VoiceNeeds (getters electron/main.ts gives). The other parts' functions are
//   taken once (main.ts's wrappers read its own functions when called); a value is read when it is used: `const { store } = needs; // read
//   when called` at the top of a function, `needs.<name>` inside a constructor's ports. register() takes the values the ready chain set
//   before it registers (registerIPC) and never replaces; lastAmbientSpeech (the 系统声音 line) is read and cleared through needs.
// - register() runs inside the agent channel's recorder, where main.ts registered the speech handlers.
// - The two save steps (saveTtsKey, saveStopsSpeech) are top-level functions: electron/main.ts's wireSaveSettings list names them in the
//   order the old saveSettings had them, and the wiring golden expands their bodies in place. They call the part's speechRuntime and
//   clearReplySpeech through the two bindings below (set by wireVoice, before any save can run).
// The before-quit lines (speechPlaybackActivity, speechRuntime, voiceCall) and the window events stay in electron/main.ts's ordered
// lists, reading the names main.ts takes from provides.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { shell, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AppSettings } from '../../shared/contracts';
import type { MediaOwner, RuntimeState } from '../../shared/foundation/runtime-state';
import type { JournalInput, PauseStuckKind } from '../../shared/memory';
import type { FatiguePhase } from '../../shared/mood';
import { BUBBLE_FOLLOW_KNOBS, bubbleFollowMode, characterTtsConfig, settingsSaveCutsReading, type ReadingCancelBy } from '../../shared/voice';
import { CallDeviceJudge, FrozenReadingVoices, fishVoiceSynthesizer, ReadNotes, readingScope, readingVoice, speechFailureEntry, cancelReplySpeechTransport, CallStreamingSpeech, CallVadBridge, characterSpeechPersona, CompletedReplySpeech,
  FishBudget, registerFishVoiceIpc, resolveTtsKey, SpeechDiagnosticsLog, SpeechPlaybackActivity, SpeechRuntime, speechSynthesizer } from '../voice';
import { VoiceCallHost } from '../voice/voice-call/host';
import { callSurfaceShown } from '../voice/voice-call/surface';
// 感知's wiring makes the voice chat host (R33, voice input: electron/wiring/senses-wiring.ts). Its class is not on 声音's public page (it
// imports the companion, which imports that page), so the senses wiring reaches it through 声音's wiring (wiring rewrite step 4c).
export { VoiceChatHost, type VoiceAppCapture } from '../voice/voice-chat-host';
import { prepareCharacterSpeechPreview } from '../voice/speech-preview';
import { composeSpeechConfig, ReplySpeechStyles } from '../mood';
import { chatAvailability, type CompanionService, type ReplyRhythmHost } from '../brain';
import { quickLineWithClaude } from '../initiative'; // I-177 batch 2: the device judgement's one haiku call
import type { CharacterCardStore } from '../cards';
import type { AppJournal, TextMemorialHost } from '../memory';
import type { AudioCaptureHost, FeedCueSynth, LocalAsrHost, VisionPresentationGuard, VoiceRoute } from '../senses';
import type { ReplyProofSurface, UnboundHost } from '../unbound';
import { inputCallPort } from '../unbound';
import type { SettingsStore } from '../settings';
import type { PartIpc } from './ipc-wiring';
import type { PartHandle } from './parts-wiring';
import { broadcast, ownerFor, windows } from './shell-wiring';
import { unboundInputCall } from './unbound-wiring';
import { wireVoiceKeep } from './voice-keep-wiring';
import { callStreamingSpeechFor } from './voice-call-speech-wiring';

/** 系统声音's last line being read (electron/main.ts lastAmbientSpeech): only its own display proof may let it speak. */
export type AmbientSpeechLine = { owner: number; id: string; text: string; presentation: ReplyProofSurface };
/** Her own proactive line being read (electron/main.ts lastVisionSpeech; the inner loop's lines carry their own guard). */
export type VisionSpeechLine = { owner: number; id: string; guard?: Pick<VisionPresentationGuard, 'canSpeak'> };

/** What the voice wiring reads from the rest of the app (electron/main.ts gives getters; each read when it is used). */
export interface VoiceNeeds {
  /** Undefined until the ready chain made it (the voice call and the logs read it optionally, as before). */
  readonly store: SettingsStore;
  readonly pet: BrowserWindow | null;
  readonly controls: BrowserWindow | null;
  readonly companion: CompanionService;
  readonly characterCards: CharacterCardStore;
  /** 感知: the camera, microphone and screen switches (electron/senses/media-runtime.ts MediaRuntime). */
  readonly media: { readonly state: RuntimeState; update(value: unknown, owner: MediaOwner, resolveVoiceOwner?: (requested: MediaOwner) => MediaOwner): RuntimeState };
  readonly audioCapture: Pick<AudioCaptureHost, 'selectChatOwner'> | null;
  readonly localAsr: LocalAsrHost | null;
  readonly voiceRoute: Pick<VoiceRoute, 'engine'>;
  /** 大脑: the chat's Claude process (electron/brain/claude-session.ts PersistentClaudeChat); a call keeps it warm. */
  readonly claudeChat: { holdWarm(on: boolean): void };
  readonly replyRhythm: ReplyRhythmHost;
  readonly appJournal: AppJournal;
  /** 体验记录's extra rows (electron/memory/journal/extras.ts JournalExtras). */
  readonly journalExtras: { speechRecord(value: unknown): void; readonly reading: { unread(why: 'off' | 'hidden'): void }; readonly readCancel: { note(by: ReadingCancelBy): void }; readonly readNotes: ReadNotes };
  readonly textMemorialHost: TextMemorialHost | null;
  /** The companion's reply window (electron/brain/reply-window.ts PetReplyWindow); null until the ready chain made it. */
  readonly petReply: ReplyProofSurface | null;
  /** I-165 `bubbleHold`: her full-screen bubble shows a read-aloud reply as her voice reaches it (absent in older test sandboxes). */
  readonly unbound: (Pick<UnboundHost, 'state'> & Partial<Pick<UnboundHost, 'bubbleHold'>>) | null;
  readonly visionPresentation: VisionPresentationGuard;
  lastAmbientSpeech: AmbientSpeechLine | null;
  readonly lastVisionSpeech: VisionSpeechLine | null;
  /** 感知 B06: the feeding cues' fixed short clips. */
  readonly feedCueSynth: Pick<FeedCueSynth, 'clip'>;
  // The other parts' functions (electron/main.ts's wrappers; taken once).
  suspendAmbientSpeech(): void;
  syncFatigueActivity(): void;
  noteStuck(what: PauseStuckKind): void;
  replySurface(): ReplyProofSurface | null;
  herOnScreen(): boolean;
  mediaChanged(previous: RuntimeState): void;
  journalCharacterId(): string | null;
  completedFatigueFeeling(scope: string, cardId: string): Readonly<{ phase: FatiguePhase }> | undefined;
  noteVisionUserActivity(): void;
}

export interface VoiceProvides {
  readonly replySpeechStyles: ReplySpeechStyles;
  readonly completedReplySpeech: CompletedReplySpeech;
  readonly voiceCall: VoiceCallHost;
  readonly speechRuntime: SpeechRuntime;
  readonly callStreamingSpeech: CallStreamingSpeech;
  readonly speechPlaybackActivity: SpeechPlaybackActivity;
  /** Ends the reply being read (or the one with this id); false when a window did not get the cancel. */
  cancelCompletedReply(id?: string, by?: ReadingCancelBy): boolean;
  replySpeechBusy(): boolean;
  clearReplySpeech(): void;
  cancelReplyStyle(id: string, by?: ReadingCancelBy): boolean;
  dropReplySpeechOwner(owner: number): void;
  /** The conversation and model this voice belongs to. Throws while the context changes. */
  /** I-209 stage voice: with a reply id, the scope that reading is current under (someone else on stage: hers). */
  speechScope(replyId?: string): string;
  /** Same speech style freeze for a confirmed visual or inner-loop line before its readout. */
  beginInitiativeSpeech(sender: number, id: string, owner?: string): void;
}

// The two save steps below call these (set by wireVoice, which runs while electron/main.ts is evaluated, long before any save).
let speechRuntime!: SpeechRuntime;
let clearReplySpeech!: () => void;
function keepForSaveSteps(runtime: SpeechRuntime, clear: () => void): void { speechRuntime = runtime; clearReplySpeech = clear; }

/** Save step (声音): a key the window does not see stays. */
export function saveTtsKey(next: AppSettings, _baseline: unknown, store: SettingsStore): void {
  if (next.tts) next.tts = resolveTtsKey(next.tts, store.current.tts);
}
/** Save step (声音): another model (another character on stage) stops what is being read. A voice, rate, volume or provider change does not: it applies from her next reply (2026-11-25, shared/voice/interrupt-policy.ts). */
export function saveStopsSpeech(next: AppSettings, _baseline: unknown, store: SettingsStore): void {
  if (settingsSaveCutsReading(store.current, next)) {
    speechRuntime.stop();
    clearReplySpeech();
  }
}

export function wireVoice(needs: VoiceNeeds): PartHandle<VoiceProvides> & { register(ipc: PartIpc): void } {
  // The other parts' functions the moved lines call (electron/main.ts's wrappers read its own functions when called).
  const { suspendAmbientSpeech, syncFatigueActivity, noteStuck, replySurface, herOnScreen, mediaChanged, journalCharacterId, completedFatigueFeeling,
    noteVisionUserActivity } = needs;
  const replySpeechStyles = new ReplySpeechStyles();
  // I-165: her bubble shows each sentence when its audio starts (shared/voice/bubble-follow/knobs.ts mode, the constant both windows read).
  const completedReplySpeech = new CompletedReplySpeech(undefined, { follow: () => bubbleFollowMode() !== 'off' });
  // I-091 像打语音电话一样和她聊天 (electron/voice/voice-call/host.ts): the call mode on top of voice input; the ports are read when used.
  const voiceCall: VoiceCallHost = new VoiceCallHost({
    now: () => Date.now(),
    media: () => needs.media.state,
    turnOnVoice: owner => { const previous = { ...needs.media.state }; let next; try { next = needs.media.update({ voiceInput: true }, owner, value => needs.audioCapture?.selectChatOwner(value) ?? value); } catch { return false; } mediaChanged(previous); return next.voiceInput === true; },
    turnOffVoice: owner => { const previous = { ...needs.media.state }; needs.media.update({ voiceInput: false }, owner); mediaChanged(previous); },
    windowShown: owner => { const shown = (win: BrowserWindow | null | undefined) => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized(); return callSurfaceShown(owner, { pet: shown(needs.pet), controls: shown(needs.controls), held: !!needs.unbound && needs.unbound.state !== 'normal' }); }, // Unbound v1 step 3: out in Unbound, the call goes on
    out: () => !!needs.unbound && needs.unbound.state !== 'normal',
    asleep: () => { const fatigue = needs.companion?.mood.get().fatigue; return fatigue?.sleeping === true || fatigue?.phase === 'falling-asleep'; },
    ttsConfig: () => needs.store?.current.voice.enabled ? characterTtsConfig(needs.store.current, needs.characterCards.getActive()) : null,
    characterId: () => needs.characterCards.getActive().id,
    mood: () => { const view = needs.companion.mood.get(); return { values: view.snapshot.values, baseline: view.parameters.baseline, A: view.fatigue?.A ?? null }; }, // read only
    keepWarm: on => needs.claudeChat.holdWarm(on),
    cancelReading: id => { noteReadCancel('interrupt'); callStreamingSpeech.cancelAll(); cancelCompletedReply(id ?? undefined); }, // step 4: talking over her ends the host's sentence-by-sentence reading too
    sentence: (id, index) => completedReplySpeech.segmentRange(id, index), writtenText: id => callStreamingSpeech.writtenText(id), // I-204: where her voice is, and what she wrote, for the cut note
    broadcast: view => { if (!view.on) noteReadCancel('hang-up'); broadcast('desk:voice-call', view); unboundInputCall().changed(view.on === true); }, // the Unbound input box's 打电话 / 挂断 label follows
    journal: entry => { needs.appJournal.record({ type: 'voice-call', characterId: journalCharacterId(), ...entry } as JournalInput); },
    directory: () => needs.store ? needs.store.directory : null,
    synthesize: (config, text, signal, emit, context) => speechSynthesizer(fishVoiceSynthesizer(fishBudget))(config, text, signal, emit, context), // Drama 3 under its monthly limit, one more try when it never connected
  });
  // I-177 batch 2: Claude's judgement of a new device set (haiku, the user's own Claude; only while it answers, a daily cap; electron/voice/call-device-judge.ts).
  const callDeviceJudge = new CallDeviceJudge({ ask: async (prompt, systemPrompt, signal) => (await quickLineWithClaude(prompt, systemPrompt, signal)).text, available: () => chatAvailability.isAvailable() });
  unboundInputCall().connect(inputCallPort(voiceCall)); // the input box's 打电话 button = the companion window's button (no-pet-ok: owner value 'pet' is the call host's name for her companion window, which holds the microphone while she is out)
  // R02 developer-mode speech timing: numbers and voice IDs only, never text (see electron/voice/speech-diagnostics.ts).
  const speechDiagnostics = new SpeechDiagnosticsLog({ enabled: () => !!needs.companion?.mood.isDeveloperMode(),
    file: () => needs.store ? path.join(needs.store.directory, 'dev', 'speech-events.jsonl') : null });
  /** Who cancels a reading, for the journal's reading-time line (closed words; electron/voice/read-cancel-cause.ts). Never blocks a cancel. */
  function noteReadCancel(by: ReadingCancelBy): void { try { needs.journalExtras.readCancel.note(by); } catch { /* journal only */ } }
  function cancelCompletedReply(id?: string, by?: ReadingCancelBy): boolean {
    const current = completedReplySpeech.identity();
    // I-221: noted only when a reading is cancelled here; a note with nothing to cancel stayed and named a later, unrelated cut ('window' at start-up, 'superseded' at each new message).
    if (by && ((current && (id === undefined || current.id === id)) || id !== undefined)) { try { noteReadCancel(by); } catch { /* journal only */ } }
    let delivered = false;
    if (current && (id === undefined || current.id === id)) {
      delivered = true;
      completedReplySpeech.cancel(current.owner, current.id);
      speechRuntime.cancelReply(current.owner, current.id);
      replySpeechStyles.cancel(current.id);
      for (const win of windows()) {
        try { win.webContents.send('desk:reply-speech-cancelled', current.id); } catch { delivered = false; }
      }
    } else if (id !== undefined) completedReplySpeech.cancelReply(id);
    try { needs.unbound?.bubbleHold?.release(id ?? current?.id, 'cancelled'); } catch { /* I-165: her full-screen bubble shows the rest */ }
    suspendAmbientSpeech();
    return delivered;
  }
  function replySpeechBusy(): boolean { return speechRuntime.busy || completedReplySpeech.busy; }
  function clearReplySpeech(): void { cancelCompletedReply(undefined, 'superseded'); completedReplySpeech.clear(); replySpeechStyles.clear(); }
  function cancelReplyStyle(id: string, by?: ReadingCancelBy): boolean { const matched = replySpeechStyles.cancel(id); cancelCompletedReply(id, by); return matched; }
  function dropReplySpeechOwner(owner: number): void {
    speechPlaybackActivity.dropOwner(owner);
    if (completedReplySpeech.identity()?.owner === owner) cancelCompletedReply(undefined, 'window');
    completedReplySpeech.dropOwner(owner); replySpeechStyles.dropOwner(owner);
    suspendAmbientSpeech();
  }
  // I-209 stage voice (electron/voice/stage-voices.ts): a reading of someone else on the full-screen stage is current under her own scope.
  const ownerScope = (owner: string | null) => readingScope(owner, { desk: () => needs.companion.currentScope().characterId, seat: id => needs.companion.speechScopeOf(id),
    deskScope: () => JSON.stringify([needs.companion.currentSpeechScope(), createHash('sha256').update(needs.store.current.model?.path ?? '').digest('hex')]) });
  const speechScope = (replyId?: string) => ownerScope(replyId === undefined ? null : replySpeechStyles.ownerOf(replyId));
  // I-070 Drama 3: this month's spending (<profile>/drama3-usage.json, numbers only) and the paid synthesis that respects it.
  const fishBudget = new FishBudget({ directory: () => needs.store ? needs.store.directory : null, publish: view => broadcast('desk:tts-budget', view) });
  const voiceKeep = wireVoiceKeep({ directory: () => needs.store?.directory ?? null, character: () => { const card = needs.characterCards.getActive(); return { id: card.id, name: card.name }; }, controls: () => needs.controls });
  const frozenVoices = new FrozenReadingVoices<ReturnType<typeof readingVoice>>();
  const speechRuntime = new SpeechRuntime(
    (owner, context) => {
      const { lastAmbientSpeech, lastVisionSpeech, visionPresentation, textMemorialHost, store, characterCards } = needs; // read when called
      const ambient = lastAmbientSpeech;
      if (context && ambient?.id === context.replyId && ambient.owner === owner
        && (replySurface() !== ambient.presentation || !ambient.presentation.isPresentationCurrent(ambient.text)))
        throw new Error('这条系统声音评论已不在当前回复窗显示，语音已结束。');
      if (context && lastVisionSpeech?.owner === owner && lastVisionSpeech.id === context.replyId && !(lastVisionSpeech.guard ?? visionPresentation).canSpeak(context.replyId))
        throw new Error('Visual presentation is no longer current');
      if(context && textMemorialHost?.ownsSpeech(context.replyId) && !textMemorialHost.canSpeak(owner,context.replyId))
        throw Error('文字纪念邀请已不在当前回复窗显示。');
      const make = () => readingVoice(store.current, characterCards, replySpeechStyles.ownerOf(context?.replyId)); // I-209 stage voice: hers
      const config = context ? frozenVoices.of(context.replyId, make) : make(); // 2026-11-25: a reply keeps the voice it started in
      return context ? { ...config, ...replySpeechStyles.resolveStyle(owner, context.replyId, speechScope(context.replyId)) } : config;
    },
    (owner, event) => {
      windows().find(win => win.webContents.id === owner)?.webContents.send('desk:speech', event);
      syncFatigueActivity();
    },
    speechSynthesizer(fishVoiceSynthesizer(fishBudget)),
    // A failed paid reading: one journal line with its category, the error kind, whether it was tried twice and which reply (2026-11-24; electron/voice/speech-failure-record.ts).
    (failure, provider, info) => { needs.appJournal.record(speechFailureEntry(replySpeechStyles.ownerOf(info?.replyId) ?? journalCharacterId(), provider, failure, info, needs.journalExtras.readNotes)); },
    { expired: () => noteStuck('speech-route') },
    replyId => { needs.journalExtras.readNotes.numberOf(replyId); }, // 2026-11-24: the reply gets its number when its first sentence is asked for
    info => voiceKeep.tee(info), // 2026-11-24: dev-only 保存她念出来的声音 (null on stable and packaged builds)
  );
  const callVad = new CallVadBridge({ callOwner: () => voiceCall.on ? voiceCall.controller.owner : voiceCall.wakeOwner(), /* Unbound v1 step 3: also while she listens for her name */ microphoneOwner: () => needs.media.state.voiceInput ? needs.media.state.voiceOwner : null,
    engine: () => needs.voiceRoute.engine === 'local' && needs.localAsr?.ready ? needs.localAsr : null }); // I-099: only the call's own window, only with the local recognizer
  /** Same speech style freeze for a confirmed visual or inner-loop line before its readout. */
  function beginInitiativeSpeech(sender: number, id: string, owner?: string): void { // I-209 step 4: `owner` (a chime-in on stage): her card's voice, her mood, her scope
    const { characterCards, companion, store } = needs; // read when called
    const other = owner && owner !== characterCards.getActive().id ? owner : undefined;
    const card = other ? characterCards.getCard(other) : characterCards.getActive(), snapshot = (other && companion.moodOf?.(other) || companion.mood.get()).snapshot, scope = ownerScope(other ?? null);
    const mood = { context: snapshot.context, primary: snapshot.primary };
    const config = readingVoice(store.current, characterCards, other ?? null);
    replySpeechStyles.begin(sender, id, scope, other); needs.journalExtras?.readNotes?.offered(id); // her reading rows carry her id
    replySpeechStyles.complete(sender, id, scope, mood, composeSpeechConfig(config, mood, characterSpeechPersona(card), completedFatigueFeeling(scope, card.id)));
  }
  // I-091 step 4: in a call her reply is read sentence by sentence (electron/wiring/voice-call-speech-wiring.ts).
  const callStreamingSpeech: CallStreamingSpeech = callStreamingSpeechFor({ needs, plan: completedReplySpeech, styles: replySpeechStyles, voiceCall,
    holding: () => replySpeechBusy(), playback: () => speechPlaybackActivity.busy, cancelled: by => noteReadCancel(by) });
  const speechPlaybackActivity = new SpeechPlaybackActivity();
  /** One exact current native proof, committed in the original immutable lease. */
  async function withCompletedPrefixProof(owner:number,id:string,scope:string,segment:NonNullable<ReturnType<CompletedReplySpeech['next']>>,commit:()=>boolean):Promise<boolean>{
    const { store } = needs; // read when called
    const surface=replySurface(),full=completedReplySpeech.fullPresentationText(owner,id,scope,segment);
    const signal=completedReplySpeech.presentationSignal(owner,id,scope,segment);
    // I-165: with her bubble following the voice, the sentence before this one (none for the first: "……") is what must be on screen.
    const end=completedReplySpeech.proofEnd(owner,id,scope,segment),follows=end>=0&&end<segment.visibleText.length;
    if(!surface||full===null||!signal||end<0||!completedReplySpeech.prefixMode(owner,id,scope,segment))return false;
    const remaining=completedReplySpeech.presentationRemaining(owner,id,scope,segment);
    return surface.waitForCompletedPrefix(()=>completedReplySpeech.fullPresentationText(owner,id,scope,segment),end,signal,
      follows?Math.min(remaining,BUBBLE_FOLLOW_KNOBS.proofWaitMs):remaining,candidate=>{
        if(!store.current.voice.enabled||surface!==replySurface()||scope!==speechScope(id)
          ||!completedReplySpeech.ownsLease(owner,id,scope,segment)
          ||!completedReplySpeech.fullPresentationText(owner,id,scope,segment)?.startsWith(full)
          ||!completedReplySpeech.fullPresentationText(owner,id,scope,segment)!.startsWith(candidate)||candidate.length<end
          ||!(follows?surface.followingText?.()===candidate:surface.isCompletedPrefixCurrent(candidate)))return false; // I-165: following, the bubble up for this reply is enough (never a paint receipt)
        return completedReplySpeech.approvePresentation(owner,id,scope,segment,candidate)&&commit();
      });
  }
  function canBeginSpeechPlaybackActivity(sender: number): boolean {
    const { pet, controls, store, unbound } = needs; // read when called
    const owner = windows().find(win => win.webContents.id === sender);
    if (!owner) return false;
    if ((owner.isVisible() && !owner.isMinimized()) || (owner === pet && owner.isMinimized())) return true; // I-174 item 9: minimized (a step away) she reads on; no-pet-ok: pet is the companion window's existing name
    // Controls may own an ordinary reply while its visible presentation lives
    // in the companion. This sleep blocker follows that acknowledged presentation;
    // synthesis and media permissions keep their separate existing gates.
    if (owner === pet && heldLineSpeakable(sender)) return true; // read-aloud: her own line, proven in her bubble while she is out
    // Unbound v1 step 3: a call from her companion window goes on while she is out; that hidden window reads its replies under the same proof as controls.
    if ((owner !== controls && !(owner === pet && unbound?.state === 'unbound')) || !store.current.voice.enabled
      || !herOnScreen()) return false;
    const scope = speechScope(completedReplySpeech.latestId?.());
    const segment = completedReplySpeech.approvedCurrentSegment(sender, scope);
    const prefix=segment&&completedReplySpeech.prefixMode(sender,segment.replyId,scope,segment);
    const text=segment&&(prefix?completedReplySpeech.approvedPresentationText(sender,segment.replyId,scope,segment.index)
      :completedReplySpeech.fullPresentationText(sender,segment.replyId,scope,segment));
    const surface=replySurface(),follows=!!segment&&completedReplySpeech.proofEnd(sender,segment.replyId,scope,segment)===0; // I-165: following: no paint receipt
    return text!=null&&!!surface&&(prefix?(follows?surface.followingText?.()===text:surface.isCompletedPrefixCurrent(text)):surface.isPresentationCurrent(text));
  }
  function heldLineSpeakable(sender: number): boolean {
    const { unbound, store, lastVisionSpeech, visionPresentation, lastAmbientSpeech } = needs; // read when called
    return unbound?.state === 'unbound' && store.current.voice.enabled && ((lastVisionSpeech?.owner === sender && (lastVisionSpeech.guard ?? visionPresentation).canSpeak(lastVisionSpeech.id))
    || (lastAmbientSpeech?.owner === sender && replySurface() === lastAmbientSpeech.presentation && lastAmbientSpeech.presentation.isPresentationCurrent(lastAmbientSpeech.text))); }
  keepForSaveSteps(speechRuntime, clearReplySpeech);
  return {
    id: 'voice',
    units: ['reply-speech', 'speech-runtime', 'voice-call', 'call-vad', 'call-streaming', 'fish-budget', 'speech-diagnostics', 'speech-playback', 'speech-preview'],
    register(ipc: PartIpc): void {
      const { host, scopedHost } = ipc;
      // What the handlers read: set before the ready chain registers (registerIPC) and not replaced later. lastAmbientSpeech changes:
      // read and cleared through needs at each use.
      const { store, pet, petReply, textMemorialHost, characterCards, companion, journalExtras, feedCueSynth, replyRhythm } = needs;
      journalExtras.readNotes?.whose(id => replySpeechStyles.ownerOf(id)); // I-209 stage voice: someone else's reading rows carry her id
      scopedHost('beginSpeechPlaybackActivity', async (sender, id) => {
        syncFatigueActivity();
        if(!windows().some(win=>win.webContents.id===sender))return null;
        let scope:string;try{scope=speechScope(completedReplySpeech.latestId?.());}catch{return null;}
        const segment=completedReplySpeech.approvedCurrentSegment(sender,scope);
        if(segment&&completedReplySpeech.prefixMode(sender,segment.replyId,scope,segment)){
          let activity:string|null=null;
          await withCompletedPrefixProof(sender,segment.replyId,scope,segment,()=>{
            if(!canBeginSpeechPlaybackActivity(sender))return false;
            activity=speechPlaybackActivity.begin(sender,id);syncFatigueActivity();return activity!==null;
          });
          return activity;
        }
        if (!canBeginSpeechPlaybackActivity(sender)) return null;
        const lease=speechPlaybackActivity.begin(sender,id);
        syncFatigueActivity();
        return lease;
      }, false);
      scopedHost('endSpeechPlaybackActivity', (sender, id, lease) => {
        speechPlaybackActivity.end(sender,id,lease);
        syncFatigueActivity();
      }, false);
      scopedHost('synthesizeSpeech', async (sender, id, text, context) => {
        if(context && textMemorialHost?.ownsSpeech(context.replyId)
          && (!store.current.voice.enabled || context.segmentIndex!==undefined || !textMemorialHost.authorizeSpeech(sender,context.replyId,text)))
          throw Error('文字纪念朗读尚未取得这段原文的当前呈现许可。');
        if (context?.segmentIndex !== undefined || (context && completedReplySpeech.isOrdinary(sender, context.replyId, speechScope(context.replyId)))) {
          if (!store.current.voice.enabled) throw new Error('自动朗读已关闭。');
          const segment = completedReplySpeech.approvedSegment(sender, context.replyId, speechScope(context.replyId), context.segmentIndex);
          const scope=speechScope(context.replyId);
          if(segment&&completedReplySpeech.prefixMode(sender,context.replyId,scope,segment)){
            let operation:Promise<void>|null=null;
            const accepted=await withCompletedPrefixProof(sender,context.replyId,scope,segment,()=>{
              completedReplySpeech.authorizeCloud(sender,context.replyId,scope,context.segmentIndex,text);
              operation=speechRuntime.speak(sender,id,text,context);syncFatigueActivity();return true;
            });
            if(!accepted){
              if(completedReplySpeech.ownsLease(sender,context.replyId,scope,segment)){cancelCompletedReply(context.replyId,'error');throw Error('回复气泡尚未确认显示，本段未开始朗读。');}
              return;
            }
            return (operation as Promise<void>|null)?.finally(()=>syncFatigueActivity());
          }
          const fullText = segment && completedReplySpeech.fullPresentationText(sender, context.replyId, speechScope(context.replyId), segment);
          if (fullText == null || !petReply?.isPresentationCurrent(fullText))
            throw new Error('这段回复尚未确认显示，本段未开始朗读。');
          completedReplySpeech.authorizeCloud(sender, context.replyId, speechScope(context.replyId), context.segmentIndex, text);
        }
        const operation = speechRuntime.speak(sender, id, text, context);
        syncFatigueActivity();
        return operation.finally(() => syncFatigueActivity());
      }, false);
      scopedHost('releaseSpeech', (sender, id) => { if (speechRuntime.release(sender, id)) suspendAmbientSpeech(); }, false);
      scopedHost('recordSpeechDiagnostic', (_sender, record) => { speechDiagnostics.record(record); journalExtras.speechRecord(record); }, false);
      scopedHost('synthesizeFeedCue', (_sender, kind) => !store.current.voice.enabled ? null : feedCueSynth.clip(kind,
        characterTtsConfig(store.current, characterCards.getActive())), false);
      // I-091 像打语音电话一样和她聊天: the call (either window's own button), talking over her, and her short sounds.
      scopedHost('getVoiceCall', () => voiceCall.view(), false);
      scopedHost('setVoiceCall', (sender, on, via) => voiceCall.set(ownerFor(sender), on, via), false);
      scopedHost('callDevicesAsk', (_sender, devices) => callDeviceJudge.ask(devices), false); // I-177 batch 2: either window's call (stripped names; the call never waits)
      scopedHost('voiceCallFiller', (sender, last) => voiceCall.filler(ownerFor(sender), last), false);
      scopedHost('voiceCallFillerClips', sender => voiceCall.clips(ownerFor(sender)), false);
      scopedHost('prepareVoiceCallFillers', (sender, voiceKey) => voiceCall.prepare(ownerFor(sender), voiceKey), false);
      scopedHost('voiceCallVad', (sender, pcm, reset) => callVad.probe(ownerFor(sender), pcm, reset), false); // I-099
      scopedHost('voiceCallTurn', (sender, pcm) => callVad.probeTurn(ownerFor(sender), pcm), false); // I-099/I-100: does the turn sound finished (Smart Turn)
      scopedHost('cancelReplySpeech', (sender, id) => {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('回复语音身份无效。');
        if (completedReplySpeech.isOrdinary(sender, id, speechScope(id))) cancelReplyStyle(id, 'error'); // the window gave up on this reply's reading (its bubble would not show)
      }, false);
      // I-165: the reading window's facts about the sentence being heard; her full-screen bubble shows it then (electron/unbound/bubble-hold.ts).
      // Display timing only: it can only show her own reply's held text sooner (never read, synthesize or prove anything); another id changes nothing.
      // I-197: a sentence's 'start' also ends that call reply's add-on window (only ever makes the next line go through the barge-in gate sooner).
      scopedHost('noteReplySpeechHeard', (sender, id, index, phase) => {
        if (!windows().some(win => win.webContents.id === sender) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)
          || !Number.isInteger(index) || index < -1 || index > 127 || (phase !== 'start' && phase !== 'end' && phase !== 'skip' && phase !== 'over')) return;
        const hold = needs.unbound?.bubbleHold;
        if (phase === 'over') hold?.release(id, 'over'); else if (index >= 0) hold?.heard(id, index, phase);
        if (phase === 'start' && index >= 0) voiceCall.addOn.voiced(id); // I-197: her voice started: a line now is talking over her again
        voiceCall.sentenceHeard(id, index, phase); // I-204: where her voice is in a call reply (the cut point, the echo window)
      }, false);
      scopedHost('nextReplySpeechSegment', async (sender, id, completedIndex) => {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)
          || (completedIndex !== undefined && (!Number.isInteger(completedIndex) || completedIndex < 0 || completedIndex > 127))) throw new Error('回复句段身份无效。');
        if (completedIndex === undefined) needs.journalExtras?.readNotes?.offered(id); // I-209 stage voice: whose reading the rows are
        if (!store.current.voice.enabled || !herOnScreen()) {
          if (completedIndex === undefined) journalExtras.reading.unread(store.current.voice.enabled ? 'hidden' : 'off');
          if (completedReplySpeech.isOrdinary(sender, id, speechScope(id))) cancelReplyStyle(id, store.current.voice.enabled ? 'hidden' : 'switch');
          return null;
        }
        const scope = speechScope(id);
        if(completedReplySpeech.isPrefixReply(sender,id,scope)){
          const fence=await completedReplySpeech.waitForCommit(sender,id,scope);
          if(!fence||scope!==speechScope(id)||!completedReplySpeech.commitCurrent(fence,sender,id,scope))return null;
        }
        replySpeechStyles.resolveStyle(sender, id, scope);
        await needs.unbound?.bubbleHold?.quiet(); // I-203: her lips are on (a kiss from her reply): no new sentence until she pulls back
        if (!await completedReplySpeech.waitForPiece(sender, id, scope, completedIndex) || scope !== speechScope(id)) return null; // R02: next streamed sentence
        const segment = completedReplySpeech.next(sender, id, scope, completedIndex);
        suspendAmbientSpeech();
        if (!segment) return null;
        // The companion's acknowledgement follows all of its older native patches on
        // the same IPC sender. No full-body stream patch may race this new receipt.
        const ready = await completedReplySpeech.waitForPresentationReady(sender, id, scope, segment);
        if (!ready) {
          if (completedReplySpeech.ownsLease(sender, id, scope, segment)) {
            cancelCompletedReply(id,'error');
            throw new Error('回复气泡尚未确认显示，本段未开始朗读。');
          }
          return null;
        }
        if(completedReplySpeech.prefixMode(sender,id,scope,segment)){
          broadcast('desk:reply-speech-segment',segment);
          const accepted=await withCompletedPrefixProof(sender,id,scope,segment,()=>true);
          if(!accepted){
            if(completedReplySpeech.ownsLease(sender,id,scope,segment)){cancelCompletedReply(id,'error');throw Error('回复气泡尚未确认显示，本段未开始朗读。');}
            return null;
          }
          return scope===speechScope(id)&&completedReplySpeech.ownsLease(sender,id,scope,segment)?replyRhythm.withGap(replySpeechStyles.withTone(sender,id,scope,segment)):null;
        }
        const surface = petReply;
        const expected = completedReplySpeech.fullPresentationText(sender, id, scope, segment);
        const signal = completedReplySpeech.presentationSignal(sender, id, scope, segment);
        const shown = surface && signal && expected !== null ? surface.waitForPresentation(expected, signal) : Promise.resolve(false);
        broadcast('desk:reply-speech-segment', segment);
        if (!surface || !await shown
          || petReply !== surface || expected === null || !surface.isPresentationCurrent(expected)
          || scope !== speechScope(id) || !completedReplySpeech.ownsLease(sender, id, scope, segment)
          || completedReplySpeech.fullPresentationText(sender, id, scope, segment) !== expected) {
          if (completedReplySpeech.ownsLease(sender, id, scope, segment)) {
            cancelCompletedReply(id,'error');
            throw new Error('回复气泡尚未确认显示，本段未开始朗读。');
          }
          return null;
        }
        if (!completedReplySpeech.approvePresentation(sender, id, scope, segment)) return null;
        return replyRhythm.withGap(replySpeechStyles.withTone(sender, id, scope, segment)); // R02: the system voice's frozen mood tone (F7: the trial's gap)
      }, false);
      scopedHost('acknowledgeReplySpeechReady', async (sender, id) => {
        if (sender !== pet?.webContents.id || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
          throw new Error('回复呈现准备身份无效。');
        const scope=speechScope(id),identity=completedReplySpeech.identity();
        if(identity?.id===id&&completedReplySpeech.isPrefixReply(identity.owner,id,scope)){
          const fence=await completedReplySpeech.waitForCommit(identity.owner,id,scope);
          return !!fence&&store.current.voice.enabled&&sender===pet?.webContents.id&&scope===speechScope(id)
            &&completedReplySpeech.markPresentationReady(id,scope,fence);
        }
        return store.current.voice.enabled && completedReplySpeech.markPresentationReady(id, speechScope(id));
      }, false);
      scopedHost('prepareCharacterSpeechPreview', sender => {
        noteVisionUserActivity();
        const card = characterCards.getActive();
        const snapshot = companion.mood.get().snapshot;
        return prepareCharacterSpeechPreview({ owner: sender, scope: speechScope(), card,
          config: characterTtsConfig(store.current, card),
          mood: { primary: snapshot.primary, context: snapshot.context }, styles: replySpeechStyles,
          stop: () => speechRuntime.stop(),
        });
      });
      scopedHost('cancelSpeech', (sender, id) => {
        const { cancelled, replyId } = cancelReplySpeechTransport(speechRuntime, sender, id, cancelReplyStyle);
        if (cancelled) {
          if (needs.lastAmbientSpeech?.owner === sender && needs.lastAmbientSpeech.id === replyId) needs.lastAmbientSpeech = null;
        }
        suspendAmbientSpeech();
      }, false);
      host('openTtsConsole', () => shell.openExternal('https://bailian.console.aliyun.com/'));
      host('openTtsGuide', () => shell.openExternal('https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide'));
      registerFishVoiceIpc(host, fishBudget, target => shell.openExternal(target)); // I-070: three fixed operations, no arguments
      voiceKeep.register(ipc); // 2026-11-24: dev-only 保存她念出来的声音: the control window's one handler (nothing is registered on stable builds)
    },
    provides: { replySpeechStyles, completedReplySpeech, voiceCall, speechRuntime, callStreamingSpeech, speechPlaybackActivity, cancelCompletedReply, replySpeechBusy,
      clearReplySpeech, cancelReplyStyle, dropReplySpeechOwner, speechScope, beginInitiativeSpeech },
  };
}
