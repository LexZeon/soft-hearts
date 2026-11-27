// The model check-up is saved after a model loads (docs/claude/2026-11-27-model-checkup-not-saved.md).
// Since the old stage was deleted (575216516, 2026-11-24) no page saved the profile it built, so a model first loaded after that day had
// no stored check-up: her replies offered no small action, play_her_action said "还没有这个模型的体检档案", the character page's switches
// stayed grey. These tests start where the bug started: a model the app has never seen, loaded by today's engine (loadWindowModel, the
// window engine's one load step, with the real Gene / Mumi files), and end where the user felt it: the host's real profile store has it
// on disk and the host's real "can she do it" rule offers the actions the model can do. Only the IPC between the two is a plain function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadWindowModel, type WindowLoadedModel } from '../src/unbound/window-mode/window-model';
import { saveBuiltProfile } from '../src/stage/model-profile-save';
import { ModelProfileStore } from '../electron/stage/model-profile-store';
import { modelOfRead } from '../electron/brain/chat-actions-host';
import { CHAT_ACTION_WORDS, chatActionRefusal, offeredChatActions } from '../shared/brain/chat-actions';
import { loadPmxForTargets, loadPublicGeneForTargets } from './public-gene-fixture';

const GENE_KEY = 'a'.repeat(64), MUMI_KEY = 'b'.repeat(64);
const GENE_URL = 'asset://bundled/gene/model/gene.pmx', MUMI_URL = 'asset://bundled/mumi/model.pmx';
const MUMI_FILE = new URL('../assets/bundled/mumi/model.pmx', import.meta.url);
const refuse = async (): Promise<never> => { throw new Error('not in this test'); };

/** The host as far as a load reaches it: the Gene check, and the profile cache read and save over the REAL store (the IPC handler's rule). */
function hostFor(store: ModelProfileStore, model: { key: string; url: string; reviewed: boolean }, options: { refuseSave?: boolean } = {}) {
  const calls = { reads: 0, saves: 0 };
  const host = {
    isBehaviorModelSupported: async () => model.reviewed,
    getModelProfile: async () => { calls.reads++; await store.flush(); return { modelKey: model.key, modelUrl: model.url, profile: store.get(model.key), haiku: null, motionFits: null }; },
    // electron/wiring/stage-model-wiring.ts saveModelProfile: only the current model's key is stored.
    saveModelProfile: async (key: string, profile: unknown) => { calls.saves++; return !options.refuseSave && key === model.key && store.set(key, profile); },
    resolveChatGesture: refuse, resolveHerAction: refuse, reportHerAction: async () => {}, getBehaviorBodyPlan: refuse, resolveBehaviorBody: refuse,
    resolveBehaviorMotion: refuse, resolveHerLifeMotion: refuse, getRestStand: async () => null,
  };
  return { host, calls };
}

async function load(store: ModelProfileStore, model: { key: string; url: string; reviewed: boolean; mesh: () => Promise<{ mesh: import('three').SkinnedMesh }> },
  options: { refuseSave?: boolean; current?: () => boolean; log?: (line: string) => void } = {}) {
  const { host, calls } = hostFor(store, model, options);
  const loaded = await loadWindowModel(model.url, { host: host as never, current: options.current ?? (() => true), idle: Promise.resolve(null), random: () => 0.5, breath: 0.5,
    loadMmd: async () => ({ mesh: (await model.mesh()).mesh, textures: Promise.resolve() }), log: options.log } as never) as (WindowLoadedModel & { profileSaved?: Promise<unknown> }) | null;
  assert.ok(loaded, 'the model loaded');
  const outcome = await loaded.profileSaved; // the save is scheduled off the load's path; the stage never awaits it
  await store.flush();
  return { loaded, calls, outcome };
}

/** What the host offers her for the model now: the internal channel's and the turn's tail note's one rule over what the store holds. */
const offered = (store: ModelProfileStore, key: string, url: string) =>
  offeredChatActions(modelOfRead({ view: { modelKey: key, modelUrl: url, profile: store.get(key), record: null }, fits: null }));

const tempProfile = () => mkdtemp(path.join(os.tmpdir(), 'checkup-saved-'));

