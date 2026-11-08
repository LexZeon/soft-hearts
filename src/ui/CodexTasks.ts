import { uiText, uiTemplate } from './ui-language';
import type { AppSettings } from "../../shared/contracts";
import {
  CODEX_TASK_PROMPT_LIMIT, suggestCodexTask,
  type CodexApprovalDecision, type CodexTaskApproval, type CodexTaskCapabilities,
  type CodexTaskContinue, type CodexTaskDetails, type CodexTaskEvent,
  type CodexTaskMode, type CodexTaskStart, type CodexTaskSummary,
} from "../../shared/codex-tasks";

/** R20 task panel. Historical "Codex" names stay in the IPC; the backend is the user's Claude Code. */
export interface CodexTaskBridge {
  listCodexTasks(): Promise<CodexTaskSummary[]>;
  readCodexTask(taskId: string): Promise<CodexTaskDetails>;
  startCodexTask(request: CodexTaskStart): Promise<CodexTaskSummary>;
  continueCodexTask(request: CodexTaskContinue): Promise<CodexTaskSummary>;
  interruptCodexTask(taskId: string): Promise<void>;
  respondCodexApproval(taskId: string, approvalId: string, decision: CodexApprovalDecision): Promise<void>;
  onCodexTaskEvent(callback: (event: CodexTaskEvent) => void): () => void;
  codexTaskCapabilities(): Promise<CodexTaskCapabilities>;
  selectDirectory(): Promise<string | null>;
  /** The opt-in switch (off by default); the host shows a first-run notice before turning it on. */
  setClaudeTasksEnabled?(enabled: boolean): Promise<CodexTaskCapabilities>;
  onClaudeTasks?(callback: (state: { enabled: boolean }) => void): () => void;
}
interface CodexTasksOptions {
  api: CodexTaskBridge;
  getSettings(): AppSettings;
  beforeStart(): Promise<boolean>;
  onDirectorySelected(path: string): Promise<void> | void;
  onError(message: string): void;
  onOpen?(): void;
}
type Message = CodexTaskDetails["messages"][number];
const STATUS = { idle: "待继续", running: "进行中", completed: "已完成", interrupted: "已停止", failed: "未完成" };
const DISPLAY_LIMIT = 160_000;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function button(label: string, action: () => void, className = ""): HTMLButtonElement {
  const node = element("button", className, label); node.type = "button"; node.onclick = action; return node;
}

/** A pet-sized suggestion opens the task panel; it cannot start a task or change permissions. */
export function mountCodexTaskOffer(container: HTMLElement, prompt: string, callbacks: {
  onTask(prompt: string): void;
  onChat(): void;
  onDismiss?(): void;
}): (() => void) | null {
  const suggestion = suggestCodexTask(prompt);
  if (!suggestion) return null;
  const card = element("section", "codex-task-offer codex-task-inline-offer");
  card.setAttribute("aria-label", uiText("Claude 任务建议"));
  card.append(element("strong", "", uiText("要交给 Claude 完成吗？")), element("p", "", uiText("打开任务窗口后，可以确认文件夹和权限，点了同意才开始。")));
  if (suggestion.needsComputer) card.append(element("p", "codex-task-warning", uiText("任务只能处理所选文件夹里的文件和命令，还不能操作桌面上的应用。")));
  let mounted = true;
  const cleanup = () => { if (mounted) { mounted = false; card.remove(); } };
  const finish = (action: () => void) => { if (mounted) { cleanup(); action(); } };
  const actions = element("div", "action-line");
  actions.append(button(uiText("交给 Claude"), () => finish(() => callbacks.onTask(prompt)), "primary"), button(uiText("普通聊天"), () => finish(callbacks.onChat), "subtle"), button(uiText("取消"), () => finish(() => callbacks.onDismiss?.()), "subtle"));
  card.append(actions); container.append(card);
  return cleanup;
}

