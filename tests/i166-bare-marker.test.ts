// 2026-11-22 (found in a fake-Claude acceptance with senses): a reply that is only a closer-look marker, with that sense off or the
// frame failing, left an empty bubble, and the next turn's history then did not match the warm process (a cold 'diverged-short').
// Now she always says something: the continuation tells her the sense is off / no picture came and she goes on in words, in the same
// warm process and the same reply; a process that cannot continue gets the app's own "……" instead of nothing.
// Real: PersistentClaudeChat with the fake Claude, LookContinuation, closerLookNote. Fake: Claude Code, the capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { ChatMessage } from '../shared/foundation/chat';
import { closerLookNote } from '../shared/senses/see-and-say/words';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { LookContinuation, type CloserLookEntry } from '../electron/brain/look-continuation';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { fakeClaudeStream } from './helpers/fake-claude-stream';

async function kit(over: { on: boolean; capture?: () => Promise<{ dataUrls(): string[] } | null> }) {
  const claude = await fakeClaudeStream();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: line => { if (process.env.DBG) console.log(line); } });
  const messages: ChatMessage[] = [], shownBy = new Map<number, string>();
  let n = 0;
  const task = (text: string): CompanionClaudeTask => {
    messages.push({ role: 'user', content: text });
    const window = [...messages], base = '你是测试角色小桃。';
    return { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(base, window); },
      replyId: `r${++n}`, session: { key: 'typed', basePersona: base, persona: base, messages: window, data: () => null, shown: ((id: number) => () => shownBy.get(id) ?? null)(n) } };
  };
  const entries: CloserLookEntry[] = [];
  const look = new LookContinuation({ senses: () => ({ camera: over.on, screen: false }), capture: async () => (over.capture ? over.capture() : null),
    note: (sense, seen, off) => `CONTINUE-${sense}-${off ? 'off' : seen ? 'seen' : 'missed'}`, journal: entry => entries.push(entry),
    knobs: { closerLook: true, closerTimeoutMs: 2000, dots: '……' } });
  const say = async (text: string) => {
    let shown = '';
    await look.stream(chat, task(text), new AbortController().signal, (type, delta) => { if (type === 'delta') shown += delta; });
    shownBy.set(n, shown); messages.push({ role: 'assistant', content: shown });
    return shown;
  };
  const pids = async () => (await claude.inputs()).filter(input => input.user !== undefined).map(input => input.pid);
  return { claude, chat, entries, say, pids, dispose: async () => { chat.dispose(); await claude.cleanup(); } };
}

test('a reply that is only the marker, with the sense off: she is told it is off and goes on in words; the next turn reuses the warm process', async () => {
  const k = await kit({ on: false });
  try {
    const shown = await k.say('⟦look-camera⟧#bare');
    assert.ok(shown.trim().length > 0 && !shown.includes('⟦'), `not empty, no marker: ${JSON.stringify(shown)}`);
    assert.ok(shown.includes('CONTINUE-camera-off'), shown);
    assert.deepEqual(k.entries.map(entry => entry.outcome), ['off']);
    const next = await k.say('然后呢');
    assert.ok(next.includes('然后呢'));
    const used = await k.pids();
    assert.equal(used.length, 3, 'marker turn, its continuation, the next turn');
    assert.equal(new Set(used).size, 1, `one warm process, no diverged cold start: ${used}`);
  } finally { await k.dispose(); }
});

test('a reply that is only the marker, and the frame fails: she goes on without it, also in the same warm process afterwards', async () => {
  const k = await kit({ on: true, capture: async () => null });
  try {
    const shown = await k.say('⟦look-camera⟧#bare');
    assert.ok(shown.includes('CONTINUE-camera-missed'), shown);
    assert.deepEqual(k.entries.map(entry => [entry.outcome, entry.why]), [['failed', 'no-frame']]);
    await k.say('然后呢');
    assert.equal(new Set(await k.pids()).size, 1);
  } finally { await k.dispose(); }
});

test('a reply with words before the marker and the sense off still ends as she wrote it (no extra continuation)', async () => {
  const k = await kit({ on: false });
  try {
    const shown = await k.say('我看看⟦look-camera⟧');
    assert.ok(!shown.includes('CONTINUE'), shown);
    assert.ok(shown.includes('我看看'), shown);
    assert.equal((await k.pids()).length, 1);
  } finally { await k.dispose(); }
});

test('only the marker and no process to continue: the app\'s own dots go out, never an empty reply', async () => {
  for (const on of [false, true]) {
    const chat = { stream: async (_task: CompanionClaudeTask, _signal: AbortSignal, emit: (type: 'delta', text: string) => void) => { emit('delta', '⟦look-screen⟧'); return { superseded: false, output: '' }; },
      continueReply: async () => null };
    const look = new LookContinuation({ senses: () => ({ camera: false, screen: on }), capture: async () => null, note: () => 'N', knobs: { closerLook: true, closerTimeoutMs: 100, dots: '……' } });
    let shown = '';
    await look.stream(chat, {} as CompanionClaudeTask, new AbortController().signal, (_type, text) => { shown += text; });
    assert.ok(shown.trim().length > 0 && !shown.includes('⟦'), `sense ${on ? 'on' : 'off'}: ${JSON.stringify(shown)}`);
  }
});

test('the off note names the sense, says there is no picture, and is not the "did not come" note', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    const off = closerLookNote('screen', false, language, '', true), missed = closerLookNote('screen', false, language, '');
    assert.notEqual(off, missed);
    assert.ok(off.length > 20);
  }
  assert.ok(closerLookNote('camera', false, 'zh-CN', '', true).includes('关着'));
});
