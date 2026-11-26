// Test double for `claude -p` in the Claude 助手 tests (never shipped, never run by the app). It behaves like Claude Code as far
// as the assistant needs: reads the --mcp-config file, starts that MCP server exactly as written (the real assistant shim),
// speaks JSON-RPC to it, prints stream-json events, and follows a scripted scenario from ASSISTANT_DOUBLE_SCENARIO:
//   { init?: {...}, steps: [ {text}, {call: {tool, args}}, {sleep}, {foreignTool: 'Bash'}, {thinking: true}, {fail: 'msg'} ] }
// Every tool result is appended (one JSON line) to ASSISTANT_DOUBLE_LOG, with the argv and the stdin prompt first.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const log = value => { if (process.env.ASSISTANT_DOUBLE_LOG) appendFileSync(process.env.ASSISTANT_DOUBLE_LOG, JSON.stringify(value) + '\n'); };
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const scenario = JSON.parse(process.env.ASSISTANT_DOUBLE_SCENARIO || '{"steps":[{"text":"好的。"}]}');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
await new Promise(resolve => process.stdin.on('end', resolve));
const prompt = JSON.parse(input.split('\n')[0]).message.content[0].text;
log({ argv, prompt });

const config = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8'));
const [serverName, server] = Object.entries(config.mcpServers)[0];
const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '', nextId = 1;
const waiting = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    waiting.get(message.id)?.(message); waiting.delete(message.id);
  }
});
const rpc = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'double', version: '0' } });
const listed = await rpc('tools/list', {});
const tools = listed.result.tools;
log({ tools });
out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: tools.map(tool => `mcp__${serverName}__${tool.name}`),
  mcp_servers: [{ name: serverName, status: 'connected' }], permissionMode: 'default', plugins: [{ name: 'x', path: 'builtin' }], ...(scenario.init ?? {}) });

let message = 0;
const begin = () => { message++; out({ type: 'stream_event', event: { type: 'message_start', message: { id: `msg_${message}` } } }); };
for (const step of scenario.steps) {
  if (step.sleep) { await sleep(step.sleep); continue; }
  if (step.fail) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: step.fail }); child.kill(); process.exit(1); }
  if (step.thinking) { begin(); out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } }); continue; }
  if (step.text !== undefined) {
    begin();
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    for (const piece of step.text.match(/[\s\S]{1,3}/g) ?? []) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
      if (step.slow) await sleep(step.slow);
    }
    out({ type: 'assistant', message: { id: `msg_${message}`, content: [{ type: 'text', text: step.text }] } });
    continue;
  }
  if (step.foreignTool) {
    begin();
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `f${message}`, name: step.foreignTool, input: {} } } });
    // As Claude Code does for a tool it does not have: the whole message, then its own error result, and the turn goes on.
    out({ type: 'assistant', message: { id: `msg_${message}`, content: [{ type: 'tool_use', id: `f${message}`, name: step.foreignTool, input: { secret: 'never recorded' } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `f${message}`, content: `<tool_use_error>Error: No such tool available: ${step.foreignTool}</tool_use_error>`, is_error: true }] } });
    log({ foreign: step.foreignTool });
    continue;
  }
  if (step.call) {
    begin();
    const name = `mcp__${serverName}__${step.call.tool}`;
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `t${message}`, name, input: {} } } });
    out({ type: 'assistant', message: { id: `msg_${message}`, content: [{ type: 'tool_use', id: `t${message}`, name, input: step.call.args ?? {} }] } });
    const result = await rpc('tools/call', { name: step.call.tool, arguments: step.call.args ?? {} });
    log({ call: step.call.tool, result: result.result ?? result.error });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${message}`, content: result.result?.content ?? [], is_error: !!result.result?.isError }] } });
  }
}
out({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
child.stdin.end();
child.kill();
process.exit(0);
