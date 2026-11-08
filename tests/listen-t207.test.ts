// Codex T-207 (X-251, X-252; fixed at dae249b): counterexamples in 一起听 (I-016) and the outbound boundary the user approved
// (docs/claude/2026-11-03-listen-watch-plan.md, "同意方案" 2026-11-03 20:36; record docs/claude/2026-11-03-listen-together.md):
//  - the sound never leaves the computer: only the local recognizer transcribes; with 识别方式 = compatible the switch is rhythm only;
//  - text reaches the user's Claude only (1) as one segment's bounded transcript for its haiku note (a segment's end, a long show's
//    roll about every ten minutes, a show paused 30 s with enough new words), (2) when the user asks (the note or a little raw
//    text), (3) as the note when she speaks at a pause;
//  - plain talk (a call, a meeting) is not kept, and she does not comment on it; when it is unclear, nothing is kept.
// Every input is synthetic: hand-written text, programme-made PCM, fake clocks, fake model ports. No Electron, no network, no device.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AmbientAsrRoute, type AmbientAsrRouteDeps } from '../electron/asr/ambient-route';
import { LocalAsrError } from '../electron/asr/host';
import { transcribeAmbientWav } from '../electron/ambient-asr';
import { AudioReadingHostBroker } from '../electron/audio-reading-host-broker';
import { validateVoiceInput } from '../electron/validation';
import { ListenKindSource } from '../electron/listen-kind-source';
import { ListenTogetherCore } from '../electron/listen-together/core';
import { ListenTogether } from '../electron/listen-together/host';
import type { AmbientCommentsLike } from '../electron/listen-together/proactive';
import { LISTEN_LIMITS, segmentText, type ListenSegment } from '../shared/listen-together';
import { ListenKindHost, type ListenKind } from '../shared/listen-kind';
import { listenAskContext, matchListenAsk } from '../shared/listen-ask';
import type { NoteRequest } from '../shared/listen-note';
import type { VoiceInputConfig } from '../shared/contracts';
import type { StageMusicState } from '../shared/her-state';
import { createMoodState, getMoodSnapshot, DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import { NOTICE_ACTIONS, readingRefusalAction } from '../src/notice-policy';
import { listenSwitchStatus } from '../src/ui/ListenTogetherSwitch';
import { setUiLanguage, uiText } from '../src/ui/ui-language';
import { MusicLikeness } from '../src/stage/music-likeness';
import { encodeWav } from '../src/ui/MediaInput';
import { musicPresence, MUSIC_AUDIBLE_RMS } from '../src/stage/music-presence';
import { analyserSamples, RATE, rng, seconds, speechLike } from './helpers/listen-audio';

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// ---- 1. the waveform never leaves the computer ----

/** Replaces the global fetch for one test: every call is counted and answered locally (the reserved address is never reached). */
function trapFetch() {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (request: unknown) => { calls.push(String(request)); return Response.json({ text: '合成占位结果' }); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/** The route as dae249b's electron/main.ts built it: the stored setting, the local host, and the HTTP transcriber it handed in. */
function routeLikeMain(config: () => VoiceInputConfig, local: { ready: boolean; blocked?: 'needs-component' | 'preparing' | 'unavailable' | null } | null) {
  let localCalls = 0;
  const deps = {
    config, journal() {}, characterId: () => 'synthetic',
    local: () => local ? { ready: local.ready, voiceBlocked: () => local.blocked ?? null,
      recognize: async () => {
        if (!local.ready) throw new LocalAsrError('needs-component', 'synthetic: not installed');
        localCalls++; return { text: '本机占位结果', tags: { language: 'zh' as const, event: 'bgm' as const, emotion: null } };
      } } : null,
    // dae249b handed the route the HTTP transcriber. The fixed route has no such port: listening together may never use it.
    compatible: (voice: VoiceInputConfig, wav: ArrayBuffer, signal: AbortSignal) => transcribeAmbientWav(voice, wav, signal),
  };
  return { route: new AmbientAsrRoute(deps as AmbientAsrRouteDeps), localCalls: () => localCalls };
}

test('T-207 #1: an old setting with a changed address (识别方式 = compatible) turns 一起听 on as rhythm only, with the reason; no clip leaves', async t => {
  // A setting saved before 识别方式 existed, its address changed by the user: validation keeps the compatible interface.
  const config = validateVoiceInput({ baseUrl: 'https://asr.example.invalid/v1', model: 'fixture', language: 'zh' });
  assert.equal(config.engine, 'compatible', 'precondition of the counterexample');
  const net = trapFetch();
  const { route, localCalls } = routeLikeMain(() => config, { ready: true });
  let publications = 0;
  const broker = new AudioReadingHostBroker('t207-synthetic', {
    acquire: async () => ({ captureId: 'synthetic-system', release: async () => {} }),
    transcribe: async (input, signal) => route.transcribe(input.wav, signal),
    publicationReady: ticket => { publications++; ticket.discard(); return undefined; },
  });
  try {
    // electron/main.ts setAudioReadingIntent asks exactly this before it turns the words on.
    const refused = route.blocked('pet');
    assert.equal(refused, 'not-local', 'the words part is refused: only the local recognizer may transcribe played sound');
    assert.equal(route.ready(), false, 'no listening session can start on the compatible address');
    // She says why (the pet's notice), in both languages; the status under the switch is the rhythm-only line.
    assert.equal(readingRefusalAction(refused), 'reading-not-local');
    try {
      for (const language of ['zh-CN', 'en'] as const) {
        setUiLanguage(language);
        const line = uiText(NOTICE_ACTIONS['reading-not-local']);
        assert.ok(line.length > 10 && line.length <= 160, `${language}: fits the toast`);
        if (language === 'zh-CN') { assert.match(line, /本机自带识别/); assert.match(line, /不会离开/); assert.match(line, /节奏/); }
        else assert.ok(!/[一-鿿]/u.test(line), 'English copy');
      }
    } finally { setUiLanguage('zh-CN'); }
    assert.match(listenSwitchStatus({ view: broker.getView(), systemDance: true, danceActive: true }), /^只听得到节奏/);
    // Even if a words cell were turned on anyway (an old internal path), a clip is not transcribed and nothing is posted.
    await broker.setIntent('system-audio', 'music', true); await broker.settled();
    const token = broker.currentCapture('system-audio'); assert.ok(token);
    assert.equal(broker.submitSegment(token, { sequence: 1, startedAtMs: 1_000, pcm16: new ArrayBuffer(32_000) }).accepted, true);
    await broker.settled();
    t.diagnostic(JSON.stringify({ engine: route.engine, posted: net.calls, localCalls: localCalls(), publications }));
    assert.deepEqual(net.calls, [], 'I-016 never posts a system-audio waveform');
    assert.equal(localCalls(), 0, '识别方式 is not local: no transcription at all (rhythm only)');
    assert.equal(publications, 0, 'nothing is published to be kept');
  } finally {
    broker.dispose(); await broker.settled(); net.restore();
  }
});

test('T-207 #1: no setting and no component state sends a played clip anywhere; only the local recognizer ever hears one', async () => {
  const net = trapFetch();
  const wav = encodeWav(new Float32Array(16_000).fill(0.05));
  try {
    const cases: [string, VoiceInputConfig, Parameters<typeof routeLikeMain>[1], 'local' | 'none'][] = [
      ['local, ready', { ...validateVoiceInput({}), engine: 'local' }, { ready: true }, 'local'],
      ['local, component missing', { ...validateVoiceInput({}), engine: 'local' }, { ready: false, blocked: 'needs-component' }, 'none'],
      ['local, no recognizer for this computer', { ...validateVoiceInput({}), engine: 'local' }, null, 'none'],
      ['compatible, filled in', validateVoiceInput({ baseUrl: 'https://asr.example.invalid/v1', model: 'm', engine: 'compatible' }), { ready: true }, 'none'],
      ['compatible, empty model', validateVoiceInput({ baseUrl: 'https://asr.example.invalid/v1', model: '', engine: 'compatible' }), { ready: true }, 'none'],
      ['pre-engine, changed address', validateVoiceInput({ baseUrl: 'http://192.0.2.1:9000/v1', model: 'm' }), { ready: true }, 'none'],
    ];
    for (const [name, config, local, expected] of cases) {
      const { route, localCalls } = routeLikeMain(() => config, local);
      const words = route.blocked('pet') === null;
      let heard = false;
      try { await route.transcribe(wav, new AbortController().signal); heard = true; } catch { /* refused or not local */ }
      assert.equal(words && heard ? 'local' : 'none', expected, name);
      assert.equal(localCalls() > 0, expected === 'local', `${name}: the local recognizer is the only one asked`);
    }
    assert.deepEqual(net.calls, [], 'not one request left the computer');
  } finally { net.restore(); }
});

// ---- 2. a quote, a refusal or someone else's words is not a question ----

function askRig() {
  let clock = T0;
  const kinds = new ListenKindHost();
  const core = new ListenTogetherCore({ kinds, now: () => clock, characterId: () => 'synthetic', listening: () => true,
    note: async () => { throw new Error('no note expected'); }, save: async () => {} });
  kinds.set({ kind: 'show', since: clock - 20_000, revision: 1, confidence: 1 });
  assert.equal(core.accept({ at: clock - 12_000, end: clock - 2_000, text: '合成台词核验标记柠檬八十七', language: 'zh' }), 'kept');
  clock += 20_000;
  kinds.set({ kind: 'music', since: clock - 15_000, revision: 2, confidence: 1 });
  assert.equal(core.accept({ at: clock - 12_000, end: clock, text: '合成歌词核验标记苹果三十一', language: 'zh' }), 'kept');
  return core;
}
const CANARIES = /柠檬八十七|苹果三十一/u;

test('T-207 #2: a quoted question, a refusal, or someone else\'s words never brings the raw transcript into an ordinary turn', async t => {
  const core = askRig();
  try {
    // Genuine questions still bring the words (the plan's step 4).
    for (const line of ['刚才那句台词什么意思？', '这首歌在唱什么', '我没听懂刚才那句台词', '“远方有雪”这句歌词什么意思', '这首歌不是讲分手的吗', '演到哪了'])
      assert.match(core.askContext(line), CANARIES, `a real question: ${line}`);
    const unrelated = [
      '不要引用或讨论刚才那句台词。请只说今天是星期几。', // Codex T-207
      '请把「刚才那句台词什么意思」翻译成英文，别回答引号里的问题。', // Codex T-207
      '别管刚才那首歌', '不要再放这首歌了', '别提这集了', '不用回答刚才那句台词是什么意思',
      '他说\'刚才那首歌讲的什么\'', '他说“这集演到哪了”', '她问：刚才那句歌词什么意思', '“刚才那首歌讲的什么”这句话用英语怎么说',
      "don't quote that line, just tell me the time", 'please do not discuss this song', 'he said "what is this song about"',
    ];
    const blocks = unrelated.map(line => core.askContext(line));
    t.diagnostic(JSON.stringify(unrelated.map((line, i) => ({ line, attachedRaw: CANARIES.test(blocks[i]!) }))));
    assert.deepEqual(blocks.map(block => block.length > 0), unrelated.map(() => false), 'none of these asks about the sound playing');
  } finally { await core.flush(); }
});

test('T-207 #2: when it is not clear the user is asking her, the turn may carry her note but never the raw words', () => {
  for (const line of ['朋友问我这集演到哪了', '他说这首歌讲的是分手', '我不想聊工作了，刚才那首歌讲的什么'])
    assert.equal(matchListenAsk(line)?.raw, false, `uncertain: ${line}`);
  for (const line of ['这集演到哪了', '你说这首歌讲的什么', '他刚才说了什么', 'what did she just say', '刚才那首歌讲的什么'])
    assert.equal(matchListenAsk(line)?.raw, true, `asked: ${line}`);
  const now = 10 * MIN;
  const segment: ListenSegment = { id: 's', characterId: 'c', kind: 'show', startedAt: now - 5 * MIN, lastHeardAt: now, endedAt: null, notedUpTo: now - 4 * MIN, notedAt: now,
    pieces: [{ at: now - 5 * MIN, end: now - 4 * MIN, text: '早一点的台词', language: 'zh' }, { at: now - MIN, end: now, text: '合成台词核验标记柠檬八十七', language: 'zh' }] };
  const note = { id: 'ln-s', characterId: 'c', segmentId: 's', kind: 'show' as const, what: '剧' as const, gist: '两个人在车站告别', mood: '不舍', points: [], mention: false,
    hook: '', startedAt: segment.startedAt, endedAt: now, local: false, languages: ['zh' as const], createdAt: now, updatedAt: now, rolls: 0, talkedAt: null };
  const unsure = listenAskContext(matchListenAsk('朋友问我这集演到哪了'), { now, segments: [segment], notes: [note] });
  assert.match(unsure, /车站告别/, 'the note may come along');
  assert.ok(!CANARIES.test(unsure) && !unsure.includes('早一点的台词'), 'no raw text');
  assert.equal(listenAskContext(matchListenAsk('朋友问我这集演到哪了'), { now, segments: [segment], notes: [] }), '', 'no note: nothing at all');
  assert.match(listenAskContext(matchListenAsk('这集演到哪了'), { now, segments: [segment], notes: [note] }), CANARIES, 'asked: the recent raw text too');
});

// ---- 3. a call is never kept as a song or a show ----

/** Codex T-207's stage-report replay: the stage says what it hears each second, the host smooths it, the core keeps or drops. */
async function replay(steps: (stage: (count: number, music: StageMusicState, beat: number, speech?: boolean) => void) => void) {
  let now = T0;
  let stage: { music: StageMusicState; beat: number; always: boolean } | null = null;
  const source = new ListenKindSource({ stage: { current: () => stage }, hearing: () => true, now: () => now });
  const requests: NoteRequest[] = [];
  const core = new ListenTogetherCore({ kinds: source.host, now: () => now, characterId: () => 'synthetic', listening: () => true,
    note: async request => { requests.push(request); return ''; }, save: async () => {} });
  const kinds: ListenKind[] = [];
  steps((count, music, beat, speech = false) => {
    stage = { music, beat, always: false };
    for (let i = 1; i <= count; i++) {
      now += 1_000;
      if (speech && i % 12 === 0) source.noteHeard({ words: true, event: 'speech' });
      source.tick(); core.tick(); kinds.push(source.host.current().kind);
    }
  });
  const text = '合成会议核验标记橘子五十三';
  const decision = core.accept({ at: now - 12_000, end: now, text, language: 'zh' });
  await core.settled();
  return { kind: source.host.current().kind, decision, kinds,
    stored: core.snapshot().segments.some(segment => segment.pieces.some(piece => piece.text === text)), requests };
}

test('T-207 #3: a call that starts after a show and a recognised quiet is talk, not the old show; its words are not kept', async t => {
  const alone = await replay(seconds => seconds(110, 'still', 0.05, true));
  const afterShow = await replay(seconds => {
    seconds(16, 'still', 0.95); // the opening song
    seconds(40, 'still', 0.05, true); // a scene of dialogue
    seconds(35, 'silent', 0); // the show is over, and the host said so
    seconds(110, 'still', 0.05, true); // a speech-only call
  });
  t.diagnostic(JSON.stringify({ alone: { ...alone, kinds: undefined }, afterShow: { ...afterShow, kinds: [...new Set(afterShow.kinds)] } }));
  assert.ok(afterShow.kinds.includes('show') && afterShow.kinds.includes('quiet'), 'fixture: the show and the quiet were recognised');
  assert.deepEqual({ kind: alone.kind, decision: alone.decision, stored: alone.stored }, { kind: 'talk', decision: 'talk', stored: false });
  assert.deepEqual({ kind: afterShow.kind, decision: afterShow.decision, stored: afterShow.stored }, { kind: 'talk', decision: 'talk', stored: false });
  // A short pause inside the show (the host never said quiet) is still the same show.
  const shortPause = await replay(seconds => { seconds(16, 'still', 0.95); seconds(40, 'still', 0.05, true); seconds(10, 'silent', 0); seconds(40, 'still', 0.05, true); });
  assert.equal(shortPause.kind, 'show');
});

/** The real fast layer and host on synthetic PCM (Codex T-207's analyser replay), with the listen-together core on top. */
async function listenThrough(pcm: Float32Array, clip: { words: boolean; event: 'speech' | 'bgm' } | null, text?: (n: number) => string) {
  let now = T0, lastTick = 0, lastLoud = -Infinity, clips = 0;
  const fast = new MusicLikeness();
  let presence = musicPresence({ hearing: true, choice: undefined, danceOn: false, sinceLoudS: Infinity });
  const source = new ListenKindSource({ stage: { current: () => presence }, hearing: () => true, now: () => now });
  const requests: NoteRequest[] = [];
  const core = new ListenTogetherCore({ kinds: source.host, now: () => now, characterId: () => 'synthetic', listening: () => true,
    note: async request => { requests.push(request); return ''; }, save: async () => {} });
  let peak = 0;
  for (const sample of analyserSamples(pcm, { jitterMs: 0, refreshHz: 60 })) {
    fast.update(sample);
    if (sample.rms >= MUSIC_AUDIBLE_RMS) lastLoud = sample.time;
    peak = Math.max(peak, fast.score);
    const second = Math.floor(sample.time);
    if (second <= lastTick) continue;
    lastTick = second; now += 1_000;
    presence = musicPresence({ hearing: true, choice: undefined, danceOn: false, sinceLoudS: sample.time - lastLoud, music: fast.music, beat: fast.score });
    if (clip && second % 12 === 0) {
      source.noteHeard(clip); clips++;
      if (text) core.accept({ at: now - 12_000, end: now, text: text(clips), language: 'zh' });
    }
    source.tick(); core.tick();
  }
  const kind = source.host.current().kind;
  // Then the computer goes quiet for a while: whatever was open ends (and would be noted).
  presence = musicPresence({ hearing: true, choice: undefined, danceOn: false, sinceLoudS: 99 });
  for (let i = 0; i < 60; i++) { now += 1_000; source.tick(); core.tick(); }
  await core.settled();
  return { kind, peak, stored: core.snapshot().segments.flatMap(segment => segment.pieces.map(piece => piece.text)), requests };
}

test('T-207 #3: speech-like syllables over a steady hum (a beat the recognizer only ever hears as speech) is not a song; nothing of it is kept', async t => {
  const syllables = speechLike(0.65, { seed: 17, rate: 1.5 });
  const signal = seconds(42);
  for (let n = 0; n < signal.length; n++) signal[n] = syllables[n % syllables.length]! * 0.6 + 0.04 * Math.sin(2 * Math.PI * 114 * n / RATE);
  const run = await listenThrough(signal, { words: true, event: 'speech' }, n => `合成通话核验标记梨子${n}号，我们下午三点再对一下进度`);
  t.diagnostic(JSON.stringify({ kind: run.kind, peak: run.peak, stored: run.stored.length, requests: run.requests.length }));
  assert.ok(run.peak > 0.9, 'fixture: the fast layer does hear a steady beat in it');
  assert.notEqual(run.kind, 'music', 'conflicting evidence is not a song');
  assert.deepEqual(run.stored, [], 'not one of its words is kept, including those heard before the recognizer disagreed');
  assert.equal(run.requests.length, 0, 'and none is handed to the small model');
});

test('T-207 #3 (not changed, guarded): an irregular staccato melody the beat misses stays unkept without tags; the recognizer\'s instrumental tags make it music', async t => {
  const staccato = (duration: number) => {
    const pcm = seconds(duration), random = rng(42);
    const melody = [60, 64, 67, 72, 69, 67, 64, 62, 67, 71, 74, 72, 69, 65, 62, 60];
    for (let at = 0.1, index = 0; at < duration; index++) {
      const hold = 0.16 + 0.25 * random(), freq = 440 * 2 ** ((melody[index % melody.length]! - 69) / 12);
      const start = Math.round(at * RATE), length = Math.round(hold * RATE);
      for (let n = 0; n < length && start + n < pcm.length; n++) {
        const phase = 2 * Math.PI * freq * n / RATE, envelope = Math.sin(Math.PI * n / length) ** 0.7 * Math.exp(-2 * n / RATE);
        pcm[start + n] = 0.24 * envelope * (Math.sin(phase) + 0.3 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase));
      }
      at += hold + 0.12 + 0.43 * random();
    }
    return pcm;
  };
  const bare = await listenThrough(staccato(42), null);
  // The local recognizer answers a clip of music without singing with "." and the bgm tag (docs/claude/2026-11-03-ambient-local-asr.md).
  const tagged = await listenThrough(staccato(72), { words: false, event: 'bgm' });
  t.diagnostic(JSON.stringify({ bare: bare.kind, tagged: tagged.kind }));
  assert.equal(bare.kind, 'talk', 'known miss: the beat alone takes it for talk (the safe direction: nothing kept, she does not dance)');
  assert.equal(tagged.kind, 'music', 'with the switch\'s own recognizer tags it is music');
});

// ---- 3b. the core: when the host takes a song back, its raw text goes; a recognised quiet drops what was waiting ----

function coreRig() {
  let clock = T0, revision = 0;
  const kinds = new ListenKindHost(), requests: NoteRequest[] = [];
  const core = new ListenTogetherCore({ kinds, now: () => clock, characterId: () => 'synthetic', listening: () => true,
    note: async request => { requests.push(request); return ''; }, save: async () => {}, createId: () => `seg-${revision}` });
  const set = (kind: ListenKind, since = clock) => { kinds.set({ kind, confidence: 0.9, since, revision: ++revision }); core.tick(); };
  const hear = (text: string) => core.accept({ at: clock - 12_000, end: clock, text, language: 'zh' });
  const advance = async (ms: number) => { for (let t = 0; t < ms; t += 1_000) { clock += 1_000; core.tick(); } await flush(); };
  return { core, set, hear, advance, requests, now: () => clock, texts: () => core.snapshot().segments.flatMap(s => s.pieces.map(p => p.text)) };
}

test('T-207 #3: the host taking a song back (unsure from the song\'s own start) discards its raw text with no note; an ordinary change keeps it', async () => {
  const r = coreRig();
  const since = r.now();
  r.set('music', since); await r.advance(70_000); r.hear('被当成歌的通话第一句'); await r.advance(12_000); r.hear('被当成歌的通话第二句');
  r.set('unsure', since); await r.advance(10_000);
  assert.deepEqual(r.texts(), [], 'the stretch was never a song');
  assert.equal(r.requests.length, 0, 'no note of it');
  assert.equal(r.core.snapshot().segments.length, 0);
  // An ordinary change (the song ended into something unclear, since = now) keeps the song and notes it.
  const k = coreRig();
  k.set('music'); await k.advance(70_000); k.hear('真正的一首歌的歌词在这里唱着'); await k.advance(2_000);
  k.set('unsure'); await k.advance(LISTEN_LIMITS.musicGapMs + 2_000);
  assert.deepEqual(k.texts(), ['真正的一首歌的歌词在这里唱着']); assert.equal(k.requests.length, 1);
});

test('T-207 #3: words waiting while it is unclear are dropped once the host says quiet, so they never join the next song', async () => {
  const r = coreRig();
  r.set('unsure'); assert.equal(r.hear('听不出是什么的一段说话'), 'pending');
  await r.advance(30_000); r.set('quiet'); await r.advance(20_000);
  r.set('music'); r.hear('下一首歌的第一句歌词'); await r.advance(2_000);
  assert.deepEqual(r.texts(), ['下一首歌的第一句歌词']);
});

// ---- 4. X-252: when text leaves for the user's Claude, and what ----

const NOTE = (kind: 'music' | 'show') => JSON.stringify({ what: kind === 'music' ? '歌' : '剧', gist: kind === 'music' ? '一首讲雨夜等人的歌' : '两个人在车站告别的一段剧',
  mood: '安静、有点不舍', points: ['最后说了再见'], mention: true, hook: '你会去车站送人吗' });
/** The transcript one note request carries (the JSON string inside <transcript>). */
const transcriptOf = (prompt: string) => JSON.parse(/<transcript>\n([\s\S]*)\n<\/transcript>/u.exec(prompt)![1]!) as string;

test('X-252: a note request goes out only at a segment\'s end, a long show\'s roll or a pause, carrying only that segment\'s bounded text', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-t207-'));
  let clock = T0, revision = 0, on = true;
  const kinds = new ListenKindHost();
  const notes: { prompt: string; system: string; at: number }[] = [], lines: string[] = [];
  const listen = new ListenTogether({ directory, kinds, characterId: () => 'synthetic-card', listening: () => on, now: () => clock,
    quick: async (prompt, system) => { notes.push({ prompt, system, at: clock }); return NOTE(/一段剧或视频/u.test(prompt) ? 'show' : 'music'); } });
  // Her pause line: the same ports main.ts gives it, the chat model replaced by a recorder.
  let busy = false;
  const session = { owner: 2, sessionId: 'scope-1', startedAt: T0, captureReadyAt: T0, mode: 'music' as const, scope: { characterId: 'synthetic-card', providerScope: 'p' }, contextIdentity: 'ctx' };
  const ports = {
    gate: { get busy() { return busy; }, setScope() {}, tryAcquire: () => { if (busy) return null; busy = true; const c = new AbortController();
      return { signal: c.signal, commit: () => { busy = false; return true; }, cancel: () => { c.abort(); busy = false; } }; } },
    currentSession: () => session, canComment: () => true, persona: () => '合成角色', moodText: () => '平静',
    generate: async (prompt: string) => { lines.push(prompt); return '{"comment":"刚才那首好安静"}'; }, offer() {}, random: () => 0,
  };
  const legacy: AmbientCommentsLike = { clear() {}, noteTranscript() {}, nextSourceObservation: () => undefined, interrupt() {}, observe() {},
    awaitingPresentation: () => null, acknowledge: async () => null, acceptUserTurn: async () => {} };
  const comments = listen.comments(ports, legacy, () => ({ primary: 'happy' }));
  const set = (kind: ListenKind) => { kinds.set({ kind, confidence: 0.9, since: clock, revision: ++revision }); listen.core.tick(); };
  const play = async (ms: number, line?: (i: number) => string) => {
    // One simulated second at a time, letting a note request's reply land before the next second (as the 1 s timer does).
    for (let t = 0, i = 0; t < ms; t += 1_000) {
      clock += 1_000; if (line && (t / 1_000) % 12 === 11) listen.core.accept({ at: clock - 12_000, end: clock, text: line(i++), language: 'zh' });
      listen.core.tick(); await flush();
    }
  };
  const segmentOf = (kind: 'music' | 'show') => listen.core.segmentsFor('synthetic-card').filter(s => s.kind === kind).at(-1)!;
  const cue = (source: { kind: 'ambient'; sessionId: string; observationId: string }): MoodView => {
    const snapshot = getMoodSnapshot(createMoodState(clock), clock);
    snapshot.cue = { id: `cue-${clock}`, kind: 'speech', at: clock, until: clock + 40_000, source };
    return { characterId: 'synthetic-card', revision: 1, token: 'tok', developerMode: false, expressions: true, parameters: DEFAULT_MOOD_PARAMETERS, snapshot, gesture: null };
  };
  try {
    // A song with lyrics: nothing goes out while it plays; its end sends exactly its own words, bounded.
    set('music'); await play(3 * MIN, i => `合成歌词核验标记苹果第${i}句雨一直下我在车站等你`);
    assert.equal(notes.length, 0, 'nothing while the song plays');
    const song = segmentOf('music');
    set('quiet'); await play(2_000);
    assert.equal(notes.length, 1, 'the song ended: one note request');
    assert.equal(transcriptOf(notes[0]!.prompt), segmentText(song), 'exactly this segment\'s words');
    assert.ok(transcriptOf(notes[0]!.prompt).length <= LISTEN_LIMITS.noteInputChars);
    // Her pause line: from the note only.
    const source = comments.nextSourceObservation(); assert.ok(source, 'the note was worth mentioning: one pause observation');
    assert.equal(lines.length, 0, 'no chat-model call before the mood host gives her the cue');
    comments.observe(cue(source!)); await flush();
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /一首讲雨夜等人的歌/); assert.ok(!/苹果|车站等你/u.test(lines[0]!), 'her line is written from the note, never the raw words');
    // A call: nothing kept, nothing sent, nothing said.
    set('talk'); await play(5 * MIN, i => `合成会议核验标记橘子第${i}项进度我们周五前对齐`);
    assert.equal(notes.length, 1); assert.equal(lines.length, 1);
    assert.ok(!listen.core.segmentsFor('synthetic-card').some(s => s.pieces.some(p => p.text.includes('橘子'))));
    // Asking is local: the block is built here, no model is called for it.
    assert.match(listen.askContext('刚才那首歌讲的什么'), /一首讲雨夜等人的歌/);
    assert.equal(listen.askContext('今天周几'), '');
    assert.equal(notes.length, 1); assert.equal(lines.length, 1);
    // A long show: a rolling note about every ten minutes, each with only the words since the last one (plus that note).
    set('show'); await play(25 * MIN, i => `合成台词核验标记柠檬第${i}句你真的要走了吗我送你去车站`);
    const show = segmentOf('show');
    assert.equal(notes.length, 3, 'two rolls in 25 minutes');
    for (const request of notes.slice(1)) {
      const words = transcriptOf(request.prompt);
      assert.ok(segmentText(show).includes(words.replace(/^…/u, '')), 'only this show\'s words');
      assert.ok(!/苹果|橘子/u.test(request.prompt), 'never another segment\'s words');
      assert.ok(words.length <= LISTEN_LIMITS.noteInputChars);
      assert.match(request.prompt, /前面已经记下的笔记|一段剧或视频/u);
    }
    assert.ok(!transcriptOf(notes[2]!.prompt).includes('第0句'), 'a roll reads the new part, not the whole viewing again');
    // Paused 30 s with enough new words: one more; then the switch goes off (Codex X-252): the open viewing ends, one last note.
    await play(3 * MIN, i => `合成台词核验标记柠檬暂停前第${i}句我们以后还会见面吗`);
    set('quiet'); await play(LISTEN_LIMITS.pauseMs + 2_000);
    assert.equal(notes.length, 4, 'the pause point');
    set('show'); await play(2 * MIN, i => `合成台词核验标记柠檬关开关前第${i}句好好照顾自己`);
    on = false; listen.core.tick(); await flush();
    assert.equal(notes.length, 5, 'switching off ends the viewing: one final note, its own bounded words');
    assert.ok(segmentText(segmentOf('show')).includes(transcriptOf(notes[4]!.prompt).replace(/^…/u, '')));
    t.diagnostic(JSON.stringify({ noteRequests: notes.map(n => ({ minute: Math.round((n.at - T0) / MIN), chars: transcriptOf(n.prompt).length })), herLines: lines.length }));
    // Nothing else ever left: five note requests (end, two rolls, pause, end) and one line of hers, from a note.
    await play(15 * MIN);
    assert.equal(notes.length, 5); assert.equal(lines.length, 1);
    assert.ok(notes.every(n => n.system.length > 0 && !/橘子/u.test(n.prompt)));
  } finally {
    await listen.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
