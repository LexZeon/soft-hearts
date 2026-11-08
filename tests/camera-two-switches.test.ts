// I-036：摄像头共享展开后是两个独立开关——「发图片」（不用下载；每条消息带一张约 320×240 的小图，
// 叫她"看看我"或点「拍一张给她看」时发清楚的一张）和「姿势识别」（本机 RTMPose，第一次要下载组件）。两个都开时，姿势有明显变化
// 或十分钟没发过才带小图。发送时不现拍：小图是窗口事先交给宿主、宿主只留最新一张的那张。"别看"之后什么都不拍，直到叫她看。
// 这里用真实的媒体开关（electron/runtime.ts）、真实的宿主附图（electron/look-attachments.ts + electron/camera-glance.ts）、真实的
// 聊天请求校验和这一轮的感知行，按 electron/main.ts 的接法走；取图口和 Claude 是假的，不开窗口、不碰摄像头。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Attachment, RuntimeState } from '../shared/contracts';
import { MediaRuntime, cameraImagesRevoked, type CameraPolicy } from '../electron/runtime';
import { LookTurns } from '../electron/look-turns';
import { LookAttachments } from '../electron/look-attachments';
import { CameraGlance, gistChanged, movementBand, poseGist } from '../electron/camera-glance';
import { validateChatRequest } from '../electron/validation';
import { lookHint, turnAttachments } from '../src/look-send';
import { GLANCE_LINE, PERCEPTION_LINE_MAX, perceptionTurnLine, perceptionTurnState } from '../shared/perception-rule';
import { ACTIVITY_PHRASES, type ScreenActivity } from '../shared/screen-activity';
import { GLANCE_BLIND_MS, GLANCE_MAX_AGE_MS, GLANCE_MAX_CHARS, glanceSize } from '../shared/camera-glance';
import { CameraTrayEye, TRAY_TIPS } from '../electron/pose/tray';
import type { PoseSignal } from '../shared/pose-signals';
import { installPetWindow } from './helpers/pet-window-dom';
import { PetUI, renderPet } from '../src/ui/PetUI';
import { CAMERA_BOTH_HINT, CAMERA_GROUP_HINT, CAMERA_GROUP_TITLE, CAMERA_IMAGES_HINT, CAMERA_IMAGES_TITLE, CAMERA_POSE_HINT, CAMERA_POSE_TITLE } from '../src/ui/CameraSharingPanel';

const small = (n: number) => `data:image/jpeg;base64,/9j/small${n}AA==`;
const clear = 'data:image/jpeg;base64,/9j/clearAAAA';

/** A pose policy: 'local' (component installed), 'blocked' (missing: the control window asks), 'share' (no package here). */
function policy(mode: 'local' | 'blocked' | 'share') {
  const asked: string[] = [];
  const value: CameraPolicy = { mode: () => mode, blocked: owner => { asked.push(owner); return 'needs-component'; } };
  return { value, asked };
}

const signal = (over: Partial<PoseSignal> = {}): PoseSignal => ({ present: true, confidence: 0.9, facing: 'toward', posture: 'sitting', energy: 0.1,
  rhythm: false, tempo: null, events: [], hand: null, capability: 'full', ...over });

/** The host as electron/main.ts wires it, with a fake camera window and a fake pose signal. */
function host(mode: 'local' | 'blocked' | 'share' = 'local') {
  const pose = policy(mode);
  let now = 1_000_000, generation = 0, poseNow: PoseSignal | null = null;
  const media = new MediaRuntime(undefined, pose.value, undefined, () => now);
  const captures: string[] = [];
  const glance = new CameraGlance({ frame: () => media.cameraAttachment(now), poseOn: () => media.state.cameraLocal === true,
    signal: () => poseNow, opening: () => media.openings.camera, now: () => now });
  const look = new LookAttachments(new LookTurns(() => now), {
    noteActivity: () => { generation++; },
    state: () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `c|${media.revision}`,
      screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true }),
    sharesCameraFrames: () => media.sharesCameraFrames(),
    revision: () => media.revision, generation: () => generation, opening: source => media.openings[source],
    captureScreen: async () => ({ source: 'screen', dataUrl: 'data:image/jpeg;base64,/9j/screenAA==' }),
    captureCamera: async () => { captures.push('clear'); return media.sharesCameraFrames() ? { source: 'camera', dataUrl: clear } : null; },
    glance: () => glance.take(), seenCamera: () => glance.seen(),
    holdCamera: held => { media.holdCamera(held); },
  });
  const claude: { images: string[]; sight: string; asked: number }[] = [];
  let id = 0;
  async function send(content: string, manual: Attachment[] = []) {
    const attachments = turnAttachments(manual, await look.request(lookHint(content, false)));
    const request = validateChatRequest({ id: `t${++id}`, messages: [{ role: 'user', content }], attachments });
    const frames = look.admit(request.attachments); request.attachments = frames.current();
    const sight = perceptionTurnLine(perceptionTurnState(media.state, request.attachments, content, { cameraGlance: frames.cameraGlance() }));
    claude.push({ images: frames.current().map(a => a.dataUrl), sight, asked: frames.asked().length });
    return claude.at(-1)!;
  }
  /** The owner window hands over a small frame (src/ui/camera-glance-sampler.ts → publishCameraFrame). */
  const keep = (n: number, owner: 'pet' | 'controls' = 'pet') => media.publishCamera(owner, small(n));
  return { media, pose, look, glance, send, keep, captures, claude,
    advance: (ms: number) => { now += ms; }, setPose: (value: PoseSignal | null) => { poseNow = value; } };
}

