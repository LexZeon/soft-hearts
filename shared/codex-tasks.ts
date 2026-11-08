import { t } from './ui-language';
/** A suggestion is never execution consent. Ordinary chat keeps its own provider. */
export type CodexTaskMode = "read-only" | "workspace-write";
export type CodexTaskStatus = "idle" | "running" | "completed" | "interrupted" | "failed";
export interface CodexTaskSuggestion {
  reason: string;
  mode: CodexTaskMode;
  needsComputer: boolean;
}
export interface CodexTaskSummary {
  id: string;
  title: string;
  workingDirectory: string;
  mode: CodexTaskMode;
  createdAt: number;
  updatedAt: number;
  status: CodexTaskStatus;
}
export interface CodexTaskDetails {
  task: CodexTaskSummary;
  /** "step" is a one-line progress note (a tool Claude used), shown between messages. */
  messages: Array<{ role: "user" | "assistant" | "step"; text: string }>;
  hasMore: boolean;
  /** Claude's closing summary of the latest turn, when it finished. */
  summary?: string;
}
export interface CodexTaskStart {
  prompt: string;
  workingDirectory: string;
  mode: CodexTaskMode;
  /** Empty follows the user's Codex default. */
  model?: string;
}
export interface CodexTaskContinue {
  taskId: string;
  prompt: string;
  mode: CodexTaskMode;
}
export type CodexApprovalDecision = "accept" | "decline" | "cancel";
export interface CodexTaskApproval {
  taskId: string;
  approvalId: string;
  kind: "command" | "file";
  reason: string;
  command?: string;
  workingDirectory?: string;
  files?: Array<{ path: string; diff: string }>;
  /** Elevation can exceed the initially selected sandbox; show before accepting. */
  permissionWarning?: string;
  decisions: CodexApprovalDecision[];
}
export interface CodexTaskCapabilities {
  authenticated: boolean;
  login: "chatgpt" | "apiKey" | "other" | "none";
  computerControl: false;
  reason: string;
  /** R20 (Claude): the user's opt-in switch, off by default. */
  enabled?: boolean;
  /** The folder chosen through the native picker; empty when none. */
  folder?: string;
  /** Claude Code on native Windows has no sandbox; the UI says so next to the switch. */
  noSandbox?: boolean;
}
export type CodexTaskEvent =
  | { type: "task"; task: CodexTaskSummary }
  | { type: "delta"; taskId: string; text: string }
  | { type: "approval"; approval: CodexTaskApproval }
  | { type: "approval-resolved"; taskId: string; approvalId: string }
  | { type: "step"; taskId: string; text: string }
  | { type: "done"; taskId: string; status: CodexTaskStatus; summary?: string }
  | { type: "error"; taskId?: string; message: string };

export const CODEX_TASK_PROMPT_LIMIT = 32_000;

/** Cheap, local suggestion only. A manual task button covers false negatives. */
export function suggestCodexTask(text: string): CodexTaskSuggestion | null {
  const input = text.trim().slice(0, CODEX_TASK_PROMPT_LIMIT);
  if (!input || /^(?:解释|介绍|什么是|为什么|如何|怎么|讲讲|what is|why |how (?:do|does|to) )/i.test(input)) return null;
  const computer = /(?:打开|操作|点击|点开|启动|关闭|填写|登录|整理|移动|删除|新建|创建|保存|截图|截屏|搜索|查找).{0,24}(?:浏览器|网页|网站|软件|应用|桌面|窗口)|(?:open|click|launch|close|navigate|fill).{0,24}(?:browser|website|webpage|app|window)/i.test(input);
  const files = /(?:修改|修复|创建|新建|编写|重构|运行|执行|测试|检查|读取|整理|分析|转换|安装|下载|删除|移动|保存|生成).{0,40}(?:代码|脚本|文件|目录|文件夹|项目|仓库|程序|命令|测试|依赖|配置|日志|报告|文档)|(?:代码|脚本|文件|项目|仓库|程序|配置).{0,30}(?:改|修复|运行|测试|重构|整理)|(?:edit|fix|create|write|refactor|run|test|inspect|read|convert|install|delete|move|save|generate).{0,40}(?:code|script|file|folder|directory|project|repo|command|test|config|log|report|document)/i.test(input);
  if (!computer && !files) return null;
  const writing = /修改|修复|创建|新建|编写|重构|安装|下载|删除|移动|保存|生成|整理|转换|edit|fix|create|write|refactor|install|delete|move|save|generate|convert/i.test(input);
  return {
    reason: computer ? t("这项请求涉及操作应用或电脑。Claude 任务目前只能处理所选文件夹里的文件和命令。") : t("这项请求涉及文件、代码或命令，可以交给 Claude 任务，在你选定的文件夹里完成。"),
    mode: writing ? "workspace-write" : "read-only",
    needsComputer: computer,
  };
}

export function validCodexTaskMode(value: unknown): value is CodexTaskMode {
  return value === "read-only" || value === "workspace-write";
}

export function validateCodexTaskPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > CODEX_TASK_PROMPT_LIMIT) {
    throw new Error(`任务内容必须为 1–${CODEX_TASK_PROMPT_LIMIT} 个字符。`);
  }
  return value.trim();
}
