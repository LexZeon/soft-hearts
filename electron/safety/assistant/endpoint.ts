// I-071 v2 第二步 Claude 助手: the per-turn endpoint its MCP shim connects to. Reuses the agent channel's wire format and
// transport (HMAC handshake, one request at a time, frame limits) with a short-lived identity of its own: a fresh random token
// and a fresh private pipe (or socket) for every turn, gone as soon as the turn ends. A process left over from an earlier turn
// can no longer reach anything. The tool list it serves is the host's (AGENT_TOOLS the registry exposes right now, plus the
// assistant's own offer_choices), written for the assistant: no userWords, and confirm-tier tools say the popup decides.
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_TOOLS, type AgentToolDescriptor } from '../../../shared/safety/agent-channel';
import { ASSISTANT_CHOICES_TOOL } from '../../../shared/safety/assistant';
import type { AgentCallResult } from '../agent-channel/registry';
import { AgentChannelServer } from '../agent-channel/transport';
import { ASSISTANT_PIPE_PREFIX, assistantMcpConfig, type ShimLaunch } from './process';
import { ASSISTANT_NAME } from '../../../shared/foundation/assistant-name';

export interface McpToolDescriptor { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }

const TIER_NOTE: Record<AgentToolDescriptor['tier'], string> = {
  read: '只读。',
  reversible: `直接执行，soft hearts 会显示“由 ${ASSISTANT_NAME} 操作”。`,
  confirm: '需要用户确认：soft hearts 会弹窗，用户点“允许”才执行（拒绝或 120 秒不回应就不执行）。不需要用户原话，也不要替用户确认。',
};

const SAME = 'soft hearts 会弹窗请用户确认。';
/**
 * The catalog's sentences about userWords are for the external Claude Code. Here the popup decides, so each is rewritten
 * (tests check every pattern still matches the catalog, so a changed catalog text is noticed).
 */
export const USER_WORDS_REWRITES: Readonly<Record<string, readonly [RegExp, string]>> = Object.freeze({
  set_setting: [/：三方互通打开时要带上 userWords（用户的原话），没有就不执行；read_handbook 里 needsUserWords 为 true 的都是。/u, '（read_handbook 里 needsUserWords 为 true 的）会弹窗请用户确认。'],
  set_perception: [/打开要带上 userWords（用户的原话），没有就不执行；关掉随时可以，不需要原话。/u, '打开会弹窗请用户确认；关掉随时可以。'],
  // 敏感操作弹窗 (2026-11-12): the catalog's next sentence already says how the dialog asks, so the userWords one just goes.
  import_character_card: [/三方互通打开时（默认）要带上 userWords[^。]*。/u, ''],
  update_character_card: [/三方互通打开时（默认）要带上 userWords[^。]*。/u, ''],
  load_model: [/三方互通打开时（默认）要带上 userWords[^。]*。/u, ''],
  bind_current_model_to_character: [/三方互通打开时（默认）要带上 userWords[^。]*。/u, SAME],
  voice_preview: [/三方互通打开时（默认）要带上 userWords[^。]*。/u, SAME],
  delete_memories: [/，再带上 userWords（用户的原话），没有就不执行。/u, '；' + SAME],
  clear_song_memory: [/，再带上 userWords（用户的原话），没有就不执行。/u, '；' + SAME],
  delete_character: [/，再带上 userWords（用户的原话），没有就不执行。/u, '；' + SAME], // I-173
  set_character_voice: [/带上 userWords（用户的原话），没有就不执行；带了 soft hearts 也会弹窗/u, 'soft hearts 会弹窗'], // 2026-11-24
  use_bundled_model: [/；三方互通打开时要带上 userWords（用户的原话）。/u, '。' + SAME],
  convert_character_language: [/；三方互通打开时（默认）还要先带上 userWords（用户的原话），没有就不执行。/u, '。'],
});

/**
 * I-071 fix 5: in the Claude 助手 the software shows the conversion intro itself (service.ts showConversionIntro), so the catalog's
 * "say the intro to the user first" is rewritten here (tests check each pattern still matches the catalog).
 */
export const ASSISTANT_ONLY_REWRITES: Readonly<Record<string, readonly (readonly [RegExp, string])[]>> = Object.freeze({
  prepare_character_conversion: [
    [/intro：要先原样告诉用户的一段话（带什么、不带什么、准确的调用次数）/u, 'intro：带什么、不带什么、准确的调用次数（soft hearts 会自己把它显示给用户，你不要重复）'],
    [/先把这些用一两句告诉用户，再让用户逐个选名字/u, '然后让用户逐个选名字'],
  ],
});

