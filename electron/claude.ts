import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StreamEvent } from "../shared/contracts";
import { claudeModelOrDefault } from "../shared/claude-model";
import type { ReplyIncident } from "../shared/chat-incident";
import { COMPANION_RULES } from "../shared/companion-rules";
import { PERCEPTION_RULE } from "../shared/perception-rule";
import { COMPANION_REFUSAL_ENABLED, COMPANION_REFUSAL_RULES } from "../shared/companion-refusal-rules";
import { APP_REPLY_OPENING, OPENING_SYSTEM_SENTENCE } from "./reply-opening";
import { discoverClaude } from "../scripts/claude-discovery.mjs";
import { PROFILE_FOLDER } from "./profile";

/**
 * Companion chat through the user's own, unmodified Claude Code CLI.
 *
 * Every call is one headless `claude -p` process with all built-in tools, MCP
 * servers, slash commands, skills, hooks, plugins, CLAUDE.md files and settings
 * files turned off, in an empty temporary folder, with no saved session. The
 * init event is checked before any text is accepted: if Claude Code reports a
 * tool or MCP server, the turn stops. Credentials are never read or copied; the
 * CLI uses whatever login the user completed through Anthropic's own flow.
 */
export interface ClaudeTask {
  kind: "chat";
  model: string;
  /** Kept for call-site compatibility; Claude always runs in its own empty temp folder. */
  workingDirectory: string;
  writable: boolean;
  prompt: string;
  imageDataUrls?: string[];
  /** Accepted for call-site compatibility; images go over stdin, not to disk. */
  imageTemporaryRoot?: string;
  /**
   * Replaces CLAUDE_SYSTEM_PROMPT for this one call (the inner loop's strict JSON decision).
   * Every isolation flag stays; omitting it keeps the arguments exactly as before.
   */
  systemPrompt?: string;
}
/** Usage reported by Claude Code's final `result` event; missing fields stay null. */
export interface ClaudeUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  costUsd: number | null;
}
type Emit = (type: StreamEvent["type"], text: string) => void;

/**
 * A failed Claude Code turn: the short friendly message, plus the raw text it was made from. The raw
 * text is kept only so the failure can be classified (shared/claude-failure.ts); it is never displayed.
 */
export class ClaudeFailureError extends Error {
  /** `incident`: the model refused, or answered with nothing (shared/chat-incident.ts); the chat then fails quietly. */
  constructor(message: string, readonly detail = "", readonly unsafe = false, readonly incident?: ReplyIncident) {
    super(message);
    this.name = "ClaudeFailureError";
  }
}

/**
 * X2: with the network off Claude Code does not fail the turn. It
 * retries the request with backoff for minutes, printing stream-json `system/api_retry` events whose
 * `error_status` is null when no HTTP answer came back at all (shape read from claude.exe 2.1.x). The
 * second such retry ends the turn as offline; so does a turn that gets no answer whatsoever (no stream
 * event, message, result, or a retry the server answered) within CLAUDE_FIRST_RESPONSE_TIMEOUT_MS.
 * A retry with a status (busy, overloaded, 5xx) means the server is reachable and is waited for as before.
 */
export const CLAUDE_OFFLINE_RETRY_ATTEMPTS = 2;
export const CLAUDE_FIRST_RESPONSE_TIMEOUT_MS = 30_000;
/** Shown only in developer mode; the user sees her own words and the "needs attention" panel. */
export const CLAUDE_OFFLINE_MESSAGE = "连不上 Claude，网络可能断开了，已停止。";
/** Classification text only (shared/claude-failure.ts reads "Unable to connect to API" as `network`); never displayed. */
export const claudeOfflineDetail = (reason: string): string => `Unable to connect to API (${reason}).`;

/** The app's own words for the two "no usable reply" endings; shown only in developer mode, classified as `other`. */
export const CLAUDE_REFUSED_MESSAGE = "Claude 拒绝了这次请求。";
export const CLAUDE_EMPTY_MESSAGE = "Claude 没有返回文字。请检查 Claude Code 登录状态。";

/** Claude Code's `stop_reason` value (also in the API) for a reply the model refused to give. */
const isRefusalReason = (value: unknown): boolean => typeof value === "string" && value.toLowerCase() === "refusal";
/** The sentence Claude Code prints in place of a reply when the request was stopped for policy reasons. */
const REFUSAL_NOTICE = /unable to respond to this request|appears to violate our usage policy/i;

