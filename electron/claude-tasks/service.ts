// R20: the pet hands a task to the user's own Claude Code — a separate `claude -p` per turn,
// never the chat process — inside one user-selected folder, with per-action approval in the
// app. Same IPC surface and events as the inherited Codex task UI. Tasks live in memory
// only: no Claude session is saved; "continue" starts a new process with a short recap.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  CodexApprovalDecision, CodexTaskApproval, CodexTaskCapabilities, CodexTaskContinue, CodexTaskDetails,
  CodexTaskEvent, CodexTaskMode, CodexTaskStart, CodexTaskStatus, CodexTaskSummary,
} from '../../shared/codex-tasks';
import { validCodexTaskMode, validateCodexTaskPrompt } from '../../shared/codex-tasks';
import { claudeEnvironment, claudeFailure, findClaude } from '../claude';
import { openTaskPermissionEndpoint, type TaskPermissionEndpoint } from './permission-server';
import { classifyPermission, type PermissionRequest, type PolicyFs } from './policy';
import { killProcessTree, taskArguments, TaskStreamReader, type ShimLaunch } from './process';

export const TASK_OFF = '桌宠任务还没有打开。请在「Claude 任务」里打开“允许桌宠通过 Claude Code 帮你做事”。';
export const TASK_NO_FOLDER = '还没有选择文件夹。请先选择一个文件夹，Claude 只能在这个文件夹里操作。';
export const APPROVAL_TIMEOUT_MS = 120_000;
/** A permission request that arrives before this run's init report passed verification (X-090). */
export const TASK_NOT_VERIFIED = '任务还没有通过启动核对，这次操作已拒绝。';
const RUN_TIMEOUT_MS = 45 * 60_000;
const MAX_TASKS = 20;
const MAX_MESSAGES = 400;
const MAX_TRANSCRIPT = 160_000;

export type Decision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string; interrupt?: true };

export interface ClaudeTaskServiceOptions {
  emit(event: CodexTaskEvent): void;
  /** Host-held opt-in: the switch and the folder from the native picker. */
  state(): { enabled: boolean; folder: string };
  model?(): string;
  shim: ShimLaunch;
  findBinary?(): Promise<string>;
  /** Extra leading arguments (tests run a script through node). */
  binaryArgs?: string[];
  environment?(): NodeJS.ProcessEnv;
  /** Brings the approval surface forward; false means nobody can see it, so the request is denied. */
  surface?(): boolean;
  platform?: NodeJS.Platform;
  approvalTimeoutMs?: number;
  runTimeoutMs?: number;
  /** Longest wait in close()/stopAll() for a stopped run's process to finish exiting (default 10 s). */
  stopWaitMs?: number;
  tempRoot?: string;
  policyFs?: PolicyFs;
}

interface TaskRecord { summary: CodexTaskSummary; messages: CodexTaskDetails['messages']; turns: Array<{ prompt: string; result: string }>; lastSummary?: string }
interface Run {
  id: string; taskId: string; folder: string; mode: CodexTaskMode; prompt: string;
  child?: ChildProcess; endpoint?: TaskPermissionEndpoint; reader?: TaskStreamReader;
  closed: boolean; cancelled: boolean; exited: boolean; stderr: string; timer?: NodeJS.Timeout; textOpen: boolean;
  done: Promise<void>; settle(): void;
}
interface Pending { approval: CodexTaskApproval; runId: string; input: Record<string, unknown>; resolve(decision: Decision): void; timer?: NodeJS.Timeout }

const deny = (message: string, interrupt = false): Decision => ({ behavior: 'deny', message, ...(interrupt ? { interrupt: true as const } : {}) });
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The second argument must be the folder granted through the host's native picker. */
export async function validateTaskDirectory(requested: unknown, granted: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (!granted) throw new Error(TASK_NO_FOLDER);
  if (typeof requested !== 'string' || !path.isAbsolute(requested) || !path.isAbsolute(granted) || requested.includes('\0') || granted.includes('\0'))
    throw new Error('请先通过“选择文件夹”授权任务目录。');
  const [candidate, folder] = await Promise.all([realpath(requested), realpath(granted)]);
  const fold = (value: string) => platform === 'win32' || platform === 'darwin' ? value.toLowerCase() : value;
  if (fold(candidate) !== fold(folder) || !(await stat(folder)).isDirectory()) throw new Error('任务目录和当前选定的文件夹不一致，请重新选择。');
  return folder;
}

