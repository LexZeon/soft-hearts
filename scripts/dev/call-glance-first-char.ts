// I-161 A (docs/claude/2026-11-19-call-glance-a.md): how soon her first character comes in a call, per sentence, with a small 320×240 frame on
// every sentence — the warm process kept (A) or retired after each picture (before A) — and without frames. The app's own PersistentClaudeChat,
// ClaudeChatProcess and session prompt; a synthetic persona and window (a public original character, no user data); synthetic PNG frames
// (no camera, no screen). No app profile is opened; Claude Code runs with the app's flags (no tools, no settings, no session file).
//
//   node node_modules/tsx/dist/cli.mjs scripts/dev/call-glance-first-char.ts --fake            the fake Claude (tests/helpers/fake-claude-stream.ts): local cost only
//   node node_modules/tsx/dist/cli.mjs scripts/dev/call-glance-first-char.ts --real            the user's Claude Code: uses their Claude quota, ask first
//     --per-group N (default 9)  --max-requests N (default 30; the run stops before going over)  --gap-ms N (pause between sentences, default 2500)
//     --model NAME (default: Claude Code's own)  --out FILE (numbers as JSON)
// Prints numbers only. Each group's first sentence opens a new process (counted in the requests, left out of the statistics).
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import type { ChatMessage } from '../../shared/foundation/chat';
import { GLANCE_LINE } from '../../shared/brain/perception-rule';
import { callPastGlancesNote } from '../../shared/brain/call-frame-note';
import { findClaude } from '../../electron/brain/claude';
import { buildCodexChatPrompt } from '../../electron/brain/conversation-context';
import { PersistentClaudeChat, type ClaudeTimingInfo, type CompanionClaudeTask } from '../../electron/brain/claude-session';
import { fakeClaudeStream } from '../../tests/helpers/fake-claude-stream';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const real = args.includes('--real');
if (!real && !args.includes('--fake')) { console.error('say --fake or --real (--real uses the Claude quota)'); process.exit(2); }
const perGroup = Number(option('--per-group', '9')), maxRequests = Number(option('--max-requests', '30')), gapMs = Number(option('--gap-ms', '2500'));
const model = option('--model', ''), out = option('--out', '');
if (perGroup * 3 > maxRequests) { console.error(`3 groups × ${perGroup} sentences is over --max-requests ${maxRequests}`); process.exit(2); }

/** A 320×240 RGB PNG: a gradient with a moving band and a little noise, different for each `seed`. */
function framePng(seed: number): string {
  const width = 320, height = 240, raw = Buffer.alloc((width * 3 + 1) * height);
  let noise = seed * 2654435761 >>> 0;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      noise = (noise * 1664525 + 1013904223) >>> 0;
      const band = Math.abs(((x + seed * 37) % 160) - 80) < 12 ? 90 : 0;
      raw[row + 1 + x * 3] = (x * 255 / width + band) & 255;
      raw[row + 2 + x * 3] = (y * 255 / height + (noise & 15)) & 255;
      raw[row + 3 + x * 3] = (seed * 41 + band) & 255;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

// A public original character and a synthetic 24-message window of about 11 000 characters (the stable app's measured opening size).
const BASE = '你是小桃，一个住在用户电脑里的原创桌宠角色。你说话温柔、有点害羞，喜欢用短句，偶尔撒娇。你关心用户的作息和心情，记得你们聊过的小事。'
  + '你不会假装能做做不到的事；不知道的就照实说。和用户打电话的时候，你说话更口语，一次只说一两句。'.repeat(3);
const TOPICS = ['下班路上的晚霞', '新买的耳机', '周末想去的书店', '昨晚没睡好', '楼下新开的面馆', '工作上的一个小麻烦', '想学的吉他', '天气突然变冷', '朋友的生日礼物', '一部老电影', '早上的咖啡', '阳台上的绿萝'];
function windowMessages(): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 24; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const text = i % 2 === 0
      ? `我跟你说说${topic}吧。` + `今天想起${topic}，就觉得有点想和你聊聊，虽然也说不出什么特别的，就是想说给你听。`.repeat(5)
      : `嗯嗯，${topic}呀。` + `我在听呢，你说的${topic}我记住了，下次你再提起来，我就知道是哪件事啦。`.repeat(5);
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: text });
  }
  return messages;
}
const SENTENCES = ['喂，听得到吗', '我刚到家', '今天好累啊', '你在干嘛呀', '我在吃晚饭', '你猜我买了什么', '是一盆小多肉', '明天还要早起', '那我先去洗澡啦'];

