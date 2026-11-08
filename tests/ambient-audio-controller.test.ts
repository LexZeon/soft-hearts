import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { DesktopAPI } from '../shared/contracts';
import type { AmbientMode } from '../shared/ambient-audio';
import type { AmbientAudioView, AmbientRuntimeSubmission, AmbientSubmissionResult } from '../shared/ambient-audio-runtime';
import { AmbientAudioController } from '../src/ui/ambient-audio-controller';

const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Element {
  private text = '';
  textWrites: string[] = [];
  get textContent(): string { return this.text; }
  set textContent(value: string) { this.text = value; this.textWrites.push(value); }
  className = ''; hidden = false; disabled = false; type = '';
  children: Element[] = []; dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  onclick: (() => void) | null = null; onkeydown: ((event: KeyboardEvent) => void) | null = null;
  removed = false;
  constructor(readonly tagName: string) {}
  append(...children: Element[]): void { this.children.push(...children); }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  focus(): void {}
  remove(): void { this.removed = true; }
  click(): void { if (!this.disabled) this.onclick?.(); }
  find(text: string): Element {
    for (const child of this.children) {
      if (child.textContent === text) return child;
      try { return child.find(text); } catch { /* Search the next subtree. */ }
    }
    throw new Error(`Missing element: ${text}`);
  }
  containsText(text: string): boolean { return this.textContent.includes(text) || this.children.some(child => child.containsText(text)); }
  containsWrite(text: string): boolean { return this.textWrites.some(value => value.includes(text)) || this.children.some(child => child.containsWrite(text)); }
}
type PcmListener = ((samples: Float32Array, sourceRate: number, frameEndMs: number) => void) | null;
class Input {
  active = false;
  listener: PcmListener = null;
  enables: boolean[] = [];
  stops = 0;
  toggles = 0;
  private generation = 0;
  enableQueue: Promise<void>[] = [];
  setPcmListener(listener: PcmListener): void { this.listener = listener; }
  async setEnabled(enabled: boolean): Promise<void> {
    this.enables.push(enabled); const generation = ++this.generation;
    const wait = this.enableQueue.shift(); if (wait) await wait;
    if (generation === this.generation) this.active = enabled;
  }
  async toggle(): Promise<void> { this.toggles++; await this.setEnabled(!this.active); }
  async stop(): Promise<void> { this.stops++; this.generation++; this.active = false; }
}
const view = (sessionId: string | null = null, mode: AmbientMode = 'movie', suspended = false, startedAt = 100_000): AmbientAudioView => ({
  active: sessionId !== null, sessionId, startedAt: sessionId ? startedAt : null, mode: sessionId ? mode : null,
  suspended, reason: !sessionId ? 'off' : suspended ? 'speaking' : 'listening',
  status: !sessionId ? '声音理解已关闭' : suspended ? '朗读期间暂停理解系统声音' : '等待系统声音片段',
  origin: 'system-audio', available: true, destination: '当前本机转写连接', languageNotice: '检测结果未确定时标记未知',
});

