// The voice call harness of the I-161 semantic look tests (tests/i161-call-semantic-look.test.ts, tests/i161-call-screen-look.test.ts): the real voice host,
// companion service, media switches, look decision and tickets, reaction host and I-040 router, wired as senses-voice-input-wiring wires them; fakes for
// haiku, the captures, the recognizer and Claude. No window, screen, camera, microphone or network.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../shared/foundation/defaults';
import { senseCarryNote } from '../../shared/senses/sense-carry';
import type { SenseOn } from '../../shared/senses/sense-router';
import { callFrameNote } from '../../shared/brain/call-frame-note';
import { FakeReactionJudge } from '../../shared/behaviors/reactions/fake';
import type { Dispositions } from '../../shared/behaviors/reactions/dispositions';
import type { ReactionPerformer } from '../../shared/behaviors/reactions/interface';
import { CompanionService } from '../../electron/brain/companion';
import { VoiceChatHost } from '../../electron/voice/voice-chat-host';
import { LookTurns } from '../../electron/senses/look-turns';
import { LookAttachments } from '../../electron/senses/look-attachments';
import { CameraGlance } from '../../electron/senses/camera-glance';
import { MediaRuntime, type CameraPolicy } from '../../electron/senses/media-runtime';
import { voiceLegLook } from '../../electron/senses/voice-look';
import { SenseRouterHost, type SenseRouterPorts } from '../../electron/senses/sense-router/host';
import { voiceSegmentSenses } from '../../electron/senses/sense-router/voice';
import { ReactionHost, type ReactionHostOptions, type ReactionNowSource } from '../../electron/mood/reactions/host';
import { encodeWav } from '../../src/senses/MediaInput';
import type { CallLookFields } from '../../shared/voice/call-look-journal';
export const SIX: Dispositions = Object.freeze({ shy: 62, clingy: 45, lively: 55, soothable: 50, volatile: 40, restrained: 48 });
export const SENSE_FRAME = (sense: string, n: number) => `data:image/jpeg;base64,/9j/sense-${sense}${n}AA==`;
export const SCREEN_FACTS = '屏幕上是一个表格软件，标题写着"十一月预算"。';
export const CAMERA_FACTS = '他坐在桌前，戴着耳机，在笑。';
export const LINE = '诶，看到啦，你在弄预算呀？';
export const wait = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
export const answerWith = (senses: string[]) => JSON.stringify({ event: 'none', reactions: [], delta: {}, confidence: 0.9, senses });

export interface Sent { text: string; images: string[]; persona: string }

/**
 * The voice host with the real reaction host and router on it. `judge`: the reaction judge's answer (senses named), or a promise the test
 * holds. `call`: the capture is a call (else plain voice input). `quiet`: the reaction call is not made (e.g. she is hidden).
 */
