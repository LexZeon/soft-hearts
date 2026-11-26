/**
 * 2026-11-21 (out in full-screen Unbound with 「发图片」 on, the camera was not looked at when she was asked;
 * docs/claude/2026-11-21-unbound-camera-look.md). Synthetic phrases only (never the user's words), fake frames, fake haiku, no camera.
 *
 * What it pins:
 *  - the words: a look at the user ("你看看我是不是…"), at the camera itself ("看看摄像头吧") and "can you see me" ("看得见我吗") ask for the
 *    camera; "this" with both on takes both, but a "别看" on the camera still wins over "this";
 *  - the window: while she is out her companion window is held hidden, and the frame it gives for a request is taken (before: refused, so
 *    every camera look failed); a hidden window while she is home, another window, or a "别看" said meanwhile still gets nothing;
 *  - the journal: a failed or frameless camera look says where it broke, a cut-short one how far it got and what cut it (closed words);
 *  - a chat message (typed, or voice input sent as a message) writes the "look" line calls already had.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { scanLookRequest } from '../shared/senses/look-request';
import { lookWants } from '../shared/senses/look-at-you';
import { asksCanSeeYou } from '../shared/senses/look-can-see';
import { LookTurns } from '../electron/senses/look-turns';
import { LookAttachments, type LookAttachmentPorts } from '../electron/senses/look-attachments';
import { CameraSampleBroker } from '../electron/senses/camera-sample';
import { CameraLookJournal } from '../electron/senses/camera-look-journal';
import { cameraLookLater, type CameraLookDetail, type CameraLookLine, type CameraLookMiss, type SenseCameraResult } from '../shared/senses/camera-look';
import { SenseRouterHost, cameraDetail, type SenseRouterPorts } from '../electron/senses/sense-router/host';
import { createSenseRouter } from '../electron/senses/sense-router/wiring';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { ENGLISH_JOURNAL_UI_COPY } from '../shared/foundation/ui-copy.journal.en';
import type { CallLookFields } from '../shared/voice';
import type { Attachment } from '../shared/foundation/chat';
// Reads as text (test-affected selects this test when they change): 'electron/main.ts' (with electron/wiring/*.ts).
import { WIRING_PRELUDE, wiringHandler } from './helpers/wiring-source';

// ---------------------------------------------------------------- 1. the words

test('words: the user, the camera itself and "can you see me" ask for the camera; things, screen things and the user\'s own looking do not', () => {
  for (const text of ['你看看我是不是胖了', '你看看我像不像熬夜了', '帮我看看我脸上是不是长痘了', '看看摄像头吧', '你瞧一眼镜头', '看下我的摄像头',
    '看得见我吗', '你能看到我吗', '这会儿看得见我么', '能不能看见我'])
    assert.equal(scanLookRequest(text), 'camera', text);
  for (const [text, want] of [['你看看我写的', 'screen'], ['你看看我屏幕上这个', 'screen'], ['你看看这个', 'either'], ['你看看我这个', 'either'],
    ['你看看我的猫', 'either'], ['你看看我在干嘛', 'either'], ['你看看我，再看看屏幕', 'either']] as const)
    assert.equal(scanLookRequest(text), want, text);
  for (const text of ['我能看到你吗', '你看到我了吗', '希望你能看到我', '我看看摄像头', '你看我多惨', '你看我干嘛', '别看摄像头', '关掉摄像头吧'])
    assert.equal(scanLookRequest(text), null, text);
  assert.equal(asksCanSeeYou('看得见我么'), true);
  assert.equal(asksCanSeeYou('我看得到你么'), false);
});

test('which senses a request takes: "this" with both on takes both; a "别看" on the camera wins over "this" while the screen is there', () => {
  const both = { screen: true, camera: true };
  assert.deepEqual(lookWants('camera', both), { screen: false, camera: true });
  assert.deepEqual(lookWants('screen', both), { screen: true, camera: false });
  assert.deepEqual(lookWants('either', both), { screen: true, camera: true });
  assert.deepEqual(lookWants('either', { ...both, cameraHeld: true }), { screen: true, camera: false });
  assert.deepEqual(lookWants('either', { screen: false, camera: true, cameraHeld: true }), { screen: false, camera: true }, 'as before: "this" with only the camera on');
  assert.deepEqual(lookWants('camera', { screen: true, camera: false }), { screen: false, camera: false }, 'never a sense that is off');
  assert.deepEqual(lookWants(null, both), { screen: false, camera: false });
  const turns = new LookTurns();
  const BOTH = { screen: true, camera: true, scope: 's' };
  assert.deepEqual(pick(turns.decide({ text: '你看看我是不是胖了' }, BOTH)), { screen: false, camera: true }, 'the user, not the screen (12:57)');
  assert.deepEqual(pick(turns.decide({ text: '你看看这个' }, BOTH)), { screen: true, camera: true });
  const held = turns.decide({ text: '你看看这个' }, { ...BOTH, cameraHeld: true });
  assert.deepEqual(pick(held), { screen: true, camera: false });
  assert.equal(held.hold, undefined, 'the "别看" stays');
  assert.equal(turns.decide({ text: '你看看我是不是胖了' }, { ...BOTH, cameraHeld: true }).hold, false, 'asking her to look at the user lifts it, as before');
});
const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));
const pick = (decision: { screen: boolean; camera: boolean }) => ({ screen: decision.screen, camera: decision.camera });

// ---------------------------------------------------------------- 2. the window that takes the picture, while she is out

function evaluate<T>(body: string, env: Record<string, unknown>): T {
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
}
interface Win { webContents: { id: number }; isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean }
const JPEG = 'data:image/jpeg;base64,WU9V';

/**
 * The real chain with fakes at its ends: the camera broker (camera-sample.ts) asks the owner window; the "window" answers with a frame through
 * the wiring's own publishCameraSample handler (its text, evaluated); `heldCounts` is the companion window rule of stage-window-wiring.ts onScreen.
 */
