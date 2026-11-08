// I-021 删除一致性, the late window (Codex T-222 phase 2, case E04, 2026-11-05; docs/claude/2026-11-05-recall-late-window.md).
// CompanionService.begin already recalls again when a note was deleted while the turn was being prepared (E02, covered in
// tests/memory-notes-delete.test.ts test 4). E04: the note is deleted AFTER the turn was put together, while its message waits
// for the Claude process to start; the old selection (the note's title and the original excerpt it picked) still went out.
// Here the turn runs through the real PersistentClaudeChat with a fake process (no CLI, no network, no model); every
// conversation is made up for the test and each test uses its own temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type { ChatMessage } from '../shared/contracts';
import type { MemoryRecall, MemoryScope } from '../shared/memory';
import type { MemoryNoteBody } from '../shared/memory-notes/interface';
import { MEMORY_NOTES_KNOBS } from '../shared/memory-notes/knobs';
import { FakeNoteWriter, fakeNoteBody } from '../shared/memory-notes/fake';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { CompanionService } from '../electron/companion';
import { MemoryStore } from '../electron/memory';
import { MemoryNotes } from '../electron/memory-notes/host';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/claude-session';
import type { ClaudeChatProcess } from '../electron/claude-process';
import { buildCodexChatPrompt, buildCompanionPersona, companionMemoryBlock, replaceMemoryBlock } from '../electron/conversation-context';
import { recallLateCheck } from '../electron/recall-late-check';
import { validateProvider } from '../electron/validation';
import { VoiceChatHost } from '../electron/voice-chat-host';
import { encodeWav } from '../src/ui/MediaInput';

const HOUR = 3_600_000;
const CHARACTER = 'synthetic-late-girl';
const NAME = '合成角色';
const MARKER = '只在笔记里出现的标题';
const QUERY = '那家店去了吗';
const RAMEN = { user: '学校旁边新开了一家拉面店，周末我想和朋友去尝尝', her: '听起来不错！去了记得告诉我味道怎么样～' };
const RAMEN_WORDS = '学校旁边新开了一家拉面店';
const MOVIE = { user: '昨天看了一部科幻电影，特效很震撼', her: '哇，是哪一部呀？我也想听你讲讲。' };
const MOVIE_NOTE: MemoryNoteBody = { title: '看了一部科幻电影', summary: '用户昨天看了一部科幻电影，觉得特效很震撼。', people: [], things: ['科幻电影', '特效'],
  mood: '兴奋', plans: [], tags: ['科幻电影', '电影', '特效', '看电影'] };

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-recall-late-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
async function chat(store: MemoryStore, scope: MemoryScope, id: string, user: string, her: string, at: number): Promise<string> {
  const handle = await store.beginTurn(scope, { id, userText: user, at, conversationId: `c-${id}` });
  await store.appendAssistant(scope, id, her, at + 1_000);
  await store.finishTurn(scope, id, 'complete', at + 2_000);
  await store.seal(scope);
  return handle.recordId;
}
/** Two old chats of the current character, each with her note; the ramen note's title is MARKER (it appears nowhere else). */
async function fixture(service: CompanionService, directory: string): Promise<{ notes: MemoryNotes; ramen: string; movie: string; scope: MemoryScope }> {
  const scope = service.currentScope();
  const ramen = await chat(service.memory, scope, 'ramen', RAMEN.user, RAMEN.her, Date.now() - 3 * HOUR);
  const movie = await chat(service.memory, scope, 'movie', MOVIE.user, MOVIE.her, Date.now() - 2 * HOUR);
  assert.deepEqual(service.memory.retrieve(scope, QUERY), [], 'fixture: without her notes the question finds nothing');
  const clock = { t: Date.now() };
  const writer = new FakeNoteWriter('不是 JSON').when('拉面店', fakeNoteBody({ title: MARKER })).when('科幻电影', MOVIE_NOTE);
  const notes = new MemoryNotes({ directory, archive: service.memory, write: writer.write, userBusy: () => false, modelBusy: () => false,
    lastActivityAt: () => null, scope: () => service.currentScope(), now: () => clock.t, tickMs: 3_600_000 });
  await notes.start();
  clock.t += MEMORY_NOTES_KNOBS.pace.startDelaySeconds * 1000;
  for (let i = 0; i < 6; i++) { clock.t += MEMORY_NOTES_KNOBS.pace.spacingSeconds * 1000; notes.core.tick(); await settle(); }
  await notes.core.flush();
  assert.equal(notes.state(ramen).status, 'written');
  assert.equal(notes.state(movie).status, 'written');
  assert.equal(service.memory.retrieve(scope, QUERY)[0]?.id, ramen, 'fixture: with the note, the question recalls the ramen chat');
  return { notes, ramen, movie, scope };
}

