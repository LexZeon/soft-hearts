import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_SYSTEM_PROMPT, ClaudeStreamReader, claudeArguments, claudeUsage, streamClaude } from '../electron/claude';
import { INNER_LOOP_SYSTEM_PROMPT } from '../shared/inner-loop';

// The exact arguments before the optional system prompt existed (ef71489). Any drift is a behavior change.
const PINNED = (systemPrompt: string, model?: string) => [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--tools', '', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence',
  '--setting-sources', '', '--system-prompt', systemPrompt, ...(model ? ['--model', model] : []),
];

test('without a custom system prompt the Claude Code arguments are byte-for-byte unchanged', () => {
  assert.deepEqual(claudeArguments({ model: 'haiku' }), PINNED(CLAUDE_SYSTEM_PROMPT, 'haiku'));
  assert.deepEqual(claudeArguments({ model: '' }), PINNED(CLAUDE_SYSTEM_PROMPT));
  assert.deepEqual(claudeArguments({ model: 'sonnet' }, 'persistent prompt'), PINNED('persistent prompt', 'sonnet'));
  assert.deepEqual(claudeArguments({ model: 'haiku', systemPrompt: undefined }), PINNED(CLAUDE_SYSTEM_PROMPT, 'haiku'));
});

test('a custom system prompt replaces only the system prompt value; every isolation flag stays', () => {
  const args = claudeArguments({ model: 'haiku', systemPrompt: INNER_LOOP_SYSTEM_PROMPT });
  assert.deepEqual(args, PINNED(INNER_LOOP_SYSTEM_PROMPT, 'haiku'));
  for (const bad of ['', '   ', 'x'.repeat(20_001), 'a\0b']) assert.throws(() => claudeArguments({ model: 'haiku', systemPrompt: bad }));
});

test('usage and cost come only as numbers from the final result event', () => {
  const reader = new ClaudeStreamReader(() => {});
  reader.consumeEvent({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
  reader.consumeEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"action":"none"}' } } });
  reader.consumeEvent({ type: 'result', subtype: 'success', is_error: false, result: 'ignored text', total_cost_usd: 0.00081,
    usage: { input_tokens: 9, output_tokens: 12, cache_read_input_tokens: 3100, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 0 } } });
  assert.deepEqual(reader.usage, { inputTokens: 9, outputTokens: 12, cacheReadInputTokens: 3100, cacheCreationInputTokens: 0, costUsd: 0.00081 });
  assert.equal(claudeUsage({ type: 'result' }), null);
  assert.deepEqual(claudeUsage({ usage: { input_tokens: -1, output_tokens: 'many' }, total_cost_usd: 0.1 }),
    { inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null, costUsd: 0.1 });
});

async function fakeClaude(): Promise<{ script: string; record: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-claude-system-'));
  const record = path.join(root, 'record.json'), script = path.join(root, 'fake-claude.cjs');
  const lines = [
    { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"action":"look"}' } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'x', total_cost_usd: 0.0006, usage: { input_tokens: 4, output_tokens: 8 } },
  ].map(line => JSON.stringify(line));
  await writeFile(script, `
const fs = require("node:fs");
let input = "";
process.stdin.on("data", c => input += c);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2) }));
  for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + "\\n");
});`);
  return { script, record, root };
}

test('streamClaude sends the same arguments as before unless a system prompt is passed, and returns usage', async () => {
  for (const systemPrompt of [undefined, INNER_LOOP_SYSTEM_PROMPT]) {
    const fake = await fakeClaude();
    try {
      let text = '';
      const usage = await streamClaude({ kind: 'chat', model: 'haiku', workingDirectory: fake.root, writable: false, prompt: '决定',
        ...(systemPrompt ? { systemPrompt } : {}) }, new AbortController().signal, (type, value) => { if (type === 'delta') text += value; },
        process.execPath, [fake.script]);
      const record = JSON.parse(await readFile(fake.record, 'utf8'));
      assert.deepEqual(record.args, PINNED(systemPrompt ?? CLAUDE_SYSTEM_PROMPT, 'haiku'));
      assert.equal(text, '{"action":"look"}');
      assert.deepEqual(usage, { inputTokens: 4, outputTokens: 8, cacheReadInputTokens: null, cacheCreationInputTokens: null, costUsd: 0.0006 });
    } finally { await rm(fake.root, { recursive: true, force: true }); }
  }
});
