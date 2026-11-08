// I-021 删除一致性, the late window for 一起听 (I-016) and 画像 (2026-11-05; docs/claude/2026-11-05-listen-late-window.md). The same
// window as Codex T-222 E04 (tests/recall-late-window.test.ts): a question about what she heard brings this turn its 一起听 block
// when the turn is put together (electron/main.ts, listenTogether.askTurn); the message may then wait for the Claude process.
// What the user deletes in the control window meanwhile (a note, the raw text, the character's memories) must not go out with it.
// The turn runs through the real CompanionService and PersistentClaudeChat with a fake process (no CLI, no network, no model);
// every song, show, note and profile entry is made up for the test, and each test uses its own temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type { ChatMessage } from '../shared/contracts';
import type { ListenNote, ListenSegment } from '../shared/listen-together';
import { CompanionService } from '../electron/companion';
import type { CompanionClaudeTask } from '../electron/claude-session';
import { buildCodexChatPrompt } from '../electron/conversation-context';
import { ListenTogether } from '../electron/listen-together/host';
import { ListenTogetherCore, type ListenFile } from '../electron/listen-together/core';
import { UserProfileStore } from '../electron/user-profile';
import { UserProfileContext } from '../electron/user-profile-context';
import { validateProvider } from '../electron/validation';
import { gatedChat, sentText } from './helpers/gated-claude';

const MIN = 60_000;
const CHARACTER = 'synthetic-listen-late';
const NAME = '合成角色';
const HOST_LINE = '（主机在这一轮后面加的一行）';
const NOW_SONG = '刚才那首歌讲的什么';
const PAST_SONG = '上次那首歌讲的什么';
const NOW_SHOW = '这集演到哪了';
const NOW_LINE = '刚才那首歌那句歌词是什么意思';
const RAIN = { segment: 'seg-rain', note: 'ln-seg-rain', raw: '合成歌词雨伞晚窗原文我们一起慢慢走回家', gist: '一首合成的慢歌，讲下雨天撑着雨伞走回家', point: '只在雨伞笔记里的一点' };
const SEA = { segment: 'seg-sea', note: 'ln-seg-sea', raw: '合成歌词海边晚窗原文风从海上吹过来', gist: '一首合成的快歌，讲夏天在海边吹风', point: '只在海边笔记里的一点' };
const SHOW = { segment: 'seg-show', raw: '合成台词晚窗原文你明天还会来车站吗' };

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-listen-late-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

function note(of: { segment: string; note: string; gist: string; point: string }, kind: 'music' | 'show', startedAt: number, endedAt: number): ListenNote {
  return { id: of.note, characterId: CHARACTER, segmentId: of.segment, kind, what: kind === 'music' ? '歌' : '剧', gist: of.gist, mood: '安静',
    points: [of.point], mention: false, hook: '', startedAt, endedAt, local: false, languages: ['zh'], createdAt: endedAt, updatedAt: endedAt, rolls: 0, talkedAt: null };
}
/**
 * Three things she heard with the user, all made up: a song that ended 15 minutes ago (her note covers all its words), a song from two
 * hours ago (with its note), and a short show that ended 5 minutes ago without a note (only its raw words). A segment still open
 * cannot be loaded (load closes it), and a note on one needs the model; the fields are dropped the same way either way.
 */
function listenFile(now: number): ListenFile {
  const rain: ListenSegment = { id: RAIN.segment, characterId: CHARACTER, kind: 'music', startedAt: now - 20 * MIN, lastHeardAt: now - 15 * MIN, endedAt: now - 15 * MIN,
    pieces: [{ at: now - 19 * MIN, end: now - 16 * MIN, text: RAIN.raw, language: 'zh' }], notedUpTo: now - 15 * MIN, notedAt: now - 15 * MIN };
  const sea: ListenSegment = { id: SEA.segment, characterId: CHARACTER, kind: 'music', startedAt: now - 125 * MIN, lastHeardAt: now - 120 * MIN, endedAt: now - 120 * MIN,
    pieces: [{ at: now - 124 * MIN, end: now - 121 * MIN, text: SEA.raw, language: 'zh' }], notedUpTo: now - 120 * MIN, notedAt: now - 120 * MIN };
  const show: ListenSegment = { id: SHOW.segment, characterId: CHARACTER, kind: 'show', startedAt: now - 6 * MIN, lastHeardAt: now - 5 * MIN, endedAt: now - 5 * MIN,
    pieces: [{ at: now - 6 * MIN, end: now - 5 * MIN, text: SHOW.raw, language: 'zh' }], notedUpTo: now - 6 * MIN - 1, notedAt: now - 5 * MIN };
  return { version: 1, segments: [rain, sea, show], deletedNotes: [],
    notes: [note(RAIN, 'music', rain.startedAt, rain.endedAt!), note(SEA, 'music', sea.startedAt, sea.endedAt!)] };
}