/** A stand-in for the Claude Code process (no CLI, no network): keeps every message line it is handed and answers one short line. */
function fakeProcess(lines: string[]): ClaudeChatProcess {
  const process = {
    model: 'sonnet', turnsStarted: 0, alive: true, busy: false,
    settled: async () => {}, close: () => { process.alive = false; }, supersede: () => false,
    runTurn: async (line: string, _signal: AbortSignal, emit: (type: 'delta', text: string) => void) => {
      lines.push(line); process.turnsStarted++;
      emit('delta', '嗯。');
      return { output: '嗯。', superseded: false };
    },
  };
  return process as unknown as ClaudeChatProcess;
}
/** A persistent Claude chat whose process start waits for `gate`; `starting` resolves when the start began (the turn waits there). */
function gatedChat(lines: string[]) {
  const starting = deferred<void>(), gate = deferred<void>();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => 'claude',
    startProcess: async () => { starting.resolve(); await gate.promise; return fakeProcess(lines); } });
  return { chat, starting: starting.promise, open: () => gate.resolve(undefined) };
}

/** The text of one message line written to Claude Code's stdin. */
function sentText(line: string): string {
  const content = JSON.parse(line).message.content as string | { type: string; text?: string }[];
  return typeof content === 'string' ? content : content.map(block => block.text ?? '').join('');
}
/** The recalled memories inside a persona or a sent message ([] when it carries none). */
function memoriesIn(text: string): { title: string; createdAt: string; excerpt: string }[] {
  const start = text.indexOf('<private-memory-data>\n');
  if (start < 0) return [];
  return JSON.parse(text.slice(start + '<private-memory-data>\n'.length, text.indexOf('\n</private-memory-data>', start)));
}

/**
 * One ordinary typed chat turn on the Claude path, wired the way electron/main.ts hands it over: the prompt and the session's
 * persona are getters read where the message is written, after the process has started (the last test holds main.ts to it).
 * `whileStarting` runs after the turn was put together, while its message waits for the process.
 */
async function typedTurn(service: CompanionService, id: string, whileStarting?: () => Promise<void>): Promise<{ sent: string[]; built: string; same: boolean }> {
  const turn = await service.begin(id, QUERY, NAME, () => {});
  const settings = { persona: turn.persona + '\n\n（主机在这一轮后面加的一行）' }; // main.ts: settings.persona = turn.persona, once the host's lines are added
  let same = true;
  const messages: ChatMessage[] = [{ role: 'user', content: QUERY }];
  const lines: string[] = [];
  const { chat, starting, open } = gatedChat(lines);
  const outgoing = () => { const value = turn.withCurrentRecall(settings.persona); same &&= value === settings.persona; return value; };
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
  return { sent: lines.map(sentText), built: settings.persona, same };
}

test('control: with nothing deleted, the message carries the recalled chat exactly as the turn was put together', async () => {
  await withDirectory(async directory => {
    const service = new CompanionService(directory, () => {});
    let notes: MemoryNotes | null = null;
    try {
      await service.load();
      await service.context(CHARACTER, validateProvider({ kind: 'claude', baseUrl: '', model: 'sonnet' }), NAME);
      ({ notes } = await fixture(service, directory));
      const { sent, built, same } = await typedTurn(service, 'control-turn');
      assert.equal(sent.length, 1);
      assert.ok(same, 'nothing taken back: the check hands back the very persona it was given (byte for byte)');
      const memories = memoriesIn(sent[0]);
      assert.ok(memories.some(memory => memory.title === MARKER && memory.excerpt.includes(RAMEN_WORDS)), 'the note\'s title and the original excerpt go out');
      assert.deepEqual(memories, memoriesIn(built), 'exactly what begin() selected');
    } finally { await notes?.dispose(); await service.flush(); }
  });
});