/** Tasks have their own explicit consent and never inherit companion history. */
export class CodexTasks {
  private readonly tasks = new Map<string, CodexTaskSummary>();
  private readonly messages = new Map<string, Message[]>();
  private readonly revisions = new Map<string, number>();
  private readonly summaries = new Map<string, string>();
  private readonly approvals = new Map<string, CodexTaskApproval>();
  private selectedId: string | null = null;
  private operation = false;
  private disposed = false;
  private readGeneration = 0;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeSwitch: (() => void) | null = null;
  private capabilities: CodexTaskCapabilities | null = null;
  private pendingPrompt: string | null = null;
  private continueChat: (() => void) | null = null;
  private readonly enable = element("input", "codex-task-enable");
  private readonly sandboxNote = element("p", "codex-task-warning codex-task-sandbox");
  private readonly taskSelect = element("select", "codex-task-select");
  private readonly prompt = element("textarea", "codex-task-prompt");
  private readonly mode = element("select", "codex-task-mode");
  private readonly directory = element("output", "codex-task-directory");
  private readonly scope = element("p", "hint codex-task-scope");
  private readonly capability = element("p", "hint codex-task-capability", uiText("正在核对本机 Claude Code…"));
  private readonly offerBox = element("div", "codex-task-offer");
  private readonly output = element("div", "codex-task-transcript");
  private readonly summaryBox = element("div", "codex-task-summary");
  private readonly approvalBox = element("div", "codex-task-approvals");
  private readonly status = element("output", "codex-task-state", uiText("选择任务或新建任务；点了同意才会开始。"));
  private readonly start = button(uiText("同意并新建任务"), () => void this.submit(false), "primary");
  private readonly resume = button(uiText("同意并继续任务"), () => void this.submit(true), "primary");
  private readonly stop = button(uiText("停止任务"), () => void this.interrupt(), "danger");
  private readonly choose = button(uiText("选择文件夹"), () => void this.chooseDirectory());
  private readonly refresh = button(uiText("刷新"), () => void this.reload());

  constructor(private readonly container: HTMLElement, private readonly options: CodexTasksOptions) {
    this.render();
  }

  async init(): Promise<void> {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = this.options.api.onCodexTaskEvent(event => this.receive(event));
    this.unsubscribeSwitch = this.options.api.onClaudeTasks?.(() => void this.reload()) ?? null;
    await this.reload();
  }

  /** Local intent detection only. Opening this prompt does not grant execution permission. */
  offer(text: string, onContinueChat?: () => void): boolean {
    const suggestion = suggestCodexTask(text);
    if (!suggestion || this.disposed || this.capabilities?.enabled === false) return false;
    this.prepare(text);
    // Start with least privilege even when the request is likely to need a write.
    this.mode.value = "read-only";
    this.continueChat = onContinueChat ?? null;
    this.offerBox.replaceChildren(element("strong", "", uiText("要交给 Claude 完成吗？")), element("p", "", suggestion.reason));
    if (suggestion.mode === "workspace-write") this.offerBox.append(element("p", "hint", uiText("这项任务可能需要修改文件；需要时在下方选“可以修改”。每次修改仍会先问你。")));
    if (suggestion.needsComputer) this.offerBox.append(element("p", "codex-task-warning", uiText("任务只能处理所选文件夹里的文件和命令，还不能操作桌面上的应用。")));
    this.offerBox.append(button(onContinueChat ? uiText("继续普通聊天") : uiText("暂不开启"), () => {
      const callback = this.continueChat; this.continueChat = null; this.offerBox.hidden = true; callback?.();
    }, "subtle"));
    this.offerBox.hidden = false; this.options.onOpen?.(); this.update();
    return true;
  }

  /** Manual entry point and explicit transfer from a lightweight pet suggestion card. */
  prepare(text = ""): void {
    if (this.disposed) return;
    this.selectedId = null; this.readGeneration++;
    this.prompt.value = text.slice(0, CODEX_TASK_PROMPT_LIMIT);
    this.mode.value = "read-only"; this.offerBox.hidden = true; this.continueChat = null;
    this.output.replaceChildren(element("p", "hint", uiText("新任务只接收这里填写的内容；陪伴对话和共享画面不会自动传入。")));
    this.renderSummary(null);
    this.status.textContent = uiText("检查文件夹和权限，点击「同意并新建任务」后开始。");
    this.update();
  }

  syncSettings(): void { if (!this.disposed) this.update(); }
  dismissOffer(): void {
    if (this.disposed) return;
    this.offerBox.hidden = true; this.continueChat = null;
  }

