// Renderer wiring, 声音: this window's voice output, the feeding and thinking cues, the reply-speech queue, Drama 3's month and the reply-speech events (both windows).
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { currentUiLanguage, uiText } from '../foundation/ui-language';
import { EMOTIONAL_VOICE_PREVIEW, VoiceOutput } from "../voice";
import { FishVoiceFallback } from "../voice";
import { FISH_BUDGET_NOTICE } from "../../shared/voice";
import { SharedAudioOutput, chooseCallOutput } from "../voice";
import { CompletedReplySpeechQueue } from "../voice";
import { characterTtsConfig, DEFAULT_TTS_CONFIG, effectiveTtsConfig, isCloudTtsProvider, newCharacterVoice, ttsProviderReady, type ReadingCancelBy, type TtsConfig } from "../../shared/voice";
import { setSystemVoiceWishSource, systemWishOf, type SystemVoiceWish } from "../voice";
import { readingVoices } from '../voice'; // I-209 stage voice: someone else on stage reads in her own voice
import { HeldLines } from '../brain'; // read-aloud while she is out in Unbound (docs/claude/2026-11-15-unbound-read-aloud.md)
import { ReplyThinkingPresenter, systemSpeechBusy } from '../brain';
import { THINK_CUE_KINDS } from '../../shared/initiative';
import { sanitizeFillerShape } from '../../shared/behaviors/voice-call/mouth';
import { FeedSpeechPause } from '../initiative';
import { flashTarget, takeMeThereLeaf } from '../initiative';
import { FeedCuePlayer } from '../initiative';
import { FeedCuePrefetch } from '../initiative';
import { ChosenFeedCues } from '../initiative';
import { isPet, notify, notifyLink, windowKind } from './shell-wiring';
import { controlNavigation, populateVoices, settings } from './settings-wiring';
import { stage } from './stage-wiring';
import { ambientAudioController, callControls, mediaInput, voiceReplyIds } from './voice-chat-wiring';
import { activeChat, activeUser, chatOwner, finishReplySpeechPresentation, hostVisible, ordinaryReplyPresentation, shown, ordinaryVoiceConfig, rememberAmbientComment, rememberInitiative, setSpeechPlaybackErrorShown, speechPlaybackErrorShown } from './chat-wiring';
import { endReplySpeech, replyPresentation, replySpeechContext } from './chat-view-wiring';
import { characterState } from './cards-wiring';
import { petUI } from './pet-window-wiring';
import { emotionalVoiceControls } from './control-window-wiring';
import { awayReadPause, startAwayReadPause, wantAttentionPoll } from './user-attention-wiring'; // I-189 #1
import { speechBeats } from './speech-beats-wiring'; // 边说边演: a beat plays when the reading reaches it
import { bubbleFollow } from './bubble-follow-wiring'; // I-165: her bubble follows her voice
export let speechChannel: BroadcastChannel;
export let voicePlaybackActive = false;
export let speechPreparing = false;
export let windowAudio: SharedAudioOutput;
// I-070: Drama 3's month used up → this window reads in the system voice (switching only between readings).
export const fishFallback = new FishVoiceFallback();
export let speechOutput: VoiceOutput;
export let feedPauseChannel: BroadcastChannel;
export let feedCues: FeedCuePlayer;
export let chosenFeedCues: ChosenFeedCues;
export let thinkingCues: FeedCuePlayer;
export let feedCuePrefetch: FeedCuePrefetch;
export let feedPause: FeedSpeechPause;
export let replyThinking: ReplyThinkingPresenter;
export let replySpeechQueue: CompletedReplySpeechQueue;
export const speech = {
  voices: () => speechOutput.voices(),
  speak: (...args: Parameters<VoiceOutput['speak']>) => { awayReadPause?.cancel(); replySpeechQueue.cancel(); return speechOutput.speak(...args); },
  preview: (...args: Parameters<VoiceOutput['preview']>) => { awayReadPause?.cancel(); replySpeechQueue.cancel(); return speechOutput.preview(...args); },
  previewCharacter: (...args: Parameters<VoiceOutput['previewCharacter']>) => { awayReadPause?.cancel(); replySpeechQueue.cancel(); return speechOutput.previewCharacter(...args); },
  stop: (why?: ReadingCancelBy) => { speechOutput.noteStop(why ?? null); try { awayReadPause?.cancel(); replySpeechQueue.cancel(); speechOutput.stop(); feedPause.cancelCues(); } finally { speechOutput.noteStop(null); } }, // 2026-11-24: why it stopped rides on the cancelled record // I-189: a stop ends a pause for you too
  prewarm: () => { if (settings.voice.enabled) speechOutput.prewarm(); }, // also wakes the output before she speaks (I-150)
  wake: () => { if (settings.voice.enabled) speechOutput.wakeForReply(); }, // I-150: a reply started (typed or in a call)
  dispose: () => { replySpeechQueue.cancel(); speechOutput.dispose(); windowAudio.dispose(); },
};
export let heldLines: HeldLines;
/** This window's voice output, the feeding and thinking cues and the reply-speech queue, made in this order (both windows). */
export function startVoiceOutput(): void {
setSystemVoiceWishSource(systemVoiceWish); // I-162: every system-voice pick (replies, previews, calls, cues) follows her gender and her own voice
speechChannel = new BroadcastChannel("mmd-desk-speaking");
// 2026-11-05 freeze: building an AudioContext can block this window for seconds, so reading aloud, the feeding cues and
// the waiting hum share one output, whose context is built once, early (warmAudioOutput), and resumed after that.
windowAudio = new SharedAudioOutput({ sink: { choose: () => chooseCallOutput() } }); // I-177 batch 2: her cloud voice on the first plugged-in entry of the 「听」 list
speechOutput = new VoiceOutput({
  getTtsConfig: speakingTtsConfig,
  getVoiceConfig: () => settings.voice,
  api: window.desktop,
  audio: windowAudio,
  onSpeaking: active => {
    voicePlaybackActive = active;
    if (active) callControls?.replySound(true); // I-091: her real first sound ends her short "嗯"
    stage?.setSpeaking(active);
    mediaInput?.setSpeaking(active);
    ambientAudioController?.setSpeaking(active);
    void window.desktop.setAmbientAudioSpeaking(active).catch(() => {});
    speechChannel.postMessage(active);
  },
  onState: state => {
    // T-215: "about to speak" (loading: synthesis or the device, before the first sound) lets a mouth face shape start
    // handing back now; a flag and a message only, so the sound itself is not delayed. Sent on changes only.
    const preparing = state.phase === 'loading' ? true : state.phase === 'idle' || state.phase === 'error' ? false : speechPreparing;
    if (preparing !== speechPreparing) { speechPreparing = preparing; stage?.setSpeechPreparing(preparing); speechChannel.postMessage({ prepare: preparing }); }
    fishFallback.playback(state.phase); emotionalVoiceControls?.setPlaybackState(state); feedCuePrefetch.playback(state);
  },
  onError: message => { setSpeechPlaybackErrorShown(true); notify(message, true); },
  onSpeechFace: cue => { stage?.speechFaceCue(cue); speechBeats().voiced(cue); speechChannel.postMessage({ speechFace: cue }); void window.desktop.relaySpeechFace?.(cue)?.catch(() => {}); }, // I-073 part 3: her face while she speaks (batch A: and her full-screen face while she is out)
  // I-165: a sentence of hers became audible / ended / had nothing to say: her bubble (this window, the other one, full-screen Unbound) shows it.
  onSegmentHeard: fact => { bubbleFollow().heard(fact); speechChannel.postMessage({ segmentHeard: fact }); void window.desktop.noteReplySpeechHeard(fact.replyId, fact.segmentIndex, fact.phase).catch(() => {}); awayReadPause?.segment(fact); }, // I-189 #1: a sentence ended: the place to pause if you are away
});
// B06: a snack at her mouth pauses speech and the paced bubble, with a "啊"/"嗯" cue; the companion sees the snack, either window may speak.
feedPauseChannel = new BroadcastChannel('soft-hearts-feed-pause');
feedCues = new FeedCuePlayer({ api: window.desktop, getTtsConfig: currentTtsConfig, getVoiceConfig: () => settings.voice, audio: windowAudio });
// #32: the sound she picked for this snack (the host's pick in the mood view, shared/behaviors/feed-cue/), on the same cue player.
chosenFeedCues = new ChosenFeedCues({ player: feedCues, onMood: listener => window.desktop.onMood(listener) });
// B06: once a reply plays aloud in the Bailian voice, both cues are fetched ahead of the first feed (feed-cue-prefetch.ts).
// X1: the waiting "嗯…" — same cue path, its own player (own cache and playback), warmed together with the feeding cues.
thinkingCues = new FeedCuePlayer({ api: window.desktop, getTtsConfig: currentTtsConfig, getVoiceConfig: () => settings.voice, kinds: THINK_CUE_KINDS, audio: windowAudio });
feedCuePrefetch = new FeedCuePrefetch({ prefetch: () => { feedCues.prefetch(); thinkingCues.prefetch(); }, getTtsConfig: currentTtsConfig, voiceOn: () => settings.voice.enabled });
// I-189 #1: her reading also pauses while you are turned away or gone; the two owners share one pause (src/wiring/user-attention-wiring.ts).
const sharedPause = startAwayReadPause({ targets: [speechOutput, replyPresentation, bubbleFollow()], reading: () => replySpeechQueue?.replyId ?? null, end: endAwayReading });
wantAttentionPoll(() => voicePlaybackActive || speechPreparing || !!mediaInput?.inCall);
feedPause = new FeedSpeechPause({ targets: [sharedPause.as('feed')], // I-165: her bubble's stall clocks wait while she eats broadcast: message => feedPauseChannel.postMessage(message), voiceOn: () => settings.voice.enabled,
  cues: chosenFeedCues });
feedPauseChannel.onmessage = event => feedPause.receive(event.data);
replyThinking = new ReplyThinkingPresenter({ stage: () => stage, cue: thinkingCues, voiceOn: () => settings.voice.enabled,
  // The window that reads this typed reply aloud (a voice conversation's open microphone never hears it).
  speaks: id => activeChat === id && chatOwner === windowKind && !!activeUser && !voiceReplyIds.has(id) && (!isPet || shown()),
  busy: () => feedPause.active || feedPause.state !== 'idle' || voicePlaybackActive || systemSpeechBusy() });
replySpeechQueue = new CompletedReplySpeechQueue(window.desktop,
  segment => speechOutput.speak(segment.text, { ...(ordinaryVoiceConfig ?? settings.voice) }, segment.context),
  () => settings.voice.enabled && (!isPet || shown() || (!!ordinaryReplyPresentation?.call && !!callControls?.readsOut)), // I-174: covered (minimized, the snip) she reads on // Unbound v1 step 3: a call reply while she is out
  replyId => speechOutput.openReply({ ...(ordinaryVoiceConfig ?? settings.voice) }, replyId)); // R02: one Bailian playback per reply
// Read-aloud while she is out: her own lines, already in her Unbound bubble, are acknowledged and read here, never shown on the hidden companion.
heldLines = new HeldLines({ ackVision: id => window.desktop.ackVisionInitiative(id), ackAmbient: id => window.desktop.acknowledgeAmbientComment(id), free: () => isPet && !activeChat,
  voiceOn: () => settings.voice.enabled, speak: (text, context) => speech.speak(text, settings.voice, context), stop: () => speech.stop(), ended: (id, kind) => { if (kind === 'vision') endReplySpeech(id); else petUI?.endAnswerSpeech(id); },
  rememberVision: message => rememberInitiative(message), rememberAmbient: comment => rememberAmbientComment(comment), rememberSense: message => rememberInitiative(message), voiceOf: (id, characterId) => readingVoices.own(id, characterId) });
}
/** I-189 #1: you stayed away while her reading was paused: it ends quietly, like a cancelled reading (the rest of her bubble shows, unread). */
function endAwayReading(id: string): void {
  speechBeats().cancel(id); bubbleFollow().over(id, 'cancelled'); speech.stop('away');
  if (ordinaryReplyPresentation?.id === id) finishReplySpeechPresentation(id);
  void window.desktop.noteReplySpeechHeard?.(id, -1, 'over')?.catch(() => {}); // full-screen Unbound's bubble shows the rest
}
/** Builds this window's audio context now, while the model loads, when she reads aloud in the Bailian voice (2026-11-05). */
/** one of her short sounds in a call sounds (its mouth scale) or stopped (null): this window's stage, the other window's and the Unbound page follow. A source of its own: a reply's speaking is never touched. */
export function fillerMouth(shape: number | null): void {
  stage?.setSpeaking(shape !== null, 'filler', shape ?? undefined);
  try { speechChannel?.postMessage({ fillerMouth: shape }); } catch { /* the other window is gone */ }
  void window.desktop.setAmbientAudioSpeaking(shape !== null, shape).catch(() => {});
}
export function warmAudioOutput(): void {
  let bailian = false;
  try { bailian = isCloudTtsProvider(speakingTtsConfig().provider); } catch { /* Config errors surface on speak. */ }
  if (settings.voice.enabled && bailian) setTimeout(() => windowAudio.warm(), 0);
}
/** Reply-speech segments and cancels from the host, and the other window speaking (both windows). */
export function wireSpeechEvents(): void {
window.desktop.onReplySpeechSegment(segment => {
  bubbleFollow().segment(segment); // I-165: where this sentence ends, for her bubble (only the reply it follows counts)
  const accepted = ordinaryReplyPresentation;
  if (!accepted || accepted.ended || segment.replyId !== accepted.id || accepted.context !== replySpeechContext()
    || segment.index !== accepted.index + 1 || !accepted.text.startsWith(segment.visibleText)
    || !shown()) return; // I-174: covered, the segment still counts
  accepted.index = segment.index;
  // Streamed text is already visible. Speech progress must never replace the
  // full reply with an earlier prefix; the host verifies the current native
  // full-body receipt together with this segment's own lease.
  if (segment.index === 0) {
    if(accepted.early)petUI?.expectAnswerSpeech(segment.replyId);
    else petUI?.finishAnswer(accepted.text, segment.replyId, true, true);
  }
  petUI?.refreshAnswerReader(accepted.text, false);
});
window.desktop.onReplySpeechCancelled(id => {
  speechBeats().cancel(id); // 边说边演: her reading of this reply was cancelled (talked over in a call, stopped, hung up): what was not played is dropped, never made up for later
  bubbleFollow().over(id, 'cancelled'); // I-165: the voice will not follow: the rest of her bubble shows now
  if (replySpeechQueue.replyId === id) speech.stop();
  if (ordinaryReplyPresentation?.id === id) finishReplySpeechPresentation(id);
});
speechChannel.onmessage = (event) => {
  if (typeof event.data === 'boolean') { stage?.setSpeaking(event.data, 'remote'); mediaInput?.setSpeaking(event.data); ambientAudioController?.setSpeaking(event.data); }
  else if (event.data && typeof event.data === 'object' && 'fillerMouth' in event.data) { const shape = sanitizeFillerShape(event.data.fillerMouth); stage?.setSpeaking(shape !== null, 'filler', shape ?? undefined); } // 2026-11-20: the other window's short sound
  else if (event.data && typeof event.data === 'object' && typeof event.data.prepare === 'boolean') stage?.setSpeechPreparing(event.data.prepare, 'remote');
  else if (event.data && typeof event.data === 'object' && 'speechFace' in event.data) { stage?.speechFaceCue(event.data.speechFace); speechBeats().voiced(event.data.speechFace); } // 边说边演: the reading reached a sentence
  else if (event.data && typeof event.data === 'object' && 'segmentHeard' in event.data) bubbleFollow().heard(event.data.segmentHeard); // I-165: the other window's voice reached a sentence
};
}
export function voiceContext(): { characterId: string; modelPath: string } {
  return { characterId: characterState?.activeId ?? '', modelPath: settings.model?.path ?? '' };
}
/** I-162: the active character's voice through the one resolver (shared/voice/character-voice-resolver.ts), as the host resolves it. */
export function currentTtsConfig(): TtsConfig {
  const context = voiceContext(), card = characterState?.cards.find(item => item.id === context.characterId);
  return characterTtsConfig(settings, card ?? (context.characterId ? { id: context.characterId } : null), context.modelPath);
}
/**
 * What the voice panel shows: the default provider (the old global 输出方案), her own provider when it is not that one (ownProvider), and her
 * voice ids. Her Bailian and Drama 3 ids are her own when her default voice is on that provider (step 1 keeps the old panel working).
 */