export async function harness(options: { script?: string[][]; senses?: string[]; hold?: boolean; call?: boolean; quiet?: boolean; ownJudge?: boolean; language?: 'zh-CN' | 'en' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i161-semantic-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku';
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  media.update({ voiceInput: true }, 'controls');
  let generation = 0, phraseScreenShots = 0;
  const turns = new LookTurns(() => 0);
  const lookState = () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `c|${media.revision}`,
    screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true });
  const glanceKeeper = new CameraGlance({ frame: () => media.cameraAttachment(), poseOn: () => false, signal: () => null, opening: () => media.openings.camera });
  const look = new LookAttachments(turns, {
    noteActivity: () => { generation++; }, state: lookState, sharesCameraFrames: () => media.sharesCameraFrames(),
    revision: () => media.revision, generation: () => generation, opening: source => media.openings[source],
    captureScreen: async () => { phraseScreenShots++; return { source: 'screen', dataUrl: `data:image/jpeg;base64,/9j/phrase${phraseScreenShots}AA==` }; },
    captureCamera: async () => null, glance: () => glanceKeeper.take(), seenCamera: () => glanceKeeper.seen(), holdCamera: held => { media.holdCamera(held); },
    textFirst: () => true,
  });
  // The router, with the app's `on` (electron/wiring/initiative-look-wiring.ts): only senses the user has on, minus a "别看".
  const senseCaptures: string[] = [], looks: { images: readonly string[]; prompt: string }[] = [], lines: string[] = [], published: string[] = [];
  let ownJudgeAsks = 0;
  const on = (): SenseOn => ({ camera: media.sharesCameraFrames() && media.state.cameraHeld !== true, screen: media.state.screenSharing === true && !turns.refusedIn(lookState()), transcript: false });
  const ports: SenseRouterPorts = {
    enabled: () => true, on, identity: () => 'scope', conversation: () => 'conv-1',
    capture: async sense => { senseCaptures.push(sense); return SENSE_FRAME(sense, senseCaptures.length); },
    heard: () => null,
    ask: async (prompt, system, images) => {
      if (system.includes('感知判定员')) return JSON.stringify({ senses: options.script ? options.script[ownJudgeAsks++] ?? [] : ownJudgeAsks++ === 0 ? options.senses ?? ['screen'] : [] });
      looks.push({ images, prompt });
      return images[0]?.includes('screen') ? SCREEN_FACTS : CAMERA_FACTS;
    },
    line: async prompt => { lines.push(prompt); return JSON.stringify({ text: LINE }); },
    character: () => ({ id: 'fixture-character', persona: '温和', language: '' }), mood: () => '', free: () => true,
    publish: message => { published.push(message.text); return true; }, speechStyle: () => {}, archive: async () => {},
  };
  const router = new SenseRouterHost(ports);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // haiku names `senses` for the first utterance only; later utterances need nothing (so what a later segment carries is the first look's).
  let judged = 0;
  const judge = new FakeReactionJudge(async () => { if (options.hold) await held; return answerWith(options.script ? options.script[judged++] ?? [] : judged++ === 0 ? options.senses ?? ['screen'] : []); });
  const store = { enabled: true, calls: 0, chats: 0, today: () => store.calls, noteCall: () => ++store.calls, chatsToday: () => store.chats, noteChat: () => ++store.chats };
  const now = (): ReactionNowSource => ({ characterId: 'fixture-character', dispositions: SIX, mood: 'calm', moodWords: '平静', fatigue: '', sleepy: false, values: null, persona: '温和' });
  const performer: ReactionPerformer = { stage: false, gate: () => null, perform: () => ({ done: true }) };
  const reactions = new ReactionHost({ ask: judge.ask, store, now, performers: { blush: performer, shy: performer, happy: performer, action: performer },
    quiet: () => (options.quiet ? 'hidden' : null), lift: () => {}, random: () => 0.5, localDate: () => 'day', warm: () => true, senses: router.port,
    knobs: { warmParallel: true, startDelayMs: 0 } } as ReactionHostOptions);
  const sent: Sent[] = [], journal: CallLookFields[] = [];
  let beforeWrite: (() => void | Promise<void>) | null = null;
  const pending = new Set<string>(), asr: string[] = [];
  const host = new VoiceChatHost({
    broadcast() {}, memoryChanged() {}, windowVisible: () => true, media: () => media.state, turnOffVoiceInput() {},
    speechScope: () => 'scope', settings: () => settings,
    // As the wiring: the reaction judge takes the spoken words first.
    companion: () => ({ beginVoiceGroup: (id: string, text: string, persona: string) => { reactions.userTurn(id, text); return service.beginVoiceGroup(id, text, persona); } }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: { stream: async (task, _signal, emit) => {
      if (beforeWrite) { const run = beforeWrite; beforeWrite = null; await run(); }
      sent.push({ text: task.session!.messages.at(-1)!.content, images: [...(task.imageDataUrls ?? [])], persona: task.session!.persona });
      emit('delta', '嗯嗯。'); return { superseded: false, output: '嗯嗯。' };
    } },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', stopReading() {}, prepareSpeech() {},
    look: text => voiceLegLook({ request: (hint, opts) => look.request(hint, opts), admit: frames => look.admit(frames), note: frames => callFrameNote(frames, options.language) }, text),
    senses: voiceSegmentSenses({ router: () => router, asking: id => reactions.asking(id), reactionFirstChar: id => reactions.firstChar(id),
      inCall: () => options.call !== false, journal: fields => { journal.push(fields); }, language: () => options.language ?? 'zh-CN', ...(options.ownJudge !== undefined ? { ownJudge: () => options.ownJudge! } : {}) }),
  });
  let binding = host.open(77, 'controls'), seq = 0;
  const say = async (text: string) => {
    asr.push(text);
    host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
    host.pipeline.finishSpeaking(77, binding.captureSessionId);
    const before = sent.length;
    for (let i = 0; i < 400 && sent.length === before; i++) await wait();
    for (let i = 0; i < 400 && pending.size; i++) await wait();
    await host.drain();
  };
  const until = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await wait(); };
  const reopen = () => { binding = host.open(77, 'controls'); seq = 0; };
  const dispose = async () => { router.dispose(); reactions.dispose(); host.dispose(); await host.drain(); await service.flush(); await rm(directory, { recursive: true, force: true }); };
  return { scope: () => binding.captureSessionId, host, media, router, reactions, judge, sent, say, until, reopen, dispose, release, journal, senseCaptures, looks, lines, published,
    ownJudgeAsks: () => ownJudgeAsks, phraseScreenShots: () => phraseScreenShots, beforeWrite: (run: () => void | Promise<void>) => { beforeWrite = run; },
    keepSmall: (n: number) => media.publishCamera('controls', `data:image/jpeg;base64,/9j/small${n}AA==`) };
}
