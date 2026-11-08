// The R20 task process: a separate `claude -p` that is never the chat process.
// Argument list, init verification, stream-json reading and process-tree shutdown.
// Every flag here was checked against `claude --help` (2.1.316) or, for the hidden
// `--permission-prompt-tool`, against the CLI's own option table; see
// docs/claude/2026-11-02-r20-tasks.md.
import { execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { claudeFailure } from '../claude';

export const TASK_MCP_SERVER = 'soft-hearts-task';
export const TASK_PERMISSION_TOOL_NAME = 'approve';
export const TASK_PERMISSION_TOOL = `mcp__${TASK_MCP_SERVER}__${TASK_PERMISSION_TOOL_NAME}`;
/** Built-in tools the task may see. Names Claude Code does not have on a platform are ignored by the CLI. */
export const TASK_TOOLS: readonly string[] = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell']);
/**
 * `ask` rules make Claude Code send every shell command and file change to the permission
 * tool, including commands it would otherwise auto-allow as read-only (`ls`, `git status`).
 */
export const TASK_ASK_RULES: readonly string[] = Object.freeze(['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const TASK_DENIED_TOOLS: readonly string[] = Object.freeze(['WebFetch', 'WebSearch']);

export const TASK_SYSTEM_PROMPT = [
  '你在帮用户完成一件具体的事。用户通过桌面陪伴应用 soft hearts 把任务交给你，你只能在当前工作目录（用户选定的文件夹）里工作。',
  '读取文件夹里的文件会自动放行；修改文件和运行命令每次都要用户在应用里批准。被拒绝时，不要换一种方式重复同一个操作，改为说明情况或换一种不需要这一步的做法。',
  '你不能联网，也不能访问文件夹以外的位置。',
  '结束时用简短的中文（如果用户用别的语言提问，就用那种语言）总结：做了什么、改了哪些文件、还有什么没做或需要用户确认。',
].join('\n');

export function taskSettingsJson(): string {
  return JSON.stringify({ permissions: { ask: [...TASK_ASK_RULES], deny: [...TASK_DENIED_TOOLS] } });
}

/** The exact argv for one task turn. The prompt goes over stdin, never on the command line. */
export function taskArguments(options: { mcpConfigFile: string; model?: string }): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--restricted',
    '--tools', TASK_TOOLS.join(','),
    '--disallowedTools', TASK_DENIED_TOOLS.join(','),
    '--settings', taskSettingsJson(),
    '--setting-sources', '',
    '--mcp-config', options.mcpConfigFile,
    '--strict-mcp-config',
    '--permission-prompt-tool', TASK_PERMISSION_TOOL,
    '--disable-slash-commands',
    '--no-session-persistence',
    '--append-system-prompt', TASK_SYSTEM_PROMPT,
  ];
  const model = (options.model ?? '').trim();
  if (model) args.push('--model', model.slice(0, 160));
  return args;
}

export interface ShimLaunch { command: string; args: string[]; env?: Record<string, string> }

/** The single MCP server the task process may load: the app's permission shim. */
export function taskMcpConfig(launch: ShimLaunch, endpoint: string, token: string): Record<string, unknown> {
  return { mcpServers: { [TASK_MCP_SERVER]: { type: 'stdio', command: launch.command, args: [...launch.args],
    env: { ...(launch.env ?? {}), SOFT_HEARTS_TASK_ENDPOINT: endpoint, SOFT_HEARTS_TASK_TOKEN: token } } } };
}

const sameFolder = (a: string, b: string, platform: NodeJS.Platform) => {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const fold = (value: string) => platform === 'win32' || platform === 'darwin' ? api.resolve(value).toLowerCase() : api.resolve(value);
  return fold(a) === fold(b);
};

/**
 * Checks Claude Code's own report before anything else is accepted: right folder, standard
 * permission mode, only allowed tools, exactly the permission MCP server, no extra folders
 * and no user plugins. Returns a user-facing reason to stop, or null.
 */
export function verifyTaskInit(event: Record<string, any>, folder: string, platform: NodeJS.Platform = process.platform): string | null {
  const tools = Array.isArray(event.tools) ? event.tools : null;
  if (!tools || !tools.includes('Read') || tools.some((tool: unknown) => typeof tool !== 'string' || !TASK_TOOLS.includes(tool)))
    return 'Claude Code 报告的工具和预期不一致，任务已停止。';
  const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : null;
  if (!servers || servers.length !== 1 || servers[0]?.name !== TASK_MCP_SERVER || servers[0]?.status !== 'connected')
    return '审批工具没有接上（或加载了别的 MCP 服务），任务已停止。';
  if (event.permissionMode !== 'default') return 'Claude Code 没有使用逐项审批的权限模式，任务已停止。';
  if (typeof event.cwd !== 'string' || !sameFolder(event.cwd, folder, platform)) return 'Claude Code 的工作目录不是你选定的文件夹，任务已停止。';
  if (Array.isArray(event.additional_directories) && event.additional_directories.length) return 'Claude Code 带上了额外的目录，任务已停止。';
  if (Array.isArray(event.plugins) && event.plugins.some((plugin: any) => plugin?.path !== 'builtin'))
    return 'Claude Code 加载了插件，任务已停止。';
  return null;
}

export interface TaskStreamSink {
  text(text: string): void;
  step(text: string): void;
}

const MAX_TEXT = 128_000;

/** One-line, user-readable description of a tool call for the progress stream. */
export function describeToolUse(name: string, input: Record<string, any>, folder: string, platform: NodeJS.Platform = process.platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const shown = (value: unknown) => {
    if (typeof value !== 'string' || !value) return '';
    const relative = api.relative(folder, api.resolve(folder, value));
    return (!relative.startsWith('..') && !api.isAbsolute(relative) ? relative || '.' : value).slice(0, 200);
  };
  const line = (value: unknown) => typeof value === 'string' ? value.split(/\r?\n/)[0].slice(0, 160) : '';
  switch (name) {
    case 'Read': return `读取 ${shown(input.file_path)}`;
    case 'Glob': return `查找文件 ${line(input.pattern)}`;
    case 'Grep': return `搜索 “${line(input.pattern)}”`;
    case 'Write': return `写入 ${shown(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `修改 ${shown(input.file_path)}`;
    case 'NotebookEdit': return `修改笔记本 ${shown(input.notebook_path)}`;
    case 'Bash': case 'PowerShell': return `运行命令：${line(input.command)}`;
    default: return `使用 ${name.slice(0, 60)}`;
  }
}

/** Consumes the task process's stream-json; returns "stop" when the process must be ended. */
export class TaskStreamReader {
  initialized = false;
  finished = false;
  failure = '';
  status: 'completed' | 'failed' = 'failed';
  summary = '';
  denials = 0;
  private output = 0;
  private streamedMessages = new Set<string>();
  private currentMessage = '';

  constructor(private readonly sink: TaskStreamSink, private readonly folder: string, private readonly platform: NodeJS.Platform = process.platform) {}

  consume(line: string): 'ok' | 'stop' {
    let event: Record<string, any>;
    try { event = JSON.parse(line); } catch { return 'ok'; }
    if (!event || typeof event !== 'object') return 'ok';
    if (event.type === 'system' && event.subtype === 'init') {
      const problem = verifyTaskInit(event, this.folder, this.platform);
      if (problem) { this.failure = problem; this.initialized = false; return 'stop'; }
      this.initialized = true;
      return 'ok';
    }
    if (!this.initialized) {
      // Nothing is accepted from a process that has not proven its isolation.
      if (['stream_event', 'assistant', 'user', 'result'].includes(event.type)) {
        this.failure ||= 'Claude Code 没有报告启动状态，任务已停止。';
        return 'stop';
      }
      return 'ok';
    }
    if (event.type === 'stream_event') {
      const inner = event.event ?? {};
      if (inner.type === 'message_start' && typeof inner.message?.id === 'string') this.currentMessage = inner.message.id;
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
        if (this.currentMessage) this.streamedMessages.add(this.currentMessage);
        return this.text(inner.delta.text);
      }
      return 'ok';
    }
    if (event.type === 'assistant') {
      const message = event.message ?? {};
      const blocks: any[] = Array.isArray(message.content) ? message.content : [];
      if (typeof message.id !== 'string' || !this.streamedMessages.has(message.id)) {
        const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
        if (text && this.text(text) === 'stop') return 'stop';
      }
      for (const block of blocks)
        if (block?.type === 'tool_use' && typeof block.name === 'string')
          this.sink.step(describeToolUse(block.name, block.input && typeof block.input === 'object' ? block.input : {}, this.folder, this.platform));
      return 'ok';
    }
    if (event.type === 'user') {
      const blocks: any[] = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of blocks) if (block?.type === 'tool_result' && block.is_error) {
        const raw = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join(' ') : '';
        this.sink.step(`↳ 没有执行：${raw.replace(/<\/?tool_use_error>/g, '').split(/\r?\n/)[0].slice(0, 160) || '已拒绝或失败'}`);
      }
      return 'ok';
    }
    if (event.type === 'result') {
      this.finished = true;
      this.denials = Array.isArray(event.permission_denials) ? event.permission_denials.length : 0;
      if (event.is_error || event.subtype !== 'success') {
        const detail = typeof event.result === 'string' ? event.result : Array.isArray(event.errors) ? event.errors.join('; ') : String(event.subtype ?? '');
        this.failure ||= claudeFailure(detail);
        this.status = 'failed';
      } else {
        this.status = 'completed';
        this.summary = typeof event.result === 'string' ? event.result.slice(0, 8_000) : '';
      }
      return 'ok';
    }
    return 'ok';
  }

  private text(value: string): 'ok' | 'stop' {
    if (!value) return 'ok';
    this.output += value.length;
    if (this.output > MAX_TEXT) { this.failure ||= '任务输出过长，已停止。'; return 'stop'; }
    this.sink.text(value);
    return 'ok';
  }
}

/**
 * Ends the task process and everything it started. POSIX: the process leads its own group
 * (spawned detached), so the whole group gets SIGTERM, then SIGKILL. Windows: taskkill /T /F.
 */
export function killProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform,
  run: typeof execFile = execFile, graceMs = 1500): void {
  const pid = child.pid;
  if (!pid) return;
  if (platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    run(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => { try { child.kill(); } catch { /* Gone. */ } });
    return;
  }
  const signal = (name: NodeJS.Signals) => { try { process.kill(-pid, name); } catch { try { child.kill(name); } catch { /* Gone. */ } } };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), graceMs).unref?.();
}
