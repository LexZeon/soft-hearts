import assert from 'node:assert/strict';
import test from 'node:test';
import { AmbientAudioSegments, type AmbientEncodedSegment } from '../src/ui/ambient-audio-segments';
import { AmbientAudioControls } from '../src/ui/AmbientAudio';

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const pcm = (seconds: number, level = 0.1, rate = 16000) => new Float32Array(Math.round(seconds * rate)).fill(level);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function packetPcm(packet: AmbientEncodedSegment): Int16Array { return new Int16Array(packet.wav.slice(44)); }

test('system-audio PCM stays inert until an explicit valid session; stop discards partial audio', async () => {
  const packets: AmbientEncodedSegment[] = [];
  const segments = new AmbientAudioSegments({ onSegment: async packet => { packets.push(packet); return true; }, now: () => 0 });
  segments.push(pcm(1), 16000, 1000); await flush();
  assert.equal(packets.length, 0); assert.equal(segments.active, false);
  assert.throws(() => segments.start('', 'music'), /会话/);
  assert.throws(() => segments.start('session', 'other' as 'music'), /会话/);
  segments.start('session', 'music', 1000);
  segments.push(pcm(0.5), 16000, 1500);
  assert.equal(segments.state.bufferedSamples, 8000);
  segments.stop(); await flush();
  assert.equal(segments.state.bufferedSamples, 0); assert.equal(packets.length, 0);
  segments.push(pcm(1), 16000, 2500); await flush();
  assert.equal(packets.length, 0);
});

test('silence and short noises are not sent; a final bounded WAV preserves voiced sound and a short tail', async () => {
  const packets: AmbientEncodedSegment[] = [];
  const segments = new AmbientAudioSegments({ onSegment: async packet => { packets.push(packet); return true; }, now: () => 0 });
  segments.start('music-session', 'music', 0);
  for (let index = 1; index <= 10; index++) segments.push(pcm(0.1, 0), 16000, index * 100);
  segments.push(pcm(0.1), 16000, 1100);
  for (let index = 12; index <= 18; index++) segments.push(pcm(0.1, 0), 16000, index * 100);
  await flush(); assert.equal(packets.length, 0);
  for (let index = 19; index <= 22; index++) segments.push(pcm(0.1, 0.2), 16000, index * 100);
  for (let index = 23; index <= 28; index++) segments.push(pcm(0.1, 0), 16000, index * 100);
  await flush(); assert.equal(packets.length, 1);
  const packet = packets[0], view = new DataView(packet.wav);
  assert.equal(new TextDecoder().decode(packet.wav.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16); assert.equal(view.getUint32(40, true), 8800 * 2);
  assert.equal(packet.mode, 'music'); assert.equal(packet.sessionKey, 'music-session'); assert.equal(packet.sequence, 1);
  assert.equal(packet.startOffsetMs, 1800); assert.equal(packet.endOffsetMs, 2350);
  const audio = packetPcm(packet); assert.equal(audio.length, 8800);
  assert.equal(audio[0], 6553); assert.equal(audio[6399], 6553); assert.equal(audio[6400], 0);
  assert.equal(segments.state.bufferedSamples, 0);
});

test('continuous music is bounded by the segment duration without resetting sequence or timing', async () => {
  const packets: AmbientEncodedSegment[] = [];
  const segments = new AmbientAudioSegments({ limits: { maxSeconds: 1 },
    onSegment: async packet => { packets.push(packet); return true; }, now: () => 0 });
  segments.start('continuous', 'music', 5000);
  for (let index = 1; index <= 25; index++) { segments.push(pcm(0.1), 16000, 5000 + index * 100); await flush(); }
  assert.equal(packets.length, 2); assert.deepEqual(packets.map(value => value.sequence), [1, 2]);
  assert.deepEqual(packets.map(value => [value.startOffsetMs, value.endOffsetMs]), [[0, 1000], [1000, 2000]]);
  assert.ok(packets.every(value => packetPcm(value).length === 16000));
  assert.equal(segments.state.bufferedSamples, 8000);
  segments.stop(); assert.equal(segments.state.bufferedSamples, 0); assert.equal(packets.length, 2);
});

test('native PCM resampling, invalid samples, and exact pre-consent trimming keep the outgoing duration truthful', async () => {
  const packets: AmbientEncodedSegment[] = [];
  const segments = new AmbientAudioSegments({ limits: { maxSeconds: 1 },
    onSegment: async packet => { packets.push(packet); return true; }, now: () => 0 });
  segments.start('movie-session', 'movie', 250);
  // This first native block straddles session consent. Only its last 250ms may remain.
  segments.push(pcm(0.5, 0.2, 48000), 48000, 500);
  const native = pcm(0.75, 0.3, 48000); native[0] = NaN; native[1] = Infinity;
  segments.push(native, 48000, 1250); await flush();
  assert.equal(packets.length, 1); const packet = packets[0];
  assert.equal(packet.mode, 'movie'); assert.equal(packet.startOffsetMs, 0); assert.equal(packet.endOffsetMs, 1000);
  const audio = packetPcm(packet); assert.equal(audio.length, 16000);
  assert.equal(audio[0], 6553); assert.equal(audio[3999], 6553); assert.ok(audio[4000] >= 0 && audio[4000] < 9830);
  assert.equal(audio[4001], 9830);
});

test('one in-flight request and one queued segment bound backpressure; skipped intervals are visible', async () => {
  const first = deferred<string>(), second = deferred<string>();
  const requests: { packet: AmbientEncodedSegment; signal: AbortSignal }[] = [], accepted: string[] = [], gaps: unknown[] = [], statuses: string[] = [];
  const segments = new AmbientAudioSegments({ limits: { maxSeconds: 1 }, now: () => 4000,
    onSegment: (packet, signal) => { requests.push({ packet, signal }); return requests.length === 1 ? first.promise : second.promise; },
    onAccepted: value => accepted.push(value), onGap: gap => gaps.push(gap), onStatus: value => statuses.push(value) });
  segments.start('backpressure', 'music', 0);
  segments.push(pcm(1), 16000, 1000); await flush(); assert.equal(requests.length, 1);
  segments.push(pcm(1), 16000, 2000); segments.push(pcm(1), 16000, 3000);
  assert.equal(requests.length, 1); assert.equal(segments.state.inFlight, true); assert.equal(segments.state.queued, true);
  assert.deepEqual(gaps, [{ startOffsetMs: 2000, endOffsetMs: 3000, reason: 'backpressure' }]);
  assert.ok(statuses.some(value => value.includes('略过')));
  first.resolve('first'); await flush(); assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(value => value.packet.sequence), [1, 2]); assert.equal(segments.state.queued, false);
  second.resolve('second'); await flush(); assert.deepEqual(accepted, ['first', 'second']);
  assert.equal(segments.state.inFlight, false);
});

