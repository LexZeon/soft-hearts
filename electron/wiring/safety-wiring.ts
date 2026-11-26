// 连接任务和安全's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-4a.md):
// the help card (I-117, outside her role), the developer test commands (D2 / I-008), Claude tasks (R20: separate Claude Code task
// processes, opt-in, every write and command approved) and the agent channel (I-014: the internal channel, the Claude 助手, the perception
// switches). Moved from electron/main.ts.
// - The help card is core: it is created while electron/main.ts is evaluated (a failure stops the app loading, as before) and its two
//   handlers register in register() without a catch, so a failure there reaches the ready chain's 「soft hearts 启动失败」. `core` says so
//   for step 7 (isolation never switches it off).
// - register() runs inside the agent channel's recorder (electron/main.ts registerIPC, before agentOperations.done()): the test command,
//   the help card and the Claude task handlers, as they were. startAgentChannel() runs after the recorder stopped, with the operations it
//   recorded, as createAgentChannel did.
// - Claude tasks' host and the test commands are made on first use (overhaul step 8, electron/wiring/lazy-wiring.ts): register() leaves a
//   shell for each of their handlers, with the old names and flags, and the first call makes the part and its real handlers. Claude
//   tasks' making is its unit's start (claude-tasks), the test commands' too (test-commands). Before quit (releaseClaudeTasks) and when the
//   control window goes (interruptOwnedTasks) a host never made has nothing running. codexTasks stays a live binding (undefined until made).
// What the lines read from the rest of the app comes through SafetyNeeds (electron/main.ts gives getters; each read when used).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { dialog, type BrowserWindow } from 'electron';
import { t } from '../../shared/foundation/ui-language';
import { validateCodexTaskPrompt } from '../../shared/safety';
import { createSafety } from '../safety/wiring';
import { createTestCommands, type TestCommandPorts } from '../safety/test-commands/wiring';
import { ClaudeTasksHost } from '../safety/claude-tasks/electron-wiring';
import { createAgentChannel, type AgentChannelWiring } from '../safety/agent-channel/electron-wiring';
import { createPerceptionSwitches, type PerceptionSwitches } from '../safety';
import type { SettingsStore } from '../settings';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import type { PartIpc } from './ipc-wiring';
import { startUnitSync, type PartHandle } from './parts-wiring';
import { registerLazy } from './lazy-wiring';
import { CLAUDE_TASK_METHODS, TEST_COMMAND_METHODS } from './safety-lazy-wiring';
import { broadcast, showControls } from './shell-wiring';
import { unbound } from './unbound-wiring';
import { voiceKeepChannelTools } from './voice-keep-wiring';
// 记忆's wiring (electron/wiring/memory-wiring.ts, step 4d) reads these of the agent channel's: the refresh after the bin changes and the
// I-014 memory bridge the bin host finds chat and profile entries back through (not on the safety part's public page).
export { agentChannelRefresh, type RecoverableMemoryWiring } from '../safety/agent-channel/electron-wiring';
export { createMemoryBridge } from '../safety/agent-channel/memory-bridge';

/** What the safety wiring reads from the rest of the app (electron/main.ts gives getters; each is read when it is used). */
export interface SafetyNeeds {
  /** The settings store; undefined while electron/main.ts is still evaluated (the help card reads its region later). */
  readonly store: SettingsStore | undefined;
  readonly controls: BrowserWindow | null;
  readonly pet: BrowserWindow | null;
  /** I-085: a test command is the user's turn for her look offers (electron/senses/look-turns.ts). */
  readonly lookTurns: { userTurn(): void };
  /** D2: which main-process object answers each test command (electron/main.ts knows them; electron/safety/test-commands/wiring.ts). */
  readonly testCommandPorts: TestCommandPorts;
  /** Unbound v1 step 2: she is out, so her hidden companion window still counts as shown. */
  petHeld(): boolean;
  /** R20 selectDirectory: the chosen folder is written in the mutation queue, then every part catches up. */
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  sync(exclude?: number): void;
  /** The host's mutation queue: the perception switches' commits re-check their guard when they run. */
  readonly mutations: { guarded: AgentChannelWiring['admit'] };
}
/** The agent channel's reach into the app (electron/main.ts builds it in registerIPC from what exists there): every option but the windows. */
export type AgentChannelApp = Omit<AgentChannelWiring, 'profileDirectory' | 'controls' | 'pet' | 'petHeld' | 'operations' | 'register'>;
export interface SafetyProvides {
  /** I-117: the help card (the reaction judge's port, the chat's port, whether she yields). */
  readonly crisisCard: ReturnType<typeof createSafety>;
  /** R20: the task proposal entry (also what a proactive R20 offer opens; no executor). */
  openCodexTaskConfirmation(value: unknown, current?: () => boolean): void;
}

/** R20: separate Claude Code task processes (electron/safety/claude-tasks/); made on the first call of one of its handlers (step 8). */
export let codexTasks: ClaudeTasksHost; // undefined until made
/** Claude tasks' making (step 8: on the first call of one of its handlers; overhaul step 7: this unit's start, through the part runner). */
function startClaudeTasks(store: SettingsStore, controls: () => BrowserWindow | null): void {
  startUnitSync('safety', 'claude-tasks', () => {
  codexTasks = new ClaudeTasksHost({ profileDirectory: store.directory, settings: () => store.current,
    controls, showControls, broadcast });
  });
}
/** Before quit: running tasks end. */
export function releaseClaudeTasks(): void {
  void codexTasks?.close();
}
/** Window helper (step 5b; electron/main.ts's wireWindowEvents gives the order): the control window's page is new, gone or closed: its running tasks are interrupted. */
export function interruptOwnedTasks(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (owner !== 'controls' || !codexTasks) return;
  void codexTasks.list().then(tasks => Promise.all(tasks.filter(task => task.status === 'running').map(task => codexTasks.interrupt(task.id)))).catch(() => {});
}

