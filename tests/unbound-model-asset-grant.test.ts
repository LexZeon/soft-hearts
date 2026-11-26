/**
 * K14 (2026-11-24, docs/claude/2026-11-24-k14-asset-403.md): the Unbound window loads her model through the same mmd-asset://
 * grant the companion window uses (electron/main.ts: `source: () => unboundSource(store.current, …)`), so a user-imported model
 * (the user's own characters use them) must load there, and nothing outside that grant may.
 *
 * How the grant works (electron/foundation/assets.ts): `AssetRegistry.register(file)` realpaths the chosen file and hands out an
 * unguessable 128-bit token for its folder; `resolve` serves only files inside a granted folder with a model, motion or texture
 * extension. The token is process-wide, not per window: every window of the app gets the same URL from the host, and only the
 * host decides which files are registered. A restart registers again (SettingsStore.load) and gets a new token, so a URL kept
 * from before the restart no longer opens anything.
 *
 * The pretrial K14 failure was its own setup: card K7 deleted the copied model's folder while that model was still the active
 * character, so the fetch answered 403 (the "model file gone" case below), not a missing grant.
 *
 * I-209 step 1 (several characters on the full-screen stage): each extra's model is granted the same way, by the host from the
 * card store (electron/unbound/company/ports.ts `companyPorts`, wired with the same registry in electron/wiring/unbound-wiring.ts).
 * The last test checks that a card on stage gets her own URL and that no URL on the page reaches a model no card brought out.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import bundled from '../shared/actions/bundled-assets.json';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { createAssetProtocolHandler } from '../electron/foundation/asset-protocol';
import { AssetRegistry } from '../electron/foundation/assets';
import { SettingsStore } from '../electron/settings/settings';
import { unboundSource } from '../electron/unbound/source';
import { companyPorts } from '../electron/unbound/company/ports';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENE_PATH = path.join(REPO_ROOT, 'assets/bundled', bundled.root, bundled.model.relativePath);
const secret = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };

/** The app's protocol handler over a real registry, with Electron's net.fetch on file:// replaced by a plain file read. */
function protocol(registry: AssetRegistry) {
  const handle = createAssetProtocolHandler({
    resolve: url => registry.resolve(url),
    fetchFile: async url => new Response(await readFile(fileURLToPath(url)), { status: 200 }),
  });
  return async (url: string) => {
    const response = await handle(new Request(url));
    return { status: response.status, body: response.status === 200 ? Buffer.from(await response.arrayBuffer()) : null };
  };
}

/** A user-imported model in its own folder (a texture beside it) and a second character's model in a sibling folder. */
async function userModels() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unbound-asset-grant-'));
  const one = path.join(root, 'One的模型'), mumi = path.join(root, 'Mumi的模型');
  await mkdir(path.join(one, 'tex'), { recursive: true });
  await mkdir(mumi, { recursive: true });
  await writeFile(path.join(one, 'One.pmx'), 'PMX one');
  await writeFile(path.join(one, 'tex', 'face.png'), 'one face');
  await writeFile(path.join(mumi, 'Mumi.pmx'), 'PMX mumi');
  await writeFile(path.join(mumi, 'face.png'), 'mumi face');
  const kai = path.join(root, 'Kai的模型');
  await mkdir(kai, { recursive: true });
  await writeFile(path.join(kai, 'Kai.pmx'), 'PMX kai');
  return { root, onePmx: path.join(one, 'One.pmx'), mumiPmx: path.join(mumi, 'Mumi.pmx'), kaiPmx: path.join(kai, 'Kai.pmx'),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A profile whose saved settings point at `model`, loaded the way the app starts (its own registry, as after a restart). */
async function startApp(profile: string, model: string, staleUrl: string) {
  const saved = { ...structuredClone(DEFAULT_SETTINGS), model: { path: model, name: path.basename(model), url: staleUrl } };
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify(saved));
  const registry = new AssetRegistry();
  const store = new SettingsStore(profile, secret, registry);
  await store.load();
  return { registry, store, fetch: protocol(registry) };
}

const prefix = (url: string) => url.slice(0, url.lastIndexOf('/') + 1);

test('K14: after a restart, the Unbound window loads the user-imported model and its textures through the current grant', async () => {
  const models = await userModels();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'unbound-asset-profile-'));
  try {
    // Before the restart: the model was picked and granted (the URL the old process handed out).
    const before = await new AssetRegistry().register(models.onePmx);
    const app = await startApp(profile, models.onePmx, before.url);
    const { modelUrl } = unboundSource(app.store.current, null);
    assert.ok(modelUrl, 'the Unbound window is told which model to load');
    assert.notEqual(modelUrl, before.url, 'the restart granted the folder again under a new token');
    const model = await app.fetch(modelUrl);
    assert.equal(model.status, 200, 'the user-imported model loads in the Unbound window');
    assert.equal(model.body?.toString(), 'PMX one');
    const texture = await app.fetch(`${prefix(modelUrl)}tex/face.png`);
    assert.equal(texture.status, 200, 'its textures load beside it');
    assert.equal(texture.body?.toString(), 'one face');
    assert.equal((await app.fetch(before.url)).status, 403, 'a URL from before the restart opens nothing');
  } finally {
    await models.cleanup();
    await rm(profile, { recursive: true, force: true });
  }
});

