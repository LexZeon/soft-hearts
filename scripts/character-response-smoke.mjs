import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// Maintainer QA, not an automatic launch. Obtain the native/build lease first.
// Real host phases use an owned synthetic profile + reviewed Gene. Fault phases
// replace only this process's IPC handlers and are reported separately.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = await realpath(path.resolve(process.env.MMD_TEST_APP_DIR ?? source));
const executable = process.env.MMD_TEST_EXE ? await realpath(path.resolve(process.env.MMD_TEST_EXE)) : null;
const legacyExecutable = process.env.MMD_TEST_LEGACY_EXE ? await realpath(path.resolve(process.env.MMD_TEST_LEGACY_EXE)) : null;
const output = path.resolve(process.env.MMD_TEST_OUTPUT_DIR ?? path.join(source, '.local/character-response-smoke'));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-character-response-e2e-'));
const profile = path.join(temporary, 'profile'), files = path.join(temporary, 'cards');
await mkdir(profile); await mkdir(files);
const checks = [], mockChecks = [], errors = [], guardRuns = [], requests = [], screenshots = [], plans = new Map();
const tendencyKeys = ['playful', 'close', 'comfortable', 'cautious'];
const intensityKeys = ['expression', 'gaze', 'posture', 'playful', 'text'];
const moodKeys = ['calm', 'close', 'content', 'happy', 'excited', 'concerned', 'disappointed', 'upset', 'longing', 'sad', 'relieved', 'tense-expectation'];
const fields = ['name', 'description', 'personality', 'scenario', 'greeting', 'examples', 'systemPrompt'];
const sidecarFile = path.join(profile, 'character-response-settings.json');
let instance, controls, pet, claude, report, phase = 'setup', dialogDecision = null, currentKind, originalId, secondId, originalResponse;
let uiDialogs = 0, closed = true;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const identity = { packaged: Boolean(executable), asarSha256: executable ? await hash(path.join(path.dirname(executable), 'resources/app.asar')) : null,
  legacyAsarSha256: legacyExecutable ? await hash(path.join(path.dirname(legacyExecutable), 'resources/app.asar')) : null,
  harnessSha256: await hash(fileURLToPath(import.meta.url)) };
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const mockPass = name => { mockChecks.push(name); console.log(`PASS mock ${name}`); };
async function poll(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(70); }
  throw Error(`Timed out: ${label} (${phase})`);
}
const cards = () => controls.evaluate(() => window.desktop.getCharacterCards());
const mood = () => controls.evaluate(() => window.desktop.getMood());
const response = id => controls.evaluate(id => window.desktop.getCharacterResponse(id), id);
const getSettings = () => controls.evaluate(() => window.desktop.getSettings());
const profileJson = value => JSON.stringify(value);
const emptyProfile = () => ({ version: 1, rules: [] });
function rule(when, tendency = {}, intensity = {}) {
  return { when, tendencyScale: { playful: 1, close: 1, comfortable: 1, cautious: 1, ...tendency },
    intensityScale: { expression: 1, gaze: 1, posture: 1, playful: 1, text: 1, ...intensity } };
}
const baseDraft = card => ({ ...Object.fromEntries(fields.map(key => [key, card[key] ?? ''])), mood: structuredClone(card.mood) });
const rewardState = view => ({ parameters: view.parameters, values: view.snapshot.values, trend: view.snapshot.trend,
  boredom: view.snapshot.boredom, longing: view.snapshot.longing, lastInteractionAt: view.snapshot.lastInteractionAt });