  async interruptActive(): Promise<void> {
    const running = [...this.tasks.values()].filter(task => task.status === "running");
    for (const task of running) await this.options.api.interruptCodexTask(task.id);
  }

  dispose(): void {
    this.disposed = true; this.readGeneration++;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.unsubscribeSwitch?.(); this.unsubscribeSwitch = null;
    this.continueChat = null; this.tasks.clear(); this.messages.clear(); this.approvals.clear(); this.summaries.clear();
    this.container.replaceChildren();
  }

  private render(): void {
    const section = element("section", "codex-tasks"); section.setAttribute("aria-label", uiText("Claude 任务"));
    const heading = element("div", "panel-heading");
    const title = element("div"); title.append(element("h2", "", uiText("交给 Claude")), element("p", "", uiText("让桌宠通过你本机的 Claude Code，在选定的文件夹里帮你做事。任务只保留到关闭软件为止。")));
    heading.append(title, button(uiText("新建任务"), () => this.prepare(), "subtle"), this.refresh);
    const toggle = element("section", "settings-section codex-task-switch"); toggle.id = 'codex-task-switch';
    const label = element("label", "toggle-row");
    const copy = element("span");
    copy.append(element("strong", "", uiText("允许桌宠通过 Claude Code 帮你做事（默认关闭）")),
      element("small", "", uiText("打开后，桌宠可以把任务交给你本机的 Claude Code，只在下面选定的一个文件夹里操作：读文件自动放行；改文件和运行命令每次都先问你，120 秒不回应视为拒绝；不能联网，不能碰文件夹以外的位置。用的是你自己的 Claude 额度。")));
    this.enable.type = "checkbox"; this.enable.checked = false; this.enable.disabled = true;
    this.enable.setAttribute("role", "switch");
    this.enable.onchange = () => void this.setEnabled(this.enable.checked);
    label.append(copy, this.enable);
    toggle.append(label, this.sandboxNote);
    const chooser = element("label", "field"); chooser.id = 'codex-task-list'; chooser.append(element("span", "", uiText("已有任务")), this.taskSelect);
    this.taskSelect.setAttribute("aria-label", uiText("选择 Claude 任务"));
    this.taskSelect.onchange = () => { const id = this.taskSelect.value; if (id) void this.select(id); else this.prepare(); };
    const scope = element("section", "settings-section codex-task-consent"); scope.id = 'codex-task-consent'; scope.append(element("h3", "", uiText("本次权限")));
    const folder = element("div", "codex-task-folder"); folder.append(this.directory, this.choose);
    const modeLabel = element("label", "field"); modeLabel.append(element("span", "", uiText("任务范围")), this.mode);
    for (const [value, label] of [["read-only", uiText("只读：读取和分析，不改文件（命令仍会逐条问你）")], ["workspace-write", uiText("可以修改：改文件和运行命令前，每次都先问你")]]) {
      const option = element("option", "", label); option.value = value; this.mode.append(option);
    }
    this.mode.setAttribute("aria-label", uiText("Claude 本次权限")); this.mode.value = "read-only"; this.mode.onchange = () => this.update();
    scope.append(folder, modeLabel, this.scope, this.capability);
    const form = element("form", "settings-section codex-task-form"); form.id = 'codex-task-form';
    const promptLabel = element("label", "field"); promptLabel.append(element("span", "", uiText("这次要做什么？")), this.prompt);
    this.prompt.rows = 5; this.prompt.maxLength = CODEX_TASK_PROMPT_LIMIT; this.prompt.placeholder = uiText("例如：阅读这个项目，检查启动失败的原因。");
    this.prompt.setAttribute("aria-label", uiText("Claude 任务内容")); this.prompt.oninput = () => this.update();
    const actions = element("div", "action-line"); actions.append(this.start, this.resume, this.stop);
    this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    form.append(promptLabel, actions, this.status); form.onsubmit = event => { event.preventDefault(); void this.submit(!!this.selectedId); };
    this.offerBox.hidden = true; this.summaryBox.hidden = true;
    this.output.id = 'codex-task-progress'; this.approvalBox.id = 'codex-task-approvals'; this.output.setAttribute("aria-label", uiText("Claude 任务进展"));
    this.output.append(element("p", "hint", uiText("选择任务后显示进展。")));
    section.append(heading, toggle, this.offerBox, chooser, scope, form, this.approvalBox, this.summaryBox, this.output);
    this.container.replaceChildren(section); this.update();
  }

