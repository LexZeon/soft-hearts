// I-071 v2 第二步 Claude 助手: the Claude Code side (docs/claude/brain-interface.md lists it). One `claude -p` process per
// turn with no built-in tools, only this app's assistant MCP server (--mcp-config + --strict-mcp-config), no settings files,
// slash commands, session file or auto-memory; the init event is checked before anything is accepted. Flags checked against
// `claude --help` 2.1.316 and a probe on this machine (2026-11-11): `--safe-mode` would drop the --mcp-config server, so it is
// not used; `--settings {"autoMemoryEnabled":false}` plus CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 remove `memory_paths` from init.
import { claudeEnvironment, claudeFailure, claudeSettingsArguments, CLAUDE_OFFLINE_MESSAGE, CLAUDE_OFFLINE_RETRY_ATTEMPTS } from '../../brain';
import type { AssistantPrefs } from '../../../shared/safety/assistant';
import { ASSISTANT_NAME, ASSISTANT_CLI_NAME } from '../../../shared/foundation/assistant-name';

export const ASSISTANT_MCP_SERVER = 'soft-hearts-assistant';
export const ASSISTANT_TOOL_PREFIX = `mcp__${ASSISTANT_MCP_SERVER}__`;
export const ASSISTANT_PIPE_PREFIX = '\\\\.\\pipe\\soft-hearts-next-assistant-';

export interface ShimLaunch { command: string; args: string[]; env?: Record<string, string> }

/** The single MCP server the assistant process may load: the app's assistant shim with this turn's endpoint and token. */
export function assistantMcpConfig(launch: ShimLaunch, endpoint: string, token: string): Record<string, unknown> {
  return { mcpServers: { [ASSISTANT_MCP_SERVER]: { type: 'stdio', command: launch.command, args: [...launch.args],
    env: { ...(launch.env ?? {}), SOFT_HEARTS_ASSISTANT_ENDPOINT: endpoint, SOFT_HEARTS_ASSISTANT_TOKEN: token } } } };
}

/** The exact argv for one turn. The prompt goes over stdin, never on the command line. */
export function assistantArguments(options: { mcpConfigFile: string; prefs: AssistantPrefs; systemPrompt: string }): string[] {
  const { systemPrompt } = options;
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim() || systemPrompt.length > 20_000 || systemPrompt.includes('\0'))
    throw new Error('助手的系统提示词为空或过长。');
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // No built-in tool at all: no files, no shell, no web. Only the app's own MCP tools below.
    '--tools', '',
    '--mcp-config', options.mcpConfigFile,
    '--strict-mcp-config',
    // The app's registry is the permission gate (tiers, popups); Claude Code just lets its own server's tools through
    // and denies anything else that would ask.
    '--allowedTools', `mcp__${ASSISTANT_MCP_SERVER}`,
    '--permission-prompts', 'none',
    '--setting-sources', '',
    ...claudeSettingsArguments({ autoMemoryEnabled: false }), // + peer messages refused (electron/brain/claude-settings.ts)
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt', systemPrompt,
    '--model', options.prefs.model,
    '--effort', options.prefs.effort,
  ];
}

/** claudeEnvironment (no parent session, no update check) and no auto-memory. */
export function assistantEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...claudeEnvironment(source), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
}

/**
 * Claude Code's own report before anything is accepted: only this server's tools, exactly this server and connected,
 * standard permission mode, built-in plugins only, no extra folders, no memory files.
 */
export function verifyAssistantInit(event: Record<string, any>): string | null {
  const tools = Array.isArray(event.tools) ? event.tools : null;
  if (!tools || tools.some((tool: unknown) => typeof tool !== 'string' || !tool.startsWith(ASSISTANT_TOOL_PREFIX)))
    return `${ASSISTANT_CLI_NAME} 报告的工具和预期不一致（不应有任何内置工具），已停止。`;
  const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : null;
  if (!servers || servers.length !== 1 || servers[0]?.name !== ASSISTANT_MCP_SERVER || servers[0]?.status !== 'connected')
    return '软件的工具没有接上（或加载了别的 MCP 服务），已停止。';
  if (!tools.length) return `${ASSISTANT_CLI_NAME} 没有拿到软件的工具，已停止。`;
  if (event.permissionMode !== 'default') return `${ASSISTANT_CLI_NAME} 没有使用默认的权限模式，已停止。`;
  if (Array.isArray(event.additional_directories) && event.additional_directories.length) return `${ASSISTANT_CLI_NAME} 带上了额外的目录，已停止。`;
  if (Array.isArray(event.plugins) && event.plugins.some((plugin: any) => plugin?.path !== 'builtin')) return `${ASSISTANT_CLI_NAME} 加载了插件，已停止。`;
  if (event.memory_paths && typeof event.memory_paths === 'object' && Object.keys(event.memory_paths).length)
    return `${ASSISTANT_CLI_NAME} 打开了记忆文件，已停止。`;
  return null;
}