/**
 * Trial seam, off unless set: start the app with SOFT_HEARTS_SIMULATE_CLAUDE_FAILURE="<a failure text>"
 * (for example "You've hit your session limit · resets 11:59pm") and every Claude call (chat, retry,
 * her prepared lines) fails with that text, as if Claude Code had printed it. Nothing else changes: the
 * failure travels the same way a real one does. Used to look at the "Claude cannot answer" experience
 * (docs/claude/2026-11-02-in-character-errors.md) without using up an allowance.
 */
export function simulatedClaudeFailure(env: NodeJS.ProcessEnv = process.env): ClaudeFailureError | null {
  const text = env.SOFT_HEARTS_SIMULATE_CLAUDE_FAILURE?.trim().slice(0, 2000);
  return text ? new ClaudeFailureError(claudeFailure(text), text) : null;
}

export const CLAUDE_SYSTEM_PROMPT =
  "你在一个桌面陪伴应用里，扮演用户消息中描述的角色。你没有任何工具，也不能读写文件或执行命令。严格按用户消息里的要求和格式只输出回复内容；不要提及自己是 Claude Code 或编程助手。";

/**
 * Ordinary companion chat on the one-process-per-message path (the fallback of PersistentClaudeChat:
 * persistent sessions off, degraded after two process failures, or a second turn while one runs).
 * The same companion rules as the persistent process's fixed system prompt
 * (electron/claude-session-prompt.ts), so chat says the same thing on either path. Every other
 * streamClaude caller keeps CLAUDE_SYSTEM_PROMPT unchanged.
 * The "婉拒也要像她" section follows the companion rules only when COMPANION_REFUSAL_ENABLED is on
 * (shared/companion-refusal-rules.ts; off since).
 */
export function claudeChatSystemPrompt(options: { refusalRules?: boolean; opening?: boolean } = {}): string {
  // The perception fact (shared/perception-rule.ts, pretrial issue 8) comes last, after the rules and the section, as on the persistent path.
  // I-046 'fixed': the one opening marker is named right after the base, as on the persistent path (electron/reply-opening.ts).
  const opening = options.opening ?? APP_REPLY_OPENING === "fixed";
  return CLAUDE_SYSTEM_PROMPT + (opening ? OPENING_SYSTEM_SENTENCE : "") + "\n" + COMPANION_RULES + ((options.refusalRules ?? COMPANION_REFUSAL_ENABLED) ? "\n" + COMPANION_REFUSAL_RULES : "")
    + "\n" + PERCEPTION_RULE;
}
export const CLAUDE_CHAT_SYSTEM_PROMPT = claudeChatSystemPrompt();

export async function findClaude(): Promise<string> {
  const result = await discoverClaude();
  if (result.status === "found") return result.path;
  if (result.status === "invalid-override")
    throw new Error("CLAUDE_PATH 指向的 Claude Code 可执行文件不存在。");
  throw new Error(
    "未找到 Claude Code。请先安装官方 Claude Code 并运行 claude 完成登录，或把 CLAUDE_PATH 设为 claude.exe 的完整路径。",
  );
}

// Keep the user's own auth/provider choices; drop everything that identifies or
// connects to a parent Claude Code session (session ids, sockets, entrypoints,
// late MCP servers), so a pet started from inside Claude Code stays isolated.
const keptClaudeVariables = new Set([
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_GIT_BASH_PATH",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
]);
export function claudeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("CLAUDE") && !keptClaudeVariables.has(upper)) continue;
    if (upper === "ELECTRON_RUN_AS_NODE") continue;
    env[key] = value;
  }
  env.NO_COLOR = "1";
  // One short-lived process per reply: skip the background update check.
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

export function claudeArguments(task: Pick<ClaudeTask, "model" | "systemPrompt">, systemPrompt = task.systemPrompt ?? CLAUDE_SYSTEM_PROMPT): string[] {
  if (typeof systemPrompt !== "string" || !systemPrompt.trim() || systemPrompt.length > 20_000 || systemPrompt.includes("\0"))
    throw new Error("Claude 系统提示词为空或过长。");
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--strict-mcp-config",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--setting-sources", "",
    "--system-prompt", systemPrompt,
  ];
  // The chat model is kept as saved (the memory scope depends on it); a name inherited from the
  // Codex/OpenAI era (gpt-5, o4-mini…) is not sent to Claude Code, which then uses its default.
  const model = claudeModelOrDefault(task.model);
  if (model) args.push("--model", model.slice(0, 160));
  return args;
}

const imagePattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;
function imageBlock(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length > 6_000_000)
    throw new Error("图片格式不正确或过大。");
  const match = imagePattern.exec(value);
  if (!match) throw new Error("Claude 只接受 PNG、JPEG 或 WebP 图片。");
  const bytes = Buffer.from(match[2], "base64");
  const valid =
    match[1] === "png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === "jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid || bytes.toString("base64") !== match[2]) throw new Error("图片数据不正确。");
  return { type: "image", source: { type: "base64", media_type: `image/${match[1]}`, data: match[2] } };
}

