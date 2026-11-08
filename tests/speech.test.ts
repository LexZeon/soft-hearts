import test from "node:test";
import assert from "node:assert/strict";
import { CANCEL_SETTLE_MS, SpeechOutput } from "../src/ui/speech";
import { DEFAULT_SETTINGS } from "../shared/defaults";

class Utterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = ""; rate = 1; volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}
function fixture() {
  const previous = new Map(["speechSynthesis", "SpeechSynthesisUtterance"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const queued: Utterance[] = [], speaking: boolean[] = [];
  let cancelCount = 0, failSpeak = false, cancelEvent = false, now = 0;
  const due: { at: number; callback: () => void; id: number }[] = [];
  let ids = 0;
  const timers = { set: (callback: () => void, ms: number) => { due.push({ at: now + ms, callback, id: ++ids }); return ids; },
    clear: (handle: unknown) => { const index = due.findIndex(item => item.id === handle); if (index >= 0) due.splice(index, 1); } };
  const voices = [{ voiceURI: "fixture-en", lang: "en-US" }, { voiceURI: "fixture-zh", lang: "zh-CN" }] as SpeechSynthesisVoice[];
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", { configurable: true, writable: true, value: Utterance });
  Object.defineProperty(globalThis, "speechSynthesis", { configurable: true, writable: true, value: {
    getVoices: () => voices,
    speak(utterance: Utterance) { queued.push(utterance); if (failSpeak) throw new Error("fixture synchronous speech failure"); },
    cancel() { cancelCount++; if (cancelEvent) queued.at(-1)?.onend?.(); },
  } });
  const output = new SpeechOutput(value => speaking.push(value), { timers, now: () => now });
  const config = { ...DEFAULT_SETTINGS.voice, enabled: true, voiceURI: "fixture-zh", rate: 1.3, volume: 0.4 };
  return { output, config, queued, speaking, voices,
    get cancelCount() { return cancelCount; },
    throwOnSpeak() { failSpeak = true; },
    emitEndOnCancel() { cancelEvent = true; },
    /** Run timers due within `ms` (R02: a replacement is spoken shortly after cancel()). */
    advance(ms: number) { now += ms; for (const item of due.filter(entry => entry.at <= now)) { due.splice(due.indexOf(item), 1); item.callback(); } },
    restore() { output.stop(); for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } },
  };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test("system speech completion waits through queueing and playback, preserving voice configuration", async () => {
  const f = fixture();
  try {
    let completed = false;
    const finished = f.output.speak("播放结束前保留气泡", f.config).then(() => { completed = true; });
    await flush(); assert.equal(completed, false); assert.deepEqual(f.speaking, [false]);
    const utterance = f.queued[0];
    assert.equal(utterance.voice, f.voices[1]); assert.equal(utterance.lang, "zh-CN");
    assert.equal(utterance.rate, 1.3); assert.equal(utterance.volume, 0.4);
    utterance.onstart?.(); await flush(); assert.equal(completed, false);
    utterance.onend?.(); await finished;
    assert.equal(completed, true); assert.deepEqual(f.speaking, [false, true, false]);
  } finally { f.restore(); }
});

test("disabled and empty speech settle immediately without queueing an utterance", async () => {
  const f = fixture();
  try {
    await f.output.speak("关闭朗读", { ...f.config, enabled: false });
    await f.output.speak(" \n\t ", f.config);
    assert.equal(f.queued.length, 0); assert.deepEqual(f.speaking, [false, false]);
  } finally { f.restore(); }
});

test("replacement settles the old completion while late old callbacks cannot affect new playback", async () => {
  const f = fixture();
  try {
    let oldDone = false, newDone = false;
    const oldFinished = f.output.speak("旧回答", f.config).then(() => { oldDone = true; });
    const old = f.queued[0]; old.onstart?.();
    const nextFinished = f.output.speak("新回答", f.config).then(() => { newDone = true; });
    await oldFinished; assert.equal(oldDone, true); assert.equal(newDone, false);
    // R02: interrupting cancels the old utterance, and the new one is spoken after a short settle.
    assert.equal(f.cancelCount, 1); assert.equal(f.queued.length, 1);
    f.advance(CANCEL_SETTLE_MS);
    const next = f.queued[1]; next.onstart?.();
    const before = [...f.speaking];
    old.onstart?.(); old.onend?.(); old.onerror?.(); await flush();
    assert.equal(newDone, false); assert.deepEqual(f.speaking, before);
    const nextRejected = assert.rejects(nextFinished, /系统语音/);
    next.onerror?.(); await nextRejected; assert.equal(newDone, false);
    assert.deepEqual(f.speaking, [...before, false]);
  } finally { f.restore(); }
});

test("stop settles queued speech even if cancellation dispatches an immediate old end event", async () => {
  const f = fixture();
  try {
    f.emitEndOnCancel();
    let completed = false;
    const finished = f.output.speak("尚未开始播放", f.config).then(() => { completed = true; });
    await flush(); assert.equal(completed, false);
    f.output.stop(); await finished;
    // R02: speak() no longer cancels when nothing is playing; stop() cancels the owned utterance once.
    assert.equal(completed, true); assert.equal(f.cancelCount, 1);
    assert.deepEqual(f.speaking, [false, false]);
    const before = [...f.speaking]; f.queued[0].onerror?.(); assert.deepEqual(f.speaking, before);
  } finally { f.restore(); }
});

test("synchronous speech engine failure rejects without leaving an active utterance", async () => {
  const f = fixture();
  try {
    f.throwOnSpeak();
    const finished = f.output.speak("无法开始播放", f.config);
    assert.ok(finished instanceof Promise); await assert.rejects(finished, /系统语音/);
    assert.deepEqual(f.speaking, [false, false]);
    const before = [...f.speaking];
    f.queued[0].onstart?.(); f.queued[0].onend?.(); assert.deepEqual(f.speaking, before);
  } finally { f.restore(); }
});
