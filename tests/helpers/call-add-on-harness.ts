/**
 * I-197 test world: a call in the controls window over the real voice host (VoiceChatHost, the session, the companion's archive and
 * mood) and the real persistent Claude chat driving the fake `claude` CLI (tests/helpers/fake-claude-stream.ts). The call's reading
 * plan is a fake that records what reached it; "her voice started" is the test calling `voiced(replyId)` (in the app: the reading
 * window's noteReplySpeechHeard 'start'). The add-on window (electron/voice/voice-call/add-on.ts) is the real one with a fake clock
 * and timers. Each line is said the way a call says it: its clip, then the endpoint (so each line is its own utterance until joined).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../../electron/brain/companion';
import { PersistentClaudeChat } from '../../electron/brain/claude-session';
import { VoiceChatHost } from '../../electron/voice/voice-chat-host';
import { CallAddOn, type AddOnJournalRow } from '../../electron/voice/voice-call/add-on';
import { encodeWav } from '../../src/senses/MediaInput';
import { DEFAULT_SETTINGS } from '../../shared/foundation/defaults';
import type { VoiceConversationEvent } from '../../shared/voice/voice-conversation';
import type { HeldKind, InterruptBy } from '../../shared/behaviors/interrupt/judge';
import { fakeClaudeStream } from './fake-claude-stream';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/**
 * Waits until `check` holds, with no deadline of its own (2026-11-24, docs/claude/2026-11-24-quit-hang.md): what it waits for is a
 * real fake-CLI process and the host's own chain, which answer when they answer; a busy computer only makes that later (a 5 s
 * deadline failed "waiting for her voice" at 7.2 s and timing 1 at 5.9 s under the full suite). Nothing in the world it watches runs
 * on a wall clock (the add-on and the chat process have fake timers), so it ends exactly when the state is there. A real hang is caught
 * by the test's own timeout (CALL_TEST); the label is printed once after 30 s so that timeout says what it was waiting for.
 */