// ---------------------------------------------------------------- the two switches

test('两个开关各管各的：都开、只开一个、都不开；关一个不动另一个；总开关关掉两个都关', () => {
  const h = host('local');
  const images = h.media.update({ cameraImages: true }, 'pet');
  assert.equal(images.cameraSharing, true);
  assert.equal(images.cameraImages, true);
  assert.equal(images.cameraLocal, undefined, '只开发图片');
  assert.equal(h.media.sharesCameraFrames(), true);
  assert.equal(h.media.allowsMedia('pet', 'video'), true, '发图片的窗口能开摄像头');
  const both = h.media.update({ cameraLocal: true }, 'pet');
  assert.equal(both.cameraImages, true); assert.equal(both.cameraLocal, true);
  const poseOnly = h.media.update({ cameraImages: false }, 'pet');
  assert.equal(poseOnly.cameraSharing, true, '姿势识别还开着');
  assert.equal(poseOnly.cameraImages, undefined);
  assert.equal(poseOnly.cameraLocal, true);
  assert.equal(h.media.sharesCameraFrames(), false, '只开姿势识别：窗口不拿画面');
  assert.equal(h.media.allowsMedia('pet', 'video'), false);
  assert.throws(() => h.keep(1), '只开姿势识别时，小图交不进来');
  h.media.update({ cameraImages: true }, 'pet');
  const none = h.media.update({ cameraSharing: false }, 'pet');
  assert.deepEqual([none.cameraSharing, none.cameraImages, none.cameraLocal, none.cameraOwner], [false, undefined, undefined, null]);
  assert.throws(() => h.media.update({ cameraImages: 'yes' }, 'pet'), '只收开关值');
});

test('发图片不用下载：组件没装时照样开，不弹下载的问题；姿势识别照旧被拒并问一次', () => {
  const h = host('blocked');
  const images = h.media.update({ cameraImages: true }, 'pet');
  assert.equal(images.cameraImages, true);
  assert.equal(images.cameraRefused, undefined);
  assert.deepEqual(h.pose.asked, [], '没有问下载');
  const pose = h.media.update({ cameraLocal: true }, 'pet');
  assert.equal(pose.cameraRefused, 'needs-component', '姿势识别：今天的下载提示不变');
  assert.deepEqual(h.pose.asked, ['pet']);
  assert.equal(h.media.state.cameraImages, true, '被拒的姿势识别不碰发图片');
  assert.equal(h.media.state.cameraLocal, undefined);
  // Both asked at once: 发图片 turns on, 姿势识别 is refused and says why.
  const fresh = host('blocked');
  const mixed = fresh.media.update({ cameraImages: true, cameraLocal: true }, 'controls');
  assert.equal(mixed.cameraImages, true); assert.equal(mixed.cameraLocal, undefined); assert.equal(mixed.cameraRefused, 'needs-component');
});

