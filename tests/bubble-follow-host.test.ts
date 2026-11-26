// I-165: the host side of "her bubble follows her voice". The order flips: a sentence is
// shown when its audio starts, so a sentence's display proof is the sentence BEFORE it ("……" for the first) — and nothing may deadlock.
// Part A runs the real PetReplyWindow (fake Electron boundaries, as tests/reply-waiting-window.test.ts) with the real reading plan; part B // no-pet-ok: the wiring's own name for the companion window (needs.pet) and the paint test's existing names
// runs the real read-aloud handlers from electron/wiring/voice-wiring.ts (as tests/r27-prefix-host-caller.test.ts).
// Reads as text (test-affected selects this test when they change): 'electron/wiring/voice-wiring.ts', 'electron/brain/reply-window.ts'.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { CompletedReplySpeech } from '../electron/voice/completed-reply-speech';
import { CompletedPrefixProof } from '../electron/voice/completed-prefix-proof';
import { ReplyPresentation } from '../electron/brain/reply-presentation';
import { ReplyRhythmHost } from '../electron/brain/reply-rhythm-host';
import { ReplySpeechStyles } from '../electron/mood/speech-emotion';
import { SpeechRuntime } from '../electron/voice/speech-runtime';
import { SpeechPlaybackActivity } from '../electron/voice/speech-playback-activity';
import { DEFAULT_TTS_CONFIG } from '../shared/voice/tts';
import { UnboundBubbleProof } from '../electron/unbound/read-aloud';
import { BUBBLE_FOLLOW_KNOBS } from '../shared/voice/bubble-follow/knobs';
import { WIRING_PRELUDE, wiringFunction, wiringHandler } from './helpers/wiring-source';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const BODY = '第一句。第二句。';

// ---- part A: the real native bubble and the real plan --------------------------------------------------------------------------

function nativeWorld(t: TestContext) {
  const ipcMain = new EventEmitter();
  const windows: Win[] = [];
  class Win extends EventEmitter {
    visible = false; minimized = false; destroyed = false; top = false; url = ''; parent: Win | null = null;
    bounds = { x: 100, y: 200, width: 400, height: 560 };
    readonly sent: Array<{ text?: string; waiting: boolean; presentationToken?: string | null }> = [];
    readonly webContents = Object.assign(new EventEmitter(), {
      send: (_channel: string, value: { text?: string; waiting: boolean; presentationToken?: string | null }) => this.sent.push(value),
      setWindowOpenHandler: () => {}, mainFrame: { url: '' }, getURL: () => this.url, isDestroyed: () => this.destroyed,
    });
    constructor(options?: { parent?: Win }) { super(); this.parent = options?.parent ?? null; windows.push(this); }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return this.minimized; } getOpacity() { return 1; }
    getParentWindow() { return this.parent; } isAlwaysOnTop() { return this.top; } setAlwaysOnTop(value: boolean) { this.top = value; }
    getBounds() { return { ...this.bounds }; } setBounds(value: typeof this.bounds) { this.bounds = { ...value }; } setIgnoreMouseEvents() {}
    loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; return Promise.resolve(); }
    hide() { const was = this.visible; this.visible = false; if (was) this.emit('hide'); }
    showInactive() { this.visible = true; this.emit('show'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const filename = new URL('../electron/brain/reply-window.ts', import.meta.url);
  const localRequire = createRequire(filename), module = { exports: {} };
  const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const injected = (name: string) => name === 'electron'
    ? { BrowserWindow: Win, ipcMain, screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) } } : localRequire(name);
  new Function('require', 'module', 'exports', '__dirname', code)(injected, module, module.exports, path.dirname(fileURLToPath(filename)));
  const owner = new Win(); owner.visible = true;
  type Reply = { update(patch: unknown): unknown; dispose(): void; waitForCompletedPrefix(full: string | (() => string | null), end: number, signal: AbortSignal, remaining: number, commit: (text: string) => boolean): Promise<boolean>; isCompletedPrefixCurrent(text: string): boolean; followingText(): string | null };
  const { PetReplyWindow } = module.exports as { PetReplyWindow: new (owner: Win) => Reply }; // no-pet-ok: the wiring's own name for the companion window (needs.pet) and the paint test's existing names
  const reply = new PetReplyWindow(owner); // no-pet-ok: the wiring's own name for the companion window (needs.pet) and the paint test's existing names
  t.after(() => reply.dispose());
  const child = () => windows[1]!;
  return { reply, owner, child,
    waiting: () => reply.update({ state: 'waiting', text: '', anchor: { x: 200, y: 210, radius: 110, visible: true } }),
    show: (text: string) => reply.update({ state: 'streaming', text }),
    /** The bubble's own preload: painted, two frames later the token goes back. */
    paint: () => { const token = child().sent.at(-1)?.presentationToken; assert.ok(token); const wc = child().webContents; ipcMain.emit('desk:reply-presented', { sender: wc, senderFrame: wc.mainFrame }, token); },
  };
}

