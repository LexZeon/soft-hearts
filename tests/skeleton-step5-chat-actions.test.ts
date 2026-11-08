/**
 * Universal skeleton step 5 (docs/claude/2026-11-06-skeleton-step5.md): five body actions and two face shapes join the words she
 * may pick in a reply's state tail, only where this model can do them, and her pick is one cue the stage may still refuse.
 * Gene and Gene-derived data only (no other model, nothing of the user's, no PMX bytes written), and no real Claude call.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildModelProfile } from '../shared/model-profile';
import { HER_ACTION_SPECS, herActionSupport, type HerActionId, type HerActionPlayResult } from '../shared/her-actions';
import { CHAT_ACTION_OF, CHAT_ACTION_WORDS, chatActionAllowed, offeredChatActions, type ChatActionWord } from '../shared/chat-actions';
import { MOTION_SCORE_STAMP, type MotionFitRecord } from '../shared/motion-fit-record';
import { CHAT_GESTURE_SENTENCE_BEFORE, MoodReplyProtocol, chatGestureSentence } from '../electron/mood-chat';
import { ChatActionHost, CHAT_ACTION_AFTER_SPEECH_MS, CHAT_ACTION_SPEECH_POLL_MS, CHAT_ACTION_SPEECH_WAIT_MS } from '../electron/chat-actions-host';
import { CompanionService, type CompanionTurn } from '../electron/companion';
import type { ModelCapabilityView } from '../shared/model-capability-check';
import type { ProviderConfig } from '../shared/contracts';
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
const supportOf = (data: ModelData) => herActionSupport(profileOf(data));

// ---------------------------------------------------------------- which words a model offers

test('Gene offers all seven; the list is the closed table, each word mapped to its pinned action', () => {
  assert.deepEqual(CHAT_ACTION_WORDS, ['wave', 'nod', 'tilt', 'heart', 'clap', 'wink', 'pout']);
  assert.deepEqual(Object.values(CHAT_ACTION_OF), ['hello-wave', 'nod', 'tilt', 'two-hand-heart', 'clap', 'wink', 'pout']);
  for (const action of Object.values(CHAT_ACTION_OF)) assert.ok(HER_ACTION_SPECS[action], action);
  assert.deepEqual(offeredChatActions({ support: herActionSupport(GENE_PROFILE) }), [...CHAT_ACTION_WORDS]);
  assert.deepEqual(offeredChatActions(null), [], 'no model: nothing');
  assert.deepEqual(offeredChatActions({ support: null }), [], 'no profile yet: nothing');
});

test('a model that cannot do one does not offer it: no fingers (no heart), no wink shape, no mouth shapes, no head', () => {
  const noFingers = supportOf(geneData(data => { hideBones(data.bones as never, name => /(親指|人指|中指|薬指|小指)/.test(name)); return data; }));
  assert.equal(noFingers['two-hand-heart'].ok, false);
  assert.deepEqual(offeredChatActions({ support: noFingers }), ['wave', 'nod', 'tilt', 'clap', 'wink', 'pout']);
  const winkless = supportOf(geneData(data => ({ ...data, morphs: data.morphs.filter(morph => !/ウィンク|ｳｨﾝｸ|まば[左右]|wink|blink|eye_close/i.test(morph.name)) })));
  assert.ok(!offeredChatActions({ support: winkless }).includes('wink'), JSON.stringify(winkless.wink));
  const faceless = supportOf(geneData(data => ({ ...data, morphs: [] })));
  assert.deepEqual(offeredChatActions({ support: faceless }), ['wave', 'nod', 'tilt', 'heart', 'clap'], 'no morphs: neither face shape');
  const headless = supportOf(geneData(data => { hideBones(data.bones as never, name => name === '首' || name === '頭'); return data; }));
  assert.ok(!offeredChatActions({ support: headless }).some(word => word === 'nod' || word === 'tilt'));
});

test('an approximation counts as doable (撅嘴 from "う" on a model without a pucker), as on the character page', () => {
  const support = supportOf(geneData(data => ({ ...data, morphs: data.morphs.filter(morph => !/mouthPucker|pucker/i.test(morph.name)) })));
  assert.equal(support.pout.ok, true);
  assert.ok(support.pout.approximate?.length, 'built from its own shapes');
  assert.ok(offeredChatActions({ support }).includes('pout'));
});

test('a stored fit score that holds an action back takes it away, only when it was scored by this conversion and check', () => {
  const support = herActionSupport(GENE_PROFILE);
  const fits = (stamp: string, action: HerActionId): MotionFitRecord => ({ version: 1, stamp, input: `fit:${'a'.repeat(64)}`, motions: [{ sha256: HER_ACTION_SPECS[action].sha256,
    pack: 'soft-hearts-actions', motion: action, status: 'hidden', basis: 'sampled', samples: 20, issues: ['contact: hands miss each other (palm)'], adjustments: [], lost: [] }] });
  assert.ok(!offeredChatActions({ support, fits: fits(MOTION_SCORE_STAMP, 'clap'), stamp: MOTION_SCORE_STAMP }).includes('clap'));
  assert.ok(offeredChatActions({ support, fits: fits('r0.0-f0-c0-0000000000000000', 'clap'), stamp: MOTION_SCORE_STAMP }).includes('clap'), 'another stamp: not known, not used');
  const adjusted: MotionFitRecord = { ...fits(MOTION_SCORE_STAMP, 'clap'), motions: [{ ...fits(MOTION_SCORE_STAMP, 'clap').motions[0], status: 'adjusted' }] };
  assert.ok(offeredChatActions({ support, fits: adjusted, stamp: MOTION_SCORE_STAMP }).includes('clap'), 'adjusted still plays');
});

test('the character page switches: 有口型 off takes 撅嘴, 能闭眼 off the wink, 能做手势 off the arm actions (not the head)', () => {
  const support = herActionSupport(GENE_PROFILE);
  assert.ok(!offeredChatActions({ support, choices: { mouth: 'off' } }).includes('pout'));
  assert.ok(!offeredChatActions({ support, choices: { closeEyes: 'off' } }).includes('wink'));
  assert.deepEqual(offeredChatActions({ support, choices: { gesture: 'off' } }), ['nod', 'tilt', 'wink', 'pout']);
  assert.deepEqual(offeredChatActions({ support, choices: { gesture: 'on', mouth: 'on' } }), [...CHAT_ACTION_WORDS]);
});

test('her mood gates a pick as the talking gesture: expressions on, idle, the card\'s intensity above zero for that kind', () => {
  const view = (expressions: boolean, phase: string, posture: number, expression: number) => ({ expressions, snapshot: { phase, intensity: { posture, expression } } });
  assert.equal(chatActionAllowed('clap', view(true, 'idle', 50, 50)), true);
  assert.equal(chatActionAllowed('clap', view(false, 'idle', 50, 50)), false);
  assert.equal(chatActionAllowed('clap', view(true, 'touch', 50, 50)), false);
  assert.equal(chatActionAllowed('clap', view(true, 'idle', 0, 50)), false);
  assert.equal(chatActionAllowed('wink', view(true, 'idle', 0, 50)), true, 'a face shape follows the expression intensity');
  assert.equal(chatActionAllowed('pout', view(true, 'idle', 50, 0)), false);
});

// ---------------------------------------------------------------- the tail she reads and writes

const tail = (protocol: MoodReplyProtocol, gesture: unknown) =>
  `好呀。\n${protocol.start}${JSON.stringify({ context: 'positive', delta: { D: 2 }, reason: '测试', confidence: 0.9, gesture })}${protocol.end}`;
function run(actions: readonly ChatActionWord[] | undefined, gesture: unknown) {
  let shown = '';
  const protocol = new MoodReplyProtocol(text => { shown += text; }, actions ? { actions } : {});
  protocol.push(tail(protocol, gesture));
  return { protocol, appraisal: protocol.finish(true), shown };
}

test('nothing offered: the instruction is exactly the old one; offered: only those words, each with its meaning', () => {
  const plain = new MoodReplyProtocol(() => {}).instruction();
  assert.ok(plain.includes(CHAT_GESTURE_SENTENCE_BEFORE));
  assert.equal(chatGestureSentence([]), CHAT_GESTURE_SENTENCE_BEFORE);
  assert.equal(new MoodReplyProtocol(() => {}, { actions: [] }).instruction().replace(/[a-f0-9]{32}/g, 'N'), plain.replace(/[a-f0-9]{32}/g, 'N'));
  const all = new MoodReplyProtocol(() => {}, { actions: [...CHAT_ACTION_WORDS] }).instruction();
  assert.ok(!all.includes(CHAT_GESTURE_SENTENCE_BEFORE));
  assert.ok(all.includes('none/explain/upbeat/consider/wave/nod/tilt/heart/clap/wink/pout'));
  for (const meaning of ['挥手打招呼', '点头', '歪头', '双手比心', '鼓掌', '眨一只眼', '撅嘴']) assert.ok(all.includes(meaning), meaning);
  const some = new MoodReplyProtocol(() => {}, { actions: ['pout', 'nod'] }).instruction();
  assert.ok(some.includes('none/explain/upbeat/consider/nod/pout：'), 'table order, only the offered ones');
  assert.ok(!/wave|heart|clap|wink|比心|鼓掌/.test(some));
  // No count, no trigger: nothing in the sentence says how often or when.
  assert.ok(!/每\d|次|最多|必须/.test(chatGestureSentence([...CHAT_ACTION_WORDS])));
  // The added length (the first-token A/B measured it).
  assert.ok(chatGestureSentence([...CHAT_ACTION_WORDS]).length - CHAT_GESTURE_SENTENCE_BEFORE.length <= 110);
});

test('her pick: an offered word is kept (her talking gesture says none, the mood stands); one not offered does nothing but keeps the mood', () => {
  const picked = run(['clap', 'pout'], 'clap');
  assert.equal(picked.protocol.chatAction(), 'clap');
  assert.equal(picked.appraisal?.gesture, 'none');
  assert.deepEqual(picked.appraisal?.delta, { D: 2 });
  assert.equal(picked.shown, '好呀。', 'the tail is not shown');
  const notOffered = run(['nod'], 'clap');
  assert.equal(notOffered.protocol.chatAction(), null);
  assert.ok(notOffered.appraisal, 'the tail is not thrown away for it');
  assert.equal(notOffered.appraisal?.gesture, 'none');
  const nothingOffered = run(undefined, 'heart');
  assert.equal(nothingOffered.protocol.chatAction(), null);
  assert.equal(nothingOffered.appraisal?.context, 'positive');
  for (const gesture of ['explain', 'none', undefined]) {
    const plain = run([...CHAT_ACTION_WORDS], gesture);
    assert.equal(plain.protocol.chatAction(), null);
    assert.equal(plain.appraisal?.gesture, gesture ?? 'none');
  }
  assert.equal(run([...CHAT_ACTION_WORDS], 'hug').appraisal, null, 'an unknown value still rejects the tail as before');
  assert.equal(run([...CHAT_ACTION_WORDS], '../clap.vmd').appraisal, null);
});

// ---------------------------------------------------------------- the host: offered list and the one cue

function hostFixture(options: { speaking?: () => boolean; play?: (action: HerActionId) => Promise<HerActionPlayResult>; view?: () => ModelCapabilityView | null } = {}) {
  const state = { path: 'C:/models/gene.pmx' as string | null, played: [] as HerActionId[], logs: [] as string[], timers: new Map<number, () => void>(), serial: 0 };
  const view = options.view ?? (() => ({ modelKey: 'k'.repeat(64), modelUrl: '', profile: GENE_PROFILE, record: null }));
  const host = new ChatActionHost({
    modelPath: () => state.path,
    read: async () => { const value = view(); return value ? { view: value, fits: null } : null; },
    play: options.play ?? (async action => { state.played.push(action); return { status: 'played', missing: [], detail: '' }; }),
    speaking: options.speaking ?? (() => false), developerMode: () => true, log: line => state.logs.push(line),
    timers: { set: (callback, ms) => { assert.equal(ms, CHAT_ACTION_SPEECH_POLL_MS); const id = ++state.serial; state.timers.set(id, callback); return id; }, clear: id => { state.timers.delete(id as number); } },
  });
  const fire = () => { const [id, callback] = [...state.timers][0] ?? []; assert.ok(callback, 'a timer is waiting'); state.timers.delete(id!); callback!(); };
  return { host, state, fire };
}

test('host: the list is per model, read in the background; a new model offers nothing until its own check is read', async () => {
  const { host, state } = hostFixture();
  assert.deepEqual(host.offered(), [], 'not read yet');
  await host.refresh();
  assert.deepEqual(host.offered(), [...CHAT_ACTION_WORDS]);
  state.path = 'C:/models/other.pmx';
  assert.deepEqual(host.offered(), [], 'the model changed: nothing until read');
  await host.refresh();
  assert.deepEqual(host.offered(), [...CHAT_ACTION_WORDS]);
  state.path = null;
  await host.refresh();
  assert.deepEqual(host.offered(), []);
  const failing = hostFixture({ view: () => { throw new Error('read failed'); } });
  await failing.host.refresh();
  assert.deepEqual(failing.host.offered(), [], 'a failed read offers nothing');
});

test('host: a body action or the wink is one cue at once; the stage\'s answer only reaches the developer log', async () => {
  const { host, state } = hostFixture({ speaking: () => true });
  host.request('clap'); host.request('wink'); host.request('nod');
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(state.played, ['clap', 'wink', 'nod']);
  assert.equal(host.pending, false);
  assert.ok(state.logs.every(line => /^\[她的小动作\] 回复里选了 \w+：played$/.test(line)), JSON.stringify(state.logs));
  const refused = hostFixture({ play: async () => ({ status: 'missing', missing: ['左手手指'], detail: '' }) });
  refused.host.request('heart');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refused.state.logs.at(-1), '[她的小动作] 回复里选了 heart：missing', 'skipped quietly');
  const throwing = hostFixture({ play: () => Promise.reject(new Error('no window')) });
  throwing.host.request('wave');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(throwing.state.logs.at(-1), '[她的小动作] 回复里选了 wave：error');
});

test('host: 撅嘴 waits until she has been quiet for a moment after speaking; a new message drops it; it gives up after a long speech', async () => {
  let speaking = true;
  const { host, state, fire } = hostFixture({ speaking: () => speaking });
  host.request('pout');
  assert.equal(host.pending, true); assert.deepEqual(state.played, []);
  fire(); fire(); assert.deepEqual(state.played, [], 'still speaking');
  speaking = false;
  for (let quiet = CHAT_ACTION_SPEECH_POLL_MS; quiet < CHAT_ACTION_AFTER_SPEECH_MS; quiet += CHAT_ACTION_SPEECH_POLL_MS) fire();
  assert.deepEqual(state.played, []);
  speaking = true; fire(); speaking = false; // a pause between two sentences does not count
  for (let quiet = 0; quiet < CHAT_ACTION_AFTER_SPEECH_MS; quiet += CHAT_ACTION_SPEECH_POLL_MS) fire();
  assert.deepEqual(state.played, ['pout']); assert.equal(host.pending, false);

  speaking = true; host.request('pout'); assert.equal(host.pending, true);
  host.cancel(); assert.equal(host.pending, false); assert.equal(state.timers.size, 0);
  host.request('pout'); host.request('nod');
  await Promise.resolve();
  assert.deepEqual(state.played, ['pout', 'nod'], 'a later pick replaces the waiting one');
  assert.equal(state.timers.size, 0);

  host.request('pout');
  for (let waited = 0; waited < CHAT_ACTION_SPEECH_WAIT_MS; waited += CHAT_ACTION_SPEECH_POLL_MS) fire();
  assert.equal(host.pending, false); assert.equal(state.timers.size, 0);
  assert.deepEqual(state.played, ['pout', 'nod']);
  assert.match(state.logs.at(-1)!, /pout：dropped: still speaking/);
  const quiet = hostFixture();
  quiet.host.request('pout');
  await Promise.resolve();
  assert.deepEqual(quiet.state.played, ['pout'], 'not speaking (voice off): at once');
});

// ---------------------------------------------------------------- the companion: offered words in, one pick out

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'https://synthetic.example/v1', model: 'fixture' };
async function companion(t: TestContext, offered: readonly ChatActionWord[]) {
  const target = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-chat-actions-'));
  const service = new CompanionService(target, () => {});
  t.after(async () => { await service.flush().catch(() => {}); await rm(target, { recursive: true, force: true }); });
  await service.load(); await service.context('gene', provider, 'Gene');
  const picks: ChatActionWord[] = [];
  let cancels = 0;
  service.setChatActions({ offered: () => offered, request: word => { picks.push(word); }, cancel: () => { cancels++; } });
  const say = async (id: string, gesture: unknown, status: 'complete' | 'stopped' = 'complete') => {
    const turn: CompanionTurn = await service.begin(id, '我今天面试过了！', 'Gene', () => {});
    const opening = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0]; assert.ok(opening);
    turn.push('delta', `真好！\n${opening}${JSON.stringify({ context: 'positive', delta: {}, reason: '测试', confidence: 0.9, gesture })}${opening.replace('<', '</')}`);
    await turn.finish(status);
    return turn;
  };
  return { service, picks, say, cancels: () => cancels };
}

test('companion: the words this model offers are in the turn; her pick goes out once; none, a stop, or expressions off send nothing', async t => {
  const h = await companion(t, ['clap', 'nod']);
  const first = await h.say('a1', 'clap');
  assert.ok(first.persona.includes('none/explain/upbeat/consider/nod/clap：'));
  assert.deepEqual(h.picks, ['clap']);
  await first.finish('complete');
  assert.deepEqual(h.picks, ['clap'], 'one reply, one pick');
  assert.equal(h.cancels(), 1, 'a new message drops a pick still waiting');
  await h.say('a2', 'none'); await h.say('a3', 'explain'); await h.say('a4', 'heart');
  assert.deepEqual(h.picks, ['clap'], 'none, a talking gesture, or a word not offered: nothing');
  await h.say('a5', 'nod', 'stopped');
  assert.deepEqual(h.picks, ['clap'], 'a stopped reply: nothing');
  h.service.mood.setExpressions(false);
  await h.say('a6', 'nod');
  assert.deepEqual(h.picks, ['clap'], 'her expressions off: nothing');
  // The host's list is read in the background; the turn starts the read, so even the first message after start offers the words.
  const fresh = hostFixture();
  const first2 = await companion(t, []);
  first2.service.setChatActions(fresh.host);
  const opened = await first2.say('c1', 'tilt');
  assert.ok(opened.persona.includes('/wave/nod/tilt/heart/clap/wink/pout：'), 'the first turn already has the words');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fresh.state.played, ['tilt']);
  const empty = await companion(t, []);
  const turn = await empty.say('b1', 'clap');
  assert.ok(turn.persona.includes(CHAT_GESTURE_SENTENCE_BEFORE), 'nothing offered: the old words');
  assert.deepEqual(empty.picks, []);
});