test('迁移：旧的单个摄像头开关（老窗口、内部通道的 camera）= 姿势识别；发图片从关开始；组件缺时被拒，不会改成发图片', () => {
  const h = host('local');
  const on = h.media.update({ cameraSharing: true }, 'controls');
  assert.equal(on.cameraLocal, true);
  assert.equal(on.cameraImages, undefined, '发图片从关开始');
  assert.equal(h.media.sharesCameraFrames(), false);
  const missing = host('blocked');
  const refused = missing.media.update({ cameraSharing: true }, 'pet');
  assert.equal(refused.cameraRefused, 'needs-component');
  assert.equal(missing.media.state.cameraSharing, false);
  assert.equal(missing.media.state.cameraImages, undefined, '不会改成发图片');
  const unavailable = new MediaRuntime(undefined, { mode: () => 'blocked' });
  assert.equal(unavailable.update({ cameraSharing: true }, 'pet').cameraRefused, 'unavailable');
  assert.equal(unavailable.state.cameraImages, undefined);
  // Already on (only 发图片): the old switch "on" changes nothing about the two switches.
  const already = host('local');
  already.media.update({ cameraImages: true }, 'pet');
  assert.equal(already.media.update({ cameraSharing: true }, 'pet').cameraLocal, undefined);
});

// ---------------------------------------------------------------- what each message carries

test('只开发图片：每条消息带一张事先备好的小图，发送时不现拍；感知行说是小图', async () => {
  const h = host('local');
  h.media.update({ cameraImages: true }, 'pet');
  h.keep(1);
  const first = await h.send('今天好累啊');
  assert.deepEqual(first.images, [small(1)], '带的就是窗口备好的那张');
  assert.deepEqual(h.captures, [], '没有现拍');
  assert.ok(first.sight.includes(GLANCE_LINE), first.sight);
  assert.doesNotMatch(first.sight, /用户叫你看摄像头/);
  assert.equal(first.asked, 0, '小图不算"带了图的消息"（本地控制、R20 照旧）');
  h.keep(2); h.advance(1_000);
  assert.deepEqual((await h.send('嗯嗯')).images, [small(2)], '每条都带最新的一张');
  h.advance(GLANCE_MAX_AGE_MS);
  assert.deepEqual((await h.send('还在吗')).images, [], '窗口停了交图（过时）就不带，不带旧图');
});

test('第一个字不变慢：普通消息不等摄像头（取清楚画面的口一直不返回也不影响）', async () => {
  const media = new MediaRuntime(undefined, { mode: () => 'local' });
  media.update({ cameraImages: true }, 'pet');
  media.publishCamera('pet', small(1));
  const glance = new CameraGlance({ frame: () => media.cameraAttachment(), poseOn: () => false, signal: () => null, opening: () => media.openings.camera });
  let waited = false;
  const look = new LookAttachments(new LookTurns(), { noteActivity() {}, state: () => ({ screen: false, camera: true, scope: 's' }),
    sharesCameraFrames: () => media.sharesCameraFrames(), revision: () => media.revision, generation: () => 0, opening: s => media.openings[s],
    captureScreen: async () => null, captureCamera: () => { waited = true; return new Promise(() => {}); }, glance: () => glance.take() });
  const started = performance.now();
  const frames = await look.request({ text: '晚上吃什么' });
  assert.equal(frames.length, 1);
  assert.equal(waited, false);
  assert.ok(performance.now() - started < 50, 'resolves at once');
});

test('叫她看（"你看看我"等）发清楚的一张；按「拍一张给她看」自己拍的那张优先，不被小图顶掉', async () => {
  const h = host('local');
  h.media.update({ cameraImages: true }, 'pet');
  h.keep(1);
  for (const words of ['你看看我', '你看我今天的发型怎么样', '看看我']) {
    const turn = await h.send(words);
    assert.deepEqual(turn.images, [clear], words);
    assert.match(turn.sight, /用户叫你看摄像头，本轮附了画面/);
    assert.equal(turn.asked, 1);
  }
  assert.equal(h.captures.length, 3);
  const snapshot: Attachment = { source: 'camera', dataUrl: 'data:image/jpeg;base64,/9j/handAA==' };
  const turn = await h.send('拍给你看', [snapshot]);
  assert.deepEqual(turn.images, [snapshot.dataUrl], '自己拍的清楚的那张');
  // The pure rule of the window's half.
  assert.deepEqual(turnAttachments([snapshot], [{ source: 'camera', dataUrl: small(9), shareTicket: 'x' }]), [snapshot]);
});

