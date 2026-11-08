import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ClaudeStreamReader,
  claudeArguments,
  claudeEnvironment,
  claudeFailure,
  claudeInput,
  streamClaude,
} from "../electron/claude";
import { discoverClaude } from "../scripts/claude-discovery.mjs";

const green =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQ0lEQVR4AcXBAQEAAAiDMKR/5xuD7RgjJDGJSUxiEpOYxCQmMYlJTGISk5jEJCYxiUlMYhKTmMQkJjGJSUxiEpOYxB4v5AI+g+yDOgAAAABJRU5ErkJggg==";
const image = `data:image/png;base64,${green}`;
const init = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [], ...extra });
const delta = (text: string) =>
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const assistant = (text: string, id = "msg_1") =>
  JSON.stringify({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } });
const success = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ignored" });

function collect() {
  const events: Array<[string, string]> = [];
  return { events, emit: (type: string, text: string) => { events.push([type, text]); } };
}

test("chat arguments turn off every tool, MCP server, slash command, setting source and saved session", () => {
  const args = claudeArguments({ model: "" });
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes("-p"));
  assert.equal(value("--tools"), "");
  assert.equal(value("--setting-sources"), "");
  assert.equal(value("--input-format"), "stream-json");
  assert.equal(value("--output-format"), "stream-json");
  for (const flag of ["--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence", "--include-partial-messages", "--verbose"])
    assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes("--model"), "empty model follows the CLI default");
  assert.ok(!args.some(arg => /dangerously|bypass|--allowed-?tools|--add-dir|--mcp-config/i.test(arg)));
  assert.deepEqual(claudeArguments({ model: "  sonnet " }).slice(-2), ["--model", "sonnet"]);
  assert.deepEqual(claudeArguments({ model: "fable" }).slice(-2), ["--model", "fable"]);
  // A chat model inherited from the Codex edition stays in the saved settings (memory scope) but
  // never reaches Claude Code, which would reject it; the CLI default answers instead.
  for (const stale of ["gpt-5", "gpt-5-codex", "o4-mini", "qwen3:8b", "sonnet --dangerously-skip-permissions"])
    assert.ok(!claudeArguments({ model: stale }).includes("--model"), stale);
});

test("child environment drops parent Claude Code session wiring but keeps the user's own auth choices", () => {
  const env = claudeEnvironment({
    PATH: "/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "parent",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SSE_PORT: "1234",
    claude_code_messaging_socket: "x",
    CLAUDE_CONFIG_DIR: "/cfg",
    CLAUDE_CODE_OAUTH_TOKEN: "user-own-token",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_API_KEY: "user-key",
    ELECTRON_RUN_AS_NODE: "1",
  });
  assert.equal(env.PATH, "/bin");
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "claude_code_messaging_socket", "ELECTRON_RUN_AS_NODE"])
    assert.equal(env[key], undefined, key);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/cfg");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "user-own-token");
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(env.ANTHROPIC_API_KEY, "user-key");
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
});

test("stdin carries one stream-json user message with verified base64 images", () => {
  const line = claudeInput({ prompt: "看看这张图", imageDataUrls: [image] });
  assert.ok(line.endsWith("\n"));
  const message = JSON.parse(line);
  assert.equal(message.type, "user");
  assert.deepEqual(message.message.content[0], { type: "text", text: "看看这张图" });
  assert.deepEqual(message.message.content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: green } });
  assert.throws(() => claudeInput({ prompt: "x", imageDataUrls: ["data:image/png;base64,AAAA"] }), /图片数据不正确/);
  assert.throws(() => claudeInput({ prompt: "x", imageDataUrls: ["data:image/gif;base64,R0lG"] }), /PNG、JPEG 或 WebP/);
  assert.throws(() => claudeInput({ prompt: "x", imageDataUrls: [image, image, image] }), /最多/);
  assert.throws(() => claudeInput({ prompt: "" }), /为空/);
});

test("stream reader shows live deltas once and ignores the repeated complete message", () => {
  const { events, emit } = collect();
  const reader = new ClaudeStreamReader(emit);
  for (const line of [init(), delta("你"), delta("好"), assistant("你好"), success])
    assert.equal(reader.consume(line), "ok");
  assert.deepEqual(events, [["delta", "你"], ["delta", "好"]]);
  assert.equal(reader.output, "你好");
});