test('a cancelled old request cannot publish or overlap a replacement session even when it ignores abort', async () => {
  const old = deferred<string>(), replacement = deferred<string>();
  const requests: { packet: AmbientEncodedSegment; signal: AbortSignal }[] = [], accepted: string[] = [];
  const segments = new AmbientAudioSegments({ limits: { maxSeconds: 1 }, now: () => 0,
    onSegment: (packet, signal) => { requests.push({ packet, signal }); return requests.length === 1 ? old.promise : replacement.promise; },
    onAccepted: value => accepted.push(value) });
  segments.start('old-session', 'music', 0); segments.push(pcm(1), 16000, 1000); await flush();
  segments.start('new-session', 'movie', 5000); assert.equal(requests[0].signal.aborted, true);
  segments.push(pcm(1), 16000, 6000); await flush(); assert.equal(requests.length, 1);
  old.resolve('stale'); await flush(); assert.equal(requests.length, 2); assert.deepEqual(accepted, []);
  assert.equal(requests[1].packet.sessionKey, 'new-session'); assert.equal(requests[1].packet.sequence, 1);
  replacement.resolve('current'); await flush(); assert.deepEqual(accepted, ['current']);
});

test('TTS aborts partial/pending/queued audio and its tail is trimmed before transcription resumes', async () => {
  const old = deferred<string>();
  const requests: { packet: AmbientEncodedSegment; signal: AbortSignal }[] = [], accepted: string[] = [];
  const segments = new AmbientAudioSegments({ limits: { maxSeconds: 1 }, now: () => 4500,
    onSegment: (packet, signal) => { requests.push({ packet, signal }); return requests.length === 1 ? old.promise : Promise.resolve('after-tail'); },
    onAccepted: value => accepted.push(value) });
  segments.start('same-session', 'movie', 0); segments.push(pcm(1), 16000, 1000); await flush();
  segments.push(pcm(1), 16000, 2000); assert.equal(segments.state.queued, true);
  segments.push(pcm(0.2), 16000, 2200); assert.equal(segments.state.bufferedSamples, 3200);
  segments.setSpeaking(true, 2200); assert.equal(requests[0].signal.aborted, true); assert.equal(segments.state.queued, false);
  assert.equal(segments.state.bufferedSamples, 0);
  segments.push(pcm(0.5, -0.9), 16000, 2500); assert.equal(segments.state.bufferedSamples, 0);
  segments.setSpeaking(false, 3000);
  segments.push(pcm(0.4, -0.9), 16000, 3400); assert.equal(segments.state.bufferedSamples, 0);
  // Block includes pre-guard sound; retain only the 100ms after the 3500ms guard.
  segments.push(pcm(0.5, 0.2), 16000, 3600); assert.equal(segments.state.bufferedSamples, 1600);
  segments.push(pcm(0.9, 0.3), 16000, 4500); assert.equal(segments.state.queued, true);
  old.resolve('self-or-stale'); await flush();
  assert.deepEqual(accepted, ['after-tail']); assert.equal(requests.length, 2);
  const after = requests[1].packet, audio = packetPcm(after);
  assert.equal(after.startOffsetMs, 3500); assert.equal(after.endOffsetMs, 4500); assert.equal(audio.length, 16000);
  assert.equal(audio[0], 6553); assert.equal(audio[1599], 6553); assert.equal(audio[1600], 9830);
  assert.ok(audio.every(value => value >= 0));
});