test('两个都开：姿势有明显变化或十分钟没发过才带小图；没有变化时不带，只有本机识别的姿势', async () => {
  const h = host('local');
  h.media.update({ cameraImages: true, cameraLocal: true }, 'pet');
  h.setPose(signal());
  h.keep(1);
  assert.deepEqual((await h.send('在吗')).images, [small(1)], '第一条：带');
  h.keep(2); h.advance(3_000);
  const same = await h.send('嗯');
  assert.deepEqual(same.images, [], '姿势没变：不带');
  assert.match(same.sight, /摄像头开着，但这一轮你没看画面/);
  h.setPose(signal({ posture: 'standing' })); h.keep(3); h.advance(3_000);
  assert.deepEqual((await h.send('我站起来了')).images, [small(3)], '坐→站：带');
  h.setPose(signal({ posture: 'standing', energy: 0.7 })); h.keep(4); h.advance(3_000);
  assert.deepEqual((await h.send('动一动')).images, [small(4)], '动作幅度换档：带');
  h.keep(5); h.advance(3_000);
  assert.deepEqual((await h.send('嗯')).images, []);
  h.glance.noteSignal(signal({ posture: 'standing', energy: 0.7, events: ['wave'] })); h.keep(6); h.advance(3_000);
  assert.deepEqual((await h.send('嗨')).images, [small(6)], '挥手之后：带');
  h.keep(7); h.advance(3_000);
  assert.deepEqual((await h.send('嗯')).images, []);
  h.advance(GLANCE_BLIND_MS); h.keep(8);
  assert.deepEqual((await h.send('嗯')).images, [small(8)], '十分钟没发过：带，不至于一直看不见');
  h.setPose(signal({ present: false, posture: 'unknown', facing: 'unknown', energy: 0 })); h.keep(9); h.advance(3_000);
  assert.deepEqual((await h.send('我走开一下')).images, [small(9)], '人离开：带');
  // Sensing not running yet: no reason to hold the picture back.
  h.setPose(null); h.keep(10); h.advance(3_000);
  assert.deepEqual((await h.send('嗯')).images, [small(10)]);
});

test('变化规则本身：在不在、朝向、姿势、动作档位', () => {
  assert.equal(movementBand(0.1), 'still'); assert.equal(movementBand(0.3), 'moving'); assert.equal(movementBand(0.6), 'lively');
  const base = poseGist(signal());
  assert.equal(gistChanged(base, poseGist(signal({ energy: 0.15, confidence: 0.5 }))), false, '同一档的小抖动、置信度不算');
  for (const change of [{ present: false }, { facing: 'side' as const }, { posture: 'slumped' as const }, { energy: 0.3 }])
    assert.equal(gistChanged(base, poseGist(signal(change))), true, JSON.stringify(change));
});

// ---------------------------------------------------------------- nothing when off or told not to look

test('关着或说了"别看"：什么都不拍、不收、不发；叫她看才恢复', async () => {
  const h = host('local');
  assert.throws(() => h.keep(1), '没开：交不进来');
  assert.deepEqual((await h.send('今天好累')).images, []);
  h.media.update({ cameraLocal: true }, 'pet');
  assert.deepEqual((await h.send('你看看我')).images, [], '只开姿势识别：叫她看也没有图');
  assert.deepEqual(h.captures, []);
  h.media.update({ cameraImages: true }, 'pet'); h.setPose(null);
  h.keep(1);
  const no = await h.send('别看我');
  assert.deepEqual(no.images, [], '"别看我"这一条不带');
  assert.equal(h.media.state.cameraHeld, true, '窗口停止画小图');
  assert.equal(h.media.cameraAttachment(), null, '宿主留着的那张也丢了');
  assert.throws(() => h.keep(2), '说了别看之后交不进来');
  assert.deepEqual((await h.send('今天吃什么')).images, [], '之后的消息也不带');
  assert.deepEqual(h.captures, []);
  const asked = await h.send('你看看我');
  assert.deepEqual(asked.images, [clear], '叫她看：拍清楚的一张，并恢复');
  assert.equal(h.media.state.cameraHeld, undefined);
  h.keep(3);
  assert.deepEqual((await h.send('好')).images, [small(3)]);
  // A no said after a small frame was handed out holds that frame back too.
  h.keep(4);
  const taken = await h.look.request(lookHint('嗯', false));
  assert.equal(taken.length, 1);
  await h.look.request(lookHint('先别看我了', false));
  assert.deepEqual(h.look.admit(taken).current(), [], '已交出的小图也不发');
  // Turning 发图片 off and on again is a new opening: the no is over, the old frame is not.
  h.media.update({ cameraImages: false }, 'pet'); h.media.update({ cameraImages: true }, 'pet');
  assert.equal(h.media.state.cameraHeld, undefined);
  assert.equal(h.media.cameraAttachment(), null);
});

