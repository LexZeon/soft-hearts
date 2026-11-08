import test from "node:test";
import assert from "node:assert/strict";
import { CodexTasks, mountCodexTaskOffer, type CodexTaskBridge } from "../src/ui/CodexTasks";
import { claudeTasksOffered, watchClaudeTasks } from "../src/ui/claude-task-gate";
import type { CodexTaskDetails, CodexTaskEvent, CodexTaskSummary } from "../shared/codex-tasks";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_TASKS_UI_COPY } from '../shared/ui-copy.tasks.en';

// Narrow DOM fixture: records text and actions; no script parsing or browser behavior is mocked.
class Node {
  children: Node[] = [];
  parent: Node | null = null;
  className = ""; textContent = ""; value = ""; hidden = false; disabled = false;
  scrollTop = 0; scrollHeight = 0;
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  attributes = new Map<string, string>();
  constructor(readonly tagName: string) {}
  append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: Node[]) { for (const node of this.children) node.parent = null; this.children = []; this.append(...nodes); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
}
function all(root: Node): Node[] { return [root, ...root.children.flatMap(all)]; }
function find(root: Node, className: string): Node { return all(root).find(node => node.className.split(" ").includes(className))!; }
function text(root: Node): string { return all(root).map(node => node.textContent).join("\n"); }
function click(root: Node, label: string) {
  const node = all(root).find(item => item.tagName === "button" && item.textContent === label)!;
  assert.ok(node, `button ${label}`); assert.equal(node.disabled, false, `${label} should be enabled`); node.onclick?.();
}
async function flush() { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); }
function summary(id: string, status: CodexTaskSummary["status"] = "idle"): CodexTaskSummary {
  return { id, title: `Task ${id}`, workingDirectory: "selected-project", mode: "read-only", createdAt: 1, updatedAt: 2, status };
}
function fixture(overrides: Partial<CodexTaskBridge> = {}) {
  const original = globalThis.document;
  globalThis.document = { createElement: (tag: string) => new Node(tag) } as unknown as Document;
  const root = new Node("div");
  const settings = structuredClone(DEFAULT_SETTINGS); settings.agent.workingDirectory = "selected-project";
  const requests: unknown[] = [], errors: string[] = [];
  let emit: (event: CodexTaskEvent) => void = () => {};
  let unsubscribed = false;
  const api: CodexTaskBridge = {
    async listCodexTasks() { return []; },
    async readCodexTask(id) { return { task: summary(id), messages: [], hasMore: false }; },
    async startCodexTask(request) { requests.push(request); return summary("new", "running"); },
    async continueCodexTask(request) { requests.push(request); return summary(request.taskId, "running"); },
    async interruptCodexTask(id) { requests.push({ interrupt: id }); },
    async respondCodexApproval(taskId, approvalId, decision) { requests.push({ taskId, approvalId, decision }); },
    onCodexTaskEvent(callback) { emit = callback; return () => { unsubscribed = true; }; },
    async codexTaskCapabilities() { return { authenticated: true, login: "chatgpt", computerControl: false, reason: "当前不支持桌面操作。" }; },
    async selectDirectory() { return null; }, ...overrides,
  };
  const panel = new CodexTasks(root as unknown as HTMLElement, {
    api, getSettings: () => settings, beforeStart: async () => true,
    onDirectorySelected: path => { settings.agent.workingDirectory = path; }, onError: message => errors.push(message),
  });
  return { root, panel, settings, requests, errors, emit: (event: CodexTaskEvent) => emit(event), get unsubscribed() { return unsubscribed; },
    restore() { panel.dispose(); globalThis.document = original; } };
}

