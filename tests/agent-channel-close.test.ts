// X-090: closing the internal channel abandons approved-but-uncommitted operations with a clear
// error; committed ones keep their result (no rollback). Semantics confirmed.
// Also: the host's mutation queue that carries the guard to the commit point, and the one
// confirmation lock shared by the channel and the chat settings cards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { AssetRef } from '../shared/contracts';
import type { CharacterCardState } from '../shared/character-cards';
import { MutationQueue } from '../electron/mutation-queue';
import { AgentConfirmLock, AgentToolRegistry, AGENT_CHANNEL_CLOSED, type AgentToolDefinition } from '../electron/agent-channel/registry';
import { AgentChannelHost } from '../electron/agent-channel/host';
import { createAppTools, type CommitResult } from '../electron/agent-channel/app-tools';
import { createHostBridge, type IpcHandler } from '../electron/agent-channel/bridge';
import { agentHostActions, type AgentHostActionPorts } from '../electron/agent-channel/host-actions';
import { argsObject } from '../electron/agent-channel/validate';
import type { FileSystemPort } from '../electron/agent-channel/validate';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out waiting'); await tick(); }
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('mutation queue: one at a time in order; a guard is checked when the change starts, not when it was queued', async () => {
  const queue = new MutationQueue(), order: string[] = [];
  const gate = deferred();
  const first = queue.run(async () => { await gate.promise; order.push('first'); });
  let open = true;
  const guarded = queue.run(async () => { order.push('guarded'); }, () => { if (!open) throw new Error('closed'); });
  const after = queue.run(async () => { order.push('after'); });
  open = false; // Invalidated while waiting for its turn.
  gate.resolve();
  await first;
  await assert.rejects(guarded, /closed/);
  await after;
  assert.deepEqual(order, ['first', 'after'], 'the guarded change never ran; the queue went on');
  await queue.idle();
});

test('mutation queue: guarded() covers changes queued synchronously inside it, and only those', async () => {
  const queue = new MutationQueue(), ran: string[] = [];
  let open = true;
  const guard = () => { if (!open) throw new Error('closed'); };
  const gate = deferred();
  const blocker = queue.run(() => gate.promise);
  // Like a reused IPC handler: it queues its change as its first step.
  const handler = () => queue.run(async () => { ran.push('handler'); });
  const inside = queue.guarded(guard, handler);
  const outside = handler(); // Not inside guarded(): unaffected.
  // A queue call made after guarded() returned (e.g. after an await) is not covered.
  const later = queue.guarded(guard, async () => { await tick(); return queue.run(async () => { ran.push('later'); }); });
  open = false; gate.resolve(); await blocker;
  await assert.rejects(inside, /closed/);
  await outside;
  await (await later);
  assert.deepEqual(ran, ['handler', 'later']);
  // Nested guarded() restores the outer guard afterwards.
  const outer = () => { throw new Error('outer'); };
  const results = queue.guarded(outer, () => [queue.guarded(() => {}, () => queue.run(async () => 'inner')), queue.run(async () => 'outer-run')]);
  assert.equal(await results[0], 'inner');
  await assert.rejects(results[1], /outer/);
});

function confirmTool(name: string, run: AgentToolDefinition['run'] = () => ({ ran: name })): AgentToolDefinition {
  return { name, title: name, tier: 'confirm', validate: raw => argsObject(raw, []), confirmation: () => ({ title: name, detail: 'd' }), run };
}

test('registry: closing aborts an open dialog and voids it; turning the channel off and on again does not revive an old allow', async () => {
  let enabled = true, runs = 0;
  const answers: Array<(value: boolean) => void> = [], signals: AbortSignal[] = [];
  const registry = new AgentToolRegistry([confirmTool('ask', () => ({ runs: ++runs }))], {
    enabled: () => enabled,
    confirm: (_request, signal) => { signals.push(signal); return new Promise<boolean>(resolve => answers.push(resolve)); },
    confirmTimeoutMs: 5_000,
  });
  const first = registry.call('ask', {});
  await tick();
  enabled = false; registry.revoke(); // What AgentChannelHost does when the switch goes off.
  const closed = await first;
  assert.deepEqual(closed, { ok: false, error: { code: 'channel_off', message: AGENT_CHANNEL_CLOSED } });
  assert.equal(signals[0].aborted, true, 'the native dialog is closed at once');
  // Off -> on while a dialog from the earlier generation is still answered late.
  enabled = true;
  const second = registry.call('ask', {});
  await tick();
  enabled = false; registry.revoke(); enabled = true; // Off and on again before the user clicks.
  answers[1](true);
  const stale = await second;
  assert.equal(!stale.ok && stale.error.code, 'channel_off');
  assert.equal(runs, 0, 'an allow from before the restart never runs');
  // A fresh call in the new generation works as usual.
  const fresh = registry.call('ask', {});
  await tick(); answers[2](true);
  assert.deepEqual(await fresh, { ok: true, result: { runs: 1 } });
  assert.equal(registry.pending, 0);
});