test('E04: a note deleted after the turn was put together, while its message waits for the Claude process, does not go out with it', async () => {
  await withDirectory(async directory => {
    const service = new CompanionService(directory, () => {});
    let notes: MemoryNotes | null = null;
    try {
      await service.load();
      await service.context(CHARACTER, validateProvider({ kind: 'claude', baseUrl: '', model: 'sonnet' }), NAME);
      const made = await fixture(service, directory);
      notes = made.notes;
      const { sent, built } = await typedTurn(service, 'late-turn', async () => {
        assert.equal((await made.notes.deleteNote(made.ramen)).status, 'deleted');
        assert.ok(!service.memory.retrieve(made.scope, QUERY).some(memory => memory.id === made.ramen), 'fixture: recall no longer finds it');
      });
      assert.ok(memoriesIn(built).some(memory => memory.title === MARKER), 'fixture: the turn was put together with the note');
      assert.equal(sent.length, 1, 'the turn still goes out');
      assert.ok(!sent[0].includes(MARKER), 'the deleted note\'s title is not sent');
      assert.ok(!sent[0].includes(RAMEN_WORDS), 'nor the excerpt only the deleted note had picked');
      assert.ok(!sent[0].includes('<private-memory-data>'), 'the emptied memories block leaves nothing behind');
      assert.ok(sent[0].includes('（主机在这一轮后面加的一行）'), 'what the host added after the turn still goes out');
      assert.ok(service.memory.read(made.scope, made.ramen), 'the chat itself stays in the archive (only the note was deleted)');
    } finally { await notes?.dispose(); await service.flush(); }
  });
});

test('E04: deleting another note meanwhile drops nothing that is still recalled', async () => {
  await withDirectory(async directory => {
    const service = new CompanionService(directory, () => {});
    let notes: MemoryNotes | null = null;
    try {
      await service.load();
      await service.context(CHARACTER, validateProvider({ kind: 'claude', baseUrl: '', model: 'sonnet' }), NAME);
      const made = await fixture(service, directory);
      notes = made.notes;
      const { sent, built } = await typedTurn(service, 'unrelated-turn', async () => {
        assert.equal((await made.notes.deleteNote(made.movie)).status, 'deleted');
      });
      assert.equal(sent.length, 1);
      assert.ok(memoriesIn(sent[0]).some(memory => memory.title === MARKER && memory.excerpt.includes(RAMEN_WORDS)));
      assert.deepEqual(memoriesIn(sent[0]), memoriesIn(built), 'the ramen chat goes out as it was selected');
    } finally { await notes?.dispose(); await service.flush(); }
  });
});

async function until(check: () => boolean): Promise<void> {
  const end = performance.now() + 5000;
  while (!check() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'timed out waiting');
}

test('E04, voice: the same late window on a spoken sentence, through the real voice host', async () => {
  await withDirectory(async directory => {
    const service = new CompanionService(directory, () => {});
    let notes: MemoryNotes | null = null, voice: VoiceChatHost | null = null;
    const lines: string[] = [];
    const { chat, starting, open } = gatedChat(lines);
    try {
      await service.load();
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.provider = validateProvider({ kind: 'claude', baseUrl: '', model: 'sonnet' }); settings.voice.enabled = true; settings.persona = NAME;
      await service.context(CHARACTER, settings.provider, NAME);
      const made = await fixture(service, directory);
      notes = made.notes;
      const pending = new Map<string, AbortController>(), finals = [QUERY];
      voice = new VoiceChatHost({
        broadcast: () => {}, memoryChanged() {},
        windowVisible: sender => sender === 77, media: () => ({ voiceInput: true, voiceOwner: 'controls' }), turnOffVoiceInput() {},
        speechScope: () => 'fixture-context', settings: () => settings, companion: () => service, ambient: () => null,
        reserveChat: (replyId, controller) => { if (pending.size) return false; pending.set(replyId, controller); return true; },
        releaseChat: replyId => { pending.delete(replyId); }, userTurn() {}, activityChanged() {}, cancelProactive() {},
        claude: chat, languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
        transcribe: async () => finals.shift()!, stopReading() {}, prepareSpeech() {},
      });
      const binding = voice.open(77, 'controls');
      assert.equal(voice.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: 1, wav: encodeWav(new Float32Array(4096).fill(0.1)) }).state, 'queued');
      await starting; // the leg was put together (its recall made) and waits for the process
      assert.equal((await made.notes.deleteNote(made.ramen)).status, 'deleted');
      open();
      await until(() => lines.length === 1);
      const sent = sentText(lines[0]);
      assert.ok(!sent.includes(MARKER), 'the deleted note\'s title is not sent');
      assert.ok(!sent.includes(RAMEN_WORDS), 'nor the excerpt only the deleted note had picked');
    } finally {
      open();
      voice?.dispose(); await new Promise<void>(resolve => setImmediate(resolve)); await voice?.drain();
      chat.dispose(); await notes?.dispose(); await service.flush().catch(() => {});
    }
  });
});

