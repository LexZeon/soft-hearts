// Codex T-205 第四轮（X-258，2026-11-04，固定 9f58785）：每条消息一个进程的备用路（electron/claude.ts streamClaude，只在常驻进程
// 不可用时用）在调用当下就把提示词和图冻结成要写进 stdin 的那一行，之后还要建临时目录、启动进程。这中间关掉共享并中止这轮聊天，
// 调用方收到"已停止"，模拟进程的 stdin 却仍收到了旧图一张。修法：真正启动进程、写 stdin 之前再核一次中止，并且现读提示词和图
// （electron/main.ts 的 prompt / imageDataUrls 是按这一轮的帧现算的 getter）。docs/claude/2026-11-04-v1-refusal-grab.md 末节。
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { streamClaude, type ClaudeTask } from '../electron/claude';

const green = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQ0lEQVR4AcXBAQEAAAiDMKR/5xuD7RgjJDGJSUxiEpOYxCQmMYlJTGISk5jEJCYxiUlMYhKTmMQkJjGJSUxiEpOYxB4v5AI+g+yDOgAAAABJRU5ErkJggg==';
const image = `data:image/png;base64,${green}`;

/** A fake `claude` (run as `node fake.cjs <args>`): records what reached its stdin, then answers like Claude Code. */
async function fakeClaude(): Promise<{ script: string; record: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-claude-frames-'));
  const record = path.join(root, 'stdin.json'), script = path.join(root, 'fake-claude.cjs');
  const lines = [
    { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '嗯。' } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'x' },
  ].map(line => JSON.stringify(line));
  await writeFile(script, `
const fs = require("node:fs");
let input = "";
process.stdin.on("data", c => input += c);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, input);
  for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + "\\n");
});`);
  return { script, record, root };
}

function blocks(stdin: string): { type: string; text?: string }[] {
  return JSON.parse(stdin.trim()).message.content;
}

test('备用路：调用之后、进程启动之前关共享并中止这轮聊天，调用方收到停止，进程不启动，什么都没写出去', async () => {
  const fake = await fakeClaude();
  try {
    const controller = new AbortController();
    let reads = 0;
    const task: ClaudeTask = { kind: 'chat', model: '', workingDirectory: fake.root, writable: false, prompt: '【此刻的感知】用户叫你看屏幕，本轮附了画面。',
      // The first read is the call's own (validation); the user turns sharing off right after, while the adapter prepares the process.
      get imageDataUrls() { if (++reads === 1) queueMicrotask(() => controller.abort()); return controller.signal.aborted ? [] : [image]; } };
    await assert.rejects(streamClaude(task, controller.signal, () => {}, process.execPath, [fake.script]));
    await assert.rejects(access(fake.record), '没有进程收到这条消息');
  } finally { await rm(fake.root, { recursive: true, force: true }); }
});

test('备用路：进程启动之前这一帧被丢掉（没有中止，例如清掉了视觉上下文）：写进 stdin 的没有图，感知行按剩下的帧写', async () => {
  const fake = await fakeClaude();
  try {
    let sharing = true;
    const task: ClaudeTask = { kind: 'chat', model: '', workingDirectory: fake.root, writable: false,
      get prompt() { return sharing ? '【此刻的感知】用户叫你看屏幕，本轮附了画面。' : '【此刻的感知】用户开着屏幕共享，但这一轮你没看画面。'; },
      get imageDataUrls() { if (sharing) queueMicrotask(() => { sharing = false; }); return sharing ? [image] : []; } };
    let text = '';
    await streamClaude(task, new AbortController().signal, (type, value) => { if (type === 'delta') text += value; }, process.execPath, [fake.script]);
    assert.equal(text, '嗯。', '文字照常发出、照常回复');
    const content = blocks(await readFile(fake.record, 'utf8'));
    assert.ok(content.every(block => block.type === 'text'), '没有图片块离开本机');
    assert.match(content[0].text ?? '', /没看画面/);
    assert.doesNotMatch(content[0].text ?? '', /附了画面/);
  } finally { await rm(fake.root, { recursive: true, force: true }); }
});

test('备用路：共享一直开着，图照常写进 stdin（对照）', async () => {
  const fake = await fakeClaude();
  try {
    const task: ClaudeTask = { kind: 'chat', model: '', workingDirectory: fake.root, writable: false, prompt: '你看看我屏幕', imageDataUrls: [image] };
    await streamClaude(task, new AbortController().signal, () => {}, process.execPath, [fake.script]);
    const content = blocks(await readFile(fake.record, 'utf8'));
    assert.deepEqual(content.map(block => block.type), ['text', 'image']);
  } finally { await rm(fake.root, { recursive: true, force: true }); }
});

// electron/main.ts（语法树检查，不 eval）：备用路现读的提示词也按这一轮剩下的帧重写感知行，和常驻进程的 persona 一样。
test('electron/main.ts：交给适配器的 prompt 是现读的 getter，帧被丢掉时用 turnFrames.recompose 重写感知行', () => {
  const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const main = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  let prompt = '';
  const visit = (node: ts.Node): void => {
    if (ts.isGetAccessorDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'prompt'
      && /turnFrames|chatContextData/.test(node.body?.getText(main) ?? '')) prompt = node.body!.getText(main);
    ts.forEachChild(node, visit);
  };
  visit(main);
  assert.match(prompt, /turnFrames\.recompose\(request\.attachments, settings\.persona, sightAgain\)/);
  assert.match(prompt, /buildCodexChatPrompt\(persona, request\.messages,/);
});