  private update(): void {
    if (this.disposed) return;
    const selected = this.selectedId ? this.tasks.get(this.selectedId) : null;
    const running = [...this.tasks.values()].find(task => task.status === "running");
    const directory = this.options.getSettings().agent.workingDirectory;
    const enabled = this.capabilities?.enabled === true;
    this.enable.checked = enabled;
    this.enable.disabled = this.operation || !this.capabilities || !this.options.api.setClaudeTasksEnabled;
    this.sandboxNote.textContent = this.capabilities?.noSandbox
      ? uiText("注意：Windows 上的 Claude Code 没有沙箱。你批准的命令会以你的身份直接运行，就像你自己在终端里运行一样。")
      : uiText("注意：任务没有启用沙箱。你批准的命令会以你的身份运行，就像你自己在终端里运行一样。");
    this.directory.textContent = directory || uiText("尚未选择文件夹");
    const writable = this.mode.value === "workspace-write";
    this.scope.textContent = writable
      ? uiText("Claude 只能在这个文件夹里操作。每次修改文件或运行命令都会先在下方问你。")
      : uiText("只读：Claude 可以读取这个文件夹里的文件，不会修改文件；运行命令前会先问你。");
    if (selected && selected.workingDirectory !== directory) this.scope.textContent += uiTemplate` 继续此任务前，请选择原工作目录：${selected.workingDirectory}`;
    const canSend = !this.operation && !running && !!directory && !!this.prompt.value.trim() && this.capabilities?.authenticated;
    this.start.hidden = !!selected; this.resume.hidden = !selected;
    this.start.disabled = !canSend; this.resume.disabled = !canSend || selected?.workingDirectory !== directory;
    this.stop.hidden = !running; this.stop.disabled = this.operation;
    this.choose.disabled = this.operation || !!running; this.mode.disabled = this.operation || !!running;
    this.refresh.disabled = this.operation;
    this.taskSelect.replaceChildren();
    const first = element("option", "", uiText("新建任务")); first.value = ""; this.taskSelect.append(first);
    for (const task of [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const option = element("option", "", `${task.title} · ${uiText(STATUS[task.status])}`); option.value = task.id; this.taskSelect.append(option);
    }
    this.taskSelect.value = this.selectedId ?? "";
  }

  private applyCapabilities(capabilities: CodexTaskCapabilities): void {
    this.capabilities = capabilities;
    this.capability.textContent = capabilities.reason;
    this.update();
  }

  private async reload(): Promise<void> {
    try {
      const [tasks, capabilities] = await Promise.all([this.options.api.listCodexTasks(), this.options.api.codexTaskCapabilities()]);
      if (this.disposed) return;
      for (const task of tasks) this.acceptTask(task);
      this.applyCapabilities(capabilities);
    } catch (error) { this.error(error); }
  }

  private async setEnabled(enabled: boolean): Promise<void> {
    const toggle = this.options.api.setClaudeTasksEnabled;
    if (!toggle) return;
    await this.perform(async () => {
      const capabilities = await toggle(enabled);
      if (!this.disposed) this.applyCapabilities(capabilities);
    });
    if (!this.disposed) this.enable.checked = this.capabilities?.enabled === true;
  }

  private acceptTask(task: CodexTaskSummary): void {
    const previous = this.tasks.get(task.id);
    if (!previous || previous.updatedAt <= task.updatedAt) this.tasks.set(task.id, task);
  }

  private async select(id: string, resetDraft = true): Promise<void> {
    this.selectedId = id;
    if (resetDraft) { this.prompt.value = ""; this.mode.value = "read-only"; this.offerBox.hidden = true; }
    const generation = ++this.readGeneration, revision = this.revisions.get(id) ?? 0;
    this.renderMessages(id); this.update(); this.status.textContent = uiText("正在读取任务进展…");
    try {
      const details = await this.options.api.readCodexTask(id);
      if (this.disposed || generation !== this.readGeneration || this.selectedId !== id) return;
      this.acceptTask(details.task);
      if (revision === (this.revisions.get(id) ?? 0)) this.messages.set(id, details.messages);
      if (details.summary) this.summaries.set(id, details.summary);
      this.renderMessages(id); this.update();
      this.status.textContent = `${uiText(STATUS[this.tasks.get(id)!.status])}${details.hasMore ? uiText(" · 显示最近的聊天记录") : ""}`;
    } catch (error) { if (generation === this.readGeneration) this.error(error); }
  }

  private renderMessages(id: string): void {
    const messages = this.messages.get(id) ?? [];
    this.output.replaceChildren();
    for (const message of messages) {
      if (message.role === "step") { this.output.append(element("div", "codex-task-step", `· ${message.text}`)); continue; }
      const row = element("div", `codex-task-message ${message.role}`);
      row.append(element("strong", "", message.role === "user" ? uiText("你") : "Claude"), element("div", "codex-task-message-body", message.text.slice(-DISPLAY_LIMIT)));
      this.output.append(row);
    }
    if (!messages.length) this.output.append(element("p", "hint", uiText("暂无可显示的文字记录。")));
    this.output.scrollTop = this.output.scrollHeight;
    this.renderSummary(this.summaries.get(id) ?? null);
  }

  private renderSummary(summary: string | null): void {
    this.summaryBox.replaceChildren();
    this.summaryBox.hidden = !summary;
    if (summary) this.summaryBox.append(element("strong", "", uiText("Claude 的总结")), element("div", "codex-task-message-body", summary));
  }

  private async chooseDirectory(): Promise<void> {
    await this.perform(async () => {
      const directory = await this.options.api.selectDirectory();
      if (directory && !this.disposed) await this.options.onDirectorySelected(directory);
    });
    if (!this.disposed) void this.reload();
  }

  private async submit(continuing: boolean): Promise<void> {
    const prompt = this.prompt.value.trim(), taskId = this.selectedId;
    if (!prompt || this.operation || [...this.tasks.values()].some(task => task.status === "running")) return;
    if (!this.capabilities?.authenticated) return this.error(this.capabilities?.reason || uiText("请先打开开关并选择文件夹。"));
    const settings = this.options.getSettings(), mode = this.mode.value as CodexTaskMode;
    if (!settings.agent.workingDirectory) return this.error(uiText("请先选择文件夹。"));
    if (continuing && (!taskId || this.tasks.get(taskId)?.workingDirectory !== settings.agent.workingDirectory)) return this.error(uiText("继续任务前，请选择此任务原来的工作目录。"));
    await this.perform(async () => {
      if (!(await this.options.beforeStart()) || this.disposed) return;
      this.continueChat = null; this.offerBox.hidden = true; this.readGeneration++;
      this.pendingPrompt = prompt; this.status.textContent = uiText("正在交给 Claude…");
      if (taskId && continuing) { this.appendPrompt(taskId, prompt); this.summaries.delete(taskId); }
      const task = continuing
        ? await this.options.api.continueCodexTask({ taskId: taskId!, prompt, mode })
        : await this.options.api.startCodexTask({ prompt, workingDirectory: settings.agent.workingDirectory, mode, model: settings.agent.model || undefined });
      if (this.disposed) return;
      this.acceptTask(task); this.selectedId = task.id;
      if (!continuing && !this.messages.get(task.id)?.some(message => message.role === "user")) this.appendPrompt(task.id, prompt);
      if (this.prompt.value.trim() === prompt) this.prompt.value = "";
      this.renderMessages(task.id); this.status.textContent = task.status === "running" ? uiText("Claude 正在处理任务…") : uiText(STATUS[task.status]);
    });
    this.pendingPrompt = null;
  }

  private appendPrompt(id: string, text: string): void {
    const messages = this.messages.get(id) ?? [];
    messages.push({ role: "user", text }); this.messages.set(id, messages);
  }

  private async interrupt(): Promise<void> {
    const task = [...this.tasks.values()].find(item => item.status === "running");
    if (!task) return;
    await this.perform(async () => { await this.options.api.interruptCodexTask(task.id); if (!this.disposed) this.status.textContent = uiText("已停止任务。"); });
  }

  private receive(event: CodexTaskEvent): void {
    if (this.disposed) return;
    if (event.type === "task") {
      this.acceptTask(event.task);
      if (this.pendingPrompt && !this.selectedId && event.task.status === "running") {
        this.selectedId = event.task.id; this.appendPrompt(event.task.id, this.pendingPrompt);
      }
    } else if (event.type === "delta") {
      this.revisions.set(event.taskId, (this.revisions.get(event.taskId) ?? 0) + 1);
      const messages = this.messages.get(event.taskId) ?? [];
      if (messages.at(-1)?.role !== "assistant") messages.push({ role: "assistant", text: "" });
      messages.at(-1)!.text = (messages.at(-1)!.text + event.text).slice(-DISPLAY_LIMIT);
      this.messages.set(event.taskId, messages);
      if (this.selectedId === event.taskId) this.renderMessages(event.taskId);
    } else if (event.type === "step") {
      this.revisions.set(event.taskId, (this.revisions.get(event.taskId) ?? 0) + 1);
      const messages = this.messages.get(event.taskId) ?? [];
      messages.push({ role: "step", text: event.text }); this.messages.set(event.taskId, messages);
      if (this.selectedId === event.taskId) this.renderMessages(event.taskId);
    } else if (event.type === "approval") {
      this.approvals.set(event.approval.approvalId, event.approval); this.renderApprovals(); this.options.onOpen?.();
    } else if (event.type === "approval-resolved") {
      this.approvals.delete(event.approvalId); this.renderApprovals();
    } else if (event.type === "done") {
      const task = this.tasks.get(event.taskId); if (task) task.status = event.status;
      if (event.summary) this.summaries.set(event.taskId, event.summary); else this.summaries.delete(event.taskId);
      for (const [id, approval] of this.approvals) if (approval.taskId === event.taskId) this.approvals.delete(id);
      this.renderApprovals();
      if (this.selectedId === event.taskId) { this.status.textContent = uiText(STATUS[event.status]); void this.select(event.taskId, false); }
    } else if (event.type === "error") this.error(event.message);
    this.update();
  }

  private renderApprovals(): void {
    this.approvalBox.replaceChildren();
    for (const approval of this.approvals.values()) {
      const card = element("section", "codex-task-approval");
      card.append(element("strong", "", approval.kind === "command" ? uiText("Claude 想运行命令") : uiText("Claude 想修改文件")), element("p", "", approval.reason));
      if (approval.command) card.append(element("pre", "", approval.command));
      if (approval.workingDirectory) card.append(element("p", "hint", uiTemplate`目录：${approval.workingDirectory}`));
      for (const file of approval.files ?? []) {
        const details = element("details", "codex-task-file-diff");
        details.open = true;
        details.append(element("summary", "", file.path), element("pre", "", file.diff)); card.append(details);
      }
      if (approval.permissionWarning) card.append(element("p", "codex-task-warning", approval.permissionWarning));
      card.append(element("p", "hint", uiText("120 秒内不回应视为拒绝。")));
      const actions = element("div", "action-line");
      const labels = { accept: uiText("仅允许这次"), decline: uiText("拒绝这次"), cancel: uiText("取消任务") };
      const decisions = approval.kind === "file" && !approval.files?.length ? approval.decisions.filter(decision => decision !== "accept") : approval.decisions;
      if (approval.kind === "file" && !approval.files?.length) card.append(element("p", "codex-task-warning", uiText("缺少可核对的文件差异，无法允许这项修改。")));
      for (const decision of decisions) actions.append(button(labels[decision], () => {
        for (const child of actions.children) (child as HTMLButtonElement).disabled = true;
        void this.options.api.respondCodexApproval(approval.taskId, approval.approvalId, decision).catch(error => {
          if (this.disposed) return; this.error(error); this.renderApprovals();
        });
      }, decision === "accept" ? "primary" : "subtle"));
      card.append(actions); this.approvalBox.append(card);
    }
  }

  private async perform(action: () => Promise<void>): Promise<void> {
    if (this.disposed || this.operation) return;
    this.operation = true; this.update();
    try { await action(); } catch (error) { this.error(error); }
    finally { if (!this.disposed) { this.operation = false; this.update(); } }
  }
  private error(error: unknown): void {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.status.textContent = message; this.options.onError(message);
  }
}