function environment(context: TestContext) {
  let now = 0, session = 0;
  const originalDateNow = Date.now;
  const originals = ['document', 'performance'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  Date.now = () => 100_000 + now;
  const container = new Element('div'), input = new Input();
  const listeners = new Set<(state: AmbientAudioView) => void>();
  const beginModes: AmbientMode[] = [], confirmedIds: string[] = [], stopIds: Array<string | undefined> = [], submissions: AmbientRuntimeSubmission[] = [];
  const music: boolean[] = [], errors: string[] = [], expanded: boolean[] = [];
  const begins: Promise<AmbientAudioView>[] = [], stops: Promise<AmbientAudioView>[] = [], reads: Promise<AmbientAudioView>[] = [];
  const confirmations: Promise<void>[] = [];
  const replies: Promise<AmbientSubmissionResult>[] = [];
  const api: Pick<DesktopAPI, 'beginAmbientAudio' | 'confirmAmbientAudioCapture' | 'stopAmbientAudio' | 'getAmbientAudioState' | 'submitAmbientAudio' | 'onAmbientAudioState'> = {
    beginAmbientAudio: mode => { beginModes.push(mode); return begins.shift() ?? Promise.resolve(view(`session-${++session}`, mode, false, 100_000 + now)); },
    confirmAmbientAudioCapture: id => { confirmedIds.push(id); return confirmations.shift() ?? Promise.resolve(); },
    stopAmbientAudio: id => { stopIds.push(id); return stops.shift() ?? Promise.resolve(view()); },
    getAmbientAudioState: () => reads.shift() ?? Promise.resolve(view()),
    submitAmbientAudio: packet => {
      submissions.push(packet); return replies.shift() ?? Promise.resolve({ status: 'accepted', sessionId: packet.sessionId, sequence: packet.sequence,
        recordId: `${packet.sessionId}:${packet.sequence}`, inserted: true });
    },
    onAmbientAudioState: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  };
  const controller = new AmbientAudioController(container as unknown as HTMLElement, {
    api, input, onMusicEnabled: value => music.push(value), onError: message => errors.push(message), onExpanded: value => expanded.push(value),
  });
  context.after(() => {
    controller.dispose();
    Date.now = originalDateNow;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  const emit = (state: AmbientAudioView) => { for (const callback of [...listeners]) callback(state); };
  const feed = (seconds: number, level = 0.1, listener: PcmListener = input.listener) => {
    const count = Math.round(seconds * 10);
    for (let index = 0; index < count; index++) { now += 100; listener?.(new Float32Array(1600).fill(level), 16000, now); }
  };
  const utterance = (listener: PcmListener = input.listener) => { feed(0.4, 0.1, listener); feed(0.6, 0, listener); };
  return { controller, container, input, listeners, beginModes, confirmedIds, stopIds, submissions, music, errors, expanded,
    begins, stops, reads, confirmations, replies, emit, feed, utterance, setNow: (value: number) => { now = value; } };
}

test('opening and choosing a purpose does not grant ASR; explicit movie start uses the one existing capture and PCM tap', async context => {
  const f = environment(context); await f.controller.init();
  f.controller.toggleExpanded(); f.container.find('陪看电影').click(); await flush();
  assert.deepEqual(f.beginModes, []); assert.deepEqual(f.input.enables, []); assert.equal(f.submissions.length, 0);
  f.container.find('开始理解').click(); await flush();
  assert.deepEqual(f.beginModes, ['movie']); assert.deepEqual(f.input.enables, [true]); assert.equal(f.controller.active, true);
  assert.ok(f.input.listener); assert.equal(f.music.at(-1), false);
  f.utterance(); await flush(); assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].sessionId, f.controller.sessionId); assert.equal(f.submissions[0].sequence, 1);
  assert.equal(new DataView(f.submissions[0].wav).getUint32(24, true), 16000);
  assert.ok(!('language' in f.submissions[0]) && !('path' in f.submissions[0]));
});

test('music understanding keeps rhythm enabled while local dance alone never begins understanding', async context => {
  const f = environment(context); await f.controller.init();
  f.controller.toggleExpanded(); f.container.find('仅本机律动').click(); await flush();
  assert.equal(f.input.toggles, 1); assert.deepEqual(f.beginModes, []); assert.equal(f.input.listener, null);
  assert.equal(f.music.at(-1), true); assert.equal(f.controller.active, false);
  await f.controller.start('music');
  assert.deepEqual(f.beginModes, ['music']); assert.equal(f.music.at(-1), true); assert.ok(f.input.listener);
});

test('stopping while host begin is pending revokes only its late session and cannot enable capture', async context => {
  const f = environment(context), begin = deferred<AmbientAudioView>();
  await f.controller.init(); f.begins.push(begin.promise);
  const start = f.controller.start('movie'); await flush();
  const stop = f.controller.stop(); await stop;
  begin.resolve(view('session-late-begin')); await start; await flush();
  assert.deepEqual(f.input.enables, []); assert.equal(f.input.listener, null); assert.equal(f.controller.active, false);
  assert.deepEqual(f.stopIds, [undefined, 'session-late-begin']); assert.equal(f.submissions.length, 0);
});

test('stopping during pending capture releases its owner and late capture cannot attach a tap', async context => {
  const f = environment(context), capture = deferred<void>();
  await f.controller.init(); f.input.enableQueue.push(capture.promise);
  const start = f.controller.start('music'); await flush();
  assert.deepEqual(f.input.enables, [true]); assert.equal(f.input.listener, null);
  await f.controller.stop(); capture.resolve(); await start; await flush();
  assert.equal(f.input.active, false); assert.equal(f.input.listener, null); assert.equal(f.controller.active, false);
  f.utterance(); await flush(); assert.equal(f.submissions.length, 0);
});

test('an old stop response cannot apply off-state or close the replacement session capture', async context => {
  const f = environment(context), stop = deferred<AmbientAudioView>();
  await f.controller.init(); await f.controller.start('movie'); const previousId = f.controller.sessionId;
  f.stops.push(stop.promise); const stopping = f.controller.stop();
  assert.equal(f.input.listener, null); assert.equal(f.input.active, false); assert.equal(f.input.stops, 1);
  f.setNow(1000); await f.controller.start('music'); const currentId = f.controller.sessionId, currentTap = f.input.listener;
  assert.notEqual(currentId, previousId); const captureStops = f.input.stops;
  stop.resolve(view()); await stopping; await flush();
  assert.equal(f.controller.active, true); assert.equal(f.controller.sessionId, currentId);
  assert.equal(f.input.active, true); assert.equal(f.input.listener, currentTap); assert.equal(f.input.stops, captureStops);
  f.utterance(); await flush(); assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].sessionId, currentId);
});

