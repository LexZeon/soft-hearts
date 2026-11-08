// Maintainer command: pnpm exec tsx scripts/behavior-motion-smoke.mjs
// Run only on the coordinated immutable candidate; all state below is synthetic.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createMoodState, serializeMoodState, DEFAULT_MOOD_PARAMETERS } from '../shared/mood.ts';
import { DEFAULT_SETTINGS } from '../shared/defaults.ts';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.MMD_TEST_APP_DIR && await realpath(process.env.MMD_TEST_APP_DIR);
const executable = process.env.MMD_TEST_EXE && await realpath(process.env.MMD_TEST_EXE);
assert.ok(source && executable, 'Use an owner-validated frozen source and packaged executable.');
assert.notEqual(source.toLowerCase(), (await realpath(root)).toLowerCase());
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const name of ['shared/mood.ts', 'shared/contracts.ts', 'shared/defaults.ts'])
  assert.equal(sha(await readFile(path.join(root, name))), sha(await readFile(path.join(source, name))), 'Fixture helpers must match the frozen runtime source.');
const asar = path.join(path.dirname(executable), 'resources/app.asar');
const asarSha256 = sha(await readFile(asar)), harnessSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
const output = path.join(root, '.local/behavior-motion'); await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'soft-behavior-motion-'));
const cases = [
  { mood: 'calm', values: {}, binding: null },
  { mood: 'happy', values: { D: 80, E: 75 }, context: 'positive', binding: 'face.happy' },
  { mood: 'excited', values: { D: 95, N: 80, C: 45 }, context: 'positive', binding: 'face.laugh' },
  { mood: 'tense-expectation', values: { D: 95, N: 80, C: 80 }, context: 'positive', binding: 'face.in-trouble' },
  { mood: 'concerned', values: {}, context: 'concern', binding: 'face.compassion' },
  { mood: 'upset', values: { N: 80, C: 80 }, context: 'offense', binding: 'face.disgust' },
  { mood: 'disappointed', values: { D: 20 }, context: 'disappointment', binding: 'face.disappointed' },
  { mood: 'close', values: { O: 80, E: 65, C: 45 }, binding: 'face.embarrassed-smile' },
  { mood: 'content', values: { E: 80, C: 45 }, binding: 'face.smile' },
  { mood: 'longing', values: {}, longing: 40, binding: 'face.sentimental' },
  { mood: 'sad', values: {}, longing: 75, binding: 'face.sad' },
  { mood: 'relieved', values: {}, longing: 75, context: 'neutral', binding: 'face.sentimental' },
].map(value => ({ ...value, id: randomUUID() }));
const checks = [], rows = [], captures = [], errors = [], requests = [];
const responses = new Map(); let app, controls, pet, report, phase = 'fixtures', sequence = 0;
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs): only the declared messages are answered.
const claude = await createClaudeFixture({ respond: turn => {
  const fixture = responses.get(turn.currentUser);
  assert.ok(fixture, 'Only synthetic messages may reach the fake Claude Code.');
  const nonce = turn.nonce('state'); assert.ok(nonce && /^[a-f0-9]{32}$/.test(nonce));
  requests.push({ context: fixture.context, gesture: fixture.gesture });
  return `这是原创隔离表情验收回复。\n<sh-state-${nonce}>${JSON.stringify({ context: fixture.context, delta: {}, confidence: 0.99, reason: '合成场景', gesture: fixture.gesture })}</sh-state-${nonce}>`;
} });
const settings = structuredClone(DEFAULT_SETTINGS);
settings.provider = { ...settings.provider, ...claude.provider };
settings.voice.enabled = false; settings.voice.volume = 0;
settings.pet.followMouse = false; settings.pet.breath = 0; settings.pet.alwaysOnTop = false;
const now = Date.now();
await writeFile(path.join(profile, 'settings.json'), JSON.stringify(settings));
await writeFile(path.join(profile, 'characters.json'), JSON.stringify({ version: 1, activeId: cases[0].id,
  cards: cases.map(c => ({ id: c.id, name: `Fixture ${c.mood}`, description: '公开Gene合成状态验收；不是默认卡绑定。',
    personality: '均衡。', scenario: '', greeting: '', examples: '', systemPrompt: '',
    mood: { version: 1, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS) } })) }));
