// A fake `claude -p --input-format stream-json` for the speech-beats measurement script (scripts/dev/speech-beats-measure.ts --fake) and its
// tests: like tests/helpers/fake-claude-stream.ts (same event shapes) but its replies carry the markers of 边说边演 when this turn's persona
// has the sentence about them (the words "动作标记"), written in 3-character pieces so every marker is split across stream events.
//   tease      -> performance only: ⟦shy⟧⟦hand-cheek⟧ (no words)
//   compliment -> ⟦shy⟧哎呀，别夸啦。
//   sad        -> ⟦look-down⟧我在呢，慢慢说。  (a bad marker ⟦frown⟧ in front, and a half-written ⟦sm at the very end of the first one)
//   anything else -> ⟦smile-warm⟧好呀。⟦tilt⟧后来呢？
// With the sentence absent (switch off) the reply has no markers. The opening marker, the state tail and a `result` with usage numbers follow
// the real protocol. It prints every user message it gets to a file (`inputs`), so a test sees what was sent.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const source = String.raw`
const fs = require("node:fs"), path = require("node:path");
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
let buffer = "", turns = 0, busy = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
function handle(message) {
  if (message.type === "control_request") { out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { still_queued: [] } } }); return; }
  if (message.type !== "user") return;
  const prompt = message.message.content.map(block => block.text || "").join("");
  const start = prompt.lastIndexOf("<conversation-data>\n"), end = prompt.lastIndexOf("\n</conversation-data>");
  let text = prompt;
  if (start >= 0 && end > start) { try { text = JSON.parse(prompt.slice(start + 20, end)).currentUser; } catch {} }
  const nonce = [...prompt.matchAll(/<sh-state-([a-f0-9]+)>/g)].map(match => match[1]).at(-1) || "";
  fs.appendFileSync(path.join(__dirname, "input.log"), JSON.stringify({ pid: process.pid, user: text, beats: prompt.includes("动作标记"), prompt }) + "\n");
  busy = busy.then(() => reply(prompt, text, nonce));
}
function body(prompt, text) {
  if (!prompt.includes("动作标记")) return "好呀，" + text.slice(0, 8) + "。";
  if (/想我/.test(text)) return "⟦shy⟧⟦hand-cheek⟧";
  if (/可爱|安心/.test(text)) return "⟦shy⟧哎呀，别夸啦。";
  if (/难受|怀疑|奶奶/.test(text)) return "⟦frown⟧⟦look-down⟧我在呢，慢慢说。⟦sm";
  return "⟦smile-warm⟧好呀。⟦tilt⟧后来呢？";
}
async function reply(prompt, text, nonce) {
  turns++;
  out({ type: "system", subtype: "init", tools: [], mcp_servers: [], model: "fake-model" });
  const full = "<sh-open>" + body(prompt, text) + (nonce ? "\n<sh-state-" + nonce + ">{\"context\":\"support\",\"delta\":{\"O\":1},\"reason\":\"合成\",\"confidence\":0.9}</sh-state-" + nonce + ">" : "");
  for (let at = 0; at < full.length; at += 3) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: full.slice(at, at + 3) } } });
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  out({ type: "assistant", message: { id: "m" + turns, role: "assistant", content: [{ type: "text", text: full }] } });
  out({ type: "result", subtype: "success", is_error: false, result: full, total_cost_usd: 0, usage: { input_tokens: 50, output_tokens: Math.ceil(full.length / 2), cache_read_input_tokens: 400, cache_creation_input_tokens: 0 } });
}
`;

export async function fakeClaudeBeats() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-beats-claude-'));
  const script = path.join(root, 'fake-claude-beats.cjs');
  await writeFile(script, source);
  return {
    root, script,
    async inputs(): Promise<{ pid: number; user: string; beats: boolean; prompt: string }[]> {
      try { return (await readFile(path.join(root, 'input.log'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
    },
    cleanup: async () => {
      if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('soft-beats-claude-')) throw Error('unexpected fake root');
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}