test('stop releases the local tap/source immediately while host acknowledgement is still pending', async context => {
  const f = environment(context), acknowledged = deferred<AmbientAudioView>();
  await f.controller.init(); await f.controller.start('movie'); const oldTap = f.input.listener;
  f.stops.push(acknowledged.promise); const stopping = f.controller.stop();
  assert.equal(f.input.listener, null); assert.equal(f.input.active, false); assert.equal(f.input.stops, 1);
  // The real input reports its local release before the delayed host reply.
  f.controller.captureState({ active: false }); f.utterance(oldTap); await flush();
  assert.equal(f.stopIds.length, 1); assert.equal(f.submissions.length, 0);
  acknowledged.resolve(view()); await stopping; assert.equal(f.controller.active, false);
});

test('host suspension received during capture await is read fresh before the PCM tap can submit', async context => {
  const f = environment(context), capture = deferred<void>();
  await f.controller.init(); f.input.enableQueue.push(capture.promise);
  const start = f.controller.start('movie'); await flush(); const id = f.controller.sessionId!;
  f.emit(view(id, 'movie', true)); capture.resolve(); await start;
  f.utterance(); await flush(); assert.equal(f.submissions.length, 0); assert.equal(f.controller.active, true);
  f.emit(view(id, 'movie', false)); f.feed(0.5, 0.2); // Explicit TTS tail guard.
  f.utterance(); await flush(); assert.equal(f.submissions.length, 1);
});

test('host suspension clears partial audio and late completed results do not revive old UI text', async context => {
  const f = environment(context), reply = deferred<AmbientSubmissionResult>();
  await f.controller.init(); await f.controller.start('movie'); const id = f.controller.sessionId!;
  f.replies.push(reply.promise); f.utterance(); await flush(); assert.equal(f.submissions.length, 1);
  f.feed(0.4); f.emit(view(id, 'movie', true)); f.utterance();
  reply.resolve({ status: 'accepted', sessionId: id, sequence: 1, inserted: true, recordId: 'old-record' }); await flush();
  assert.equal(f.container.containsWrite('已保存系统音频文字'), false);
  f.emit(view(id, 'movie', false)); f.feed(0.5, 0.2); f.utterance(); await flush();
  assert.equal(f.submissions.length, 2);
  assert.equal(f.submissions[1].startOffsetMs, 2900); // No earlier partial or own TTS samples survived.
});

test('host cancellation during capture await cannot revive a session or leave capture running', async context => {
  const f = environment(context), capture = deferred<void>();
  await f.controller.init(); f.input.enableQueue.push(capture.promise);
  const start = f.controller.start('movie'); await flush(); f.emit(view());
  capture.resolve(); await start; await flush();
  assert.equal(f.controller.active, false); assert.equal(f.input.active, false); assert.equal(f.input.listener, null);
  assert.ok(f.input.stops >= 1); assert.equal(f.submissions.length, 0);
});

