import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { armSmokeWatchdog, closeElectron } from './lib/electron-cleanup.mjs';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// Run only in the coordinated native slot against an independently frozen app.
// The fresh profile and screenshots contain synthetic chat and public Gene only.
// MMD_TEST_APP_DIR stays the frozen source; optional MMD_TEST_EXE selects its package.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Source mode runs this checkout's own build (`pnpm build` first); MMD_TEST_APP_DIR still selects another build. The
// Codex-era "independent frozen app, never the shared working build" rule belonged to its shared multi-agent workspace
// and native slot (2026-11-02 smoke triage); runtimeHashes still prove the build did not change during the run.
const appDirectory = await realpath(path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace));
const executable = process.env.MMD_TEST_EXE ? await realpath(path.resolve(process.env.MMD_TEST_EXE)) : null;
const packagedAsar = executable ? await realpath(path.join(path.dirname(executable), 'resources/app.asar')) : null;
const packagedAsarHash = packagedAsar ? createHash('sha256').update(await readFile(packagedAsar)).digest('hex') : null;
const output = path.join(workspace, '.local/chat-gesture-smoke');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'soft-chat-gesture-'));
const settingsFile = path.join(profile, 'settings.json');
const checks = [], errors = [], fixtureErrors = [], requests = [], captures = [], performances = [];
const fixtures = {
  explain: { packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2', durationMs: 6_000,
    sha256: '6abec61bc8fde28e6d340c9c7cdd00e08edd2340c3939efc3ab041fdf327748d' },
  upbeat: { packId: 'mpi-embm-gestures', motionId: 'conversation-joy', durationMs: 2_933.333,
    sha256: '027860a2db2891277a36e723dc69300b16828a701e33169ec29edd3397db710b' },
};
const plans = new Map();
let instance, controls, pet, report, appIdentity, concurrency, phase = 'freeze-check', sequence = 0;
// A failing or hung run still closes its own window (scripts/lib/electron-cleanup.mjs).
const disarm = armSmokeWatchdog(() => instance, 480_000, 'chat-gesture-smoke');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs): body first, then the state tail in two pieces.
const claude = await createClaudeFixture({ respond: async turn => {
  try {
    const plan = plans.get(turn.currentUser); assert.ok(plan, 'Only registered synthetic messages reach the mock.');
    const marker = turn.nonce('state');
    assert.ok(marker && /^[a-f0-9]{32}$/.test(marker), 'Normal chat includes the random bounded appraisal protocol.');
    requests.push({ id: plan.id, gesture: plan.gesture, context: plan.context, markerPresent: true });
    const tail = `\n<sh-state-${marker}>${JSON.stringify({ context: plan.context, delta: plan.delta,
      reason: plan.reason, confidence: 0.99, gesture: plan.gesture })}</sh-state-${marker}>`;
    turn.delta('这是隔离服务的原创会话动作测试回复。');
    await pause(plan.delayMs ?? 35);
    if (turn.cancelled) return;
    turn.delta(tail.slice(0, 17)); await pause(35);
    if (turn.cancelled) return;
    turn.delta(tail.slice(17)); turn.done();
  } catch (error) { fixtureErrors.push(String(error)); throw error; }
} });

