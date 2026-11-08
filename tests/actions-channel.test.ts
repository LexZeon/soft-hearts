/**
 * Internal channel: the user's own Claude can ask her to do one of the seven small actions (docs/claude/2026-11-06-actions-channel.md).
 * Gene and Gene-derived data only; fake windows, fake stage, no Electron, no real Claude call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelProfile } from '../shared/model-profile';
import { herActionSupport, type HerActionId, type HerActionPlayResult } from '../shared/her-actions';
import { CHAT_ACTION_OF, CHAT_ACTION_WORDS, chatActionRefusal, chatActionYield, offeredChatActions } from '../shared/chat-actions';
import { MOTION_SCORE_STAMP } from '../shared/motion-fit-record';
import type { ModelCapabilityView } from '../shared/model-capability-check';
import { ChatActionHost, CHAT_ACTION_AFTER_SPEECH_MS, CHAT_ACTION_SPEECH_POLL_MS } from '../electron/chat-actions-host';
import { AgentToolRegistry } from '../electron/agent-channel/registry';
import { createAppTools } from '../electron/agent-channel/app-tools';
import { AGENT_HOST_OPERATIONS, createHostBridge, type IpcHandler } from '../electron/agent-channel/bridge';
import { AGENT_TOOLS } from '../shared/agent-channel';
import { CAPABILITIES, capability } from '../shared/capabilities';
import { handbookCategory } from '../shared/capability-handbook';
import { readGene } from './helpers/bundled-motions';
import { profileInput, type ModelData } from './helpers/model-fixtures';
import { hideBones } from './helpers/hand-variants';

const GENE = readGene();
const geneData = (edit?: (data: ModelData) => ModelData): ModelData => {
  const data: ModelData = { positions: GENE.positions, skinBone: GENE.skinBone, bones: GENE.bones.map(bone => ({ ...bone, position: [...bone.position] })), morphs: GENE.morphs };
  return edit ? edit(data) : data;
};
const profileOf = (data: ModelData) => buildModelProfile(profileInput(data));
const GENE_PROFILE = profileOf(geneData());
const NO_FINGERS = profileOf(geneData(data => { hideBones(data.bones as never, name => /(親指|人指|中指|薬指|小指)/.test(name)); return data; }));
const IDLE = { expressions: true, snapshot: { phase: 'idle', intensity: { posture: 1, expression: 1 } } };

interface Options {
  profile?: typeof GENE_PROFILE | null; mood?: () => typeof IDLE | null; speaking?: () => boolean; choices?: Record<string, 'on' | 'off'>;
  play?: (action: HerActionId) => Promise<HerActionPlayResult>;
}
function fixture(options: Options = {}) {
  const state = { played: [] as HerActionId[], timers: new Map<number, () => void>(), serial: 0 };
  const profile = options.profile === undefined ? GENE_PROFILE : options.profile;
  const host = new ChatActionHost({
    modelPath: () => 'C:/models/gene.pmx',
    read: async () => profile ? { view: { modelKey: 'k'.repeat(64), modelUrl: '', profile, record: options.choices ? { choices: options.choices } as never : null } as ModelCapabilityView, fits: null } : null,
    play: options.play ?? (async action => { state.played.push(action); return { status: 'played', missing: [], detail: '' }; }),
    speaking: options.speaking ?? (() => false), mood: options.mood ?? (() => IDLE),
    timers: { set: (callback, ms) => { assert.equal(ms, CHAT_ACTION_SPEECH_POLL_MS); const id = ++state.serial; state.timers.set(id, callback); return id; }, clear: id => { state.timers.delete(id as number); } },
  });
  return { host, state };
}

// ---------------------------------------------------------------- the shared rule gives reasons

test('the reason a word is refused is the same rule as the tail list: no reason exactly when offered', () => {
  const models = [{ support: herActionSupport(GENE_PROFILE) }, { support: herActionSupport(NO_FINGERS) }, { support: herActionSupport(GENE_PROFILE), choices: { gesture: 'off' as const, mouth: 'off' as const } }, { support: null }, null];
  for (const model of models) {
    const offered = offeredChatActions(model);
    for (const word of CHAT_ACTION_WORDS) assert.equal(chatActionRefusal(word, model) === null, offered.includes(word), `${word} ${JSON.stringify(model?.choices)}`);
  }
  assert.match(chatActionRefusal('heart', { support: herActionSupport(NO_FINGERS) })!, /做不了，缺：.*手指/u, 'says what is missing');
  assert.match(chatActionRefusal('clap', { support: herActionSupport(GENE_PROFILE), choices: { gesture: 'off' } })!, /能做手势.*关掉/u);
  assert.match(chatActionRefusal('nod', null)!, /体检档案/u);
});

test('the mood gate gives a reason for each way it holds a word back, and none when idle', () => {
  assert.equal(chatActionYield('clap', IDLE), null);
  assert.match(chatActionYield('clap', { ...IDLE, expressions: false })!, /自动表现/u);
  assert.match(chatActionYield('clap', { ...IDLE, snapshot: { ...IDLE.snapshot, phase: 'sleeping' } })!, /sleeping/u);
  assert.match(chatActionYield('clap', { ...IDLE, snapshot: { ...IDLE.snapshot, intensity: { posture: 0, expression: 1 } } })!, /强度/u);
  assert.equal(chatActionYield('wink', { ...IDLE, snapshot: { ...IDLE.snapshot, intensity: { posture: 0, expression: 1 } } }), null, 'a face shape reads expression, not posture');
});

// ---------------------------------------------------------------- the host side

test('perform: each of the seven plays exactly one cue on a model that can do them', async () => {
  const { host, state } = fixture();
  for (const word of CHAT_ACTION_WORDS) {
    const result = await host.perform(word);
    assert.deepEqual([result.played, result.status, result.word], [true, 'played', word]);
  }
  assert.deepEqual(state.played, CHAT_ACTION_WORDS.map(word => CHAT_ACTION_OF[word]), 'one cue per call, the table\'s action');
});

test('perform: a model that cannot do it is told what is missing and nothing is played', async () => {
  const { host, state } = fixture({ profile: NO_FINGERS });
  const heart = await host.perform('heart');
  assert.deepEqual([heart.played, heart.status], [false, 'cannot']);
  assert.match(heart.reason, /缺：.*手指/u);
  assert.ok(heart.missing.length > 0);
  assert.equal((await host.perform('nod')).played, true, 'the others still work');
  assert.deepEqual(state.played, ['nod']);
  const noModel = fixture({ profile: null });
  assert.equal((await noModel.host.perform('wave')).status, 'cannot');
  assert.deepEqual(noModel.state.played, []);
  const off = fixture({ choices: { gesture: 'off' } });
  assert.equal((await off.host.perform('clap')).status, 'cannot', 'the character page switch is respected');
  assert.deepEqual(off.state.played, []);
});

test('perform: sleeping, head-pat or other interaction, auto-expression off, intensity 0, or no mood yet: skipped with the reason', async () => {
  for (const [mood, pattern] of [
    [{ ...IDLE, snapshot: { ...IDLE.snapshot, phase: 'sleeping' } }, /sleeping/u],
    [{ ...IDLE, snapshot: { ...IDLE.snapshot, phase: 'touch' } }, /touch/u],
    [{ ...IDLE, expressions: false }, /自动表现/u],
    [{ ...IDLE, snapshot: { ...IDLE.snapshot, intensity: { posture: 0, expression: 0 } } }, /强度/u],
    [null, /心情/u],
  ] as const) {
    const { host, state } = fixture({ mood: () => mood });
    const result = await host.perform('clap');
    assert.deepEqual([result.played, result.status], [false, 'yielded']);
    assert.match(result.reason, pattern);
    assert.deepEqual(state.played, []);
  }
});

test('perform: the stage\'s own answers come back in words (missing part, busy, no window, no answer, failure)', async () => {
  const answer = async (play: HerActionPlayResult) => (await fixture({ play: async () => play }).host.perform('tilt'));
  const missing = await answer({ status: 'missing', missing: ['头'], detail: '' });
  assert.deepEqual([missing.status, missing.missing], ['cannot', ['头']]);
  assert.match(missing.reason, /缺：头/u);
  assert.equal((await answer({ status: 'busy', missing: [], detail: '' })).status, 'busy');
  assert.equal((await answer({ status: 'unfit', missing: [], detail: '' })).status, 'cannot');
  assert.equal((await answer({ status: 'no-window', missing: [], detail: '' })).status, 'no-pet');
  assert.equal((await answer({ status: 'no-answer', missing: [], detail: '' })).status, 'failed');
  const thrown = await fixture({ play: () => Promise.reject(new Error('x')) }).host.perform('tilt');
  assert.deepEqual([thrown.played, thrown.status], [false, 'failed']);
});

test('perform: the pout waits for her to finish speaking (answer: waiting), then plays once; a new message drops it', async () => {
  let speaking = true;
  const { host, state } = fixture({ speaking: () => speaking });
  const result = await host.perform('pout');
  assert.deepEqual([result.played, result.status], [false, 'waiting']);
  assert.equal(host.pending, true);
  assert.deepEqual(state.played, []);
  // She is still speaking: nothing. Quiet for the grace time: one cue.
  const tick = async () => { const [id, callback] = [...state.timers][0]; state.timers.delete(id); callback(); await Promise.resolve(); };
  await tick(); assert.deepEqual(state.played, []);
  speaking = false;
  for (let waited = 0; waited < CHAT_ACTION_AFTER_SPEECH_MS; waited += CHAT_ACTION_SPEECH_POLL_MS) await tick();
  await Promise.resolve();
  assert.deepEqual(state.played, ['pout']);
  // Dropped by the next message.
  speaking = true;
  await host.perform('pout'); host.cancel();
  assert.equal(host.pending, false); assert.deepEqual(state.played, ['pout']);
  // A body action while she speaks goes at once.
  assert.equal((await host.perform('clap')).played, true);
});

// ---------------------------------------------------------------- the tool

function channel(options: { interconnect: boolean; handler?: IpcHandler | null; controls?: boolean } ) {
  const gene = fixture();
  const operations = new Map<string, IpcHandler>();
  if (options.handler !== null) operations.set('playChatAction', options.handler ?? ((_event, word) => gene.host.perform(word)));
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send() {} } });
  const bridge = createHostBridge({ version: () => '0', controls: () => options.controls === false ? null : window(11), pet: () => window(12), operations, admit: (guard, run) => { guard(); return run(); },
    importCharacterCard: async () => { throw new Error('x'); }, loadModel: async () => { throw new Error('x'); }, commitPetBoolean: async () => { throw new Error('x'); },
    commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); }, replyLatency: () => [], broadcast: () => {}, interconnected: () => options.interconnect });
  const notices: string[] = [];
  const registry = new AgentToolRegistry(createAppTools(bridge), { enabled: () => true, interconnect: () => options.interconnect, confirm: async () => { throw new Error('no dialog expected'); },
    notice: (_tool, title, detail) => notices.push(`${title}：${detail ?? ''}`), called: () => {} });
  return { registry, notices, gene };
}

test('play_her_action: only the seven words; anything else is refused before the stage is touched', async () => {
  const { registry, gene } = channel({ interconnect: true });
  for (const bad of ['hello-wave', 'shake', 'cheek-puff', 'speak', 'WAVE', '', 7, null, undefined, ['wave']])
    assert.equal(((await registry.call('play_her_action', { action: bad })) as any).error.code, 'invalid_input', String(bad));
  for (const args of [{}, { action: 'wave', text: '你好' }, { action: 'wave', userWords: undefined, say: 'hi' }])
    assert.equal(((await registry.call('play_her_action', args)) as any).error.code, 'invalid_input', JSON.stringify(args));
  assert.deepEqual(gene.state.played, []);
  const catalog = AGENT_TOOLS.find(tool => tool.name === 'play_her_action')!;
  assert.deepEqual((catalog.inputSchema as any).properties.action.enum, [...CHAT_ACTION_WORDS]);
  assert.equal(catalog.tier, 'reversible');
});

test('play_her_action: a good word reaches the stage exactly once, with a notice and no dialog, whether or not 三方互通 is on', async () => {
  for (const interconnect of [true, false]) {
    const { registry, notices, gene } = channel({ interconnect });
    const result: any = await registry.call('play_her_action', { action: 'clap' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual([result.result.action, result.result.played, result.result.status], ['clap', true, 'played']);
    assert.deepEqual(gene.state.played, ['clap']);
    assert.deepEqual(notices, ['让她做一个小动作：让她鼓掌']);
  }
});

test('play_her_action: a model that cannot do it returns played:false with what is missing, and the stage gets nothing', async () => {
  const noFingers = fixture({ profile: NO_FINGERS });
  const { registry, notices } = channel({ interconnect: false, handler: (_event, word) => noFingers.host.perform(word) });
  const result: any = await registry.call('play_her_action', { action: 'heart' });
  assert.equal(result.ok, true);
  assert.deepEqual([result.result.played, result.result.status], [false, 'cannot']);
  assert.match(result.result.note, /^没做：.*缺：.*手指/u);
  assert.ok(result.result.missing.length > 0);
  assert.deepEqual(noFingers.state.played, []);
  assert.equal(notices.length, 1, 'the user is still told Claude asked');
});

test('play_her_action: without the host operation or the control window it says so, and the operation is on the allow-list', async () => {
  assert.ok(AGENT_HOST_OPERATIONS.includes('playChatAction'));
  const old = channel({ interconnect: true, handler: null });
  assert.equal(((await old.registry.call('play_her_action', { action: 'nod' })) as any).error.code, 'unavailable');
  const hidden = channel({ interconnect: true, controls: false });
  assert.equal(((await hidden.registry.call('play_her_action', { action: 'nod' })) as any).error.code, 'unavailable');
  assert.deepEqual(hidden.gene.state.played, []);
});

// ---------------------------------------------------------------- the list and the handbook

test('registered in the capability list (direct, via play_her_action) and shown in the handbook\'s character page', () => {
  const entry = capability('her_small_actions')!;
  assert.ok(entry);
  assert.equal(entry.level, 'direct');
  assert.deepEqual((entry.channel as any).tool, 'play_her_action');
  assert.equal(CAPABILITIES.filter(item => item.id === 'her_small_actions').length, 1);
  for (const word of CHAT_ACTION_WORDS) assert.match(entry.values, new RegExp(word));
  const page = handbookCategory('characters', { interconnect: false, value: () => undefined });
  const shown = page.items.find(item => item.id === 'her_small_actions')!;
  assert.ok(shown, '翻手册 shows it');
  assert.equal(shown.needsUserWords, false);
  assert.match(JSON.stringify(shown.write), /play_her_action/u);
});

void MOTION_SCORE_STAMP;