/** The host's MediaOwner name for her companion window (an existing value the host keeps). */
const HER_WINDOW = 'pet'; // no-pet-ok: the MediaOwner value the host uses for her companion window
function camera(world: { shown: boolean; out: boolean; cameraHeld?: boolean; inControls?: boolean }, heldCounts = true) {
  const companion: Win = { webContents: { id: 1 }, isDestroyed: () => false, isVisible: () => world.shown, isMinimized: () => false };
  const controls: Win = { webContents: { id: 2 }, isDestroyed: () => false, isVisible: () => false, isMinimized: () => false };
  const onScreen = (win: Win) => !win.isDestroyed() && ((win.isVisible() && !win.isMinimized()) || (heldCounts && win === companion && world.out));
  const media = { state: { cameraSharing: true, cameraOwner: world.inControls ? 'controls' : HER_WINDOW, get cameraHeld() { return world.cameraHeld === true; } }, sharesCameraFrames: () => true };
  let handler: (sender: number, id: unknown, frame: unknown) => boolean = () => false;
  const broker = new CameraSampleBroker((owner, id) => { queueMicrotask(() => handler(owner, id, JPEG)); });
  handler = evaluate(`return (${wiringHandler('publishCameraSample')});`, {
    windows: () => [controls, companion], ownerFor: (id: number) => id === 1 ? HER_WINDOW : 'controls', media, onScreen, cameraSamples: broker });
  const ownerId = world.inControls ? 2 : 1;
  return {
    take: async (miss?: (why: CameraLookMiss) => void) => broker.request(ownerId, new AbortController().signal, miss),
  };
}

test('out in full-screen Unbound: her held-hidden companion window gives the asked-for frame; home-hidden, another window or a "别看" do not', async () => {
  const misses: CameraLookMiss[] = [];
  // Before the fix (a hidden window never counted): refused, at once and with a reason.
  assert.equal(await camera({ shown: false, out: true }, false).take(why => misses.push(why)), null);
  assert.deepEqual(misses, ['refused']);
  // After: she is out, so her companion window counts as on the screen.
  assert.deepEqual(await camera({ shown: false, out: true }).take(), { source: 'camera', dataUrl: JPEG });
  // Still closed: hidden while she is home; the control window hidden; a "别看".
  misses.length = 0;
  assert.equal(await camera({ shown: false, out: false }).take(why => misses.push(why)), null);
  assert.equal(await camera({ shown: false, out: true, inControls: true }).take(why => misses.push(why)), null);
  assert.equal(await camera({ shown: false, out: true, cameraHeld: true }).take(why => misses.push(why)), null);
  assert.deepEqual(misses, ['refused', 'refused', 'refused']);
});