test("stream reader falls back to the complete message when no deltas arrive", () => {
  const { events, emit } = collect();
  const reader = new ClaudeStreamReader(emit);
  for (const line of [init(), assistant("整段回复"), success]) reader.consume(line);
  assert.deepEqual(events, [["delta", "整段回复"]]);
});

test("stream reader stops before any text when Claude Code reports tools or MCP servers", () => {
  for (const extra of [{ tools: ["Bash"] }, { mcp_servers: [{ name: "x", status: "connected" }] }, { tools: undefined }]) {
    const { events, emit } = collect();
    const reader = new ClaudeStreamReader(emit);
    assert.equal(reader.consume(init(extra)), "stop");
    assert.match(reader.failure, /关闭全部工具/);
    assert.deepEqual(events, []);
  }
  const { events, emit } = collect();
  const reader = new ClaudeStreamReader(emit);
  assert.equal(reader.consume(delta("没有 init 就不显示")), "stop");
  assert.deepEqual(events, []);
});

test("stream reader keeps the first safety-stop reason when the process writes on while it is being killed", () => {
  // Under load Windows taskkill can take seconds; the process keeps writing meanwhile (the full suite saw
  // "未报告隔离状态" replace "没能关闭全部工具" in the test below). The first reason is the real one.
  const { events, emit } = collect();
  const reader = new ClaudeStreamReader(emit);
  assert.equal(reader.consume(init({ tools: ["Bash"] })), "stop");
  const start = JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Bash" } } });
  for (const line of [delta("不该出现"), start, success]) reader.consume(line);
  assert.match(reader.failure, /关闭全部工具/);
  assert.equal(reader.unsafe, true);
  assert.deepEqual(events, []);
});

test("stream reader stops on any tool use block", () => {
  const start = JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Bash" } } });
  const reader = new ClaudeStreamReader(() => {});
  reader.consume(init());
  assert.equal(reader.consume(start), "stop");
  assert.match(reader.failure, /意外请求了工具/);
  const second = new ClaudeStreamReader(() => {});
  second.consume(init());
  const toolMessage = JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", name: "Read" }] } });
  assert.equal(second.consume(toolMessage), "stop");
});

test("failed results become short friendly messages", () => {
  const reader = new ClaudeStreamReader(() => {});
  reader.consume(init());
  assert.equal(reader.consume(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" })), "stop");
  assert.match(reader.failure, /未登录/);
  assert.match(claudeFailure("Claude usage limit reached|1793600000"), /额度/);
  assert.match(claudeFailure("error: unknown option '--safe-mode'"), /claude update/);
  assert.equal(claudeFailure(""), "Claude Code 未能完成回复。");
});

test("discovery prefers an override, then PATH, then official install locations, without running anything", async () => {
  const files = new Set([
    path.win32.join("C:\\Users\\a", ".local", "bin", "claude.exe"),
    path.win32.join("C:\\tools", "claude.exe"),
  ]);
  const io = {
    stat: async (file: string) => {
      if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => true };
    },
    access: async (file: string) => { if (!files.has(file)) throw new Error("missing"); },
  };
  const env = { PATH: "C:\\none;C:\\tools", USERPROFILE: "C:\\Users\\a" };
  assert.deepEqual(await discoverClaude({ platform: "win32", env, io }), { status: "found", path: "C:\\tools\\claude.exe" });
  assert.deepEqual(await discoverClaude({ platform: "win32", env: { ...env, PATH: "" }, io }),
    { status: "found", path: "C:\\Users\\a\\.local\\bin\\claude.exe" });
  assert.deepEqual(await discoverClaude({ platform: "win32", env: { ...env, CLAUDE_PATH: "C:\\missing.exe" }, io }),
    { status: "invalid-override", path: null });
  assert.deepEqual(await discoverClaude({ platform: "win32", env: { PATH: "", USERPROFILE: "C:\\Users\\b" }, io }),
    { status: "missing", path: null });
});


/** Runs as `node fake-claude.cjs <claude args>` through streamClaude's leading-args seam, so it also runs on Windows. */
async function fakeClaude(body: string): Promise<{ script: string; record: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "soft-claude-fake-"));
  const record = path.join(root, "record.json");
  const script = path.join(root, "fake-claude.cjs");
  await writeFile(script, `
const fs = require("node:fs");
let input = "";
process.stdin.on("data", c => input += c);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input,
    cwdEntries: fs.readdirSync(process.cwd()), env: Object.keys(process.env).filter(k => /^CLAUDE/i.test(k)) }));
  ${body}
});
`);
  return { script, record, root };
}