test('registry: an approved run abandoned at its commit point fails with channel_off; a committed one keeps its result', async () => {
  let enabled = true;
  const committed: string[] = [];
  const gate = deferred(), started = deferred();
  const registry = new AgentToolRegistry([
    confirmTool('uncommitted', async (_input, context) => { started.resolve(); await gate.promise; context.check(); committed.push('uncommitted'); return { ok: 1 }; }),
  ], { enabled: () => enabled, confirm: async () => true });
  const one = registry.call('uncommitted', {});
  await started.promise;
  enabled = false; registry.revoke();
  gate.resolve();
  const abandoned = await one;
  assert.equal(!abandoned.ok && abandoned.error.code, 'channel_off');
  assert.equal(committed.length, 0);
  // Committed before the close: the receipt stands, nothing is rolled back.
  enabled = true;
  const gate2 = deferred(), started2 = deferred();
  const registry2 = new AgentToolRegistry([
    confirmTool('committed', async (_input, context) => { context.check(); committed.push('committed'); started2.resolve(); await gate2.promise; return { saved: true }; }),
  ], { enabled: () => enabled, confirm: async () => true });
  const two = registry2.call('committed', {});
  await started2.promise;
  enabled = false; registry2.revoke();
  gate2.resolve();
  assert.deepEqual(await two, { ok: true, result: { saved: true } });
  assert.deepEqual(committed, ['committed']);
});

test('one confirmation lock for the channel and the chat cards: a second dialog is refused, not stacked', async () => {
  const lock = new AgentConfirmLock();
  const answers: Array<(value: boolean) => void> = [];
  const confirm = () => new Promise<boolean>(resolve => answers.push(resolve));
  const channel = new AgentToolRegistry([confirmTool('a')], { enabled: () => true, confirm, confirmLock: lock });
  const cards = new AgentToolRegistry([confirmTool('b')], { enabled: () => true, confirm, confirmLock: lock });
  const open = channel.call('a', {});
  await tick();
  const second = await cards.call('b', {});
  assert.equal(!second.ok && second.error.code, 'confirm_busy');
  assert.equal(answers.length, 1, 'only one dialog was shown');
  answers[0](false); await open;
  assert.equal(lock.busy, false);
  const next = cards.call('b', {});
  await tick(); answers[1](true);
  assert.equal((await next).ok, true);
});

/** The real channel host, app tools, bridge and host actions around a fake app (no Electron). */
async function channelFixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'sh-close-'));
  const mutations = new MutationQueue();
  const log: string[] = [];
  const register = { gate: null as Promise<void> | null, entered: 0 };
  const persist = { gate: null as Promise<void> | null };
  const saved: CommitResult = { persistence: 'saved', presentation: 'applied' };
  const ports: AgentHostActionPorts = {
    mutations,
    registerAsset: async (file, guard) => {
      register.entered++;
      if (register.gate) await register.gate;
      guard(); // assets.register: right before the folder is granted.
      log.push(`grant ${path.win32.basename(file)}`);
      return { path: file, name: path.win32.basename(file), url: 'mmd-asset://t/m.pmx' } as AssetRef;
    },
    noteModelSelection: () => log.push('generation'),
    persistModel: async asset => { log.push(`persist-start ${asset.name}`); if (persist.gate) await persist.gate; log.push(`persisted ${asset.name}`); },
    sync: () => log.push('sync'),
    importCharacterCard: content => mutations.run(async () => { log.push(`import ${content}`); return { cards: [], activeId: '' } as CharacterCardState; }),
    commitPetBoolean: async (value, actionId) => { log.push(`${actionId} ${value}`); return saved; },
    commitReadoutVolume: async percent => { log.push(`volume ${percent}`); return saved; },
    commitBreath: async percent => { log.push(`breath ${percent}`); return saved; },
  };
  const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    webContents: { id: 7, isDestroyed: () => false, send: () => {} } };
  const settings = structuredClone(DEFAULT_SETTINGS);
  const operations = new Map<string, IpcHandler>([['getSettings', () => structuredClone(settings)], ['getCharacterCards', () => ({ cards: [], activeId: '' })]]);
  const bridge = createHostBridge({ version: () => 'test', controls: () => window, pet: () => window, operations,
    replyLatency: () => [], broadcast: () => {}, ...agentHostActions(ports) });
  const fs: FileSystemPort = { realpath: async file => file, stat: async () => ({ isFile: () => true, size: 10, mtimeMs: 1 }) };
  const tools = createAppTools(bridge, { fs, platform: 'win32', readText: async () => '{"name":"卡"}' });
  const dialogs: Array<(value: boolean) => void> = [];
  const host = new AgentChannelHost({ profileDirectory: directory, tools, confirmTimeoutMs: 5_000,
    confirm: () => new Promise<boolean>(resolve => dialogs.push(resolve)) });
  t.after(async () => { await host.dispose(); await rm(directory, { recursive: true, force: true }); });
  await host.setEnabled(true);
  assert.equal(host.enabled, true);
  return { host, mutations, log, register, persist, dialogs };
}