export interface AssistantStreamSink {
  text(text: string): void;
  /** A new model message began after one that wrote text (a tool call came between): the panel starts a new paragraph. */
  boundary(): void;
  thinking(on: boolean): void;
  /** The init report passed: from now on the turn may use the app's tools. */
  verified?(): void;
}

const MAX_TEXT = 200_000;

// ---- Fix 4 (I-071 third test): a tool the assistant does not have -------------------------------------------------------------
// After a refused conversion request the model asked for a tool outside its list and the turn stopped with no explanation; which
// tool was not recorded. Now the name is kept as a closed diagnostic (the name only, never its input), and a call that cannot do
// anything is not fatal: Claude Code answers it with its own "no such tool" error and the turn goes on (the system prompt tells the
// model to answer in words then). The boundary is unchanged: no tool becomes available, and every other foreign name (Claude
// Code's built-in tools that read, write, run or fetch, another MCP server's tools, anything odd) still stops the turn at once.
/** Claude Code tools that touch nothing outside the conversation (loading tool descriptions; asking the user, which -p cannot do). */
const HARMLESS_FOREIGN_TOOLS: ReadonlySet<string> = new Set(['ToolSearch', 'AskUserQuestion']);
/** Refused calls a turn may make before it is stopped anyway (a model stuck asking for tools it does not have). */
export const MAX_REFUSED_TOOLS = 3;
/** The name as a diagnostic: plain tool-name characters only (never the call's input), else a fixed word. */
export function refusedToolName(name: unknown): string {
  return typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(name) ? name : '(不可读的名字)';
}
/**
 * A foreign tool that cannot do anything here, so asking for it is not a safety stop: a bare lowercase name (the model left out the
 * server prefix; Claude Code's own tools are all PascalCase and no other MCP server is loaded, so nothing has that name), this
 * server's prefix with a malformed rest (only this app's registry could receive it, and it refuses unknown names), or one of
 * HARMLESS_FOREIGN_TOOLS. Only consulted after the init report proved the turn's tool list is this server's alone.
 */
export function harmlessForeignTool(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  // A bare name has no "__" (that would be another MCP server's tool: mcp__<server>__<tool>).
  return HARMLESS_FOREIGN_TOOLS.has(name) || (/^[a-z][a-z0-9_]{0,63}$/.test(name) && !name.includes('__'))
    || (name.startsWith(ASSISTANT_TOOL_PREFIX) && /^[A-Za-z0-9_-]{1,64}$/.test(name.slice(ASSISTANT_TOOL_PREFIX.length)));
}
const ALLOWED_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);

/** Consumes the assistant process's stream-json; "stop" means the process must be ended now. */
export class AssistantStreamReader {
  initialized = false;
  finished = false;
  failure = '';
  /** A safety stop (unexpected tool, missing isolation report): never retried, shown as is. */
  unsafe = false;
  answered = false;
  /** Fix 4: the foreign tools this turn asked for (names only), in order; a diagnostic kept with the message. */
  readonly refused: string[] = [];
  private refusedIds = new Set<string>();
  private output = 0;
  private streamed = new Set<string>();
  private current = '';
  private wroteText = false;
  private thinkingOn = false;

  constructor(private readonly sink: AssistantStreamSink) {}

