// 她的大脑：聊天 (part 6), shared side: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside shared/brain/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part brain`), including
// the names other parts use from this part's behaviour folders, which stay in shared/behaviors/ like the other parts'.
// Not here (their types are), and imported directly by their users:
//   - values only the host uses, so the control window bundle does not carry them: busy-chat/choose and reply-linger/choose
//     (electron/mood/mood.ts), long-chat/knobs (electron/main.ts), prompt-route (companion.ts, mood.ts)
//     (FATIGUE_WORDS moved to shared/mood/fatigue.ts in the wiring rewrite step 1);
//   - values only the windows use, which run code when loaded, so the host bundle does not carry them: reply-anchor (src/stage/PetUI.ts),
//     reply-waiting-presentation (src/main.ts).
// Also imported directly where this page would close a runtime import cycle (chat-actions, model-adaptation, busy-chat and reply-linger
// reach other parts' pages that come back here): shared/behaviors/blush/choose.ts (she-chooses), shared/initiative/inner-loop.ts
// (unanswered, i139-texts), shared/senses/feed-recognition.ts and sense-router.ts (i139-texts), shared/voice/her-voice.ts
// (prompt-switches, i139-texts). Untangling waits for the stage and core parts and the wiring rewrite.

// Behaviour folders of this part (shared/behaviors/busy-chat, long-chat, opening-choice, pause-talk, reply-linger, text-first).
export { speechIntervalAfterUnanswered, unansweredSentence } from '../behaviors/busy-chat/unanswered';
export type { OpeningChoiceHost, OpeningNow, OpeningWhy } from '../behaviors/opening-choice/interface';
export { validPauseTalkCut } from '../behaviors/pause-talk/choose';
export type { PauseTalkCue, PauseTalkCut, PauseTalkPlan, PauseTalkSkip, PauseTalkStatus, PauseTalkView } from '../behaviors/pause-talk/interface';
export type { PetReplyLingerAnswer, ReplyLingerBubble, ReplyLingerHost, ReplyLingerMood, ReplyLingerWhy } from '../behaviors/reply-linger/interface';
export { readBubbleLingerMs, readReplyLingerAnswer, readReplyLingerLeft, replyLingerLongestMs } from '../behaviors/reply-linger/perform';
export { TEXT_FIRST_KNOBS } from '../behaviors/text-first/knobs';
export type { TextFirstKnobs } from '../behaviors/text-first/knobs';
// I-139 texts (prompts across parts use them); the prompt switches and routes.
export { AMBIENT_FORMAT_RELAXED, AMBIENT_SITUATION_RELAXED, DIARY_DATA_RELAXED, DIARY_FRAME_RELAXED, DIARY_RULES_RELAXED, FEED_HOW_RELAXED, FEED_SITUATION_RELAXED, feedBeforeRelaxed, HER_NOTE_FIRST_RELAXED, HER_NOTE_RAW_EVERY, HER_NOTE_REWRITE_RELAXED, HER_VOICE_FORMAT_JSON, HER_VOICE_FORMAT_KEEPSAKE, HER_VOICE_FORMAT_LINE, HER_VOICE_OPENING, HER_VOICE_TECH, i139Text, INNER_LOOP_NATURE_RELAXED, INNER_LOOP_NOW_RELAXED, INNER_LOOP_REST_NOTE_RELAXED, INNER_LOOP_TOUCH_NOW_RELAXED, innerLoopLeaningRelaxed, innerLoopSinceRelaxed, KEEPSAKE_TEXT_RELAXED, LISTEN_ASK_RELAXED, LISTEN_NOTE_INTRO_RELAXED, listenSituationRelaxed, moodLightLine, MOVING_MEMORY_HANDOFF_FORMAT, movingMemoryHandoffSituation, PERCEPTION_INNER_LOOP_RELAXED, PRINCIPLE_SIX_RELAXED, REALER_EMOTIONS_RELAXED, REVIEW_DATA_RELAXED, REVIEW_FRAME_RELAXED, REVIEW_RULES_RELAXED, RHYTHM_LINE, SENSE_LINE_TEXT_RELAXED, SPECIAL_DAY_LABELS_RELAXED, specialDaySituationRelaxed, VISITOR_MARK_RELAXED } from '../foundation/i139-texts';
export type { I139Language, MoodLightSince, MoodLightTired } from '../foundation/i139-texts';
export { getPromptSwitches, promptSwitchDefaults, promptSwitchesFromEnv, relaxedPromptsActive, setPromptSwitches } from './prompt-switches';
// Chat: actions, availability, language, settings, the Claude model choice, adapting to a model.
export { CHAT_ACTION_WORDS, chatActionAllowed, isChatActionWord } from './chat-actions';
export type { ChatActionWord } from './chat-actions';
export { outageDisplayText } from './chat-availability';
export type { ChatAvailabilityView, ChatOutageNotice } from './chat-availability';
export type { StreamEvent } from './stream-event';
export type { ChatRequest, ChatStarted } from './desktop-api';
export { HANDED_LINE_REFUSED, SEND_DROP_FROMS, SEND_DROP_HINT, SEND_DROP_WHYS, SEND_HELD_WORDS, parseUnboundSayAck, sendHeldBy, unboundSayAckOf, validSendWaits } from './send-drop/drop'; // 2026-11-22: a typed line never drops silently
export type { SendDropFact, SendDropFrom, SendDropWhy, SendHeld, SendOutcome, SendWaits, UnboundSayAck } from './send-drop/drop';
export { SEND_DROP_KNOBS } from './send-drop/knobs';
export { ENGLISH_SPEECH_LINE, ENGLISH_TEXT_LINE, chatLanguageSessionLine, withSpeechLanguage } from './chat-language';
export { CALL_NO_FRAME_NOTE_EN, CALL_NO_FRAME_NOTE_ZH, callFrameNote, callPastGlancesNote } from './call-frame-note'; // I-161: a voice segment's line about its frames (A: and about earlier ones)
export type { CallFrames } from './call-frame-note';
export type { ChatSettingCardView, ChatSettingChoiceRequest } from './chat-settings';
export { CHAT_MODEL_CHOICES, CHAT_MODEL_FALLBACK_NOTICE, CHAT_MODEL_FOLLOW_CLAUDE_CODE, IMPLIED_CHAT_MODEL, chatModelArgument, chatModelChoice, chatModelLabel, claudeModelOrDefault, impliesChatModel, refusedClaudeModel, reportedModelId } from './claude-model'; // I-222: her chat model
export { approximateActions, fingerReasonWords, fingerWords, missingActionGroups, modelAdaptation, partWords } from './model-adaptation';
export type { ModelAdaptation } from './model-adaptation';
// Prompt modules (I-023), proactive speech, she chooses, text first, turn awareness.
export type { ModuleRouterWhy, RoutedModule, RouterAnswerStatus, RouterDecider, RouterDecision, RouterSkip, RouterVerdict } from './module-router/interface';
export { PROACTIVE_RECENT_OPPORTUNITIES, PROACTIVE_REQUEST_LIMIT_MS } from './proactive-speech';
export type { ProactiveOrigin, ProactiveSpeechLease, ProactiveSpeechOpportunity, ProactiveSpeechSource } from './proactive-speech';
export { sheChooses } from '../foundation/she-chooses';
export type { SheChoosesCandidate, SheChoosesReason, SheChose } from '../foundation/she-chooses';
export { curiousCloserLook, LOOK_TURN_CARRIES, LOOK_TURN_CARRY_WORDS, LOOK_TURN_SENSE_WORDS, LOOK_TURN_WHY_WORDS, LOOK_TURN_WHYS } from './text-first';
export type { LookTurnCarry, LookTurnWhy, WatchSight } from './text-first';
export type { UnreadReason } from './turn-awareness';
// Her reply: anchor, checks, rhythm, the waiting look.
export { INTERNAL_WORD_RULES, REPLY_MARKER_STATES } from './reply-check';
export type { InternalWordRule, ReplyMarkerState } from './reply-check';
export { formatRhythmMultiplier, REPLY_RHYTHM_MAX, REPLY_RHYTHM_MIN, RHYTHM_MOODS, rhythmSourceLabels, USER_PACES } from './reply-rhythm';
export type { ReplyRhythmPacing, ReplyRhythmView, RhythmMood, RhythmTendency, UserPace } from './reply-rhythm';
// 体验记录 (the experience journal): this part's entry types, their closed words, builder, reason and panel line (shared/memory/journal.ts joins the slices).
export { BRAIN_JOURNAL_TYPES, CLAUDE_GATE_EVENTS, FIRST_CHAR_REUSES, GESTURE_ANSWERS, SPARE_WHYS, brainJournalReason, buildBrainJournalEntry, describeBrainJournalEntry } from './journal-entries';
export type { BrainJournalInput, FirstCharReuse, GestureAnswer, SpareWhy } from './journal-entries';
// 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md): the vocabulary, the stream filter and the timing, for the stage, Unbound and the voice host.
export { CLOSE_BEAT_LIGHTER, SPEECH_BEAT_MEANINGS, SPEECH_BEAT_SHOWCASE, SpeechBeatFilter, isCloseBeatWord, isFrameBeatWord, isGoBeatWord, isSpeechBeatHow, isSpeechBeatWord } from '../behaviors/speech-beats/choose';
export { SpeechBeatSchedule } from '../behaviors/speech-beats/schedule';
export { SpeechSpan } from '../behaviors/speech-beats/span';
export { LineHolds, beatHold, type BeatHold } from '../behaviors/speech-beats/how-long'; // I-175 "做多久"
export { SPEECH_BEAT_TIMING } from '../behaviors/speech-beats/knobs';
export { isCloseOrFrameWord, offeredBeatWords, windowCloseMomentsOn, windowGestureRefusal } from '../behaviors/speech-beats/window-close'; // 2026-11-24: the small window has no kiss / hug (knob)
export { SPEECH_BEAT_GO_WORDS } from '../behaviors/speech-beats/interface'; // I-193: her "go where" words (full-screen only)
export type { SpeechBeat, SpeechBeatChannel, SpeechBeatCloseWord, SpeechBeatGoWord, SpeechBeatHow, SpeechBeatRelease, SpeechBeatShowcaseWord, SpeechBeatsEvent, SpeechBeatWord } from '../behaviors/speech-beats/interface';
export { SPEECH_BEAT_ARM_WORDS, speechBeatAvailabilityLine, speechBeatSituationOf, unavailableBeatWords, type SituationCard, type SituationView, type SpeechBeatSituation, type SpeechBeatSurface } from '../behaviors/speech-beats/availability'; // I-185: this turn's words
// I-178 (docs/claude/2026-11-22-i178-proactive-context.md): what every prompt that makes her speak on her own shares: the recent-chat block and the spoken-words-only sentence.
export { PROACTIVE_CHAT_KNOBS, chatAgo, proactiveChatBlock, proactiveContextText, proactiveSpokenOnly } from '../foundation/proactive-context';
export type { ProactiveChatRow, ProactiveChatSource } from '../foundation/proactive-context';
