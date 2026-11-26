// 连接任务和安全's parts made on first use (overhaul step 8, electron/wiring/lazy-wiring.ts; docs/claude/2026-11-17-lazy-loading-step8.md): the
// handlers each one registers, with their flags, for the shells electron/wiring/safety-wiring.ts leaves. Kept apart so a test reads them
// without loading the app. tests/lazy-parts.test.ts checks them against the real registrations and the wiring golden.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { LazyMethod } from './lazy-wiring';

/** Claude tasks' handlers and their flags (electron/safety/claude-tasks/ipc.ts registerClaudeTaskIpc; tests/lazy-parts.test.ts checks them). */
export const CLAUDE_TASK_METHODS: readonly LazyMethod[] = [
  { method: 'listCodexTasks', controlOnly: true },
  { method: 'readCodexTask', controlOnly: true },
  { method: 'codexTaskCapabilities', controlOnly: true },
  { method: 'startCodexTask', controlOnly: true },
  { method: 'continueCodexTask', controlOnly: true },
  { method: 'interruptCodexTask', controlOnly: true },
  { method: 'respondCodexApproval', controlOnly: true },
  { method: 'proposeCodexTask', controlOnly: false }, { method: 'claudeTasksEnabled', controlOnly: false }, { method: 'setClaudeTasksEnabled', controlOnly: true },
];
/** The test command's handler and its flags. */
export const TEST_COMMAND_METHODS: readonly LazyMethod[] = [{ method: 'runTestCommand', scoped: true, controlOnly: false }];
