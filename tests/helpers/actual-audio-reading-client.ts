/**
 * The actual AudioReadingClient class (src/voice/AudioReadingClient.ts, read and transpiled as tests/audio-dance-client.test.ts does),
 * with the actual capture host (electron/senses/audio-capture-host.ts) on one test clock. Only the physical capture, the IPC and
 * requestAnimationFrame are synthetic: `send` is the companion window's sample going to the host and, accepted, coming back as a
 * frame (a busy host drops it, as the one-in-flight sender does); `frame` runs the display callback.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as uiCopy from '../../src/foundation/ui-language';
import { AudioDanceFusion } from '../../src/senses/audio-dance-fusion';
import { parseAudioDanceFrame } from '../../shared/senses/audio-dance';
import { audioReadingSources, audioReadingPurposes } from '../../shared/voice/audio-reading-toggles';
import { AmbientAudioSegments } from '../../src/senses/ambient-audio-segments';
import { AudioCaptureHost } from '../../electron/senses/audio-capture-host';
import type { MusicEnergySample } from '../../src/stage/music-dance';

const source = readFileSync(new URL('../../src/voice/AudioReadingClient.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AudioReadingClient.ts', source, ts.ScriptTarget.Latest, true);
const klass = ast.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'AudioReadingClient')!;
const create = new Function('uiText', 'uiHtml', 'uiMarkup', 'uiTemplate', 'listenSwitchOn', 'deps', `const {AudioDanceFusion,parseAudioDanceFrame,audioReadingSources,audioReadingPurposes,AmbientAudioSegments,MicrophoneInput,performance,requestAnimationFrame,cancelAnimationFrame}=deps;
${ts.transpile(klass.getText(ast).replace(/^export /, ''), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })};return AudioReadingClient;`);

// no-pet-ok: the capture host's existing owner value for the companion window (an IPC name this test cannot rename)
const OWNER = 'pet' as const;

export interface ReceiverCallbacks { onMusicEnabled(on: boolean): void; onMusicSample(sample: MusicEnergySample): void }

/** The companion window's receiver and the host, `now` in ms (performance.now of the window and the host's clock alike). */
export async function actualReceiver(callbacks: ReceiverCallbacks, now: () => number) {
  const { listenSwitchOn } = await import('../../shared/senses/listen-together');
  let serial = 0, captureEvent: (state: unknown) => void = () => {}, frameEvent: (frame: unknown) => void = () => {};
  const frames = new Map<number, (at: number) => void>();
  class CapturePort { async apply(_descriptor: unknown) {} async dispose() {} }
  const Client = create(uiCopy.uiText, uiCopy.uiHtml, uiCopy.uiMarkup, uiCopy.uiTemplate, listenSwitchOn, { AudioDanceFusion, parseAudioDanceFrame, audioReadingSources,
    audioReadingPurposes, AmbientAudioSegments, MicrophoneInput: CapturePort, performance: { now },
    requestAnimationFrame: (callback: (at: number) => void) => { frames.set(++serial, callback); return serial; }, cancelAnimationFrame: (id: number) => frames.delete(id) });
  const host = new AudioCaptureHost({ available: () => true, lost() {}, publish: state => captureEvent(state), now });
  const api = {
    onAudioReadingView: () => () => {}, onAmbientAudioState: () => () => {},
    onAudioCaptureState: (cb: (state: unknown) => void) => { captureEvent = cb; return () => {}; },
    onAudioDanceSample: (cb: (frame: unknown) => void) => { frameEvent = cb; return () => {}; },
    ackAudioCapture: async (value: unknown) => host.ack(OWNER, value),
    setAudioDanceSourceIntent: async () => null, setAudioReadingIntent: async () => null, setAudioDanceIntent: async () => null,
    submitAudioReadingPcm: async () => ({ accepted: false }),
  };
  const system = { active: true, async setEnabled() {}, async releaseOwned() {}, setPcmListener() {} };
  const client = new Client(null, { api, owner: OWNER, system, media: {}, onError: () => {}, ...callbacks });
  captureEvent(host.getState());
  /** 「和她一起听」 on: the host's dance and the system capture's readiness (as the client's own driveSystem acknowledges it). */
  const listen = async () => { host.setDance(true, 'system-audio'); for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return {
    client, host,
    /** One sample of the computer's sound: to the host and, accepted, back to the window. False when the host refused it. */
    send(sample: MusicEnergySample): boolean {
      const slot = host.getState().slots['system-audio'];
      if (!slot) return false;
      const frame = host.acceptDanceSample(OWNER, { id: slot.id, source: 'system-audio', revision: slot.revision, sample: { ...sample } });
      if (!frame) return false;
      frameEvent(frame); return true;
    },
    /** One display callback (the client's refreshDance on requestAnimationFrame). */
    frame(): void { const waiting = [...frames.values()]; frames.clear(); waiting.forEach(fn => fn(now())); },
    listen,
  };
}
