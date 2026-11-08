/**
 * X1 "等回复时也有表现", renderer and host side
 * (docs/claude/2026-11-02-waiting-expression.md):
 * - the waiting observer on the reply lifecycle (the same state as the B09
 *   dots): every way a wait ends clears it; a late or repeated reply never
 *   revives it;
 * - the presenter: the stage is told synchronously, the "嗯…" is decided a
 *   microtask later, read-aloud on and owner only, skipped when her voice is
 *   busy, never awaited;
 * - the cue: same cached cue path as the feeding cues, its own player, so the
 *   two never stop or evict each other; fixed host text, never chat text;
 * - timing: on the same fake Claude Code, with and without the thinking
 *   presentation, the first word reaches the bubble in the same synchronous
 *   step and at the same time.
 * X1_REPORT=1 prints the timing numbers.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { ChatMessage } from '../shared/contracts';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import { DEFAULT_TTS_CONFIG, type TtsConfig, type TtsStreamEvent } from '../shared/tts';
import { CUE_TEXT, FEED_CUE_INSTRUCTION, THINK_CUE_INSTRUCTION, THINK_CUE_KINDS } from '../shared/feed-cue';
import { FeedCueSynth } from '../electron/feed-cue';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/claude-session';
import { ReplyPresentationState } from '../src/ui/reply-presentation';
import { ReplyThinkingPresenter, THINK_CUE_DEADLINE_MS, type ReplyThinkingOptions } from '../src/ui/reply-thinking';
import { FeedCuePlayer } from '../src/ui/feed-cue-player';
import { SharedAudioOutput } from '../src/ui/audio-output';
import { CANCEL_SETTLE_MS } from '../src/ui/speech';
import { ReplyThinking } from '../src/stage/reply-thinking';
import { pausableEngine, pauseAudioWorld } from './helpers/feed-pause-audio';
import { fakeClaudeStream } from './helpers/fake-claude-stream';

const REPORT = !!process.env.X1_REPORT;

// ------------------------------------------------------------------ 1. the waiting observer

test('X1 waiting observer: it follows the B09 waiting state; every way a wait ends clears it; a late reply never revives it', () => {
  const seen: (string | null)[] = [];
  const state = new ReplyPresentationState(undefined, id => seen.push(id));
  assert.equal(state.begin('a'), true);
  assert.deepEqual(seen, ['a'], 'accepted: waiting at once');
  state.content('a', '   '); assert.deepEqual(seen, ['a'], 'whitespace is not the first word');
  state.content('other', '迟到'); assert.deepEqual(seen, ['a'], 'another reply\'s text does not end this wait');
  state.content('a', '嗯'); assert.deepEqual(seen, ['a', null], 'the first word ends it');
  state.close('a'); assert.deepEqual(seen, ['a', null], 'nothing more to clear');
  assert.equal(state.begin('a'), false, 'a closed reply cannot begin again'); assert.deepEqual(seen, ['a', null]);
  // Stop (stopChat closes), failure (onStream error closes), clear / new conversation / character reset (clear), hidden (suppressWaiting).
  for (const end of [(s: ReplyPresentationState, id: string) => s.close(id), (s: ReplyPresentationState) => s.clear(), (s: ReplyPresentationState) => s.suppressWaiting()]) {
    const log: (string | null)[] = [], s = new ReplyPresentationState(undefined, id => log.push(id));
    s.begin('r'); end(s, 'r');
    assert.deepEqual(log, ['r', null]);
    s.content('r', '迟到的字'); s.begin('r');
    assert.deepEqual(log, ['r', null], 'a late result of the ended reply changes nothing');
  }
  // A new reply replaces a waiting one (the old one ends first); a hydrated reply with text is not waiting.
  const log: (string | null)[] = [], s = new ReplyPresentationState(undefined, id => log.push(id));
  s.begin('one'); s.begin('two'); assert.deepEqual(log, ['one', null, 'two']);
  s.close('two'); s.begin('three', '已经有字'); assert.deepEqual(log, ['one', null, 'two', null]);
  // A throwing observer never disturbs the reply state.
  const broken = new ReplyPresentationState(undefined, () => { throw new Error('stage gone'); });
  assert.equal(broken.begin('x'), true); assert.equal(broken.isWaiting('x'), true);
  broken.content('x', '字'); assert.equal(broken.isWaiting('x'), false);
});

// ------------------------------------------------------------------ 2. the presenter

function presenter(patch: Partial<ReplyThinkingOptions> = {}) {
  const stage: (string | null)[] = [], cues: string[] = [], tasks: (() => void)[] = [];
  const options: ReplyThinkingOptions = {
    stage: () => ({ setReplyThinking: key => { stage.push(key); } }),
    cue: { play: (kind, deadline) => { cues.push(`${kind}≤${deadline}`); return new Promise(() => {}); } },
    voiceOn: () => true, speaks: () => true, busy: () => false, schedule: task => { tasks.push(task); }, ...patch,
  };
  return { p: new ReplyThinkingPresenter(options), stage, cues, flush: () => { while (tasks.length) tasks.shift()!(); } };
}

test('X1 presenter: the stage hears at once; one "嗯…" a microtask later, read-aloud on and this window\'s reply only', () => {
  const a = presenter();
  assert.equal(a.p.waiting('r1'), undefined, 'nothing to await');
  assert.deepEqual(a.stage, ['r1'], 'synchronously');
  assert.deepEqual(a.cues, [], 'the cue waits for the lifecycle to finish beginning');
  a.flush(); assert.deepEqual(a.cues, [`think≤${THINK_CUE_DEADLINE_MS}`]);
  a.p.waiting('r1'); a.flush(); assert.deepEqual(a.cues.length, 1, 'once per reply');
  a.p.waiting(null); assert.deepEqual(a.stage, ['r1', null]);
  a.p.waiting('r1'); a.flush(); assert.equal(a.cues.length, 1, 'a repeat of an earlier reply never hums again');
  // The first word before the microtask: no cue.
  const quick = presenter(); quick.p.waiting('r'); quick.p.waiting(null); quick.flush();
  assert.deepEqual(quick.cues, []); assert.deepEqual(quick.stage, ['r', null]);
  for (const patch of [{ voiceOn: () => false }, { speaks: () => false }, { busy: () => true }] as Partial<ReplyThinkingOptions>[]) {
    const skipped = presenter(patch); skipped.p.waiting('r'); skipped.flush();
    assert.deepEqual(skipped.cues, [], `skipped: ${Object.keys(patch)[0]}`);
    assert.deepEqual(skipped.stage, ['r'], 'the stage still thinks');
  }
  // Nothing it touches can throw into the reply lifecycle.
  const broken = presenter({ stage: () => { throw new Error('no stage'); }, cue: { play: () => { throw new Error('no audio'); } }, schedule: task => task() });
  assert.doesNotThrow(() => { broken.p.waiting('r'); broken.p.waiting(null); });
  const rejected = presenter({ cue: { play: () => Promise.reject(new Error('device')) }, schedule: task => task() });
  assert.doesNotThrow(() => rejected.p.waiting('r'));
});

// ------------------------------------------------------------------ 3. the cue: shared path, own player

const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
const pcm = (ms: number) => Buffer.alloc(Math.round(ms * 24) * 2).toString('base64');
const bailian: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };

test('X1 cue (Bailian): the "嗯…" uses the feeding cue cache path in its own player; neither stops nor evicts the other; not ready → skipped', async (t: TestContext) => {
  const w = pauseAudioWorld(t);
  const calls: string[] = [];
  const api = { async synthesizeFeedCue(kind: string) { calls.push(kind); return { pcm: pcm(kind === 'think' ? 500 : 400) }; } };
  const feedAudio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  const thinkAudio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  const feed = new FeedCuePlayer({ api, getTtsConfig: () => bailian, getVoiceConfig: () => voice, audio: feedAudio, timers: w.timers, now: w.now });
  const think = new FeedCuePlayer({ api, getTtsConfig: () => bailian, getVoiceConfig: () => voice, audio: thinkAudio, timers: w.timers, now: w.now, kinds: THINK_CUE_KINDS });
  t.after(() => { feed.dispose(); think.dispose(); feedAudio.dispose(); thinkAudio.dispose(); });
  assert.equal(await think.play('think', THINK_CUE_DEADLINE_MS), null, 'not ready: skipped, never late');
  await w.advance(5);
  assert.deepEqual(calls, ['think'], 'its player fetches only its own kind');
  feed.prefetch(); await w.advance(5);
  assert.deepEqual(calls.sort(), ['ah', 'mm', 'think']);
  const feeding = await feed.play('ah', 250);
  assert.ok(feeding);
  const sourceOf = (seconds: number) => w.contexts.flatMap(context => context.sources).filter(source => Math.abs((source.buffer?.duration ?? 0) - seconds) < 1e-9).at(-1)!;
  const feedSource = sourceOf(0.4);
  await w.advance(100);
  const humming = await think.play('think', THINK_CUE_DEADLINE_MS);
  assert.ok(humming, 'cached: plays');
  const thinkSource = sourceOf(0.5);
  assert.notEqual(thinkSource, feedSource);
  assert.equal(feedSource.stopAt, Infinity, 'the hum does not stop the feeding cue');
  await feed.play('mm', 350);
  assert.equal(thinkSource.stopAt, Infinity, 'a feeding cue does not stop the hum');
  // Both caches stay warm: neither player evicted the other's clips.
  assert.ok(await think.play('think', THINK_CUE_DEADLINE_MS));
  assert.ok(await feed.play('ah', 250));
  assert.deepEqual(calls.sort(), ['ah', 'mm', 'think'], 'no refetch');
});

test('X1 cue (system voice) speaks the fixed "嗯…" after the settle gap, or not at all', async (t: TestContext) => {
  const e = pausableEngine(t);
  const think = new FeedCuePlayer({ api: {}, getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => voice, timers: e.timers, now: e.now, kinds: THINK_CUE_KINDS });
  t.after(() => think.dispose());
  const started = think.play('think', THINK_CUE_DEADLINE_MS);
  await e.advance(CANCEL_SETTLE_MS);
  assert.deepEqual(e.queued.map(item => item.text), [CUE_TEXT.think]);
  assert.equal(CUE_TEXT.think, '嗯…');
  e.start(e.queued[0]); assert.ok(await started);
  const off = new FeedCuePlayer({ api: {}, getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => ({ ...voice, enabled: false }), timers: e.timers, now: e.now, kinds: THINK_CUE_KINDS });
  t.after(() => off.dispose());
  assert.equal(await off.play('think', THINK_CUE_DEADLINE_MS), null, 'read-aloud off: silent');
});

test('X1 cue host: fixed "嗯…" text with its own instruction, cached apart from the feeding "嗯～"; unknown kinds refused', async () => {
  const requests: { text: string; config: TtsConfig }[] = [];
  const synth = new FeedCueSynth(async (config, text, _signal, emit) => {
    requests.push({ text, config });
    await emit({ type: 'audio', data: pcm(300), format: 'pcm_s16le', sampleRate: 24000, channels: 1 } as TtsStreamEvent);
    await emit({ type: 'done', firstAudioMs: 1, audioBytes: 14400 });
    return { firstAudioMs: 1, audioBytes: 14400 };
  }, () => 0);
  await assert.rejects(synth.clip('嗯', bailian), /种类/);
  await assert.rejects(synth.clip('hmm', bailian), /种类/);
  assert.ok(await synth.clip('think', bailian));
  assert.ok(await synth.clip('mm', bailian));
  assert.ok(await synth.clip('think', bailian));
  assert.deepEqual(requests.map(item => item.text), ['嗯…', '嗯～'], 'one clip per kind, the second ask is cached');
  assert.equal(requests[0].config.instruction, THINK_CUE_INSTRUCTION);
  assert.equal(requests[1].config.instruction, FEED_CUE_INSTRUCTION);
  assert.equal(await synth.clip('think', { ...bailian, provider: 'system' }), null, 'not Bailian: nothing to fetch');
});

// ------------------------------------------------------------------ 4. timing on the same fake Claude Code

const persona = '你是测试角色小桃。';
function task(messages: ChatMessage[], id: string): CompanionClaudeTask {
  return { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, prompt: '.', imageDataUrls: [], replyId: id,
    session: { key: 'conversation', basePersona: persona, persona: `${persona}\n\n当前心情：平静。`, messages } };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

test('X1 timing: on the same fake Claude Code the thinking presentation adds no await or block; the first word paints in the same step, at the same time', async () => {
  const claude = await fakeClaudeStream();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script],
    provider: () => ({ kind: 'claude', model: 'haiku' }), chattedBefore: () => false, interruptGraceMs: 3000, log: () => {}, maxTurns: 64 });
  const history: ChatMessage[] = [];
  const character = { seedKey: 'gene', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity, companion: null };
  const turn = async (thinking: boolean, n: number) => {
    // The stage's thinking channel keeps rendering meanwhile, as the pet's frame loop would.
    const channel = new ReplyThinking(), owner = {}, stageCalls: (string | null)[] = [];
    const frames = setInterval(() => channel.frame(1 / 60, { owner, character, gates: { head: true, gaze: true, face: true } }), 16);
    const presenterUnderTest = new ReplyThinkingPresenter({ stage: () => ({ setReplyThinking: key => { stageCalls.push(key); channel.set(key); } }),
      // A cue that never settles: if anything on the reply path waited on it, the turn could not finish.
      cue: { play: () => new Promise(() => {}) }, voiceOn: () => true, speaks: () => true });
    const presentation = new ReplyPresentationState(undefined, thinking ? id => presenterUnderTest.waiting(id) : undefined);
    const id = `x1-${thinking ? 'on' : 'off'}-${n}`, user: ChatMessage = { role: 'user', content: `第${n}句` };
    let reply = '', inDelta = false, firstDelta = -1, firstPaint = -1, paintedInDelta = false;
    const sentAt = performance.now();
    // The renderer's beginChat at send time (the host's chat-started), then the stream.
    presentation.begin(id);
    presentation.startReadout(id, () => { if (firstPaint < 0) { firstPaint = performance.now(); paintedInDelta = inDelta; } });
    const atSend = [...stageCalls];
    try {
      await chat.stream(task([...history, user], id), new AbortController().signal, (type, text) => {
        if (type !== 'delta') return;
        if (firstDelta < 0) firstDelta = performance.now();
        inDelta = true;
        try { reply += text; presentation.content(id, reply); presentation.readoutContent(id, reply); }
        finally { inDelta = false; }
      });
    } finally { clearInterval(frames); }
    presentation.close(id); presentation.cancelReadout();
    history.push(user, { role: 'assistant', content: `收到，${user.content}` });
    return { firstWordMs: firstDelta - sentAt, paintGapMs: firstPaint - firstDelta, paintedInDelta, atSend, stageCalls, reply };
  };
  try {
    await turn(false, 0); // the process starts once; every measured turn runs on the same warm process
    const off: number[] = [], on: number[] = [], gaps: number[] = [];
    for (let n = 1; n <= 16; n++) {
      const thinking = n % 2 === 0, result = await turn(thinking, n);
      assert.equal(result.paintedInDelta, true, 'the first word is painted inside the delta that carries it (no await between)');
      assert.ok(result.reply.startsWith('收到，'));
      (thinking ? on : off).push(result.firstWordMs); gaps.push(result.paintGapMs);
      if (thinking) {
        assert.deepEqual(result.atSend, [`x1-on-${n}`], 'the stage is told synchronously at send');
        assert.deepEqual(result.stageCalls, [`x1-on-${n}`, null], 'and released at the first word');
      } else assert.deepEqual(result.stageCalls, []);
    }
    const spawns = await claude.spawns();
    assert.equal(spawns.length, 1, 'one warm process for every turn');
    const difference = median(on) - median(off);
    if (REPORT) console.log(`first word (send → first delta, ms): without thinking median ${median(off).toFixed(2)} [${off.map(v => v.toFixed(1)).join(' ')}]; with thinking median ${median(on).toFixed(2)} [${on.map(v => v.toFixed(1)).join(' ')}]; delta → bubble paint at most ${Math.max(...gaps).toFixed(3)} ms`);
    assert.ok(difference < 15, `first word is not slower with thinking (median +${difference.toFixed(2)} ms)`);
    assert.ok(Math.max(...gaps) < 5, 'the bubble paints within the first delta in both');
  } finally {
    chat.dispose();
    const pids = (await claude.spawns()).map(spawn => spawn.pid);
    await until(() => pids.every(pid => !alive(pid)));
    await claude.cleanup();
  }
});
