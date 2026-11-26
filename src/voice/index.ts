// 声音 (part 11), window side: the public page. Other parts and the wiring import the voice part only through this file (overhaul
// plan section 8). Files inside src/voice/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part voice`), except:
//   - AudioReadingClient: it imports its stylesheet, which would make every importer of this page unloadable in node tests;
//     src/main.ts imports it directly (wiring may);
//   - emotional-voice.css: a side-effect import of src/main.ts;
//   - voice-call/call-controls.ts (only src/main.ts uses it): it imports src/initiative/feed-cue-player.ts, which imports this page, so
//     carrying it here would make an import cycle through the page; src/main.ts imports it directly.

// The control window's voice panels and readers (created by src/main.ts).
export { VoiceOutput } from './VoiceOutput';
export { EMOTIONAL_VOICE_PREVIEW, EmotionalVoiceControls } from './EmotionalVoice';
export { FishVoiceFallback } from './fish-voice-fallback';
export { CompletedReplySpeechQueue } from './completed-reply-speech-queue';
export { BubbleFollowView } from './bubble-follow-view'; // I-165: her bubble follows her voice
export { VoiceContinuationStatus } from './VoiceContinuationStatus';
export { VoiceDraftInput } from './VoiceDraftInput';
export { wirePushToTalk } from './push-to-talk';
export { showSleepMurmur } from './sleep-murmur';
export { fallbackUtteranceLang, pickSystemVoice, setSpeechLanguageSource, setSystemVoiceWishSource, speechLanguage, systemVoiceDelivery, systemVoiceLine, systemVoiceReading, systemWishOf } from './voice-language';
export type { SystemVoiceWish } from './voice-language';
// Shared audio output (her lines, feed cues).
export { defaultAudioTimers, SharedAudioOutput } from './audio-output';
export type { AudioOutputTimers } from './audio-output';
export { chooseCallOutput } from './voice-call/call-mic'; // I-177 batch 2: the output her voice plays on (the 「听」 list)
export { sinkSupported } from './output-sink';
// The mouth and speaking face on the stage: who is speaking, holding the mouth, speech faces (also borrowed by music reactions).
export { SpeakingSources } from './speaking-sources';
export type { SpeakingSource } from './speaking-sources';
export { SpeechHold } from './speech-hold';
export { speechFaceContext, SpeechFaceStage } from './speech-face/stage';
export { hormoneTemper, NEUTRAL_DISPOSITIONS, NEUTRAL_TEMPER } from './speech-face/choose';
export type { Choice, DispositionTemper, HormoneTemper } from './speech-face/choose';
export { envelope } from './speech-face/recipes';
export type { Variant } from './speech-face/recipes';
export type { AccentAvailability, AccentGates } from './speech-face/layer';
export { ReplySpeechState } from './reply-speech';
// Microphone and the phone-style call in the window: speech level, capture stats, VAD, turn end, barge-in.
export { DEFAULT_SPEECH_LEVEL, SilenceWatch, SpeechLevelGate } from './voice-level';
export { VoiceCaptureStats } from './voice-capture-stats';
export { READING_DROP_WHYS, reportReadingDropped, speechDropWhy } from './reading-dropped'; // 2026-11-24: a reading dropped before it began says why
export { CallVadStream, ChunkLead, VadSpeechDetector } from './voice-call/vad';
export type { VadHeard } from './voice-call/vad';
export { CallTurnStream, toTurnAudio, TURN_AUDIO_SECONDS, TurnEndJudge } from './voice-call/turn-end';
export type { TurnEndBy } from './voice-call/turn-end';
export { BargeInDetector } from './voice-call/barge-in';
export { AwayReadPause } from './away-read-pause'; // I-189 #1: her reading pauses while you are turned away or gone
export type { AwayReadEvent, AwayReadPorts } from './away-read-pause';
export { SharedPause } from './shared-pause'; // I-189: feeding and the away pause share her voice's pause
export type { PausableSpeech } from './shared-pause';
export { dropUnvoicedReply } from './voice-call/add-on-drop'; // I-197: a call reply dropped before her voice started leaves this window's chat
export { ReadingVoices, readingVoices } from './reading-voices'; // I-209 stage voice: someone else on the full-screen stage reads in her own voice
