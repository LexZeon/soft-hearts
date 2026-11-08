import assert from 'node:assert/strict';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// A frozen source or explicit packaged executable + fresh private profile only.
// MMD_TEST_APP_DIR remains the independent frozen source; coordinate the native slot.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR ?? '');
assert.ok(process.env.MMD_TEST_APP_DIR && (await realpath(appDirectory)).toLowerCase() !== (await realpath(workspace)).toLowerCase(), 'Use an independent frozen app directory.');
const executable = process.env.MMD_TEST_EXE ? path.resolve(process.env.MMD_TEST_EXE) : null;
const packagedAsar = executable ? path.join(path.dirname(executable), 'resources', 'app.asar') : null;
const packagedAsarHash = packagedAsar ? createHash('sha256').update(await readFile(packagedAsar)).digest('hex') : null;
const output = path.join(workspace, '.local/mood-template-smoke');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'soft-mood-template-'));
const checks = [], errors = [], requests = [], images = [];
let instance, controls, pet, phase = 'launch', sequence = 0, report, appIdentity;
let responsePlan = { context: 'neutral', delta: {}, reason: '原创隔离测试', confidence: 0.99 };
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs) that appends this turn's state tail.
const claude = await createClaudeFixture({ respond: turn => {
  requests.push({ currentUser: turn.currentUser, opening: turn.opening });
  const marker = turn.nonce('state');
  const tail = marker ? `\n<sh-state-${marker}>${JSON.stringify(responsePlan)}</sh-state-${marker}>` : '';
  return `原创测试回复。${tail}`;
} });
const check = label => { checks.push(label); console.log(`PASS ${label}`); };
async function poll(page, predicate, arg, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await page.evaluate(predicate, arg)) return; await page.waitForTimeout(50); }
  throw Error(`Timeout: ${phase}`);
}
async function mood() { return controls.evaluate(() => window.desktop.getMood()); }
async function frame() { return pet.evaluate(() => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}')); }
async function capture(label) {
  await pet.locator('#stage').screenshot({ path: path.join(output, `${label}.png`), omitBackground: true }); images.push(`${label}.png`);
}
async function chat(text, plan = responsePlan, timeout = 30_000) {
  responsePlan = plan; const id = `template-smoke-${++sequence}`;
  await controls.evaluate(({ id, text }) => window.desktop.chat({ id, messages: [{ role: 'user', content: text }], attachments: [] }), { id, text });
  await poll(controls, id => window.__moodTemplateEvents.some(event => event.id === id && ['done', 'error'].includes(event.type)), id, timeout);
  const events = await controls.evaluate(id => window.__moodTemplateEvents.filter(event => event.id === id), id);
  assert.ok(!events.some(event => event.type === 'error'), events.find(event => event.type === 'error')?.text);
  return events.filter(event => event.type === 'delta').map(event => event.text).join('');
}
const runtime = path.join(appDirectory, 'dist-electron/main.cjs');
const runtimeHash = createHash('sha256').update(await readFile(runtime)).digest('hex');
try {
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE; delete env.MMD_TEST_EXE; delete env.VITE_DEV_SERVER_URL;
  instance = await electron.launch({
    ...(executable ? { executablePath: executable, args: [`--user-data-dir=${profile}`] }
      : { args: [appDirectory, `--user-data-dir=${profile}`] }),
    cwd: appDirectory, env, timeout: 30_000,
  });
  await claude.install(instance);
  const watched = new WeakSet();
  const watch = page => { if (watched.has(page)) return; watched.add(page); page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('ERR_ABORTED')) errors.push(message.text()); }); };
  instance.on('window', watch); await instance.firstWindow();
  appIdentity = await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath() }));
  assert.equal(path.resolve(appIdentity.profile), profile);
  assert.equal(appIdentity.packaged, Boolean(executable));
  assert.equal(path.resolve(appIdentity.appPath).toLowerCase(), path.resolve(packagedAsar ?? appDirectory).toLowerCase());
  await instance.evaluate(({ session }) => {
    globalThis.__templateRemote = []; globalThis.__templatePermissions = [];
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
      const denied = /^https?:/i.test(details.url);
      if (denied) globalThis.__templateRemote.push(details.url); done({ cancel: denied });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => { globalThis.__templatePermissions.push(permission); callback(false); });
  });
  for (let i = 0; i < 150 && (!controls || !pet); i++) {
    for (const page of instance.windows()) {
      watch(page); const url = new URL(page.url()); if (!url.pathname.endsWith('/index.html')) continue;
      if (url.searchParams.has('pet')) pet = page; else controls = page;
    }
    if (!controls || !pet) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(controls && pet); controls.setDefaultTimeout(20_000); pet.setDefaultTimeout(20_000);
  await controls.waitForFunction(() => typeof window.desktop?.getMood === 'function');
  await pet.waitForFunction(() => typeof window.desktop?.getMood === 'function');
  await controls.evaluate(async provider => {
    window.__moodTemplateEvents = []; window.desktop.onStream(event => window.__moodTemplateEvents.push(event));
    const settings = await window.desktop.getSettings();
    settings.provider = { ...settings.provider, ...provider };
    settings.voice.enabled = false; if (settings.tts) settings.tts.enabled = false;
    settings.pet.followMouse = false; await window.desktop.saveSettings(settings);
    await window.desktop.useBundledModel(); await window.desktop.recoverPet();
    await window.desktop.setMoodDeveloperMode(true);
  }, claude.provider);
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').blushChannel === '赤み', undefined, 60_000);
  const originalId = (await mood()).characterId;
  check('isolated profile, public Gene geometry discovers one 赤み vertex channel, devices off');

  phase = 'numeric-card-ui';
  await navigateControlPage(controls, 'providers');
  await controls.locator('#character-new').click();
  await controls.locator('#character-name').fill('原创数值角色');
  await controls.locator('#character-mood-advanced').evaluate(element => { element.open = true; });
  const template = await controls.locator('#character-mood-template').inputValue().then(JSON.parse);
  template.parameters.baseline.O = 60; template.parameters.sensitivity.O = 1.4;
  template.parameters.weights.comfortable = 1.4;
  template.parameters.weights.close = 0.8;
  template.parameters.blush.cooldownMs = 0;
  await controls.locator('#character-mood-template').fill(JSON.stringify(template, null, 2));
  await controls.locator('#character-save-activate').click();
  await poll(controls, async () => (await window.desktop.getMood()).parameters.sensitivity.O === 1.4);
  let view = await mood(); const numericId = view.characterId;
  assert.notEqual(numericId, originalId); assert.equal(view.snapshot.values.O, 60); assert.equal(view.snapshot.lastInteractionAt, null);
  assert.equal((await controls.evaluate(() => window.desktop.getCharacterCards())).cards.find(card => card.id === numericId).mood.parameters.sensitivity.O, 1.4);
  const beforeEvent = view.snapshot.values.O;
  await chat('原创亲近事件', { context: 'support', delta: { O: 6, E: 6 }, reason: '受到原创友好支持', confidence: 0.99 });
  view = await mood(); assert.ok(view.snapshot.values.O > beforeEvent + 5);
  const afterEvent = view.snapshot.values.O;
  await controls.evaluate(async () => { const view = await window.desktop.getMood(); view.parameters.sensitivity.O = 1.1; await window.desktop.setMoodParameters(view.parameters, { characterId: view.characterId, token: view.token }); });
  assert.equal((await controls.evaluate(() => window.desktop.getCharacterCards())).cards.find(card => card.id === numericId).mood.parameters.sensitivity.O, 1.1);
  assert.ok(Math.abs((await mood()).snapshot.values.O - afterEvent) < 0.1);
  check('UI numeric card save/activate/readback drives real baseline and accepted event; developer edits persist to card without resetting state');

  phase = 'copy-export-import';
  await controls.locator('#character-duplicate').click();
  assert.equal(JSON.parse(await controls.locator('#character-mood-template').inputValue()).parameters.sensitivity.O, 1.1);
  await controls.locator('#character-save-activate').click();
  await poll(controls, async numericId => (await window.desktop.getMood()).characterId !== numericId, numericId);
  const copyId = (await mood()).characterId;
  assert.equal((await mood()).snapshot.values.O, 60); assert.equal((await mood()).snapshot.lastInteractionAt, null);
  const exportFile = path.join(profile, 'original-portable-card.json');
  await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, exportFile);
  await controls.locator('#character-export').click();
  const exported = JSON.parse(await readFile(exportFile, 'utf8'));
  assert.equal(exported.version, 2); assert.equal(exported.card.mood.version, 1); assert.equal(exported.card.mood.parameters.sensitivity.O, 1.1);
  assert.ok(!JSON.stringify(exported).includes('lastInteractionAt') && !JSON.stringify(exported).includes('modelPath'));
  await controls.locator('#character-import').click();
  await poll(controls, async () => (await window.desktop.getCharacterCards()).cards.length === 4);
  assert.equal((await mood()).characterId, copyId, 'import is not activation');
  await controls.evaluate(id => window.desktop.activateCharacterCard(id), numericId);
  assert.ok(Math.abs((await mood()).snapshot.values.O - afterEvent) < 0.2);
  check('UI copy includes template but fresh experience; real host file export/import v2 preserves parameters, import stays inactive, switching returns private state');

  phase = 'mixed-concern';
  await controls.evaluate(async () => { await window.desktop.setMoodExpressions(false); await window.desktop.setMoodExpressions(true); });
  await chat('原创测试：我有点担心明天的安排。', { context: 'concern', delta: { C: 6, N: 6, D: -6 }, reason: '认真关切原创测试话题', confidence: 0.99 });
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').primary === 'concerned');
  const serious = await frame(); assert.equal(serious.smile, 0); assert.ok(serious.eventNegative > 0); assert.equal(serious.companion, 'comfortable');
  await capture('gene-concern-with-comfort');
  check('concern remains primary with comfortable companion; real stage consumes negative event direction without forced smile');

  phase = 'blush-visible-envelope';
  await capture('gene-before-blush');
  await chat('原创测试：谢谢你陪着我，和你在一起很安心。', { context: 'support', delta: { O: 6, E: 3, C: -3 }, reason: '新的原创亲近支持事件', confidence: 0.99 });
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').blush > 0.1);
  await pet.waitForTimeout(350); const peak = await frame(); await capture('gene-blush-peak');
  assert.ok(peak.blush > 0.1 && peak.blush <= 0.35); assert.equal(peak.blushPath, 'procedural');
  const lastInteraction = (await mood()).snapshot.lastInteractionAt;
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').blush === 0, undefined, 10_000);
  await capture('gene-after-blush'); assert.equal((await mood()).snapshot.lastInteractionAt, lastInteraction);
  check('causal procedural cheek blush rises, holds and fades without another reward or morph stacking; before/peak/after captures require visual review');

  phase = 'size-calibration';
  await controls.evaluate(async () => { const view = await window.desktop.getMood(); view.parameters.blush.holdMs = 12_000; view.parameters.blush.intensity = 80; await window.desktop.setMoodParameters(view.parameters, { characterId: view.characterId, token: view.token }); });
  await chat('原创测试：双颊大小滑块的持续支持样本。', { context: 'support', delta: { O: 6, E: 2 }, reason: '大小独立测试', confidence: 0.99 });
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').blush > 0.1);
  const sizeSlider = controls.locator('#character-blush-size');
  await sizeSlider.focus(); await sizeSlider.press('Home');
  for (let i = 0; i < 20; i++) await sizeSlider.press('ArrowRight');
  await controls.locator('#character-save').click();
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').blushSize === 20);
  const small = await frame(); await capture('gene-blush-small');
  await sizeSlider.focus(); await sizeSlider.press('End');
  for (let i = 0; i < 20; i++) await sizeSlider.press('ArrowLeft');
  await controls.locator('#character-save').click();
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').blushSize === 80);
  const large = await frame(); await capture('gene-blush-large');
  assert.ok(Math.abs(small.blush - large.blush) < 0.005, 'size does not silently alter envelope opacity');
  const calibration = await controls.evaluate(() => window.desktop.getBlushCalibration());
  assert.match(calibration.modelKey, /^[a-f0-9]{64}$/);
  const petWriteDenied = await pet.evaluate(async view => { try { await window.desktop.setBlushCalibration(view.modelKey, view.calibration); return false; } catch { return true; } }, calibration);
  assert.equal(petWriteDenied, true);
  await controls.locator('#blush-calibration-eyeOffsetY').focus();
  await controls.locator('#blush-calibration-eyeOffsetY').press('ArrowRight');
  await controls.locator('#blush-calibration-apply').click();
  await poll(controls, async () => (await window.desktop.getBlushCalibration()).calibration.eyeOffsetY > 0);
  assert.equal((await controls.evaluate(() => window.desktop.getCharacterCards())).cards.find(card => card.id === numericId).mood.parameters.blush.size, 80);
  await controls.evaluate(async calibration => {
    await window.desktop.setBlushCalibration(calibration.modelKey, calibration.calibration);
    const view = await window.desktop.getMood(); view.parameters.blush.holdMs = 1200; view.parameters.blush.size = 50; view.parameters.blush.intensity = 35;
    await window.desktop.setMoodParameters(view.parameters, { characterId: view.characterId, token: view.token });
    await window.desktop.setMoodExpressions(false); await window.desktop.setMoodExpressions(true);
  }, calibration);
  check('native keyboard size slider changes area independently of opacity; local model hash calibration persists separately and pet writes are denied');

  phase = 'manual-face-pause-zero-model';
  await controls.evaluate(() => window.desktop.installMotionPack('gene', 'happy', 'expression'));
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').faceBlocked === true);
  await chat('原创测试：这句支持只测手选表情优先。', { context: 'support', delta: { O: 5, E: 2 }, reason: '手选表情冲突测试', confidence: 0.99 });
  await pet.waitForTimeout(600); assert.equal((await frame()).blush, 0);
  await controls.evaluate(() => window.desktop.clearMotionLayer('expression'));
  await pet.waitForTimeout(200); assert.equal((await frame()).blush, 0, 'blocked cue never restarts late');
  await pet.waitForTimeout(3_500);
  await chat('原创测试：新的支持事件可用于暂停测试。', { context: 'support', delta: { O: 5, E: 2 }, reason: '暂停测试', confidence: 0.99 });
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').blush > 0.1);
  await controls.evaluate(() => window.desktop.setMoodExpressions(false));
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').blush === 0);
  assert.equal((await mood()).snapshot.blush, null);
  await controls.evaluate(async () => { await window.desktop.setMoodExpressions(true); const view = await window.desktop.getMood(); view.parameters.blush.intensity = 0; await window.desktop.setMoodParameters(view.parameters, { characterId: view.characterId, token: view.token }); });
  await chat('原创测试：零强度支持事件。', { context: 'support', delta: { O: 5 }, reason: '零强度测试', confidence: 0.99 });
  await pet.waitForTimeout(600); assert.equal((await frame()).blush, 0); assert.equal((await mood()).snapshot.blush, null);
  await controls.evaluate(() => window.desktop.useBundledModel());
  assert.equal((await mood()).snapshot.blush, null);
  check('manual facial VMD priority, no late replay, pause clears cue, strength zero disables, model lifecycle leaves no transient blush');

  phase = 'scalp-and-emoji';
  await controls.evaluate(() => window.desktop.recoverPet());
  await pet.waitForTimeout(500);
  await pet.bringToFront();
  await pet.waitForTimeout(150);
  const target = await pet.evaluate(() => ({ head: JSON.parse(document.querySelector('#stage canvas').dataset.interactionRegion), rect: document.querySelector('#stage').getBoundingClientRect().toJSON() }));
  const scalpX = target.rect.left + target.head.x - target.head.axisYX * 0.65;
  const scalpY = target.rect.top + target.head.y - target.head.axisYY * 0.65;
  await pet.mouse.move(scalpX, scalpY);
  await poll(pet, () => !document.querySelector('[data-pet-interaction-cursor]')?.hidden && document.querySelector('[data-pet-interaction-cursor]')?.textContent === '👋');
  assert.equal((await mood()).snapshot.phase, 'rua');
  const still = (await mood()).snapshot.values.O; await pet.waitForTimeout(700);
  assert.ok((await mood()).snapshot.values.O <= still + 0.02, 'static emoji contact cannot mint a reward');
  await capture('gene-scalp-hand-cursor');
  await pet.mouse.move(target.rect.left + target.head.x + target.head.axisYX * 1.6, target.rect.top + target.head.y + target.head.axisYY * 1.6);
  await poll(pet, () => document.querySelector('[data-pet-interaction-cursor]')?.hidden === true);
  await poll(controls, async () => (await window.desktop.getMood()).snapshot.phase === 'idle');
  assert.equal((await mood()).snapshot.phase, 'idle');
  const feedingRadius = target.head.mouthRadius, referenceWidth = target.head.referenceWidth;
  assert.ok(feedingRadius > 0 && referenceWidth > 0);
  check('actual upper-scalp pointer contact displays 👋 immediately, static contact gives no reward, lower face exits and restores cursor; W and feeding radius remain separate');

  // The former MMD_MOOD_LIVE_CHAT=1 phase drove the user's real Codex login; it was removed with Codex chat.
  // Real Claude Code chat is checked separately (SOFT_HEARTS_CLAUDE_LIVE=1 tests/claude.test.ts), never from a smoke.
  assert.deepEqual(errors, []); claude.assertClean(); assert.deepEqual((await claude.evidence(instance)).denied, []);
  const privacy = await instance.evaluate(() => ({ remote: globalThis.__templateRemote, permissions: globalThis.__templatePermissions }));
  assert.deepEqual(privacy.remote, []); assert.deepEqual(privacy.permissions, []);
  assert.equal(createHash('sha256').update(await readFile(runtime)).digest('hex'), runtimeHash);
  if (packagedAsar) assert.equal(createHash('sha256').update(await readFile(packagedAsar)).digest('hex'), packagedAsarHash);
  report = { status: 'passed', checks, errors, privacy, fakeClaudeTurns: requests.length, images, appDirectory, runtimeHash, profile, appIdentity, packagedAsarHash,
    limits: ['Only public Gene stage captures; no desktop screenshots.', 'The fake Claude Code checks are not real Claude Code or model-service verification.', 'Native file dialogs use explicit isolated fixture paths; Windows Explorer drag is a separate check.'] };
} catch (error) {
  const diagnostic = pet ? await pet.evaluate(async () => ({ head: document.querySelector('#stage canvas')?.dataset.interactionRegion,
    frame: document.querySelector('#stage canvas')?.dataset.moodFeedback, body: document.body.className,
    cursor: document.querySelector('[data-pet-interaction-cursor]')?.outerHTML, mood: await window.desktop.getMood() })).catch(() => null) : null;
  report = { status: 'failed', phase, error: String(error.stack ?? error), checks, errors, diagnostic, profile, appDirectory, runtimeHash, appIdentity, packagedAsarHash };
  process.exitCode = 1; console.error(`${phase}: ${error.message}`);
} finally {
  try { if (instance) await instance.close(); } finally { const closed = await claude.close(); if (report) report.fakeClaude = closed; }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