test('capture loss stops host understanding, detaches the tap, and does not try to reopen the device', async context => {
  const f = environment(context); await f.controller.init(); await f.controller.start('music');
  const id = f.controller.sessionId!, oldTap = f.input.listener;
  f.input.active = false; f.controller.captureState({ active: false }); await flush();
  assert.ok(f.stopIds.includes(id)); assert.equal(f.controller.active, false); assert.equal(f.input.listener, null);
  assert.deepEqual(f.input.enables, [true]); oldTap?.(new Float32Array(16000).fill(0.1), 16000, 1000); await flush();
  assert.equal(f.submissions.length, 0); assert.equal(f.music.at(-1), false);
});

test('dispose removes the tap/listener and suppresses old PCM and late begin results', async context => {
  const f = environment(context); await f.controller.init(); await f.controller.start('movie');
  const oldTap = f.input.listener, id = f.controller.sessionId!;
  f.controller.dispose(); assert.equal(f.input.listener, null); assert.equal(f.listeners.size, 0);
  assert.equal(f.controller.active, false); assert.equal(f.controller.sessionId, null);
  assert.ok(f.stopIds.includes(id)); f.utterance(oldTap); await flush(); assert.equal(f.submissions.length, 0);
});

test('dispose during pending begin revokes its returned session and cannot acquire a source', async context => {
  const f = environment(context), begin = deferred<AmbientAudioView>();
  await f.controller.init(); f.begins.push(begin.promise); const start = f.controller.start('music'); await flush();
  f.controller.dispose(); begin.resolve(view('session-disposed-begin', 'music')); await start;
  assert.deepEqual(f.input.enables, []); assert.ok(f.stopIds.includes('session-disposed-begin'));
});

test('a stale initial state read cannot overwrite a newer host event or start a capture implicitly', async context => {
  const f = environment(context), read = deferred<AmbientAudioView>();
  f.reads.push(read.promise); const loading = f.controller.init();
  f.emit(view('session-host-event', 'music')); read.resolve(view()); await loading;
  assert.equal(f.controller.sessionId, 'session-host-event'); assert.equal(f.controller.active, true);
  assert.deepEqual(f.input.enables, []); assert.equal(f.input.listener, null); assert.equal(f.beginModes.length, 0);
});

test('a failed old start cleanup cannot close a newer capture after its delayed stop acknowledgement', async context => {
  const f = environment(context), capture = deferred<void>(), oldStop = deferred<AmbientAudioView>();
  await f.controller.init(); f.input.enableQueue.push(capture.promise);
  // A superseded operation may settle quietly; only its effect on the new source matters.
  const starting = f.controller.start('movie').catch(() => {});
  await flush(); f.stops.push(oldStop.promise); capture.reject(new Error('capture denied')); await flush();
  await f.controller.start('music'); const currentId = f.controller.sessionId, currentTap = f.input.listener, captureStops = f.input.stops;
  oldStop.resolve(view()); await starting; await flush();
  assert.equal(f.controller.sessionId, currentId); assert.equal(f.input.listener, currentTap);
  assert.equal(f.input.active, true); assert.equal(f.input.stops, captureStops);
});

test('a local dance action waiting on host stop cannot reopen capture after a newer explicit stop', async context => {
  const f = environment(context), oldStop = deferred<AmbientAudioView>();
  await f.controller.init(); f.controller.toggleExpanded(); f.stops.push(oldStop.promise);
  f.container.find('仅本机律动').click(); await flush();
  await f.controller.stop(); assert.equal(f.input.active, false);
  oldStop.resolve(view()); await flush();
  assert.equal(f.input.toggles, 0); assert.equal(f.input.active, false); assert.equal(f.controller.active, false);
});