test('K14: the Unbound window cannot reach another model that was not granted (other folder, guessed token, path tricks)', async () => {
  const models = await userModels();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'unbound-asset-profile-'));
  try {
    const app = await startApp(profile, models.onePmx, 'mmd-asset://stale/One.pmx');
    const modelUrl = unboundSource(app.store.current, null).modelUrl!;
    const base = prefix(modelUrl);
    for (const [label, url] of [
      ['a sibling folder through ..', `${base}..%2FMumi%E7%9A%84%E6%A8%A1%E5%9E%8B%2FMumi.pmx`],
      ['a sibling folder through ../ (encoded dots)', `${base}%2E%2E/Mumi%E7%9A%84%E6%A8%A1%E5%9E%8B/face.png`],
      ['an absolute path', `${base}${encodeURIComponent(models.mumiPmx)}`],
      ['a guessed token with the granted model\'s own file name', `mmd-asset://${'0'.repeat(32)}/One.pmx`],
      ['a guessed token for the other model', `mmd-asset://${'f'.repeat(32)}/Mumi.pmx`],
      ['a query string', `${modelUrl}?x=1`],
    ] as const) assert.equal((await app.fetch(url)).status, 403, label);
    // The other character's model loads only once the host grants it (switching to her), under its own token.
    const mumi = await app.registry.register(models.mumiPmx);
    assert.notEqual(prefix(mumi.url), base, 'each model folder has its own token');
    assert.equal((await app.fetch(mumi.url)).body?.toString(), 'PMX mumi');
  } finally {
    await models.cleanup();
    await rm(profile, { recursive: true, force: true });
  }
});

test('K14: the bundled Gene loads through the same grant, and a model whose folder was removed answers 403 (the pretrial failure)', async () => {
  const models = await userModels();
  try {
    const registry = new AssetRegistry(), fetch = protocol(registry);
    const gene = await registry.register(GENE_PATH);
    assert.equal((await fetch(unboundSource({ ...structuredClone(DEFAULT_SETTINGS), model: gene }, null).modelUrl!)).status, 200, 'Gene');
    const one = await registry.register(models.onePmx);
    assert.equal((await fetch(one.url)).status, 200);
    // What card K7 did before K14 (2026-11-24): delete the active character's model folder while the app still runs.
    await models.cleanup();
    assert.equal((await fetch(one.url)).status, 403, 'a model file that is gone cannot load; the grant itself was never missing');
  } finally {
    await models.cleanup();
  }
});

test('I-209 company: an extra on stage gets her own model URL from the host; no URL on the page reaches a model nobody brought out', async () => {
  const models = await userModels();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'unbound-asset-profile-'));
  try {
    // One is the one you talk with (settings model); Mumi is a second card with her own imported model; Kai's model is on disk
    // but no card on stage links it (a third character left in the panel, or any other folder).
    const app = await startApp(profile, models.onePmx, 'mmd-asset://stale/One.pmx');
    const cards = {
      modelCards: () => [{ id: 'one', name: 'One', modelPath: models.onePmx }, { id: 'mumi', name: 'Mumi', modelPath: models.mumiPmx },
        { id: 'gene', name: 'Gene' }, { id: 'empty', name: '没有模型' }],
      presetGeneId: async () => 'gene',
      publicState: () => ({ activeId: 'one' }),
    };
    let bundledAsked = 0;
    const ports = companyPorts(() => ({ cards, models: {
      bundledModel: async () => { bundledAsked++; return app.registry.register(GENE_PATH); },
      register: file => app.registry.register(file),
    } }));
    const oneUrl = unboundSource(app.store.current, null).modelUrl!;
    const mumi = await ports.model('mumi');
    assert.ok(mumi && !mumi.reviewed, 'an extra with an imported model gets a URL (not the reviewed Gene)');
    assert.equal((await app.fetch(mumi.url)).body?.toString(), 'PMX mumi', 'her model loads in the full-screen window');
    assert.equal((await app.fetch(`${prefix(mumi.url)}face.png`)).body?.toString(), 'mumi face', 'and her textures');
    assert.notEqual(prefix(mumi.url), prefix(oneUrl), 'her folder has its own token');
    assert.equal((await app.fetch(oneUrl)).status, 200, 'the one you talk with still loads beside her');
    const gene = await ports.model('gene');
    assert.ok(gene?.reviewed && bundledAsked === 1, 'the preset card is the bundled Gene, reviewed');
    assert.equal((await app.fetch(gene.url)).status, 200);
    assert.equal(await ports.model('empty'), null, 'a card without a model gets nothing');
    assert.equal(await ports.model('nobody'), null, 'an id that is no card gets nothing');
    // Nothing the page now holds (One's, Mumi's and Gene's URLs) reaches Kai's folder.
    const kai = 'Kai%E7%9A%84%E6%A8%A1%E5%9E%8B';
    for (const url of [oneUrl, mumi.url, gene.url]) {
      const base = prefix(url);
      for (const probe of [`${base}..%2F${kai}%2FKai.pmx`, `${base}..%2F..%2F${kai}%2FKai.pmx`, `${base}${encodeURIComponent(models.kaiPmx)}`, `${base}Kai.pmx`])
        assert.equal((await app.fetch(probe)).status, 403, probe);
    }
    // An extra whose model folder was removed while she was on stage: her URL answers 403 (she cannot load), the others still load.
    await rm(path.dirname(models.mumiPmx), { recursive: true, force: true });
    assert.equal((await app.fetch(mumi.url)).status, 403);
    assert.equal((await app.fetch(oneUrl)).status, 200);
  } finally {
    await models.cleanup();
    await rm(profile, { recursive: true, force: true });
  }
});
