// no-pet-ok-file: the read-aloud handlers this test runs name the companion window pet (their sandbox needs the same name)
// I-209 stage voice (three on stage: "Mumi说话没朗读", "gene也不会朗读，
// 在启动unbound多人的时候"): every character on the full-screen stage reads her own lines in her own card's voice, one voice at a time; her
// reading rows carry her id; a cancelled or superseded line never speaks; one Drama 3 budget for everyone. Fake synthesizers only, no real calls.
// Reads as text (test-affected selects this test when they change): 'electron/wiring/voice-wiring.ts', 'electron/wiring/brain-stage-chat-wiring.ts'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { WIRING_PRELUDE, wiringDeclaration, wiringFunction, wiringHandler, wiringOption } from './helpers/wiring-source';
import { ReplyRhythmHost } from '../electron/brain/reply-rhythm-host';
import { CompletedReplySpeech } from '../electron/voice/completed-reply-speech';
import { ReplySpeechStyles } from '../electron/mood/speech-emotion';
import { SpeechRuntime, speechSynthesizer } from '../electron/voice/speech-runtime';
import { SpeechPlaybackActivity } from '../electron/voice/speech-playback-activity';
import { budgetedFishSynthesizer, FishBudget } from '../electron/voice/fish-voice-host';
import { GONE_SCOPE, readingScope, readingVoice } from '../electron/voice/stage-voices';
import { ReadNotes } from '../electron/voice/read-notes';
import { UnboundBubbleProof } from '../electron/unbound/read-aloud';
import { JournalExtras } from '../electron/memory/journal/extras';
import { BUBBLE_FOLLOW_KNOBS } from '../shared/voice';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/voice/tts';
import type { JournalInput } from '../shared/memory/journal';
import { ChimeTurns, CHIME_DROP_LINE, type ChimeTurnPorts } from '../electron/brain/stage-chat/turns';
import type { ChimeFacts } from '../electron/brain/stage-chat/facts';
import { HeldLines } from '../src/brain/held-lines';
import { ReadingVoices } from '../src/voice/reading-voices';
import { chimeInOrigin } from '../shared/senses/sense-router';
import { UNBOUND_REQUESTS, UNBOUND_EVENTS } from '../shared/unbound/scene';
import { stageWorld } from './helpers/stage-world';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const tick = () => new Promise(resolve => setImmediate(resolve));

// ---------------------------------------------------------------- her voice, her scope (the pure rule)

const FISH = { fishApiKey: 'placeholder-not-a-key' };
const settingsWith = (patch: Partial<TtsConfig> = {}) => ({ tts: { ...structuredClone(DEFAULT_TTS_CONFIG) as TtsConfig, provider: 'fish' as const, ...FISH, ...patch }, voice: { voiceURI: '' }, model: { path: 'C:/m/one.pmx' } });
const CARDS = new Map<string, { id: string; name: string; voice?: { provider: 'fish' | 'system'; voiceId: string } }>([
  ['one', { id: 'one', name: 'One', voice: { provider: 'fish', voiceId: 'v-one' } }],
  ['gene', { id: 'gene', name: 'Gene', voice: { provider: 'fish', voiceId: 'v-gene' } }],
  ['mumi', { id: 'mumi', name: 'Mumi', voice: { provider: 'fish', voiceId: 'v-mumi' } }],
  ['yuki', { id: 'yuki', name: 'Yuki', voice: { provider: 'system', voiceId: '' } }],
]);
const cards = { getActive: () => CARDS.get('one')!, getCard: (id: string) => { const card = CARDS.get(id); if (!card) throw new Error('no card'); return card; } };

function stageCompany() {
  const seats = new Map<string, number>([['gene', 0], ['mumi', 0], ['yuki', 0]]);
  return {
    seats,
    currentScope: () => ({ characterId: 'one', providerScope: 'claude' }),
    currentSpeechScope: () => 'conv-one',
    speechScopeOf: (id: string) => { if (!seats.has(id)) throw new Error('她不在台上'); return `seat:${id}:${seats.get(id)}`; },
  };
}
const ports = (company: ReturnType<typeof stageCompany>) => ({ desk: () => company.currentScope().characterId, deskScope: () => 'desk', seat: (id: string) => company.speechScopeOf(id) });