test('E04, voice control: with nothing deleted, the spoken sentence carries the recalled chat', async () => {
  await withDirectory(async directory => {
    const service = new CompanionService(directory, () => {});
    let notes: MemoryNotes | null = null, voice: VoiceChatHost | null = null;
    const lines: string[] = [];
    const { chat, starting, open } = gatedChat(lines);
    try {
      await service.load();
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.provider = validateProvider({ kind: 'claude', baseUrl: '', model: 'sonnet' }); settings.voice.enabled = true; settings.persona = NAME;
      await service.context(CHARACTER, settings.provider, NAME);
      ({ notes } = await fixture(service, directory));
      const pending = new Map<string, AbortController>(), finals = [QUERY];
      voice = new VoiceChatHost({
        broadcast: () => {}, memoryChanged() {},
        windowVisible: sender => sender === 77, media: () => ({ voiceInput: true, voiceOwner: 'controls' }), turnOffVoiceInput() {},
        speechScope: () => 'fixture-context', settings: () => settings, companion: () => service, ambient: () => null,
        reserveChat: (replyId, controller) => { if (pending.size) return false; pending.set(replyId, controller); return true; },
        releaseChat: replyId => { pending.delete(replyId); }, userTurn() {}, activityChanged() {}, cancelProactive() {},
        claude: chat, languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
        transcribe: async () => finals.shift()!, stopReading() {}, prepareSpeech() {},
      });
      const binding = voice.open(77, 'controls');
      voice.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: 1, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
      await starting;
      open();
      await until(() => lines.length === 1);
      assert.ok(memoriesIn(sentText(lines[0])).some(memory => memory.title === MARKER && memory.excerpt.includes(RAMEN_WORDS)));
    } finally {
      open();
      voice?.dispose(); await new Promise<void>(resolve => setImmediate(resolve)); await voice?.drain();
      chat.dispose(); await notes?.dispose(); await service.flush().catch(() => {});
    }
  });
});

test('recallLateCheck: only drops, never adds; nothing recalled stays nothing; a store it cannot read sends no memories', () => {
  const at = Date.UTC(2026, 10, 1);
  const memory = (id: string, title: string, excerpt: string) => ({ id, title, excerpt, createdAt: at, updatedAt: at, tags: [] }) as unknown as MemoryRecall;
  const a = memory('a', '合成甲', '甲的原文'), b = memory('b', '合成乙', '乙的原文'), c = memory('c', '合成丙', '丙的原文');
  const persona = (memories: MemoryRecall[]) => buildCompanionPersona({ persona: '人设', stateContext: '心情', memories, protocolInstruction: '协议' }) + '\n\n主机加的';
  let revision = '1.0', now: () => MemoryRecall[] = () => [a, b], recalls = 0;
  const options = (recalled: MemoryRecall[]) => ({ recalled, revision: '1.0', currentRevision: () => revision, recallNow: () => { recalls++; return now(); } });

  const kept: MemoryRecall[][] = [];
  const check = recallLateCheck({ ...options([a, b]), changed: next => { kept.push(next); } });
  const built = persona([a, b]);
  assert.equal(check(built), built, 'revision unchanged: the same string');
  assert.equal(recalls, 0, 'and no recall');
  revision = '1.1'; now = () => [b, c];
  assert.equal(check(built), persona([b]), 'a is dropped; c, new since, is not added');
  assert.deepEqual(kept, [[b]], 'told once');
  assert.equal(check(built), persona([b]), 'read again (a retry, the other getter): the same answer');
  assert.equal(recalls, 1, 'without recalling again');
  revision = '1.2'; now = () => { throw new Error('synthetic store failure'); };
  const none = check(built);
  assert.equal(none, persona([]), 'cannot check: no memories, and the blank line that joined them goes too');
  assert.ok(none.endsWith('协议\n\n主机加的') && !none.includes('\n\n\n'));

  const empty = recallLateCheck(options([]));
  revision = '2.0'; now = () => [c];
  assert.equal(empty(persona([])), persona([]), 'nothing was recalled: nothing is added late');
  assert.equal(replaceMemoryBlock('人设', companionMemoryBlock([a]), ''), '人设', 'a persona without the block is left as it is');
});

// electron/main.ts (syntax tree, no eval): the typed chat's prompt and session persona getters go through the turn's check.
test('electron/main.ts: the prompt and the session persona handed to Claude are read through turn.withCurrentRecall', () => {
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
    assert.match(bodies[0], /withCurrentRecall\(turnFrames\.recompose\(/, name);
  }
});