export function wireSafety(needs: SafetyNeeds): PartHandle<SafetyProvides> & {
  register(ipc: PartIpc): void;
  /** Overhaul step 7: its own unit (safety/agent-channel); null when it did not start. */
  startAgentChannel(operations: AgentChannelWiring['operations'], ipc: PartIpc, app: AgentChannelApp): PerceptionSwitches | null;
} {
  const safety = createSafety({ region: () => needs.store?.current.crisisRegion, broadcast: view => broadcast('desk:safety-card', view) }); // I-117: the help card outside her role (memory only; no text kept)
  // D2 / I-008 developer test commands ("测试：xxx", electron/safety/test-commands/): answered here in developer mode, never sent to chat.
  // Made on the first 「测试：」 line (step 8).
  let testCommands: ReturnType<typeof createTestCommands>;
  /** R20 has no executor port; this is also the existing task proposal entry. */
  function openCodexTaskConfirmation(value: unknown, current: () => boolean = () => true): void {
    const { controls } = needs; // read when called
    const prompt = validateCodexTaskPrompt(value);
    if (!current() || !controls || controls.isDestroyed()) return;
    showControls();
    if (current()) controls.webContents.send('desk:codex-task-proposal', prompt);
  }
  return {
    id: 'safety',
    units: ['crisis-card', 'test-commands', 'claude-tasks', 'agent-channel', 'assistant'],
    core: ['crisis-card'],
    /** Overhaul step 7: the handlers of each unit that can be switched off (getDiagnostics stays answered: the notice asks for it). */
    ipc: { 'test-commands': ['runTestCommand'], 'claude-tasks': ['listCodexTasks', 'readCodexTask', 'codexTaskCapabilities', 'startCodexTask', 'continueCodexTask', 'interruptCodexTask', 'respondCodexApproval', 'proposeCodexTask', 'claudeTasksEnabled', 'setClaudeTasksEnabled', 'selectDirectory'],
      'agent-channel': ['getAgentChannel', 'setAgentChannelEnabled', 'setAgentInterconnect', 'relinkAgentClaudeCode', 'undoAgentAction', 'restoreRecycledMemory', 'setRecycleDays'] },
    register(ipc: PartIpc): void {
      const { host, scopedHost } = ipc;
      // What the handlers read: set before the ready chain registers (registerIPC) and not replaced later.
      const { lookTurns } = needs;
      registerLazy(ipc, { part: 'safety', unit: 'test-commands', methods: TEST_COMMAND_METHODS, // D2: made on the first 「测试：」 line
        create: () => { startUnitSync('safety', 'test-commands', () => { testCommands = createTestCommands(needs.testCommandPorts); }); },
        register: ({ scopedHost }) => { scopedHost('runTestCommand', (sender, text) => { lookTurns.userTurn(); return testCommands.accept(sender, text); }, false); } }); // D2: handled only in developer mode, else the window sends it as chat.
      safety.register(scopedHost); // I-117: the help card's answer and its current state (either window)
      registerLazy(ipc, { part: 'safety', unit: 'claude-tasks', methods: CLAUDE_TASK_METHODS, // R20: made on the first call (the control window asks claudeTasksEnabled when it loads)
        create: () => { const { store } = needs; startClaudeTasks(store!, () => needs.controls); },
        register: ({ host }) => { codexTasks.register(host, openCodexTaskConfirmation); } }); // R20: task IPC, opt-in switch (off by default), approvals. A unit whose making failed answers PART_OFF.
      // R20: the folder Claude tasks work in, chosen in a dialog (moved from electron/main.ts's registerIPC, wiring rewrite step 5).
      host('selectDirectory', async () => {
        const { controls, store, mutate, sync } = needs; // read when called
        const selected = await dialog.showOpenDialog(controls!, {
          title: t('选择 Claude 任务工作目录'),
          properties: ['openDirectory'],
        });
        if (selected.canceled || !selected.filePaths[0]) return null;
        const directory = selected.filePaths[0];
        await mutate(() =>
          store!.persist({
            ...store!.current,
            agent: { ...store!.current.agent, workingDirectory: directory },
          }),
        );
        sync();
        return directory;
      });
    },
    // Agent internal channel (三方互通 on by default, I-014): reuses the recorded operations exactly as the control window would.
    // Its commits re-check the call's guard right before they take effect (agent-channel/host-actions.ts).
    startAgentChannel(operations, ipc, app) {
      return startUnitSync('safety', 'agent-channel', () => { // overhaul step 7: its own unit, through the part runner
      const { host } = ipc;
      const perceptionSwitches = createPerceptionSwitches({ operations, controls: () => needs.controls, pet: () => needs.pet, admit: (guard, run) => needs.mutations.guarded(guard, run) }); // Unbound v1 step 1: the switches set_perception uses
      createAgentChannel({ profileDirectory: needs.store!.directory, controls: () => needs.controls, pet: () => needs.pet, petHeld: () => needs.petHeld(), operations,
        // 2026-11-23: the user's Claude can set where she comes out in full screen (set_setting unbound_default_place); the keeper is Unbound's (electron/unbound/place-keeper.ts)
        unboundPlace: { isSet: () => unbound ? unbound.places.hasDefault : null, setHere: () => unbound?.places.setHere() ?? false, clear: () => { unbound?.places.clear(); } },
        extraTools: voiceKeepChannelTools(), // 2026-11-24: the dev-only voice_keep tool (empty on stable and packaged builds)
        register: host, ...app });
      return perceptionSwitches;
      }) ?? null;
    },
    provides: { crisisCard: safety, openCodexTaskConfirmation },
  };
}