function plan(follow: boolean) {
  const plans = new CompletedReplySpeech(undefined, { follow: () => follow });
  const fence = plans.beginCommit(8, 'reply', 'scope');
  plans.append(fence, BODY);
  assert.equal(plans.record(8, 'reply', 'scope', BODY, { prefix: true, fence }), true);
  return plans;
}

test('the plan: with follow, no sentence waits for any text to be painted (the bubble only has to be up); without, the sentence itself', () => {
  const followed = plan(true), first = followed.next(8, 'reply', 'scope')!;
  assert.equal(followed.follows('reply'), true);
  assert.equal(followed.proofEnd(8, 'reply', 'scope', first), 0);
  const second = followed.next(8, 'reply', 'scope', 0)!;
  assert.equal(followed.proofEnd(8, 'reply', 'scope', second), 0, 'the voice runs on its own; the bubble follows it');
  assert.equal(followed.approvePresentation(8, 'reply', 'scope', second, ''), true, 'the "……" bubble is enough');
  assert.equal(followed.approvePresentation(8, 'reply', 'scope', second, '别的'), false, 'never text that is not this reply');
  assert.equal(followed.segmentEnd('reply', 1), 8); assert.equal(followed.segmentEnd('other', 1), null);

  const before = plan(false), lease = before.next(8, 'reply', 'scope')!;
  assert.equal(before.follows('reply'), false);
  assert.equal(before.proofEnd(8, 'reply', 'scope', lease), 4, 'the rule before I-165');
  assert.equal(before.approvePresentation(8, 'reply', 'scope', lease, ''), false);
  assert.equal(before.proofEnd(99, 'reply', 'scope', lease), -1, 'not the lease owner');
});

test('real reply window: a followed reply is read on the "……" bubble and on text that was sent but never painted; the old rule still waits for paint', async t => {
  const w = nativeWorld(t); w.waiting(); await flush();
  assert.equal(w.child().visible, true);
  assert.equal(w.reply.followingText(), '', 'the held bubble is on screen');
  const commits: string[] = [];
  assert.equal(await w.reply.waitForCompletedPrefix(BODY, 0, new AbortController().signal, 5000, text => { commits.push(text); return true; }), true);
  w.show('第一句。'); await flush();
  assert.equal(w.reply.followingText(), '第一句。', 'sent; its paint receipt has not come back');
  assert.equal(await w.reply.waitForCompletedPrefix(BODY, 0, new AbortController().signal, 5000, text => { commits.push(text); return true; }), true, 'no paint receipt is waited for');
  assert.deepEqual(commits, ['', '第一句。']);
  let settled = false;
  const old = w.reply.waitForCompletedPrefix(BODY, 4, new AbortController().signal, 5000, text => { commits.push(text); return true; }).then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false, 'the rule before I-165 (end 4) still waits for the paint receipt');
  w.paint(); assert.equal(await old, true);
});