async function hashes() {
  const files = ['package.json'];
  for (const folder of ['dist', 'dist-electron']) {
    async function visit(relative) {
      for (const item of await readdir(path.join(appDirectory, relative), { withFileTypes: true })) {
        const child = path.join(relative, item.name);
        if (item.isDirectory()) await visit(child);
        else if (/\.(?:js|cjs|mjs|css|html)$/i.test(item.name)) files.push(child);
      }
    }
    await visit(folder);
  }
  assert.ok(files.some(file => file.endsWith('main.cjs')));
  return Object.fromEntries(await Promise.all(files.sort().map(async file =>
    [file.replaceAll('\\', '/'), createHash('sha256').update(await readFile(path.join(appDirectory, file))).digest('hex')])));
}
const runtimeHashes = await hashes();
const check = label => { checks.push(label); console.log(`PASS ${label}`); };
// Explicit IPC polling avoids Playwright treating an async predicate Promise as true.
async function poll(page, predicate, arg, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await page.evaluate(predicate, arg)) return; await page.waitForTimeout(50); }
  throw Error(`Timeout during ${phase}`);
}
async function mood(page = controls) { return page.evaluate(() => window.desktop.getMood()); }
async function state(page = pet) { return page.evaluate(() => JSON.parse(document.querySelector('#stage canvas')?.dataset.chatGesture ?? '{}')); }
async function settings() { return controls.evaluate(() => window.desktop.getSettings()); }
async function memoryState() {
  return controls.evaluate(async () => {
    const messages = []; let messageCount = 0;
    for (let offset = 0; ; offset += 50) {
      const page = await window.desktop.listMemories({ offset, limit: 50 });
      for (const record of page.records) {
        messageCount += record.messageCount;
        for (let messageOffset = 0; messageOffset < record.messageCount; messageOffset += 10) {
          const part = await window.desktop.readMemory(record.id, { messageOffset, messageLimit: 10, textLimit: 1 });
          messages.push(...part.messages.map(({ turnId, role, status }) => ({ turnId, role, status })));
        }
      }
      if (offset + page.records.length >= page.total) break;
    }
    return { messageCount, turnIds: [...new Set(messages.map(message => message.turnId))].sort(), messages };
  });
}
async function capture(label) {
  assert.equal((await settings()).model?.name?.toLowerCase(), 'gene.pmx', 'Capture only public Gene.');
  const name = `${label}.png`;
  await pet.locator('#stage').screenshot({ path: path.join(output, name), omitBackground: true }); captures.push(name);
}
function armAngle(a, b) {
  const right = new Map(b.arms ?? []); let maximum = 0;
  for (const [name, q] of a.arms ?? []) {
    if (!/^(?:左|右)(?:肩|腕|ひじ|肘|手首)$/.test(name)) continue;
    const r = right.get(name); if (!r) continue;
    assert.ok([...q, ...r].every(Number.isFinite));
    const norm = Math.hypot(...q) * Math.hypot(...r);
    maximum = Math.max(maximum, 2 * Math.acos(Math.min(1, Math.abs(q.reduce((sum, value, i) => sum + value * r[i], 0) / norm))));
  }
  return maximum;
}
async function begin(gesture, context = 'neutral', options = {}) {
  const id = options.id ?? `gesture-smoke-${++sequence}`;
  const text = options.text ?? `原创隔离场景 ${sequence}：${gesture} ${context}`;
  plans.set(text, { id, gesture, context, delta: options.delta ?? {}, reason: `原创${gesture}场景`, delayMs: options.delayMs });
  const eventStart = await controls.evaluate(() => window.__gestureEvents.length);
  await controls.evaluate(({ id, text }) => window.desktop.chat({ id, messages: [{ role: 'user', content: text }], attachments: [] }), { id, text });
  return { id, text, eventStart };
}
async function completed(turn, allowError = false) {
  await poll(controls, turn => window.__gestureEvents.slice(turn.eventStart).some(event =>
    event.id === turn.id && ['done', 'error'].includes(event.type)), turn);
  const events = await controls.evaluate(turn => window.__gestureEvents.slice(turn.eventStart).filter(event => event.id === turn.id), turn);
  if (!allowError) assert.ok(!events.some(event => event.type === 'error'), events.find(event => event.type === 'error')?.text);
  const text = events.filter(event => event.type === 'delta').map(event => event.text).join('');
  assert.ok(!text.includes('<sh-state-') && !text.includes('"gesture"'), 'Private appraisal is stripped across SSE chunks.');
  return events;
}
async function ready() {
  // Outside developer mode the pet status reads only 模型已就绪 (R38 default immersive, src/main.ts updateStageStatus).
  await poll(pet, () => /模型已就绪|VMD 播放中/.test(document.querySelector('#pet-status')?.textContent ?? '')
    && JSON.parse(document.querySelector('#stage canvas')?.dataset.chatGesture ?? '{}').blocked === false, undefined, 60_000);
  await pet.waitForTimeout(350);
}
async function inactive() { await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.chatGesture ?? '{}').active === false); }
async function active(turn) {
  await completed(turn);
  await poll(controls, async () => Boolean((await window.desktop.getMood()).gesture));
  const view = await mood(); assert.ok(view.gesture, 'Completed accepted reply produces a host cue.');
  await poll(pet, id => { const frame = JSON.parse(document.querySelector('#stage canvas')?.dataset.chatGesture ?? '{}');
    return frame.active === true && frame.id === id; }, view.gesture.id);
  return view;
}
async function play(label, gesture, context = 'neutral', options = {}) {
  const saved = await settings(), disk = await readFile(settingsFile, 'utf8'), before = await state();
  await capture(`${label}-before`);
  const turn = await begin(gesture, context, options), view = await active(turn);
  const expected = fixtures[view.gesture.intent === 'consider' ? 'explain' : view.gesture.intent];
  assert.ok(expected); assert.equal(view.gesture.intent, options.expectedIntent ?? gesture);
  const other = await mood(pet); assert.deepEqual(other.gesture, view.gesture); assert.equal(other.token, view.token);
  for (const channel of ['D', 'O', 'E', 'N', 'C']) assert.ok(Math.abs(other.snapshot.values[channel] - view.snapshot.values[channel]) < 0.1);
  const receipt = await Promise.all([controls, pet].map(page => page.evaluate(id => window.__gestureCues.some(cue => cue?.id === id), view.gesture.id)));
  assert.deepEqual(receipt, [true, true], 'Both windows consume the same host cue.');
  const frames = []; let midpoint = false, fade = false;
  const until = Date.now() + expected.durationMs + 5_000;
  while (Date.now() < until) {
    const frame = await state(); frames.push(frame);
    if (!frame.active) break;
    assert.equal(frame.id, view.gesture.id); assert.equal(frame.error, '');
    for (const key of ['packId', 'motionId', 'sha256']) assert.equal(frame[key], expected[key]);
    assert.ok(Math.abs(frame.durationMs - expected.durationMs) < 1);
    assert.ok(frame.trackNames.some(name => /(?:左|右)(?:腕|ひじ|肘)/.test(name)), 'Overlay contains real arm tracks.');
    if (!midpoint && frame.elapsedMs >= expected.durationMs * 0.4) { await capture(`${label}-middle`); midpoint = true; }
    if (frame.phase === 'fading') fade = true;
    await pet.waitForTimeout(120);
  }
  const after = await state(), samples = frames.filter(frame => frame.active);
  assert.equal(after.active, false); assert.ok(midpoint && fade && samples.length >= 8, 'Continuous body and authored fade were observed.');
  assert.ok(Math.max(...samples.map(frame => frame.elapsedMs)) >= expected.durationMs * 0.85);
  const deltas = samples.slice(1).map((frame, i) => armAngle(samples[i], frame));
  assert.ok(deltas.filter(angle => angle > 0.004).length >= 4, 'Arms change at multiple times, beyond a static pose.');
  assert.ok(Math.max(...samples.map(frame => armAngle(before, frame))) > 0.035, 'Visible bounded arm rotation exceeds two degrees.');
  assert.ok(Number.isFinite(before.baseTime) && after.baseTime > before.baseTime + expected.durationMs / 2_000, 'Base mixer continues beneath the overlay.');
  assert.ok(frames.every((frame, i) => !i || frame.baseTime >= frames[i - 1].baseTime), 'Base clock never restarts.');
  await pet.waitForTimeout(180); const settled = await state();
  assert.ok(armAngle(before, settled) < 0.08, 'Arms recover from the last keyframe.');
  await capture(`${label}-after`);
  assert.deepEqual(await settings(), saved); assert.equal(await readFile(settingsFile, 'utf8'), disk);
  assert.equal((await mood()).snapshot.lastInteractionAt, view.snapshot.lastInteractionAt, 'Playback and the second window never mint another reward.');
  performances.push({ label, requestId: turn.id, hostCue: view.gesture, resource: expected, frames, maxArmRadians: Math.max(...deltas) });
  return { turn, cue: view.gesture };
}

