import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeFailureError, simulatedClaudeFailure, streamClaude } from '../electron/claude';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/claude-session';
import { ChatAvailability } from '../electron/chat-availability';

const TEXT = "You've hit your session limit · resets 11:59pm (America/Los_Angeles)";
const task = (): CompanionClaudeTask => ({ kind: 'chat', model: 'haiku', workingDirectory: '', writable: false, prompt: '你好', replyId: 'r',
  session: { key: 'k', basePersona: 'p', persona: 'p', messages: [{ role: 'user', content: '你好' }] } });

async function withSimulation<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env.SOFT_HEARTS_SIMULATE_CLAUDE_FAILURE;
  if (value === undefined) delete process.env.SOFT_HEARTS_SIMULATE_CLAUDE_FAILURE; else process.env.SOFT_HEARTS_SIMULATE_CLAUDE_FAILURE = value;
  try { return await run(); }
  finally { if (before === undefined) delete process.env.SOFT_HEARTS_SIMULATE_CLAUDE_FAILURE; else process.env.SOFT_HEARTS_SIMULATE_CLAUDE_FAILURE = before; }
}

test('the trial switch is off unless set, and empty means off', () => {
  assert.equal(simulatedClaudeFailure({}), null);
  assert.equal(simulatedClaudeFailure({ SOFT_HEARTS_SIMULATE_CLAUDE_FAILURE: '   ' }), null);
  const error = simulatedClaudeFailure({ SOFT_HEARTS_SIMULATE_CLAUDE_FAILURE: TEXT })!;
  assert.ok(error instanceof ClaudeFailureError);
  assert.equal(error.detail, TEXT);
});

test('with the switch set, ordinary chat fails like a real quota error and reaches the panel state; without it nothing changes', async () => {
  const availability = new ChatAvailability({ now: () => Date.UTC(2026, 10, 2, 18, 0) });
  let reached = 0;
  const chat = new PersistentClaudeChat({ enabled: false, availability, perMessage: async (_t, _s, emit) => { reached++; emit('delta', '嗯'); } });
  const error = await withSimulation(TEXT, () => chat.stream(task(), new AbortController().signal, () => {}).then(() => null, e => e));
  assert.ok(error instanceof ClaudeFailureError);
  assert.equal(reached, 0, 'the real Claude path is never reached');
  assert.equal(availability.view().kind, 'quota');
  assert.equal(availability.notice(error)?.speak, true);
  const fine = await withSimulation(undefined, () => chat.stream(task(), new AbortController().signal, () => {}));
  assert.equal(fine.output, '嗯');
  assert.equal(reached, 1);
  assert.equal(availability.view().state, 'ok');
});

test('with the switch set, one-shot Claude calls (retry, her prepared lines) fail the same way before any process starts', async () => {
  const error = await withSimulation(TEXT, () => streamClaude({ kind: 'chat', model: 'haiku', workingDirectory: '', writable: false, prompt: 'x' },
    new AbortController().signal, () => {}, '/definitely/not/a/program').then(() => null, e => e));
  assert.ok(error instanceof ClaudeFailureError);
  assert.equal(error.detail, TEXT);
});
