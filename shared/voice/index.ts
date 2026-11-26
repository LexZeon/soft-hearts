// 声音 (part 11), shared half: the public page. Other parts, the wiring and the contract import the voice part only through this file
// (overhaul plan section 8). Files inside shared/voice/ import each other directly. The TTS settings types every part names
// (TtsConfig, TtsEmotion, FishMood, ...) are foundation (shared/foundation/tts-config.ts); importing them from there is fine.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part voice`).

// Her voice in every model prompt (diary, notes, inner loop, senses, special days...): the relaxed and system voice lines.
export { ambientCallSystem, herVoiceRelaxed, herVoiceSystem, thisPerson } from './her-voice';
// Read-aloud settings and speech wire types (TTS defaults, the cloud check, style bindings, speech events and requests).
export { DEFAULT_TTS_CONFIG, effectiveTtsConfig, resolveStyleBinding, isCloudTtsProvider, MAX_TTS_STYLE_BINDINGS, TTS_EMOTIONS, ttsProviderReady } from './tts';
export type { ApprovedReplySpeechSegment, SpeechRequestContext, SpeechWireEvent, TtsConfig, TtsEmotion, TtsStyleBinding } from './tts';
// I-162: the one resolver every speech path goes through (her own default voice, never a known voice of the wrong gender) and its traits.
export { capturedCharacterVoice, characterTtsConfig, chosenVoiceIdentity, newCharacterVoice } from './character-voice-resolver';
export type { VoiceSettings, VoiceSubject } from './character-voice-resolver';
export { followedVoice, voicesToSettle } from './character-voice-settle';
export { systemVoiceGender, voiceTraits } from './voice-traits';
// I-162 step 2: what the character page's 「她的声音」 shows and saves (the provider table, the voice lists with gender, the form to card voice).
export { VOICE_DESCRIPTION_EXAMPLE, VOICE_DESCRIPTION_MAX, VOICE_PROVIDER_FORM, VOICE_PROVIDER_ORDER, bailianVoiceChoices, providerNote, systemVoiceChoices, voiceFormOf, voiceFormUnchanged, voiceFromForm, voiceLabel } from './character-voice-form';
export type { VoiceChoice, VoiceForm } from './character-voice-form';
export { applyReading, applyReadingMapped, readingFor, readingSample, shownToSpokenOffset, spokenToShownOffset } from './reading-map'; // I-164 读法
export type { ReadingEdit, ReadingApplied } from './reading-map';
export type { VoiceGender, VoiceTraits } from './voice-traits';
export { cleanFishActingStyle, FISH_ACTING_STYLE_MAX, FISH_BUDGET_NOTICE, isFishMood } from './fish-voice';
// 2026-11-24: the monthly limit and this month's spending as the agent channel reads and sets them (numbers only).
export { FISH_LIST_USD_PER_MILLION_BYTES, FISH_MONTHLY_CAP_MAX_USD, FISH_NO_MONTHLY_CAP, FISH_PROMO_END_MS, fishBudgetExhausted, fishMonthKey, fishUsdPerMillionBytes, validFishBudgetView, validFishMonthlyCap } from './fish-voice';
export type { FishBudgetView, FishMood } from './fish-voice';
export { speechToneFor } from './speech-mood-tone';
export type { SpeechTone } from './speech-mood-tone';
export { scanStopReadoutRequest } from './stop-readout-request';
// Splitting a reply into spoken segments and bubbles (chat, the companion window, the reply window).
export { formatReplyBubbles, formatReplySegments, splitReplySegments } from './reply-segments';
export { EmphasisStream, stripEmphasis } from './emphasis-marks';
export type { ReplySegment } from './reply-segments';
export { IncrementalReplyOverflow, IncrementalReplySegments } from './incremental-reply-segments';
export { planReplyPieces, REPLY_BUBBLE_POLICY, replyPieces, validReplyPieces } from './reply-bubbles';
// I-165: the bubble follows her voice (the knob and the pure state machine both windows and the host run).
export { BUBBLE_FOLLOW_KNOBS, BubbleFollow, bubbleFollowMode } from './bubble-follow';
export type { BubbleFollowMode, BubbleFollowRelease, BubbleHeardPhase } from './bubble-follow';
export type { PlannedReplyPiece, ReplyBubblePolicy } from './reply-bubbles';
// Failures, cues and diagnostics the journal and notices name.
export { SPEECH_FAILURES, VOICE_INPUT_FAILURES } from './speech-failure';
export type { SpeechFailure, VoiceInputFailure } from './speech-failure';
export { SPEECH_CUE_OUTCOME_WORDS, SPEECH_CUE_OUTCOMES, SPEECH_CUE_PAIRS, SPEECH_CUE_REASON_WORDS } from './speech-cue';
export type { SpeechCueOutcome, SpeechCueReason } from './speech-cue';
export { validateSpeechDiagnosticRecord } from './speech-diagnostics';
export type { SpeechDiagnosticRecord } from './speech-diagnostics';
export { VOICE_UI_MESSAGES } from './voice-ui-messages';
export type { VoiceUiKey } from './voice-ui-messages';
// Hearing sound for her: which sources and purposes the audio-reading toggles allow.
export { audioReadingPurposes, audioReadingSources, parseAudioReadingIntent } from './audio-reading-toggles';
export type { AudioReadingAck, AudioReadingIntent, AudioReadingPurpose, AudioReadingSource, AudioReadingView } from './audio-reading-toggles';
// Voice input and the phone-style call: capture segments, conversation events, the call view and its knobs (the behaviour folder
// shared/behaviors/voice-call/ belongs to this part and stays with the other behaviour folders).
export { VOICE_OPEN_AFTER_REPLY, VOICE_OPEN_WAIT_MS } from './voice-segments';
export type { VoiceCancelReason, VoiceCaptureBinding, VoicePcmReceipt, VoicePcmSubmission } from './voice-segments';
export type { VoiceConversationEvent, VoiceInputSignal } from './voice-conversation';
export type { CallFillerClips, CallFillerId, CallFillerPick, VoiceCallOwner, VoiceCallView } from './voice-call';
export type { CallDeviceJudgement } from './call-devices'; // I-177 batch 2: Claude's judgement of a new device set (IPC callDevicesAsk)
export { speechRecognitionNote } from './speech-recognition-note';
// 2026-11-20: her short sounds in a call move her mouth: the scale and the check of a number that came over a channel (Unbound and the wiring use these).
export { MouthScale, sanitizeFillerShape } from '../behaviors/voice-call/mouth';
export { VOICE_CALL_KNOBS } from '../behaviors/voice-call/knobs';
export type { VoiceCallKnobs } from '../behaviors/voice-call/knobs';
// 体验记录 (the experience journal): this part's entry types, their closed words, builder, reason and panel line (shared/memory/journal.ts joins the slices).
export { DEFERRED_WHILES, SETTING_DEFERRALS, settingsSaveCutsReading } from './interrupt-policy'; // 2026-11-25 只有插话会打断她
export type { DeferredWhile, InterruptSettingsView, SettingDeferral } from './interrupt-policy';
export { READING_CANCEL_BYS, READING_PROVIDERS, READING_RESULTS, READING_WHYS, SPEECH_FAILURE_LABEL, VOICE_CALL_END_BYS, VOICE_CALL_END_REASONS, VOICE_CALL_VIAS, VOICE_CAPTURE_ENDS, VOICE_DEVICES, VOICE_INPUT_FAILURE_LABEL, VOICE_JOURNAL_TYPES, VOICE_TIME_ENGINES, VOICE_TIME_RESULTS, buildVoiceJournalEntry, describeVoiceJournalEntry, voiceJournalReason } from './journal-entries';
export type { ReadingCancelBy, ReadingProvider, ReadingResult, ReadingWhy, VoiceCaptureEnd, VoiceJournalInput, VoiceTimeResult } from './journal-entries';
// Batch A (docs/claude/2026-11-21-unbound-full-ACH.md): her voice's facts for her speaking face (the host checks one before relaying it to her full-screen window).
export { sanitizeSpeechFaceCue, turnOf, type SpeechFaceCue } from './speech-face-cue';
// I-161 (docs/claude/2026-11-21-call-screen-look.md): the journal's look line for a voice segment that considered a look (closed words; built by the senses part's voice adapter, written by the memory part's journal).
export { callLookFromTurn, callLookNotTaken, type CallLookFields, type CallLookTurnEnd } from './call-look-journal';
// I-174 item 3: who may end a line of hers she is already saying (a clear intent only).
export { ownLineYields } from '../behaviors/interrupt/own-line';
export type { OwnLineCause } from '../behaviors/interrupt/own-line';
// I-190: the stored device lists and the two rules the source menus use (shared/senses/device-sources.ts; the Unbound input box reads them too).
export { CALL_DEVICES_STORAGE_KEY, localCallDeviceStorage, type CallDeviceState, type CallDeviceStorage } from './call-device-storage';
export { pickByPriority, stripDeviceName, type DeviceInfo } from './call-devices';
// 2026-11-24: the dev-only keep-her-voice tool's window<->host view (docs/claude/2026-11-24-voice-keep.md).
export { VOICE_KEEP_DAYS_RANGE, type VoiceKeepRequest, type VoiceKeepView } from './voice-keep';
