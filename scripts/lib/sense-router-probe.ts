// I-040 看一眼、听一下: one real pass of the part after her reply, on synthetic material only (no camera, no screen, no private data):
// haiku reads a made-up transcript and writes its facts, then the chat model (Claude Code's default, as for her chat) says her short
// line as Gene. Two real requests. Prints the facts, her line and the times. Run it through the heavy gate:
//   node scripts/dev/heavy.mjs --label sense-router-probe -- node node_modules/tsx/dist/cli.mjs scripts/lib/sense-router-probe.ts
import { senseAskWithClaude, senseLineWithClaude } from '../../electron/sense-router/model';
import { genePersona } from './prompt-eval-runner';
import { SENSE_SUMMARY_SYSTEM_PROMPT, parseSenseLine, parseSenseSummary, senseLinePrompt, senseSummaryPrompt } from '../../shared/sense-router';

const HEARD = '欢迎回到今天的节目。今天我们请到的嘉宾是一位研究彗星的天文学家，她说明年春天会有一颗肉眼可见的彗星经过，最佳观测时间是凌晨四点左右，往东北方向看。';
const USER = '刚才视频里说的那个彗星什么时候能看到';
const REPLY = '诶，你也在看那个呀～我刚才也有听到一点点。';

async function main(): Promise<void> {
  const signal = new AbortController().signal;
  let t = performance.now();
  const raw = await senseAskWithClaude(senseSummaryPrompt('transcript', USER, HEARD), SENSE_SUMMARY_SYSTEM_PROMPT, [], signal);
  const facts = parseSenseSummary(raw);
  const summaryMs = Math.round(performance.now() - t);
  console.log(`haiku 事实（${summaryMs} ms）：${facts ?? `（读不出）${raw.slice(0, 200)}`}`);
  if (!facts) return;
  const { persona } = genePersona();
  t = performance.now();
  const rawLine = await senseLineWithClaude(senseLinePrompt({ persona, userText: USER, reply: REPLY, notes: [{ sense: 'transcript', kind: 'seen', facts }] }), '', signal);
  const line = parseSenseLine(rawLine);
  console.log(`她的第二句（${Math.round(performance.now() - t)} ms）：${line ?? `（读不出）${rawLine.slice(0, 200)}`}`);
}
main().catch(error => { console.error(error); process.exit(1); });