/** The real 一起听 host (its store in the temporary folder), loaded with the made-up file. No timer, no model: nothing is heard here. */
function listenHost(directory: string, now: number): ListenTogether {
  const listen = new ListenTogether({ directory, now: () => now, characterId: () => CHARACTER, listening: () => true,
    kinds: { current: () => ({ kind: 'quiet', confidence: 1, since: now - 10 * MIN, revision: 1 }) },
    quick: async () => { throw new Error('no model in this test'); } });
  listen.core.load(listenFile(now));
  return listen;
}

/** The 一起听 block inside a persona or a sent message ('' when it carries none). */
function listenBlock(text: string): string {
  const start = text.indexOf('\n\n【一起听】');
  return start < 0 ? '' : text.slice(start, text.indexOf('</external-audio-data>', start) + '</external-audio-data>'.length);
}
function listenItems(text: string): Record<string, unknown>[] {
  const block = listenBlock(text);
  if (!block) return [];
  const data = block.slice(block.indexOf('<external-audio-data>\n') + '<external-audio-data>\n'.length, block.indexOf('\n</external-audio-data>'));
  return JSON.parse(data);
}

/**
 * One ordinary typed chat turn on the Claude path, wired the way electron/main.ts hands it over: the 一起听 block joins the turn
 * when it is put together, the host adds its own lines after it, and the prompt and the session's persona are getters read where
 * the message is written, after the process has started (the last test holds main.ts to it). `whileStarting` runs in that wait.
 */
async function typedTurn(service: CompanionService, listen: ListenTogether, text: string, whileStarting?: () => void | Promise<void>) {
  const id = `turn-${Math.random().toString(36).slice(2)}`;
  const turn = await service.begin(id, text, NAME, () => {});
  const listenAsk = listen.askTurn(text); // main.ts: listenTogether?.askTurn(...) ?? NO_LISTEN_ASK
  turn.persona += listenAsk.block;
  turn.persona += '\n\n' + HOST_LINE;
  const settings = { persona: turn.persona }; // main.ts: settings.persona = turn.persona, once the host's lines are added
  let same = true;
  const outgoing = () => { const value = listenAsk.current(turn.withCurrentRecall(settings.persona)); same &&= value === settings.persona; return value; };
  const messages: ChatMessage[] = [{ role: 'user', content: text }];
  const lines: string[] = [];
  const { chat, starting, open } = gatedChat(lines);
  const task: CompanionClaudeTask = { kind: 'chat', model: 'sonnet', workingDirectory: '', writable: false, replyId: id,
    get prompt() { return buildCodexChatPrompt(outgoing(), messages); },
    session: { key: 'synthetic-conversation', basePersona: NAME, get persona() { return outgoing(); }, messages } };
  let streaming: Promise<unknown> | undefined;
  try {
    streaming = chat.stream(task, new AbortController().signal, turn.push);
    await starting;
    await whileStarting?.();
  } finally { open(); }
  try { await streaming; await turn.finish('complete'); }
  finally { chat.dispose(); }
  assert.equal(lines.length, 1, 'the turn goes out once');
  return { sent: sentText(lines[0]), built: settings.persona, same };
}

async function withTurnFixture(run: (service: CompanionService, listen: ListenTogether, now: number) => Promise<void>): Promise<void> {
  await withDirectory(async directory => {
    const service = new CompanionService(directory, () => {});
    const now = Date.now();
    const listen = listenHost(directory, now);
    try {
      await service.load();
      await service.context(CHARACTER, validateProvider({ kind: 'claude', baseUrl: '', model: 'sonnet' }), NAME);
      await run(service, listen, now);
    } finally { await listen.dispose(); await service.flush(); }
  });
}

test('control: with nothing deleted, the message carries the 一起听 block exactly as the turn was put together', async () => {
  await withTurnFixture(async (service, listen) => {
    const { sent, built, same } = await typedTurn(service, listen, NOW_SONG);
    assert.ok(same, 'nothing taken back: the check hands back the very persona it was given');
    assert.ok(listenBlock(built).includes(RAIN.gist), 'fixture: the question brought the song\'s note');
    assert.equal(listenBlock(sent), listenBlock(built), 'the block goes out byte for byte');
    assert.ok(!sent.includes(RAIN.raw), 'the note covers the words: no raw text');
  });
});