export async function until(check: () => boolean | Promise<boolean>, label = 'condition'): Promise<void> {
  const since = Date.now();
  let told = false;
  while (!(await check())) {
    if (!told && Date.now() - since > 30_000) { told = true; console.error('[call-add-on-harness] still waiting for ' + label); }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
/** The tests' options: a hang guard only (nothing here measures time). */
export const CALL_TEST = { timeout: 120_000 } as const;
/**
 * Fake timers for the persistent chat's process (interrupt grace, turn and first-response limits, idle, prewarm): on a busy computer
 * the fake CLI may take longer than 3 s to answer an interrupt, and a real grace timer then replaced the warm process mid-test. They
 * never fire during a test. At teardown, `disposing()` before chat.dispose() and `graceOver()` after it (and while waiting for the
 * processes to exit): what dispose() set from then on runs, as if the grace had passed (a process still in a held turn is closed).
 */
export function chatProcessTimers() {
  const list: { callback: () => void; cleared: boolean }[] = [], fired = new Set<object>();
  let from = Infinity;
  return {
    timers: { set: (callback: () => void) => { const timer = { callback, cleared: false }; list.push(timer); return timer as unknown; },
      clear: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; } },
    disposing() { from = list.length; },
    graceOver() { for (const timer of list.slice(from)) if (!timer.cleared && !fired.has(timer)) { fired.add(timer); timer.callback(); } },
  };
}
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

type Fake = Awaited<ReturnType<typeof fakeClaudeStream>>;
export interface CallWorld {
  host: VoiceChatHost; claude: Fake; service: CompanionService; addOn: CallAddOn;
  events: VoiceConversationEvent[]; rewards: string[]; journal: AddOnJournalRow[]; held: { kind: HeldKind; overHer: boolean }[]; interrupts: InterruptBy[];
  /** What reached the call's reading plan, per reply; which replies were cancelled or completed there; reading stops. */
  read: Map<string, string>; cancelled: string[]; completed: string[]; stops: number;
  /** Fake add-on clock: pending timers, fired by `fire`. */
  timers: { ms: number; callback: () => void; cleared: boolean }[];
  fire(): void;
  advance(ms: number): void;
  blockGroups(gate: Promise<void> | null): void;
  /** Says one line in the call (clip + endpoint) and waits until it was heard as a row, or held (`expectHeld`). */
  say(text: string, options?: { seconds?: number; expectHeld?: boolean }): Promise<void>;
  voiced(replyId: string): void;
  /** The user starts talking (the window's verified speech-start; in the app: VoiceCallHost.heard). */
  speechStart(): void;
  /** A clip that comes back with no words (noise, a cough): the speech that started ends with nothing to add. */
  sayNoise(): Promise<void>;
  /** Her reading finished (her voice is quiet again). */
  quiet(): void;
  starts(): string[]; text(replyId: string): string; terminal(replyId: string): Extract<VoiceConversationEvent, { type: 'terminal' }> | undefined;
  rows(): Extract<VoiceConversationEvent, { type: 'row' }>[];
  records(): any[];
}

export async function callWorld(run: (w: CallWorld) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i197-call-'));
  const claude = await fakeClaudeStream();
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku'; settings.voice.enabled = true;
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const rewards: string[] = [], original = service.mood.event.bind(service.mood);
  service.mood.event = (...args) => { rewards.push(args[0].type); original(...args); };
  const chatTimers = chatProcessTimers();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script],
    provider: () => settings.provider, chattedBefore: () => false, interruptGraceMs: 3000, log: () => {}, timers: chatTimers.timers });
  const events: VoiceConversationEvent[] = [], journal: AddOnJournalRow[] = [], held: { kind: HeldKind; overHer: boolean }[] = [], interrupts: InterruptBy[] = [];
  const read = new Map<string, string>(), cancelled: string[] = [], completed: string[] = [], timers: CallWorld['timers'] = [];
  const media = { voiceInput: true, voiceOwner: 'controls' as const };
  const pending = new Map<string, AbortController>();
  let gate: Promise<void> | null = null, stops = 0, playing = false, holding: string | null = null;
  let clock = 1000;
  const addOn = new CallAddOn({ now: () => clock, inCall: owner => owner === 'controls', journal: row => { journal.push(row); },
    timers: { set: (callback, ms) => { const timer = { ms, callback, cleared: false }; timers.push(timer); return timer; }, clear: handle => { (handle as { cleared: boolean }).cleared = true; } } });
  const host = new VoiceChatHost({
    broadcast: event => { events.push(event); },
    memoryChanged() {},
    windowVisible: sender => sender === 77,
    media: () => media,
    turnOffVoiceInput: () => { media.voiceInput = false; },
    speechScope: () => 'fixture-scope',
    settings: () => settings,
    companion: () => ({ beginVoiceGroup: async (...args: Parameters<CompanionService['beginVoiceGroup']>) => { if (gate) await gate; return service.beginVoiceGroup(...args); } }),
    ambient: () => ({ acceptUserTurn: async () => {} }),
    reserveChat: (replyId, controller) => { if (pending.size) return false; pending.set(replyId, controller); return true; },
    releaseChat: replyId => { pending.delete(replyId); },
    userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: chat,
    languageProfile: () => null,
    chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => { const text = asr.shift(); assert.ok(text !== undefined); return text; },
    // The app's gate (electron/wiring/senses-voice-input-wiring.ts): outside the add-on window her voice is her reading, which counts as soon as
    // its text reached the plan (callStreamingSpeech.reading(), even before a sound) or once it sounds; inside it only her filler counts.
    gate: { herVoice: () => addOn.herVoice(() => playing || holding !== null), herText: () => '', continuous: () => true,
      held: (kind, overHer) => { held.push({ kind, overHer }); }, interrupted: (_owner, by) => { interrupts.push(by); } },
    stopReading() { stops++; playing = false; holding = null; },
    prepareSpeech() {},
    callSpeech: {
      begin: input => { read.set(input.replyId, ''); return true; },
      delta: (id, text) => { read.set(id, (read.get(id) ?? '') + text); holding = id; },
      complete: id => { completed.push(id); return true; },
      cancel: id => { cancelled.push(id); if (holding === id) holding = null; },
    },
    addOn,
  });
  const asr: string[] = [];
  const binding = host.open(77, 'controls');
  let captureSeq = 0;
  const rows = () => events.filter((event): event is Extract<VoiceConversationEvent, { type: 'row' }> => event.type === 'row');
  const w: CallWorld = {
    host, claude, service, addOn, events, rewards, journal, held, interrupts, read, cancelled, completed, timers,
    get stops() { return stops; },
    fire: () => { for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback(); },
    advance: ms => { clock += ms; },
    blockGroups: value => { gate = value; },
    async say(text, options = {}) {
      asr.push(text);
      const heldBefore = held.length;
      const wav = encodeWav(new Float32Array(Math.round(16_000 * (options.seconds ?? 1))).fill(0.2));
      const receipt = host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++captureSeq, wav });
      assert.equal(receipt.state, 'queued');
      assert.equal(host.pipeline.endpoint(77, binding.captureSessionId), true);
      // Each clip ends one way: held, or a row; wait for whichever comes, then say whether it was the expected one (a wrong outcome
      // fails at once instead of waiting for the other).
      const asRow = () => rows().some(row => row.text.split('\n').at(-1) === text), asHeld = () => held.length > heldBefore;
      await until(() => asHeld() || asRow(), 'the clip "' + text + '" heard');
      if (options.expectHeld) assert.ok(asHeld() && !asRow(), 'held: ' + text);
      else assert.ok(asRow(), 'a row: ' + text);
      await new Promise(resolve => setImmediate(resolve));
    },
    voiced: replyId => { playing = true; addOn.voiced(replyId); },
    speechStart: () => { addOn.speechStart(); },
    async sayNoise() {
      asr.push('');
      const unheard = () => events.filter(event => event.type === 'unheard').length, before = unheard();
      const wav = encodeWav(new Float32Array(16_000).fill(0.2));
      assert.equal(host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++captureSeq, wav }).state, 'queued');
      assert.equal(host.pipeline.endpoint(77, binding.captureSessionId), true);
      // The host says "heard nothing" for the empty clip (VoiceChatHost's 'unheard' event); what it does after that for the clip
      // (the add-on window's settled()) runs in the promise reactions right behind it, all done before the next macrotask.
      await until(() => unheard() > before, 'the empty clip heard as nothing');
      await new Promise(resolve => setImmediate(resolve));
    },
    quiet: () => { playing = false; holding = null; },
    starts: () => events.filter(event => event.type === 'start').map(event => (event as { replyId: string }).replyId),
    text: replyId => events.filter(event => event.type === 'delta' && event.replyId === replyId).map(event => (event as { text: string }).text).join(''),
    terminal: replyId => events.find((event): event is Extract<VoiceConversationEvent, { type: 'terminal' }> => event.type === 'terminal' && event.replyId === replyId),
    rows,
    records() {
      const scope = service.currentScope(), page = service.memory.list(scope);
      return page.records.map(record => service.memory.read(scope, record.id)!);
    },
  };
  try { await run(w); }
  finally {
    gate = null;
    chatTimers.disposing(); host.dispose(); chat.dispose(); chatTimers.graceOver();
    await host.drain(); await service.flush();
    const pids = (await claude.spawns()).map(spawn => spawn.pid);
    await until(() => { chatTimers.graceOver(); return pids.every(pid => !alive(pid)); }, 'fake Claude processes to exit');
    await claude.cleanup();
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}