test('附小图的口自己也查开关：发图片关着时，就算别处说开着、取图口给了图，也不附', async () => {
  let glances = 0;
  const look = new LookAttachments(new LookTurns(), { noteActivity() {}, state: () => ({ screen: false, camera: true, scope: 's' }),
    sharesCameraFrames: () => false, revision: () => 0, generation: () => 0, opening: () => 0,
    captureScreen: async () => null, captureCamera: async () => null,
    glance: () => { glances++; return { source: 'camera', dataUrl: small(1) }; } });
  assert.deepEqual(await look.request({ text: '今天好累' }), []);
  assert.equal(glances, 0, '连问都不问取图口');
});

test('带小图的感知行：每种组合都在上限内，屏幕那半句照旧', () => {
  let longest = '';
  for (const activity of [...Object.keys(ACTIVITY_PHRASES), 'other', null] as (ScreenActivity | null)[])
    for (const screen of [true, false]) for (const attachedScreen of [true, false]) for (const asked of [null, 'screen', 'camera', 'either'] as const) {
      const line = perceptionTurnLine({ screen, camera: 'frames', attached: { screen: attachedScreen && screen, camera: true }, glance: true, asked,
        ...(screen && !attachedScreen ? { rough: activity } : {}) });
      assert.ok(line.endsWith(GLANCE_LINE), line);
      if (line.length > longest.length) longest = line;
    }
  assert.ok(longest.length <= PERCEPTION_LINE_MAX, `${longest.length}: ${longest}`);
});

test('小图要小：大于上限的不收；尺寸约 320×240', () => {
  const media = new MediaRuntime(undefined, { mode: () => 'local' });
  media.update({ cameraImages: true }, 'pet');
  assert.throws(() => media.publishCamera('pet', `data:image/jpeg;base64,${'A'.repeat(GLANCE_MAX_CHARS)}`));
  assert.throws(() => media.publishCamera('pet', 'data:image/png;base64,AAAA'), '只收 JPEG');
  assert.throws(() => media.publishCamera('controls', small(1)), '只收摄像头所属窗口的');
  assert.deepEqual(glanceSize(1920, 1080), { width: 320, height: 180 });
  assert.deepEqual(glanceSize(640, 480), { width: 320, height: 240 });
  assert.deepEqual(glanceSize(200, 100), { width: 200, height: 100 }, '不放大');
});

test('关掉发图片或换窗口：旧的那一路作废（electron/main.ts 据此清掉视觉上下文）', () => {
  const on: RuntimeState = { voiceInput: false, screenSharing: false, cameraSharing: true, voiceOwner: null, cameraOwner: 'pet', cameraImages: true };
  assert.equal(cameraImagesRevoked(on, { ...on, cameraImages: undefined, cameraSharing: false, cameraOwner: null }), true);
  assert.equal(cameraImagesRevoked(on, { ...on, cameraOwner: 'controls' }), true);
  assert.equal(cameraImagesRevoked(on, { ...on, cameraLocal: true }), false, '加开姿势识别不作废');
  assert.equal(cameraImagesRevoked({ ...on, cameraImages: undefined, cameraLocal: true }, { ...on, cameraImages: undefined, cameraSharing: false }), false);
});

test('托盘的小眼睛：任一开关开着就显示', () => {
  const shown: [boolean, string][] = [];
  const eye = new CameraTrayEye((on, tip) => shown.push([on, tip]));
  eye.images(true); eye.pose(true); eye.images(false); eye.pose(false); eye.pose(false);
  assert.deepEqual(shown, [[true, TRAY_TIPS.images], [true, TRAY_TIPS.both], [true, TRAY_TIPS.pose], [false, TRAY_TIPS.off]]);
});

// ---------------------------------------------------------------- the pet's camera button