test('a late begin acknowledgement cannot overwrite a subsequent host cancellation and acquire capture', async context => {
  const f = environment(context), begin = deferred<AmbientAudioView>();
  await f.controller.init(); f.begins.push(begin.promise); const starting = f.controller.start('movie'); await flush();
  f.emit(view('session-cancelled')); f.emit(view());
  begin.resolve(view('session-cancelled')); await starting; await flush();
  assert.equal(f.controller.active, false); assert.equal(f.input.active, false); assert.equal(f.input.listener, null);
  assert.deepEqual(f.input.enables, []); assert.ok(f.stopIds.includes('session-cancelled'));
});

test('capture readiness is confirmed only after actual source/tap readiness and delayed audio keeps its host timeline', async context => {
  const f = environment(context), capture = deferred<void>();
  await f.controller.init(); f.input.enableQueue.push(capture.promise);
  const starting = f.controller.start('movie'); await flush();
  assert.deepEqual(f.confirmedIds, []); assert.equal(f.input.listener, null);
  f.setNow(31_000); capture.resolve(); await starting;
  assert.deepEqual(f.confirmedIds, [f.controller.sessionId]); assert.ok(f.input.listener);
  f.utterance(); await flush(); assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].startOffsetMs, 31_000); assert.equal(f.submissions[0].endOffsetMs, 31_550);
});

test('stale capture confirmation cannot revoke or stop the replacement session source', async context => {
  const f = environment(context), confirmed = deferred<void>();
  await f.controller.init(); f.confirmations.push(confirmed.promise);
  const starting = f.controller.start('movie'); await flush(); const oldId = f.controller.sessionId!;
  assert.deepEqual(f.confirmedIds, [oldId]); assert.ok(f.input.listener);
  await f.controller.stop(); f.setNow(1000); await f.controller.start('music');
  const currentId = f.controller.sessionId, currentTap = f.input.listener, stopped = f.input.stops;
  confirmed.resolve(); await starting; await flush();
  assert.notEqual(currentId, oldId); assert.deepEqual(f.confirmedIds, [oldId, currentId]);
  assert.equal(f.controller.sessionId, currentId); assert.equal(f.input.listener, currentTap);
  assert.equal(f.input.active, true); assert.equal(f.input.stops, stopped); assert.equal(f.stopIds.at(-1), oldId);
  f.utterance(); await flush(); assert.equal(f.submissions[0].sessionId, currentId);
});

test('an unrelated false speaking event cannot override host suspension or omit the actual final tail guard', async context => {
  const f = environment(context); await f.controller.init(); await f.controller.start('movie'); const id = f.controller.sessionId!;
  f.emit(view(id, 'movie', true)); f.controller.setSpeaking(false);
  f.utterance(); await flush(); assert.equal(f.submissions.length, 0);
  f.emit(view(id, 'movie', true)); f.feed(0.4); assert.equal(f.submissions.length, 0);
  f.emit(view(id, 'movie', false)); f.feed(0.5); f.utterance(); await flush();
  assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].startOffsetMs, 1900);
});

test('local final PCM keeps suspension after host false and repeated false states do not restart the one tail guard', async context => {
  const f = environment(context); await f.controller.init(); await f.controller.start('movie'); const id = f.controller.sessionId!;
  f.emit(view(id, 'movie', true)); f.controller.setSpeaking(true); f.emit(view(id, 'movie', false));
  f.utterance(); await flush(); assert.equal(f.submissions.length, 0);
  f.controller.setSpeaking(false); f.feed(0.3); f.emit(view(id, 'movie', false));
  f.feed(0.2); f.emit(view(id, 'movie', false)); f.utterance(); await flush();
  assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].startOffsetMs, 1500);
});

test('a late same-session begin acknowledgement cannot clear a newer host speaking state', async context => {
  const f = environment(context), begin = deferred<AmbientAudioView>();
  await f.controller.init(); f.begins.push(begin.promise); const starting = f.controller.start('movie'); await flush();
  f.emit(view('session-begin-speaking', 'movie', true));
  begin.resolve(view('session-begin-speaking', 'movie', false)); await starting;
  f.utterance(); await flush(); assert.equal(f.submissions.length, 0);
  f.emit(view('session-begin-speaking', 'movie', false)); f.feed(0.5); f.utterance(); await flush();
  assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].startOffsetMs, 1500);
});