await writeFile(path.join(profile, 'mood-state.json'), JSON.stringify({ version: 1, profiles: cases.map(c => {
  const state = createMoodState(now); Object.assign(state.values, c.values);
  if (c.longing) { state.lastInteractionAt = now - DEFAULT_MOOD_PARAMETERS.longing.graceMs - c.longing / DEFAULT_MOOD_PARAMETERS.longing.perHour * 3_600_000; state.longing = c.longing; }
  return { characterId: c.id, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), state: serializeMoodState(state) };
}) }));
const check = label => { checks.push(label); console.log(`PASS ${label}`); };
async function poll(page, predicate, arg, timeout = 25_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await page.evaluate(predicate, arg)) return; await page.waitForTimeout(35); }
  throw Error(`Timeout ${phase}`);
}
const mood = () => controls.evaluate(() => window.desktop.getMood());
const frame = () => pet.evaluate(() => {
  const c = document.querySelector('#stage canvas'); return {
    motion: JSON.parse(c?.dataset.behaviorMotion ?? 'null'),
    base: JSON.parse(c?.dataset.chatGesture ?? '{}'), feedback: JSON.parse(c?.dataset.moodFeedback ?? '{}'),
  };
});
async function chat(context = 'neutral', gesture = 'none') {
  const id = `binding-${++sequence}`, text = `原创合成场景${sequence}`;
  responses.set(text, { context, gesture });
  await controls.evaluate(({ id, text }) => window.desktop.chat({ id, messages: [{ role: 'user', content: text }], attachments: [] }), { id, text });
  await poll(controls, id => window.__behaviorEvents.some(e => e.id === id && ['done', 'error'].includes(e.type)), id);
  const events = await controls.evaluate(id => window.__behaviorEvents.filter(e => e.id === id), id);
  assert.equal(events.some(e => e.type === 'error'), false); return id;
}
async function capture(name) {
  await pet.locator('#stage').screenshot({ path: path.join(output, name), omitBackground: true }); captures.push(name);
}
try {
  phase = 'launch';
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile }); delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], cwd: source, env });
  await claude.install(app);
  await app.firstWindow();
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath(), pid: process.pid }));
  assert.ok(identity.packaged); assert.equal(path.resolve(identity.profile), profile);
  assert.equal((await realpath(identity.appPath)).toLowerCase(), (await realpath(asar)).toLowerCase());
  await app.evaluate(({ session }) => {
    globalThis.__behaviorDenied = []; globalThis.__behaviorPermissions = [];
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_w, name, done) => { globalThis.__behaviorPermissions.push(name); done(false); });
  });
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (event, done) => {
      const denied = /^https?:/i.test(event.url);
      if (denied) globalThis.__behaviorDenied.push(event.url); done({ cancel: denied });
    });
  });
  for (let i = 0; i < 200 && (!controls || !pet); i++) {
    for (const page of app.windows()) {
      if (!page.url().includes('index.html')) continue;
      page.on('pageerror', error => errors.push(error.message));
      if (new URL(page.url()).searchParams.has('pet')) pet = page; else controls = page;
    }
    if (!controls || !pet) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(controls && pet);
  await controls.evaluate(async () => {
    window.__behaviorEvents = []; window.desktop.onStream(e => window.__behaviorEvents.push(e));
    await window.desktop.useBundledModel(); await window.desktop.recoverPet();
    await window.desktop.setMoodDeveloperMode(true); await window.desktop.setMoodExpressions(true);
  });
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('index.html')) w.setTitle('soft hearts · 行为映射 Gene 隔离验收'); });
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.motionTransition ?? '{}').layerTimes?.pose !== undefined);
  assert.equal(await controls.evaluate(() => window.desktop.isBehaviorModelSupported()), true, 'The content-verified bundled Gene target must be supported.');
  check('packaged identity and content-verified Gene target support');
  for (const c of cases) {
    phase = c.mood; await controls.evaluate(id => window.desktop.activateCharacterCard(id), c.id);
    if (c.context) await chat(c.context);
    await poll(controls, expected => window.desktop.getMood().then(v => v.snapshot.primary === expected), c.mood);
    if (c.binding) {
      await poll(pet, binding => { const v = JSON.parse(document.querySelector('#stage canvas')?.dataset.behaviorMotion ?? 'null');
        return v?.state.active && v.state.bindingId === binding && v.state.weight > 0 && v.state.samples.some(s => Math.abs(s.value - s.base) > 0.005); }, c.binding);
      const before = await frame(); await pet.waitForTimeout(400); const after = await frame();
      assert.equal(before.motion.state.id, after.motion.state.id); assert.ok(after.motion.state.elapsedMs > before.motion.state.elapsedMs);
      assert.ok(after.base.baseTime >= before.base.baseTime); assert.ok(after.motion.state.propertyIndices.length > 0);
      assert.ok(after.motion.state.weight > 0 && after.motion.state.samples.some(s => Math.abs(s.value - s.base) > 0.005), 'Approved properties must actually change the rendered value at positive weight.');
      rows.push({ mood: c.mood, expectedBinding: c.binding, actual: after, snapshot: (await mood()).snapshot });
    } else { assert.equal((await mood()).behavior.state, null); rows.push({ mood: c.mood, fallback: 'existing-procedural-idle' }); }
    await capture(`gene-binding-${c.mood}.png`); check(`state ${c.mood}: real approved face properties or explicit calm fallback`);
  }
  phase = 'neutral-reaction'; await controls.evaluate(id => window.desktop.activateCharacterCard(id), cases[0].id); await chat();
  await poll(pet, () => { const v = JSON.parse(document.querySelector('#stage canvas')?.dataset.behaviorMotion ?? 'null'); return v?.reaction.active && v.reaction.bindingId === 'face.convinced'; });
  rows.push({ cue: 'neutral-satisfied', actual: await frame() }); check('neutral acknowledgement uses convinced rather than unconditional happy');
  phase = 'manual-priority'; await controls.evaluate(() => window.desktop.installMotionPack('gene', 'happy', 'expression'));
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').faceBlocked === true);
  assert.equal((await frame()).motion.active, false); check('manual expression owns the face and cancels automatic output');
  await controls.evaluate(() => window.desktop.clearMotionLayer('expression'));
  phase = 'privacy';
  assert.deepEqual(await controls.evaluate(() => window.desktop.getRuntimeState()), { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null });
  assert.deepEqual(await controls.evaluate(() => window.desktop.getSystemAudioState()), { active: false });
  const privacy = await app.evaluate(() => ({ denied: globalThis.__behaviorDenied, permissions: globalThis.__behaviorPermissions }));
  assert.deepEqual(privacy, { denied: [], permissions: [] }); assert.deepEqual(errors, []); claude.assertClean();
  assert.deepEqual((await claude.evidence(app)).denied, [], 'Every Claude Code launch went to the fake.');
  const persisted = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'));
  assert.equal(JSON.stringify(persisted).includes('face.'), false);
  assert.equal(sha(await readFile(asar)), asarSha256);
  report = { status: 'passed-pending-visual-review', source, executable, asarSha256, harnessSha256, identity, profile,
    checks, rows, captures, requests, privacy, errors,
    limits: ['Synthetic saved mood fixtures with unchanged Gene parameter templates; not user tuning approval or default-card model binding proof.',
      'Public Gene only; no normal profile, real provider, voice, microphone, camera or system audio.',
      'Restricted eyebrow/eye samples are not original whole-body or mouth/blush performance; hold/loop are not enabled.'] };
} catch (error) {
  process.exitCode = 1; let diagnostic; try { diagnostic = pet && await frame(); } catch {}
  report = { status: 'failed', phase, error: String(error.stack ?? error), source, executable, asarSha256, harnessSha256, profile, checks, rows, captures, requests, errors, diagnostic };
  console.error(error);
} finally {
  try { if (app) await app.close(); } finally { const closed = await claude.close(); if (report) report.fakeClaude = closed; }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