test('reproduction: out, both on, "你看看我是不是胖了" asks for the camera only; with the old window rule refused (and why), with the fix one clear picture', async () => {
  const run = async (heldCounts: boolean) => {
    const cam = camera({ shown: false, out: true }, heldCounts);
    const taken = { screen: 0, camera: 0 };
    const ports: LookAttachmentPorts = {
      noteActivity: () => {}, state: () => ({ screen: true, camera: true, scope: 's' }), sharesCameraFrames: () => true, revision: () => 1, generation: () => 1, opening: () => 1,
      captureScreen: async () => { taken.screen++; return { source: 'screen', dataUrl: 'data:image/jpeg;base64,U0NSRUVO' }; },
      captureCamera: async (_signal, miss) => { taken.camera++; return cam.take(miss); },
    };
    const host = new LookAttachments(new LookTurns(), ports);
    const frames = host.admit(await host.request({ text: '你看看我是不是胖了' }));
    const lines: CameraLookLine[] = [];
    new CameraLookJournal(line => lines.push(line)).turn('m1', { frames: true, via: frames.cameraVia(), small: frames.cameraGlance(), held: false, screenSharing: true, miss: frames.cameraMiss(), text: '你看看我是不是胖了' }, false);
    return { taken, sources: frames.current().map((frame: Attachment) => frame.source), lines };
  };
  const before = await run(false);
  assert.deepEqual(before.taken, { screen: 0, camera: 1 }, 'the words now ask for the camera, not the screen');
  assert.deepEqual(before.sources, []);
  assert.deepEqual(before.lines, [{ seen: 'none', why: 'no-frame', miss: 'refused' }], 'the journal says where it broke');
  const after = await run(true);
  assert.deepEqual(after.taken, { screen: 0, camera: 1 });
  assert.deepEqual(after.sources, ['camera']);
  assert.deepEqual(after.lines, [{ seen: 'clear', via: 'words' }]);
});

// ---------------------------------------------------------------- 3. the router's own look: where it broke, how far it got

const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
class Clock {
  now = 0; private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
  readonly api = { set: (fn: () => void, ms: number) => { const id = ++this.next; this.timers.push({ at: this.now + Math.max(0, ms), fn, id }); return id; },
    clear: (id: unknown) => { this.timers = this.timers.filter(t => t.id !== id); } };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await flush();
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const due = this.timers[0];
      if (!due || due.at > end) break;
      this.timers.shift(); this.now = Math.max(this.now, due.at); due.fn();
    }
    this.now = end;
    await flush();
  }
}

function router(options: { judge?: string; capture?: SenseRouterPorts['capture']; facts?: string; free?: boolean } = {}) {
  const clock = new Clock();
  const results: [SenseCameraResult, CameraLookDetail][] = [];
  const ports: SenseRouterPorts = {
    enabled: () => true, on: () => ({ camera: true, screen: false, transcript: false }), identity: () => 'i', conversation: () => 'c',
    capture: options.capture ?? (async () => JPEG), heard: () => null,
    ask: async (_prompt, system) => system.includes('感知判定员') ? options.judge ?? '{"senses":["camera"]}' : options.facts ?? '他穿着一件蓝色衬衫。',
    line: async () => JSON.stringify({ text: '这身蓝衬衫挺精神的' }),
    character: () => ({ id: 'heroine', persona: 'p', language: '' }), mood: () => '', free: () => options.free ?? true,
    publish: () => true, speechStyle: () => {}, archive: async () => {},
    cameraLook: (_id, result, detail) => results.push([result, detail ?? {}]),
    clock: () => clock.now, timers: clock.api, createId: () => 'x',
  };
  return { host: new SenseRouterHost(ports), clock, results };
}
async function turn(r: ReturnType<typeof router>, text: string): Promise<void> {
  r.host.userTurn('m1', text, { merged: false }); r.host.firstChar('m1'); await r.clock.advance(100);
  r.host.replyDone('m1', true, '嗯'); await r.clock.advance(100);
}

test('router: a failed camera look says where it broke (refused, no window, slow, nothing made of it)', async () => {
  const refused = router({ capture: async (_sense, _signal, miss) => { miss?.('refused'); return null; } });
  await turn(refused, '我这身怎么样');
  assert.deepEqual(refused.results, [['failed', { miss: 'refused' }]]);
  const silent = router({ capture: async () => null });
  await turn(silent, '我这身怎么样');
  assert.deepEqual(silent.results, [['failed', { miss: 'slow' }]], 'no reason from the capture: its wait ran out');
  const junk = router({ facts: '' });
  await turn(junk, '我这身怎么样');
  assert.deepEqual(junk.results, [['failed', { miss: 'no-facts' }]]);
});

test('router: a cut-short look says how far it got and what cut it', async () => {
  const early = router();
  early.host.userTurn('m1', '我这身怎么样', { merged: false });
  early.host.userTurn('m2', '好吧', { merged: false });
  assert.deepEqual(early.results, [['cut-short', { stage: 'judging', end: 'newer' }]], 'a newer message before any judgment (13:12)');
  assert.deepEqual(cameraDetail('seen', null, 'busy'), { stage: 'unsaid', end: 'not-free' });
  assert.deepEqual(cameraDetail('looking', null, 'reply-ended'), { stage: 'looking', end: 'reply-ended' });
  assert.deepEqual(cameraDetail('seen', null, 'late'), { stage: 'unsaid', end: 'late' });
  assert.deepEqual(cameraDetail('seen', null, 'failed'), { miss: 'no-line' });
  assert.deepEqual(cameraDetail('no', null, 'nothing'), {}, 'a judged no adds nothing');
});