test('a model the app has never seen (the bundled Gene): loaded by the window engine, its check-up lands in model-profiles.json and she is offered all seven actions', async () => {
  const dir = await tempProfile();
  try {
    const store = new ModelProfileStore(dir); await store.load();
    const gene = { key: GENE_KEY, url: GENE_URL, reviewed: true, mesh: loadPublicGeneForTargets };
    assert.deepEqual(offered(store, GENE_KEY, GENE_URL), [], 'before: a fresh profile has no check-up (the reported state)');
    assert.equal(chatActionRefusal('heart', modelOfRead({ view: { modelKey: GENE_KEY, modelUrl: GENE_URL, profile: store.get(GENE_KEY), record: null }, fits: null })),
      '还没有这个模型的体检档案（先载入模型）');
    const first = await load(store, gene);
    assert.deepEqual(first.outcome, { status: 'saved' });
    assert.equal(first.calls.saves, 1, 'saved once');
    assert.equal(first.loaded.profile?.source, 'computed');
    const file = path.join(dir, 'model-profiles.json');
    assert.ok((await stat(file)).size > 1000, 'model-profiles.json is on disk');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).profiles[0].modelKey, GENE_KEY);
    assert.deepEqual(offered(store, GENE_KEY, GENE_URL), [...CHAT_ACTION_WORDS], 'wave, nod, tilt, heart, clap, wink, pout');
    // The next start: a new store reads the file; the stage takes the cached copy and nothing is written again.
    const again = new ModelProfileStore(dir); await again.load();
    const second = await load(again, gene);
    assert.equal(second.loaded.profile?.source, 'cache', 'the stored check-up is the one in use');
    assert.deepEqual(second.outcome, { status: 'kept' });
    assert.equal(second.calls.saves, 0, 'an existing profile for the same model is kept, not rewritten');
    assert.deepEqual(offered(again, GENE_KEY, GENE_URL), [...CHAT_ACTION_WORDS]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the bundled Mumi (not the reviewed Gene, fitted through the retarget): her check-up is saved too and the actions she can do are offered', async () => {
  const dir = await tempProfile();
  try {
    const store = new ModelProfileStore(dir); await store.load();
    const mumi = { key: MUMI_KEY, url: MUMI_URL, reviewed: false, mesh: () => loadPmxForTargets(MUMI_FILE) };
    const first = await load(store, mumi);
    assert.deepEqual(first.outcome, { status: 'saved' });
    assert.ok(first.loaded.retarget, 'Mumi goes through the motion retarget (not the reviewed Gene)');
    const words = offered(store, MUMI_KEY, MUMI_URL);
    // What the character page's rule says she has: every one of her bones and face shapes the seven need (her PMX face, 2026-11-19).
    assert.deepEqual(words, [...CHAT_ACTION_WORDS], `Mumi offers ${words.join(', ')}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a refused or failed save is written to the log, not swallowed, and the next load of the same model saves it', async () => {
  const dir = await tempProfile();
  try {
    const store = new ModelProfileStore(dir); await store.load();
    const gene = { key: GENE_KEY, url: GENE_URL, reviewed: true, mesh: loadPublicGeneForTargets };
    const lines: string[] = [];
    const refused = await load(store, gene, { refuseSave: true, log: line => lines.push(line) });
    assert.deepEqual(refused.outcome, { status: 'failed', reason: 'refused' });
    assert.equal(lines.length, 1, 'one log line');
    assert.match(lines[0], /not saved \(refused\)/);
    assert.equal(store.get(GENE_KEY), null);
    const retried = await load(store, gene, { log: line => lines.push(line) });
    assert.deepEqual(retried.outcome, { status: 'saved' }, 'tried again on the next load');
    assert.notEqual(store.get(GENE_KEY), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a load that a newer one replaced before the save writes nothing (the host would refuse the old key anyway)', async () => {
  const dir = await tempProfile();
  try {
    const store = new ModelProfileStore(dir); await store.load();
    let current = true;
    const gene = { key: GENE_KEY, url: GENE_URL, reviewed: true, mesh: async () => { const fixture = await loadPublicGeneForTargets(); return fixture; } };
    const { host, calls } = hostFor(store, gene);
    const loaded = await loadWindowModel(gene.url, { host: host as never, current: () => current, idle: Promise.resolve(null), random: () => 0.5, breath: 0.5,
      loadMmd: async () => ({ mesh: (await gene.mesh()).mesh, textures: Promise.resolve() }) } as never) as (WindowLoadedModel & { profileSaved?: Promise<unknown> }) | null;
    assert.ok(loaded);
    current = false; // a newer model load started right after this one returned
    assert.deepEqual(await loaded.profileSaved, { status: 'skipped', reason: 'stale' });
    assert.equal(calls.saves, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- the rule itself (saveBuiltProfile), each branch ---------------------------------------------------------------------------------

test('saveBuiltProfile: saves a computed profile under the cache read\'s key, keeps a cached one, logs every failure', async () => {
  const saved: [string, unknown][] = [], lines: string[] = [];
  const port = (answer: boolean | Error) => ({ saveModelProfile: async (key: string, profile: unknown) => { saved.push([key, profile]); if (answer instanceof Error) throw answer; return answer; } });
  const options = { current: () => true, log: (line: string) => lines.push(line) };
  const profile = { version: 1 };
  assert.deepEqual(await saveBuiltProfile(port(true), { modelKey: GENE_KEY }, { profile, source: 'computed' }, options), { status: 'saved' });
  assert.deepEqual(saved, [[GENE_KEY, profile]]);
  assert.deepEqual(await saveBuiltProfile(port(true), { modelKey: GENE_KEY }, { profile, source: 'cache' }, options), { status: 'kept' });
  assert.deepEqual(await saveBuiltProfile(port(true), { modelKey: GENE_KEY }, { profile: null, source: 'unavailable' }, options), { status: 'skipped', reason: 'no-profile' });
  assert.deepEqual(await saveBuiltProfile(port(true), { modelKey: GENE_KEY }, null, options), { status: 'skipped', reason: 'no-profile' });
  assert.equal(saved.length, 1, 'kept and skipped write nothing');
  assert.deepEqual(await saveBuiltProfile(port(true), null, { profile, source: 'computed' }, options), { status: 'failed', reason: 'no-key' });
  assert.deepEqual(await saveBuiltProfile(port(false), { modelKey: GENE_KEY }, { profile, source: 'computed' }, options), { status: 'failed', reason: 'refused' });
  assert.deepEqual(await saveBuiltProfile(port(new Error('disk full')), { modelKey: GENE_KEY }, { profile, source: 'computed' }, options), { status: 'failed', reason: 'error', detail: 'disk full' });
  assert.equal(lines.length, 3, 'each failure is one log line');
  assert.deepEqual(await saveBuiltProfile(port(true), { modelKey: GENE_KEY }, { profile, source: 'computed' }, { ...options, current: () => false }), { status: 'skipped', reason: 'stale' });
  assert.deepEqual(await saveBuiltProfile(port(true), { modelKey: GENE_KEY }, { profile, source: 'computed' }, { current: () => true, log: () => { throw new Error('log broke'); } }), { status: 'saved' });
});