try {
  const catalog = JSON.parse(await readFile(path.join(appDirectory, 'shared/motion-catalog.json'), 'utf8'));
  for (const fixture of Object.values(fixtures)) {
    const pack = catalog.packs.find(pack => pack.id === fixture.packId), motion = pack?.motions.find(motion => motion.id === fixture.motionId);
    assert.equal(motion?.sha256, fixture.sha256);
    const file = path.join(appDirectory, 'assets/bundled', pack.source, pack.id, pack.revision, motion.relativePath);
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), fixture.sha256);
  }
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile }); delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; delete env.MMD_TEST_EXE;
  instance = await electron.launch({
    ...(executable ? { executablePath: executable, args: [`--user-data-dir=${profile}`] }
      : { args: [appDirectory, `--user-data-dir=${profile}`] }),
    cwd: appDirectory, env, timeout: 30_000,
  });
  await claude.install(instance);
  const watched = new WeakSet();
  const watch = page => { if (watched.has(page)) return; watched.add(page);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('ERR_ABORTED')) errors.push(message.text()); }); };
  instance.on('window', watch); await instance.firstWindow();
  appIdentity = await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath() }));
  assert.equal(path.resolve(appIdentity.profile), profile); assert.equal(appIdentity.packaged, Boolean(executable));
  assert.equal(path.resolve(appIdentity.appPath).toLowerCase(), (packagedAsar ?? appDirectory).toLowerCase());
  await instance.evaluate(({ session }) => {
    globalThis.__gestureRemote = []; globalThis.__gesturePermissions = [];
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
      const denied = /^https?:/i.test(details.url);
      if (denied) globalThis.__gestureRemote.push(details.url); done({ cancel: denied });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => { globalThis.__gesturePermissions.push(permission); callback(false); });
    session.defaultSession.setPermissionCheckHandler(() => false);
  });
  for (let i = 0; i < 300 && (!controls || !pet); i++) {
    for (const page of instance.windows()) { watch(page); const url = new URL(page.url());
      if (!url.pathname.endsWith('/index.html')) continue;
      if (url.searchParams.has('pet')) pet = page; else controls = page;
    }
    if (!controls || !pet) await pause(100);
  }
  assert.ok(controls && pet); controls.setDefaultTimeout(20_000); pet.setDefaultTimeout(20_000);
  // A fresh profile gets the preinstalled Gene, so an ordinary start shows only the pet and keeps the controls closed
  // (electron/initial-controls.ts, R37). Wait for both windows to finish loading with the pet shown, then open the
  // controls the way a user does (the pet's settings button). The old check waited for a visible controls window.
  for (let i = 0; ; i++) {
    const stable = await instance.evaluate(({ BrowserWindow }) => {
      const pages = BrowserWindow.getAllWindows().filter(win => /\/index\.html(?:\?|$)/.test(win.webContents.getURL()));
      return pages.length === 2 && pages.every(win => !win.webContents.isLoadingMainFrame())
        && pages.some(win => new URL(win.webContents.getURL()).searchParams.has('pet') && win.isVisible());
    });
    if (stable) break; assert.ok(i < 300, 'App startup completes before fixture writes.'); await pause(100);
  }
  await pet.locator('#open-controls').evaluate(button => button.click());
  await poll(controls, () => !document.hidden, undefined, 10_000);
  await controls.waitForFunction(() => typeof window.desktop?.resolveChatGesture === 'function');
  await pet.waitForFunction(() => typeof window.desktop?.getMood === 'function');
  for (const page of [controls, pet]) await page.evaluate(() => {
    window.__gestureEvents = []; window.__gestureCues = []; window.__gestureStarted = [];
    window.desktop.onStream(event => window.__gestureEvents.push(event));
    window.desktop.onMood(view => window.__gestureCues.push(view.gesture));
    window.desktop.onChatStarted(event => window.__gestureStarted.push(event));
  });
  await controls.evaluate(async provider => {
    const value = await window.desktop.getSettings();
    value.provider = { ...value.provider, ...provider };
    value.voice.enabled = false; value.voice.volume = 0; if (value.tts) value.tts.enabled = false;
    value.pet.followMouse = false; value.pet.breath = 0;
    await window.desktop.saveSettings(value); await window.desktop.useBundledModel(); await window.desktop.recoverPet();
    await window.desktop.setMoodDeveloperMode(true); await window.desktop.setMoodExpressions(true);
  }, claude.provider);
  await pet.waitForTimeout(1000);
  console.log('STARTUP', JSON.stringify(await pet.evaluate(() => ({ status: document.querySelector('#pet-status')?.textContent,
    frame: document.querySelector('#stage canvas')?.dataset.chatGesture, mood: document.querySelector('#stage canvas')?.dataset.moodFeedback }))));
  await pet.mouse.move(1, 1);
  await poll(pet, async () => (await window.desktop.getMood()).snapshot.phase === 'idle');
  await ready();
  assert.match((await settings()).motion?.name ?? '', /^stand\.vmd$/i);
  assert.ok((await state()).arms.length >= 4 && Number.isFinite((await state()).baseTime));
  assert.deepEqual(await controls.evaluate(() => window.desktop.getRuntimeState()),
    { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null });
  assert.deepEqual(await controls.evaluate(() => window.desktop.getSystemAudioState()), { active: false });
  check('01 isolated profile, complete startup, public Gene + Stand and two pinned offline clips; voice/media stay off');

  phase = '02-explain-continuous';
  const explain = await play('gene-explain', 'explain');
  check('02 split SSE -> one accepted host cue -> continuous Gene arm explanation -> fade/recovery; base progresses and settings stay byte-identical');
  phase = '03-upbeat-continuous';
  const upbeat = await play('gene-upbeat', 'upbeat', 'positive', { delta: { D: 3, E: 2 } });
  assert.notEqual(explain.cue.id, upbeat.cue.id); assert.notEqual(fixtures.explain.sha256, fixtures.upbeat.sha256);
  check('03 positive semantics choose a different pinned arm clip; both windows share one cue without another reward');

  phase = '04-restraint-and-none';
  const restrained = await play('gene-consider', 'upbeat', 'concern', { delta: { C: 6, N: 2 }, expectedIntent: 'consider' });
  assert.ok(restrained.cue.strength < upbeat.cue.strength);
  const noTurn = await begin('none'); await completed(noTurn); await pet.waitForTimeout(400);
  assert.equal((await mood()).gesture, null); assert.equal((await state()).active, false);
  check('04 concern restrains requested upbeat into weaker consideration; neutral none creates no gesture');

  phase = '05-completed-request-replay';
  const beforeReplay = await mood(), requestsBefore = requests.length;
  const replay = await begin('none', 'neutral', { id: noTurn.id, text: noTurn.text });
  const replayEvents = await completed(replay, true);
  assert.ok(replayEvents.some(event => event.type === 'error'), 'Completed turn ID is rejected.');
  assert.equal(requests.length, requestsBefore); assert.equal((await mood()).snapshot.lastInteractionAt, beforeReplay.snapshot.lastInteractionAt);
  assert.equal((await state()).active, false);
  check('05 replaying a completed request ID reaches neither provider nor another gesture or mood reward');

  phase = '06-manual-priority-and-face-compatibility';
  await controls.evaluate(() => window.desktop.installMotionPack('mpi-embm-gestures', 'conversation-neutral', 'gesture'));
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.chatGesture ?? '{}').blocked === true
    && document.querySelector('#pet-status')?.textContent?.includes('身体 / 手势 / 表情独立'));
  await pet.waitForTimeout(200);
  const manual = await settings(), manualDisk = await readFile(settingsFile, 'utf8'), manualFrame = await state();
  const blocked = await begin('explain'); await completed(blocked); await pet.waitForTimeout(500);
  assert.ok((await mood()).gesture); assert.equal((await state()).active, false);
  assert.ok((await state()).baseTime > manualFrame.baseTime + 0.2);
  assert.deepEqual(await settings(), manual); assert.equal(await readFile(settingsFile, 'utf8'), manualDisk);
  await controls.evaluate(() => window.desktop.clearMotionLayer('gesture')); await ready(); await pet.waitForTimeout(400);
  assert.equal((await state()).active, false, 'Clearing a conflict cannot replay the consumed cue.');
  await controls.evaluate(() => window.desktop.installMotionPack('gene', 'happy', 'expression'));
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').faceBlocked === true
    && JSON.parse(document.querySelector('#stage canvas')?.dataset.chatGesture ?? '{}').blocked === false);
  await play('gene-expression-compatible', 'explain');
  assert.match((await settings()).motionLayers.expression.name, /^happy\.vmd$/i);
  await controls.evaluate(() => window.desktop.clearMotionLayer('expression')); await ready();
  check('06 manual upper-body layer keeps its asset and mixer progress, blocks automatic replay; independent Happy face coexists with a fresh arm cue');

  phase = '07-cancel-new-message-new-conversation';
  const cancelled = await begin('explain'); await active(cancelled);
  await controls.evaluate(id => window.desktop.cancel(id), cancelled.id); await inactive(); assert.equal((await mood()).gesture, null);
  const superseded = await begin('explain'); await active(superseded);
  const replacement = await begin('none'); await completed(replacement); await inactive(); assert.equal((await mood()).gesture, null);
  const cleared = await begin('explain'); await active(cleared);
  await controls.evaluate(() => window.desktop.newConversation()); await inactive(); assert.equal((await mood()).gesture, null);
  const stopping = await begin('upbeat', 'positive', { delayMs: 900 });
  await poll(controls, id => window.__gestureEvents.some(event => event.id === id && event.type === 'delta'), stopping.id);
  await controls.evaluate(id => window.desktop.cancel(id), stopping.id); await completed(stopping, true); await pet.waitForTimeout(1_100);
  assert.equal((await state()).active, false); assert.equal((await mood()).gesture, null);
  check('07 explicit stop, new accepted message and new conversation end the current clip; cancelled delayed SSE cannot trigger late playback');

  phase = '08-model-generation-and-integrity';
  const delayed = await begin('explain', 'neutral', { delayMs: 900 }), oldToken = (await mood()).token;
  await poll(controls, id => window.__gestureEvents.some(event => event.id === id && event.type === 'delta'), delayed.id);
  await controls.evaluate(async () => { const value = await window.desktop.getSettings(); value.model = null; value.motion = null;
    value.motionLayers = undefined; await window.desktop.saveSettings(value); });
  assert.notEqual((await mood()).token, oldToken);
  await completed(delayed, true); assert.equal((await mood()).gesture, null);
  await controls.evaluate(() => window.desktop.useBundledModel()); await ready(); await pet.waitForTimeout(600);
  assert.equal((await state()).active, false, 'Returning to Gene does not replay a former model generation.');
  const denied = await controls.evaluate(async () => { try { await window.desktop.resolveChatGesture('forged-cue', 'forged-token'); return false; } catch { return true; } });
  assert.equal(denied, true);
  assert.deepEqual(await instance.evaluate(() => ({ remote: globalThis.__gestureRemote, permissions: globalThis.__gesturePermissions })), { remote: [], permissions: [] });
  assert.deepEqual(errors, []); assert.deepEqual(fixtureErrors, []); assert.deepEqual(await hashes(), runtimeHashes);
  check('08 model-generation change rejects a delayed cue and return replay; forged resolution denied, runtime unchanged, no renderer/network/device errors');

  phase = '09-two-window-race-new-turn-and-gesture-replay';
  await controls.evaluate(() => window.desktop.newConversation()); await inactive();
  const raceMemoryBefore = await memoryState(), raceRequestsBefore = requests.length;
  const starts = await Promise.all([controls, pet].map(page => page.evaluate(() => ({ cues: window.__gestureCues.length, started: window.__gestureStarted.length }))));
  const eventStart = await controls.evaluate(() => window.__gestureEvents.length);
  const candidates = ['controls', 'pet'].map(owner => ({ id: `gesture-race-${owner}-${++sequence}`, text: `原创并发会话手势：来自${owner}的独立说明。`, eventStart }));
  for (const turn of candidates) plans.set(turn.text, { id: turn.id, gesture: 'explain', context: 'neutral', delta: {}, reason: '原创并发说明', delayMs: 800 });
  const outcomes = await Promise.all([controls, pet].map((page, i) => page.evaluate(async turn => {
    try { await window.desktop.chat({ id: turn.id, messages: [{ role: 'user', content: turn.text }], attachments: [] }); return { id: turn.id, accepted: true }; }
    catch (error) { return { id: turn.id, accepted: false, error: String(error) }; }
  }, candidates[i])));
  assert.equal(outcomes.filter(result => result.accepted).length, 1); assert.equal(outcomes.filter(result => !result.accepted).length, 1);
  assert.match(outcomes.find(result => !result.accepted).error, /上一项任务仍在进行/);
  const winner = candidates.find(turn => outcomes.find(result => result.id === turn.id).accepted), loser = candidates.find(turn => turn.id !== winner.id);
  const raceView = await active(winner), raceFrame = await state();
  assert.equal(raceFrame.id, raceView.gesture.id); assert.equal(raceFrame.active, true);
  assert.equal(requests.length, raceRequestsBefore + 1); assert.equal(requests.at(-1).id, winner.id);
  const raceMemory = await memoryState();
  assert.equal(raceMemory.messageCount, raceMemoryBefore.messageCount + 2);
  assert.deepEqual(raceMemory.messages.filter(message => message.turnId === winner.id).map(message => message.role).sort(), ['assistant', 'user']);
  assert.ok(!raceMemory.turnIds.includes(loser.id), 'Rejected transport never reaches memory or a mood turn.');
  const cueIds = async () => Promise.all([controls, pet].map((page, i) => page.evaluate(start =>
    [...new Set(window.__gestureCues.slice(start).filter(Boolean).map(cue => cue.id))].sort(), starts[i].cues)));
  assert.deepEqual(await cueIds(), [[raceView.gesture.id], [raceView.gesture.id]]);
  for (const [i, page] of [controls, pet].entries()) assert.deepEqual(await page.evaluate(start =>
    window.__gestureStarted.slice(start).map(turn => turn.id), starts[i].started), [winner.id]);
  await inactive();
  const next = await begin('explain', 'neutral', { text: winner.text, delayMs: 800 }), nextView = await active(next);
  assert.notEqual(next.id, winner.id); assert.notEqual(nextView.gesture.id, raceView.gesture.id);
  assert.equal((await state()).id, nextView.gesture.id); assert.equal((await state()).active, true);
  const nextMemory = await memoryState();
  assert.equal(requests.length, raceRequestsBefore + 2); assert.equal(requests.at(-1).id, next.id);
  assert.equal(nextMemory.messageCount, raceMemory.messageCount + 2);
  assert.deepEqual(nextMemory.messages.filter(message => message.turnId === next.id).map(message => message.role).sort(), ['assistant', 'user']);
  const expectedCues = [raceView.gesture.id, nextView.gesture.id].sort();
  assert.deepEqual(await cueIds(), [expectedCues, expectedCues]);
  await inactive();
  const beforeGestureReplay = await mood(), replayMemory = await memoryState(), replayRequests = requests.length;
  const gestureReplay = await begin('explain', 'neutral', { id: next.id, text: next.text });
  assert.ok((await completed(gestureReplay, true)).some(event => event.type === 'error'));
  for (let i = 0; i < 16; i++) { assert.equal((await state()).active, false, 'Completed gesture ID cannot replay even briefly.'); await pet.waitForTimeout(100); }
  assert.equal(requests.length, replayRequests); assert.deepEqual(await memoryState(), replayMemory);
  assert.deepEqual(await cueIds(), [expectedCues, expectedCues]);
  assert.equal((await mood()).snapshot.lastInteractionAt, beforeGestureReplay.snapshot.lastInteractionAt);
  concurrency = { outcomes, acceptedId: winner.id, rejectedId: loser.id, newTurnId: next.id,
    hostCueIds: expectedCues, providerRequests: requests.length - raceRequestsBefore,
    messageCounts: [raceMemoryBefore.messageCount, raceMemory.messageCount, nextMemory.messageCount, replayMemory.messageCount],
    replayRejectedWithoutNewProviderMemoryOrCue: true };
  check('09 two-window competition accepts one turn/cue; same text with a fresh ID is a new valid turn; replaying that completed gesture ID adds no request, memory, cue or playback');
  const privacy = await instance.evaluate(() => ({ remote: globalThis.__gestureRemote, permissions: globalThis.__gesturePermissions }));
  assert.deepEqual(privacy, { remote: [], permissions: [] }); assert.deepEqual(errors, []); assert.deepEqual(fixtureErrors, []);
  claude.assertClean(); assert.deepEqual((await claude.evidence(instance)).denied, []);
  assert.deepEqual(await hashes(), runtimeHashes);
  if (packagedAsar) assert.equal(createHash('sha256').update(await readFile(packagedAsar)).digest('hex'), packagedAsarHash);
  report = { status: 'passed', checks, performances, captures, localMockRequests: requests, errors, fixtureErrors, privacy,
    appDirectory, profile, runtimeHashes, appIdentity, packagedAsarHash, concurrency, limits: ['A synthetic Claude Code validates integration, not real Claude Code, the model service or semantic model accuracy.',
      'Both curated motions were observed continuously on bundled Gene; captures still require visual review.',
      'Only public Gene stage crops were taken; no desktop, private model, microphone, camera, system audio or speech was used.',
      'Manual-layer continuity is evidenced by its retained asset and continuously advancing shared mixer clock.',
      'Fresh request IDs are new accepted user turns even for identical text; this is not regeneration deduplication. The race has no fixed winning window.',
      'The rejected race ID has no memory messages and only the accepted ID is published; elapsed-time mood decay is not compared for equality.'] };
} catch (error) {
  process.exitCode = 1; console.error(`${phase}: ${error.message}`);
  const diagnostic = pet ? await pet.evaluate(() => ({ status: document.querySelector('#pet-status')?.textContent,
    frame: document.querySelector('#stage canvas')?.dataset.chatGesture, mood: document.querySelector('#stage canvas')?.dataset.moodFeedback })).catch(() => null) : null;
  report = { status: 'failed', phase, error: String(error.stack ?? error), diagnostic, checks, performances, captures,
    errors, fixtureErrors, requests, appDirectory, profile, runtimeHashes, appIdentity, packagedAsarHash, concurrency };
} finally {
  try {
    const shutdown = await closeElectron(instance); disarm();
    if (!shutdown.closed) { errors.push(`cleanup: ${shutdown.error}`); report.status = 'failed'; process.exitCode = 1; }
  }
  finally { report.fakeClaude = await claude.close(); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
