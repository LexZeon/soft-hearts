// "别看"之后她自己主动想看画面（R10）也不带摄像头的图（Codex X-337 留下的缺口，docs/claude/2026-11-06-small-gaps.md）。
// 真实的媒体开关、真实的"别看/你看看我"判断（LookAttachments + LookTurns）、真实的主动看画面引擎（ProactiveVision）和它的取图口
// （electron/proactive-capture.ts，main.ts 用的同一个）；摄像头窗口是假的：只要被问就给一张图，所以"不带"只能是宿主自己拦下的。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment } from '../shared/contracts';
import { MediaRuntime } from '../electron/runtime';
import { LookTurns } from '../electron/look-turns';
import { LookAttachments } from '../electron/look-attachments';
import { ProactiveVision } from '../electron/proactive-vision';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { captureProactiveFrames, cameraFrameAllowed } from '../electron/proactive-capture';
import { lookHint } from '../src/look-send';

const camera = 'data:image/jpeg;base64,/9j/cameraAAAA';
const screen = 'data:image/jpeg;base64,/9j/screenAAAA';

function rig(options: { screenOn?: boolean; guardWindowToo?: boolean } = {}) {
  let now = 1_000_000, generation = 0, cue = 0;
  const media = new MediaRuntime(undefined, { mode: () => 'share', blocked: () => undefined }, undefined, () => now);
  const look = new LookAttachments(new LookTurns(() => now), {
    noteActivity: () => { generation++; },
    state: () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `c|${media.revision}`,
      screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true }),
    sharesCameraFrames: () => media.sharesCameraFrames(), revision: () => media.revision, generation: () => generation,
    opening: source => media.openings[source],
    captureScreen: async () => ({ source: 'screen', dataUrl: screen }),
    // A look turn's own clear picture: the window gives one when asked (main.ts: captureSharedCamera, which skips it only while held).
    captureCamera: async () => (media.sharesCameraFrames() && !media.state.cameraHeld ? { source: 'camera', dataUrl: camera } : null),
    glance: () => null, seenCamera: () => null,
    holdCamera: held => { media.holdCamera(held); },
  });
  const gate = new ProactiveSpeechGate(() => now); gate.setScope('scope');
  const windowAsked: number[] = [];
  const generated: Attachment[][] = [];
  const vision = new ProactiveVision({ gate, clock: () => now, current: () => true,
    // The camera window of main.ts: asked, it hands over a picture (the host-side check lives in captureProactiveFrames).
    capture: signal => captureProactiveFrames({ screenOn: () => options.screenOn === true, screen: async () => ({ source: 'screen', dataUrl: screen }), media,
      camera: async () => { windowAsked.push(now); return { source: 'camera', dataUrl: camera }; } }, signal),
    generate: async attachments => { generated.push(attachments); return '你那边看起来挺安静的。'; },
    offer: () => true, present: async () => true, presentationCurrent: () => true, archive: async () => {} });
  /** One proactive look opportunity, as the mood speech cue starts it. */
  async function opportunity() {
    now += 60_000; const seen = generated.length;
    await vision.start('scope', { id: `cue${++cue}`, kind: 'speech', until: now + 30_000 }, true);
    await vision.ack(`cue${cue}`); // the offer was shown: the opportunity is over, the next may start
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return generated.length > seen ? generated.at(-1)! : null;
  }
  return { media, look, vision, opportunity, generated, windowAsked, gate,
    dispose: () => { vision.dispose(); gate.dispose(); } };
}

const cameraImages = (list: Attachment[] | null) => (list ?? []).filter(item => item.source === 'camera').length;

test('发图片开着 → 说"别看" → 她主动想看画面：交给生成的输入里没有摄像头图，摄像头窗口也没被问；再说"你看看我"就可以带图', async () => {
  const h = rig();
  h.media.update({ cameraImages: true }, 'pet');
  const before = await h.opportunity();
  assert.equal(cameraImages(before), 1, '没说别看：主动看画面会用摄像头的一帧（原来的行为）');
  assert.equal(h.windowAsked.length, 1);

  await h.look.request(lookHint('别看我', false));
  assert.equal(h.media.state.cameraHeld, true);
  const held = await h.opportunity();
  assert.equal(cameraImages(held), 0, '别看之后：0 张摄像头图');
  assert.equal(h.windowAsked.length, 1, '别看之后：连摄像头窗口都没被问');
  assert.equal(held, null, "没有画面就不生成（引擎的老规矩）");

  await h.look.request(lookHint('你看看我', false));
  assert.equal(h.media.state.cameraHeld, undefined);
  const again = await h.opportunity();
  assert.equal(cameraImages(again), 1, '叫她看之后：又可以带图');
  h.dispose();
});

test('别看时屏幕还开着：主动看画面只带屏幕，不带摄像头（两个来源分开管）', async () => {
  const h = rig({ screenOn: true });
  h.media.update({ cameraImages: true, screenSharing: true }, 'pet');
  await h.look.request(lookHint('别看我', false));
  const got = await h.opportunity();
  assert.deepEqual((got ?? []).map(item => item.source), ['screen']);
  assert.equal(h.windowAsked.length, 0);
  h.dispose();
});

test('发图片关着（只开姿势识别、或都关）：主动看画面一张摄像头图也没有', async () => {
  const h = rig();
  h.media.update({ cameraLocal: true }, 'pet');
  assert.equal(h.media.sharesCameraFrames(), false);
  assert.equal(cameraImages(await h.opportunity()), 0);
  assert.equal(h.windowAsked.length, 0);
  h.dispose();
});

test('取图口的判断：发图片开着且没被拦才许拍', () => {
  const on = { sharesCameraFrames: () => true, state: { cameraOwner: 'pet' } };
  assert.equal(cameraFrameAllowed(on), true);
  assert.equal(cameraFrameAllowed({ ...on, state: { cameraOwner: 'pet', cameraHeld: true } }), false);
  assert.equal(cameraFrameAllowed({ ...on, sharesCameraFrames: () => false }), false);
});
