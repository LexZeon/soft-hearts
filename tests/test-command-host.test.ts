/**
 * D2 / I-008, host side: developer mode gates everything (off: the text stays ordinary chat, byte for byte); a local match runs
 * without the model; only an unmatched message asks one small model call with the entry list; the note lines are not
 * chat; the diagnostic line is the entry id and the time only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TEST_NOTE_MAX, type TestCommandNote } from '../shared/test-command';
import { TestCommandHost } from '../electron/test-commands/host';
import { pickTestEntry, parseTestPick, testPickPrompt, TEST_PICK_SYSTEM_PROMPT } from '../electron/test-commands/model-pick';
import { INNER_LOOP_MODEL, quickLineWithClaude, type InnerLoopStream } from '../electron/inner-loop/model';
import { buildTestEntries } from '../electron/test-commands/entries';
import { fakeTestDeps } from './helpers/test-command-fixtures';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
type Pick = NonNullable<ConstructorParameters<typeof TestCommandHost>[0]['pick']>;

function harness(over: { developer?: boolean; pick?: Pick; pickTimeoutMs?: number; file?: string | null; throwingEntry?: boolean } = {}) {
  const fake = fakeTestDeps();
  if (over.throwingEntry) fake.deps.music.rejudge = () => { throw new Error('boom'); };
  const notes: { owner: number; note: TestCommandNote }[] = [];
  const written: { file: string; line: string }[] = [];
  const state = { developer: over.developer ?? true, picks: 0 };
  let id = 0;
  const host = new TestCommandHost({
    developerMode: () => state.developer,
    deps: fake.deps,
    note: (owner, note) => notes.push({ owner, note }),
    diagnosticsFile: () => over.file === undefined ? '/profile/dev/test-commands.jsonl' : over.file,
    pick: over.pick ? (entries, body, signal) => { state.picks++; return over.pick!(entries, body, signal); } : undefined,
    append: async (file, line) => { written.push({ file, line }); },
    clock: () => 1_234_567,
    createId: () => `cmd-${++id}`,
    pickTimeoutMs: over.pickTimeoutMs,
  });
  return { host, fake, notes, written, state, texts: () => notes.map(item => item.note.text) };
}

test('developer mode off: nothing is handled, nothing runs, nothing is written (the text stays an ordinary chat message)', async () => {
  const h = harness({ developer: false, pick: async () => 'L2.daydream' });
  assert.deepEqual(h.host.accept(7, '测试：发呆'), { handled: false, id: '' });
  assert.deepEqual(h.host.accept(7, '测试：帮助'), { handled: false, id: '' });
  await settle();
  assert.deepEqual(h.fake.calls, []);
  assert.deepEqual(h.notes, []);
  assert.deepEqual(h.written, []);
  assert.equal(h.state.picks, 0);
});

test('not a test command: handled false even in developer mode', async () => {
  const h = harness();
  for (const text of ['发呆', '你好', '今天测试：发呆', '测试一下发呆', '', undefined, 42, '测试：' + '字'.repeat(300)])
    assert.deepEqual(h.host.accept(7, text), { handled: false, id: '' }, String(text));
  await settle();
  assert.deepEqual(h.notes, []);
});

test('a local match runs the entry at once: no model call, one note to the asking window, the entry id and time in the log', async () => {
  const h = harness({ pick: async () => { throw new Error('must not be asked'); } });
  assert.deepEqual(h.host.accept(7, '测试：去忙自己的事'), { handled: true, id: 'cmd-1' });
  await settle();
  assert.deepEqual(h.fake.calls, ['herLife.start:null']);
  assert.equal(h.state.picks, 0);
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].owner, 7);
  assert.equal(h.notes[0].note.id, 'cmd-1');
  assert.match(h.notes[0].note.text, /^（测试：她按自己的心情和性格/u);
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].file, '/profile/dev/test-commands.jsonl');
  assert.deepEqual(JSON.parse(h.written[0].line), { at: 1_234_567, entry: 'L2.rules', via: 'local' });
  assert.ok(h.written[0].line.endsWith('\n'));
  assert.equal(h.written[0].line.includes('忙自己'), false, 'the user\'s words are never logged');
});

test('half-width colon, spaces and near-synonyms work the same', async () => {
  const h = harness();
  h.host.accept(3, '测试:  让她发发呆吧 ');
  h.host.accept(4, '测试 ： 放空');
  await settle();
  assert.deepEqual(h.fake.calls, ['herLife.start:daydream', 'herLife.start:daydream']);
  assert.deepEqual(h.notes.map(item => item.owner), [3, 4]);
});

test('"测试：帮助" and "测试：有哪些" list every entry (id, name, summary) without running any', async () => {
  const h = harness();
  h.host.accept(7, '测试：帮助');
  h.host.accept(7, '测试：有哪些');
  h.host.accept(7, '测试：');
  await settle();
  assert.equal(h.notes.length, 3);
  const ids = buildTestEntries(fakeTestDeps().deps).entries.map(entry => entry.id);
  for (const note of h.texts()) {
    assert.match(note, /^（测试：下面是所有的测试入口/u);
    for (const id of ids) assert.ok(note.includes(id), id);
  }
  assert.deepEqual(h.fake.calls, []);
  assert.deepEqual(h.written.map(item => JSON.parse(item.line).via), ['help', 'help', 'help']);
});

test('no local match: one model call with the entry list; its pick runs the entry, and the note says Claude picked it', async () => {
  let seen: { ids: string[]; body: string } | null = null;
  const h = harness({ pick: async (entries, body) => { seen = { ids: entries.map(entry => entry.id), body }; return 'L2.thinking'; } });
  h.host.accept(7, '测试：她最近好像总在琢磨点什么，让她表现出来');
  await settle();
  assert.deepEqual(seen!.ids.slice(0, 3), ['L2.rules', 'L2.daydream', 'L2.humming']);
  assert.equal(seen!.ids.length, buildTestEntries(fakeTestDeps().deps).entries.length);
  assert.equal(seen!.body, '她最近好像总在琢磨点什么，让她表现出来');
  assert.deepEqual(h.fake.calls, ['herLife.start:thinking']);
  const texts = h.texts();
  assert.equal(texts.length, 3);
  assert.match(texts[0], /本地没对上，正在请 Claude 帮忙找入口/u);
  assert.match(texts[1], /Claude 帮忙选了“想事情”/u);
  assert.match(texts[2], /已让她开始想事情/u);
  assert.deepEqual(h.written.map(item => JSON.parse(item.line)), [{ at: 1_234_567, entry: 'L2.thinking', via: 'claude' }]);
});

test('the model finds nothing, answers with an id outside the list, or fails: a plain note, nothing runs', async () => {
  for (const [pick, via, pattern] of [
    [async () => null, 'none', /没找到对应的入口/u],
    [async () => 'D1.delete-everything', 'none', /没找到对应的入口/u],
    [async () => { throw new Error('offline'); }, 'error', /Claude 现在没能帮忙找入口/u],
  ] as [Pick, string, RegExp][]) {
    const h = harness({ pick });
    h.host.accept(7, '测试：随便来点什么');
    await settle();
    assert.deepEqual(h.fake.calls, []);
    assert.match(h.texts().at(-1)!, pattern);
    assert.equal(JSON.parse(h.written[0].line).via, via);
  }
});

test('a sentence with two hits is still decided locally (the longest alias wins), without the model', async () => {
  const h = harness({ pick: async () => 'L2.drowsy' });
  h.host.accept(7, '测试：我累了又困了');
  await settle();
  assert.equal(h.state.picks, 0);
  assert.deepEqual(h.fake.calls, ['userState.set:tired']);
});

test('a slow model is cut off after its time; a newer command makes an older answer late and it is dropped', async () => {
  const hung = harness({ pickTimeoutMs: 20, pick: (_entries, _body, signal) => new Promise<string | null>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  hung.host.accept(7, '测试：随便来点什么');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.match(hung.texts().at(-1)!, /没能帮忙找入口/u);

  let release: (id: string | null) => void = () => {};
  const slow = harness({ pick: () => new Promise<string | null>(resolve => { release = resolve; }) });
  slow.host.accept(7, '测试：随便来点什么');
  await settle();
  slow.host.accept(7, '测试：发呆');
  await settle();
  release('L2.humming');
  await settle();
  assert.deepEqual(slow.fake.calls, ['herLife.start:daydream'], 'the older pick never runs');
});

test('an entry that throws is reported and does not take the host down', async () => {
  const h = harness({ throwingEntry: true });
  h.host.accept(7, '测试：想不想跳');
  await settle();
  assert.match(h.texts().at(-1)!, /这个入口出错了/u);
  h.host.accept(7, '测试：发呆');
  await settle();
  assert.match(h.texts().at(-1)!, /已让她开始发呆/u);
});

test('a note is cut to the allowed length; a missing log file writes nothing; after dispose nothing is sent', async () => {
  const quiet = harness({ file: null });
  quiet.host.accept(7, '测试：发呆');
  await settle();
  assert.deepEqual(quiet.written, []);
  assert.ok(quiet.notes.every(item => [...item.note.text].length <= TEST_NOTE_MAX));
  const h = harness();
  h.host.dispose();
  assert.deepEqual(h.host.accept(7, '测试：发呆'), { handled: false, id: '' });
  await settle();
  assert.deepEqual(h.notes, []);
});

test('the model call itself: haiku, tool-less, its own system prompt, the list only in this message; only a listed id is accepted', async () => {
  const entries = buildTestEntries(fakeTestDeps().deps).entries;
  const tasks: Parameters<InnerLoopStream>[0][] = [];
  const stream: InnerLoopStream = async (task, _signal, emit) => { tasks.push(task); emit('delta', '好的：{"id": "L2.drowsy"} 谢谢'); return null; };
  const picked = await pickTestEntry(entries, '她看起来快睡着了', new AbortController().signal,
    (prompt, system, signal) => quickLineWithClaude(prompt, system, signal, stream));
  assert.equal(picked, 'L2.drowsy');
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.equal(task.model, INNER_LOOP_MODEL);
  assert.equal(task.writable, false);
  assert.deepEqual(task.imageDataUrls, []);
  assert.equal(task.systemPrompt, TEST_PICK_SYSTEM_PROMPT);
  assert.equal(task.prompt, testPickPrompt(entries, '她看起来快睡着了'));
  for (const entry of entries) assert.ok(task.prompt.includes(entry.id), entry.id);
  assert.ok(task.prompt.includes('她看起来快睡着了'));
  assert.equal(parseTestPick('{"id":null}', entries), null);
  assert.equal(parseTestPick('{"id":"L9.nope"}', entries), null);
  assert.equal(parseTestPick('not json', entries), null);
  assert.equal(parseTestPick('{"id":["L2.rules"]}', entries), null);
  assert.equal(parseTestPick('[{"id":"L2.rules"}]', entries), 'L2.rules', 'the first object in the text counts');
});

test('no chat prompt module imports the test commands (a normal message\'s prompt cannot change because of them)', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['electron/claude-session-prompt.ts', 'electron/claude-session.ts', 'electron/claude.ts', 'electron/conversation-context.ts',
    'electron/mood-chat.ts', 'electron/chat-settings.ts', 'shared/companion-rules.ts', 'electron/companion.ts']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(/from\s+['"][^'"]*test-command/u.test(source), false, file);
  }
});