  consume(line: string): 'ok' | 'stop' {
    let event: Record<string, any>;
    try { event = JSON.parse(line); } catch { return 'ok'; }
    if (!event || typeof event !== 'object') return 'ok';
    if (event.type === 'system' && event.subtype === 'init') {
      const problem = verifyAssistantInit(event);
      if (problem) return this.unsafeStop(problem);
      this.initialized = true;
      this.sink.verified?.();
      return 'ok';
    }
    if (event.type === 'system' && event.subtype === 'api_retry') {
      if (typeof event.error_status === 'number') { this.answered = true; return 'ok'; }
      const attempt = typeof event.attempt === 'number' && Number.isFinite(event.attempt) ? event.attempt : 0;
      if (attempt >= CLAUDE_OFFLINE_RETRY_ATTEMPTS) { this.failure ||= CLAUDE_OFFLINE_MESSAGE; return 'stop'; }
      return 'ok';
    }
    if (!this.initialized) {
      // Nothing is accepted from a process that has not proven its isolation.
      if (['stream_event', 'assistant', 'user', 'result'].includes(event.type)) return this.unsafeStop(`${ASSISTANT_CLI_NAME} 没有报告启动状态，已停止。`);
      return 'ok';
    }
    if (['stream_event', 'assistant', 'result'].includes(event.type)) this.answered = true;
    if (event.type === 'stream_event') {
      const inner = event.event ?? {};
      if (inner.type === 'message_start') {
        this.current = typeof inner.message?.id === 'string' ? inner.message.id : '';
        if (this.wroteText) { this.wroteText = false; this.sink.boundary(); }
        return 'ok';
      }
      if (inner.type === 'content_block_start') {
        const block = inner.content_block ?? {};
        if (!ALLOWED_BLOCKS.has(block.type)) return this.unsafeStop(`${ASSISTANT_NAME} 助手意外请求了不开放的能力，已停止。`);
        if (block.type === 'tool_use' && !this.ownTool(block.name) && this.foreignTool(block, this.current) === 'stop') return 'stop';
        this.setThinking(block.type === 'thinking' || block.type === 'redacted_thinking');
        return 'ok';
      }
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
        if (this.current) this.streamed.add(this.current);
        return this.text(inner.delta.text);
      }
      return 'ok';
    }
    if (event.type === 'assistant') {
      const message = event.message ?? {};
      const blocks: any[] = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (!ALLOWED_BLOCKS.has(block?.type)) return this.unsafeStop(`${ASSISTANT_NAME} 助手意外请求了不开放的能力，已停止。`);
        if (block.type === 'tool_use' && !this.ownTool(block.name) && this.foreignTool(block, typeof message.id === 'string' ? message.id : '') === 'stop') return 'stop';
      }
      // Claude Code's own notices (API errors) travel as synthetic messages: never the reply.
      if (message.model === '<synthetic>' || typeof event.error === 'string') return 'ok';
      if (typeof message.id !== 'string' || !this.streamed.has(message.id)) {
        const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
        if (text) return this.text(text);
      }
      return 'ok';
    }
    if (event.type === 'result') {
      this.finished = true;
      this.setThinking(false);
      if (event.is_error || event.subtype !== 'success') {
        const detail = typeof event.result === 'string' ? event.result : Array.isArray(event.errors) ? event.errors.join('; ') : String(event.subtype ?? '');
        this.failure ||= /unable to respond to this request|usage policy/i.test(detail) ? `${ASSISTANT_NAME} 拒绝了这次请求。` : claudeFailure(detail);
      }
      return 'ok';
    }
    return 'ok';
  }

  /** The first-response window ran out with nothing at all from the API. */
  noResponse(): boolean {
    if (this.answered || this.finished || this.failure) return false;
    this.failure = CLAUDE_OFFLINE_MESSAGE;
    return true;
  }

  private ownTool(name: unknown): boolean {
    return typeof name === 'string' && name.startsWith(ASSISTANT_TOOL_PREFIX) && /^[a-z][a-z0-9_]{0,63}$/.test(name.slice(ASSISTANT_TOOL_PREFIX.length));
  }

  /** A tool_use outside this server: recorded once per call; a harmless one goes on (Claude Code refuses it itself), others stop. */
  private foreignTool(block: Record<string, any>, messageId: string): 'ok' | 'stop' {
    const name = refusedToolName(block.name);
    const id = typeof block.id === 'string' && block.id ? block.id : `${messageId}:${name}`;
    if (!this.refusedIds.has(id)) { this.refusedIds.add(id); this.refused.push(name); }
    if (!harmlessForeignTool(block.name)) return this.unsafeStop(`${ASSISTANT_NAME} 助手意外请求了软件以外的工具（${name}），已停止。`);
    if (this.refused.length > MAX_REFUSED_TOOLS) { this.failure ||= `${ASSISTANT_NAME} 助手反复请求它没有的工具（${this.refused.slice(-3).join('、')}），已停止。`; return 'stop'; }
    return 'ok';
  }

  private setThinking(on: boolean): void {
    if (on === this.thinkingOn) return;
    this.thinkingOn = on;
    this.sink.thinking(on);
  }

  private unsafeStop(reason: string): 'stop' {
    if (!this.unsafe) this.failure = reason;
    this.unsafe = true;
    this.initialized = false;
    return 'stop';
  }

  private text(value: string): 'ok' | 'stop' {
    if (!value) return 'ok';
    this.output += value.length;
    if (this.output > MAX_TEXT) { this.failure ||= '回复太长，已停止。'; return 'stop'; }
    this.setThinking(false);
    this.wroteText = true;
    this.sink.text(value);
    return 'ok';
  }
}
