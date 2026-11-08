// When the model refuses, answers with nothing, answers with only an internal draft, or errors out, the user sees her own cached
// line (never a technical message, never an empty bubble), the turn is archived once, and the developer log gets a category only.
// The real Claude Code stream reader, the real persistent process and the per-message process run against a scripted fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/companion';
import { ChatAvailability } from '../electron/chat-availability';
import { ChatIncidentLog, DraftOnlyReplyError } from '../electron/chat-incident-log';
import { chatFailureEvent } from '../electron/chat-failure-event';
import { ClaudeStreamReader } from '../electron/claude';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/claude-session';
import { outageDisplayText } from '../shared/chat-availability';
import { CHAT_INCIDENTS, incidentOf, sanitizeChatIncident, type ChatIncident } from '../shared/chat-incident';

const HER_LINE = '唔，我刚刚走神了，你再说一遍好不好？';
const NOTICE = 'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or start a new session for Claude Code to assist with a different task.';
const TECHNICAL = /API Error|Claude Code|stop_reason|refus|Usage Policy|aup|internal server|api_error|没有返回|拒绝了|500|SCENARIO|过滤后/iu;

// A stand-in for `claude -p --input-format stream-json`: the word after SCENARIO: in the user message picks what it streams.
const SCRIPT = String.raw`
const readline = require('node:readline');
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
let turns = 0;
readline.createInterface({ input: process.stdin }).on('line', raw => {
  let message; try { message = JSON.parse(raw); } catch { return; }
  if (message.type !== 'user') return;
  const scenario = /SCENARIO:([a-z-]+)/.exec(JSON.stringify(message))?.[1] ?? 'ok';
  const id = 'msg_' + (++turns);
  const event = inner => send({ type: 'stream_event', event: inner });
  const delta = text => event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  const finish = (reason, content, result) => {
    event({ type: 'content_block_stop', index: 0 });
    event({ type: 'message_delta', delta: { stop_reason: reason } });
    event({ type: 'message_stop' });
    send({ type: 'assistant', message: { id, role: 'assistant', stop_reason: reason, content } });
    send({ type: 'result', subtype: 'success', is_error: false, stop_reason: reason, result });
  };
  send({ type: 'system', subtype: 'init', model: 'fake', tools: [], mcp_servers: [], slash_commands: [], permissionMode: 'default', apiKeySource: 'none' });
  event({ type: 'message_start', message: { id, role: 'assistant', content: [] } });
  if (scenario === 'refusal-notice') {
    send({ type: 'assistant', error: 'invalid_request', message: { id: 'syn', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(NOTICE)} }] } });
    send({ type: 'result', subtype: 'success', is_error: true, result: ${JSON.stringify(NOTICE)} });
    return;
  }
  if (scenario === 'error') {
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}' });
    return;
  }
  event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  if (scenario === 'refusal-stop') { finish('refusal', [], ''); return; }
  if (scenario === 'empty') { finish('end_turn', [{ type: 'text', text: '' }], ''); return; }
  const text = scenario === 'draft-only' ? '尾注里的 context 用 support，gesture 用 consider。用户在为失败难过，所以 delta 给个小幅变化。' : '好的，我在。';
  delta(text);
  finish('end_turn', [{ type: 'text', text }], text);
});
`;

const SCENARIOS: Array<{ scenario: string; incident: ChatIncident; kind: string; available: boolean }> = [
  { scenario: 'refusal-stop', incident: 'refusal', kind: 'a refusal stop reason with no text', available: true },
  { scenario: 'refusal-notice', incident: 'refusal', kind: "Claude Code's usage-policy notice", available: true },
  { scenario: 'empty', incident: 'empty', kind: 'a finished reply with no text', available: true },
  { scenario: 'draft-only', incident: 'draft-only', kind: 'a reply that was only an internal draft', available: true },
  { scenario: 'error', incident: 'error', kind: 'an API error', available: false },
];

