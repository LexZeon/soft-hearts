// 识图分三档 · 第 1 步「细看」的真机检查（docs/claude/2026-11-03-image-depth-step1.md）。Source build only (run after
// `vite build && node scripts/build-electron.mjs`). Everything is synthetic: an isolated temporary profile and LOCALAPPDATA,
// the synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs) and a stubbed desktopCapturer that returns a generated
// 32×32 frame and counts calls — no real screen pixels, camera, microphone or account. The pet opens at the top-left corner.
//   node scripts/look-smoke.mjs
import { _electron as electron } from 'playwright';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const output = path.resolve('.local/look-smoke');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-look-e2e-'));
const profile = path.join(temporary, 'profile'), localAppData = path.join(temporary, 'local');
await mkdir(profile); await mkdir(localAppData);
const turns = [];
const checks = [];
const errors = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
let instance, controls, pet;

const claude = await createClaudeFixture({
  root: temporary,
  respond: turn => {
    const user = turn.currentUser ?? '';
    turns.push({ user, images: turn.images.length, spawn: turn.spawn, opening: turn.opening, sight: /【此刻的感知】[^\n]*/u.exec(turn.text)?.[0] ?? null });
    // She offers to look closer when the user only hints at something on the screen.
    return user.includes('报错') ? ['报错啊……我还没看你的屏幕呢，', '要我凑近看看吗？'] : ['好呀：', user];
  },
});
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({
  version: 1, model: null, motion: null, provider: claude.provider, persona: 'Synthetic local test companion.',
  pet: { visible: true, clickThrough: false, scale: 1, followMouse: false, fps: 24 }, voice: { enabled: false, rate: 1, volume: 0 },
}));

