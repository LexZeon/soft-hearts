// 连接、任务和安全 (part 9), host side: the public page. Other parts and the wiring import this part only through this file (overhaul
// plan section 8; the layer check counts any other way in as debt). Files inside electron/safety/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part safety`). The part's
// wiring modules (agent-channel/electron-wiring.ts, assistant/electron-wiring.ts, claude-tasks/electron-wiring.ts, test-commands/
// wiring.ts, wiring.ts for the crisis card) are wiring: electron/main.ts imports them directly and they are not on this page.
// Security boundaries live behind this page (the agent channel's registry and validation, task permissions, the clipboard check):
// the move into folders changed paths only, no logic (docs/claude/2026-11-16-overhaul-parts-2.md).

// The agent channel's tool registry, as other parts add their own tools to it (chat settings, sense cards, card conversion): the
// definition and call types, the error a tool throws, argument checks, and the commit guard a conversion holds.
export { AgentToolError, AgentToolRegistry } from './agent-channel/registry';
export type { AgentCallContext, AgentCallResult, AgentCommitGuard, AgentRegistryOptions, AgentToolDefinition } from './agent-channel/registry';
export { argsObject, oneOf } from './agent-channel/validate';
// The app tools' setting views (chat settings shows them) and the bridge types sense cards fill in.
export { settingDetail, settingViews } from './agent-channel/app-tools';
export type { AgentAppBridge, PerceptionFacts, PerceptionKind, SettingCards, SettingExtras, SystemAudioPurpose } from './agent-channel/app-tools';
// The perception switches a channel call may flip (the wiring creates them; Unbound reads them) and the window a call acts on.
export { createPerceptionSwitches } from './agent-channel/bridge';
export type { AgentWindow, PerceptionSwitches } from './agent-channel/bridge';
// What the host does for a channel call (the wiring connects it).
export { agentHostActions } from './agent-channel/host-actions';
// Which sender may write the clipboard (the wiring's permission handler).
export { allowsClipboardWrite } from './clipboard-permission';
