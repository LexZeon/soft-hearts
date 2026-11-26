// 连接、任务和安全 (part 9), window side: the public page. Other parts and the wiring import this part only through this file (overhaul
// plan section 8). Files inside src/safety/ import each other directly; stylesheets are imported by path (side effects, not this page).
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part safety`).

// The agent channel panel, its notices and the actions a channel call asks the window to do.
export { AgentChannelPanel, agentNoticeText, runAgentRendererAction } from './AgentChannelPanel';
// The settings assistant panel (I-071 v2).
export { mountAssistantPanel } from './AssistantPanel';
// Claude tasks (R20): the panel, the offer in chat, and whether tasks are offered at all.
export { CodexTasks, mountCodexTaskOffer } from './CodexTasks';
export { claudeTasksOffered, watchClaudeTasks } from './claude-task-gate';
// The crisis card outside her role (I-117) and the region setting.
export { mountCrisisRegionSelect, SafetyCard } from './SafetyCard';
// Developer test command notes.
export { TestCommandNotes } from './TestCommandNotes';
// Overhaul step 7 一部分关了: the control window's banner and its greyed switches.
export { PART_SWITCH_ELEMENTS, PartHealthNotice } from './PartHealthNotice';