async function waitFor(condition, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function send(page, text) {
  await page.bringToFront();
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-input').press('Enter');
}
async function settled(count) {
  await waitFor(() => turns.length >= count, `turn ${count}`);
  for (const page of [controls, pet]) await page.waitForFunction(() => !document.getElementById('send-chat').classList.contains('hidden'), undefined, { polling: 100 });
}
const captures = () => instance.evaluate(() => globalThis.__lookSmokeCaptures);
const visible = (page, selector) => page.locator(selector).evaluate(node => !node.hidden && getComputedStyle(node).display !== 'none');

try {
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile, LOCALAPPDATA: localAppData, SOFT_HEARTS_TEST_PET_CORNER: 'top-left' });
  delete env.ELECTRON_RUN_AS_NODE;
  instance = await electron.launch({ args: ['.'], env, timeout: 30000 });
  await claude.install(instance);
  await instance.firstWindow();
  assert.equal(await instance.evaluate(({ app }) => app.getPath('userData')), profile);
  await waitFor(() => {
    controls = instance.windows().find(page => page.url().includes('index.html') && !new URL(page.url()).searchParams.has('pet'));
    pet = instance.windows().find(page => page.url().includes('index.html') && new URL(page.url()).searchParams.has('pet'));
    return controls && pet;
  }, 'both app windows');
  for (const [kind, page] of [['controls', controls], ['pet', pet]]) {
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(`${kind}: ${error.message}`));
    await page.waitForSelector('#chat-input');
    await page.waitForFunction(() => !!window.desktop?.getRuntimeState);
  }
  await instance.evaluate(({ desktopCapturer, nativeImage, screen }) => {
    globalThis.__lookSmokeCaptures = 0;
    desktopCapturer.getSources = async () => {
      globalThis.__lookSmokeCaptures++;
      const bytes = Buffer.alloc(32 * 32 * 4);
      for (let index = 0; index < bytes.length; index += 4) { bytes[index] = 40; bytes[index + 1] = 160; bytes[index + 2] = 220; bytes[index + 3] = 255; }
      return [{ id: 'screen:fixture:0', name: 'Synthetic screen', display_id: String(screen.getPrimaryDisplay().id),
        thumbnail: nativeImage.createFromBitmap(bytes, { width: 32, height: 32 }), appIcon: null }];
    };
  });
  await pet.waitForSelector('#pet-look-screen', { state: 'attached' });
  await controls.waitForSelector('#look-screen', { state: 'attached' });
  assert.equal(await visible(pet, '#pet-look-screen'), false);
  assert.equal(await visible(controls, '#look-screen'), false);
  check('"给她看看屏幕" is not shown while screen sharing is off');

  await send(pet, '今天好累啊');
  await settled(1);
  assert.equal(turns[0].images, 0);
  assert.equal(turns[0].sight, '【此刻的感知】你看不到用户的屏幕和摄像头画面。');
  check('sharing off: an ordinary message says she cannot see, no frame');

  await pet.evaluate(() => window.desktop.setRuntimeState({ screenSharing: true }));
  await waitFor(async () => (await pet.evaluate(() => window.desktop.getRuntimeState())).screenSharing, 'screen sharing on');
  await waitFor(async () => await visible(pet, '#pet-look-screen') && await visible(controls, '#look-screen'), 'look buttons shown');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await captures(), 0, 'turning sharing on takes no frame (R09 retired)');
  assert.equal((await pet.evaluate(() => window.desktop.setVisionOptions({ autoCapture: true, intervalSeconds: 2 }))).autoCapture, false);
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal(await captures(), 0, 'an old automatic-snapshot request is ignored');
  check('sharing on: buttons appear; nothing is captured in the background, even if asked for automatic snapshots');
  await pet.screenshot({ path: path.join(output, 'pet-sharing-on.png') });

  for (const [index, text] of ['晚上吃什么好呢', '嘿嘿你今天好可爱', '我看看'].entries()) {
    await send(index % 2 ? controls : pet, text);
    await settled(2 + index);
    assert.equal(turns.at(-1).images, 0, text);
    assert.equal(turns.at(-1).sight, '【此刻的感知】用户开着屏幕共享，但这一轮你没看画面；想看要用户叫你。', text);
  }
  assert.equal(await captures(), 0);
  assert.equal(new Set(turns.slice(1, 4).map(turn => turn.spawn)).size, 1, 'ordinary turns stay on one warm process');
  check('sharing on: ordinary messages carry no frame, take no capture, and stay on the warm process');

  await send(pet, '你看看我屏幕，这个是什么');
  await settled(5);
  assert.equal(turns[4].images, 1);
  assert.match(turns[4].sight, /^【此刻的感知】用户叫你看屏幕，本轮附了画面。/u);
  assert.equal(await captures(), 1);
  await send(pet, '谢谢');
  await settled(6);
  assert.equal(turns[5].images, 0);
  assert.notEqual(turns[5].spawn, turns[4].spawn, 'the session retired after the frame turn');
  check('"你看看我屏幕": one frame on that turn only, with the 细看 line; the next turn is on a fresh process without it');

  await pet.locator('#chat-input').fill('这题怎么做');
  await pet.locator('#pet-look-screen').click();
  await settled(7);
  assert.deepEqual([turns[6].user, turns[6].images], ['这题怎么做', 1]);
  await controls.bringToFront();
  await controls.locator('#chat-input').fill('');
  await controls.locator('#look-screen').click();
  await settled(8);
  assert.deepEqual([turns[7].user, turns[7].images], ['你看看我的屏幕。', 1]);
  assert.equal(await captures(), 3);
  check('the button sends what is typed (or "你看看我的屏幕。") with the screen, in the pet and in the control window');

  await send(pet, '这个报错什么意思');
  await settled(9);
  assert.equal(turns[8].images, 0);
  await send(pet, '嗯');
  await settled(10);
  assert.equal(turns[9].images, 1, 'a yes to "要我凑近看看吗" looks');
  await send(pet, '嗯');
  await settled(11);
  assert.equal(turns[10].images, 0, 'only the message right after her offer');
  assert.equal(await captures(), 4);
  check('she asks "要我凑近看看吗", the user says "嗯": that turn looks; the next "嗯" does not');

  // Codex T-205 round 2 (X-253): a no, a ban, "没授权", a question whether she is looking and someone else's quoted words never
  // take a frame, also right after her offer; the next real ask looks again (docs/claude/2026-11-04-v1-refusal-grab.md).
  // Round 4 (X-258): a take-back of the permission and someone's words after "某人当时说，" (also labelled "这是他的原话").
  // Round 5 (X-260): someone else's words after "同事跟你说，". Round 6 (X-263): after "跟你说了声，" and "跟你说——".
  for (const text of ['禁止查看我的屏幕', '请停止查看我的屏幕', '别擅自看我的屏幕', '没授权你看我屏幕', '不允许你看我屏幕', '同事原话是‘你看看这个报错’', '你是不是在看我屏幕',
    '我撤回你看我屏幕的授权。', '同事当时说，你看看这个报错。', '同事当时说，你看看这个报错，这是他的原话。', '同事跟你说，你看看这个报错。',
    '同事跟你说了声，你看看这个报错。', '同事跟你说——你看看这个报错。']) {
    const next = turns.length + 1;
    await send(pet, text);
    await settled(next);
    assert.deepEqual([turns.at(-1).user, turns.at(-1).images], [text, 0]);
    assert.equal(turns.at(-1).sight, '【此刻的感知】用户开着屏幕共享，但这一轮你没看画面；想看要用户叫你。', text);
  }
  assert.equal(await captures(), 4, 'a refused turn takes no frame');
  const ask = turns.length + 1;
  await send(pet, '你看看我屏幕');
  await settled(ask);
  assert.equal(turns.at(-1).images, 1);
  assert.equal(await captures(), 5);
  check('a no, a ban, "没授权", "你是不是在看" and quoted words take no frame; the next ask looks again');

  await pet.evaluate(() => window.desktop.setRuntimeState({ screenSharing: false }));
  await waitFor(async () => !await visible(pet, '#pet-look-screen') && !await visible(controls, '#look-screen'), 'look buttons hidden');
  const off = turns.length + 1;
  await send(pet, '你看看我屏幕');
  await settled(off);
  assert.equal(turns.at(-1).images, 0);
  assert.match(turns.at(-1).sight, /屏幕共享没开/u);
  assert.equal(await captures(), 5);
  check('sharing off again: buttons hide; asking to look takes nothing and she is told sharing is off');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks, turns, captures: await captures() }, null, 2));
} catch (error) {
  for (const [label, page] of [['controls', controls], ['pet', pet]]) if (page) await page.screenshot({ path: path.join(output, `failure-${label}.png`) }).catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: false, error: String(error?.stack ?? error), checks, turns, errors }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await instance?.close().catch(() => {});
  await claude.close().catch(() => {});
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('soft-look-e2e-'));
  await rm(resolved, { recursive: true, force: true }).catch(() => {});
}
