// How much the call's semantic look slows her first words.
// One call-like conversation through the real voice host as electron/wiring/senses-voice-input-wiring.ts wires it: the real voice host, her
// companion service, the media switches, the look decision, the I-040 router and the voice adapter, and (for the 'carry' group) the real
// reaction host. Injected: the recognizer (the words come in as text), the screen capture (a synthetic frame), her Claude (`claude`) and the
// router's haiku (`ask`). No microphone, camera, screen, window or app profile; a synthetic persona. Three groups, one conversation each:
//   off    semanticLook off (the phrase rules only; the reaction judge answers as in the app, no router)
//   carry  semanticLook on, the reaction judge carries the question (visible case: no call of its own)
//   own    semanticLook on, the reaction judge is quiet (she is hidden: the Unbound case), so the router asks its own haiku after her first char
// The reaction judge in 'off' and 'carry' is a fake that answers after `judgeDelayMs` (it is the same in both, so the groups differ only by
// the semantic look); the 'own' group's judgment and every look (the facts) are the caller's `ask`.
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { DEFAULT_SETTINGS } from '../../shared/foundation/defaults';
import { callFrameNote } from '../../shared/brain/call-frame-note';
import { FakeReactionJudge } from '../../shared/behaviors/reactions/fake';
import type { Dispositions } from '../../shared/behaviors/reactions/dispositions';
import type { ReactionPerformer } from '../../shared/behaviors/reactions/interface';
import type { SenseOn } from '../../shared/senses/sense-router';
import { CompanionService } from '../../electron/brain/companion';
import { VoiceChatHost, type VoiceChatHostPorts } from '../../electron/voice/voice-chat-host';
import { LookTurns } from '../../electron/senses/look-turns';
import { LookAttachments } from '../../electron/senses/look-attachments';
import { CameraGlance } from '../../electron/senses/camera-glance';
import { MediaRuntime, type CameraPolicy } from '../../electron/senses/media-runtime';
import { voiceLegLook } from '../../electron/senses/voice-look';
import { SenseRouterHost, type SenseRouterPorts } from '../../electron/senses/sense-router/host';
import { voiceSegmentSenses } from '../../electron/senses/sense-router/voice';
import { ReactionHost, type ReactionHostOptions, type ReactionNowSource } from '../../electron/mood/reactions/host';
import { encodeWav } from '../../src/senses/MediaInput';

export type GroupName = 'off' | 'carry' | 'own';
export const GROUPS: readonly GroupName[] = ['off', 'carry', 'own'];

/** Synthetic lines. `look`: she would need to see the screen to answer; both phrasings are ones the phrase rules miss (the 21:41 bug). */
export interface SegmentLine { text: string; look: boolean }
export const MEASURE_LINES: readonly SegmentLine[] = Object.freeze([
  { text: '喂，听得到吗', look: false }, // the warm-up: dropped from the statistics
  { text: '我刚到家', look: false },
  { text: '我桌面上那个东西你瞅得见不', look: true },
  { text: '今天好累啊', look: false },
  { text: '我在吃晚饭', look: false },
  { text: '你觉得这个配色怎么样', look: true },
  { text: '明天还要早起', look: false },
]);

/** A public original character, not any real card. */
export const MEASURE_PERSONA = '你是小桃，一个住在用户电脑里的原创桌宠角色。你说话温柔、有点害羞，喜欢用短句，偶尔撒娇。你关心用户的作息和心情，记得你们聊过的小事。'
  + '你不会假装能做做不到的事；不知道的就照实说。和用户打电话的时候，你说话更口语，一次只说一两句。';

type ClaudePort = VoiceChatHostPorts['claude'];
export interface GroupDeps {
  /** Her Claude for this group's conversation (the caller makes a fresh one per group, warm for a call). */
  claude: ClaudePort;
  /** The router's haiku (its own judgment and its look at a frame); the caller counts and caps them. */
  ask(prompt: string, system: string, images: readonly string[], signal: AbortSignal): Promise<string>;
  /** A synthetic screen frame as a data URL. */
  frame(n: number): string;
  lines?: readonly SegmentLine[];
  /** Pause after each reply, as the user listens and speaks (ms). */
  gapMs: number;
  /** How long the fake reaction judge takes to answer (ms; about a real haiku). */
  judgeDelayMs: number;
  /** Stop before the next segment (a quota error, a cap): read between segments. */
  halted?(): boolean;
  model?: string;
  log?(line: string): void;
}

