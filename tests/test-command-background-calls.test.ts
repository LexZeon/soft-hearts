/**
 * T-205 第二轮 P1b (docs/claude/2026-11-04-unexplained-request.md). In an isolated Electron dev build Codex sent the three pose
 * test texts in normal mode (ordinary chat), turned developer mode on and sent them twice more as commands; during that window
 * the fake Claude got one more request with no current user text and no image, from a second process, source not found.
 *
 * This replays the sequence on a host assembly wired the way electron/main.ts wires it: the real CompanionService (mood, pose
 * reactions, her life, her needs), the real test commands, the real inner loop host and cue claim, the real chat availability,
 * the outage-line scheduler with its production delay, and the chat object. Every model seam records the call's source and its
 * field names only (never the text), and a spawn guard refuses and counts any Claude Code launch that bypassed a seam (the test
 * command's own model pick has no seam in the wiring; the guard is what would see it). Nothing real is ever started.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { CompanionService } from '../electron/companion';
import { ChatAvailability } from '../electron/chat-availability';
import { createChatOutage } from '../electron/chat-outage';
import { CLAUDE_CHAT_SYSTEM_PROMPT, streamClaude, type ClaudeTask } from '../electron/claude';
import { PersistentClaudeChat } from '../electron/claude-session';
import { buildCodexChatPrompt } from '../electron/conversation-context';
import { createInnerLoopHost, type InnerLoopHost } from '../electron/inner-loop/host';
import { decideWithClaude } from '../electron/inner-loop/model';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { createTestCommands } from '../electron/test-commands/wiring';
import { INNER_LOOP_SYSTEM_PROMPT } from '../shared/inner-loop';
import type { TestCommandNote } from '../shared/test-command';
import { readConversation } from '../scripts/lib/claude-smoke-fixture.mjs';

/** The exact texts of the P1b trial card (Codex T-205 round 002). */
const COMMANDS = ['测试：我冲你挥手', '测试：我打了个哈欠', '测试：我伸了个懒腰'] as const;
/** A synthetic card text: no real character is used here. */
const PERSONA = '合成测试角色：说话简短、温和。';
/**
 * The chat connection. Codex's fixture profile chats with haiku (FIXTURE_CLAUDE_MODEL), the inner loop's fixed tier too, so the
 * model could not tell the two apart there; here the chat model is another alias, so it can.
 */
const PROVIDER = { kind: 'claude', model: 'sonnet' } as const;
/** Codex's fake answered every turn with this one sentence (not valid outage lines, not a valid inner-loop decision). */
const REPLY = '这是合成测试回复。';
const START = Date.UTC(2026, 10, 4, 4, 0, 0);
const PET = 7;

/** One model call as the test keeps it: where it came from and what it carried, by name and count only. */
interface Call {
  source: 'chat' | 'outage' | 'inner-loop';
  /** Seconds since the first message. */
  at: number;
  fields: string[];
  model: string;
  systemPrompt: 'chat' | 'inner-loop' | 'default' | 'other';
  images: number;
  /** What the smoke fixture reads from the prompt: an ordinary chat turn's currentUser, or none (Codex's "currentUser: null"). */
  currentUser: 'command text' | 'other text' | null;
}

const drain = async (turns = 25) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };
/**
 * Waits in real time (timers and Date are virtual here) for file work the hosts started: the test-command log line, the outage
 * bank's attempt record before its call. Virtual time does not move meanwhile, so a call's recorded second stays its own.
 */
async function untilReal(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!await check()) {
    if (performance.now() > end) assert.fail('timed out waiting');
    await new Promise(resolve => setImmediate(resolve));
  }
}

const childProcess = createRequire(import.meta.url)('node:child_process');

/** Refuses (and counts) every Claude Code launch; anything else passes through. */
function installSpawnGuard(placeholder: string) {
  const launches: { model: string | null; cwd: string | null }[] = [];
  const original = childProcess.spawn;
  childProcess.spawn = function guarded(this: unknown, file: unknown, args: unknown, options: { cwd?: unknown } | undefined) {
    const list = Array.isArray(args) ? args.filter((value): value is string => typeof value === 'string') : [];
    const name = path.basename(String(file)).toLowerCase();
    const claudeLike = String(file) === placeholder || /^claude(?:\.(?:exe|cmd|bat|ps1))?$/u.test(name) || list.includes('--strict-mcp-config');
    if (!claudeLike) return Reflect.apply(original, this, arguments);
    launches.push({ model: list.includes('--model') ? list[list.indexOf('--model') + 1] : null, cwd: typeof options?.cwd === 'string' ? options.cwd : null });
    throw Object.assign(new Error('test guard: no Claude Code launch in this test'), { code: 'EACCES' });
  };
  syncBuiltinESMExports();
  return {
    launches,
    async restore() {
      childProcess.spawn = original;
      syncBuiltinESMExports();
      // streamClaude made an empty throwaway folder before the refused launch; remove exactly those.
      for (const { cwd } of launches) if (cwd && path.basename(cwd).startsWith('turn-') && cwd.includes('claude-chat')) await rm(cwd, { recursive: true, force: true });
    },
  };
}