type Group = 'none' | 'kept' | 'retired';
interface Row { group: Group; sentence: number; firstMs: number | null; reuse: string | undefined; process: string | undefined; image: boolean }

let requests = 0;
async function runGroup(group: Group, binary: string, binaryArgs: readonly string[] | undefined): Promise<Row[]> {
  const infos = new Map<string, { info: ClaudeTimingInfo; at: number; first: number | null }>();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => binary, ...(binaryArgs ? { binaryArgs } : {}), provider: () => ({ kind: 'claude', model }),
    chattedBefore: () => true, log: () => {}, callMaxTurns: 50, callGlances: { stays: group === 'kept', cap: 40 },
    timing: { dispatched: (id, info) => { infos.set(id, { info, at: performance.now(), first: null }); }, firstDelta: id => { const row = infos.get(id); if (row && row.first === null) row.first = performance.now() - row.at; } } });
  const rows: Row[] = [];
  const window = windowMessages();
  try {
    chat.holdWarm(true);
    await new Promise(resolve => setTimeout(resolve, real ? 4000 : 300)); // the call's spare process starts
    for (let i = 0; i < perGroup; i++) {
      if (requests + 1 > maxRequests) throw new Error('request budget reached');
      requests++;
      const withFrame = group !== 'none';
      const frame = withFrame ? [framePng(i + 1 + (group === 'retired' ? 100 : 0))] : [];
      window.push({ role: 'user', content: SENTENCES[i % SENTENCES.length] });
      const messages = window.slice(-24);
      const head = `${BASE}\n\n当前心情：平静。`;
      const persona = head + (withFrame ? '\n【此刻的感知】' + GLANCE_LINE : ''); // the segment's line for a small frame (shared/brain/call-frame-note.ts)
      const id = `${group}-${i}`;
      const task: CompanionClaudeTask = { kind: 'chat', model, workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(persona, messages); },
        imageDataUrls: frame, replyId: id, session: { key: 'measure-' + group, basePersona: BASE, persona, messages, data: () => null },
        ...(withFrame ? { callGlance: { glanceOnly: () => true, still: () => () => true, past: (now: boolean) => callPastGlancesNote(now, 'zh-CN') } } : {}) };
      const { output } = await chat.stream(task, new AbortController().signal, () => {});
      window.push({ role: 'assistant', content: output.replace(/<sh-state-[\s\S]*$/, '').trim() || '嗯。' });
      const row = infos.get(id);
      rows.push({ group, sentence: i + 1, firstMs: row?.first === null || row?.first === undefined ? null : Math.round(row.first), reuse: row?.info.reuse, process: row?.info.process, image: withFrame });
      console.log(JSON.stringify(rows.at(-1)));
      await new Promise(resolve => setTimeout(resolve, gapMs)); // the user speaks; a retired process's spare starts meanwhile
    }
  } finally { chat.dispose(); }
  return rows;
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  return { n: sorted.length, median: at(0.5), p25: at(0.25), p75: at(0.75), min: sorted[0], max: sorted.at(-1) };
}

const fake = real ? null : await fakeClaudeStream();
try {
  const binary = real ? await findClaude() : process.execPath;
  const binaryArgs = fake ? [fake.script] : undefined;
  const all: Row[] = [];
  for (const group of ['none', 'kept', 'retired'] as Group[]) all.push(...await runGroup(group, binary, binaryArgs));
  const summary = Object.fromEntries((['none', 'kept', 'retired'] as Group[]).map(group => [group,
    stats(all.filter(row => row.group === group && row.sentence > 1 && row.firstMs !== null).map(row => row.firstMs!))]));
  console.log(JSON.stringify({ mode: real ? 'real' : 'fake', model: model || 'default', requests, perGroup, gapMs, summary }));
  if (out) writeFileSync(out, JSON.stringify({ mode: real ? 'real' : 'fake', model: model || 'default', requests, rows: all, summary }, null, 1));
} finally { await fake?.cleanup(); }