/** Earlier turns, bounded, so a new process can pick the task up without a saved session. */
export function recapPrompt(turns: TaskRecord['turns'], prompt: string): string {
  if (!turns.length) return prompt;
  const recent = turns.slice(-6).map((turn, index) => `【第 ${index + 1} 次】用户：${turn.prompt.slice(0, 2_000)}\n【第 ${index + 1} 次】结果：${(turn.result || '（没有完成）').slice(0, 3_000)}`);
  return `这是同一个任务的继续。之前的经过（只作参考，文件的当前状态以实际读取为准）：\n${recent.join('\n')}\n---\n现在的要求：\n${prompt}`;
}

export class ClaudeTaskService {
  private readonly tasks = new Map<string, TaskRecord>();
  private active: Run | null = null;
  // A finished run's process may still be exiting; close() waits for it so callers can remove its folder.
  private readonly exiting = new Set<Promise<void>>();
  private shown: Pending | null = null;
  private readonly queue: Pending[] = [];
  private closed = false;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: ClaudeTaskServiceOptions) { this.platform = options.platform ?? process.platform; }

  async capabilities(): Promise<CodexTaskCapabilities> {
    const { enabled, folder } = this.options.state();
    let found = true;
    try { await (this.options.findBinary ?? findClaude)(); } catch { found = false; }
    const ready = enabled && !!folder && found;
    const reason = !enabled ? '默认关闭。打开后，桌宠可以把任务交给你本机的 Claude Code，只在你选定的文件夹里操作。'
      : !found ? '没有找到 Claude Code。请先安装官方 Claude Code 并在终端运行 claude 登录。'
        : !folder ? TASK_NO_FOLDER
          : '读文件自动放行；改文件和运行命令每次都会先问你；不能联网，不能碰文件夹以外的位置。';
    return { authenticated: ready, login: found ? 'other' : 'none', computerControl: false, reason,
      enabled, folder, noSandbox: this.platform === 'win32' };
  }

  async list(): Promise<CodexTaskSummary[]> {
    return [...this.tasks.values()].map(task => ({ ...task.summary })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(taskId: string): Promise<CodexTaskDetails> {
    const task = this.owned(taskId);
    return { task: { ...task.summary }, messages: task.messages.map(message => ({ ...message })), hasMore: false,
      ...(task.lastSummary ? { summary: task.lastSummary } : {}) };
  }

  async start(request: CodexTaskStart): Promise<CodexTaskSummary> {
    const prompt = validateCodexTaskPrompt(request?.prompt);
    const mode = request?.mode;
    if (!validCodexTaskMode(mode)) throw new Error('任务权限不正确。');
    const folder = await this.ready(request.workingDirectory);
    const time = Date.now();
    const task: TaskRecord = { summary: { id: randomUUID(), title: prompt.split(/\r?\n/)[0].slice(0, 64), workingDirectory: folder, mode,
      createdAt: time, updatedAt: time, status: 'running' }, messages: [{ role: 'user', text: prompt }], turns: [] };
    this.remember(task);
    return this.launch(task, prompt, prompt, mode);
  }

  async continue(request: CodexTaskContinue): Promise<CodexTaskSummary> {
    const prompt = validateCodexTaskPrompt(request?.prompt);
    const mode = request?.mode;
    if (!validCodexTaskMode(mode)) throw new Error('任务权限不正确。');
    const task = this.owned(request.taskId);
    const folder = await this.ready(task.summary.workingDirectory);
    task.summary.workingDirectory = folder; task.summary.mode = mode;
    task.messages.push({ role: 'user', text: prompt }); this.trim(task);
    return this.launch(task, recapPrompt(task.turns, prompt), prompt, mode);
  }

  async interrupt(taskId: string): Promise<void> {
    this.owned(taskId);
    const run = this.active;
    if (!run || run.taskId !== taskId || run.closed) return;
    run.cancelled = true;
    this.finish(run, 'interrupted');
    await run.done;
  }

  /** Turning the switch off stops whatever is running. */
  async stopAll(): Promise<void> {
    const run = this.active;
    if (run && !run.closed) { run.cancelled = true; this.finish(run, 'interrupted'); }
    // Bounded (2026-11-04): a process tree that never reported its exit kept close() waiting for 33 minutes under a fully
    // loaded machine, which would also keep the app from quitting. The run is already finished and its tree was told to end.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all([...this.exiting]), new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.stopWaitMs ?? 10_000); timer.unref?.(); })]);
    clearTimeout(timer);
  }

  respondApproval(taskId: string, approvalId: string, decision: CodexApprovalDecision): void {
    const pending = this.shown;
    if (!pending || pending.approval.taskId !== taskId || pending.approval.approvalId !== approvalId || !pending.approval.decisions.includes(decision))
      throw new Error('这个审批请求已经失效。');
    const run = this.active;
    if (decision === 'accept') {
      // Last check before an allow leaves the app: the same run, still open, still verified.
      if (!run || run.id !== pending.runId || !this.admitted(run)) {
        this.resolve(pending, deny('任务已经结束。', true));
        throw new Error('这个审批请求已经失效。');
      }
      this.resolve(pending, { behavior: 'allow', updatedInput: pending.input });
    }
    else if (decision === 'decline') this.resolve(pending, deny('用户拒绝了这次操作。不要换一种方式重复它；说明情况，或者换一种不需要这一步的做法。'));
    else {
      this.resolve(pending, deny('用户停止了任务。', true));
      if (run && run.id === pending.runId && !run.closed) { run.cancelled = true; this.finish(run, 'interrupted'); }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stopAll();
  }

  private owned(taskId: unknown): TaskRecord {
    const task = typeof taskId === 'string' ? this.tasks.get(taskId) : undefined;
    if (!task) throw new Error('只能读取或继续桌宠这次运行里创建的任务。');
    return task;
  }

  private async ready(requested: unknown): Promise<string> {
    const check = () => {
      if (this.closed) throw new Error('任务服务已关闭。');
      const state = this.options.state();
      if (!state.enabled) throw new Error(TASK_OFF);
      if (!state.folder) throw new Error(TASK_NO_FOLDER);
      if (this.active) throw new Error('已有任务在进行，请先停止或等它完成。');
      return state.folder;
    };
    const folder = await validateTaskDirectory(requested, check(), this.platform);
    // Checked again after the await: the caller starts the run synchronously after this returns.
    check();
    return folder;
  }

  private remember(task: TaskRecord): void {
    this.tasks.set(task.summary.id, task);
    for (const [id, old] of this.tasks) {
      if (this.tasks.size <= MAX_TASKS) break;
      if (old.summary.status !== 'running') this.tasks.delete(id);
    }
  }

  private trim(task: TaskRecord): void {
    while (task.messages.length > MAX_MESSAGES) task.messages.shift();
    let total = task.messages.reduce((sum, message) => sum + message.text.length, 0);
    while (total > MAX_TRANSCRIPT && task.messages.length > 1) total -= task.messages.shift()!.text.length;
  }

  private async launch(task: TaskRecord, input: string, prompt: string, mode: CodexTaskMode): Promise<CodexTaskSummary> {
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    const run: Run = { id: randomUUID(), taskId: task.summary.id, folder: task.summary.workingDirectory, mode, prompt,
      closed: false, cancelled: false, exited: false, stderr: '', textOpen: false, done, settle };
    this.active = run;
    this.exiting.add(done);
    void done.then(() => this.exiting.delete(done));
    task.summary.status = 'running'; task.summary.updatedAt = Date.now();
    this.options.emit({ type: 'task', task: { ...task.summary } });
    try {
      const binary = await (this.options.findBinary ?? findClaude)();
      if (run.closed) return { ...task.summary };
      const endpoint = await openTaskPermissionEndpoint({ launch: this.options.shim, handle: request => this.decide(run, request),
        platform: this.platform, tempRoot: this.options.tempRoot });
      run.endpoint = endpoint;
      if (run.closed) { await endpoint.close(); return { ...task.summary }; }
      this.spawn(run, binary, endpoint.mcpConfigFile, input);
    } catch (error) {
      if (!run.closed) this.finish(run, 'failed', error instanceof Error ? error.message : '无法启动 Claude Code。');
    }
    return { ...task.summary };
  }

  private spawn(run: Run, binary: string, mcpConfigFile: string, input: string): void {
    const args = [...(this.options.binaryArgs ?? []), ...taskArguments({ mcpConfigFile, model: this.options.model?.() ?? '' })];
    const child = spawn(binary, args, {
      cwd: run.folder, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: (this.options.environment ?? claudeEnvironment)(),
      // Its own process group on POSIX, so cancel can end everything it started.
      detached: this.platform !== 'win32',
    });
    run.child = child;
    const reader = new TaskStreamReader({ text: text => this.text(run, text), step: text => this.step(run, text) }, run.folder, this.platform);
    run.reader = reader;
    run.timer = setTimeout(() => { if (!run.closed) this.finish(run, 'failed', '任务超过 45 分钟，已停止。'); }, this.options.runTimeoutMs ?? RUN_TIMEOUT_MS);
    let buffer = '';
    const consume = (line: string) => {
      if (run.closed) return;
      if (line.length > 2_000_000) { this.finish(run, 'failed', 'Claude Code 返回的数据过大，任务已停止。'); return; }
      if (reader.consume(line) === 'stop') this.finish(run, 'failed', reader.failure || '任务已停止。');
    };
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (run.closed) return;
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); consume(line); }
      if (buffer.length > 2_000_000) this.finish(run, 'failed', 'Claude Code 返回的数据过大，任务已停止。');
    });
    child.stderr!.on('data', (chunk: string) => { run.stderr = (run.stderr + chunk).slice(-8_000); });
    child.once('error', error => {
      if (run.closed) return;
      this.finish(run, 'failed', (error as NodeJS.ErrnoException).code === 'ENOENT' ? '无法启动 Claude Code，请确认已安装并能在终端运行 claude。' : 'Claude Code 启动失败。');
    });
    child.once('exit', () => { run.exited = true; });
    child.once('close', code => {
      run.exited = true;
      if (buffer.trim()) consume(buffer);
      buffer = '';
      if (run.closed) return;
      if (reader.finished && reader.status === 'completed') this.finish(run, 'completed');
      else this.finish(run, 'failed', reader.failure || (code === 0 ? 'Claude Code 没有完成任务。' : claudeFailure(run.stderr) || `Claude Code 运行失败（退出码 ${code ?? '未知'}）。`));
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: input }] } }) + '\n');
  }

  private text(run: Run, text: string): void {
    const task = this.current(run);
    if (!task) return;
    const last = task.messages.at(-1);
    if (run.textOpen && last?.role === 'assistant') last.text = (last.text + text).slice(-MAX_TRANSCRIPT);
    else { task.messages.push({ role: 'assistant', text }); run.textOpen = true; }
    this.trim(task);
    this.options.emit({ type: 'delta', taskId: run.taskId, text });
  }

  private step(run: Run, text: string): void {
    const task = this.current(run);
    if (!task) return;
    run.textOpen = false;
    task.messages.push({ role: 'step', text }); this.trim(task);
    this.options.emit({ type: 'step', taskId: run.taskId, text });
  }

  /** Late events from a stopped or replaced run are dropped here. */
  private current(run: Run): TaskRecord | null {
    return !run.closed && this.active === run ? this.tasks.get(run.taskId) ?? null : null;
  }

  /**
   * The start gate (X-090). The permission endpoint opens before spawn, so a request can arrive
   * before this run's init report has been read and verified; until then nothing is allowed and
   * nothing is queued for the user. Checked on entry, after the policy await, when an approval
   * is shown and again when the user accepts.
   */
  private admitted(run: Run): boolean {
    return !run.closed && this.active === run && run.reader?.initialized === true;
  }

  private async decide(run: Run, raw: unknown): Promise<Decision> {
    if (run.closed || this.active !== run) return deny('任务已经结束。');
    if (!this.admitted(run)) return deny(TASK_NOT_VERIFIED);
    const value = object(raw), input = object(value?.input);
    if (!value || typeof value.tool_name !== 'string' || !input) return deny('审批请求格式不正确。');
    const request: PermissionRequest = { tool_name: value.tool_name, input: structuredClone(input) };
    let outcome;
    try { outcome = await classifyPermission(request, { folder: run.folder, mode: run.mode, platform: this.platform, fs: this.options.policyFs }); }
    catch { return deny('无法核对这次操作，已拒绝。'); }
    if (run.closed || this.active !== run) return deny('任务已经结束。');
    if (!this.admitted(run)) return deny(TASK_NOT_VERIFIED);
    if (outcome.kind === 'allow') return { behavior: 'allow', updatedInput: request.input };
    if (outcome.kind === 'deny') return deny(outcome.message);
    const approval: CodexTaskApproval = { ...outcome.approval, taskId: run.taskId, approvalId: randomUUID(), decisions: ['accept', 'decline', 'cancel'] };
    return new Promise<Decision>(resolve => {
      this.queue.push({ approval, runId: run.id, input: request.input, resolve });
      this.pump();
    });
  }

  /** Exactly one approval is on screen at a time; its timer starts when it is shown. */
  private pump(): void {
    while (!this.shown && this.queue.length) {
      const next = this.queue.shift()!;
      const run = this.active;
      if (!run || run.id !== next.runId || !this.admitted(run)) { next.resolve(deny('任务已经结束。')); continue; }
      let visible = false;
      try { visible = this.options.surface?.() ?? true; } catch { visible = false; }
      if (!visible) { next.resolve(deny('看不到 soft hearts 的控制窗口，无法请你批准，已拒绝。')); continue; }
      this.shown = next;
      const timeout = this.options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
      next.timer = setTimeout(() => {
        if (this.shown === next) this.resolve(next, deny(`用户没有在 ${Math.round(timeout / 1000)} 秒内回应，视为拒绝。`));
      }, timeout);
      this.options.emit({ type: 'approval', approval: { ...next.approval, decisions: [...next.approval.decisions] } });
    }
  }

  private resolve(pending: Pending, decision: Decision): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (this.shown === pending) this.shown = null;
    pending.resolve(decision);
    this.options.emit({ type: 'approval-resolved', taskId: pending.approval.taskId, approvalId: pending.approval.approvalId });
    this.pump();
  }

  private finish(run: Run, status: CodexTaskStatus, error?: string): void {
    if (run.closed) return;
    run.closed = true;
    if (this.active === run) this.active = null;
    if (run.timer) clearTimeout(run.timer);
    // Unanswered approvals of this run become denials; nothing from it is shown later.
    if (this.shown?.runId === run.id) this.resolve(this.shown, deny('任务已经结束。', true));
    for (const pending of this.queue.splice(0)) pending.resolve(deny('任务已经结束。', true));
    // POSIX: the group may still hold children of an exited leader, so it is always cleaned up.
    // Windows: never taskkill a PID that already exited (it could have been reused).
    if (run.child && (this.platform !== 'win32' || !run.exited)) killProcessTree(run.child, this.platform);
    const endpoint = run.endpoint;
    const task = this.tasks.get(run.taskId);
    const summary = status === 'completed' ? run.reader?.summary ?? '' : '';
    if (task) {
      task.summary.status = status; task.summary.updatedAt = Date.now();
      task.turns.push({ prompt: run.prompt, result: summary || (status === 'interrupted' ? '（被用户停止）' : `（失败：${error ?? '未知原因'}）`) });
      if (task.turns.length > 12) task.turns.shift();
      task.lastSummary = summary || undefined;
      this.options.emit({ type: 'task', task: { ...task.summary } });
    }
    if (error && status === 'failed') this.options.emit({ type: 'error', taskId: run.taskId, message: error });
    this.options.emit({ type: 'done', taskId: run.taskId, status, ...(summary ? { summary } : {}) });
    const exited = run.child && !run.exited
      ? new Promise<void>(resolve => { run.child!.once('close', () => resolve()); setTimeout(resolve, 3_000).unref?.(); })
      : Promise.resolve();
    void Promise.all([exited, endpoint?.close()]).finally(() => run.settle());
  }
}
