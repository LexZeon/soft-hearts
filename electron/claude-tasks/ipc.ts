// R20 opt-in switch and the task IPC surface. No Electron import: main.ts passes its own
// `host()` registrar and the Electron side supplies the native first-run notice.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CodexApprovalDecision, CodexTaskCapabilities } from '../../shared/codex-tasks';
import { TASK_OFF, type ClaudeTaskService } from './service';

export const TASK_SWITCH_FILE = 'claude-tasks.json';

/** The user's choice, kept by the host in the profile. Missing or unreadable means off. */
export class ClaudeTaskSwitch {
  private value = false;
  private loading: Promise<boolean> | null = null;
  private readonly file: string;
  constructor(profileDirectory: string) { this.file = path.join(profileDirectory, TASK_SWITCH_FILE); }
  /** Synchronous view; false until the saved choice has been read (fails closed). */
  get enabled(): boolean { return this.value; }
  load(): Promise<boolean> {
    this.loading = (async () => {
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8'));
        this.value = raw?.version === 1 && raw.enabled === true;
      } catch { this.value = false; }
      return this.value;
    })();
    return this.loading;
  }
  /** Resolves once the saved choice is known (immediately if load() was never called). */
  async loaded(): Promise<boolean> { if (this.loading) await this.loading; return this.value; }
  async set(enabled: boolean): Promise<void> {
    if (!enabled) { this.value = false; await rm(this.file, { force: true }); return; }
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, enabled: true }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.file);
    this.value = true;
  }
}

export type Registrar = (method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean) => void;

export interface ClaudeTaskIpcOptions {
  service: ClaudeTaskService;
  toggle: ClaudeTaskSwitch;
  /** The first-run notice; true only when the user explicitly chose to turn tasks on. */
  confirmEnable(): Promise<boolean>;
  /** Opens the control window's task panel with a prefilled prompt; never starts anything. */
  openTaskConfirmation(prompt: unknown): void;
  /** Tells every window whether tasks are on (the pet only offers tasks when they are). */
  broadcast(state: { enabled: boolean }): void;
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务内容不正确。');
  return value as Record<string, unknown>;
};

export function registerClaudeTaskIpc(host: Registrar, options: ClaudeTaskIpcOptions): void {
  const { service, toggle } = options;
  let switching: Promise<CodexTaskCapabilities> | null = null;
  host('listCodexTasks', () => service.list());
  host('readCodexTask', (taskId: unknown) => service.read(taskId as string));
  host('codexTaskCapabilities', async () => { await toggle.loaded(); return service.capabilities(); });
  host('startCodexTask', (value: unknown) => {
    const request = record(value);
    return service.start({ prompt: request.prompt as string, mode: request.mode as never, workingDirectory: request.workingDirectory as string });
  });
  host('continueCodexTask', (value: unknown) => {
    const request = record(value);
    return service.continue({ taskId: request.taskId as string, prompt: request.prompt as string, mode: request.mode as never });
  });
  host('interruptCodexTask', (taskId: unknown) => service.interrupt(taskId as string));
  host('respondCodexApproval', (taskId: unknown, approvalId: unknown, decision: unknown) =>
    service.respondApproval(String(taskId), String(approvalId), decision as CodexApprovalDecision));
  // The pet may ask to open the panel (an offer); it can never start a task.
  host('proposeCodexTask', (value: unknown) => {
    if (!toggle.enabled) throw new Error(TASK_OFF);
    options.openTaskConfirmation(value);
  }, false);
  host('claudeTasksEnabled', () => toggle.loaded(), false);
  host('setClaudeTasksEnabled', (value: unknown) => {
    if (typeof value !== 'boolean') throw new Error('开关的值不正确。');
    const run = async (): Promise<CodexTaskCapabilities> => {
      await toggle.loaded();
      if (value && !toggle.enabled) {
        if (!(await options.confirmEnable())) return service.capabilities();
        await toggle.set(true);
      } else if (!value && toggle.enabled) {
        await toggle.set(false);
        await service.stopAll();
      }
      options.broadcast({ enabled: toggle.enabled });
      return service.capabilities();
    };
    const next = (switching ?? Promise.resolve()).catch(() => undefined).then(run);
    switching = next;
    return next;
  });
}