async function saveResponse(id, value) {
  const before = await response(id);
  return controls.evaluate(({ id, value, revision }) => window.desktop.saveCharacterResponse(id, value, revision), { id, value, revision: before.revision });
}
async function openCards() {
  if (await controls.locator('#control-navigation').count()) {
    const item = controls.locator('#control-navigation [data-nav-target="character-cards"]');
    const ancestors = await item.evaluate(node => {
      const result = []; for (let parent = node.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'UL' && parent.id.startsWith('control-nav-children-')) result.push(parent.id.slice(21));
      return result.reverse();
    });
    for (const id of ancestors) {
      const button = controls.locator(`#control-navigation [data-nav-group][data-nav-node="${id}"]`);
      if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
    }
    await item.click();
  } else await navigateControlPage(controls, 'providers');
}
async function selectCard(id) {
  await controls.locator('#character-select').selectOption(id);
  await poll(async () => (await cards()).activeId === id && await controls.locator('#character-select').inputValue() === id, `activate synthetic card ${id}`);
  if (currentKind !== 'legacy') await poll(() => controls.locator('#response-mood').isEnabled(), 'response editor loaded');
}
async function choose(when) {
  await controls.locator('#response-mood').selectOption(when.mood);
  await controls.locator('#response-phase').selectOption(when.phase ?? '');
  await controls.locator('#response-context').selectOption(when.context ?? '');
}
async function setSlider(group, key, percent) {
  await controls.locator(`#response-${group}-${key}`).evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); }, percent);
}
async function newRule(when) { await choose(when); if (await controls.locator('#response-add-rule').isEnabled()) await controls.locator('#response-add-rule').click(); }
async function savedUi(id, value) {
  await poll(async () => profileJson((await response(id)).profile) === profileJson(value) && await controls.locator('#response-save').isDisabled(), 'response profile saved through UI');
}
async function nativeFile(kind, file) {
  assert.equal(path.dirname(file), files, 'fixture dialog stays in the owned card directory');
  await instance.evaluate(({ dialog }, value) => {
    if (value.kind === 'open') dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value.file] });
    else dialog.showSaveDialog = async () => ({ canceled: false, filePath: value.file });
  }, { kind, file });
}
async function exportUi(name) {
  const file = path.join(files, name); await nativeFile('save', file); await controls.locator('#character-export').click();
  await poll(async () => Boolean(await readFile(file, 'utf8').catch(() => '')), 'actual exported fixture file');
  return JSON.parse(await readFile(file, 'utf8'));
}
async function importUi(text, name) {
  const file = path.join(files, name); await writeFile(file, text); await nativeFile('open', file);
  const before = await cards(); await controls.locator('#character-import').click();
  await poll(async () => (await cards()).cards.length === before.cards.length + 1, 'one imported ID');
  const next = await cards(), created = next.cards.filter(card => !before.cards.some(old => old.id === card.id));
  assert.equal(created.length, 1); assert.equal(next.activeId, before.activeId, 'import never activates the new card');
  await poll(() => controls.locator('#character-select').inputValue().then(id => id === created[0].id), 'imported card editor');
  return created[0];
}
async function collectGuard() {
  if (!instance) return;
  const value = await instance.evaluate(() => {
    const q = globalThis.__responseQA; return { kind: q.kind, remote: q.remote, permissions: q.permissions, captures: q.captures,
      taskExecutions: q.taskExecutions, external: q.external };
  }).catch(() => null);
  if (value) guardRuns.push(value);
}
async function close() {
  await collectGuard(); const child = instance?.process();
  await instance?.close().catch(error => errors.push(`close: ${error.message}`));
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
      await poll(() => child.exitCode !== null || child.signalCode !== null, 'owned process exit', 5000);
    } catch (error) { errors.push(`close: ${error.message}`); }
  }
  closed = !child || child.exitCode !== null || child.signalCode !== null;
  assert.equal(closed, true, 'owned app exited before any profile reuse'); instance = controls = pet = null;
}
async function launch(origin, { legacy = false, faultStates = null, delayId = null } = {}) {
  assert.equal(instance, null); currentKind = legacy ? 'legacy' : faultStates ? 'mock-fault' : 'current'; closed = false;
  const selectedExe = legacy ? legacyExecutable : executable;
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile }); delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  instance = await electron.launch({ ...(selectedExe ? { executablePath: selectedExe, args: [`--user-data-dir=${profile}`] }
    : { args: [appDirectory, `--user-data-dir=${profile}`] }), cwd: appDirectory, env, timeout: 30000 });
  await claude.install(instance);
  const watched = new WeakSet();
  const watch = window => {
    if (watched.has(window)) return; watched.add(window); window.on('pageerror', error => errors.push(error.message));
    window.on('dialog', async dialog => { uiDialogs++; const decision = dialogDecision; dialogDecision = null;
      if (!decision) { errors.push(`Unexpected ${dialog.type()} confirmation`); await dialog.dismiss(); }
      else if (decision === 'accept') await dialog.accept(); else await dialog.dismiss(); });
  };
  instance.on('window', watch); await instance.firstWindow();
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath('userData'))), profile);
  await instance.evaluate(async ({ session, ipcMain, shell, desktopCapturer }, fixture) => {
    const q = globalThis.__responseQA = { kind: fixture.kind, remote: [], permissions: [], external: [], captures: 0, taskExecutions: [],
      states: Object.fromEntries((fixture.states ?? []).map(value => [value.characterId, value])), getCalls: [], saves: [], copies: [],
      pending: [], delayId: fixture.delayId, delayed: false, failSaves: 1, failCopies: 1 };
    await fetch('data:text/plain,response-offline-guard');
    const key = Symbol.for('undici.globalDispatcher.1'), previous = globalThis[key]; if (!previous?.dispatch) throw Error('Missing Node fetch dispatcher');
    globalThis[key] = { dispatch(options, handler) {
      if (String(options.origin) === fixture.origin) return previous.dispatch(options, handler);
      q.remote.push(String(options.origin) + options.path); handler.onError(Error('RESPONSE_SMOKE_OFFLINE')); return false;
    }, close: (...args) => previous.close(...args), destroy: (...args) => previous.destroy(...args) };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, done) => {
      const denied = /^https?:/i.test(request.url) && new URL(request.url).origin !== fixture.origin;
      if (denied) q.remote.push(request.url); done({ cancel: denied });
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, done) => { q.permissions.push(permission); done(false); });
    shell.openExternal = async () => { q.external.push('attempt'); };
    desktopCapturer.getSources = async () => { q.captures++; return []; };
    const replace = (method, callback) => { ipcMain.removeHandler(`desk:${method}`); ipcMain.handle(`desk:${method}`, callback); };
    replace('listCodexTasks', () => []);
    replace('codexTaskCapabilities', () => ({ authenticated: false, login: 'none', computerControl: false, reason: 'No app-server in response QA.' }));
    for (const method of ['startCodexTask', 'continueCodexTask', 'respondCodexApproval']) replace(method, () => { q.taskExecutions.push(method); throw Error('No task execution in response QA.'); });
    if (!fixture.states) return;
    const get = id => structuredClone(q.states[id] ?? { characterId: id, revision: 0, profile: { version: 1, rules: [] } });
    replace('getCharacterResponse', (_event, id) => {
      q.getCalls.push(id); const snapshot = get(id);
      if (id === q.delayId && !q.delayed) { q.delayed = true; return new Promise(resolve => q.pending.push({ id, snapshot, resolve })); }
      return snapshot;
    });
    replace('saveCharacterResponse', (_event, id, profile, revision) => {
      q.saves.push({ id, profile: structuredClone(profile), revision });
      if (q.failSaves-- > 0) throw Error('SYNTHETIC_SAVE_FAILURE');
      const state = { characterId: id, revision: Math.max(...Object.values(q.states).map(value => value.revision), 0) + 1, profile: structuredClone(profile) };
      q.states[id] = state; return get(id);
    });
    replace('copyCharacterResponse', (_event, sourceId, targetId) => {
      q.copies.push({ sourceId, targetId }); if (q.failCopies-- > 0) throw Error('SYNTHETIC_COPY_FAILURE');
      q.states[targetId] = { ...get(sourceId), characterId: targetId, revision: Math.max(...Object.values(q.states).map(value => value.revision), 0) + 1 };
      return get(targetId);
    });
  }, { origin, kind: currentKind, states: faultStates, delayId });
  await poll(() => {
    for (const window of instance.windows()) { watch(window); try { const url = new URL(window.url()); if (!url.pathname.endsWith('/index.html')) continue;
      if (url.searchParams.has('pet')) pet = window; else controls = window;
    } catch { /* Owned auxiliary windows have no controls. */ } }
    return Boolean(controls && pet);
  }, 'owned controls and pet');
  controls.setDefaultTimeout(15000); pet.setDefaultTimeout(15000);
  await Promise.all([controls.reload(), pet.reload()]);
  await controls.waitForSelector('#character-name', { state: 'attached' }); await openCards();
  if (!legacy) await controls.waitForSelector('#character-response-controls');
  await controls.evaluate(() => { globalThis.__responseStream = []; window.desktop.onStream(event => globalThis.__responseStream.push(event)); });
}
async function chatGesture(text, id) {
  plans.set(text, { gesture: 'explain', context: 'neutral' });
  await controls.evaluate(({ text, id }) => window.desktop.chat({ id, messages: [{ role: 'user', content: text }], attachments: [] }), { text, id });
  await poll(() => controls.evaluate(id => globalThis.__responseStream.some(event => event.id === id && event.type === 'done'), id), 'synthetic gesture reply completed');
  assert.equal(await controls.evaluate(id => globalThis.__responseStream.some(event => event.id === id && event.type === 'error'), id), false);
}
try {
  // Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs); only registered messages are answered.
  claude = await createClaudeFixture({ root: temporary, respond: turn => {
    const text = turn.currentUser, plan = plans.get(text); assert.ok(plan, 'only registered local fixture chat');
    const marker = turn.nonce('state'); assert.ok(marker && /^[a-f0-9]{32}$/.test(marker));
    requests.push({ text, gesture: plan.gesture });
    return `这是原创隔离反应验收回复。\n<sh-state-${marker}>${JSON.stringify({ context: plan.context, delta: {}, reason: 'Synthetic response gate', confidence: 0.99, gesture: plan.gesture })}</sh-state-${marker}>`;
  } });
  // No HTTP origin is allowed: chat runs through the fake Claude Code process.
  const origin = null;
  instance = null;
  phase = 'bootstrap-v2-fixture'; await launch(origin, { legacy: Boolean(legacyExecutable) });
  const initial = await cards(); originalId = initial.activeId;
  const first = initial.cards.find(card => card.id === originalId), draft = baseDraft(first);
  draft.name = 'Original response fixture'; draft.description = 'Original synthetic description'; draft.personality = 'Original synthetic personality';
  draft.mood.parameters.sensitivity.O = 1.1; draft.mood.parameters.weights.close = 0.9; draft.mood.parameters.intensity.expression = 60;
  await controls.evaluate(({ id, draft }) => window.desktop.saveCharacterCard(draft, id), { id: originalId, draft });
  const second = { ...structuredClone(draft), name: 'Second response fixture', description: 'Second original description' };
  const next = await controls.evaluate(draft => window.desktop.saveCharacterCard(draft), second);
  secondId = next.cards.find(card => !initial.cards.some(old => old.id === card.id)).id;
  await controls.evaluate(async ({ provider, id }) => {
    await window.desktop.useBundledModel(); await window.desktop.bindCharacterModel(id, true);
    const settings = await window.desktop.getSettings(); await window.desktop.saveSettings({ ...settings,
      provider: { ...settings.provider, ...provider }, voice: { ...settings.voice, enabled: false, volume: 0 } });
  }, { provider: claude.provider, id: secondId });
  await pause(1300); const legacyCards = await readFile(path.join(profile, 'characters.json'), 'utf8'); await close();
  phase = 'load-existing-profile'; await launch(origin); await poll(() => controls.locator('#response-mood').isEnabled(), 'optional profile default loaded');
  assert.equal(await readFile(path.join(profile, 'characters.json'), 'utf8'), legacyCards);
  assert.deepEqual((await response(originalId)).profile, emptyProfile());
  assert.equal(await readFile(sidecarFile, 'utf8').catch(() => null), null, 'missing optional sidecar is not rewritten');
  const oldCards = await cards(), oldSettingsBytes = await readFile(path.join(profile, 'settings.json'), 'utf8');
  assert.equal(oldCards.activeId, originalId); assert.equal(oldCards.cards.find(card => card.id === secondId).modelName, 'gene.pmx');
  pass('existing v2 card IDs, text, tuned common parameters and model bindings load without writing an optional response sidecar');

  phase = 'nine-slider-draft';
  const when = { mood: (await mood()).snapshot.primary, phase: 'rua', context: 'positive' };
  const beforeReward = rewardState(await mood()); await newRule(when);
  const t = { playful: 120, close: 80, comfortable: 110, cautious: 70 }, i = { expression: 60, gaze: 90, posture: 50, playful: 130, text: 140 };
  for (const [key, value] of Object.entries(t)) await setSlider('tendency', key, value);
  for (const [key, value] of Object.entries(i)) await setSlider('intensity', key, value);
  assert.equal(await controls.locator('#character-response-controls input[type="range"]').count(), 9);
  assert.deepEqual((await response(originalId)).profile, emptyProfile()); assert.deepEqual(rewardState(await mood()), beforeReward);
  assert.equal(await readFile(path.join(profile, 'characters.json'), 'utf8'), legacyCards);
  pass('all nine bounded sliders and mood/phase/context selectors edit a local draft without applying or creating a reward');
  originalResponse = { version: 1, rules: [rule(when,
    Object.fromEntries(Object.entries(t).map(([key, value]) => [key, value / 100])), Object.fromEntries(Object.entries(i).map(([key, value]) => [key, value / 100])))] };
  phase = 'sidecar-save'; await controls.locator('#response-save').click(); await savedUi(originalId, originalResponse);
  assert.equal(await readFile(path.join(profile, 'characters.json'), 'utf8'), legacyCards);
  assert.equal(await readFile(path.join(profile, 'settings.json'), 'utf8'), oldSettingsBytes);
  assert.deepEqual((await cards()).cards, oldCards.cards); assert.deepEqual(rewardState(await mood()), beforeReward);
  const sidecar = JSON.parse(await readFile(sidecarFile, 'utf8'));
  assert.deepEqual(sidecar.profiles, [{ characterId: originalId, profile: originalResponse }]);
  assert.equal(JSON.stringify(sidecar).includes('modelPath'), false); assert.equal(JSON.stringify(sidecar).includes('currentValues'), false);
  const image = 'character-response-controls.png'; await controls.locator('#character-response-controls').screenshot({ path: path.join(output, image) }); screenshots.push(image);
  pass('saving commits only the response sidecar while cards/settings bytes and live mood values, common parameters and reward state remain');

  phase = 'dirty-card-switch'; await setSlider('intensity', 'expression', 65); await selectCard(secondId); await selectCard(originalId);
  assert.equal(await controls.locator('#response-intensity-expression').inputValue(), '65');
  assert.deepEqual((await response(originalId)).profile, originalResponse);
  await controls.locator('#response-revert').click(); assert.equal(await controls.locator('#response-intensity-expression').inputValue(), '60');
  pass('per-character dirty response drafts survive card switches; explicit revert restores only the saved response template');

  phase = 'v2-v3-exports'; await selectCard(secondId); const v2 = await exportUi('empty-v2.json'); assert.equal(v2.version, 2);
  await selectCard(originalId); const v3 = await exportUi('with-response-v3.json'); assert.equal(v3.version, 3);
  assert.deepEqual(v3.card.responseProfile, originalResponse);
  for (const content of [v2.card, v3.card]) for (const key of ['id', 'modelPath', 'modelName', 'provider', 'permissions', 'apiKey', 'values', 'history']) assert.equal(Object.hasOwn(content, key), false);
  pass('empty response exports stay v2; nonempty profiles export v3 without bindings, IDs, keys, runtime state or execution permissions');
  phase = 'real-import-validation';
  const v2Card = await importUi(JSON.stringify(v2), 'import-v2.json'); assert.deepEqual((await response(v2Card.id)).profile, emptyProfile());
  const v3Card = await importUi(JSON.stringify(v3), 'import-v3.json'); assert.deepEqual((await response(v3Card.id)).profile, originalResponse);
  assert.notEqual(v2Card.id, secondId); assert.notEqual(v3Card.id, originalId);
  for (const unsafe of [
    { ...structuredClone(v3), card: { ...structuredClone(v3.card), modelPath: 'C:/forbidden-model.pmx' } },
    { ...structuredClone(v3), card: { ...structuredClone(v3.card), permissions: { shell: true } } },
    { ...structuredClone(v3), card: { ...structuredClone(v3.card), responseProfile: { ...originalResponse, values: { O: 100 } } } },
    { ...structuredClone(v3), card: { ...structuredClone(v3.card), responseProfile: { version: 1, rules: [{ ...originalResponse.rules[0], script: 'execute()' }] } } },
  ]) {
    const badFile = path.join(files, 'unsafe.json'); await writeFile(badFile, JSON.stringify(unsafe)); await nativeFile('open', badFile);
    const before = await cards(), bytes = await readFile(sidecarFile, 'utf8');
    assert.equal(await controls.evaluate(async () => { try { await window.desktop.importCharacterCard(); return false; } catch { return true; } }), true);
    assert.deepEqual(await cards(), before); assert.equal(await readFile(sidecarFile, 'utf8'), bytes);
  }
  pass('v2/v3 imports allocate one inactive new ID; malicious paths, permissions, current values and executable fields fail before writes');

  phase = 'strict-response-ipc';
  const validRule = originalResponse.rules[0];
  for (const invalid of [
    { ...originalResponse, path: 'C:/forbidden.json' },
    { version: 1, rules: [{ ...validRule, when: { mood: 'calm', phase: 'execute' } }] },
    { version: 1, rules: [{ ...validRule, intensityScale: { ...validRule.intensityScale, expression: Number.NaN } }] },
    { version: 1, rules: [validRule, validRule] },
  ]) {
    const bytes = await readFile(sidecarFile, 'utf8');
    assert.equal(await controls.evaluate(async ({ id, value }) => {
      try { await window.desktop.saveCharacterResponse(id, value); return false; } catch { return true; }
    }, { id: originalId, value: invalid }), true);
    assert.equal(await readFile(sidecarFile, 'utf8'), bytes);
  }
  assert.equal(await pet.evaluate(async id => {
    try { await window.desktop.saveCharacterResponse(id, { version: 1, rules: [] }); return false; } catch { return true; }
  }, originalId), true, 'the pet cannot acquire controls-only persistence authority');
  pass('strict live IPC rejects paths, invented phases, nonfinite scales and duplicate rules before writes; pet persistence is denied');

  phase = 'real-host-gates'; await selectCard(originalId);
  const base = await mood(), all = { version: 1, rules: moodKeys.map(mood => rule({ mood }, {}, { expression: 0.5, posture: 0 })) };
  await saveResponse(originalId, all); const styled = await mood();
  assert.equal(styled.snapshot.intensity.expression, base.snapshot.intensity.expression * 0.5);
  assert.equal(styled.snapshot.intensity.posture, 0); assert.deepEqual(rewardState(styled), rewardState(base));
  const phaseProfile = { version: 1, rules: [...all.rules, rule({ mood: styled.snapshot.primary, phase: 'rua' }, {}, { expression: 0, posture: 0 })] };
  await saveResponse(originalId, phaseProfile);
  await pet.evaluate(async () => { const current = await window.desktop.getMood(); await window.desktop.moodInteraction({ token: current.token, sessionId: 'response-phase-fixture', type: 'phase', phase: 'rua' }); });
  assert.equal((await mood()).snapshot.intensity.expression, 0); assert.deepEqual(rewardState(await mood()), rewardState(base));
  await pet.evaluate(async () => { const current = await window.desktop.getMood(); await window.desktop.moodInteraction({ token: current.token, sessionId: 'response-phase-fixture', type: 'phase', phase: 'idle' }); });
  await saveResponse(originalId, all);
  await chatGesture('RESPONSE_GESTURE_SUPPRESSED', 'response-gesture-suppressed'); assert.equal((await mood()).gesture, null);
  await saveResponse(originalId, emptyProfile()); await pause(200); assert.equal((await mood()).gesture, null, 'restoring posture cannot replay the consumed reply');
  await chatGesture('RESPONSE_GESTURE_ALLOWED', 'response-gesture-allowed');
  await poll(async () => Boolean((await mood()).gesture), 'new accepted reply has a host-owned gesture');
  const cue = (await mood()).gesture;
  await poll(() => pet.evaluate(id => { const value = JSON.parse(document.querySelector('#stage canvas')?.dataset.chatGesture ?? '{}'); return value.active && value.id === id; }, cue.id), 'approved local gesture reaches real stage');
  await saveResponse(originalId, all); assert.equal((await mood()).gesture, null);
  await saveResponse(originalId, originalResponse); await pause(200); assert.equal((await mood()).gesture, null);
  pass('real host snapshots honor style and phase without rewards; zero posture blocks/cancels automatic gestures and restoration never replays consumed cues');

  phase = 'restart-and-legacy-roundtrip'; await close();
  const persistedSidecar = await readFile(sidecarFile, 'utf8');
  if (legacyExecutable) {
    await launch(origin, { legacy: true }); const old = await cards(); const oldCard = old.cards.find(card => card.id === originalId);
    assert.deepEqual(oldCard.mood, oldCards.cards.find(card => card.id === originalId).mood);
    await controls.evaluate(({ id, draft }) => window.desktop.saveCharacterCard(draft, id), { id: originalId, draft: baseDraft(oldCard) });
    assert.equal(await readFile(sidecarFile, 'utf8'), persistedSidecar); await close();
  }
  await launch(origin); assert.deepEqual((await response(originalId)).profile, originalResponse); assert.equal(await readFile(sidecarFile, 'utf8'), persistedSidecar);
  assert.deepEqual((await cards()).cards.find(card => card.id === originalId).mood, oldCards.cards.find(card => card.id === originalId).mood);
  pass(legacyExecutable ? 'same synthetic profile survives actual legacy-package save and new-package restart with sidecar bytes and original tuning intact'
    : 'new-package restart preserves profiles and original common tuning (actual legacy package roundtrip not requested)');
  const faultStates = await Promise.all((await cards()).cards.map(card => response(card.id))); await close();

  phase = 'mock-late-get-and-event'; await launch(origin, { faultStates, delayId: originalId });
  await poll(() => instance.evaluate(() => globalThis.__responseQA.pending.length === 1), 'controlled delayed get');
  await selectCard(secondId);
  await instance.evaluate(() => { for (const pending of globalThis.__responseQA.pending.splice(0)) pending.resolve(pending.snapshot); });
  await pause(100); assert.equal(await controls.locator('#character-select').inputValue(), secondId);
  assert.equal(await controls.locator('#response-phase').inputValue(), '', 'late get does not replace another card editor');
  await selectCard(originalId); await choose(originalResponse.rules[0].when); await setSlider('intensity', 'expression', 65);
  await instance.evaluate(({ BrowserWindow }, id) => {
    const q = globalThis.__responseQA, state = structuredClone(q.states[id]); state.revision = Math.max(0, state.revision - 1);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('desk:character-response', state);
  }, originalId);
  await selectCard(secondId); await selectCard(originalId);
  assert.equal(await controls.locator('#response-intensity-expression').inputValue(), '65');
  await selectCard(secondId);
  await instance.evaluate(({ BrowserWindow }, id) => {
    const q = globalThis.__responseQA, newer = structuredClone(q.states[id]); newer.revision++;
    newer.profile.rules[0].intensityScale.expression = 0.9; q.states[id] = newer;
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('desk:character-response', newer);
  }, originalId);
  assert.equal(await controls.locator('#character-select').inputValue(), secondId, 'another card update does not switch the selected editor');
  await selectCard(originalId);
  assert.equal(await controls.locator('#response-intensity-expression').inputValue(), '65');
  assert.equal(await controls.locator('#response-save').isDisabled(), true, 'a real same-card conflict cannot overwrite a newer profile');
  assert.ok((await controls.locator('#response-status').textContent()).includes('较新'));
  await controls.locator('#response-revert').click(); assert.equal(await controls.locator('#response-intensity-expression').inputValue(), '90');
  mockPass('delayed get, older events and newer same-card conflicts cannot cross identity or overwrite a retained draft; explicit revert adopts the latest template');

  phase = 'mock-cancel-and-save-failure'; await setSlider('intensity', 'expression', 20);
  const savesBefore = await instance.evaluate(() => globalThis.__responseQA.saves.length); dialogDecision = 'dismiss'; await controls.locator('#response-save').click();
  await poll(() => controls.locator('#response-status').textContent().then(text => text.includes('草稿保留')), 'cancel keeps draft');
  assert.equal(await instance.evaluate(() => globalThis.__responseQA.saves.length), savesBefore);
  assert.equal(await controls.locator('#response-intensity-expression').inputValue(), '20');
  dialogDecision = 'accept'; await controls.locator('#response-save').click();
  await poll(() => controls.locator('#response-status').textContent().then(text => text.includes('未保存')), 'save failure surfaced');
  assert.equal(await controls.locator('#response-intensity-expression').inputValue(), '20');
  dialogDecision = 'accept'; await controls.locator('#response-save').click();
  await poll(() => controls.locator('#response-save').isDisabled(), 'same draft retry succeeds');
  assert.equal(await instance.evaluate(() => globalThis.__responseQA.saves.length), savesBefore + 2);
  assert.equal(await readFile(sidecarFile, 'utf8'), persistedSidecar, 'mock IPC outcomes do not masquerade as disk commits');
  mockPass('extended-setting confirmation cancellation and failed save preserve the draft; retry uses the same card and no real disk commit is claimed');

  phase = 'mock-copy-partial-failure';
  const beforeCopy = await cards(); await controls.locator('#character-duplicate').click(); await controls.locator('#character-name').fill('Copied once after synthetic failure');
  await controls.locator('#character-save').click();
  await poll(async () => (await cards()).cards.length === beforeCopy.cards.length + 1 && await controls.locator('#character-retry-response-copy').isVisible(), 'one base card retained after copy failure');
  const target = (await cards()).cards.find(card => !beforeCopy.cards.some(old => old.id === card.id)), copiedCardsBytes = await readFile(path.join(profile, 'characters.json'), 'utf8');
  await controls.locator('#character-retry-response-copy').click();
  await poll(() => controls.locator('#character-retry-response-copy').isHidden(), 'retry copied the response only');
  assert.equal((await cards()).cards.length, beforeCopy.cards.length + 1); assert.equal(await readFile(path.join(profile, 'characters.json'), 'utf8'), copiedCardsBytes);
  const copies = await instance.evaluate(() => globalThis.__responseQA.copies); assert.equal(copies.length, 2);
  assert.deepEqual(copies.map(value => value.targetId), [target.id, target.id]);
  mockPass('copy failure keeps one newly created ID; dedicated retry only copies that target profile and never creates another card');

  phase = 'mock-import-pending';
  const pendingProfile = { version: 1, rules: [rule({ mood: 'calm' }, {}, { expression: 0.8 })] };
  const beforePending = await instance.evaluate(() => globalThis.__responseQA.saves.length);
  await instance.evaluate(({ BrowserWindow }, { id, pendingProfile }) => {
    const state = { ...globalThis.__responseQA.states[id], pendingProfile, notice: 'Synthetic partial import: save this same ID only.' };
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('desk:character-response', state);
  }, { id: target.id, pendingProfile });
  await poll(() => controls.locator('#response-save').isEnabled(), 'pending response became an unsaved same-card draft');
  assert.equal(await instance.evaluate(() => globalThis.__responseQA.saves.length), beforePending, 'pending import never autosaves');
  await controls.locator('#response-save').click(); await poll(() => controls.locator('#response-save').isDisabled(), 'explicit pending draft save');
  assert.equal((await cards()).cards.length, beforeCopy.cards.length + 1); assert.equal(await controls.locator('#character-select').inputValue(), target.id);
  mockPass('partial-import retry event is retained as a same-ID draft; explicit save neither imports again nor grants another reward');
  await close();

  phase = 'final-real-readback'; await launch(origin); assert.deepEqual((await response(originalId)).profile, originalResponse);
  const runtime = await controls.evaluate(() => window.desktop.getRuntimeState());
  assert.equal(runtime.voiceInput || runtime.screenSharing || runtime.cameraSharing, false); await close();
  for (const run of guardRuns) { assert.deepEqual(run.remote, []); assert.deepEqual(run.permissions, []); assert.deepEqual(run.taskExecutions, []); assert.deepEqual(run.external, []); assert.equal(run.captures, 0); }
  assert.equal(requests.length, 2); assert.deepEqual(errors, []); claude.assertClean();
  pass('final real host readback remains unchanged after mock-only faults; all launches keep media, remote services, paid TTS and task execution off');
  report = { status: 'passed', ...identity, checks, mockChecks, localChatRequests: requests.length, uiDialogs, screenshots,
    legacyRoundtrip: legacyExecutable ? 'passed on the same disposable fixture profile' : 'skipped: MMD_TEST_LEGACY_EXE not supplied',
    guards: guardRuns, normalProfileUsed: false, physicalInputVerified: false,
    limits: ['Mock fault cases exercise real renderer/preload IPC with synthetic main handlers; disk-failure durability remains covered by service tests.',
      'Normal mood clock timestamps advance; retention checks compare original templates and live reward-state fields, not a stopped-clock fiction.',
      'Gesture requests use two synthetic Claude Code replies (fake CLI); no real Claude Code, model service, speaker listening or physical input acceptance is claimed.',
      'The response-panel screenshot requires separate visual review.'] };
} catch (error) {
  report = { status: 'failed', ...identity, phase, error: String(error), checks, mockChecks, errors, guards: guardRuns,
    normalProfileUsed: false, physicalInputVerified: false }; console.error(error); process.exitCode = 1;
} finally {
  if (instance) await close().catch(error => { errors.push(`close: ${error.message}`); process.exitCode = 1; });
  const fakeClaude = claude ? await claude.close() : null;
  const root = path.resolve(os.tmpdir()), owned = path.resolve(temporary);
  assert.equal(path.dirname(owned).toLowerCase(), root.toLowerCase()); assert.ok(path.basename(owned).startsWith('soft-character-response-e2e-'));
  if (closed) await rm(owned, { recursive: true, force: true }).catch(error => errors.push(`cleanup: ${error.message}`));
  report ??= { status: 'failed', phase, checks, mockChecks };
  if (!closed || errors.length || process.exitCode) { report.status = 'failed'; process.exitCode = 1; }
  report.errors = errors; report.cleanup = { appExited: closed, fakeClaude, temporaryProfileRemoved: closed && !errors.some(error => error.startsWith('cleanup:')) };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
