import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChatOutage } from '../electron/chat-outage';
import { ChatAvailability } from '../electron/chat-availability';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/claude-session';
import { ClaudeFailureError } from '../electron/claude';
import { outageDisplayText, genericOutageLine, OUTAGE_LINE_KINDS, type ChatAvailabilityView } from '../shared/chat-availability';

const LIMIT = "You've hit your session limit · resets 1:20pm (America/Los_Angeles)";
const OFFLINE = "Can't reach the API server";
const task = (): CompanionClaudeTask => ({ kind: 'chat', model: 'haiku', workingDirectory: '', writable: false, prompt: '你好', replyId: 'r',
  session: { key: 'k', basePersona: 'p', persona: 'p', messages: [{ role: 'user', content: '你好' }] } });
const lines = (tag: string) => JSON.stringify(Object.fromEntries(OUTAGE_LINE_KINDS.map(kind => [kind, [`${tag}甲${kind}`, `${tag}乙${kind}`, `${tag}丙${kind}`]])));
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), 'timed out'); };

/** Her lines for `persona` are cached, the cache file is written, and the generation has fully finished. */
async function prepared(a: { outage: { bank: { lines(persona: string): unknown; flush(): Promise<void> } } }, persona: string) {
  await waitFor(() => a.outage.bank.lines(persona) !== null);
  await a.outage.bank.flush();
  await new Promise(resolve => setTimeout(resolve, 10));
}

async function app(options: { limits?: Record<string, number> } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-outage-app-'));
  const state = { persona: '角色 A：嘴硬心软', busy: false, failWith: null as string | null, generated: '' as string | Error, prompts: [] as string[], views: [] as ChatAvailabilityView[], opened: [] as string[], clock: 1_000_000 };
  state.generated = lines('A');
  const availability = new ChatAvailability({ now: () => state.clock });
  const outage = createChatOutage({
    availability, directory: () => dir, provider: () => ({ kind: 'claude', model: 'haiku' }), persona: () => state.persona,
    chatBusy: () => state.busy, publish: view => state.views.push(view), openExternal: target => { state.opened.push(target); },
    platform: 'win32', lineDelayMs: 0, now: () => state.clock, lineLimits: options.limits ?? { minGapMs: 0, retryCardMs: 0, maxPerDay: 99 },
    run: async (claudeTask, _signal, emit) => {
      state.prompts.push(claudeTask.prompt);
      assert.equal(claudeTask.writable, false);
      assert.deepEqual(claudeTask.imageDataUrls, []);
      if (state.failWith && !claudeTask.prompt.includes('<character-card>')) throw new ClaudeFailureError('x', state.failWith);
      if (claudeTask.prompt.includes('<character-card>')) {
        if (state.generated instanceof Error) throw state.generated;
        emit('delta', state.generated);
      } else emit('delta', '好');
    },
  });
  await outage.load();
  const chat = new PersistentClaudeChat({ enabled: false, availability,
    perMessage: async (_t, _s, emit) => { if (state.failWith) throw new ClaudeFailureError('x', state.failWith); emit('delta', '嗯'); } });
  const send = async () => {
    const error = await chat.stream(task(), new AbortController().signal, () => {}).then(() => null, e => e);
    return error ? availability.notice(error) : null;
  };
  return { dir, state, availability, outage, send, cleanup: () => { outage.dispose(); return rm(dir, { recursive: true, force: true }); } };
}

test('before any line is cached she uses the generic sentence, once; the repeat shows nothing; recovery clears it', async () => {
  const a = await app();
  try {
    a.state.failWith = LIMIT;
    const first = await a.send();
    assert.deepEqual(first, { kind: 'quota', speak: true, line: null });
    assert.equal(outageDisplayText(first), genericOutageLine('quota'));
    const second = await a.send();
    assert.equal(second?.speak, false);
    assert.equal(outageDisplayText(second), '');
    assert.equal(a.availability.view().state, 'unavailable');
    assert.equal(a.state.views.at(-1)?.kind, 'quota');
    a.state.failWith = null;
    assert.equal(await a.send(), null);
    assert.equal(a.availability.view().state, 'ok');
    assert.equal(a.state.views.at(-1)?.state, 'ok');
  } finally { await a.cleanup(); }
});

