/**
 * #5 on the real host pieces: the actual PetReplyWindow (electron/reply-window.ts, fake Electron boundaries, no app or native
 * window) asks how long once per completion and keeps exactly that; R27's display is untouched; the real MoodHost
 * (electron/mood.ts, isolated temporary directory) adds her mood and explains it only in developer mode, memory only.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import type { PetReplyPieces, PetReplyUpdate } from '../shared/contracts';
import type { ReplyLingerBubble } from '../shared/behaviors/reply-linger/interface';
import { REPLY_LINGER_KNOBS } from '../shared/behaviors/reply-linger/knobs';
import { ReplyLingerDirector } from '../shared/behaviors/reply-linger/choose';
import { replyPieces } from '../shared/reply-bubbles';
import { MoodHost } from '../electron/mood';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';

const [SHORTEST, LONGEST] = REPLY_LINGER_KNOBS.range;
interface Render { text?: string; waiting: boolean; pieces: PetReplyPieces | null; segmented: boolean }
interface Reply { update(patch: PetReplyUpdate): { lingerMs: number } | undefined; clear(): void; dispose(): void }

function fixture(t: TestContext, linger?: (bubble: ReplyLingerBubble) => number) {
  // Date moves with the timers: the lifetime measures how long a bubble has been in sight (Codex T-207 2C).
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const windows: WindowFixture[] = [];
  const ipcMain = new EventEmitter();
  class WindowFixture extends EventEmitter {
    visible = false; minimized = false; destroyed = false; top = false;
    bounds = { x: 100, y: 200, width: 400, height: 560 };
    url = '';
    parent: WindowFixture | null = null;
    readonly sent: Render[] = [];
    readonly webContents = Object.assign(new EventEmitter(), {
      send: (_channel: string, value: Render) => this.sent.push(structuredClone(value)),
      setWindowOpenHandler: () => {}, mainFrame: { url: '' }, getURL: () => this.url, isDestroyed: () => this.destroyed,
    });
    constructor(options?: { parent?: WindowFixture }) { super(); this.parent = options?.parent ?? null; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    getOpacity() { return 1; }
    getParentWindow() { return this.parent; }
    isAlwaysOnTop() { return this.top; }
    setAlwaysOnTop(value: boolean) { this.top = value; }
    getBounds() { return { ...this.bounds }; }
    setBounds(value: typeof this.bounds) { this.bounds = { ...value }; }
    setIgnoreMouseEvents() {}
    loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; return Promise.resolve(); }
    hide() { const wasVisible = this.visible; this.visible = false; if (wasVisible) this.emit('hide'); }
    showInactive() { this.visible = true; this.emit('show'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const filename = new URL('../electron/reply-window.ts', import.meta.url);
  const localRequire = createRequire(filename), module = { exports: {} };
  const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const injectedRequire = (name: string) => name === 'electron'
    ? { BrowserWindow: WindowFixture, ipcMain, screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) } }
    : localRequire(name);
  new Function('require', 'module', 'exports', '__dirname', code)(injectedRequire, module, module.exports, path.dirname(fileURLToPath(filename)));
  const owner = new WindowFixture(); owner.visible = true;
  const { PetReplyWindow } = module.exports as { PetReplyWindow: new (owner: WindowFixture, linger?: (bubble: ReplyLingerBubble) => number) => Reply };
  const reply = linger ? new PetReplyWindow(owner, linger) : new PetReplyWindow(owner);
  t.after(() => reply.dispose());
  const anchor = { x: 200, y: 210, radius: 110, visible: true };
  return { reply, advance: (ms: number) => t.mock.timers.tick(ms), child: () => windows[1]!, ready: async () => { await Promise.resolve(); },
    stream: (text: string, state: 'streaming' | 'complete' = 'streaming') => reply.update({ state, text, pieces: replyPieces(text)!, segmented: false, anchor }) };
}

test('the window asks once per completion, with exactly what it shows, and keeps exactly that; streaming, fades and anchors never ask or renew', async t => {
  const asked: ReplyLingerBubble[] = [];
  const f = fixture(t, bubble => { asked.push(structuredClone(bubble)); return 6400; });
  f.reply.update({ state: 'waiting', text: '', anchor: { x: 200, y: 210, visible: true } }); await f.ready();
  assert.equal(f.stream('第一句。'), undefined); assert.equal(f.stream('第一句。第二句要问你吗？'), undefined);
  f.advance(60_000); assert.equal(asked.length, 0, 'streaming (and speech held as streaming) never counts down'); assert.equal(f.child().visible, true);
  assert.deepEqual(f.reply.update({ state: 'complete' }), { lingerMs: 6400 });
  assert.deepEqual(asked, [{ text: '第一句。第二句要问你吗？', pieces: replyPieces('第一句。第二句要问你吗？'), segmented: false }]);
  f.advance(3000);
  // A fade or a new position answers how long it still stays (Codex T-207 2C): never a renewal.
  for (const patch of [{ interactionOpacity: 0 }, { interactionOpacity: 0.5 }, { interactionOpacity: 1 }, { anchor: { x: 210, y: 220, visible: true } }])
    assert.deepEqual(f.reply.update(patch), { lingerMs: 3400 });
  assert.equal(asked.length, 1, 'hover and pat fades never ask again');
  f.advance(3399); assert.equal(f.child().visible, true, 'fading never renewed or paused the lifetime');
  f.advance(1); assert.equal(f.child().visible, false);
  // A repeated completion (speech end after the transport end) asks again and replaces the timer.
  f.stream('新的一句。'); f.reply.update({ state: 'complete' }); f.advance(2000); f.reply.update({ state: 'complete' });
  assert.equal(asked.length, 3); f.advance(6399); assert.equal(f.child().visible, true); f.advance(1); assert.equal(f.child().visible, false);
});

for (const [name, decider] of [['her own choice', undefined], ['the longest', () => LONGEST]] as const)
test(`R27 is untouched (${name}): the first sentence shows the moment it streams, each sentence its own bubble, a long reply whole until its own time`, async t => {
  {
    const f = fixture(t, decider);
    f.stream('第一句。'); await f.ready();
    const child = f.child(); assert.equal(child.visible, true);
    assert.equal(child.sent.at(-1)?.text, '第一句。', 'no wait before the first sentence'); assert.equal(child.sent.at(-1)?.pieces?.mode, 'bubbles');
    const long = Array.from({ length: 30 }, (_, i) => `这是第 ${i + 1} 句话，每一句都是一个独立的气泡。`).join('');
    f.stream(long); const answer = f.reply.update({ state: 'complete' })!;
    assert.equal(child.sent.at(-1)?.text, undefined, 'completion re-sends nothing');
    const shown = child.sent.filter(render => render.text !== undefined).at(-1)!;
    assert.equal(shown.text, long, 'the whole long reply reached the bubble'); assert.deepEqual(shown.pieces, replyPieces(long));
    assert.equal(shown.pieces!.ends.length, 30, 'one bubble per sentence');
    const floor = REPLY_LINGER_KNOBS.readable.noticeMs + 18 / REPLY_LINGER_KNOBS.readable.charsPerSecond * 1000;
    assert.ok(answer.lingerMs >= floor, `${answer.lingerMs} ms is enough to read the last bubble`);
    f.advance(answer.lingerMs - 1); assert.equal(child.visible, true); f.advance(1); assert.equal(child.visible, false);
  }
});

for (const [name, decider, kept] of [['throws', () => { throw new Error('broken'); }, LONGEST], ['too short', () => -1, SHORTEST],
  ['not a number', () => NaN, LONGEST], ['too long', () => 1e9, LONGEST]] as const)
test(`a decider that ${name} never breaks the reply: it is held to the range`, async t => {
  const f = fixture(t, decider); f.stream('回答。'); await f.ready();
  assert.deepEqual(f.reply.update({ state: 'complete' }), { lingerMs: kept });
  f.advance(kept - 1); assert.equal(f.child().visible, true); f.advance(1); assert.equal(f.child().visible, false);
});

test('a completion with nothing readable asks nothing', async t => {
  let asked = 0; const f = fixture(t, () => { asked++; return 9000; });
  f.reply.update({ state: 'waiting', text: '' }); await f.ready();
  assert.deepEqual(f.reply.update({ state: 'complete' }), { lingerMs: SHORTEST }); assert.equal(asked, 0); assert.equal(f.child().visible, false);
});

test('a proactive (segmented) message is read by its last paragraph', async t => {
  const asked: ReplyLingerBubble[] = []; const f = fixture(t, bubble => { asked.push(bubble); return 5000; });
  f.reply.update({ state: 'streaming', text: '我看到你在写代码。\n\n要不要休息一下？', segmented: true, anchor: { x: 200, y: 210, visible: true } }); await f.ready();
  f.reply.update({ state: 'complete' });
  assert.deepEqual(asked, [{ text: '我看到你在写代码。\n\n要不要休息一下？', pieces: null, segmented: true }]);
  const choice = new ReplyLingerDirector({ random: () => 0.5 }); choice.decide('gene', asked[0], null);
  assert.equal(choice.recent('gene')[0].why[0], '最后一句在问你（多留一会儿）'); assert.match(choice.recent('gene')[0].why[1], /^7 个字/);
});

test('MoodHost adds her mood and card; the why goes out in developer mode only and is never saved', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-reply-linger-'));
  const clock = { now: 1_000_000 }, views: MoodView[] = [];
  const host = new MoodHost(directory, view => views.push(view), () => clock.now, { replyLinger: new ReplyLingerDirector({ random: () => 0.5, clock: () => clock.now }) });
  const question: ReplyLingerBubble = { text: '你今天累不累？', pieces: replyPieces('你今天累不累？'), segmented: false };
  try {
    await host.load();
    host.activate('gene', structuredClone(DEFAULT_MOOD_PARAMETERS));
    const published = views.length, quiet = host.decideReplyLinger(question);
    assert.ok(quiet >= SHORTEST && quiet <= LONGEST);
    assert.equal(views.length, published, 'outside developer mode nothing is published for it');
    assert.equal(host.get().replyLingerWhy, undefined);
    host.setDeveloperMode(true); assert.equal(host.setTestMood('happy'), 'happy');
    const happy = host.decideReplyLinger(question);
    const why = views.at(-1)!.replyLingerWhy!;
    assert.equal(why[0].ms, happy);
    assert.deepEqual(why[0].why.slice(0, 3), ['最后一句在问你（多留一会儿）', '6 个字（读完约 2.0 秒）', '心情：愉快（收得早一点）']);
    for (const reason of why[0].why.slice(3)) assert.match(reason, /^这会儿.+（(多留一会儿|收得早一点)）$/, 'anything else is her tendency now');
    host.setTestMood('longing'); const longing = host.decideReplyLinger(question);
    assert.ok(longing > happy, `missing you (${longing}) stays longer than happy (${happy})`);
    clock.now += 60_000; await host.flush();
    const saved = await readFile(path.join(directory, 'mood-state.json'), 'utf8');
    for (const word of ['replyLinger', '最后一句', '个字', '累不累']) assert.ok(!saved.includes(word), `${word} is not saved`);
    host.setDeveloperMode(false); assert.equal(host.get().replyLingerWhy, undefined);
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