export interface AskEvent { kind: 'judge' | 'look'; segment: number; startMs: number; endMs: number; durationMs: number; ok: boolean; chars: number; inFlightAtStart: number }
export interface SegmentRow {
  group: GroupName; segment: number; text: string; look: boolean;
  /** From the end of the user's words (t0) to Claude being called, and to her first delta; and the Claude part alone. */
  dispatchMs: number | null; firstMs: number | null; firstFromDispatchMs: number | null;
  /** Haiku asks running when this segment's Claude call started. */
  haikuInFlightAtDispatch: number;
  /** The facts note this segment's words carried (chars; 0 none), read where the segment was written. */
  noteChars: number;
  reply: string; error?: string;
}
export interface GroupResult { group: GroupName; rows: SegmentRow[]; asks: AskEvent[]; factsLanded: Record<string, 'this' | 'next' | 'never'> }

const SIX: Dispositions = Object.freeze({ shy: 62, clingy: 45, lively: 55, soothable: 50, volatile: 40, restrained: 48 });
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const round = (value: number | null) => value === null ? null : Math.round(value * 10) / 10;

export async function runGroup(group: GroupName, deps: GroupDeps): Promise<GroupResult> {
  const lines = deps.lines ?? MEASURE_LINES;
  const log = deps.log ?? (() => {});
  const directory = await mkdtemp(path.join(os.tmpdir(), 'call-look-first-char-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = deps.model ?? ''; settings.persona = MEASURE_PERSONA;
  await service.context('fixture-character', settings.provider, MEASURE_PERSONA);
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  media.update({ voiceInput: true }, 'controls');
  media.update({ screenSharing: true }, 'controls');
  let generation = 0, shots = 0;
  const turns = new LookTurns(() => 0);
  const lookState = () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `c|${media.revision}`,
    screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true });
  const glanceKeeper = new CameraGlance({ frame: () => media.cameraAttachment(), poseOn: () => false, signal: () => null, opening: () => media.openings.camera });
  const look = new LookAttachments(turns, {
    noteActivity: () => { generation++; }, state: lookState, sharesCameraFrames: () => media.sharesCameraFrames(),
    revision: () => media.revision, generation: () => generation, opening: source => media.openings[source],
    captureScreen: async () => ({ source: 'screen', dataUrl: deps.frame(++shots + 500) }), captureCamera: async () => null,
    glance: () => glanceKeeper.take(), seenCamera: () => glanceKeeper.seen(), holdCamera: held => { media.holdCamera(held); }, textFirst: () => true,
  });

  // ---- measurement state
  const t = () => performance.now();
  let current = -1, t0 = 0, inFlight = 0;
  const t0s: number[] = []; // each segment's t0 (absolute), so a haiku that ends in a later segment is still told from its own segment's start
  const rows: SegmentRow[] = [], asks: AskEvent[] = [], noteSegments = new Map<number, number>();
  const segmentOf = new Map<string, number>(); // replyId -> segment
  const row = (n: number) => rows[n];

  const on = (): SenseOn => ({ camera: false, screen: media.state.screenSharing === true && !turns.refusedIn(lookState()), transcript: false });
  const ports: SenseRouterPorts = {
    enabled: () => true, on, identity: () => 'scope', conversation: () => 'conv-1',
    capture: async () => deps.frame(++shots), heard: () => null,
    ask: async (prompt, system, images, signal) => {
      const kind: AskEvent['kind'] = system.includes('感知判定员') ? 'judge' : 'look';
      const begun = t(), event: AskEvent = { kind, segment: current, startMs: begun - t0, endMs: 0, durationMs: 0, ok: false, chars: 0, inFlightAtStart: inFlight };
      asks.push(event); inFlight++;
      try { const text = await deps.ask(prompt, system, images, signal); event.ok = true; event.chars = text.length; return text; }
      finally { inFlight--; event.endMs = t() - t0s[event.segment]; event.durationMs = t() - begun; }
    },
    line: async () => JSON.stringify({ text: '嗯。' }), // never used in a call
    character: () => ({ id: 'fixture-character', persona: MEASURE_PERSONA, language: '' }), mood: () => '', free: () => true,
    publish: () => true, speechStyle: () => {}, archive: async () => {},
  };
  const router = new SenseRouterHost(ports);

  // The reaction judge, as the app has it: it takes the utterance first. 'off' and 'carry' have the fake judge answer; 'own' is quiet (hidden).
  const looksFor = (prompt: string) => lines.some(line => line.look && prompt.includes(line.text));
  const judge = new FakeReactionJudge(async prompt => { await wait(deps.judgeDelayMs); return JSON.stringify({ event: 'none', reactions: [], delta: {}, confidence: 0.9, senses: looksFor(prompt) ? ['screen'] : [] }); });
  const store = { enabled: true, calls: 0, chats: 0, today: () => store.calls, noteCall: () => ++store.calls, chatsToday: () => store.chats, noteChat: () => ++store.chats };
  const nowSource = (): ReactionNowSource => ({ characterId: 'fixture-character', dispositions: SIX, mood: 'calm', moodWords: '平静', fatigue: '', sleepy: false, values: null, persona: MEASURE_PERSONA });
  const performer: ReactionPerformer = { stage: false, gate: () => null, perform: () => ({ done: true }) };
  const reactions = new ReactionHost({ ask: judge.ask, store, now: nowSource, performers: { blush: performer, shy: performer, happy: performer, action: performer },
    quiet: () => (group === 'own' ? 'hidden' : null), lift: () => {}, random: () => 0.5, localDate: () => 'day', warm: () => true, senses: router.port,
    knobs: { warmParallel: true, startDelayMs: 0 } } as ReactionHostOptions);

  const realSenses = voiceSegmentSenses({ router: () => router, asking: id => reactions.asking(id), reactionFirstChar: id => reactions.firstChar(id), inCall: () => true,
    language: () => 'zh-CN', enabled: () => group !== 'off', ownJudge: () => true });
  const pending = new Set<string>(), asr: string[] = [];
  const claude: ClaudePort = { ...deps.claude, stream: async (task, signal, emit, control) => {
    const n = current, r = row(n);
    segmentOf.set(task.replyId ?? '', n);
    r.dispatchMs = t() - t0; r.haikuInFlightAtDispatch = inFlight;
    const sentAt = t();
    try {
      const outcome = await deps.claude.stream(task, signal, (type, text) => { if (type === 'delta' && r.firstMs === null && /\S/u.test(text)) { r.firstMs = t() - t0; r.firstFromDispatchMs = t() - sentAt; } emit(type, text); }, control);
      r.reply = outcome.output;
      return outcome;
    } catch (caught) { r.error = String((caught as Error)?.message ?? caught); throw caught; }
  } };
  const host = new VoiceChatHost({
    broadcast() {}, memoryChanged() {}, windowVisible: () => true, media: () => media.state, turnOffVoiceInput() {},
    speechScope: () => 'scope', settings: () => settings,
    companion: () => ({ beginVoiceGroup: (id: string, text: string, persona: string) => { reactions.userTurn(id, text); return service.beginVoiceGroup(id, text, persona); } }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude,
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', stopReading() {}, prepareSpeech() {},
    look: text => voiceLegLook({ request: (hint, opts) => look.request(hint, opts), admit: frames => look.admit(frames), note: frames => callFrameNote(frames, 'zh-CN') }, text),
    senses: { ...realSenses, note: input => { const text = realSenses.note(input); if (text) { const n = segmentOf.get(input.replyId) ?? current; noteSegments.set(n, text.length); } return text; } },
  });
  const binding = host.open(77, 'controls');
  let seq = 0;
  try {
    for (let i = 0; i < lines.length; i++) {
      if (deps.halted?.()) break;
      current = i;
      rows[i] = { group, segment: i + 1, text: lines[i].text, look: lines[i].look, dispatchMs: null, firstMs: null, firstFromDispatchMs: null, haikuInFlightAtDispatch: 0, noteChars: 0, reply: '' };
      asr.push(lines[i].text);
      t0 = t(); t0s[i] = t0;
      host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
      host.pipeline.finishSpeaking(77, binding.captureSessionId);
      for (let k = 0; k < 6000 && (pending.size || rows[i].dispatchMs === null); k++) await wait(5);
      await host.drain();
      log(JSON.stringify({ ...row(i), reply: undefined }));
      await wait(deps.gapMs); // the user listens and speaks; a haiku started during her reply may land now
    }
    await wait(Math.min(deps.gapMs, 1500));
  } finally { router.dispose(); reactions.dispose(); host.dispose(); await host.drain(); await service.flush(); await rm(directory, { recursive: true, force: true }); }

  const factsLanded: GroupResult['factsLanded'] = {};
  for (const r of rows) {
    r.noteChars = noteSegments.get(r.segment - 1) ?? 0;
    r.dispatchMs = round(r.dispatchMs); r.firstMs = round(r.firstMs); r.firstFromDispatchMs = round(r.firstFromDispatchMs);
  }
  for (const r of rows.filter(item => item.look)) {
    const here = noteSegments.has(r.segment - 1), next = noteSegments.has(r.segment);
    factsLanded[`segment ${r.segment}`] = here ? 'this' : next ? 'next' : 'never';
  }
  return { group, rows, asks: asks.map(a => ({ ...a, startMs: Math.round(a.startMs), endMs: Math.round(a.endMs), durationMs: Math.round(a.durationMs) })), factsLanded };
}

// ---------------------------------------------------------------- numbers

export interface Spread { n: number; median: number; p25: number; p75: number; min: number; max: number }
export function spread(values: readonly number[]): Spread | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => { const x = p * (sorted.length - 1), lo = Math.floor(x), hi = Math.ceil(x); return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo); };
  return { n: sorted.length, median: round(at(0.5))!, p25: round(at(0.25))!, p75: round(at(0.75))!, min: sorted[0], max: sorted[sorted.length - 1] };
}

