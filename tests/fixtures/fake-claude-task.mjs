// Fake `claude -p` for R20 task tests. Speaks stream-json on stdout, launches the MCP server
// named in --mcp-config (the real task shim), and asks its permission tool the way Claude Code
// does: tools/call {tool_name, input, tool_use_id} -> text JSON {behavior, ...}.
// Env: FAKE_SCRIPT (JSON file with {init?, steps[]}), FAKE_RECORD (JSON file to write argv/cwd/input).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
const script = process.env.FAKE_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_SCRIPT, 'utf8')) : { steps: [] };
const out = event => process.stdout.write(JSON.stringify(event) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (script.lateOnTerm) process.on('SIGTERM', () => {
  // A process that keeps talking after it was told to stop: the app must drop all of this.
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LATE TEXT' } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'LATE RESULT' });
  setTimeout(() => process.exit(0), 50);
});

// --- MCP client for the configured server -------------------------------------------------
const config = JSON.parse(readFileSync(value('--mcp-config'), 'utf8'));
const [serverName, server] = Object.entries(config.mcpServers ?? {})[0] ?? [];
const mcp = spawn(server.command, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
let mcpBuffer = '', nextId = 1;
const waiting = new Map();
mcp.stdout.setEncoding('utf8');
mcp.stdout.on('data', chunk => {
  mcpBuffer += chunk; let end;
  while ((end = mcpBuffer.indexOf('\n')) >= 0) {
    const line = mcpBuffer.slice(0, end); mcpBuffer = mcpBuffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message); waiting.delete(message.id);
  }
});
const rpc = (method, params) => new Promise(resolve => {
  const id = nextId++; waiting.set(id, resolve);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const promptTool = value('--permission-prompt-tool');
async function ask(toolName, input, id) {
  const response = await rpc('tools/call', { name: promptTool.split('__').at(-1), arguments: { tool_name: toolName, input, tool_use_id: id } });
  return JSON.parse(response.result.content[0].text);
}

// --- stdin: one stream-json user message ---------------------------------------------------
let input = '';
process.stdin.setEncoding('utf8');
const message = await new Promise(resolve => {
  process.stdin.on('data', chunk => { input += chunk; if (input.includes('\n')) resolve(JSON.parse(input.slice(0, input.indexOf('\n')))); });
});
if (process.env.FAKE_RECORD) writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv, cwd: process.cwd(), prompt: message.message.content[0].text,
  env: { CLAUDECODE: process.env.CLAUDECODE ?? null, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID ?? null, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null } }));

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const list = await rpc('tools/list', {});
const connected = !!init.result && list.result?.tools?.some(tool => `mcp__${serverName}__${tool.name}` === promptTool);
// preInit: permission asks that reach the app before its init report is on stdout (X-090). Nothing is
// printed for them, so only the app's start gate (not the stdout reader) can refuse them.
let preNo = 0;
for (const step of script.preInit ?? []) {
  const decision = await ask(step.tool, step.input, `toolu_pre_${++preNo}`);
  if (process.env.FAKE_DECISIONS) appendFileSync(process.env.FAKE_DECISIONS, JSON.stringify({ tool: step.tool, preInit: true, decision }) + '\n');
}
const tools = (value('--tools') ?? '').split(',').filter(name => name && !['PowerShell', 'MultiEdit'].includes(name));
out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools, mcp_servers: [{ name: serverName, status: connected ? 'connected' : 'failed' }],
  permissionMode: 'default', additional_directories: [], plugins: [{ name: 'builtin-x', path: 'builtin' }], ...(script.init ?? {}) });

// --- steps ---------------------------------------------------------------------------------
const denials = [];
let messageNo = 0, toolNo = 0;
async function runTool(step) {
  const id = `toolu_${++toolNo}`;
  out({ type: 'assistant', message: { id: `msg_${++messageNo}`, role: 'assistant', content: [{ type: 'tool_use', id, name: step.tool, input: step.input }] } });
  const decision = step.ask === false ? { behavior: 'allow', updatedInput: step.input } : await ask(step.tool, step.input, id);
  if (process.env.FAKE_DECISIONS) appendFileSync(process.env.FAKE_DECISIONS, JSON.stringify({ tool: step.tool, decision }) + '\n');
  if (decision.behavior === 'allow') {
    const used = decision.updatedInput ?? step.input;
    if (step.tool === 'Write') writeFileSync(used.file_path, used.content);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  } else {
    denials.push({ tool_name: step.tool, tool_use_id: id });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: decision.message }] } });
  }
}
for (const step of script.steps ?? []) {
  if (step.text !== undefined) {
    const id = `msg_${++messageNo}`;
    out({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } } });
    out({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: step.text }] } });
  } else if (step.tool) await runTool(step);
  else if (step.parallel) await Promise.all(step.parallel.map(runTool));
  else if (step.sleep) await sleep(step.sleep);
  else if (step.spawnChild) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(step.spawnChild, String(child.pid));
  } else if (step.hang) await new Promise(() => {});
  else if (step.raw) out(step.raw);
  else if (step.exit !== undefined) process.exit(step.exit);
}
out({ type: 'result', subtype: 'success', is_error: false, result: script.result ?? '完成了。', permission_denials: denials });
mcp.kill();
process.exit(0);