test('English task controls preserve private prompt/title/text and require the same explicit scope confirmation', async () => {
  registerUiMessages({ en: ENGLISH_TASKS_UI_COPY, 'zh-CN': {} }); setUiLanguage('en');
  const privateTitle = '新建任务', privateBody = '停止任务';
  const f = fixture({
    async listCodexTasks() { return [{ ...summary('owned'), title: privateTitle }]; },
    async readCodexTask() { return { task: { ...summary('owned'), title: privateTitle }, messages: [{ role: 'assistant', text: privateBody }], hasMore: false }; },
    async codexTaskCapabilities() { return { authenticated: true, login: 'chatgpt', computerControl: false, reason: 'Fixture connection' }; },
  });
  try {
    await f.panel.init();
    assert.ok(text(f.root).includes('Ask Claude'));
    assert.ok(text(f.root).includes('Let the companion get things done through Claude Code (off by default)'));
    assert.ok(text(f.root).includes(`${privateTitle} · Ready to continue`));
    assert.equal(find(f.root, 'codex-task-mode').value, 'read-only');
    assert.deepEqual(f.requests, []);
    const select = find(f.root, 'codex-task-select'); select.value = 'owned'; select.onchange?.(); await flush();
    assert.equal(find(f.root, 'codex-task-message-body').textContent, privateBody);
    const prompt = find(f.root, 'codex-task-prompt'); prompt.value = '选择文件夹'; prompt.oninput?.();
    assert.deepEqual(f.requests, []);
    click(f.root, 'Confirm & continue task'); await flush();
    assert.deepEqual(f.requests, [{ taskId: 'owned', prompt: '选择文件夹', mode: 'read-only' }]);
  } finally { f.restore(); setUiLanguage('zh-CN'); }
});

test("task suggestions never execute until consent; ordinary chat remains a separate action", async () => {
  const f = fixture();
  try {
    await f.panel.init(); let continued = 0;
    assert.equal(f.panel.offer("请修复这个项目的代码", () => continued++), true);
    assert.equal(find(f.root, "codex-task-mode").value, "read-only");
    assert.equal(f.requests.length, 0);
    click(f.root, "继续普通聊天"); assert.equal(continued, 1); assert.equal(f.requests.length, 0);
    f.panel.offer("请修复这个项目的代码");
    click(f.root, "同意并新建任务"); await flush();
    assert.deepEqual(f.requests, [{ prompt: "请修复这个项目的代码", workingDirectory: "selected-project", mode: "read-only", model: undefined }]);
    assert.ok(text(f.root).includes("当前不支持桌面操作"));
  } finally { f.restore(); }
});

test("explicit write consent continues an owned task and a mismatched directory blocks continuation", async () => {
  const f = fixture({ async listCodexTasks() { return [summary("owned")]; } });
  try {
    await f.panel.init(); const select = find(f.root, "codex-task-select"); select.value = "owned"; select.onchange?.(); await flush();
    const prompt = find(f.root, "codex-task-prompt"); prompt.value = "修复入口"; prompt.oninput?.();
    f.settings.agent.workingDirectory = "different-project"; f.panel.syncSettings();
    assert.equal(all(f.root).find(node => node.textContent === "同意并继续任务")!.disabled, true);
    f.settings.agent.workingDirectory = "selected-project"; f.panel.syncSettings();
    const mode = find(f.root, "codex-task-mode"); mode.value = "workspace-write"; mode.onchange?.();
    click(f.root, "同意并继续任务"); await flush();
    assert.deepEqual(f.requests, [{ taskId: "owned", prompt: "修复入口", mode: "workspace-write" }]);
  } finally { f.restore(); }
});

test("a slow read cannot replace a subsequently selected task", async () => {
  let finishFirst!: (value: CodexTaskDetails) => void;
  const first = new Promise<CodexTaskDetails>(resolve => { finishFirst = resolve; });
  const f = fixture({ async listCodexTasks() { return [summary("A"), summary("B")]; }, async readCodexTask(id) {
    return id === "A" ? first : { task: summary("B"), messages: [{ role: "assistant", text: "RESULT_B" }], hasMore: false };
  } });
  try {
    await f.panel.init(); const select = find(f.root, "codex-task-select");
    select.value = "A"; select.onchange?.(); select.value = "B"; select.onchange?.(); await flush();
    finishFirst({ task: summary("A"), messages: [{ role: "assistant", text: "STALE_A" }], hasMore: false }); await flush();
    assert.ok(text(find(f.root, "codex-task-transcript")).includes("RESULT_B"));
    assert.ok(!text(find(f.root, "codex-task-transcript")).includes("STALE_A"));
  } finally { f.restore(); }
});