/** Median of `b` minus median of `a`, with a seeded bootstrap 95% interval (so "no measurable slow-down" has a number behind it). */
export function medianDifference(a: readonly number[], b: readonly number[], resamples = 4000, seed = 12345): { diff: number; low: number; high: number } | null {
  if (!a.length || !b.length) return null;
  let state = seed >>> 0;
  const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
  const median = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pick = (xs: readonly number[]) => xs.map(() => xs[Math.floor(random() * xs.length)]);
  const diffs: number[] = [];
  for (let i = 0; i < resamples; i++) diffs.push(median(pick(b)) - median(pick(a)));
  diffs.sort((p, q) => p - q);
  return { diff: round(median([...b]) - median([...a]))!, low: round(diffs[Math.floor(resamples * 0.025)])!, high: round(diffs[Math.floor(resamples * 0.975)])! };
}

export interface Summary {
  firstMs: Record<string, Spread | null>; dispatchMs: Record<string, Spread | null>; firstFromDispatchMs: Record<string, Spread | null>;
  differences: Record<string, { diff: number; low: number; high: number } | null>;
  judgeMs: Spread | null; lookMs: Spread | null; haikuOverlappingDispatch: Record<string, number>;
}

/** Each group's first segment is a warm-up and is left out. */
export function summarise(results: readonly GroupResult[]): Summary {
  const measured = (group: GroupName, pick: (row: SegmentRow) => number | null) => (results.find(r => r.group === group)?.rows ?? []).filter(row => row.segment > 1)
    .map(pick).filter((v): v is number => v !== null);
  const by = (pick: (row: SegmentRow) => number | null) => Object.fromEntries(GROUPS.map(group => [group, spread(measured(group, pick))]));
  const first = (row: SegmentRow) => row.firstMs;
  const differences: Summary['differences'] = {
    'carry - off': medianDifference(measured('off', first), measured('carry', first)),
    'own - off': medianDifference(measured('off', first), measured('own', first)),
    'own - carry': medianDifference(measured('carry', first), measured('own', first)),
  };
  const asks = (kind: AskEvent['kind']) => results.flatMap(r => r.asks).filter(a => a.kind === kind && a.ok).map(a => a.durationMs);
  return { firstMs: by(first), dispatchMs: by(row => row.dispatchMs), firstFromDispatchMs: by(row => row.firstFromDispatchMs), differences,
    judgeMs: spread(asks('judge')), lookMs: spread(asks('look')),
    haikuOverlappingDispatch: Object.fromEntries(GROUPS.map(group => [group, (results.find(r => r.group === group)?.rows ?? []).filter(row => row.segment > 1 && row.haikuInFlightAtDispatch > 0).length])) };
}
