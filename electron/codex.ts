import { execFile, spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import type { StreamEvent } from "../shared/contracts";
import { withCodexImages } from "./codex-images";
import { PROFILE_FOLDER } from "./profile";
import { discoverCodex } from "../scripts/codex-discovery.mjs";

interface CodexTask {
  kind: "chat" | "agent";
  model: string;
  workingDirectory: string;
  writable: boolean;
  prompt: string;
  imageDataUrls?: string[];
  imageTemporaryRoot?: string;
}
const disabledChatFeatures = [
  "shell_tool",
  "apps",
  "plugins",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "image_generation",
  "view_image",
  "multi_agent",
  "skill_search",
  "hooks",
  "code_mode",
  "code_mode_only",
  "code_mode_host",
  "workspace_dependencies",
  "sleep_tool",
  "goals",
  "send_message_to_user_async",
  "default_mode_request_user_input",
  "current_time_reminder",
];
const execFileAsync = promisify(execFile);
export async function findCodex(): Promise<string> {
  const result = await discoverCodex();
  if (result.status === "found") return result.path;
  if (result.status === "invalid-override")
    throw new Error("CODEX_PATH 指向的 Codex 可执行文件不存在或不可执行。");
  throw new Error(
    "未找到官方 Codex CLI。请安装并运行 codex login，或将 CODEX_PATH 设为 Codex 可执行文件的完整路径。",
  );
}
export function codexEnvironment(): NodeJS.ProcessEnv {
  // The desktop dev session can carry an app tools pipe and parent-thread identity.
  // Never let a companion child inherit those application capabilities.
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => !key.startsWith("CODEX_") || key === "CODEX_HOME")
      .concat([
        ["NO_COLOR", "1"],
        ["RUST_LOG", "error"],
      ]),
  );
}
export function codexArguments(
  task: CodexTask,
  imageFiles: string[] = [],
): string[] {
  const args = [
    "--no-daemon",
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    task.kind === "agent" && task.writable ? "workspace-write" : "read-only",
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    "features.hooks=false",
  ];
  if (task.kind === "chat") {
    for (const feature of disabledChatFeatures)
      args.push("-c", `features.${feature}=false`);
    // Skills are a separate discovery surface from plugins and project instructions.
    args.push(
      "-c",
      "features.multi_agent_v2={enabled=false,disable_native_tools=true}",
      "-c",
      "tools.experimental_request_user_input.enabled=false",
      "-c",
      "tools.update_plan.enabled=false",
      "-c",
      "features.skip_host_skill_discovery=true",
      "-c",
      "project_doc_max_bytes=0",
    );
  } else {
    args.push("-c", "features.multi_agent=true");
    // Ignoring user config also removes Windows' sandbox backend selection.
    // The restricted-token backend enforces the chosen scope without admin setup.
    if (process.platform === "win32")
      args.push("-c", 'windows.sandbox="unelevated"');
  }
  if (task.model.trim()) args.push("--model", task.model.trim());
  for (const file of imageFiles) args.push("--image", file);
  args.push("--cd", task.workingDirectory, "-");
  return args;
}