/** The single stream-json user message written to Claude Code's stdin. */
export function claudeInput(task: Pick<ClaudeTask, "prompt" | "imageDataUrls">): string {
  if (!task.prompt || task.prompt.length > 400_000) throw new Error("聊天内容为空或过长。");
  const images = task.imageDataUrls ?? [];
  if (!Array.isArray(images) || images.length > 2) throw new Error("每次最多附带 2 张图片。");
  const content: Record<string, unknown>[] = [
    { type: "text", text: task.prompt },
    ...images.map(imageBlock),
  ];
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

/** Turns friendly messages out of a failed result without echoing request text. */
export function claudeFailure(text: string): string {
  const value = text.slice(0, 2000);
  if (/not logged in|log ?in|\/login|oauth|credential|invalid api key|authenticat|401/i.test(value))
    return "Claude Code 未登录或登录已失效。请在终端运行 claude 完成登录后重试。";
  if (/usage limit|rate limit|limit reached|429|overloaded|529/i.test(value))
    return "Claude 暂时不可用（额度已用完或服务繁忙），请稍后再试。";
  if (/unknown option|unrecognized|unexpected argument|invalid value/i.test(value))
    return "当前 Claude Code 版本不支持所需的隔离参数，请运行 claude update 后重试。";
  return value || "Claude Code 未能完成回复。";
}

/**
 * Consumes Claude Code stream-json lines. Pure, so it can be tested without a
 * process: returns "stop" with a reason when the turn must be killed.
 */
export class ClaudeStreamReader {
  output = "";
  failure = "";
  /** The raw failure text behind `failure` (bounded), for classification only. */
  failureDetail = "";
  initialized = false;
  finished = false;
  /** The stop was a safety stop (tools, MCP, missing isolation report), never a retry candidate. */
  unsafe = false;
  /** Token counts and cost from a successful `result` event, when Claude Code reports them. */
  usage: ClaudeUsage | null = null;
  /**
   * The model refused this reply: a `refusal` stop reason anywhere in the turn's events, or Claude Code's usage-policy
   * notice. Not a failure of the process; the caller settles the turn as a refusal instead of showing any of this text.
   */
  refused = false;
  /** X2: the API answered something in this turn (a stream event, a message, a result, or a retry with an HTTP status). */
  answered = false;
  private messageText = new Map<string, string>();
  /**
   * `verified`: a long-lived process already reported a clean init in an
   * earlier turn. Any init in this turn is still checked again.
   */
  constructor(private readonly emit: Emit, options: { verified?: boolean } = {}) {
    this.initialized = options.verified === true;
  }

  consume(line: string): "ok" | "stop" {
    let event: Record<string, any>;
    try { event = JSON.parse(line); } catch { return "ok"; }
    return this.consumeEvent(event);
  }

  consumeEvent(event: Record<string, any>): "ok" | "stop" {
    if (!event || typeof event !== "object") return "ok";
    if (event.type === "system" && event.subtype === "init") {
      const tools = Array.isArray(event.tools) ? event.tools : null;
      const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : null;
      if (!tools || tools.length || !servers || servers.length) {
        this.initialized = false;
        this.unsafe = true;
        this.failure = "Claude Code 没能关闭全部工具，已停止。请运行 claude update 后重试。";
        return "stop";
      }
      this.initialized = true;
      return "ok";
    }
    if (event.type === "system" && event.subtype === "api_retry") {
      if (typeof event.error_status === "number") { this.answered = true; return "ok"; }
      const attempt = typeof event.attempt === "number" && Number.isFinite(event.attempt) ? event.attempt : 0;
      return attempt >= CLAUDE_OFFLINE_RETRY_ATTEMPTS
        ? this.offline(`Claude Code retry ${Math.min(attempt, 99)} got no HTTP response`) : "ok";
    }
    if (event.type === "stream_event" || event.type === "assistant" || event.type === "result") this.answered = true;
    if (event.type === "stream_event") {
      const inner = event.event ?? {};
      if (inner.type === "content_block_start" && inner.content_block?.type
        && !["text", "thinking", "redacted_thinking"].includes(inner.content_block.type))
        return this.toolRequested();
      if (inner.type === "message_delta" && isRefusalReason(inner.delta?.stop_reason)) this.refused = true;
      if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta"
        && typeof inner.delta.text === "string") {
        this.streamed = true;
        return this.append(inner.delta.text);
      }
      return "ok";
    }
    if (event.type === "assistant") {
      const message = event.message ?? {};
      const blocks: any[] = Array.isArray(message.content) ? message.content : [];
      if (blocks.some(block => block && !["text", "thinking", "redacted_thinking"].includes(block.type)))
        return this.toolRequested();
      if (isRefusalReason(message.stop_reason)) this.refused = true;
      // Partial-message deltas are the live stream; complete messages are kept
      // only as a fallback for a CLI that sent no deltas, emitted at the end.
      const text = blocks.filter(block => block?.type === "text" && typeof block.text === "string")
        .map(block => block.text).join("");
      // Claude Code's own notices (API errors, the usage-policy sentence) travel as synthetic assistant messages:
      // they are never the reply, and the policy one marks a refusal.
      if (message.model === "<synthetic>" || typeof event.error === "string") {
        if (REFUSAL_NOTICE.test(text)) this.refused = true;
        return "ok";
      }
      const key = typeof message.id === "string" ? message.id : `message-${this.messageText.size}`;
      this.messageText.set(key, text);
      return "ok";
    }
    if (event.type === "result") {
      this.finished = true;
      if (isRefusalReason(event.stop_reason) || isRefusalReason(event.terminal_reason)) this.refused = true;
      if (event.is_error || event.subtype !== "success") {
        const detail = typeof event.result === "string" ? event.result
          : Array.isArray(event.errors) ? event.errors.join("; ") : String(event.subtype ?? "");
        // A refusal is not a process failure: the host settles the turn as a refusal (no technical text is kept).
        if (this.refused || REFUSAL_NOTICE.test(detail)) { this.refused = true; return "ok"; }
        this.failure = claudeFailure(detail);
        this.failureDetail = detail.slice(0, 2000);
        return "stop";
      }
      this.usage = claudeUsage(event);
      if (!this.streamed) {
        const text = [...this.messageText.values()].join("");
        if (text) return this.append(text);
      }
      return "ok";
    }
    return "ok";
  }

  /**
   * X2: the first-response window ran out. True (and the failure recorded) only when nothing
   * answered and the turn has not ended; the caller then stops the turn.
   */
  noResponse(windowMs: number): boolean {
    if (this.answered || this.finished || this.failure) return false;
    this.offline(`no response within ${Math.round(windowMs / 1000)} s`);
    return true;
  }

  private offline(reason: string): "stop" {
    this.failure ||= CLAUDE_OFFLINE_MESSAGE;
    this.failureDetail = claudeOfflineDetail(reason);
    return "stop";
  }

  private streamed = false;
  private append(text: string): "ok" | "stop" {
    if (!text) return "ok";
    if (!this.initialized) {
      // A safety stop already recorded is the real reason; what the process writes while it is being killed is not.
      if (!this.unsafe) this.failure = "Claude Code 未报告隔离状态，已停止。";
      this.unsafe = true;
      return "stop";
    }
    this.output += text;
    this.emit("delta", text);
    if (this.output.length > 100_000) {
      this.failure = "Claude 输出过长，已停止。";
      return "stop";
    }
    return "ok";
  }
  private toolRequested(): "stop" {
    // An earlier safety stop keeps its reason (as in append).
    if (!this.unsafe) this.failure = "Claude 聊天通道意外请求了工具，已停止。";
    this.unsafe = true;
    return "stop";
  }
}