test('late window: a note deleted in the control window while the message waits for the Claude process does not go out', async () => {
  await withTurnFixture(async (service, listen) => {
    const { sent, built } = await typedTurn(service, listen, NOW_SONG, () => {
      listen.deleteNote(RAIN.note); // the control window's 删除 (registerListenTogetherIpc → deleteListenNote)
      assert.ok(listen.askContext(NOW_SONG).includes(RAIN.raw), 'fixture: asked afresh now, the song\'s raw words would come instead of the note');
    });
    assert.ok(built.includes(RAIN.gist) && built.includes(RAIN.point), 'fixture: the turn was put together with the note');
    assert.ok(!sent.includes(RAIN.gist) && !sent.includes(RAIN.point), 'the deleted note is not sent');
    assert.ok(!sent.includes(RAIN.raw), 'nothing is added late: the raw words the note stood for do not take its place');
    assert.ok(!sent.includes('【一起听】') && !sent.includes('external-audio-data'), 'the emptied block leaves nothing behind');
    assert.ok(sent.includes(HOST_LINE), 'what the host added after the block still goes out');
  });
});

test('late window: deleting another note meanwhile drops only that one; what is still there goes out as it was selected', async () => {
  await withTurnFixture(async (service, listen) => {
    const { sent, built } = await typedTurn(service, listen, PAST_SONG, () => { listen.deleteNote(SEA.note); });
    const before = listenItems(built), after = listenItems(sent);
    assert.equal(before.length, 2, 'fixture: the question brought both songs\' notes');
    assert.ok(!sent.includes(SEA.gist) && !sent.includes(SEA.point), 'the deleted note is not sent');
    assert.deepEqual(after, before.filter(item => JSON.stringify(item).includes(RAIN.gist)), 'the other note goes out exactly as selected');
  });
});

test('late window: 清空原文 meanwhile takes the raw words out of the block; her note of the song stays', async () => {
  await withTurnFixture(async (service, listen) => {
    const { sent, built } = await typedTurn(service, listen, NOW_LINE, () => { listen.clearRaw(); });
    assert.ok(built.includes(RAIN.raw) && built.includes(RAIN.gist), 'fixture: the song\'s note and its last words were in the turn');
    assert.ok(!sent.includes(RAIN.raw), 'the cleared raw words are not sent');
    assert.ok(sent.includes(RAIN.gist) && sent.includes(RAIN.point), 'the note was not deleted: it still goes out');
    assert.deepEqual(listenItems(sent), listenItems(built).map(item => { const { 最后一两分钟的原文: _raw, ...rest } = item; return rest; }));
  });
});

test('late window: 清空原文 meanwhile, on a show with only raw words: the whole block goes', async () => {
  await withTurnFixture(async (service, listen) => {
    const { sent, built } = await typedTurn(service, listen, NOW_SHOW, () => { listen.clearRaw(); });
    assert.ok(built.includes(SHOW.raw), 'fixture: the show\'s words were in the turn');
    assert.ok(!sent.includes(SHOW.raw) && !sent.includes('【一起听】'), 'the cleared words are not sent, and no empty block is left');
    assert.ok(sent.includes(HOST_LINE));
  });
});

test('late window: forgetting the character\'s memories meanwhile leaves no 一起听 block', async () => {
  await withTurnFixture(async (service, listen) => {
    const { sent, built } = await typedTurn(service, listen, PAST_SONG, () => { listen.core.forgetCharacter(CHARACTER); });
    assert.ok(built.includes(RAIN.gist) && built.includes(SEA.gist));
    assert.ok(!sent.includes('【一起听】') && !sent.includes(RAIN.gist) && !sent.includes(SEA.gist));
  });
});

test('askTurn: only drops, never adds; an ordinary message gets nothing; a persona without the block is left as it is', () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const core = new ListenTogetherCore({ kinds: { current: () => ({ kind: 'quiet', confidence: 1, since: now, revision: 1 }) }, characterId: () => CHARACTER,
    listening: () => true, note: async () => { throw new Error('no model'); }, save: async () => {}, now: () => now });
  core.load(listenFile(now));
  const ordinary = core.askTurn('今天晚上吃什么好呢');
  assert.equal(ordinary.block, '', 'not a question about what she heard');
  assert.equal(ordinary.current('人设'), '人设');
  const ask = core.askTurn(PAST_SONG);
  assert.equal(ask.block, core.askContext(PAST_SONG), 'the same block askContext gives (byte for byte)');
  const persona = '人设' + ask.block + '\n\n主机加的';
  assert.equal(ask.current(persona), persona, 'nothing taken back: the same string');
  // Meanwhile a third song's note lands (here: a reload with it) and the sea note goes: the sea note is dropped, the new one not added.
  const file = listenFile(now), third = note({ segment: 'seg-third', note: 'ln-seg-third', gist: '第三首合成歌的笔记', point: '只在第三首里的一点' }, 'music', now - 60 * MIN, now - 50 * MIN);
  core.load({ ...file, notes: [...file.notes.filter(n => n.id !== SEA.note), third] });
  const late = ask.current(persona);
  assert.ok(!late.includes(SEA.gist) && late.includes(RAIN.gist) && !late.includes(third.gist));
  assert.ok(late.startsWith('人设\n\n【一起听】') && late.endsWith('</external-audio-data>\n\n主机加的'));
  assert.equal(ask.current(persona), late, 'read again (a retry, the other getter): the same answer');
  assert.equal(ask.current('别的人设'), '别的人设', 'a persona without the block is left as it is');
  // Raw words only (the show): 清空原文 takes the whole block, and the blank line that joined it.
  const show = core.askTurn(NOW_SHOW), withShow = '人设' + show.block + '\n\n主机加的';
  assert.ok(show.block.includes(SHOW.raw));
  core.clearRaw();
  assert.equal(show.current(withShow), '人设\n\n主机加的');
});