// ---------------------------------------------------------------- 4. the journal lines

test('journal: the camera line carries a miss, a stage and an end only where they apply; anything else is no line', () => {
  const write = (line: object) => buildJournalEntry({ type: 'camera-look', characterId: 'heroine', ...line }, 0);
  assert.ok(write({ seen: 'none', why: 'look-failed', miss: 'refused' }));
  assert.ok(write({ seen: 'small', why: 'no-frame', miss: 'no-window' }));
  assert.ok(write({ seen: 'none', why: 'cut-short', stage: 'unsaid', end: 'not-free' }));
  for (const bad of [{ seen: 'none', why: 'judge-no', miss: 'refused' }, { seen: 'none', why: 'look-failed', miss: 'a picture of you' },
    { seen: 'none', why: 'look-failed', stage: 'judging' }, { seen: 'none', why: 'cut-short', end: 'whatever' }])
    assert.equal(write(bad), null, JSON.stringify(bad));
  const entry = write({ seen: 'none', why: 'look-failed', miss: 'refused' })!;
  assert.match(describeJournalEntry(entry, plain), /她想看，没看成；拍到的画面没被收下/u);
  const cut = write({ seen: 'none', why: 'cut-short', stage: 'judging', end: 'newer' })!;
  assert.match(describeJournalEntry(cut, plain), /还在判断要不要看；你又说了一句/u);
  for (const words of ['拍到的画面没被收下', '还在判断要不要看', '你又说了一句', '{0}；{1}']) assert.ok(ENGLISH_JOURNAL_UI_COPY[words], words);
  assert.deepEqual(cameraLookLater(false, 'judge-no', { miss: 'refused', stage: 'judging' }), { seen: 'none', why: 'judge-no' }, 'detail never lands on another reason');
});

test('a chat message (typed or voice input sent as a message) writes the look line: judged, answered, how it ended; none with nothing on', async () => {
  const lines: (CallLookFields & { chat: true })[] = [];
  const clock = new Clock();
  let judge = '{"senses":[]}', enabled = true, on = { camera: true, screen: false, transcript: false };
  const router = createSenseRouter({
    on: () => on, identity: () => 'i', conversation: () => 'c', capture: async () => JPEG, heard: () => null,
    // no-pet-ok: petSender is the router wiring's existing port name
    character: () => ({ id: 'heroine', persona: 'p', language: '' }), mood: () => '', chatModel: () => '', free: () => true, petSender: () => 1,
    send: () => true, speechStyle: () => {}, archive: async () => {}, enabled: () => enabled, log: () => {}, lookLine: fields => lines.push(fields),
    ports: { ask: async () => judge, line: async () => JSON.stringify({ text: '嗯' }), clock: () => clock.now, timers: clock.api, createId: () => 'x' },
  });
  assert.equal(router.userTurn('m1', '今天好累', false, []), true);
  router.firstChar('m1'); await clock.advance(100); router.replyDone('m1', true, '辛苦啦'); await clock.advance(100);
  assert.deepEqual(lines, [{ call: false, chat: true, rules: 'none', judge: 'own', answer: 'none', camera: true, screen: false, result: 'judge-no' }]);
  // Cut by the next message before the judgment came: the line says the judgment was asked and the turn was cut (the 13:12 question).
  judge = '{"senses":["camera"]}'; lines.length = 0;
  router.userTurn('m2', '你能感觉到吗', false, []); router.firstChar('m2');
  router.userTurn('m3', '算了', false, []);
  assert.equal(lines[0].result, 'cut');
  assert.equal(lines[0].judge, 'own');
  // Not taken (the switch off) with the camera on: a line that says nothing was judged; nothing on: no line.
  router.cancel(); lines.length = 0; enabled = false;
  assert.equal(router.userTurn('m4', '你看看我', false, []), false);
  assert.deepEqual(lines, [{ call: false, chat: true, rules: 'none', judge: 'none', answer: 'not-asked', camera: true, screen: false, result: 'not-asked' }]);
  on = { camera: false, screen: false, transcript: false }; lines.length = 0;
  router.userTurn('m5', '今天好累', false, []);
  assert.deepEqual(lines, []);
  const entry = buildJournalEntry({ type: 'voice-call', characterId: 'heroine', event: 'look', call: false, chat: true, rules: 'none', judge: 'own', answer: 'none', camera: true, screen: false, result: 'judge-no' }, 0)!;
  assert.match(describeJournalEntry(entry, plain), /一条消息（打字或语音转文字）/u);
});