test('invalid/backward PCM and capture discontinuity discard partial audio instead of fabricating timing', async () => {
  const packets: AmbientEncodedSegment[] = [];
  const segments = new AmbientAudioSegments({ limits: { maxSeconds: 1 }, now: () => 0,
    onSegment: async packet => { packets.push(packet); return true; } });
  segments.start('valid', 'movie', 0);
  segments.push(pcm(0.5), 16000, 500); assert.equal(segments.state.bufferedSamples, 8000);
  segments.push(pcm(0.1), 16000, 400); assert.equal(segments.state.bufferedSamples, 0);
  segments.push(pcm(0.5), 16000, 1000);
  segments.push(pcm(0.5), 16000, 3000); assert.equal(segments.state.bufferedSamples, 8000);
  segments.push(pcm(0.5), 16000, 3500); await flush(); assert.equal(packets.length, 1);
  assert.equal(packets[0].startOffsetMs, 2500); assert.equal(packets[0].endOffsetMs, 3500);
  segments.push(pcm(0.1), NaN, 3600); segments.push(pcm(0.1), 16000, NaN);
  segments.push(pcm(2.1), 16000, 5700); await flush(); assert.equal(packets.length, 1);
});

test('stop/dispose suppress late failures and never restart a capture or transcription', async () => {
  const waiting = deferred<boolean>(), errors: string[] = [], accepted: boolean[] = [];
  let calls = 0;
  const segments = new AmbientAudioSegments({ limits: { maxSeconds: 1 }, now: () => 0,
    onSegment: () => { calls++; return waiting.promise; }, onError: value => errors.push(value), onAccepted: value => accepted.push(value) });
  segments.start('stop', 'music', 0); segments.push(pcm(1), 16000, 1000); await flush();
  segments.stop(); waiting.reject(new Error('late failure with private network detail')); await flush();
  assert.equal(calls, 1); assert.deepEqual(errors, []); assert.deepEqual(accepted, []);
  segments.dispose(); segments.start('ignored', 'music', 1000); segments.push(pcm(1), 16000, 2000); await flush();
  assert.equal(calls, 1); assert.equal(segments.active, false);
});

test('invalid segment budgets fail early rather than allocating an unbounded buffer', () => {
  const onSegment = async () => true;
  for (const value of [{ maxSeconds: Infinity }, { maxSeconds: 60 }, { minSoundSeconds: 0 }, { rmsThreshold: NaN }, { ttsTailMs: -1 }])
    assert.throws(() => new AmbientAudioSegments({ onSegment, limits: value }), /分段参数/);
});

test('opening the purpose panel and choosing movie/music never implies ASR consent', async context => {
  class Element {
    textContent = ''; className = ''; hidden = false; disabled = false; type = '';
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
        try { return child.find(text); } catch { /* Search the next child. */ }
      }
      throw new Error(`Missing element: ${text}`);
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  context.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); });
  const container = new Element('div'), starting = deferred<void>(), modes: string[] = [], expanded: boolean[] = [];
  let stops = 0, dances = 0;
  const controls = new AmbientAudioControls(container as unknown as HTMLElement, {
    onStart: mode => { modes.push(mode); return starting.promise; },
    onStop: async () => { stops++; }, onDanceOnly: async () => { dances++; }, onExpanded: value => expanded.push(value),
  });
  controls.toggleExpanded(); container.find('陪看电影').click(); await flush();
  assert.deepEqual(modes, []); assert.equal(stops, 0); assert.equal(dances, 0);
  container.find('开始理解').click(); await flush(); assert.deepEqual(modes, []);
  controls.setState({ available: true, destination: '当前本机转写连接', unavailableReason: '' });
  container.find('开始理解').click(); await flush(); assert.deepEqual(modes, ['movie']);
  container.find('停止理解').click(); await flush(); assert.equal(stops, 1);
  starting.resolve(); await flush();
  container.find('听音乐').click(); container.find('仅本机律动').click(); await flush();
  assert.equal(dances, 1); assert.deepEqual(modes, ['movie']);
  controls.dispose(); assert.deepEqual(expanded, [true, false]); assert.equal(container.children[0].removed, true);
  assert.equal(stops, 1); // The owner, not disposing a view, owns capture teardown.
});