test('桌宠的摄像头按钮：点一下只展开两个开关，不直接开摄像头；两个开关各发各的；被拒的弹回并说明原因', async t => {
  const dom = installPetWindow(t, { openControls: async () => {}, updatePetReply: async () => undefined, setPetWindowOperation: async () => undefined });
  renderPet(dom.app as unknown as HTMLElement);
  const patches: unknown[] = [], explained: unknown[] = [];
  const media = new MediaRuntime(undefined, { mode: () => 'blocked', blocked: () => 'needs-component' });
  const ui: PetUI = new PetUI({ edit() {}, feature: feature => patches.push(['feature', feature]),
    camera: async patch => { patches.push(patch); const reply = media.update(patch, 'pet'); ui.applyRuntime({ ...media.state }); return reply; },
    explainRuntime: reply => explained.push(reply.cameraRefused),
    popups: { 'screen-sharing-options': { isOpen: () => false, close() {} }, 'mood-companion': { isOpen: () => false, close() {} } },
    send() {}, stop() {}, error: message => { throw Error(message); } });
  dom.beforeClose(() => ui.dispose());
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const button = dom.byId('pet-camera-sharing'), panel = dom.byId('pet-camera-panel');
  assert.equal(panel.hidden, true);
  button.click();
  assert.deepEqual(patches, [], '按钮只展开，不开摄像头');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.hidden, false);
  const images = panel.querySelector('[data-camera-switch="cameraImages"]')!, pose = panel.querySelector('[data-camera-switch="cameraLocal"]')!;
  assert.deepEqual(panel.querySelectorAll('strong').map(node => node.textContent), ['摄像头共享', '发图片', '姿势识别（本机）']);
  images.checked = true; images.onchange!(new Event('change')); await flush();
  assert.deepEqual(patches, [{ cameraImages: true }]);
  assert.equal(images.checked, true); assert.equal(pose.checked, false);
  pose.checked = true; pose.onchange!(new Event('change')); await flush();
  assert.deepEqual(patches.at(-1), { cameraLocal: true });
  assert.equal(pose.checked, false, '组件没装：姿势识别弹回');
  assert.deepEqual(explained.at(-1), 'needs-component', '并说明要下载');
  assert.equal(images.checked, true, '发图片不受影响');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(button.dataset.tooltip ?? '', /发图片已开/);
  button.click();
  assert.equal(panel.hidden, true, '再点收起；开关不变');
  assert.equal(media.state.cameraImages, true);
});

test('控制窗口隐私页的两行和桌宠面板用同样的话', () => {
  const layout = readFileSync(new URL('../src/ui/layout.ts', import.meta.url), 'utf8');
  for (const words of [CAMERA_GROUP_TITLE, CAMERA_GROUP_HINT, CAMERA_BOTH_HINT, CAMERA_IMAGES_TITLE, CAMERA_IMAGES_HINT, CAMERA_POSE_TITLE, CAMERA_POSE_HINT])
    assert.ok(layout.includes(`'${words}'`), words);
  assert.match(layout, /toggle\('runtime-camera-images','发图片'/);
  assert.match(layout, /toggle\('runtime-camera','姿势识别（本机）'/);
});

// ---------------------------------------------------------------- wiring in the hot files (text checks only where there is no other way)

test('electron/main.ts 接线：小图走 CameraGlance、"别看"走 holdCamera、托盘眼睛跟两个开关；小图不进任何小模型调用', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.match(main, /glance: \(\) => cameraGlance\.take\(\), seenCamera: \(\) => cameraGlance\.seen\(\)/);
  assert.match(main, /holdCamera: held => \{ const previous = \{ \.\.\.media\.state \}; if \(media\.holdCamera\(held\)\) mediaChanged\(previous\); \}/);
  assert.match(main, /new CameraGlance\(\{ frame: \(\) => media\.cameraAttachment\(\)/);
  assert.match(main, /cameraEye\.images\(media\.sharesCameraFrames\(\)\);/);
  assert.match(main, /trayChanged: on => cameraEye\.pose\(on\)/);
  assert.match(main, /cameraImagesRevoked\(previous, next\)/);
  assert.match(main, /const readoutControl = turnFrames\.asked\(\)\.length === 0/);
  // Every clear camera capture (a look, her proactive topic) stops while the user's "别看" holds.
  assert.match(main, /async function captureSharedCamera[^\n]*\n\s*if \(!media\.sharesCameraFrames\(\)\) return null;[^\n]*\n\s*if \(media\.state\.cameraHeld\) return null;/);
  // The only small-model call with a picture is the screen's rough reading (its own thumbnail), never a chat attachment.
  for (const call of main.match(/quickLineWithClaude\([^)]*\)/g) ?? []) assert.doesNotMatch(call, /attachments|cameraAttachment|cameraGlance|turnFrames/, call);
  assert.doesNotMatch(main, /moduleRouter\.userTurn\([^)]*attachments/);
  assert.doesNotMatch(main, /moodJudge\.host\.userText\([^)]*attachments/);
});
