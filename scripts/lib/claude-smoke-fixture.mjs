// Synthetic Claude Code for the maintainer-only source smokes (scripts/*-smoke.mjs other than scripts/smoke.mjs).
// Same isolation rules as the packaging smoke (scripts/smoke.mjs + smoke-isolation.mjs):
//   - CODEX_PATH names a file that must not exist, CODEX_HOME is an empty owned folder;
//   - CLAUDE_PATH is an inert owned placeholder and CLAUDE_CONFIG_DIR an empty owned folder, so even a wrongly
//     started real CLI would find no login;
//   - only the interposer this module installs into the app's main process (after launch) turns the app's own
//     Claude Code launch into the relay fake (fake-claude-relay.mjs); every other Claude Code launch is refused.
// Each chat turn the app sends reaches `respond(turn)` here, in the smoke runner, which streams that smoke's
// synthetic reply. Importing this module starts nothing.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOLLOW_UP_MARKER } from './fake-claude.mjs';
import { FAKE_CLAUDE_RELAY_MARKER, RELAY_FILE } from './fake-claude-relay.mjs';
import { CLAUDE_PLACEHOLDER_TEXT, installClaudeInterposer } from './smoke-isolation.mjs';

/** The alias the synthetic profiles select (Claude-only edition: no address, no key). */
export const FIXTURE_CLAUDE_MODEL = 'haiku';
/** Source smokes switch characters and conversations often; each switch may start a new Claude Code process. */
export const FIXTURE_MAX_SPAWNS = 64;
const relayScript = fileURLToPath(new URL('./fake-claude-relay.mjs', import.meta.url));

/** A Claude chat connection for a synthetic profile's settings.json. */
export function fixtureClaudeProvider(model = FIXTURE_CLAUDE_MODEL) { return { kind: 'claude', model }; }

/**
 * The child environment: `base` minus every inherited Claude/Codex variable and ELECTRON_RUN_AS_NODE, plus the
 * owned Codex sentinel, Claude placeholder and empty Claude config folder.
 */
export function isolatedClaudeEnvironment(base, owned) {
  for (const key of ['codexHome', 'sentinel', 'claudeHome', 'claudePlaceholder']) assert.equal(typeof owned?.[key], 'string', 'Owned child path required: ' + key);
  const env = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    const upper = key.toUpperCase();
    if (value === undefined || upper.startsWith('CLAUDE') || upper.startsWith('CODEX_') || upper === 'ELECTRON_RUN_AS_NODE') continue;
    env[key] = value;
  }
  return { ...env, CODEX_HOME: owned.codexHome, CODEX_PATH: owned.sentinel, CLAUDE_PATH: owned.claudePlaceholder, CLAUDE_CONFIG_DIR: owned.claudeHome };
}

/** The app's `<conversation-data>` block (electron/conversation-context.ts buildCodexChatPrompt), with the history, or null. */
export function readConversation(text) {
  if (typeof text !== 'string') return null;
  const start = text.lastIndexOf('<conversation-data>\n'), end = text.lastIndexOf('\n</conversation-data>');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(text.slice(start + '<conversation-data>\n'.length, end));
    if (!data || typeof data.currentUser !== 'string' || !Array.isArray(data.history)) return null;
    return { opening: !text.startsWith(FOLLOW_UP_MARKER), currentUser: data.currentUser, history: data.history };
  } catch { return null; }
}

// buildCodexChatPrompt puts the (composed) persona first, then this fixed instruction and the conversation data.
const CONVERSATION_INSTRUCTION = '\n\n以下JSON是普通聊天输入';
/**
 * The text before the conversation data: on an opening turn the composed persona (character persona + this turn's
 * mood/memory/protocol context); on a follow-up the follow-up header + this turn's context only.
 */
export function personaPart(text) {
  if (typeof text !== 'string') return '';
  const end = text.lastIndexOf(CONVERSATION_INSTRUCTION);
  return end >= 0 ? text.slice(0, end) : text.slice(0, Math.max(0, text.lastIndexOf('<conversation-data>')));
}

