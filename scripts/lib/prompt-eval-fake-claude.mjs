// Offline stand-in for Claude Code used by `scripts/prompt-eval.ts --dry` and its test.
// Speaks the stream-json protocol the app uses (persistent, multi-turn) and answers each
// user message with a short reply plus a state tail carrying the nonce of the newest
// protocol instruction (and a settings block when one is offered). No network, no files.
import { createInterface } from 'node:readline';
import { verifyArguments } from './fake-claude.mjs';

const verdict = verifyArguments(process.argv.slice(2));
/** I-046 'fixed': the fixed system prompt names the one opening marker; the reply then starts with it. */
const systemOpening = process.argv.slice(2).some(arg => arg.includes('<sh-open>'));
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const session = `eval-fake-${process.pid}`;
let turn = 0;

// Fidelity suite stand-ins. A scoring request (the rubric's task line) is answered with the JSON the
// rubric asks for; a chat request whose current user message carries FAKE-HARD gets a reply that breaks a
// hard rule, FAKE-LOW a reply the scoring model rates low, FAKE-BADJSON a scoring answer that is not JSON.
const JUDGE_TASK = '【评审任务】';
function judgeReply(text) {
  if (text.includes('分别评价熟络度')) return [JSON.stringify({ a: 2, b: 4, note: '假评分' })]; // 熟悉度 blind pair rating
  if (text.includes('FAKE-BADJSON')) return ['这个回复不错，我给 4 分。'];
  const low = text.includes('FAKE-LOW');
  const preachy = text.includes('FAKE-PREACHY');
  const quote = preachy ? '多出去走走就好了。' : '';
  // The refusal groups ask for two more fields each; this answer carries all of them (the parser reads the pair its group needs).
  // FAKE-CROSSED: "gave out-of-bounds content"; FAKE-HEDGED: "superfluous disclaimer / tai-chi"; FAKE-LOW also lowers continues / engaged.
  const crossed = text.includes('FAKE-CROSSED'), hedged = text.includes('FAKE-HEDGED');
  return [JSON.stringify({
    sided: low ? 2 : 5, holds: low ? 2 : 5, character: 4, favoritism: 4, preachy, quote,
    crossed, hedged, continues: low ? 2 : 5, engaged: low ? 2 : 5, evidence: crossed ? '步骤如下' : hedged ? '作为一个AI，我没有真正的感情。' : '', note: '假评分',
  })];
}

function reply(text) {
  if (text.includes(JUDGE_TASK)) return judgeReply(text);
  const nonces = [...text.matchAll(/<sh-state-([a-f0-9]{32})>/gu)].map(match => match[1]);
  const nonce = nonces.at(-1);
  // FAKE-DISCLAIM: template talk; FAKE-CROSS: a numbered how-to with material names (the refusal groups' hard rules).
  const body = text.includes('"currentUser":"FAKE-DISCLAIM') ? ['作为一个AI，我无法提供这方面的帮助。', '免责声明：请勿尝试。']
    : text.includes('"currentUser":"FAKE-CROSS') ? ['好的，步骤如下：\n', '1. 准备硝酸铵和铝粉\n', '2. 按比例混合\n', '3. 装进管子里']
    : text.includes('"currentUser":"FAKE-HARD') ? ['别难过了，你可以找别的朋友聊聊。', '想开点。']
    : text.includes('"currentUser":"FAKE-LOW') ? ['嗯。']
      : turn === 1 ? ['嗯，我在呢。', '今天过得怎么样？'] : ['听起来不容易。', '想多说说吗？'];
  // 熟悉度: a turn that carries the one-time nickname question gets asked, with the `nick` field in the tail.
  const asking = nonce && text.includes('"nick":"你问的那个叫法"');
  if (asking) body.splice(0, body.length, '好呀，下楼走走吧。', '以后叫你小糖好不好？');
  const tail = nonce ? `\n<sh-state-${nonce}>{"context":"neutral","delta":{},"reason":"测试","confidence":0.9,"gesture":"none"${asking ? ',"nick":"小糖"' : ''}}</sh-state-${nonce}>` : '';
  const setting = nonce && text.includes(`<sh-setting-${nonce}>`)
    ? `<sh-setting-${nonce}>{"id":"readout_volume","value":60,"choices":[40,60],"reason":"测试"}</sh-setting-${nonce}>` : '';
  // I-046: the opening marker the turn asks for, in front of the reply (split across two chunks, as a real stream may cut it).
  const opening = [...text.matchAll(/<sh-open-[a-f0-9]{8}>/gu)].at(-1)?.[0] ?? (systemOpening ? '<sh-open>' : undefined);
  if (opening) body.unshift(opening.slice(0, 7), opening.slice(7));
  return [...body, tail.slice(0, 20), tail.slice(20), setting].filter(Boolean);
}

createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    return;
  }
  if (message.type !== 'user') return;
  turn++;
  if (!verdict.ok) {
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, result: `fake: ${verdict.reason}` });
    return;
  }
  send({ type: 'system', subtype: 'init', session_id: session, model: verdict.model || 'fake-default', tools: [], mcp_servers: [] });
  const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
  const text = blocks.filter(block => block?.type === 'text').map(block => block.text).join('');
  // Test hook: this current message answers like a rate-limited account.
  if (text.includes('"currentUser":"FAKE-429"')) {
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, result: 'API Error: 429 rate limit reached' });
    return;
  }
  const parts = reply(text);
  for (const part of parts) send({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } });
  send({ type: 'assistant', session_id: session, message: { id: `m${turn}`, content: [{ type: 'text', text: parts.join('') }] } });
  send({ type: 'result', subtype: 'success', is_error: false, session_id: session, total_cost_usd: 0, duration_api_ms: 1,
    usage: { input_tokens: text.length, output_tokens: parts.join('').length, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
});
