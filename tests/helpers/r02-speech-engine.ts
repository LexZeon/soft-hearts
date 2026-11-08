import type { TestContext } from 'node:test';
import { flush } from './r02-audio-world';

/** R02 test fake of the Web Speech engine with a manual millisecond clock and timers. */
export class Utterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = ''; rate = 1; volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event?: { error: string }) => void) | null = null;
  onboundary: (() => void) | null = null;
  constructor(readonly text: string) {}
}

export function engine(t: TestContext) {
  let now = 0, ids = 0;
  const due: { at: number; id: number; callback: () => void }[] = [];
  const timers = {
    set: (callback: () => void, ms: number) => { due.push({ at: now + ms, id: ++ids, callback }); return ids; },
    clear: (handle: unknown) => { const index = due.findIndex(item => item.id === handle); if (index >= 0) due.splice(index, 1); },
  };
  const log: string[] = [];
  const queued: Utterance[] = [];
  const synth = {
    speaking: false, pending: false,
    getVoices: () => [{ voiceURI: 'zh', lang: 'zh-CN' }] as SpeechSynthesisVoice[],
    speak(utterance: Utterance) { queued.push(utterance); log.push(`speak:${utterance.text}@${now}`); },
    cancel() { log.push(`cancel@${now}`); synth.speaking = false; },
  };
  const saved = ['speechSynthesis', 'SpeechSynthesisUtterance'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: Utterance });
  Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, writable: true, value: synth });
  t.after(() => { for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  return {
    synth, queued, log, timers, now: () => now,
    async advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now++;
        for (;;) {
          due.sort((a, b) => a.at - b.at);
          const next = due[0];
          if (!next || next.at > now) break;
          due.shift(); next.callback(); await flush();
        }
      }
      await flush();
    },
    start(utterance: Utterance) { synth.speaking = true; utterance.onstart?.(); },
    end(utterance: Utterance) { synth.speaking = false; utterance.onend?.(); },
  };
}