test('real reply window: a hidden companion holds nothing, with or without text; a wait fails when it leaves the screen', async t => {
  const w = nativeWorld(t); w.waiting(); await flush();
  w.show('第一句。'); await flush(); assert.equal(w.reply.followingText(), '第一句。');
  w.reply.update({ interactionOpacity: 0 }); // a pat fades the bubble out
  assert.equal(w.reply.followingText(), null, 'a faded bubble holds nothing');
  w.reply.update({ interactionOpacity: 1 }); assert.equal(w.reply.followingText(), '第一句。');
  w.owner.visible = false; w.owner.emit('hide');
  assert.equal(w.reply.followingText(), null);
  assert.equal(await w.reply.waitForCompletedPrefix(BODY, 0, new AbortController().signal, 5000, () => true), false);
});

test('the prefix proof: end 0 takes what the bubble holds for this reply at once, never another reply\'s text, never a hidden bubble', async () => {
  let held: string | null = '';
  const snapshot = { text: '', revision: 0, ready: false, ownerCurrent: true };
  const proof = new CompletedPrefixProof({ snapshot: () => ({ ...snapshot }), current: () => false, waitExact: async () => false, following: () => held });
  const commits: string[] = [];
  assert.equal(await proof.wait(BODY, 0, new AbortController().signal, 1000, text => { commits.push(text); return true; }), true);
  held = '第一句。';
  assert.equal(await proof.wait(BODY, 0, new AbortController().signal, 1000, text => { commits.push(text); return true; }), true);
  assert.deepEqual(commits, ['', '第一句。']);
  for (const value of ['另一条回复。', null]) {
    held = value; let settled = false;
    const waiting = proof.wait(BODY, 0, new AbortController().signal, 1000, () => true).then(result => { settled = true; return result; });
    await flush(); assert.equal(settled, false, `${value ?? 'hidden'}: still waiting`);
    proof.cancel(); assert.equal(await waiting, false);
  }
  held = '';
  let settled = false;
  const later = proof.wait(BODY, 4, new AbortController().signal, 1000, () => true).then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false, 'the old rule (end 4) never takes the following text');
  proof.cancel(); await later;
});

// ---- part B: the real read-aloud handlers ---------------------------------------------------------------------------------------