async function environment(mode: 'persistent' | 'per-message') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-refusal-'));
  const script = path.join(directory, 'fake-claude.cjs');
  await writeFile(script, SCRIPT, 'utf8');
  const service = new CompanionService(directory, () => {});
  await service.load();
  await service.context('gene', { kind: 'claude', baseUrl: 'https://refusal.invalid/v1', model: 'fixture' }, '角色名称：Gene');
  const availability = new ChatAvailability({ line: kind => (kind === 'other' ? HER_LINE : null), cardKey: () => 'gene' });
  const lines: string[] = [];
  const incidents = new ChatIncidentLog({ enabled: () => true, file: () => path.join(directory, 'dev', 'chat-incidents.jsonl'), write: async (_file, line) => { lines.push(line); } });
  const chat = new PersistentClaudeChat({
    enabled: mode === 'persistent', binary: async () => process.execPath, binaryArgs: [script], provider: () => ({ kind: 'claude', model: '' }), chattedBefore: () => false,
    availability, interruptGraceMs: 300, log: () => {},
  });
  let count = 0;
  /** One chat turn the way electron/main.ts runs it: stream, finish, fail quietly on an emptied reply, finish as error otherwise. */
  async function say(scenario: string) {
    const id = `turn-${++count}`;
    const shown: string[] = [];
    const turn = await service.begin(id, `SCENARIO:${scenario}`, '角色名称：Gene', (type, text) => { if (type === 'delta') shown.push(text); });
    const messages = [{ role: 'user' as const, content: `SCENARIO:${scenario}` }];
    const task: CompanionClaudeTask = {
      kind: 'chat', model: '', workingDirectory: directory, writable: false, prompt: `SCENARIO:${scenario}`, replyId: id,
      session: { key: `conversation-${count}`, basePersona: '角色名称：Gene', persona: turn.persona, messages, data: () => null },
    };
    let error: unknown = null;
    try {
      await chat.stream(task, new AbortController().signal, turn.push);
      await turn.finish('complete');
      if (turn.emptyReply?.()) throw availability.quietFailure(new DraftOnlyReplyError());
    } catch (failure) { error = failure; await turn.finish('error'); }
    const event = error ? chatFailureEvent({ id, kind: 'chat', error, aborted: false, availability, incidents }) : null;
    return { turn, shown, error, event };
  }
  return { directory, service, availability, chat, lines, say, cleanup: async () => { chat.dispose(); await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

for (const mode of ['persistent', 'per-message'] as const) {
  for (const spec of SCENARIOS) {
    test(`${mode}: ${spec.kind} gives her line, no technical text, no empty bubble, one archive, a category-only log`, async () => {
      const env = await environment(mode);
      try {
        const { turn, shown, error, event } = await env.say(spec.scenario);
        assert.ok(error, 'the turn failed');
        assert.ok(event && event.type === 'error');
        // What the window shows in normal mode: her cached line, from the notice; the technical message is never displayed.
        assert.ok(event.outage, 'there is a notice for her to speak');
        assert.equal(event.outage.kind, 'other');
        assert.equal(event.outage.speak, true);
        assert.equal(outageDisplayText(event.outage), HER_LINE);
        assert.doesNotMatch(outageDisplayText(event.outage) ?? '', TECHNICAL);
        // No empty bubble: nothing was streamed to the window (or only a text with real content).
        assert.ok(shown.every(piece => piece.trim().length > 0) && shown.length === 0, `streamed: ${JSON.stringify(shown)}`);
        // Archived once: the user's message and one assistant placeholder, an error, empty.
        assert.equal(env.service.memory.list(turn.scope).total, 1);
        const record = env.service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
        assert.deepEqual(record.messages.map(message => [message.role, message.content, message.status]),
          [['user', `SCENARIO:${spec.scenario}`, 'complete'], ['assistant', '', 'error']]);
        await turn.finish('error'); await turn.finish('complete'); // a late second finish changes nothing
        assert.equal(env.service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!.messages.length, 2);
        // The developer log: one line, time and category.
        assert.equal(env.lines.length, 1);
        const entry = JSON.parse(env.lines[0]);
        assert.deepEqual(Object.keys(entry).sort(), ['at', 'category']);
        assert.equal(entry.category, spec.incident);
        assert.ok(!Number.isNaN(Date.parse(entry.at)));
        assert.doesNotMatch(env.lines[0], /SCENARIO|API|Usage|Gene/u);
        // A refusal, an empty answer and a draft-only one leave chat available; a real error is an outage as before.
        assert.equal(env.availability.view().state, spec.available ? 'ok' : 'unavailable');
        // A failure that repeats while Claude keeps failing is said once, then quiet. A draft-only reply is different: Claude
        // itself answered fine, which clears the "already said" memory, so each such reply gets her line.
        const again = await env.say(spec.scenario);
        const repeats = spec.incident === 'draft-only';
        assert.equal(again.event?.outage?.speak, repeats);
        assert.equal(outageDisplayText(again.event?.outage), repeats ? HER_LINE : '');
      } finally { await env.cleanup(); }
    });
  }
}

test('a normal reply still works through the same pipeline, and it is not logged', async () => {
  const env = await environment('persistent');
  try {
    const { turn, shown, error, event } = await env.say('ok');
    assert.equal(error, null); assert.equal(event, null);
    assert.equal(shown.join(''), '好的，我在。');
    assert.equal(env.service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!.messages[1].status, 'complete');
    assert.deepEqual(env.lines, []);
  } finally { await env.cleanup(); }
});

test('three quiet failures in a row stop being a one-off; a working reply in between resets the count', async () => {
  const env = await environment('per-message');
  try {
    await env.say('refusal-stop'); await env.say('empty');
    assert.equal(env.availability.view().state, 'ok');
    await env.say('ok');
    await env.say('refusal-stop'); await env.say('refusal-stop');
    assert.equal(env.availability.view().state, 'ok', 'the count started again after the working reply');
    await env.say('empty');
    assert.equal(env.availability.view().state, 'unavailable', 'the third in a row is recorded as a real failure');
  } finally { await env.cleanup(); }
});

// ------------------------------------------------------------------ the pieces

function consume(events: Array<Record<string, unknown>>) {
  const reader = new ClaudeStreamReader(() => {});
  reader.consumeEvent({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
  const verdicts = events.map(event => reader.consumeEvent(event));
  return { reader, verdicts };
}
test('the stream reader sees a refusal in a message_delta, an assistant message, a result, or the usage-policy notice', () => {
  const ok = { type: 'result', subtype: 'success', is_error: false, result: '好' };
  assert.equal(consume([{ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'refusal' } } }, ok]).reader.refused, true);
  assert.equal(consume([{ type: 'assistant', message: { id: 'a', stop_reason: 'refusal', content: [] } }, ok]).reader.refused, true);
  assert.equal(consume([{ ...ok, stop_reason: 'refusal' }]).reader.refused, true);
  assert.equal(consume([{ type: 'assistant', error: 'invalid_request', message: { model: '<synthetic>', content: [{ type: 'text', text: NOTICE }] } }, ok]).reader.refused, true);
  const notice = consume([{ type: 'result', subtype: 'success', is_error: true, result: NOTICE }]);
  assert.equal(notice.reader.refused, true); assert.equal(notice.reader.failure, '', 'a refusal is not a process failure'); assert.equal(notice.verdicts[0], 'ok');
});
test('the stream reader does not call an ordinary ending, an ordinary error or a normal "I cannot help" refusal a model refusal', () => {
  const normal = consume([{ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
    { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '这个我帮不了你。' }]);
  assert.equal(normal.reader.refused, false);
  const broken = consume([{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 500' }]);
  assert.equal(broken.reader.refused, false); assert.notEqual(broken.reader.failure, ''); assert.equal(broken.verdicts[0], 'stop');
});
test('a synthetic notice is never the reply text', () => {
  const { reader } = consume([{ type: 'assistant', message: { id: 's', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500 oops' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '' }]);
  assert.equal(reader.output, '');
});

test('the incident category: refusal, empty and draft-only come from the error itself, anything else is "error", a context change is none', () => {
  assert.equal(incidentOf(Object.assign(new Error('x'), { incident: 'refusal' })), 'refusal');
  assert.equal(incidentOf(Object.assign(new Error('x'), { incident: 'empty' })), 'empty');
  assert.equal(incidentOf(new DraftOnlyReplyError()), 'draft-only');
  assert.equal(incidentOf(new Error('API Error: 429')), 'error');
  assert.equal(incidentOf('text'), 'error');
  assert.equal(incidentOf(Object.assign(new Error('x'), { kind: 'closed' })), null);
  assert.equal(incidentOf(Object.assign(new Error('x'), { incident: 'something else' })), 'error');
  assert.deepEqual([...CHAT_INCIDENTS], ['refusal', 'empty', 'draft-only', 'error']);
});
test('the log accepts only a known category and writes nothing outside developer mode', () => {
  assert.deepEqual(sanitizeChatIncident({ category: 'refusal', text: '用户说了什么', error: 'API Error' }), { category: 'refusal' });
  assert.equal(sanitizeChatIncident({ category: '用户说了什么' }), null);
  assert.equal(sanitizeChatIncident('refusal'), null);
  const written: string[] = [];
  let developer = false;
  const log = new ChatIncidentLog({ enabled: () => developer, file: () => '/x/dev/chat-incidents.jsonl', wallNow: () => Date.UTC(2026, 10, 3, 1, 2, 3), write: async (_file, line) => { written.push(line); } });
  assert.equal(log.record('refusal'), false); assert.deepEqual(written, []);
  developer = true;
  assert.equal(log.record('refusal'), true);
  assert.equal(log.record(null), false);
  assert.equal(log.record('not a category' as never), false);
  assert.deepEqual(written, ['{"at":"2026-11-03T01:02:03.000Z","category":"refusal"}\n']);
  assert.equal(new ChatIncidentLog({ enabled: () => { throw new Error('x'); }, file: () => 'f' }).record('error'), false);
});
test('the failure event: her notice for a chat failure, the plain text for a stop or another kind of task, and a log failure changes nothing', () => {
  const availability = new ChatAvailability({ line: () => HER_LINE, cardKey: () => 'k' });
  const error = availability.quietFailure(Object.assign(new Error('Claude 拒绝了这次请求。'), { incident: 'refusal' }));
  const recorded: Array<ChatIncident | null> = [];
  const incidents = { record: (category: ChatIncident | null) => { recorded.push(category); return true; } };
  const event = chatFailureEvent({ id: 'a', kind: 'chat', error, aborted: false, availability, incidents });
  assert.deepEqual(event, { id: 'a', kind: 'chat', type: 'error', text: 'Claude 拒绝了这次请求。', outage: { kind: 'other', speak: true, line: HER_LINE } });
  assert.deepEqual(recorded, ['refusal']);
  assert.deepEqual(chatFailureEvent({ id: 'b', kind: 'chat', error, aborted: true, availability, incidents }), { id: 'b', kind: 'chat', type: 'error', text: '已停止。' });
  assert.deepEqual(chatFailureEvent({ id: 'c', kind: 'agent', error: new Error('任务出错'), aborted: false, availability, incidents }), { id: 'c', kind: 'agent', type: 'error', text: '任务出错' });
  assert.deepEqual(recorded, ['refusal'], 'a stop and a non-chat task are not chat incidents');
  const throwing = { record: () => { throw new Error('disk full'); } };
  assert.equal(chatFailureEvent({ id: 'd', kind: 'chat', error: new Error('x'), aborted: false, availability, incidents: throwing }).type, 'error');
});