test('X-090: load_model approved, then the channel is closed while it waits in the queue: nothing is saved and the error says why', async t => {
  const f = await channelFixture(t);
  const busy = deferred();
  const userWork = f.mutations.run(() => busy.promise); // e.g. the user's own model import still running
  const call = f.host.registry.call('load_model', { path: 'C:\\m\\mira.pmx' });
  await until(() => f.dialogs.length === 1);
  f.dialogs[0](true);
  await until(() => f.log.includes('generation')); // Registered, now waiting for its turn.
  await tick();
  await f.host.setEnabled(false);
  busy.resolve(); await userWork;
  const result = await call;
  assert.deepEqual(result, { ok: false, error: { code: 'channel_off', message: AGENT_CHANNEL_CLOSED } });
  assert.ok(!f.log.some(line => line.startsWith('persist')), 'the model was not saved');
  assert.ok(!f.log.includes('sync'));
});

test('X-090: closed during the asset registration: the model folder is never granted', async t => {
  const f = await channelFixture(t);
  const gate = deferred();
  f.register.gate = gate.promise;
  const call = f.host.registry.call('load_model', { path: 'C:\\m\\mira.pmx' });
  await until(() => f.dialogs.length === 1);
  f.dialogs[0](true);
  await until(() => f.register.entered === 1);
  await f.host.setEnabled(false);
  gate.resolve();
  const result = await call;
  assert.equal(!result.ok && result.error.code, 'channel_off');
  assert.deepEqual(f.log, [], 'no grant, no generation bump, no save');
});

test('X-090: a model save already under way when the channel closes completes and keeps its receipt (no rollback)', async t => {
  const f = await channelFixture(t);
  const gate = deferred();
  f.persist.gate = gate.promise;
  const call = f.host.registry.call('load_model', { path: 'C:\\m\\mira.pmx' });
  await until(() => f.dialogs.length === 1);
  f.dialogs[0](true);
  await until(() => f.log.includes('persist-start mira.pmx'));
  await f.host.setEnabled(false);
  gate.resolve();
  const result = await call;
  assert.deepEqual(result, { ok: true, result: { model: { name: 'mira.pmx' } } });
  assert.deepEqual(f.log, ['grant mira.pmx', 'generation', 'persist-start mira.pmx', 'persisted mira.pmx', 'sync']);
});

test('X-090: an approved card import and a reversible setting queued behind other work are dropped when the channel closes', async t => {
  const f = await channelFixture(t);
  const busy = deferred();
  const userWork = f.mutations.run(() => busy.promise);
  const card = f.host.registry.call('import_character_card', { path: 'C:\\cards\\mira.json' });
  await until(() => f.dialogs.length === 1);
  f.dialogs[0](true);
  const setting = f.host.registry.call('set_setting', { id: 'readout_volume', value: 30 });
  await tick(); await tick();
  await f.host.setEnabled(false);
  busy.resolve(); await userWork;
  assert.equal(((await card) as any).error.code, 'channel_off');
  assert.equal(((await setting) as any).error.code, 'channel_off');
  assert.deepEqual(f.log, []);
});