test('her scope: the desktop companion reads under hers as before; someone else on stage under her own seat; once she left, never', () => {
  const company = stageCompany();
  assert.equal(readingScope(null, ports(company)), 'desk');
  assert.equal(readingScope('one', ports(company)), 'desk', 'the desktop companion\'s own line: as before');
  assert.equal(readingScope('mumi', ports(company)), 'seat:mumi:0');
  company.seats.set('mumi', 1);
  assert.equal(readingScope('mumi', ports(company)), 'seat:mumi:1', 'her conversation changed: an older reading is no longer current');
  company.seats.delete('mumi');
  assert.equal(readingScope('mumi', ports(company)), GONE_SCOPE, 'she left the stage: no reading of hers is current');
  const styles = new ReplySpeechStyles();
  styles.begin(8, 'r-m', 'seat:mumi:0', 'mumi');
  styles.begin(8, 'r-1', 'desk');
  assert.deepEqual([styles.ownerOf('r-m'), styles.ownerOf('r-1'), styles.ownerOf(undefined)], ['mumi', null, null], 'whose each reading is outlives the one-slot style');
});

test('her voice: her card\'s provider and voice id (a system voice stays system), the desktop companion\'s as before', () => {
  const settings = settingsWith();
  assert.equal(readingVoice(settings, cards, null).fishVoiceId, 'v-one');
  assert.equal(readingVoice(settings, cards, 'gene').fishVoiceId, 'v-gene');
  assert.equal(readingVoice(settings, cards, 'mumi').fishVoiceId, 'v-mumi');
  assert.equal(readingVoice(settings, cards, 'yuki').provider, 'system', 'Yuki\'s own system voice, not One\'s Drama 3 (the window then speaks it itself)');
  assert.throws(() => readingVoice(settings, cards, 'gone'), 'a card that cannot be read is never read in someone else\'s voice');
});

// ---------------------------------------------------------------- the real read-aloud handlers (electron/wiring/voice-wiring.ts)

