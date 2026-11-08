import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createClaudeIsolation } from './lib/claude-smoke-fixture.mjs';
import { armSmokeWatchdog, closeElectron } from './lib/electron-cleanup.mjs';

// Prepare/run only in the coordinated native slot. Never uses a normal profile,
// private model, real provider, physical media device, speech or system audio.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.MMD_TEST_EXE ? await realpath(path.resolve(process.env.MMD_TEST_EXE)) : null;
// Source mode runs this checkout's own build (`pnpm build` first); MMD_TEST_APP_DIR / MMD_TEST_EXE still select another
// build or a package. The Codex-era "frozen source, never the shared working build" rule belonged to its shared multi-agent
// workspace and native slot (2026-11-02 smoke triage); sourceHashes() still proves the build did not change during the run.
const source = executable ? null : await realpath(path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace));
const appDirectory = source ?? path.dirname(executable);
const packagedAsar = executable ? await realpath(path.join(path.dirname(executable), 'resources/app.asar')) : null;
const output = path.join(workspace, '.local/interaction-transition-smoke');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'soft-interaction-transition-'));
const templateFile = path.join(workspace, 'docs/mood/character-card-example.json');
const geneParameters = JSON.parse(await readFile(templateFile, 'utf8')).card.mood.parameters;
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const templateHash = await hash(templateFile);
const harnessHash = await hash(fileURLToPath(import.meta.url));
const checks = [], errors = [], captures = [], samples = {}, numeric = {}, manual = [];
let instance, controls, pet, report, appIdentity, geneCardId, phase = 'freeze-check';
let networkGuard = false;
// A failing or hung run still closes its own window (scripts/lib/electron-cleanup.mjs).
const disarm = armSmokeWatchdog(() => instance, 480_000, 'interaction-transition-smoke');

async function sourceHashes() {
  if (!source) return null;
  const result = {};
  for (const folder of ['dist', 'dist-electron']) {
    async function visit(directory) {
      for (const item of await readdir(path.join(source, directory), { withFileTypes: true })) {
        const relative = path.join(directory, item.name);
        if (item.isDirectory()) await visit(relative);
        else if (/\.(?:js|cjs|mjs|css|html)$/i.test(item.name)) result[relative.replaceAll('\\', '/')] = await hash(path.join(source, relative));
      }
    }
    await visit(folder);
  }
  assert.ok(Object.keys(result).some(file => file.endsWith('main.cjs')));
  return result;
}
const frozenHashes = await sourceHashes();
const packagedHash = packagedAsar ? await hash(packagedAsar) : null;
const check = label => { checks.push(label); console.log(`PASS ${label}`); };
async function poll(page, predicate, arg, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await page.evaluate(predicate, arg)) return; await page.waitForTimeout(40); }
  throw Error(`Timed out during ${phase}`);
}
async function mood() { return controls.evaluate(() => window.desktop.getMood()); }
async function frame() {
  return pet.evaluate(async () => {
    const canvas = document.querySelector('#stage canvas');
    const mood = await window.desktop.getMood();
    return { at: performance.now(), pointerAt: window.__m005PointerAt, local: document.querySelector('#mood-local-feedback')?.dataset.phase,
      feedback: JSON.parse(canvas?.dataset.moodFeedback ?? '{}'), transition: JSON.parse(canvas?.dataset.motionTransition ?? '{}'),
      animation: JSON.parse(canvas?.dataset.chatGesture ?? '{}'), snapshot: mood.snapshot,
      hand: !!document.querySelector('[data-pet-interaction-cursor]') && !document.querySelector('[data-pet-interaction-cursor]').hidden };
  });
}
async function collect(ms, interval = 90) {
  const rows = [], end = Date.now() + ms;
  while (Date.now() < end) { rows.push(await frame()); await pet.waitForTimeout(interval); }
  rows.push(await frame()); return rows;
}
async function capture(label) {
  const s = await controls.evaluate(() => window.desktop.getSettings());
  assert.match(s.model?.name ?? '', /^gene\.pmx$/i, 'Only bundled public Gene may be captured.');
  const file = `${label}.png`, observed = await frame();
  await pet.locator('#stage').screenshot({ path: path.join(output, file), omitBackground: true });
  captures.push({ file, feedback: observed.feedback, transition: observed.transition, local: observed.local });
}
async function projectedHead() {
  await poll(pet, () => {
    const canvas = document.querySelector('#stage canvas'), r = JSON.parse(canvas?.dataset.interactionRegion ?? '{}');
    return ['x', 'y', 'axisXX', 'axisXY', 'axisYX', 'axisYY', 'referenceWidth', 'mouthX', 'mouthY', 'mouthRadius'].every(k => Number.isFinite(r[k]));
  });
  return pet.evaluate(() => ({ ...JSON.parse(document.querySelector('#stage canvas').dataset.interactionRegion),
    rect: document.querySelector('#stage').getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight,
    reserved: [...document.querySelectorAll('.pet-toolbar,.pet-chat,.pet-size-panel,[data-mood-ui]')]
      .map(el => el.getBoundingClientRect().toJSON()).filter(r => r.width > 0 && r.height > 0) }));
}
const point = (h, u = 0, v = 0) => ({ x: h.rect.left + h.x + h.axisXX * u + h.axisYX * v,
  y: h.rect.top + h.y + h.axisXY * u + h.axisYY * v });