/** Numbers only (no text) from a result event's `usage` and `total_cost_usd`. */
export function claudeUsage(event: Record<string, any>): ClaudeUsage | null {
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const usage = event?.usage && typeof event.usage === "object" ? event.usage : {};
  const result: ClaudeUsage = {
    inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
    cacheReadInputTokens: count(usage.cache_read_input_tokens), cacheCreationInputTokens: count(usage.cache_creation_input_tokens),
    costUsd: count(event?.total_cost_usd),
  };
  return Object.values(result).some(value => value !== null) ? result : null;
}

/** Ends a Claude Code process (and, on Windows, its process tree). */
export function terminateClaude(child: ChildProcess, closed: () => boolean): void {
  if (closed()) return;
  if (process.platform === "win32" && child.pid) {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {
      if (!closed()) child.kill();
    });
  } else child.kill();
}

let claudeCallsRunning = 0;
/** How many one-shot Claude Code calls (streamClaude) are running now. I-021: her background notes start only while none is. */
export function claudeCallsInFlight(): number { return claudeCallsRunning; }
/** A model call that does not go through streamClaude (the warm reaction haiku, electron/inner-loop/warm-line.ts) counts too: call the result when it ends. */
export function noteClaudeCall(): () => void {
  claudeCallsRunning++;
  let open = true;
  return () => { if (open) { open = false; claudeCallsRunning--; } };
}