test('while chat works her lines are prepared for the active card, then used in the next outage', async () => {
  const a = await app();
  try {
    await a.send(); // a working turn
    await prepared(a, a.state.persona);
    assert.equal(a.state.prompts.length, 1);
    assert.match(a.state.prompts[0], /角色 A：嘴硬心软/);
    const saved = JSON.parse(await readFile(path.join(a.dir, 'outage-lines.json'), 'utf8'));
    assert.equal(Object.keys(saved.cards).length, 1);
    a.state.failWith = LIMIT;
    const notice = await a.send();
    assert.equal(notice?.line, 'A甲quota');
    assert.equal(outageDisplayText(notice), 'A甲quota');
    // The next outage picks the next line.
    a.state.failWith = null; await a.send();
    a.state.failWith = OFFLINE;
    assert.equal((await a.send())?.line, 'A乙network');
    // Coming back is told once, in her words, in the status update.
    a.state.failWith = null; await a.send();
    const recovered = a.state.views.filter(view => view.recovered);
    assert.equal(recovered.length >= 1, true);
    assert.equal(recovered.at(-1)?.recovered?.line, 'A乙recovered');
  } finally { await a.cleanup(); }
});

test('another character has its own lines; before they exist the generic sentence is used, not the previous character\'s', async () => {
  const a = await app();
  try {
    await a.send();
    await prepared(a, '角色 A：嘴硬心软');
    a.state.persona = '角色 B：温柔话少';
    a.state.failWith = OFFLINE;
    const notice = await a.send();
    assert.deepEqual(notice, { kind: 'network', speak: true, line: null });
    a.state.failWith = null; a.state.generated = lines('B');
    await a.send();
    await prepared(a, '角色 B：温柔话少');
    a.state.failWith = OFFLINE;
    assert.match((await a.send())?.line ?? '', /^B/);
    // Switching back and forth in the middle of one outage: each character announces once.
    a.state.persona = '角色 A：嘴硬心软';
    const again = await a.send();
    assert.equal(again?.speak, true);
    assert.match(again?.line ?? '', /^A/);
  } finally { await a.cleanup(); }
});

test('a changed card gets new lines, but only within the generation limits', async () => {
  const a = await app({ limits: { minGapMs: 10 * 60_000, retryCardMs: 6 * 3_600_000, maxPerDay: 4 } });
  try {
    await a.send();
    await prepared(a, '角色 A：嘴硬心软');
    a.state.persona = '角色 A：嘴硬心软（改过）';
    a.state.generated = lines('N');
    await a.send(); // too soon after the last attempt
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(a.outage.bank.lines(a.state.persona), null);
    assert.equal(a.state.prompts.filter(prompt => prompt.includes('<character-card>')).length, 1, 'no second call inside the gap');
    a.state.clock += 11 * 60_000;
    await a.send();
    await prepared(a, a.state.persona);
    assert.equal(a.outage.bank.pick(a.state.persona, 'quota', 0), 'N甲quota');
  } finally { await a.cleanup(); }
});

test('output that is not valid is never cached, and no preparation runs during a chat turn', async () => {
  const a = await app();
  try {
    a.state.generated = '{"quota":["只有一句话"]}';
    a.state.busy = true;
    await a.send();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(a.state.prompts.length, 0, 'not while a chat turn is running');
    a.state.busy = false;
    await a.send();
    await waitFor(() => a.state.prompts.length === 1);
    await a.outage.bank.flush();
    assert.equal(a.outage.bank.lines(a.state.persona), null);
    const saved = JSON.parse(await readFile(path.join(a.dir, 'outage-lines.json'), 'utf8'));
    assert.deepEqual(saved.cards, {});
  } finally { await a.cleanup(); }
});

test('the repair buttons: retry asks one small question and clears the state, and the only things opened are fixed', async () => {
  const a = await app();
  try {
    a.state.failWith = OFFLINE;
    await a.send();
    const stillDown = await a.outage.host.retry();
    assert.equal(stillDown.state, 'unavailable');
    assert.equal(a.state.prompts.at(-1), '请只回复一个字：好');
    a.state.failWith = null;
    const back = await a.outage.host.retry();
    assert.equal(back.state, 'ok');
    assert.equal(a.state.views.some(view => view.state === 'ok' && view.recovered), true);
    await a.outage.host.openNetworkSettings();
    await a.outage.host.openHelp();
    assert.deepEqual(a.state.opened, ['ms-settings:network', 'https://code.claude.com/docs/en/setup']);
  } finally { await a.cleanup(); }
});