const usable = (h, p) => p.x > h.rect.left && p.y > h.rect.top && p.x < Math.min(h.width, h.rect.right)
  && p.y < Math.min(h.height, h.rect.bottom) && h.reserved.every(r => p.x < r.left || p.x >= r.right || p.y < r.top || p.y >= r.bottom);
function stroke(h) {
  const v = [-0.3, 0, 0.2].find(v => [-0.45, 0, 0.45].every(u => usable(h, point(h, u, v))));
  assert.notEqual(v, undefined, 'Recovered Gene must have a visible scalp stroke outside the retained UI reservations.');
  return u => point(h, u, v);
}
async function outside() { const height = await pet.evaluate(() => innerHeight); await pet.mouse.move(2, Math.min(450, height - 3)); }
async function armPointer() { await pet.evaluate(() => { window.__m005PointerAt = null; }); }
async function idle() {
  await outside();
  await poll(controls, async () => (await window.desktop.getMood()).snapshot.phase === 'idle');
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').contact < 0.01);
}
async function drag(type, target) {
  await pet.evaluate(({ type, target }) => document.querySelector('#stage').dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, clientX: target.x, clientY: target.y, dataTransfer: window.__m005Snack,
  })), { type, target });
}
async function savedState() {
  const file = path.join(profile, 'mood-state.json'), until = Date.now() + 8_000;
  let row;
  while (Date.now() < until) {
    try { row = JSON.parse(await readFile(file, 'utf8')).profiles.find(p => p.characterId === geneCardId); } catch { /* wait for the first atomic save */ }
    if (row && row.state.lastInteractionAt === (await mood()).snapshot.lastInteractionAt) return row;
    await pet.waitForTimeout(80);
  }
  throw Error('The isolated Gene state did not reach its latest acknowledged save.');
}
const norm = value => Math.hypot(...value);
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
const quaternionAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((s, x, i) => s + x * b[i], 0))));
function continuousHead(rows, label) {
  for (const row of rows) assert.ok(row.feedback.head?.length === 3 && row.feedback.head.every(Number.isFinite), `${label}: finite head output`);
  const maxStep = Math.max(0, ...rows.slice(1).map((r, i) => norm(r.feedback.head.map((x, k) => x - rows[i].feedback.head[k]))));
  assert.ok(maxStep < 0.075, `${label}: no abrupt local head step (${maxStep} radians at ~90ms observation intervals)`);
  return maxStep;
}
async function motionSwitch(label, action, unchanged = ['pose', 'expression']) {
  phase = label;
  await pet.evaluate(() => {
    window.__m005Motion = [];
    window.__m005MotionTimer = setInterval(() => {
      const canvas = document.querySelector('#stage canvas');
      window.__m005Motion.push({ at: performance.now(), transition: JSON.parse(canvas?.dataset.motionTransition ?? '{}'),
        animation: JSON.parse(canvas?.dataset.chatGesture ?? '{}') });
      if (window.__m005Motion.length > 400) window.__m005Motion.shift();
    }, 25);
  });
  try {
    await pet.waitForTimeout(80); await capture(`${label}-before`); await action();
    await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.motionTransition ?? '{}').active === true, undefined, 8_000);
    await pet.waitForTimeout(70); await capture(`${label}-middle`);
    await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.motionTransition ?? '{}').active === false);
    await pet.waitForTimeout(100); await capture(`${label}-after`);
  } finally { await pet.evaluate(() => clearInterval(window.__m005MotionTimer)); }
  const rows = await pet.evaluate(() => window.__m005Motion), active = rows.filter(r => r.transition.active);
  assert.ok(active.length >= 4 && active.some(r => r.transition.weight > 0.05 && r.transition.weight < 0.95), `${label}: a real multi-frame intermediate pose exists`);
  assert.ok(active.every(r => r.transition.durationMs >= 200 && r.transition.durationMs <= 1_500));
  const unique = rows.filter((r, i) => !i || r.animation.baseTime !== rows[i - 1].animation.baseTime);
  assert.ok(unique.length >= 7, `${label}: actual rendered frames were sampled`);
  const maxJumps = {};
  for (let i = 1; i < unique.length; i++) {
    const a = unique[i - 1], b = unique[i], dt = (b.at - a.at) / 1000;
    if (Number.isFinite(a.animation.baseTime) && Number.isFinite(b.animation.baseTime)) assert.ok(b.animation.baseTime >= a.animation.baseTime, `${label}: base mixer never resets`);
    for (const layer of unchanged) {
      const t0 = a.transition.layerTimes?.[layer], t1 = b.transition.layerTimes?.[layer];
      assert.equal(typeof t1, typeof t0, `${label}: unaffected ${layer} layer remains present`);
      if (typeof t0 === 'number' && typeof t1 === 'number' && dt < 0.2)
        assert.ok(t1 >= t0 - 0.015 || t1 < 0.2, `${label}: unaffected ${layer} time advances or crosses its loop seam`);
    }
    if (dt > 0 && dt < 0.12) for (const [name, q] of b.animation.arms ?? []) {
      const old = a.animation.arms?.find(([key]) => key === name)?.[1]; if (!old) continue;
      const jump = quaternionAngle(old, q); maxJumps[name] = Math.max(maxJumps[name] ?? 0, jump);
      assert.ok(jump < 0.65, `${label}: ${name} has no >37 degree one-frame change (${jump})`);
    }
  }
  manual.push({ label, rows, maxJumps, unchanged });
  check(`${label}: multiple intermediate render frames and continuous unaffected clocks`);
}

