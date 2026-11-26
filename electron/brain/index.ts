// 她的大脑：聊天 (part 6), host side: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside electron/brain/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part brain`).
// Claude-specific code (process flags, stream-json events, model aliases, error texts) stays inside this part's brain-interface modules
// (handbook/brain-interface.md); this page only re-exports. Companion chat never gets tools: that is enforced in claude.ts and
// claude-session.ts, not here.
// The part's wiring modules (module-router/wiring.ts, pause-talk/wiring.ts, speak-only/wiring.ts) are wiring: electron/main.ts imports
// them directly. reply-preload.ts is its own bundle entry (the reply window's preload) and reply-pieces-dom.ts belongs to it.
// reply-window.ts is not here: it loads electron's BrowserWindow, ipcMain and screen at import time, which the node tests' electron
// stub does not have; only electron/main.ts uses it, directly.
// Not here (their types are): the values of six modules that reach other parts' pages which come back to this one, so through this
// page they would close runtime import cycles (with the memory, mood, initiative, senses and voice pages): chat-actions-host
// (ChatActionHost), chat-settings (the proposals and applier), claude-session (PersistentClaudeChat, companionHasHistory),
// long-chat/history (isLeakedDraft, markTimes), long-chat/host, speak-only/judge-host (SpeakOnlyJudge). Their users import them
// directly: electron/main.ts, companion.ts, voice/call-offers.ts, voice/voice-chat-host.ts, memory/her-note/writer.ts,
// memory/moving-memory/handoff.ts, and two wiring files. Untangling waits for the core part and the wiring rewrite.