function systemPromptLabel(task: ClaudeTask): Call['systemPrompt'] {
  if (task.systemPrompt === undefined) return 'default';
  if (task.systemPrompt === CLAUDE_CHAT_SYSTEM_PROMPT) return 'chat';
  if (task.systemPrompt === INNER_LOOP_SYSTEM_PROMPT) return 'inner-loop';
  return 'other';
}

async function assemble(t: TestContext) {
  // Virtual time for every timer and clock the hosts read (the outage scheduler keeps its production 30 s delay).
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-p1b-calls-'));
  const placeholder = path.join(directory, 'claude-placeholder.exe');
  await writeFile(placeholder, 'not a program\n');
  const previousClaudePath = process.env.CLAUDE_PATH;
  process.env.CLAUDE_PATH = placeholder;
  const guard = installSpawnGuard(placeholder);

  const calls: Call[] = [];
  let firstMessageAt: number | null = null;
  const record = (source: Call['source'], task: ClaudeTask) => {
    const fields: string[] = [];
    for (const key in task) fields.push(key); // the chat path's task inherits its fields (claude-session.ts perMessage)
    const conversation = readConversation(task.prompt);
    calls.push({ source, at: (Date.now() - (firstMessageAt ?? START)) / 1000, fields: fields.sort(), model: task.model,
      systemPrompt: systemPromptLabel(task), images: task.imageDataUrls?.length ?? 0,
      currentUser: conversation ? ((COMMANDS as readonly string[]).includes(conversation.currentUser) ? 'command text' : 'other text') : null });
  };

  // electron/main.ts: userInputUntil, the chat in flight, the shared proactive-speech gate, the app-wide availability.
  const app = { userInputUntil: 0, chatting: false };
  const gate = new ProactiveSpeechGate();
  const availability = new ChatAvailability();
  const canExpress = () => Date.now() >= app.userInputUntil && !gate.busy && !app.chatting;
  let innerLoopHost: InnerLoopHost | null = null;
  const service = new CompanionService(directory, view => {
    try { gate.setScope(`p1b:${view.token}`); } catch { gate.cancel('context'); }
    if (view.snapshot.phase !== 'idle') app.userInputUntil = Date.now() + 15_000;
    // One cue, one owner (main.ts, I-020 #10 opening choice): memorial, R20 and screen chat are off here, audio needs a source.
    innerLoopHost?.opening.claim(view.snapshot.cue, {
      memorial: () => false, r20: () => false, vision: () => false,
      ambient: cue => cue.kind === 'speech' && cue.source !== undefined,
    }, view);
  });
  innerLoopHost = createInnerLoopHost({
    gate, setting: () => true, expressions: () => service.mood.get().expressions,
    canExpress: () => canExpress() && availability.isAvailable(),
    current: () => Date.now() >= app.userInputUntil && service.mood.get().snapshot.phase === 'idle' && !app.chatting,
    characterId: () => service.mood.get().characterId, gateScope: () => `p1b:${service.mood.get().token}`,
    parameters: () => service.mood.get().parameters, fatiguePhase: () => service.mood.get().fatigue?.phase,
    needReady: id => service.herNeeds.hasSpeechChance(id),
    context: { persona: () => PERSONA, language: () => '', mood: () => service.mood.chatContext(),
      lastInteractionAt: () => service.mood.get().snapshot.lastInteractionAt,
      userState: () => service.userState.innerLoopContext(service.mood.get().characterId), pose: () => service.pose.innerLoopLine(),
      activity: () => service.herLife.view(service.mood.get().characterId), need: () => service.herNeeds.speechChance(service.mood.get().characterId),
      profileEnabled: () => false, profilePoints: () => '', audioReading: () => false, ambientText: () => '' },
    // The real adapter (model tier, system prompt, task shape) with a recording stream in place of Claude Code.
    decide: (prompt, signal) => decideWithClaude(prompt, signal, async (task, _signal, emit) => { record('inner-loop', task); emit('delta', REPLY); return null; }),
    realize: (claim, kind, id) => service.mood.event({ type: 'attention', id, kind, claimed: { id: claim.id, kind: claim.kind, at: claim.at } }, claim.characterId),
    releaseSpeech: claim => service.mood.releaseSpeech({ id: claim.id, at: claim.at }, claim.characterId),
    offer: () => false, cancelOffer: () => {}, surface: () => null, presentationIdentity: () => 'p1b', archive: async () => {},
    developerMode: () => service.mood.get().developerMode, diagnosticsFile: () => null, diagnosticsChanged: () => {},
    report: availability,
  });
  // X2: her lines for chat outages, prepared once per card while chat works (main.ts createChatOutage, default delay).
  const outage = createChatOutage({ availability, directory: () => directory, provider: () => PROVIDER, persona: () => PERSONA,
    chatBusy: () => app.chatting, publish: () => {}, openExternal: () => {},
    run: async (task, _signal, emit) => { record('outage', task); emit('delta', REPLY); } });
  await outage.load();
  const chat = new PersistentClaudeChat({ enabled: false, availability,
    perMessage: async (task, _signal, emit) => { record('chat', task); emit('delta', REPLY); } });
  const notes: TestCommandNote[] = [];
  const commands = createTestCommands({
    companion: () => service, innerLoop: () => innerLoopHost!.loop,
    rps: () => ({ testInvite: () => false, testStart: () => false, active: false }) as never, diary: () => undefined, innerLoopOn: () => true,
    gate: () => ({ petVisible: true, dragging: false, userTyping: Date.now() < app.userInputUntil, speaking: gate.busy, chatting: app.chatting,
      playing: false, claudeAvailable: availability.isAvailable(), idle: service.mood.get().snapshot.phase === 'idle' }),
    note: (_owner, note) => { notes.push(note); }, effect: () => {}, expression: () => true, action: async () => ({ status: 'played', missing: [], detail: '' }), directory: () => directory,
  });
  service.mood.activate('gene');
  // The one-second mood tick (main.ts moodTimer).
  const moodTimer = setInterval(() => {
    innerLoopHost!.loop.sweep();
    const can = canExpress();
    service.mood.tick(can, { allowGenericSpeech: true });
    service.herLifeTick(can);
  }, 1_000);

  /** The pet window's send (src/main.ts sendChat): a developer-mode "测试：…" goes to the host first; anything else is chat. */
  async function send(text: string): Promise<'command' | 'chat'> {
    if (commands.accept(PET, text).handled) { await drain(); return 'command'; }
    firstMessageAt ??= Date.now();
    app.userInputUntil = Date.now() + 15_000; // noteUserInput
    gate.cancel('user');
    app.chatting = true;
    try {
      await chat.stream({ kind: 'chat', model: PROVIDER.model, workingDirectory: directory, writable: false,
        prompt: buildCodexChatPrompt(PERSONA, [{ role: 'user', content: text }]), imageDataUrls: [], replyId: randomUUID() },
      new AbortController().signal, () => {});
    } finally { app.chatting = false; }
    await drain();
    return 'chat';
  }
  async function advance(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 1_000) { t.mock.timers.tick(Math.min(1_000, left)); await drain(); }
  }
  async function close(): Promise<void> {
    clearInterval(moodTimer);
    commands.dispose(); innerLoopHost!.loop.dispose(); outage.dispose(); chat.dispose(); gate.dispose();
    t.mock.timers.reset();
    await service.flush().catch(() => {});
    await outage.bank.flush();
    await guard.restore();
    if (previousClaudePath === undefined) delete process.env.CLAUDE_PATH; else process.env.CLAUDE_PATH = previousClaudePath;
    await rm(directory, { recursive: true, force: true });
  }
  const diagnostics = async () => (await readFile(path.join(directory, 'dev', 'test-commands.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as { entry: string; via: string });
  return { service, calls, notes, guard, send, advance, close, diagnostics, sinceFirst: () => (Date.now() - (firstMessageAt ?? START)) / 1000 };
}

test('the spawn guard sees a Claude Code launch that bypasses every seam (so "no launch" below means something)', async t => {
  const h = await assemble(t);
  try {
    await assert.rejects(streamClaude({ kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, prompt: '.', imageDataUrls: [] },
      new AbortController().signal, () => {}), /test guard/u);
    assert.deepEqual(h.guard.launches.map(launch => launch.model), ['haiku']);
  } finally { await h.close(); }
});

test('T-205 P1b replay: the extra request is X2 preparing her outage lines 30 s after chat first worked, not the test commands', async t => {
  const h = await assemble(t);
  try {
    // 1. Normal mode: the three card texts are ordinary chat, one turn each, with the text as currentUser (Codex: 3 turns).
    for (const text of COMMANDS) { assert.equal(await h.send(text), 'chat'); await h.advance(2_000); }
    assert.deepEqual(h.calls.map(call => [call.source, call.currentUser, call.images]), COMMANDS.map(() => ['chat', 'command text', 0]));
    // 2. Developer mode on (automatic expressions are on), Codex's 1.8 s pause, then wave / yawn / stretch twice, a cue apart.
    h.service.mood.setDeveloperMode(true);
    await h.advance(1_800);
    const atDeveloper = h.calls.length;
    for (const text of [...COMMANDS, ...COMMANDS]) {
      const before = h.calls.length;
      assert.equal(await h.send(text), 'command');
      assert.equal(h.calls.length, before, 'a command itself asks nothing');
      await h.advance(4_000);
      if (h.sinceFirst() < 30) assert.equal(h.calls.length, atDeveloper, 'nothing else before the 30 s mark');
    }
    assert.ok(h.sinceFirst() > 30, 'the window ends after the 30 s mark, as Codex\'s did');

    // Each command answered locally with its one note: no chat, no model pick (Codex: notes 1..6, fakeChatDelta 0).
    assert.equal(h.notes.length, 6);
    assert.ok(h.notes.every(note => /测试：假装摄像头看到你/u.test(note.text)), 'only the pose notes, no "请 Claude 帮忙找入口"');
    await untilReal(async () => (await h.diagnostics()).length >= 6);
    assert.deepEqual((await h.diagnostics()).map(line => line.via), Array(6).fill('local'));

    // The one request in the developer window: the X2 outage lines, with Codex's exact signature. (The bank writes its attempt
    // record before the call; that file write runs in real time, so wait for it rather than for more virtual seconds.)
    await untilReal(() => h.calls.length > atDeveloper);
    const during = h.calls.slice(atDeveloper);
    t.diagnostic(`calls in the developer window: ${JSON.stringify(during)}`);
    assert.equal(during.length, 1);
    const [extra] = during;
    assert.equal(extra.source, 'outage');
    assert.equal(extra.currentUser, null, 'no <conversation-data>: the fixture reads currentUser null');
    assert.equal(extra.images, 0);
    assert.equal(extra.model, PROVIDER.model, 'the chat model, not the inner loop\'s fixed haiku');
    assert.notEqual(extra.model, 'haiku');
    assert.equal(extra.systemPrompt, 'default');
    assert.deepEqual(extra.fields, ['imageDataUrls', 'kind', 'model', 'prompt', 'workingDirectory', 'writable']);
    assert.ok(extra.at >= 30 && extra.at <= h.sinceFirst(), `at the 30 s mark after the first chat worked (was ${extra.at} s)`);
    assert.equal(h.calls.filter(call => call.source === 'inner-loop').length, 0, 'no inner-loop opportunity in a fresh mood');
    assert.equal(h.guard.launches.length, 0, 'nothing bypassed a seam');

    // 3. Once per card: later working chats do not ask again (the fake's answer was not valid lines: next try after 6 h).
    await h.advance(3 * 60_000);
    assert.equal(await h.send('普通的一句话'), 'chat');
    await h.advance(60_000);
    assert.equal(h.calls.filter(call => call.source === 'outage').length, 1);
    assert.equal(h.guard.launches.length, 0);
  } finally { await h.close(); }
});

test('developer mode from the start: the pose test commands (all five) only play on the stage and ask no model at all', async t => {
  const h = await assemble(t);
  try {
    h.service.mood.setDeveloperMode(true);
    await h.advance(2_000);
    for (const text of [...COMMANDS, '测试：我坐了很久', '测试：我回到电脑前', ...COMMANDS]) {
      assert.equal(await h.send(text), 'command');
      await h.advance(4_000);
    }
    await h.advance(2 * 60_000);
    assert.equal(h.notes.length, 8);
    await untilReal(async () => (await h.diagnostics()).length >= 8);
    assert.deepEqual((await h.diagnostics()).map(line => line.via), Array(8).fill('local'));
    assert.deepEqual(h.calls, [], 'no chat, no outage lines (chat never worked), no inner loop');
    assert.deepEqual(h.guard.launches, [], 'and no launch past any seam');
  } finally { await h.close(); }
});