function createTurn(fixture, connection, message) {
  const conversation = readConversation(message.text);
  const controller = new AbortController();
  const listeners = [];
  let finished = false, cancelReason = null, settle;
  const closed = new Promise(resolve => { settle = resolve; });
  const send = value => { if (!connection.socket.destroyed) connection.socket.write(JSON.stringify({ ...value, seq: message.seq }) + '\n'); };
  const open = () => !finished && !cancelReason;
  const turn = {
    /** 1-based across this fixture, in arrival order. */
    index: fixture.turns.length + 1,
    spawn: connection.hello?.spawn ?? -1,
    seq: message.seq,
    model: connection.hello?.model ?? null,
    systemPrompt: connection.hello?.systemPrompt ?? '',
    /** The whole text the app wrote for this turn (persona/turn context + conversation data). */
    text: message.text,
    conversation,
    /** The current user message, or null when this prompt is not an ordinary chat turn. */
    currentUser: conversation?.currentUser ?? null,
    /** History the app sent with this turn (all of it when opening a session, only unseen messages afterwards). */
    history: conversation?.history ?? [],
    opening: conversation?.opening ?? null,
    /**
     * A Chat Completions-style view for smokes written against the retired OpenAI fixture: the persona part as one
     * system message, the history this turn carries, then the current user message. On a persistent session's
     * follow-up the "system" part is only the follow-up header + turn context and the history only unseen messages.
     */
    messages: conversation
      ? [{ role: 'system', content: personaPart(message.text) }, ...conversation.history, { role: 'user', content: conversation.currentUser }]
      : [{ role: 'user', content: message.text }],
    images: message.images.map(image => ({ ...image, dataUrl: `data:${image.mediaType};base64,${image.data}` })),
    signal: controller.signal,
    closed,
    get finished() { return finished; },
    get cancelled() { return !!cancelReason; },
    get cancelReason() { return cancelReason; },
    /** This turn's private tail nonce (`<sh-state-…>`, `<sh-memorial-…>`, `<sh-setting-…>`), or null. */
    nonce(kind = 'state') { return new RegExp(`<sh-${kind}-([a-f0-9]{1,32})>`).exec(message.text)?.[1] ?? null; },
    delta(text) { if (!open()) return false; if (text) send({ type: 'delta', text: String(text) }); return true; },
    done() { if (!open()) return false; finished = true; send({ type: 'done' }); settle('done'); return true; },
    fail(reason = 'synthetic failure') { if (!open()) return false; finished = true; send({ type: 'fail', message: String(reason) }); settle('fail'); return true; },
    reply(...chunks) { for (const chunk of chunks.flat()) turn.delta(chunk); return turn.done(); },
    onCancel(listener) { if (cancelReason) listener(cancelReason); else listeners.push(listener); },
    cancel(reason) {
      if (!open()) return;
      cancelReason = reason; controller.abort(Error(reason)); settle('cancel');
      for (const listener of listeners.splice(0)) { try { listener(reason); } catch (error) { fixture.errors.push(`cancel listener: ${error?.message ?? error}`); } }
    },
  };
  return turn;
}

/**
 * Only the owned folders under `root` (an owned temporary folder of the calling smoke): for smokes that never chat.
 * Nothing is installed in the app, so any Claude Code launch fails at the inert placeholder.
 */
export async function createClaudeIsolation({ root, model = FIXTURE_CLAUDE_MODEL } = {}) {
  if (root === undefined) {
    // No owned folder given: make one in the system temp folder and remove it when the runner exits.
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-claude-fixture-')));
    const owned = root;
    process.once('exit', () => { try { rmSync(owned, { recursive: true, force: true }); } catch { /* A fake still holding its log: left in temp. */ } });
  }
  assert.ok(typeof root === 'string' && path.isAbsolute(root), 'An owned absolute root folder is required.');
  const base = path.join(root, 'claude-fixture');
  const owned = { base, codexHome: path.join(base, 'codex-home'), sentinel: path.join(base, 'must-not-exist-codex.exe'), claudeHome: path.join(base, 'claude-home'),
    claudePlaceholder: path.join(base, 'claude-placeholder.exe'), fakeLog: path.join(base, 'fake-claude') };
  await mkdir(base);
  for (const directory of [owned.codexHome, owned.claudeHome, owned.fakeLog]) await mkdir(directory);
  await writeFile(owned.claudePlaceholder, CLAUDE_PLACEHOLDER_TEXT, { flag: 'wx', mode: 0o700 });
  return {
    ...owned,
    provider: fixtureClaudeProvider(model),
    model,
    /** `base` (default process.env) with the isolation variables; pass to electron.launch({ env }). */
    environment: (environment = process.env) => isolatedClaudeEnvironment(environment, owned),
    /** The Claude Code config folder is still empty (nothing logged in or wrote settings there). */
    claudeHomeEmpty: async () => (await readdir(owned.claudeHome).catch(() => [])).length === 0,
  };
}

/**
 * Owned folders under `root` (an owned temporary folder of the calling smoke), a local pipe for the relay fake and
 * the interposer installer. `respond(turn)` handles each turn: stream with `turn.delta(text)` and end with
 * `turn.done()` / `turn.fail(message)` (or return a string / string array to reply with it). `turn.onCancel` fires
 * when the app interrupts the turn or kills its process (stop, new conversation, character change, quit).
 */