// The Claude brain (docs/claude/brain-interface.md): the chat process, the long-lived session, one-shot calls.
export { CLAUDE_OFFLINE_MESSAGE, CLAUDE_OFFLINE_RETRY_ATTEMPTS, claudeCallsInFlight, claudeEnvironment, claudeFailure, claudeInput, findClaude, noteClaudeCall, streamClaude, terminateClaude } from './claude';
export type { ClaudeCallLimits, ClaudeTask, ClaudeUsage } from './claude';
export { chatModelFallbackSettled, followClaudeCodeAfterRefusal, observeChatModelFallback } from './chat-model-fallback'; // I-222: the implied Opus refused
export { ClaudeChatProcess } from './claude-process';
export { PEER_DENIED_TOOLS, claudeSettingsArguments, lockedClaudeSettings } from './claude-settings';
export { noteStreamKind, observeClaudeStreamKinds, unknownStreamKind, type ClaudeStreamKind } from './claude-stream-kinds';
export { observeClaudeEnvironment } from './claude-env'; // 2026-11-25: a parent session's endpoint and credential names dropped (names only)
export { CLAUDE_LAUNCH_HOOK, claudeLaunchesSettled, launchClaude } from './claude-launch';
export type { ClaudeChild, ClaudeLaunch, ClaudeLaunchHook, ClaudeLaunchOptions } from './claude-launch';
// I-202: the one start gate every Claude Code process goes through (docs/claude/2026-11-23-claude-login-race.md).
export { CLAUDE_START_GATE, ClaudeGateWatch, ClaudeStartGate, ClaudeStartPausedError, apiStreamLine, claudeStartGate, loginLost, type ClaudeGateEvent, type ClaudeGatePass } from './claude-start-gate';
export type { CompanionService } from './companion'; // the value stays direct: only the wiring creates it (wiring rewrite step 2)
export type { ClaudeProcessOptions, ClaudeTurnResult } from './claude-process';
export type { ClaudeTimingInfo, ClaudeTimingObserver } from './claude-session';
export { LookContinuation, lookStream, type ClearLook, type CloserLookEntry, type ContinuableChat, type LookContinuationPorts } from './look-continuation'; // I-166: her own closer look
// I-139 (her own voice in chat).
export { i139ChatEdge } from './i139-chat';
export type { OnceLine, RelaxedChat } from './i139-chat';
// Assembling a turn: the conversation context, the interconnect line, filling a draft, the first turn in text, turn awareness.
export { buildCodexChatPrompt, buildCompanionPersona, companionMemoryBlock, conversationData, replaceMemoryBlock } from './conversation-context';
export { interconnectTurnLine } from './interconnect-line';
export { DraftFillLines } from './draft-fill';
export { textFirstTurn } from './text-first-turn';
export { createTurnAwareness } from './turn-awareness-host';
export { OpeningHost } from './opening-host';
export type { OpeningBudget, OpeningHostOptions } from './opening-host';
// Chat actions, settings and availability (outages, failures, incidents).
export type { ChannelActionResult } from './chat-actions-host';
export type { ChatSettingApplier, ChatSettingFacts } from './chat-settings';
export { registerChatAvailabilityIpc } from './chat-availability-host';
export { chatAvailability } from './chat-availability';
export { chatFailureEvent } from './chat-failure-event';
export { ChatIncidentLog, DraftOnlyReplyError } from './chat-incident-log';
export { createChatOutage } from './chat-outage';
// Her reply: the draft guard, input, latency, opening, rhythm and the reply window.
export { asksForEnglish, chatLooksChinese, draftFilterLine, ReplyDraftGuard, speakersFromPersona } from './reply-draft-guard';
export type { DraftDrop, DraftKind } from './reply-draft-guard';
export { validateReplyUpdate } from './reply-input';
export { appendBounded, firstCharTiming, ReplyLatencyProbe } from './reply-latency';
export { APP_REPLY_OPENING, FIXED_OPENING_MARKER, FIXED_TURN_REMINDER, FIXED_TURN_REMINDER_AT, FIXED_TURN_SENTENCE, OPENING_CLOSING_SLOT, takeClosingSlot, type ReminderPlace, internalWords, OpeningGate, openingMarker, openingSentence } from './reply-opening';
export type { OpeningMode } from './reply-opening';
export { ReplyRhythmHost } from './reply-rhythm-host';
// Long chat: greeting, history, the host and prewarming the next process.
export { GreetingArchive } from './long-chat/greeting';
export type { Timed } from './long-chat/history';
export { SessionRestartLog } from './long-chat/prewarm';
// Prompt modules (I-023) and speak-only (I-098).
export { ModuleRouter } from './module-router/router';
export { judgeBookInput, tailBookInput } from './speak-only/book-journal';
export type { SpeakOnlyJudgeOptions, SpeakOnlyOutcome } from './speak-only/judge-host';
export type { SpeakOnlyWarmPort } from './speak-only/route';
export { SPEAK_ONLY_REPLY_INSTRUCTION, speakOnlyEnabled } from './speak-only/rules';
export type { SpeakOnlyTurnKind } from './speak-only/rules';
// 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md): the beats file and the turn, for the chat wiring, the voice wiring and the memory wiring (privacy follows her chat records).
export { speechBeatsFor, SpeechBeatsHost } from './speech-beats/host';
export { followChatDeletions } from './speech-beats/follow-chat';
export { recordReplyCut } from './speech-beats/cuts'; // 2026-11-23/24: the one door for "her words were cut short, and why" (a voice barge-in now, a kiss or hug cut short later)
// I-178: the host reader of the recent-chat block every proactive prompt carries (shared/foundation/proactive-context.ts builds it).
export { proactiveChatReader } from './proactive-chat';
export type { ProactiveChatReaderDeps } from './proactive-chat';
// 2026-11-23: one truth for a line from her full-screen box: the chat handler admits it only while the box's ledger still holds it open.
export { admitHandedLine, setHandedLineGate, turnOwnerFor } from './handed-line-gate';
export type { HandedLineGate } from './handed-line-gate';
export { TurnOwners, companionChangeStops, ownHistory, ownerSettings, ownerSpeechScope, stageTurn, switchStops } from './turn-owner'; // I-209 step 2: every brain turn carries which character it belongs to (step 3: her card's persona)
export type { OwnerReader, OwnerSeat, OwnersStopped } from './turn-owner';
export { ChimeIn, ChimeTurns, StageHearing, chimeDecisionWithClaude, chimeLineWithClaude, heardId, historyText, sharedSight } from './stage-chat'; // I-209 step 4: everyone hears, everyone records, the characters decide who answers
export type { ChimeFacts, ChimeRow, HeardEvent, StageLine } from './stage-chat';