test('画像: a profile entry deleted in the same window is not sent (the turn is cancelled, and its lease reads nothing)', async () => {
  for (const cancels of [true, false]) await withDirectory(async directory => {
    let context: UserProfileContext | undefined;
    const store = new UserProfileStore(directory, { now: () => 1000, onInvalidated: () => { context?.invalidate(); } });
    context = new UserProfileContext(store);
    try {
      await store.activate({ characterId: CHARACTER, providerScope: 'synthetic-provider' });
      store.setEnabled(true);
      const said = '我在阳台上种了一盆合成薄荷';
      const acceptance = store.acceptUserMessage({ requestId: 'p1', messageId: 'message-p1', source: 'text', acceptedAt: 1000, text: said });
      const ticket = store.beginObservation(acceptance); assert.ok(ticket);
      assert.deepEqual(await store.completeObservation(ticket, 'p1', [{ kind: 'fact', quoteStart: 0, quoteEnd: said.length }]), { status: 'saved', added: 1 });
      const question = '阳台上的薄荷长得怎么样了', messages: ChatMessage[] = [{ role: 'user', content: question }];
      // main.ts: the lease's cancel aborts the turn (cancels = true); the other case checks the lease alone.
      const controller = new AbortController();
      const lease = context.begin(question, () => { if (cancels) controller.abort(); return cancels; }, messages);
      assert.ok(lease && context.read(lease)?.includes(said), 'fixture: the turn carries the profile entry');
      const lines: string[] = [];
      const { chat, starting, open } = gatedChat(lines);
      const task: CompanionClaudeTask = { kind: 'chat', model: 'sonnet', workingDirectory: '', writable: false, replyId: 'p-turn', prompt: '',
        session: { key: 'synthetic-profile', basePersona: NAME, persona: NAME, messages, data: () => context!.read(lease) } };
      const streaming = chat.stream(task, controller.signal, () => {}).then(() => 'sent', () => 'stopped');
      await starting;
      const view = store.view();
      await store.deleteEntry(view.entries[0]!.id, view.revision);
      open();
      const outcome = await streaming;
      chat.dispose();
      if (cancels) { assert.equal(outcome, 'stopped'); assert.equal(lines.length, 0, 'the turn is cancelled: nothing is written'); }
      else { assert.equal(lines.length, 1); assert.ok(!sentText(lines[0]).includes('合成薄荷'), 'the lease reads nothing after the deletion'); }
    } finally { store.dispose(); }
  });
});

// electron/main.ts (syntax tree, no eval): the turn takes its block through askTurn, and both getters read it through the check.
test('electron/main.ts: the 一起听 block comes from askTurn and the prompt and session persona go through listenAsk.current', () => {
  const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const main = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const getters: Record<string, string[]> = { prompt: [], persona: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isGetAccessorDeclaration(node) && ts.isIdentifier(node.name) && node.name.text in getters
      && /turnFrames\.recompose/.test(node.body?.getText(main) ?? '')) getters[node.name.text].push(node.body!.getText(main));
    ts.forEachChild(node, visit);
  };
  visit(main);
  for (const [name, bodies] of Object.entries(getters)) {
    assert.equal(bodies.length, 1, `one ${name} getter on the typed chat path`);
    assert.match(bodies[0], /listenAsk\.current\(turn!\.withCurrentRecall\(turnFrames\.recompose\(/, name);
  }
  assert.match(source, /const listenAsk = listenTogether\?\.askTurn\(request\.messages\.at\(-1\)\?\.content, companion\?\.conversationId \?\? '', media\.state\.screenSharing === true\) \?\? NO_LISTEN_ASK;/); // I-047: and the conversation the window belongs to
  assert.match(source, /turn\.persona \+= listenAsk\.block;/);
  assert.doesNotMatch(source, /listenTogether\?\.askContext\(/, 'no turn takes the block without its check');
});