test("approval shows scope warning and only supported per-request decisions; content remains text", async () => {
  const f = fixture();
  try {
    await f.panel.init();
    f.emit({ type: "approval", approval: { taskId: "owned", approvalId: "approval", kind: "command", reason: "<img src=x onerror=alert(1)>", command: "<script>untrusted()</script>", permissionWarning: "可能超出初始沙箱", decisions: ["decline", "cancel"] } });
    assert.ok(text(f.root).includes("可能超出初始沙箱"));
    assert.ok(text(f.root).includes("<script>untrusted()</script>"));
    assert.equal(all(f.root).some(node => node.tagName === "script" || node.textContent === "仅允许这次"), false);
    click(f.root, "拒绝这次"); await flush();
    assert.deepEqual(f.requests, [{ taskId: "owned", approvalId: "approval", decision: "decline" }]);
    f.emit({ type: "approval-resolved", taskId: "owned", approvalId: "approval" });
    assert.equal(find(f.root, "codex-task-approvals").children.length, 0);
  } finally { f.restore(); }
});

test("pet offer only transfers its prompt and cleanup removes only its card", () => {
  const f = fixture();
  try {
    const existing = new Node("p"); existing.textContent = "keep me"; f.root.append(existing);
    let prompt = "", chat = 0;
    const cleanup = mountCodexTaskOffer(f.root as unknown as HTMLElement, "请修复这个项目的代码", { onTask: value => { prompt = value; }, onChat: () => chat++ });
    assert.ok(cleanup); assert.equal(f.requests.length, 0);
    click(f.root, "交给 Claude"); assert.equal(prompt, "请修复这个项目的代码"); assert.equal(chat, 0);
    assert.ok(f.root.children.includes(existing)); cleanup(); assert.ok(f.root.children.includes(existing));
    assert.equal(mountCodexTaskOffer(f.root as unknown as HTMLElement, "你好", { onTask() {}, onChat() {} }), null);
    f.panel.dispose(); assert.equal(f.unsubscribed, false);
  } finally { f.restore(); }
});

test("file approval renders reviewable paths and differences and cannot accept missing previews", async () => {
  const f = fixture();
  try {
    await f.panel.init();
    f.emit({ type: "approval", approval: { taskId: "owned", approvalId: "missing", kind: "file", reason: "review unavailable", decisions: ["accept", "decline", "cancel"] } });
    assert.equal(all(f.root).some(node => node.textContent === "仅允许这次"), false);
    assert.ok(text(f.root).includes("缺少可核对的文件差异"));
    f.emit({ type: "approval-resolved", taskId: "owned", approvalId: "missing" });
    f.emit({ type: "approval", approval: { taskId: "owned", approvalId: "patch", kind: "file", reason: "update", files: [{ path: "selected-project/example.ts", diff: "-old\n+<literal>" }], decisions: ["accept", "decline", "cancel"] } });
    assert.ok(text(f.root).includes("selected-project/example.ts"));
    assert.ok(text(f.root).includes("-old\n+<literal>"));
    click(f.root, "仅允许这次"); await flush();
    assert.deepEqual(f.requests, [{ taskId: "owned", approvalId: "patch", decision: "accept" }]);
  } finally { f.restore(); }
});

test("streaming completion preserves the next draft and disposal unsubscribes", async () => {
  const f = fixture();
  try {
    await f.panel.init(); f.panel.prepare("读取项目文件"); click(f.root, "同意并新建任务"); await flush();
    f.emit({ type: "delta", taskId: "new", text: "partial" });
    const prompt = find(f.root, "codex-task-prompt"); prompt.value = "next draft";
    f.emit({ type: "done", taskId: "new", status: "completed" }); await flush();
    assert.equal(prompt.value, "next draft");
    f.panel.dispose(); assert.equal(f.unsubscribed, true);
  } finally { f.restore(); }
});

