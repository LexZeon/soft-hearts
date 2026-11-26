// 连接、任务和安全 (part 9), shared side: the public page. Other parts, the wiring and the contract import this part only through this
// file (overhaul plan section 8). Files inside shared/safety/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part safety`).

// The agent channel's catalog: tools and settings, which ones always ask in a dialog or are never exposed, setting states and
// validation, recycle-bin parts (the capability table, the handbook, chat settings and the journal read it), and its wire types.
export { AGENT_ALWAYS_DIALOG_TOOLS, AGENT_NEVER_EXPOSED, AGENT_SETTING_STATE_LABELS, AGENT_SETTINGS, AGENT_TOOLS, agentSetting, settingAlwaysDialog, validateAgentSettingValue } from './agent-channel';
export type { AgentChannelNotice, AgentChannelRendererAction, AgentChannelView, AgentRecyclePart, AgentRecycleSummary, AgentSettingId, AgentSettingSpec, AgentSettingValue } from './agent-channel';
export type { AgentToolDescriptor } from './agent-channel'; // 2026-11-24: the dev-only voice_keep tool lists itself outside the catalog
// The Claude Code link's diagnosis words (diagnostics and the journal).
export { LINK_FAILURE_WORDS, LINK_FAILURES, LINK_RECORD_STATES, LINK_STATE_REASON, LINK_TRIGGERS, LINK_UNREADABLE, LINK_UNREADABLE_WORDS, linkExplanation, plainVersion, smallCount } from './claude-link-diag';
export type { LinkFailure, LinkRecordState, LinkTrigger, LinkUnreadable } from './claude-link-diag';
// Claude tasks (R20): the prompt check and the wire types.
export { validateCodexTaskPrompt } from './codex-tasks';
export type { CodexApprovalDecision, CodexTaskCapabilities, CodexTaskContinue, CodexTaskDetails, CodexTaskEvent, CodexTaskStart, CodexTaskSummary } from './codex-tasks';
// The settings assistant's wire types.
export type { AssistantEvent, AssistantPrefs, AssistantView } from './assistant';
// The crisis card (I-117): the setting's region preference, the danger level, the reaction judge's closed field, the card's wire types.
export { crisisRegionPreference } from './crisis-lines';
export type { DangerLevel } from './detect';
export { parseDangerField, SAFETY_JUDGE_BLOCK, SAFETY_JUDGE_RULE } from './judge-field';
export type { SafetyCardAnswer, SafetyCardView } from './card';
// Developer test commands ("测试：xxx"): recognising one in the chat box, and the wire types.
export { asksTestCommand } from './test-command';
export type { TestCommandNote, TestCommandOutcome, TestEffect } from './test-command';
// 体验记录 (the experience journal): this part's entry types, their closed words, builder, reason and panel line (shared/memory/journal.ts joins the slices).
export { SAFETY_JOURNAL_TYPES, buildSafetyJournalEntry, describeSafetyJournalEntry, safetyJournalReason } from './journal-entries';
export type { SafetyJournalInput, SettingVia } from './journal-entries';
