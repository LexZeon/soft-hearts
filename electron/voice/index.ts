// 声音 (part 11), host side: the public page. Other parts and the wiring import the voice part only through this file (overhaul plan
// section 8; the layer check counts any other way in as debt). Files inside electron/voice/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part voice`), except
// three modules only electron/main.ts uses, which import back into modules that import this page (an import cycle through the page):
//   - voice-chat-host.ts (-> companion.ts -> this page), speech-preview.ts and voice-call/host.ts (-> speech-emotion.ts -> this page).
//   The wiring imports them directly (it may); untangling those imports is left for the core and mood moves.

// Reading her replies aloud: the speech runtime, the providers (百炼 key and synthesis, Drama 3 with its budget), the per-character
// persona line, preview, who is speaking, playback activity, cancelling a reply's speech, and its diagnostics log.
export { SpeechRuntime, speechSynthesizer } from './speech-runtime';
export type { SpeechSynthesizer } from './speech-runtime';
export { resolveTtsKey, synthesizeBailianSpeech, TtsError, ttsInstruction, validateTtsConfig } from './tts';
export { budgetedFishSynthesizer, FishBudget, registerFishVoiceIpc } from './fish-voice-host';
export { characterSpeechPersona, SPEECH_PERSONA_LIMIT } from './speech-persona';
export { SpeakingOwners } from './speaking-owners';
export { SpeechPlaybackActivity } from './speech-playback-activity';
export { cancelReplySpeechTransport } from './reply-speech-transport';
export { SpeechDiagnosticsLog } from './speech-diagnostics';
// A finished reply read sentence by sentence, the proof that a shown prefix is final (reply window, Unbound), and the last reading.
export { CompletedReplySpeech } from './completed-reply-speech';
export { CompletedPrefixProof } from './completed-prefix-proof';
export type { CompletedPrefixBody } from './completed-prefix-proof';
export { LastReplyReading } from './last-reply-reading';
export { ReadCancelCauses } from './read-cancel-cause'; // who cancelled a reading (journal)
export { SegmentTimings } from './segment-timings'; // 2026-11-24: each sentence's synthesis time and the silence before it played
export { ReadingLedger } from './reading-ledger'; // 2026-11-24: every reply handed to her voice ends in a reading row or a row that says why not
export { ReadNotes } from './read-notes'; // 2026-11-24: a number per reply and a retried-failure note for the reading rows
export { FrozenReadingVoices } from './frozen-reading-voices'; // 2026-11-25: a reply keeps the voice it started in
export { SettleWhenQuiet } from './settle-when-quiet'; // 2026-11-25: a change that must restart something waits until her reply and its voice are done
export { fishVoiceSynthesizer } from './fish-retry'; // 2026-11-24: one more try for a Drama 3 request that never connected
export { speechFailureEntry } from './speech-failure-record'; // 2026-11-24: the speech row with its error kind, retry and reply number
export { GONE_SCOPE, readingScope, readingVoice } from './stage-voices'; // I-209 stage voice: each one on the full-screen stage reads in her own voice, under her own scope
// Hearing sound for her (the audio-reading toggles' host side: the archive and the broker that publishes readings to listeners).
export { AudioReadingArchive } from './audio-reading-archive';
export { AudioReadingHostBroker } from './audio-reading-host-broker';
export type { AudioReadingPublicationTicket, AudioReadingTally } from './audio-reading-host-broker';
// Voice chat and the phone-style call (streaming speech, the bundled VAD and turn models), call offers, the companion group.
export { VoiceCompanionGroup } from './voice-companion';
export { CallOffers } from './call-offers';
export { gateClip, herVoiceFrom } from './utterance-gate'; // only a clear sentence interrupts her
export { CallDeviceJudge } from './call-device-judge'; // I-177 batch 2: Claude's judgement of a new set of audio devices
export type { UtteranceGatePorts } from './utterance-gate';
export { CallStreamingSpeech } from './voice-call/streaming-speech';
export { CallVadBridge, loadSileroModel, loadSmartTurnModel, SILERO_VAD_RELATIVE, SMART_TURN_RELATIVE } from './voice-call/vad';
export { CallAddOn } from './voice-call/add-on'; // I-197: in a call, a line heard before her voice started joins the one before it
export type { AddOnHold, AddOnJournalRow } from './voice-call/add-on';
// 2026-11-24: the dev-only keep-her-voice tool (docs/claude/2026-11-24-voice-keep.md); its wiring is electron/wiring/voice-keep-wiring.ts.
export { VoiceKeepHost, voiceKeepAvailable, voiceKeepChannelTool, HER_READING } from './voice-keep';
export type { KeepInfo, SentenceTee, VoiceKeepHostPorts } from './voice-keep';