test("R20 switch: off by default, turning it on goes through the host, Windows shows the no-sandbox note", async () => {
  let enabled = false; const toggles: boolean[] = [];
  const caps = () => ({ authenticated: enabled, login: "other" as const, computerControl: false as const, reason: enabled ? "可以开始" : "默认关闭。", enabled, folder: "selected-project", noSandbox: true });
  const f = fixture({
    async codexTaskCapabilities() { return caps(); },
    // The host may show a first-run notice; here the user accepts it.
    async setClaudeTasksEnabled(value) { toggles.push(value); enabled = value; return caps(); },
  });
  try {
    const box = find(f.root, "codex-task-enable") as Node & { checked?: boolean };
    assert.equal(box.checked, false);
    await f.panel.init();
    assert.equal(box.checked, false); assert.equal(box.disabled, false);
    assert.ok(text(f.root).includes("Windows 上的 Claude Code 没有沙箱"));
    assert.equal(f.panel.offer("请修复这个项目的代码"), false, "no task offer while the switch is off");
    const prompt = find(f.root, "codex-task-prompt"); prompt.value = "整理文件"; prompt.oninput?.();
    assert.equal(all(f.root).find(node => node.textContent === "同意并新建任务")!.disabled, true, "cannot start while off");
    box.checked = true; box.onchange?.(); await flush();
    assert.deepEqual(toggles, [true]); assert.equal(box.checked, true);
    assert.equal(all(f.root).find(node => node.textContent === "同意并新建任务")!.disabled, false);
    assert.deepEqual(f.requests, [], "turning the switch on starts nothing");
  } finally { f.restore(); }
});

test("chat offers mirror the host switch, fail closed, and a later event wins over a slow first answer", async () => {
  let answer!: (value: boolean) => void; let push!: (state: { enabled: boolean }) => void;
  const stop = watchClaudeTasks({ claudeTasksEnabled: () => new Promise(resolve => { answer = resolve; }), onClaudeTasks: callback => { push = callback; return () => {}; } });
  try {
    assert.equal(claudeTasksOffered(), false, "false until the host answers");
    push({ enabled: true }); assert.equal(claudeTasksOffered(), true);
    answer(false); await flush();
    assert.equal(claudeTasksOffered(), true, "the stale first answer does not override the newer event");
    push({ enabled: false }); assert.equal(claudeTasksOffered(), false);
  } finally { stop(); }
  assert.equal(claudeTasksOffered(), false);
});

test("progress steps, approval cards and the final summary render as plain text", async () => {
  const f = fixture();
  try {
    await f.panel.init(); f.panel.prepare("读取项目文件"); click(f.root, "同意并新建任务"); await flush();
    f.emit({ type: "delta", taskId: "new", text: "我先看看。" });
    f.emit({ type: "step", taskId: "new", text: "运行命令：<b>ls</b>" });
    f.emit({ type: "approval", approval: { taskId: "new", approvalId: "a1", kind: "command", reason: "Claude 想运行命令：列文件", command: "ls -la", workingDirectory: "selected-project", permissionWarning: "Windows 上 Claude Code 没有沙箱", decisions: ["accept", "decline", "cancel"] } });
    assert.ok(text(f.root).includes("Claude 想运行命令"));
    assert.ok(text(f.root).includes("120 秒内不回应视为拒绝。"));
    assert.equal(find(f.root, "codex-task-approvals").children.length, 1);
    click(f.root, "取消任务"); await flush();
    assert.deepEqual(f.requests.at(-1), { taskId: "new", approvalId: "a1", decision: "cancel" });
    assert.equal(find(f.root, "codex-task-step").textContent, "· 运行命令：<b>ls</b>");
    f.emit({ type: "done", taskId: "new", status: "completed", summary: "改了 2 个文件。" }); await flush();
    const summaryBox = find(f.root, "codex-task-summary");
    assert.equal(summaryBox.hidden, false);
    assert.ok(text(summaryBox).includes("改了 2 个文件。"));
  } finally { f.restore(); }
});