try {
  const env = (await createClaudeIsolation()).environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; delete env.MMD_TEST_EXE;
  instance = await electron.launch({ ...(executable ? { executablePath: executable, args: [`--user-data-dir=${profile}`] }
    : { args: [source, `--user-data-dir=${profile}`] }), cwd: appDirectory, env, timeout: 30_000 });
  const watched = new WeakSet();
  const watch = page => { if (watched.has(page)) return; watched.add(page); page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('ERR_ABORTED')) errors.push(message.text()); }); };
  instance.on('window', watch); await instance.firstWindow();
  appIdentity = await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath() }));
  assert.equal(path.resolve(appIdentity.profile), profile); assert.equal(appIdentity.packaged, Boolean(executable));
  assert.equal(path.resolve(appIdentity.appPath).toLowerCase(), path.resolve(packagedAsar ?? source).toLowerCase());
  await instance.evaluate(({ session }) => {
    globalThis.__m005Remote = []; globalThis.__m005Permissions = [];
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (detail, done) => {
      const denied = /^https?:/i.test(detail.url); if (denied) globalThis.__m005Remote.push(detail.url); done({ cancel: denied }); });
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, done) => { globalThis.__m005Permissions.push(permission); done(false); });
  }); networkGuard = true;
  for (let i = 0; i < 200 && (!controls || !pet); i++) {
    for (const page of instance.windows()) { watch(page); const url = new URL(page.url()); if (!url.pathname.endsWith('/index.html')) continue;
      if (url.searchParams.has('pet')) pet = page; else controls = page; }
    if (!controls || !pet) await new Promise(resolve => setTimeout(resolve, 75));
  }
  assert.ok(controls && pet); await controls.waitForFunction(() => typeof window.desktop?.saveCharacterCard === 'function');
  await instance.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const url = win.webContents.getURL(); if (!url.includes('index.html')) continue;
      win.setTitle(`soft hearts · M005 Gene 隔离验收 · ${new URL(url).searchParams.has('pet') ? '桌宠' : '控制窗'}`);
    }
  });
  await controls.evaluate(async parameters => {
    const s = await window.desktop.getSettings(); s.voice.enabled = false; s.voice.volume = 0; s.pet.followMouse = false; s.pet.breath = 0;
    s.provider = { kind: 'claude', model: '' }; // Never chats: Claude Code is an inert placeholder here.
    await window.desktop.saveSettings(s); await window.desktop.useBundledModel();
    const state = await window.desktop.saveCharacterCard({ name: 'M005 Gene基准', description: '公开Gene的隔离交互验收。', personality: '均衡。', scenario: '', greeting: '', examples: '', systemPrompt: '', mood: { version: 1, parameters } });
    const card = state.cards.find(c => c.name === 'M005 Gene基准'); if (!card) throw Error('Missing Gene fixture card');
    await window.desktop.activateCharacterCard(card.id); await window.desktop.recoverPet();
    await window.desktop.setMoodDeveloperMode(true); await window.desktop.setMoodExpressions(true);
  }, geneParameters);
  // One-click recovery frames the whole model asynchronously in the pet renderer (src/main.ts onPetRecovered:
  // applySettings, frame('full'), savePetView). Wait for that camera before measuring the head; otherwise a fast run
  // measures the default camera, where the crown is above the window.
  await poll(controls, async () => Math.abs((await window.desktop.getSettings()).camera.distance - 30) > 1e-5, undefined, 30_000);
  await poll(pet, () => {
    const c = document.querySelector('#stage canvas'), f = JSON.parse(c?.dataset.moodFeedback ?? '{}'), t = JSON.parse(c?.dataset.motionTransition ?? '{}');
    return ['hover', 'contact', 'mouth', 'eyelids', 'blink'].every(k => Number.isFinite(f[k])) && typeof f.activeContact === 'boolean'
      && typeof t.active === 'boolean' && t.layerTimes && f.head?.every(Number.isFinite);
  }, undefined, 60_000);
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.motionTransition ?? '{}').active === false);
  const initial = await mood(); geneCardId = initial.characterId;
  assert.deepEqual(initial.parameters, geneParameters); assert.deepEqual(initial.snapshot.values, { D: 50, O: 50, E: 50, N: 50, C: 50 });
  assert.equal(initial.snapshot.lastInteractionAt, null); assert.equal(initial.snapshot.boredom, 0); assert.equal(initial.snapshot.longing, 0);
  const cardState = await controls.evaluate(() => window.desktop.getCharacterCards());
  assert.equal(cardState.cards.find(c => c.id === geneCardId).name, 'M005 Gene基准');
  assert.deepEqual(cardState.cards.find(c => c.id === geneCardId).mood.parameters, geneParameters);
  numeric.parameters = geneParameters; numeric.initial = initial.snapshot;
  await pet.evaluate(() => { document.querySelector('#stage').addEventListener('pointermove', e => { window.__m005PointerAt ??= e.timeStamp; }, { capture: true }); });
  await pet.locator('#chat-input').fill('原创M005未发送草稿'); await pet.bringToFront(); await outside(); await pet.waitForTimeout(250);
  check('01 fresh system-temp profile, public Gene + explicit Gene baseline card, complete parameter readback and required render diagnostics');

  phase = '02-immediate-contact-ui-exit';
  let h = await projectedHead(), pathPoint = stroke(h), p = pathPoint(0.42);
  await capture('gene-hover-before'); await armPointer(); await pet.mouse.move(p.x, p.y);
  await poll(controls, () => window.desktop.getMood().then(v => v.snapshot.phase === 'rua'), undefined, 1_000);
  samples.earlyHover = await collect(1_150); await capture('gene-hover-middle');
  assert.ok(samples.earlyHover[0].at - samples.earlyHover[0].pointerAt < 1_000, 'Contact has no artificial two-second entry gate.');
  assert.ok(samples.earlyHover.some(r => r.feedback.contact > 0.03 && r.feedback.contact < 0.99));
  for (const r of samples.earlyHover) {
    assert.equal(r.local, 'rua'); assert.equal(r.snapshot.phase, 'rua'); assert.equal(r.snapshot.lastInteractionAt, null);
    assert.equal(r.snapshot.boredom, initial.snapshot.boredom); assert.equal(r.snapshot.longing, initial.snapshot.longing);
    assert.equal(r.hand, true); assert.deepEqual(r.snapshot.values, initial.snapshot.values);
  }
  continuousHead(samples.earlyHover, 'immediate smooth contact');
  const inputBounds = await pet.locator('#chat-input').boundingBox(); assert.ok(inputBounds);
  await pet.mouse.move(inputBounds.x + inputBounds.width / 2, inputBounds.y + inputBounds.height / 2);
  // R29 B05 (160e54c): a pat survives a brief exit for PAT_HOLD 0.35 s and then eases out (damp 4/s, ~1.15 s to < 0.01),
  // so the visual contribution needs ~1.5 s to leave; the old 1.4 s window predates that hold.
  samples.earlyExit = await collect(2_000); continuousHead(samples.earlyExit, 'early UI exit');
  assert.ok(samples.earlyExit[0].feedback.contact > 0, 'The first exit frame retains a decaying visual contribution.');
  assert.ok(samples.earlyExit.at(-1).feedback.contact < 0.01); assert.equal((await mood()).snapshot.lastInteractionAt, null);
  assert.equal(await pet.locator('#chat-input').inputValue(), '原创M005未发送草稿'); await capture('gene-hover-ui-exit');
  check('02 scalp hit immediately shows emoji and smooth contact; stationary input gives no reward and UI exit preserves the draft');

  phase = '03-immediate-entry-qualified-stroke';
  await idle(); h = await projectedHead(); pathPoint = stroke(h); p = pathPoint(0.42);
  await armPointer(); const contactStarted = Date.now(); await pet.mouse.move(p.x, p.y);
  samples.immediateContact = await collect(200);
  assert.ok(samples.immediateContact.at(-1).hand && samples.immediateContact.at(-1).feedback.activeContact);
  assert.equal((await mood()).snapshot.lastInteractionAt, null, 'The first point and stationary time create no effective movement.');
  continuousHead(samples.immediateContact, 'immediate entry');
  const strokeStarted = Date.now();
  let earlyRewardAt = null;
  for (let i = 1; i <= 14; i++) {
    const q = pathPoint(0.42 * Math.cos(i * Math.PI / 7)); await pet.mouse.move(q.x, q.y); await pet.waitForTimeout(90);
    if (i === 4) {
      earlyRewardAt = (await mood()).snapshot.lastInteractionAt;
      assert.ok(earlyRewardAt !== null && earlyRewardAt - contactStarted < 2_000, 'Qualifying real movement can count before the toolbar-only two-second timer.');
    }
  }
  const strokeMs = Date.now() - strokeStarted; await pet.waitForTimeout(350);
  const stationaryBefore = (await mood()).snapshot; await pet.waitForTimeout(600);
  const stationaryAfter = (await mood()).snapshot;
  assert.equal(stationaryAfter.lastInteractionAt, stationaryBefore.lastInteractionAt, 'Stationary contact does not keep responding/rewarding.');
  await capture('gene-rua-static'); await idle();
  const row = await savedState(), fresh = row.state.freshness.rua;
  // The saved `doses` has already started recovering (shared/mood.ts advanceMood): after quietMs past the last
  // rua event it falls by depthCap per ruaMs. The save lands when the pat eases out (~1.4-1.5 s after the
  // last event since B05), so ~0.006 of the credited dose is gone and O read back sat 0.05-0.07 above a
  // formula fed that recovered value (2026-11-02 triage). Undo exactly that recovery to get the credited dose.
  const { retention, floor, ruaMs, quietMs } = geneParameters.freshness;
  const depthCap = retention === 1 || floor === 1 || retention === 0 ? 1 : Math.min(64, floor === 0 ? 64 : Math.ceil(Math.log(floor) / Math.log(retention)));
  const recovered = fresh ? Math.max(0, fresh.recoveredAt - (fresh.lastEventAt + quietMs)) / ruaMs * depthCap : 0;
  const dose = (fresh?.doses ?? 0) + recovered;
  assert.ok(recovered < 0.05, `Recovery between the last pat and the save stays small (${recovered}).`);
  assert.ok(dose > 0 && dose < 1 && dose <= strokeMs / geneParameters.interaction.ruaDoseMs + 0.08, 'Only measured movement contributes; entry and stationary time are never backfilled.');
  const expectedO = 100 - 50 * Math.exp(-10 * dose / 50), expectedE = 100 - 50 * Math.exp(-4 * dose / 50);
  near(row.state.values.O, expectedO, 0.06, 'Gene O from actual credited dose'); near(row.state.values.E, expectedE, 0.06, 'Gene E from actual credited dose');
  for (const c of ['D', 'N', 'C']) near(row.state.values[c], 50, 1e-8, `rua does not add ${c}`);
  numeric.rua = { dose, savedDoses: fresh?.doses ?? 0, recovered, strokeMs, contactStarted, earlyRewardAt, state: row.state, expectedO, expectedE, tolerance: 0.06 };
  check('03 immediate entry, real movement before two seconds, stationary no extra reward and measured Gene O/E calculation');

  phase = '04-feeding-mouth-and-release';
  const originalCamera = (await controls.evaluate(() => window.desktop.getSettings())).camera;
  h = await projectedHead(); const faceY = (h.y + h.mouthY) / 2;
  const targetY = originalCamera.targetY + (1 - faceY / (h.rect.height / 2)) * originalCamera.distance * Math.tan(originalCamera.fov * Math.PI / 360);
  await controls.evaluate(async camera => { const s = await window.desktop.getSettings(); s.camera = camera; await window.desktop.saveSettings(s); }, { ...originalCamera, targetY, distance: originalCamera.distance * 0.4 });
  await pet.waitForTimeout(400); await pet.bringToFront(); await outside(); h = await projectedHead();
  const mouth = { x: h.rect.left + h.mouthX, y: h.rect.top + h.mouthY };
  // B06 (R29): the mouth already opens by proximity up to four mouth radii (PetInteraction mouthProximity), so
  // "away" must lie beyond that zone; the old 2.4 radii now opens to about 0.26 by design.
  const away = [[-1, 0], [1, 0], [-0.6, -0.8], [0.6, -0.8], [-0.8, -0.6], [0.8, -0.6], [-0.8, 0.6], [0.8, 0.6]]
    .map(([dx, dy]) => ({ x: mouth.x + dx * 4.5 * h.mouthRadius, y: mouth.y + dy * 4.5 * h.mouthRadius })).find(p => usable(h, p));
  assert.ok(away, 'A drag point outside the mouth anticipation zone is visible: ' + JSON.stringify({ mouth, radius: h.mouthRadius }));
  await pet.evaluate(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'original-m005.png', { type: 'image/png' })); window.__m005Snack = transfer;
  });
  const beforeFood = (await mood()).snapshot; await capture('gene-feeding-before'); await drag('dragenter', away); await pet.waitForTimeout(250);
  assert.ok((await frame()).feedback.mouth < 0.05);
  for (let i = 0; i < 9; i++) { await drag('dragover', mouth); await pet.waitForTimeout(120); }
  await poll(controls, async () => (await window.desktop.getMood()).snapshot.phase === 'food-ready');
  samples.feedingPeak = await collect(350); assert.ok(samples.feedingPeak.some(r => r.feedback.mouth > 0.6), 'Prepared feeding opens visibly beyond the previous 0.42 target.');
  assert.equal((await mood()).snapshot.lastInteractionAt, beforeFood.lastInteractionAt); near((await mood()).snapshot.values.D, 50, 1e-8, 'Preparation does not accept food');
  await capture('gene-feeding-open'); await drag('dragover', away); samples.feedingLeave = await collect(850);
  assert.ok(samples.feedingLeave[0].feedback.mouth > 0.05 && samples.feedingLeave.at(-1).feedback.mouth < 0.04, 'Leaving the mouth smoothly closes preparation.');
  near((await mood()).snapshot.values.D, 50, 1e-8, 'Leaving preparation creates no food reward');
  for (let i = 0; i < 9; i++) { await drag('dragover', mouth); await pet.waitForTimeout(120); }
  await poll(controls, async () => (await window.desktop.getMood()).snapshot.phase === 'food-ready'); await drag('drop', mouth);
  await poll(controls, async () => (await window.desktop.getMood()).snapshot.phase === 'food-eating');
  const acceptedFood = (await mood()).snapshot, expectedD = 100 - 50 * Math.exp(-12 / 50);
  near(acceptedFood.values.D, expectedD, 0.04, 'Gene first food dose'); await drag('drop', mouth); await pet.waitForTimeout(250);
  assert.ok((await mood()).snapshot.values.D <= acceptedFood.values.D + 0.001, 'Duplicate drop cannot accept another portion.');
  numeric.food = { before: beforeFood, accepted: acceptedFood, expectedD, tolerance: 0.04 };
  await idle(); await capture('gene-feeding-closed');
  await controls.evaluate(async camera => { const s = await window.desktop.getSettings(); s.camera = camera; await window.desktop.saveSettings(s); }, originalCamera);
  await pet.waitForTimeout(350); await pet.bringToFront();
  check('04 mouth-only prepared feeding opens beyond 0.6, closes smoothly outside mouth, release accepts one Gene food dose');

  phase = '05-stable-eyelids-and-normal-blink';
  h = await projectedHead(); pathPoint = stroke(h); p = pathPoint(0); await outside(); await pet.mouse.move(p.x, p.y);
  await poll(controls, async () => (await window.desktop.getMood()).snapshot.phase === 'rua');
  // Keep actual head contact while varying only real pointer speed. The six-second
  // series distinguishes a stable enjoyment envelope from natural sparse blinks.
  samples.stableEyes = []; const eyesStarted = Date.now();
  for (let i = 0; Date.now() - eyesStarted < 6_400; i++) {
    const u = (Math.floor(i / 12) % 2 ? 0.27 : 0.12) * Math.sin(i * Math.PI / 2), q = pathPoint(u);
    await pet.mouse.move(q.x, q.y); await pet.waitForTimeout(95); samples.stableEyes.push(await frame());
  }
  assert.ok(samples.stableEyes.at(-1).at - samples.stableEyes[0].at >= 6_000);
  const steadyEyes = samples.stableEyes.filter(r => r.at - samples.stableEyes[0].at > 1_000);
  assert.ok(steadyEyes.every(r => Number.isFinite(r.feedback.eyelids) && Number.isFinite(r.feedback.blink)));
  assert.ok(steadyEyes.every(r => r.feedback.activeContact && r.snapshot.phase === 'rua'), 'Eye stability must be observed during actual continuous rua.');
  assert.ok(steadyEyes.some(r => r.feedback.eyelids > 0.08), 'The happy Gene fixture actually exercises enjoyment eyelids; all-zero output is not a stability pass.');
  const eyelidVariation = steadyEyes.slice(1).reduce((sum, r, i) => sum + Math.abs(r.feedback.eyelids - steadyEyes[i].feedback.eyelids), 0);
  assert.ok(eyelidVariation < 1.5, `Enjoyment eyelids should not flutter at pointer-sample frequency (${eyelidVariation}).`);
  await capture('gene-stable-rua-eyes'); await idle();
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').eyelids < 0.01);
  samples.normalBlink = await collect(8_000, 25);
  assert.ok(samples.normalBlink.some(r => r.feedback.blink > 0.7), 'Normal blinking continues after contact rather than being disabled.');
  assert.ok(samples.normalBlink.some(r => r.feedback.blink < 0.05), 'The actual blink morph also returns open.');
  numeric.eyelidVariation = eyelidVariation;
  check('05 six-second steady contact eye series is bounded; leaving clears enjoyment and normal blinking still opens/closes');

  await controls.evaluate(() => window.desktop.installMotionPack('gene', 'happy', 'expression'));
  await poll(pet, () => {
    const canvas = document.querySelector('#stage canvas'), f = JSON.parse(canvas?.dataset.moodFeedback ?? '{}'), t = JSON.parse(canvas?.dataset.motionTransition ?? '{}');
    return f.faceBlocked === true && typeof t.layerTimes?.expression === 'number';
  });
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.motionTransition ?? '{}').active === false);
  await motionSwitch('06-gesture-enter', () => controls.evaluate(() => window.desktop.installMotionPack('mpi-embm-gestures', 'conversation-neutral', 'gesture')));
  await motionSwitch('07-gesture-replace', () => controls.evaluate(() => window.desktop.installMotionPack('mpi-embm-gestures', 'conversation-joy', 'gesture')));
  await motionSwitch('08-gesture-clear', () => controls.evaluate(() => window.desktop.clearMotionLayer('gesture')));
  await motionSwitch('09-expression-replace', () => controls.evaluate(() => window.desktop.installMotionPack('gene', 'sad', 'expression')), ['pose']);
  await motionSwitch('10-clear-all-to-idle', async () => { await controls.evaluate(async () => { await window.desktop.clearMotionLayer('expression'); await window.desktop.clearMotionLayer('pose'); }); }, []);
  await pet.waitForTimeout(500); const relaxed = await frame();
  for (const name of ['左腕', '右腕']) { const q = relaxed.animation.arms?.find(([key]) => key === name)?.[1]; assert.ok(q); assert.ok(quaternionAngle(q, [0,0,0,1]) > 0.45, 'Clear-all returns relaxed arms, not the unanimated T pose.'); }
  check('clear-all settled target is relaxed idle rather than the unanimated T pose');

  phase = '11-pet-compact-controls-details';
  // Stable UI-owner selector. The pet deliberately never expands its full panel.
  await pet.locator('#mood-open-controls').click();
  await poll(controls, () => !document.querySelector('.mood-companion')?.hidden && !document.querySelector('.mood-companion-body')?.hidden);
  const geometry = await Promise.all([pet, controls].map(page => page.evaluate(() => {
    const root = document.querySelector('.mood-companion'), body = document.querySelector('.mood-companion-body'), stage = document.querySelector('#stage');
    return { compact: root?.classList.contains('is-compact'), bodyHidden: body?.hidden, panel: root?.getBoundingClientRect().toJSON(), stage: stage?.getBoundingClientRect().toJSON() };
  })));
  assert.ok(geometry[0].compact && geometry[0].bodyHidden, 'Pet remains compact when full state is opened in controls.');
  const a = geometry[1].panel, b = geometry[1].stage; assert.ok(a && b);
  const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  assert.ok(overlap < 1, `Expanded controls flow outside the model preview (${overlap} CSS px² overlap).`);
  const touchConfig = await pet.evaluate(() => JSON.parse(document.querySelector('#mood-local-feedback').dataset.touchConfig));
  const changedTouchConfig = { ...touchConfig, minSpeed: touchConfig.minSpeed === 0.15 ? 0.2 : 0.15 };
  await controls.locator('.mood-touch-tuning > summary').click();
  await controls.locator('#mood-touch-parameters').fill(JSON.stringify(changedTouchConfig, null, 2));
  await controls.locator('#mood-touch-apply').click();
  await poll(pet, expected => JSON.parse(document.querySelector('#mood-local-feedback').dataset.touchConfig).minSpeed === expected, changedTouchConfig.minSpeed);
  await poll(controls, () => document.querySelector('.mood-touch-tuning output')?.textContent?.includes('已确认应用'));
  await controls.locator('#mood-touch-parameters').fill(JSON.stringify(touchConfig, null, 2)); await controls.locator('#mood-touch-apply').click();
  await poll(pet, expected => JSON.parse(document.querySelector('#mood-local-feedback').dataset.touchConfig).minSpeed === expected, touchConfig.minSpeed);
  samples.panelGeometry = geometry;
  const controlsCapture = 'gene-controls-full-state.png';
  await controls.screenshot({ path: path.join(output, controlsCapture) });
  captures.push({ file: controlsCapture, kind: 'isolated-public-Gene-controls' });
  check('11 pet stays compact, full controls avoid preview, relocated touch tuning reaches the pet and confirms actual application');

  const media = await controls.evaluate(() => window.desktop.getRuntimeState());
  assert.deepEqual(media, { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null });
  assert.deepEqual(await controls.evaluate(() => window.desktop.getSystemAudioState()), { active: false });
  const privacy = await instance.evaluate(() => ({ remote: globalThis.__m005Remote, permissions: globalThis.__m005Permissions }));
  assert.deepEqual(privacy, { remote: [], permissions: [] }); assert.deepEqual(errors, []);
  assert.deepEqual(await sourceHashes(), frozenHashes); if (packagedAsar) assert.equal(await hash(packagedAsar), packagedHash);
  assert.deepEqual((await mood()).parameters, geneParameters, 'No visual test changes Gene baseline or reward parameters.');
  report = { status: 'passed-pending-visual-review', checks, source, executable, packagedHash, frozenHashes, harnessHash, appIdentity, profile,
    geneCardId, templateHash, numeric, samples, manual, captures, errors, privacy,
    limits: ['Only public Gene stage and isolated application captures; root must visually review the motion, feeding and full controls images.',
      'No normal profile, private model, real provider, physical media, speech or system audio is used.',
      'DOM DataTransfer verifies application feeding; it is not Windows Explorer cross-window drag proof.',
      'Native timing has polling tolerance; immediate-entry/event boundaries are additionally covered by tracker/host tests; toolbar-only two-second delay and hover zones have separate UI checks.',
      'Gene numeric checks are automated implementation evidence, not user approval of mood tuning or general model compatibility.'] };
} catch (error) {
  process.exitCode = 1;
  let diagnostic; try { diagnostic = pet ? await frame() : null; } catch { /* app may have already exited */ }
  report = { status: 'failed', phase, error: String(error.stack ?? error), checks, source, executable, packagedHash, harnessHash, appIdentity, profile,
    numeric, samples, manual, captures, errors, diagnostic };
  console.error(error);
} finally {
  const shutdown = await closeElectron(instance); disarm();
  if (!shutdown.closed) { errors.push(`cleanup:${shutdown.error}`); report.status = 'failed-cleanup'; process.exitCode = 1; }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