test("a chat turn runs one isolated process in an empty folder and streams its text", async () => {
  const fake = await fakeClaude(`
    const out = l => process.stdout.write(l + "\\n");
    out(${JSON.stringify(init())}); out(${JSON.stringify(delta("嗨，"))}); out(${JSON.stringify(delta("我在。"))});
    out(${JSON.stringify(assistant("嗨，我在。"))}); out(${JSON.stringify(success)});`);
  const previous = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = "parent-session";
  try {
    const { events, emit } = collect();
    await streamClaude({ kind: "chat", model: "haiku", workingDirectory: fake.root, writable: false, prompt: "你好", imageDataUrls: [image] },
      new AbortController().signal, emit, process.execPath, [fake.script]);
    assert.deepEqual(events, [["delta", "嗨，"], ["delta", "我在。"]]);
    const record = JSON.parse(await readFile(fake.record, "utf8"));
    assert.deepEqual(record.cwdEntries, []);
    assert.notEqual(path.resolve(record.cwd), path.resolve(fake.root));
    assert.ok(!record.env.includes("CLAUDE_CODE_SESSION_ID"));
    assert.equal(record.args[record.args.indexOf("--model") + 1], "haiku");
    const message = JSON.parse(record.input);
    assert.equal(message.message.content[0].text, "你好");
    assert.equal(message.message.content[1].type, "image");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = previous;
    await rm(fake.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("a chat turn that reports tools is stopped and shows nothing", async () => {
  const fake = await fakeClaude(`
    const out = l => process.stdout.write(l + "\\n");
    out(${JSON.stringify(init({ tools: ["Bash"] }))});
    setTimeout(() => { out(${JSON.stringify(delta("不该出现"))}); out(${JSON.stringify(success)}); }, 3000);`);
  try {
    const { events, emit } = collect();
    await assert.rejects(streamClaude({ kind: "chat", model: "", workingDirectory: fake.root, writable: false, prompt: "你好" },
      new AbortController().signal, emit, process.execPath, [fake.script]), /关闭全部工具/);
    assert.deepEqual(events, []);
  } finally { await rm(fake.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test("a login failure from the CLI reaches the user as a short message", async () => {
  const fake = await fakeClaude(`
    process.stdout.write(${JSON.stringify(init())} + "\\n");
    process.stdout.write(${JSON.stringify(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }))} + "\\n");
    process.exitCode = 1;`);
  try {
    await assert.rejects(streamClaude({ kind: "chat", model: "", workingDirectory: fake.root, writable: false, prompt: "你好" },
      new AbortController().signal, () => {}, process.execPath, [fake.script]), /未登录/);
  } finally { await rm(fake.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test("stopping a turn ends the process without further text", async () => {
  const fake = await fakeClaude(`
    process.stdout.write(${JSON.stringify(init())} + "\\n");
    process.stdout.write(${JSON.stringify(delta("第一句"))} + "\\n");
    setInterval(() => process.stdout.write(${JSON.stringify(delta("还在"))} + "\\n"), 50);`);
  try {
    const controller = new AbortController();
    const { events, emit } = collect();
    const turn = streamClaude({ kind: "chat", model: "", workingDirectory: fake.root, writable: false, prompt: "你好" },
      controller.signal, (type, text) => { emit(type, text); if (text === "第一句") controller.abort(); }, process.execPath, [fake.script]);
    await assert.rejects(turn);
    // Nothing after the stop, even while Windows taskkill is still ending the process.
    assert.deepEqual(events, [["delta", "第一句"]]);
  } finally { await rm(fake.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

// Opt-in: talks to the real, signed-in Claude Code on this machine (uses your own quota).
test("live: the real Claude Code answers with no tools", { skip: process.env.SOFT_HEARTS_CLAUDE_LIVE === "1" ? false : "set SOFT_HEARTS_CLAUDE_LIVE=1" }, async () => {
  const { events, emit } = collect();
  await streamClaude({ kind: "chat", model: "haiku", workingDirectory: os.tmpdir(), writable: false, prompt: "只回复两个字：你好", imageDataUrls: [image] },
    new AbortController().signal, emit);
  assert.ok(events.length > 0);
  assert.ok(events.map(([, text]) => text).join("").trim().length > 0);
});