const HANDLERS = { next: 'nextReplySpeechSegment', synth: 'synthesizeSpeech', begin: 'beginSpeechPlaybackActivity', end: 'endSpeechPlaybackActivity' };
const compiled = ts.transpileModule([WIRING_PRELUDE, wiringDeclaration('ownerScope'), wiringDeclaration('speechScope'),
  ...['noteReadCancel', 'withCompletedPrefixProof', 'canBeginSpeechPlaybackActivity', 'cancelCompletedReply', 'cancelReplyStyle', 'replySurface', 'herOnScreen', 'heldLineSpeakable'].map(name => wiringFunction(name)),
  `return { ${Object.entries(HANDLERS).map(([key, name]) => `${key}: (${wiringHandler(name)})`).join(', ')}, speechScope };`].join('\n'),
{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

type Host = { next(owner: number, id: string, done?: number): Promise<{ index: number; text: string; context: unknown } | null>; synth(owner: number, id: string, text: string, context: unknown): Promise<void>;
  begin(owner: number, id: string): Promise<string | null>; end(owner: number, id: string, lease: string): void; speechScope(replyId?: string): string };

/** Out in full screen with others on stage: one voice (controls reads typed replies), the first host's bubble proof, Drama 3 under one budget. */
function voiceStage(cap = 0) {
  const company = stageCompany(), settings = settingsWith({ fishMonthlyCapUsd: cap }), styles = new ReplySpeechStyles(), plans = new CompletedReplySpeech();
  const activity = new SpeechPlaybackActivity(), proof = new UnboundBubbleProof({ active: () => true });
  const heard: { voice: string; text: string; replyId?: string }[] = [], effects: unknown[] = [];
  const budget = new FishBudget({ directory: () => 'C:/fake-profile', read: () => { throw new Error('none'); }, write: async () => {} });
  const fish = budgetedFishSynthesizer(budget, (async (config: TtsConfig, text: string, _signal: AbortSignal, _emit: unknown, extra: { accepted(bytes: number): void }) => {
    heard.push({ voice: config.fishVoiceId ?? '', text }); extra.accepted(200_000); return {} as never; }) as never);
  let host!: Host;
  const runtime = new SpeechRuntime((owner, context) => { // what voice-wiring's runtime resolves (her card, her scope)
    const config = readingVoice(settings, cards, styles.ownerOf(context?.replyId));
    return context ? { ...config, ...styles.resolveStyle(owner, context.replyId, host.speechScope(context.replyId)) } : config;
  }, (_owner, event) => { effects.push(event); }, speechSynthesizer(fish));
  const controls = { webContents: { id: 8, send: () => {} }, isDestroyed: () => false, isVisible: () => false, isMinimized: () => true };
  const pet = { webContents: { id: 7, send: () => {} }, isDestroyed: () => false, isVisible: () => false, isMinimized: () => false };
  const env: Record<string, unknown> = { completedReplySpeech: plans, replySpeechStyles: styles, replyRhythm: new ReplyRhythmHost(), speechRuntime: runtime, speechPlaybackActivity: activity,
    petReply: null, pet, controls, windows: () => [pet, controls], companion: company, readingScope, createHash, BUBBLE_FOLLOW_KNOBS,
    store: { current: { voice: { enabled: true }, model: { path: 'C:/m/one.pmx' } } }, textMemorialHost: null, unbound: { state: 'unbound', readAloud: proof },
    lastVisionSpeech: null, lastAmbientSpeech: null, visionPresentation: null, journalExtras: null,
    broadcast: (channel: string, value: unknown) => effects.push({ channel, value }), syncFatigueActivity: () => {}, suspendAmbientSpeech: () => {} };
  host = new Function(...Object.keys(env), compiled)(...Object.values(env)) as Host;
  activity.setScope('desk');
  /** A turn accepted the way brain-chat-wiring accepts it: under her scope (someone else on stage) and her name on the reading. */
  const turn = (id: string, owner: string | null, reader = 8) => {
    const scope = owner ? company.speechScopeOf(owner) : host.speechScope();
    const fence = plans.beginCommit(reader, id, scope);
    styles.begin(reader, id, scope, owner ?? undefined);
    assert.equal(styles.complete(reader, id, scope, { primary: 'calm', context: 'neutral' }, { instruction: 'her frozen feeling', emotion: 'calm' }), true);
    let shown = '';
    return {
      /** Her streamed words: the plan, and her bubble (the first host's proof; the stage sends the bubble to her window). */
      say(text: string) { plans.append(fence, text); shown += text; const rev = proof.sent(id, text); return () => proof.report({ id, rev, text: shown, visible: true }); },
      done() { assert.equal(plans.record(reader, id, scope, shown, { prefix: true, fence }), true); },
    };
  };
  /** The window reads one sentence: next, the playback lease, the synthesis, the drain. */
  const read = async (id: string, done?: number, reader = 8) => {
    const piece = await host.next(reader, id, done).catch(error => { if (process.env.STAGE_VOICE_DEBUG) console.log('next failed', error); return null; });
    if (!piece) return null;
    const lease = await host.begin(reader, `play-${id}-${piece.index}`);
    if (!lease) return { piece, lease };
    await host.synth(reader, `t-${id}-${piece.index}`, piece.text, piece.context);
    runtime.release(reader, `t-${id}-${piece.index}`); host.end(reader, `play-${id}-${piece.index}`, lease);
    return { piece, lease };
  };
  return { company, settings, styles, plans, proof, runtime, budget, heard, effects, host, turn, read, close: () => { runtime.stop(); activity.dispose(); } };
}

for (const onStage of [2, 3]) test(`${onStage} on stage: the reply of the one you clicked is read in HER voice, under her scope, through the real handlers`, { timeout: 4000 }, async t => {
  const v = voiceStage(); t.after(() => v.close());
  if (onStage === 2) v.company.seats.delete('gene');
  const mumi = v.turn('r-mumi', 'mumi');
  const painted = mumi.say('今天下雪了。'); mumi.done();
  const reading = v.read('r-mumi'); await flush();
  assert.equal(painted(), true, 'her page painted it (the first host\'s proof)');
  const first = await reading;
  assert.ok(first?.piece && first.lease, 'her sentence is handed out and may play');
  assert.deepEqual(v.heard, [{ voice: 'v-mumi', text: '今天下雪了。' }], 'her Drama 3 voice id, not One\'s');
});

test('she left the stage: the rest of her reply is never read (her scope is gone); the desktop companion\'s next reply reads as before', { timeout: 4000 }, async t => {
  const v = voiceStage(); t.after(() => v.close());
  const gene = v.turn('r-gene', 'gene');
  const one = gene.say('第一句。'), two = gene.say('第二句。'); gene.done();
  const reading = v.read('r-gene'); await flush(); one(); two();
  assert.equal((await reading)?.piece.index, 0);
  v.company.seats.delete('gene'); // sent back
  assert.equal(await v.read('r-gene', 0), null, 'nothing more of hers');
  assert.deepEqual(v.heard.map(row => row.voice), ['v-gene']);
  const desk = v.turn('r-one', null);
  const shown = desk.say('我在。'); desk.done();
  const mine = v.read('r-one'); await flush(); shown();
  assert.ok((await mine)?.lease);
  assert.deepEqual(v.heard.map(row => row.voice), ['v-gene', 'v-one'], 'One reads in her own voice after someone else on stage');
});

test('spending: everyone on stage reads against ONE Drama 3 budget: counted together, and the month\'s limit stops all of them', { timeout: 4000 }, async t => {
  const v = voiceStage(1); t.after(() => v.close()); // a $1 limit; the fake service counts 200 000 bytes per sentence
  const one = v.turn('r-one', null), shown = one.say('嗯。'); one.done();
  const a = v.read('r-one'); await flush(); shown(); await a;
  const before = v.budget.view().bytes;
  assert.equal(before, 200_000, 'One\'s sentence was counted');
  const gene = v.turn('r-gene', 'gene'), hers = gene.say('我也在。'); gene.done();
  const b = v.read('r-gene'); await flush(); hers(); await b;
  assert.deepEqual(v.heard.map(row => row.voice), ['v-one'], 'the limit One crossed stops Gene\'s Drama 3 too (one shared month)');
  assert.ok(v.effects.some(event => (event as { type?: string }).type === 'error'), 'her sentence ends as a refused (quota) reading');
  assert.equal(v.budget.view().bytes, before, 'nothing more was spent');
});

// ---------------------------------------------------------------- her line on stage: one voice at a time, nothing dropped, nothing doubled

const facts: ChimeFacts = { self: 'gene', selfName: 'Gene', present: [{ id: 'gene', name: 'Gene' }, { id: 'one', name: 'One' }], recent: [{ id: 'a', speaker: 'one', text: '下雪了', at: 0 }], streak: 1, sinceUserMs: 1000, userBusy: null, userAway: null };

function chimeRig(over: Partial<ChimeTurnPorts> = {}) {
  let now = 0;
  const state = { free: true, speaking: false, proven: true, onStage: true };
  const log: string[] = [];
  const ports: ChimeTurnPorts = {
    chatModel: () => '', character: () => ({ persona: '（Gene 的角色卡）' }), mood: () => '', history: () => '', available: () => true,
    decide: async () => '{"speak":true}', line: async () => '{"text":"真的吗"}',
    free: () => state.free, onStage: () => state.onStage, speaking: () => state.speaking, proven: () => state.proven,
    show: (id, lineId) => { log.push(`show ${id} ${lineId} speaking=${state.speaking}`); return true; },
    voice: (id, lineId) => { log.push(`voice ${id} ${lineId} speaking=${state.speaking}`); return true; },
    cut: lineId => { log.push(`cut ${lineId}`); }, release: lineId => { log.push(`release ${lineId}`); },
    archive: async (id, lineId) => { log.push(`archive ${id} ${lineId}`); },
    clock: () => now, sleep: async ms => { now += ms; await tick(); }, createId: () => 'x', ...over,
  };
  return { turns: new ChimeTurns(ports), state, log, now: () => now };
}

test('a chime-in waits as long as someone speaks (45 s here, longer than the old 30 s bound) and is then shown, archived and read once', async () => {
  const r = chimeRig();
  r.state.speaking = true; // One still reads her reply
  let ended = false;
  const run = r.turns.speak('gene', facts, new AbortController().signal).finally(() => { ended = true; });
  while (r.now() < 45_000 && !ended) await tick();
  assert.equal(ended, false, 'still waiting after 45 s of her speaking');
  assert.deepEqual(r.log, [], 'nothing while she speaks');
  r.state.speaking = false;
  assert.equal(await run, 'said', 'not dropped because someone was speaking');
  assert.deepEqual(r.log, ['show gene sense-chime-x speaking=false', 'archive gene sense-chime-x', 'voice gene sense-chime-x speaking=false', 'release sense-chime-x']);
});

test('two lines never sound at once: the gap between two of someone\'s sentences is not quiet; her voice only after her bubble is proven', async () => {
  const r = chimeRig();
  r.state.speaking = true;
  const run = r.turns.speak('gene', facts, new AbortController().signal);
  for (let gap = 0; gap < 5; gap++) { // One's sentences, with 200 ms of silence between them
    for (let i = 0; i < 10; i++) await tick();
    r.state.speaking = false; await tick(); await tick(); r.state.speaking = true;
  }
  assert.ok(!r.log.some(line => line.startsWith('show')), 'never shown in a gap between sentences');
  r.state.speaking = false; r.state.proven = false;
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(r.log[0]?.startsWith('show'), 'shown once quiet');
  assert.ok(!r.log.some(line => line.startsWith('voice')), 'not read before her page painted it');
  r.state.proven = true;
  assert.equal(await run, 'said');
  assert.ok(r.log.some(line => line.startsWith('voice gene') && line.endsWith('speaking=false')));
});

test('a superseded line never speaks or archives; your turn while she reads cuts her reading; someone else\'s newer line does not', async () => {
  const early = chimeRig(); early.state.speaking = true;
  const controller = new AbortController();
  const run = early.turns.speak('gene', facts, controller.signal);
  for (let i = 0; i < 5; i++) await tick();
  controller.abort('user'); early.state.speaking = false;
  assert.equal(await run, 'dropped');
  assert.deepEqual(early.log, [], 'never shown, never archived, never read');
  const late = chimeRig();
  const talking = new AbortController();
  const said = late.turns.speak('gene', facts, talking.signal);
  for (let i = 0; i < 500 && !late.log.some(line => line.startsWith('voice')); i++) await tick();
  late.state.speaking = true; await tick();
  talking.abort('user'); // you started talking while her line is read
  assert.equal(await said, 'said');
  assert.deepEqual(late.log.slice(-2), ['cut sense-chime-x', 'release sense-chime-x'], 'her reading stops; the floor passes');
  const other = chimeRig();
  const newer = new AbortController();
  const kept = other.turns.speak('gene', facts, newer.signal);
  for (let i = 0; i < 500 && !other.log.some(line => line.startsWith('voice')); i++) await tick();
  other.state.speaking = true; await tick();
  newer.abort(CHIME_DROP_LINE);
  for (let i = 0; i < 10; i++) await tick();
  assert.ok(!other.log.some(line => line.startsWith('cut')), 'someone else\'s newer line does not cut her');
  other.state.speaking = false;
  assert.equal(await kept, 'said');
});

test('how a line ended is a closed word: failed, unreadable, quiet, not-shown, busy', async () => {
  assert.equal(await chimeRig({ line: async () => { throw new Error('down'); } }).turns.speak('gene', facts, new AbortController().signal), 'failed');
  assert.equal(await chimeRig({ line: async () => '<<不是一句>>' }).turns.speak('gene', facts, new AbortController().signal), 'unreadable');
  assert.equal(await chimeRig({ line: async () => '{"text":""}' }).turns.speak('gene', facts, new AbortController().signal), 'quiet');
  assert.equal(await chimeRig({ show: () => false }).turns.speak('gene', facts, new AbortController().signal), 'not-shown');
  const never = chimeRig(); never.state.free = false;
  assert.equal(await never.turns.speak('gene', facts, new AbortController().signal), 'busy', 'only a stage that never comes free at all ends it');
});

// ---------------------------------------------------------------- the stage: her page's paint proves her lines for the one voice

test('the stage: her page\'s paint report proves her line (two and three on stage); a report about someone else\'s line does not', async () => {
  const w = stageWorld({ replyOwner: new Map([['r-a', 'vrm-a'], ['r-b', 'pmx-b']]) });
  const main = await w.enter(), a = await w.bringOut('vrm-a');
  w.host.stream({ id: 'r-a', kind: 'chat', type: 'delta', text: '我也想去。' });
  const bubble = a.of(UNBOUND_EVENTS.bubble).at(-1) as { id: string; rev: number; text: string };
  assert.equal(bubble.id, 'r-a', 'her reply went to her window');
  assert.equal(w.host.readAloud.isPresentationCurrent('我也想去。'), false, 'not proven before her page painted it');
  await w.call(UNBOUND_REQUESTS.shown, main, { id: 'r-a', rev: bubble.rev, text: '我也想去。', visible: true });
  assert.equal(w.host.readAloud.isPresentationCurrent('我也想去。'), false, 'the first one\'s page cannot prove a line it never showed');
  await w.call(UNBOUND_REQUESTS.shown, a, { id: 'r-a', rev: bubble.rev, text: '我也想去。', visible: true });
  assert.equal(w.host.readAloud.isPresentationCurrent('我也想去。'), true, 'her own page proves it: the voice may read it');
  const b = await w.bringOut('pmx-b');
  w.stage.own('sense-chime-b', 'pmx-b');
  w.host.holdLine('sense-chime-b', '真的吗');
  const line = b.of(UNBOUND_EVENTS.bubble).at(-1) as { rev: number };
  await w.call(UNBOUND_REQUESTS.shown, a, { id: 'sense-chime-b', rev: line.rev, text: '真的吗', visible: true });
  assert.equal(w.host.readAloud.isPresentationCurrent('真的吗'), false, 'A\'s page cannot prove B\'s line');
  await w.call(UNBOUND_REQUESTS.shown, b, { id: 'sense-chime-b', rev: line.rev, text: '真的吗', visible: true });
  assert.equal(w.host.readAloud.isPresentationCurrent('真的吗'), true, 'three on stage: B proves her own chime-in');
  w.host.exit(); w.host.quit();
});

test('the wiring: her chime-in is handed to the companion window with her voice, and may sound only while her bubble shows it and she is on stage', () => {
  const sent: unknown[] = [], begun: unknown[][] = [], guards = new Map<string, { canSpeak(id: string): boolean }>();
  const proof = { currentId: 'sense-chime-1', shown: true, isPresentationCurrent(text: string) { return this.shown && text === '真的吗'; } };
  let present = ['one', 'gene'];
  const pet = { isDestroyed: () => false, webContents: { id: 7, send: (channel: string, value: unknown) => { sent.push({ channel, value }); } } };
  const env = { needs: () => ({ pet, beginInitiativeSpeech: (...args: unknown[]) => { begun.push(args); } }), unbound: { readAloud: proof }, stageIds: () => present,
    readStageLine: (owner: number, id: string, guard: { canSpeak(id: string): boolean }) => { guards.set(`${owner}:${id}`, guard); }, chimeInOrigin };
  const voice = new Function(...Object.keys(env), `return (${ts.transpile(wiringOption('turns', 'voice')).trim().replace(/;$/, '')});`)(...Object.values(env)) as (id: string, lineId: string, text: string) => boolean;
  const proven = new Function(...Object.keys(env), `return (${ts.transpile(wiringOption('turns', 'proven')).trim().replace(/;$/, '')});`)(...Object.values(env)) as (lineId: string, text: string) => boolean;
  assert.equal(proven('sense-chime-1', '真的吗'), true);
  assert.equal(voice('gene', 'sense-chime-1', '真的吗'), true);
  assert.deepEqual(begun, [[7, 'sense-chime-1', 'gene']], 'her card\'s voice, her mood, her scope');
  assert.deepEqual((sent[0] as { value: Record<string, unknown> }).value.voice, 'gene', 'the companion window reads it with her voice');
  const guard = guards.get('7:sense-chime-1')!;
  assert.equal(guard.canSpeak('sense-chime-1'), true);
  assert.equal(guard.canSpeak('sense-chime-2'), false, 'only this line');
  proof.shown = false;
  assert.equal(guard.canSpeak('sense-chime-1'), false, 'her bubble no longer shows it: not one more piece of audio');
  assert.equal(proven('sense-chime-1', '真的吗'), false);
  proof.shown = true; present = ['one'];
  assert.equal(guard.canSpeak('sense-chime-1'), false, 'she left the stage: silent');
});

// ---------------------------------------------------------------- her reading rows carry her id

test('reading rows: each read line leaves its reading-time / reading-segments rows under the speaker\'s id; One\'s stay hers', () => {
  const rows: JournalInput[] = [];
  const extras = new JournalExtras({ sink: { record: (row: JournalInput) => { rows.push(row); return true; } } as never, characterId: () => 'one', engine: () => 'local', uptimeMs: () => 0, blushStage: () => {},
    timers: { set: () => 0, clear: () => {} } });
  const owners = new Map([['r-mumi', 'mumi'], ['sense-chime-g', 'gene']]);
  extras.readNotes.whose(id => owners.get(id) ?? null);
  const record = (segmentIndex: number | null, outcome: 'ended' | 'error' = 'ended') => ({ kind: 'reply' as const, provider: 'fish' as const, segmentIndex, textLength: 6, outcome, t: { request: 3, firstPacket: 120, playbackStart: 300 } });
  for (const id of ['r-mumi', 'r-one', 'sense-chime-g']) {
    extras.readNotes.offered(id); extras.readNotes.numberOf(id);
    extras.reading.segment(record(id.startsWith('sense') ? null : 0)); extras.reading.segment(record(1));
  }
  extras.reading.flush();
  const reading = rows.filter(row => row.type === 'reading-time' || row.type === 'reading-segments').map(row => `${row.type}:${row.characterId}`);
  assert.deepEqual(reading, ['reading-time:mumi', 'reading-segments:mumi', 'reading-time:one', 'reading-segments:one', 'reading-time:gene', 'reading-segments:gene']);
  rows.length = 0;
  extras.readNotes.offered('r-mumi'); extras.readingLedger.expect('r-mumi');
  extras.reading.notRead('not-asked', true, 'r-mumi');
  assert.equal(rows[0]?.characterId, 'mumi', 'a reply of hers never read says so under her id');
  const notes = new ReadNotes();
  notes.whose(() => { throw new Error('broken'); });
  notes.offered('x');
  assert.equal(notes.latestOwner(), null, 'a broken lookup is the desktop companion\'s (as before), never a crash');
});

// ---------------------------------------------------------------- the window: her held line read with her card's voice

test('the companion window: her held chime-in names whose voice reads it; a malformed name drops the line; a reply of hers is hers too', async () => {
  const voices = new ReadingVoices(), spoken: { text: string; owner: string | null }[] = [];
  let active: string | null = null;
  const held: HeldLines = new HeldLines({ ackVision: async () => true, ackAmbient: async () => null, free: () => true, voiceOn: () => true,
    speak: async text => { spoken.push({ text, owner: voices.speaking(held.active, active) }); }, stop: () => {}, ended: () => {}, rememberVision: () => {}, rememberAmbient: () => {},
    voiceOf: (id, characterId) => voices.own(id, characterId) });
  const line = { id: 'sense-chime-g', text: '真的吗', origin: chimeInOrigin('sense-chime-g', 1_700_000_000_000) };
  assert.equal(held.sense({ ...line, held: true, voice: 'gene' }), true);
  await flush();
  assert.deepEqual(spoken, [{ text: '真的吗', owner: 'gene' }], 'read, with Gene\'s voice');
  assert.equal(held.sense({ ...line, id: 'sense-chime-h', origin: chimeInOrigin('sense-chime-h', 1), held: true, voice: '../x' }), true);
  await flush();
  assert.equal(spoken.length, 1, 'a malformed name: dropped, never read');
  assert.equal(held.sense({ ...line, id: 'sense-chime-i', origin: chimeInOrigin('sense-chime-i', 1), held: true }), true);
  await flush();
  assert.deepEqual(spoken[1], { text: '真的吗', owner: null }, 'no name: the desktop companion\'s own line, as before');
  voices.own('r-mumi', 'mumi'); active = 'r-mumi';
  assert.equal(voices.speaking(null, active), 'mumi', 'her reply to you (ChatStarted.speakerId) reads in her voice');
  assert.equal(voices.speaking(null, 'r-one'), null);
});