export function chatCatalog(raw: string): string {
  const catalog = JSON.parse(raw) as { models?: Record<string, unknown>[] };
  if (!Array.isArray(catalog.models) || !catalog.models.length)
    throw new Error("Codex 未返回可验证的模型能力目录。");
  for (const model of catalog.models) {
    // Model metadata can force tools even when matching feature flags are false.
    // Keep every real model identifier and inference setting, remove local tools only.
    delete model.apply_patch_tool_type;
    delete model.tool_mode;
    delete model.multi_agent_version;
    model.shell_type = "disabled";
    model.experimental_supported_tools = [];
    model.supports_search_tool = false;
  }
  return JSON.stringify(catalog);
}
async function prepareChat(
  binary: string,
  task: CodexTask,
  signal: AbortSignal,
): Promise<{ directory: string; config: string }> {
  const directory = await mkdtemp(
    path.join(task.workingDirectory, ".tool-free-"),
  );
  try {
    const result = await execFileAsync(
      binary,
      ["debug", "models", "--bundled"],
      {
        env: codexEnvironment(),
        cwd: directory,
        signal,
        timeout: 12000,
        windowsHide: true,
        maxBuffer: 5_000_000,
      },
    );
    const catalogPath = path.join(directory, "models.json");
    await writeFile(catalogPath, chatCatalog(result.stdout), { mode: 0o600 });
    const config = `model_catalog_json=${JSON.stringify(catalogPath)}`;
    const options = codexArguments(task);
    const overrides = options.flatMap((arg, i) =>
      arg === "-c" ? ["-c", options[i + 1]] : [],
    );
    const model = task.model.trim() ? ["--model", task.model.trim()] : [];
    // Probe in an empty Codex home: no account credential is copied or required.
    const probe = await execFileAsync(
      binary,
      [
        "--no-daemon",
        ...model,
        "debug",
        "prompt-input",
        ...overrides,
        "-c",
        config,
        "capability probe",
      ],
      {
        env: { ...codexEnvironment(), CODEX_HOME: directory },
        cwd: directory,
        signal,
        timeout: 12000,
        windowsHide: true,
        maxBuffer: 5_000_000,
      },
    );
    const input = JSON.parse(probe.stdout) as { tools?: unknown[] }[];
    if (
      !Array.isArray(input) ||
      input.some((item) => Array.isArray(item.tools) && item.tools.length > 0)
    )
      throw new Error(
        "当前 Codex CLI 无法关闭全部聊天工具，请更新 CLI 或选择 API 后端。",
      );
    return { directory, config };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function streamCodex(
  task: CodexTask,
  signal: AbortSignal,
  emit: (type: StreamEvent["type"], text: string) => void,
): Promise<void> {
  if (task.imageDataUrls?.length) {
    if (task.kind !== "chat")
      throw new Error("图片只能附加到明确提交的聊天请求。");
    return withCodexImages(
      task.imageDataUrls,
      task.imageTemporaryRoot ?? path.join(os.tmpdir(), PROFILE_FOLDER, "chat"),
      signal,
      (files) => runCodex(task, signal, emit, files),
    );
  }
  return runCodex(task, signal, emit);
}
async function runCodex(
  task: CodexTask,
  signal: AbortSignal,
  emit: (type: StreamEvent["type"], text: string) => void,
  imageFiles: string[] = [],
): Promise<void> {
  signal.throwIfAborted();
  const binary = await findCodex();
  signal.throwIfAborted();
  const isolated =
    task.kind === "chat" ? await prepareChat(binary, task, signal) : null;
  if (signal.aborted) {
    if (isolated)
      await rm(isolated.directory, { recursive: true, force: true });
    signal.throwIfAborted();
  }
  const args = codexArguments(task, imageFiles);
  if (isolated) args.splice(args.length - 1, 0, "-c", isolated.config);
  const child = spawn(binary, args, {
    cwd: task.workingDirectory,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: codexEnvironment(),
  });
  let stderr = "";
  let output = "";
  let lineBuffer = "";
  let turnFailure = "";
  let finished = false;
  let stopping = false;
  const seen = new Map<string, string>();
  const stop = () => {
    if (stopping || finished) return;
    stopping = true;
    if (process.platform === "win32" && child.pid) {
      // Stop only this owned process tree, including an in-flight agent command.
      const taskkill = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "taskkill.exe",
      );
      execFile(
        taskkill,
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true },
        () => {
          if (!finished) child.kill();
        },
      );
    } else child.kill();
  };
  const timeout = setTimeout(
    () => {
      turnFailure = "Codex 任务超时，已停止。";
      stop();
    },
    task.kind === "chat" ? 120000 : 600000,
  );
  signal.addEventListener("abort", stop, { once: true });
  const consume = (line: string) => {
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "error" || event.type === "turn.failed")
      turnFailure =
        typeof event.message === "string"
          ? event.message
          : (event.error?.message ?? "Codex 未能完成任务。");
    const item = event.item as
      | {
          id?: string;
          type?: string;
          text?: string;
          command?: string;
          status?: string;
        }
      | undefined;
    if (!item || !String(event.type).startsWith("item.")) return;
    if (item.type === "agent_message" && typeof item.text === "string") {
      const key = item.id ?? "answer";
      const previous = seen.get(key) ?? "";
      if (item.text.startsWith(previous)) {
        const delta = item.text.slice(previous.length);
        if (delta) {
          if (task.kind === "chat" && !output && event.type === "item.completed")
            emit("status", "本次回复整段到达，将逐句展示。");
          output += delta;
          emit("delta", delta);
        }
      }
      seen.set(key, item.text);
    } else if (
      task.kind === "chat" &&
      [
        "command_execution",
        "file_change",
        "mcp_tool_call",
        "web_search",
        "collab_tool_call",
      ].includes(item.type ?? "")
    ) {
      turnFailure =
        "Codex 聊天通道意外请求了工具，已停止；请使用单独的 Agent 任务。";
      stop();
    } else if (
      task.kind === "agent" &&
      event.type === "item.started" &&
      item.type !== "reasoning"
    ) {
      emit(
        "status",
        item.type === "command_execution"
          ? `执行：${(item.command ?? "").slice(0, 500)}`
          : `Codex：${item.type ?? "工作中"}`,
      );
    }
    if (output.length > 100000 || line.length > 2_000_000) {
      turnFailure = "Codex 输出过长，已停止。";
      stop();
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    lineBuffer += chunk;
    let boundary: number;
    while ((boundary = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, boundary);
      lineBuffer = lineBuffer.slice(boundary + 1);
      consume(line);
    }
    if (lineBuffer.length > 2_000_000) {
      turnFailure = "Codex 返回的数据过大。";
      stop();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        finished = true;
        if (lineBuffer.trim()) consume(lineBuffer);
        resolve(code);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(task.prompt);
    });
    signal.throwIfAborted();
    if (turnFailure) throw new Error(turnFailure.slice(0, 2000));
    if (exitCode !== 0) {
      if (
        /unexpected argument|unrecognized|unknown.*(argument|option)/i.test(
          stderr,
        )
      )
        throw new Error(
          "Codex CLI 版本不支持所需的隔离参数，请更新官方 Codex CLI。",
        );
      if (/not logged|login|auth|401|token/i.test(stderr))
        throw new Error("Codex 登录不可用，请在终端运行 codex login 后重试。");
      throw new Error(
        `Codex 运行失败（退出码 ${exitCode ?? "未知"}）。请在终端检查 codex login status 和模型可用性。`,
      );
    }
    if (!output.trim())
      throw new Error("Codex 未返回文字。请检查登录状态和模型权限。");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", stop);
    if (!finished) stop();
    if (isolated)
      await rm(isolated.directory, { recursive: true, force: true });
  }
}