/** A catalog description as the assistant reads it: no userWords anywhere (an unknown mention loses its sentence). */
export function assistantDescription(name: string, description: string): string {
  const rewrite = USER_WORDS_REWRITES[name];
  let text = rewrite ? description.replace(rewrite[0], rewrite[1]) : description;
  for (const [pattern, replacement] of ASSISTANT_ONLY_REWRITES[name] ?? []) text = text.replace(pattern, replacement);
  return text.replace(/[^。]*userWords[^。]*。?/gu, '').trim();
}

export const CHOICES_TOOL: McpToolDescriptor = Object.freeze({
  name: ASSISTANT_CHOICES_TOOL, title: '给选项按钮',
  description: '在聊天框里把 2～6 个选项做成按钮给用户点（比如转卡时每个昵称“保留原样 / 换成英文”）。调用后结束这一轮回复；用户点的那个会作为下一条消息发来。权限：只显示按钮，不改任何东西。',
  inputSchema: { type: 'object', properties: {
    question: { type: 'string', maxLength: 200, description: '按钮上方的一句问题，说清楚在选什么' },
    options: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string', maxLength: 60 }, description: '每个按钮上的字' },
  }, required: ['options'], additionalProperties: false },
  annotations: { title: '给选项按钮', readOnlyHint: true, openWorldHint: false },
});

/** The catalog descriptors of `names` (the registry's exposed tools), rewritten for the assistant. */
export function assistantToolList(names: readonly string[]): McpToolDescriptor[] {
  const exposed = new Set(names);
  const tools = AGENT_TOOLS.filter(tool => exposed.has(tool.name)).map(tool => {
    const { userWords: _dropped, ...properties } = tool.inputSchema.properties as Record<string, unknown>;
    const description = assistantDescription(tool.name, tool.description);
    return {
      name: tool.name, title: tool.title,
      description: `${description}\n权限：${TIER_NOTE[tool.tier]}${tool.interconnectOnly ? '只在“三方互通”打开时有。' : ''}`,
      // userWords leaves `required` too (I-071 v2 第三步: a required field the schema no longer has made the model fill it anyway).
      inputSchema: { ...tool.inputSchema, properties, ...(tool.inputSchema.required ? { required: tool.inputSchema.required.filter(key => key !== 'userWords') } : {}) },
      annotations: { title: tool.title, readOnlyHint: tool.tier === 'read', destructiveHint: tool.name === 'delete_memories' || tool.name === 'delete_character',
        idempotentHint: tool.tier !== 'confirm', openWorldHint: false },
    };
  });
  return [...tools, CHOICES_TOOL];
}

export interface AssistantEndpointHandlers {
  list(): McpToolDescriptor[];
  call(tool: unknown, args: unknown): Promise<AgentCallResult>;
}
export interface AssistantEndpoint { readonly endpoint: string; readonly mcpConfigFile: string; close(): Promise<void> }

/** Starts the endpoint and writes the owner-only MCP config file that carries its token. */
export async function openAssistantEndpoint(options: { launch: ShimLaunch; handlers: AssistantEndpointHandlers; platform?: NodeJS.Platform; tempRoot?: string }): Promise<AssistantEndpoint> {
  const platform = options.platform ?? process.platform;
  // mkdtemp creates the folder 0700; the config file below is 0600.
  const directory = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), 'shn-assistant-'));
  const token = randomBytes(32).toString('hex');
  const endpoint = platform === 'win32' ? `${ASSISTANT_PIPE_PREFIX}${randomBytes(12).toString('hex')}` : path.join(directory, 'a.sock');
  let open = true;
  const server = new AgentChannelServer(endpoint, {
    token: () => open ? token : null,
    list: () => ({ tools: open ? options.handlers.list() : [] }),
    call: (tool, args): Promise<AgentCallResult> => open ? options.handlers.call(tool, args)
      : Promise.resolve({ ok: false, error: { code: 'channel_off', message: '这一轮已经结束，没有执行。' } }),
  }, { maxConnections: 2, ratePerMinute: 120, idleTimeoutMs: 30 * 60_000 }, platform);
  const mcpConfigFile = path.join(directory, 'mcp.json');
  try {
    await server.start();
    await writeFile(mcpConfigFile, JSON.stringify(assistantMcpConfig(options.launch, endpoint, token)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (platform !== 'win32') await chmod(mcpConfigFile, 0o600);
  } catch (error) {
    open = false;
    await server.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    endpoint, mcpConfigFile,
    async close() {
      if (!open) return;
      open = false;
      await server.stop().catch(() => {});
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    },
  };
}