export function panelTtsConfig(): TtsConfig {
  const context = voiceContext(), config = currentTtsConfig(), own = characterState?.cards.find(card => card.id === context.characterId)?.voice;
  // The style fields are hers as saved, never what a fallback filled in (her description as an instruction or acting style).
  const style = effectiveTtsConfig(settings.tts ?? structuredClone(DEFAULT_TTS_CONFIG), context.characterId, context.modelPath);
  return { ...config, provider: settings.tts?.provider ?? 'system', instruction: style.instruction, emotion: style.emotion, fishActingStyle: style.fishActingStyle,
    ...(own?.provider === 'bailian' && own.voiceId ? { voice: own.voiceId } : {}), ...(own?.provider === 'fish' ? { fishVoiceId: own.voiceId } : {}) };
}
/**
 * I-209 stage voice: the voice of the line this window reads now. Someone else's on the full-screen stage (her reply to you, her chime-in):
 * her own card's (her binding by her id, as the host resolves it); anything else: the active character's (currentTtsConfig), as before.
 */
export function readingTtsConfig(): TtsConfig {
  const owner = readingVoices.speaking(heldLines?.active, replySpeechQueue?.replyId), card = owner && owner !== characterState?.activeId ? characterState?.cards.find(item => item.id === owner) : undefined;
  return card ? characterTtsConfig(settings, card, '') : currentTtsConfig();
}
/** I-162: the system voice this window should pick for her (her gender; her own voiceURI when the system voice is her choice). I-209: the one reading now. */
function systemVoiceWish(): SystemVoiceWish | null {
  return systemWishOf(readingTtsConfig().voicePlan);
}
let lastVoiceNotice = '';
/** I-162: the control window says once, in one line, when she cannot speak with her own voice (and which voice she uses instead). */
export function noteVoicePlan(): void {
  if (isPet) return; // no-pet-ok: isPet is the existing window flag (shell-wiring), not a name for her
  try { if (speechOutput) populateVoices(); } catch { /* the list is filled again when the settings form syncs */ } // the system voice list shows her own voice
  const plan = currentTtsConfig().voicePlan;
  const notice = (currentUiLanguage() === 'en' ? plan?.noticeEn : undefined) ?? plan?.notice ?? ''; // step 2: the English line with an English interface
  // Step 2: one click on the line takes the user to her voice settings (the 带我去 place 'character-voice').
  if (notice && notice !== lastVoiceNotice) notifyLink(`${notice} ${uiText('（点这里去她的声音设置）')}`, goToHerVoice);
  lastVoiceNotice = notice;
}
/** I-162 step 2: opens 「她的声音」 on the character page and flashes it (the same destination 带我去 uses; it only shows the page). */
export function goToHerVoice(): void {
  const leaf = takeMeThereLeaf('character-voice');
  if (!leaf) return;
  controlNavigation?.navigate(leaf.page, leaf.target);
  flashTarget(document.getElementById(leaf.target));
}
/** What the character page's 「她的声音」 reads from this window: the default voice, the system voices, whether a provider's key is saved, the preview. */
export function characterVoicePorts() {
  const sample = uiText(EMOTIONAL_VOICE_PREVIEW);
  return {
    newDefault: () => newCharacterVoice(settings),
    systemVoices: () => speech.voices(),
    providerReady: (provider: 'system' | 'bailian' | 'fish') => ttsProviderReady(settings.tts ?? DEFAULT_TTS_CONFIG, provider),
    isActive: (id: string) => characterState?.activeId === id,
    // The saved voice, through the same preview as the voice panel: a paid one keeps its own notice and consent (prepareCharacterSpeechPreview).
    preview: async (): Promise<void> => { await (currentTtsConfig().provider === 'system' ? speech.preview(sample) : speech.previewCharacter(sample, () => window.desktop.prepareCharacterSpeechPreview())); },
    // I-164 读法 试听: the shown texts of her reading list, through the same preview (the map is applied at the voice, so what is heard is the spoken form).
    previewText: async (text: string): Promise<void> => { await (currentTtsConfig().provider === 'system' ? speech.preview(text) : speech.previewCharacter(text, () => window.desktop.prepareCharacterSpeechPreview())); },
    openSetup: (provider: 'bailian' | 'fish') => {
      const leaf = takeMeThereLeaf(provider === 'fish' ? 'fish-key' : 'bailian-key');
      if (leaf) { controlNavigation?.navigate(leaf.page, leaf.target); flashTarget(document.getElementById(leaf.target)); }
    },
  };
}
/** What this window reads with: the user's choice, or the system voice while Drama 3's month is used up (settings stay as chosen). */
export function speakingTtsConfig(): TtsConfig { return fishFallback.speaking(readingTtsConfig()); }
/** I-070: this month's Drama 3 spending (both windows). */
export function wireTtsBudget(): void {
  // I-070: this month's Drama 3 spending; the crossing push carries the one notice, shown by the window that is in front.
  window.desktop.onTtsBudget(view => {
    const accepted = fishFallback.update(view);
    if (!accepted) return;
    emotionalVoiceControls?.refreshBudget();
    if (accepted.notice && (isPet || !settings.pet.visible)) notify(uiText(FISH_BUDGET_NOTICE));
  });
  void window.desktop.getTtsBudget().then(view => { fishFallback.update(view); emotionalVoiceControls?.refreshBudget(); }).catch(() => {});
}