const compiled = ts.transpileModule(WIRING_PRELUDE + '\n' + ['withCompletedPrefixProof', 'canBeginSpeechPlaybackActivity', 'cancelCompletedReply', 'cancelReplyStyle', 'replySurface', 'herOnScreen', 'heldLineSpeakable'].map(name => wiringFunction(name)).join('\n')
  + '\nreturn {' + Object.entries({ next: 'nextReplySpeechSegment', synth: 'synthesizeSpeech', begin: 'beginSpeechPlaybackActivity', end: 'endSpeechPlaybackActivity' }).map(([key, name]) => key + ':(' + wiringHandler(name) + ')').join(',') + ',cancel:cancelCompletedReply};',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

/** A reply surface with the companion window's proof semantics: exact painted prefixes, plus what it holds for her voice (I-165). */
class Surface {
  text = ''; revision = 0; shown = true; paintedText: string | null = null; readonly recipient = {}; token: string | null = null; private serial = 0;
  readonly native = new ReplyPresentation({ createToken: () => 'native-token-' + (++this.serial).toString().padStart(8, '0') });
  readonly prefix = new CompletedPrefixProof({ snapshot: () => ({ text: this.text, revision: this.revision, ownerCurrent: true, ready: !!this.text }),
    current: text => this.isCompletedPrefixCurrent(text), following: () => this.followingText(),
    waitExact: async (text, signal) => { const token = this.token, ok = await this.native.waitForPresentation(text, signal); if (ok && token && this.native.isCurrent(token, this.recipient)) this.paintedText = text; return ok && this.isCompletedPrefixCurrent(text); } });
  /** Her voice reached a sentence: the companion publishes that much (it paints two frames later: ack, maybe never). */
  reveal(text: string) { this.text = text; this.revision++; this.token = this.native.begin(text, this.recipient); this.prefix.changed(); }
  ack() { assert.ok(this.token); assert.equal(this.native.acknowledge(this.token, this.recipient, true), true); this.prefix.changed(); }
  hide() { this.shown = false; this.prefix.changed(); }
  waitForCompletedPrefix(full: string, end: number, signal: AbortSignal, remaining: number, commit: (text: string) => boolean) { return this.prefix.wait(full, end, signal, remaining, commit); }
  isCompletedPrefixCurrent(text: string) { return this.paintedText === text && this.text === text; }
  isPresentationCurrent(text: string) { return this.isCompletedPrefixCurrent(text); }
  followingText() { return this.shown ? this.text : null; }
  close() { this.prefix.cancel(); this.native.dispose(); }
}

function handlers(t: TestContext, options: { knobs?: typeof BUBBLE_FOLLOW_KNOBS; out?: boolean } = {}) {
  const plans = new CompletedReplySpeech(undefined, { follow: () => true }), styles = new ReplySpeechStyles(), surface = new Surface(), activity = new SpeechPlaybackActivity();
  activity.setScope('scope');
  const requests: string[] = [], effects: unknown[] = [];
  let finish!: () => void; const transport = new Promise<void>(resolve => { finish = resolve; });
  const runtime = new SpeechRuntime((owner, context) => ({ ...DEFAULT_TTS_CONFIG, ...styles.resolveStyle(owner, context!.replyId, 'scope') }), (_owner, event) => effects.push(event),
    async (_config, text) => { requests.push(text); await transport; });
  // Out in full-screen Unbound: her bubble's real display proof is the surface, and its page never reports a paint in these tests.
  const page = new UnboundBubbleProof({ active: () => true });
  const pet = { webContents: { id: 7, send: () => {} }, isDestroyed: () => false, isVisible: () => !options.out, isMinimized: () => false }; // no-pet-ok: the wiring's own name for the companion window (needs.pet) and the paint test's existing names
  const controls = { webContents: { id: 8, send: () => {} }, isDestroyed: () => false, isVisible: () => !options.out, isMinimized: () => false };
  const env = { completedReplySpeech: plans, replySpeechStyles: styles, replyRhythm: new ReplyRhythmHost(), speechRuntime: runtime, speechPlaybackActivity: activity, petReply: surface, pet, controls, // no-pet-ok: the wiring's own name for the companion window (needs.pet) and the paint test's existing names
    windows: () => [pet, controls], speechScope: () => 'scope', store: { current: { voice: { enabled: true } } }, textMemorialHost: null, // no-pet-ok: the wiring's own name for the companion window (needs.pet) and the paint test's existing names
    unbound: options.out ? { state: 'unbound', readAloud: page } : { state: 'normal' }, lastVisionSpeech: null,
    lastAmbientSpeech: null, visionPresentation: null, broadcast: (channel: string, value: unknown) => effects.push({ channel, value }), syncFatigueActivity: () => {}, suspendAmbientSpeech: () => {},
    BUBBLE_FOLLOW_KNOBS: options.knobs ?? BUBBLE_FOLLOW_KNOBS };
  const host = new Function(...Object.keys(env), compiled)(...Object.values(env)) as {
    next(owner: number, id: string, prior?: number): Promise<{ index: number; text: string; context: unknown } | null>;
    synth(owner: number, id: string, text: string, context: unknown): Promise<void>; begin(owner: number, id: string): Promise<string | null>; cancel(id?: string): void };
  let fence: object, id = 'reply';
  const accept = (replyId: string) => {
    id = replyId; fence = plans.beginCommit(8, replyId, 'scope'); styles.begin(8, replyId, 'scope');
    styles.complete(8, replyId, 'scope', { primary: 'calm', context: 'neutral' }, { instruction: 'frozen', emotion: 'calm' });
  };
  accept('reply');
  t.after(() => { host.cancel(); finish(); runtime.stop(); activity.dispose(); surface.close(); });
  return { plans, surface, page, host, requests, finish, accept, say: (text: string) => plans.append(fence, text), done: (body = BODY) => plans.record(8, id, 'scope', body, { prefix: true, fence }) };
}

test('real handlers: her voice never waits for the bubble: sentence 1 on the "……" bubble, sentence 2 before sentence 1 was even painted', { timeout: 5000 }, async t => {
  const h = handlers(t);
  h.say('第一句。');
  const first = await h.host.next(8, 'reply');
  assert.equal(first?.index, 0, 'the first lease is out before any text was shown');
  const lease = await h.host.begin(8, 'playback');
  assert.equal(typeof lease, 'string', 'her voice may start playing on the held bubble');
  const speaking = h.host.synth(8, 'synth-0', first!.text, first!.context); await flush();
  assert.deepEqual(h.requests, ['第一句。'], 'the paid synthesis runs on the held bubble too');
  h.say('第二句。'); h.done();
  assert.equal((await h.host.next(8, 'reply', 0))?.index, 1, 'nothing painted (no reveal, no receipt): the second sentence is prepared on time');
  h.surface.reveal('第一句。'); // the bubble follows, its receipt never comes back
  assert.equal(await h.host.next(8, 'reply', 1), null);
  h.finish(); await speaking;
});

test('real handlers: a cancelled reading never revives; a bubble that cannot be seen at all ends the reading instead of hanging', { timeout: 5000 }, async t => {
  const h = handlers(t);
  h.say(BODY); h.done();
  assert.equal((await h.host.next(8, 'reply'))?.index, 0);
  h.host.cancel('reply');
  h.surface.reveal('第一句。'); h.surface.ack();
  assert.equal(await h.host.next(8, 'reply', 0).catch(() => null), null, 'cancelled: a late paint changes nothing');

  const stuck = handlers(t, { knobs: { ...BUBBLE_FOLLOW_KNOBS, proofWaitMs: 40 } });
  stuck.say(BODY); stuck.done(); stuck.surface.hide();
  await assert.rejects(stuck.host.next(8, 'reply'), /尚未确认显示/, 'her bubble cannot be seen: the reading stops instead of waiting forever');
  assert.equal(stuck.plans.busy, false, 'and the plan is cancelled (the windows show everything)');
});

test('out in full-screen Unbound: the page reports late or never: her voice starts on time; interrupted in a call, the next reply starts on time too', { timeout: 5000 }, async t => {
  const h = handlers(t, { out: true });
  h.page.hold('reply'); // electron/unbound/bubble-hold.ts: "……" for a reply that follows her voice
  h.say('第一句。');
  const first = await h.host.next(8, 'reply');
  assert.equal(first?.index, 0, 'no paint report from the page: the first sentence is out');
  assert.equal(typeof await h.host.begin(8, 'playback'), 'string', 'the hidden reading window may play');
  void h.host.synth(8, 'synth-0', first!.text, first!.context); await flush();
  assert.deepEqual(h.requests, ['第一句。']);
  h.page.sent('reply', '第一句。'); // the host sent the sentence when it sounded; the page never reports it painted
  h.say('第二句。'); h.done();
  assert.equal((await h.host.next(8, 'reply', 0))?.index, 1, 'still no report: the second sentence is on time');
  // Talked over in the call (voice-call interrupt): the reading is cancelled; her next reply streams in.
  h.host.cancel('reply');
  h.accept('reply-2'); h.page.hold('reply-2');
  h.say('好，我听你说。'); h.done('好，我听你说。');
  const next = await h.host.next(8, 'reply-2');
  assert.equal(next?.index, 0, 'the next reply after an interruption starts on time, with no report from the page');
  assert.equal(next?.text, '好，我听你说。');
  // A reply that did not follow (no hold) but was sent to the bubble: still no wait for the page.
  h.host.cancel('reply-2');
  h.accept('reply-3'); h.page.sent('reply-3', '嗯。');
  h.say('嗯。'); h.done('嗯。');
  assert.equal((await h.host.next(8, 'reply-3'))?.index, 0);
});

test('withCompletedPrefixProof, following: it commits only what her bubble still holds for this reply at that moment', async () => {
  const SEG = { replyId: 'reply', index: 1, text: '第二句。', visibleText: BODY, context: { replyId: 'reply', segmentIndex: 1 } };
  const run = async (holds: string | null) => {
    const commits: string[] = [];
    const surface = { waitForCompletedPrefix: async (_full: unknown, end: number, _signal: unknown, _remaining: number, commit: (text: string) => boolean) => { assert.equal(end, 0); return commit('第一句。'); },
      isCompletedPrefixCurrent: () => false, followingText: () => holds };
    const completedReplySpeech = { fullPresentationText: () => BODY, presentationSignal: () => new AbortController().signal, prefixMode: () => true, presentationRemaining: () => 60_000,
      ownsLease: () => true, approvePresentation: (_o: number, _i: string, _s: string, _l: unknown, text: string) => { commits.push(text); return true; }, proofEnd: () => 0 };
    const env = { store: { current: { voice: { enabled: true } } }, completedReplySpeech, replySurface: () => surface, speechScope: () => 'scope', BUBBLE_FOLLOW_KNOBS };
    const proof = new Function(...Object.keys(env), ts.transpileModule(WIRING_PRELUDE + '\n' + wiringFunction('withCompletedPrefixProof') + '\nreturn withCompletedPrefixProof;',
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env)) as (o: number, i: string, s: string, seg: unknown, c: () => boolean) => Promise<boolean>;
    return { result: await proof(8, 'reply', 'scope', SEG, () => true), commits };
  };
  assert.deepEqual(await run('第一句。'), { result: true, commits: ['第一句。'] }, 'the paint receipt is never asked for (isCompletedPrefixCurrent is false here)');
  assert.deepEqual(await run(null), { result: false, commits: [] }, 'her bubble went away meanwhile: nothing is committed');
  assert.deepEqual(await run('第一句。第二'), { result: false, commits: [] }, 'it holds something else now: nothing is committed');
});

test('real handler noteReplySpeechHeard: only from her own windows, well formed, to her full-screen bubble; a cancel releases it', () => {
  const calls: unknown[][] = [];
  const bubbleHold = { heard: (...args: unknown[]) => calls.push(['heard', ...args]), release: (...args: unknown[]) => calls.push(['release', ...args]) };
  const pet = { webContents: { id: 7 } }, plans = new CompletedReplySpeech(undefined, { follow: () => true }); // no-pet-ok: the wiring's own name for the companion window (needs.pet) and the paint test's existing names
  const env = { windows: () => [pet], unbound: { state: 'unbound', bubbleHold }, completedReplySpeech: plans, speechRuntime: { cancelReply() {} }, replySpeechStyles: { cancel() {} }, // no-pet-ok: the wiring's own name for the companion window (needs.pet) and the paint test's existing names
    suspendAmbientSpeech: () => {}, store: { current: { voice: { enabled: true } } },
    voiceCall: { addOn: { voiced: (id: unknown) => calls.push(['voiced', id]) }, // I-197: a sentence's start ends that reply's add-on window
      sentenceHeard: (id: unknown, index: unknown, phase: unknown) => calls.push(['sentence', id, index, phase]) } }; // I-204: where her voice is
  const code = ts.transpileModule(WIRING_PRELUDE + '\n' + wiringFunction('cancelCompletedReply') + '\nreturn { heard: (' + wiringHandler('noteReplySpeechHeard') + '), cancel: cancelCompletedReply };',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const host = new Function(...Object.keys(env), code)(...Object.values(env)) as { heard(sender: number, id: unknown, index: unknown, phase: unknown): void; cancel(id?: string): void };
  host.heard(7, 'reply', 0, 'start'); host.heard(7, 'reply', 0, 'end'); host.heard(7, 'reply', -1, 'over');
  host.heard(99, 'reply', 1, 'start'); host.heard(7, 'bad id!', 1, 'start'); host.heard(7, 'reply', 1.5, 'start'); host.heard(7, 'reply', 1, 'later'); host.heard(7, 'reply', 500, 'start');
  assert.deepEqual(calls, [['heard', 'reply', 0, 'start'], ['voiced', 'reply'], ['sentence', 'reply', 0, 'start'], ['heard', 'reply', 0, 'end'], ['sentence', 'reply', 0, 'end'],
    ['release', 'reply', 'over'], ['sentence', 'reply', -1, 'over']], 'a foreign window or a malformed fact changes nothing');
  host.cancel('reply');
  assert.deepEqual(calls.at(-1), ['release', 'reply', 'cancelled'], 'a cancelled reading shows the rest of her full-screen bubble');
});