export async function createClaudeFixture({ root, respond = () => { throw Error('No synthetic chat is expected in this smoke.'); }, model = FIXTURE_CLAUDE_MODEL, maxSpawns = FIXTURE_MAX_SPAWNS } = {}) {
  const owned = await createClaudeIsolation({ root, model });
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\soft-hearts-smoke-${randomUUID()}` : path.join(os.tmpdir(), `shs-${randomUUID().slice(0, 8)}.sock`);
  const fixture = { turns: [], spawns: [], errors: [] };
  const connections = new Set();
  const server = net.createServer(socket => {
    const connection = { socket, hello: null, record: null, turns: new Map() };
    connections.add(connection);
    socket.unref();
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        let message;
        try { message = JSON.parse(line); } catch { fixture.errors.push('relay: not JSON'); continue; }
        if (message.type === 'hello') { connection.hello = message; connection.record = { ...message, closed: false }; fixture.spawns.push(connection.record); continue; }
        if (message.type === 'cancel') { connection.turns.get(message.seq)?.cancel(message.reason === 'interrupt' ? 'interrupt' : 'closed'); continue; }
        if (message.type !== 'turn') { fixture.errors.push('relay: unexpected ' + String(message.type).slice(0, 40)); continue; }
        const turn = createTurn(fixture, connection, message);
        connection.turns.set(message.seq, turn); fixture.turns.push(turn);
        Promise.resolve().then(() => respond(turn)).then(value => {
          if (typeof value === 'string' || Array.isArray(value)) turn.reply(value);
        }, error => {
          fixture.errors.push(`respond turn ${turn.index}: ${error?.message ?? error}`);
          turn.fail(`synthetic fixture refused this turn: ${error?.message ?? error}`);
        });
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      connections.delete(connection);
      if (connection.record) connection.record.closed = true;
      // The process ended (or was killed) with a turn still open: the app has given up on it.
      for (const turn of connection.turns.values()) turn.cancel('closed');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  // The pipe never keeps a finished smoke runner alive; the app's own processes are what the smoke waits for.
  server.unref();
  await writeFile(path.join(owned.fakeLog, RELAY_FILE), JSON.stringify({ pipe }), { flag: 'wx' });
  const expected = { marker: randomUUID(), claudePlaceholder: owned.claudePlaceholder, claudeHome: owned.claudeHome, fakeLog: owned.fakeLog,
    fakeNode: process.execPath, fakeScript: relayScript, fakeMarker: FAKE_CLAUDE_RELAY_MARKER, maxSpawns };
  const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
  return {
    ...owned,
    /** Every turn the fake received, in order. */
    turns: fixture.turns,
    /** One record per fake process: argv verdict, model, system prompt, pid, whether its pipe closed. */
    spawns: fixture.spawns,
    /** Fixture-side problems (respond threw, protocol errors). A clean smoke has none. */
    errors: fixture.errors,
    /** Install the interposer in the launched app's main process. Call right after launch, before any chat. */
    install: instance => instance.evaluate(installClaudeInterposer, expected),
    /** The interposer's record: launches routed to the fake (with environment findings) and refused launches. */
    evidence: instance => instance.evaluate(() => {
      const state = globalThis.__safeSmokeClaude;
      return state ? { spawned: state.spawned.map(entry => ({ index: entry.index, model: entry.model, findings: { ...entry.findings } })), denied: [...state.denied], passedThrough: state.passedThrough } : null;
    }),
    /** Resolves with the next turn matching `predicate` (already received or future). */
    async waitForTurn(predicate = () => true, timeout = 20_000) {
      const end = Date.now() + timeout;
      for (;;) {
        const turn = fixture.turns.find(predicate);
        if (turn) return turn;
        if (Date.now() > end) throw Error('Timed out waiting for a fake Claude Code turn.');
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    },
    /** Throws unless every fake saw the exact isolation argv, an allowed model and an empty folder, and the fixture recorded no problem. */
    assertClean(models = [model]) {
      assert.deepEqual(fixture.errors, [], 'The synthetic Claude Code fixture reported problems.');
      for (const spawn of fixture.spawns) assert.ok(spawn.argvOk && models.includes(spawn.model) && spawn.cwdEmpty === true, 'Every fake Claude Code process must see the exact isolation flags, the selected model and an empty folder.');
    },
    /** Waits (bounded) for every fake process to exit, then closes the pipe. Never throws. */
    async close(milliseconds = 4000) {
      const end = Date.now() + milliseconds;
      const pids = () => fixture.spawns.map(spawn => spawn.pid).filter(pid => Number.isSafeInteger(pid) && pid > 0);
      while (!pids().every(gone) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 60));
      const exited = pids().every(gone);
      for (const connection of connections) connection.socket.destroy();
      await new Promise(resolve => server.close(() => resolve()));
      if (process.platform !== 'win32') await rm(pipe, { force: true }).catch(() => {});
      return { fakeClaudeExited: exited, claudeHomeEmpty: await owned.claudeHomeEmpty() };
    },
  };
}