export async function streamClaude(
  task: ClaudeTask,
  signal: AbortSignal,
  emit: Emit,
  binaryOverride?: string,
  /** Test seam only: arguments before Claude Code's own (tests run a script through node). The app never sets it. */
  leadingArgs: readonly string[] = [],
  /** Test seam only: a shorter X2 first-response window. */
  limits: { firstResponseTimeoutMs?: number } = {},
): Promise<ClaudeUsage | null> {
  claudeCallsRunning++;
  try { return await runClaudeCall(task, signal, emit, binaryOverride, leadingArgs, limits); }
  finally { claudeCallsRunning--; }
}

async function runClaudeCall(task: ClaudeTask, signal: AbortSignal, emit: Emit, binaryOverride: string | undefined,
  leadingArgs: readonly string[], limits: { firstResponseTimeoutMs?: number }): Promise<ClaudeUsage | null> {
  if (task.kind !== "chat" || task.writable) throw new Error("Claude 聊天通道只支持无工具的普通聊天。");
  signal.throwIfAborted();
  const simulated = simulatedClaudeFailure();
  if (simulated) throw simulated;
  claudeInput(task); // Validate before any process work.
  const args = claudeArguments(task);
  const binary = binaryOverride ?? await findClaude();
  signal.throwIfAborted();
  const root = path.join(os.tmpdir(), PROFILE_FOLDER, "claude-chat");
  await mkdir(root, { recursive: true, mode: 0o700 });
  // An empty, throwaway folder: nothing for Claude Code to discover or read.
  const directory = await mkdtemp(path.join(root, "turn-"));
  // 关掉之后的旧帧 (Codex T-205 round 4): the turn may have been stopped, or a frame dropped, while the folder was made (the user
  // turned sharing off: electron/main.ts aborts the chat and its getters leave the frame out). Checked and read again here, where
  // nothing waits any more until the line is written to stdin: a stopped turn starts no process and writes nothing.
  let input: string;
  try { signal.throwIfAborted(); input = claudeInput(task); }
  catch (error) { await rm(directory, { recursive: true, force: true }).catch(() => {}); throw error; }
  const child = spawn(binary, [...leadingArgs, ...args], {
    cwd: directory,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: claudeEnvironment(),
  });
  let stderr = "";
  let lineBuffer = "";
  let closed = false;
  let stopping = false;
  // Once stopped, nothing more reaches the caller: on Windows taskkill takes a moment and the
  // process keeps writing until it is gone (found when these tests first ran on Windows).
  const reader = new ClaudeStreamReader((type, text) => { if (!stopping && !signal.aborted) emit(type, text); });
  const stop = () => {
    if (stopping || closed) return;
    stopping = true;
    terminateClaude(child, () => closed);
  };
  const timeout = setTimeout(() => {
    reader.failure ||= "Claude 回复超时，已停止。";
    stop();
  }, 120_000);
  const firstResponseMs = limits.firstResponseTimeoutMs ?? CLAUDE_FIRST_RESPONSE_TIMEOUT_MS;
  const stall = setTimeout(() => { if (reader.noResponse(firstResponseMs)) stop(); }, firstResponseMs); // X2: offline
  stall.unref?.();
  signal.addEventListener("abort", stop, { once: true });
  const consume = (line: string) => {
    if (line.length > 2_000_000) { reader.failure ||= "Claude 返回的数据过大。"; stop(); return; }
    if (reader.consume(line) === "stop") stop();
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
    if (lineBuffer.length > 2_000_000) { reader.failure ||= "Claude 返回的数据过大。"; stop(); }
  });
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => {
        closed = true;
        if (lineBuffer.trim()) consume(lineBuffer);
        resolve(code);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
    signal.throwIfAborted();
    if (reader.failure) throw new ClaudeFailureError(reader.failure, reader.failureDetail, reader.unsafe);
    if (reader.refused) throw new ClaudeFailureError(CLAUDE_REFUSED_MESSAGE, "", false, "refusal");
    if (exitCode !== 0) throw new ClaudeFailureError(claudeFailure(stderr) || `Claude Code 运行失败（退出码 ${exitCode ?? "未知"}）。`, stderr.slice(0, 2000));
    if (!reader.output.trim()) throw new ClaudeFailureError(CLAUDE_EMPTY_MESSAGE, "", false, "empty");
    return reader.usage;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      throw new Error("无法启动 Claude Code，请确认已安装并能在终端运行 claude。");
    throw error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(stall);
    signal.removeEventListener("abort", stop);
    if (!closed) stop();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
