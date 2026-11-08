// I-024 模型体检 in the windows: each window's stage gets its card after a model load and again when the record changes; the
// first load runs the check once; the character page's 「这个模型能做什么」 rows, switches and 试一下; the pet answers; and the
// same table through the internal channel (I-025). Synthetic models, a temporary folder and a fake haiku; no Electron.
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { MODEL_CAPABILITY_IDS, deriveModelCapabilities, type CapabilityChoice, type ModelCapabilities, type ModelCapabilityId } from '../shared/model-capability';
import type { CapabilityPreviewResult, ModelCapabilityUpdate } from '../shared/model-capability-check';
import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_CHARACTER_UI_COPY } from '../shared/ui-copy.character.en';
import { capability } from '../shared/capabilities';
import { ModelCapabilityStore } from '../electron/model-capability-store';
import { CapabilityPreviewRelay, ModelCapabilityHost } from '../electron/model-capability-host';
import { AgentToolRegistry } from '../electron/agent-channel/registry';
import { createAppTools } from '../electron/agent-channel/app-tools';
import { AGENT_HOST_OPERATIONS, createHostBridge, type IpcHandler } from '../electron/agent-channel/bridge';
import { StageModelProfile, requestModelProfileCache } from '../src/stage/model-profile';
import { ModelCapabilitySync, bindCapabilityPreview, type ModelCapabilitySyncState } from '../src/ui/model-capability-sync';
import { CAPABILITY_ROWS, ModelCapabilityPanel } from '../src/ui/ModelCapabilityPanel';
import { modelAdaptation, type ModelAdaptation } from '../shared/model-adaptation';
import { buildModelProfile } from '../shared/model-profile';
import { JAPANESE_MORPHS, profileInput, toThreeMesh, toyModel, type ModelData, type ToyMorph } from './helpers/model-fixtures';

const KEY = 'c'.repeat(64);
/** Blink, blush and neck under names the alias lists do not know (as in tests/i024-model-capability-check.test.ts). */
function oddModel(): ModelData {
  const morphs: ToyMorph[] = [...JAPANESE_MORPHS.filter(morph => !['まばたき', 'ウィンク', 'ウィンク右', '照れ'].includes(morph.name)),
    { name: 'めとじ', region: 'eyes', amount: 0.31 }, { name: 'ほっぺ', region: 'cheeks', amount: 0.09 }];
  const data = toyModel({ morphs });
  data.bones.find(bone => bone.name === '首')!.name = 'くび';
  return data;
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

/** The real host over a temporary folder, a fake haiku, and one window's sync whose stage records every card it is given. */
async function world(options: { hostProfile?: 'same' | 'none'; available?: boolean; answer?: string } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i024-ui-'));
  const store = new ModelCapabilityStore(directory); await store.load();
  const asked: string[] = [], cards: (ModelCapabilities | null)[] = [], states: ModelCapabilitySyncState[] = [];
  let hostProfile: unknown = null, available = options.available ?? true;
  let sync!: ModelCapabilitySync;
  const host = new ModelCapabilityHost({ store, current: async () => ({ modelKey: KEY, modelUrl: 'local://odd' }),
    profile: async () => hostProfile === null ? null : JSON.parse(JSON.stringify(hostProfile)), available: () => available,
    ask: async prompt => { asked.push(prompt); return { text: options.answer ?? '{"morphs":{"blink":["めとじ","あ"],"shy":["ほっぺ"]},"bones":{"neck":["くび"]}}' }; },
    developerMode: () => false, broadcast: update => sync.receive(update) });
  sync = new ModelCapabilitySync({ api: { getModelCapabilities: () => host.view(), askModelCapabilityNames: (key, request) => host.ask(key, request),
    saveModelCapabilityCheck: (key, matches) => host.saveCheck(key, matches) }, apply: card => cards.push(card), onChange: state => states.push(state),
    retryDelaysMs: [1, 1], wait: async () => {} });
  const meshes: ReturnType<typeof toThreeMesh>[] = [];
  const load = (data: ModelData, cached?: unknown) => {
    const mesh = toThreeMesh(data); meshes.push(mesh);
    const profile = new StageModelProfile(mesh, { reviewed: false, cached });
    if (options.hostProfile !== 'none') hostProfile = profile.namedProfile; // the stage saves its profile right after building it
    sync.profileBuilt(profile);
    return profile;
  };
  return { host, store, sync, asked, cards, states, load, setAvailable: (value: boolean) => { available = value; },
    cleanup: async () => { sync.dispose(); for (const mesh of meshes) mesh.geometry.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('first load: the stage gets the card, haiku is asked once with only this model\'s names, what passed comes back on the card', async () => {
  const w = await world();
  try {
    const data = oddModel();
    w.load(data);
    assert.equal(w.cards.length, 0, 'nothing is sent to the stage in the middle of its own load');
    await w.sync.settled();
    assert.equal(w.asked.length, 1);
    for (const name of ['めとじ', 'ほっぺ', 'くび', '頭']) assert.ok(w.asked[0].includes(name), name);
    const card = w.cards.at(-1)!;
    assert.deepEqual([card.closeEyes.source, card.blush.source, card.sleepPose.source, card.mouth.source], ['haiku', 'haiku', 'haiku', 'name']);
    assert.equal(card.closeEyes.enabled, true);
    const record = w.store.get(KEY)!;
    assert.ok(record.checkedAt);
    assert.deepEqual(record.haiku, { morphs: { blink: data.morphs.findIndex(morph => morph.name === 'めとじ'), shy: data.morphs.findIndex(morph => morph.name === 'ほっぺ') },
      bones: { neck: data.bones.findIndex(bone => bone.name === 'くび') } }, 'the decoy あ for blink did not pass the vertex check');
    assert.equal(w.sync.state.waitingForReload, true, 'this load of the stage does not have them yet');
    // Next load, as the stage does it: the host's cached profile comes with the checked matches, and the stage uses them.
    const hostView = await w.host.view();
    const cache = await requestModelProfileCache({ getModelProfile: async () => ({ modelKey: KEY, modelUrl: 'local://odd', profile: hostView.profile,
      haiku: w.host.haikuFor(KEY) }) }, 'local://odd');
    const again = w.load(data, cache!.profile);
    await w.sync.settled();
    assert.equal(w.asked.length, 1, 'never asked twice');
    assert.equal(again.source, 'cache');
    assert.equal(again.indices.blink, record.haiku.morphs!.blink, 'the stage closes the eyes with the morph haiku found');
    assert.equal(w.cards.at(-1)!.closeEyes.source, 'haiku', 'the card still says how it was found');
    assert.equal(w.sync.state.waitingForReload, false);
  } finally { await w.cleanup(); }
});

test("the user's off reaches the stage at once (and in every window that shows this model); on cannot open what is missing", async () => {
  const w = await world();
  try {
    w.load(toyModel());
    await w.sync.settled();
    assert.equal(w.cards.at(-1)!.closeEyes.enabled, true);
    const before = w.cards.length;
    const pending = w.host.setChoice(KEY, 'closeEyes', 'off');
    await pending;
    assert.equal(w.cards.length, before + 1, 'one new card, straight from the broadcast');
    assert.deepEqual([w.cards.at(-1)!.closeEyes.choice, w.cards.at(-1)!.closeEyes.enabled], ['off', false]);
    assert.equal(w.cards.at(-1)!.blush.enabled, true, 'only that one');
    await w.host.setChoice(KEY, 'closeEyes', 'on');
    assert.equal(w.cards.at(-1)!.closeEyes.enabled, true);
    w.sync.receive({ modelKey: 'd'.repeat(64), record: { ...w.store.get(KEY)!, choices: { blush: 'off' } } } as ModelCapabilityUpdate);
    assert.equal(w.cards.at(-1)!.blush.enabled, true, 'another model\'s record is ignored');
  } finally { await w.cleanup(); }
});

test('a model with everything found asks nothing and is marked checked; a checked model is not checked again', async () => {
  const w = await world();
  try {
    w.load(toyModel()); await w.sync.settled();
    assert.equal(w.asked.length, 0);
    assert.ok(w.store.get(KEY)?.checkedAt);
    const stamp = w.store.get(KEY)!.checkedAt;
    w.load(toyModel()); await w.sync.settled();
    assert.equal(w.store.get(KEY)!.checkedAt, stamp);
    assert.equal(w.states.at(-1)!.checking, false);
  } finally { await w.cleanup(); }
});

test('Claude unavailable: not asked, not marked checked (the next load tries again); the names\' card still reaches the stage', async () => {
  const w = await world({ available: false });
  try {
    w.load(oddModel()); await w.sync.settled();
    assert.equal(w.asked.length, 0);
    assert.equal(w.store.get(KEY)?.checkedAt ?? null, null);
    assert.equal(w.cards.at(-1)!.closeEyes.detected, false);
    assert.equal(w.cards.at(-1)!.mouth.enabled, true);
    w.setAvailable(true);
    w.load(oddModel()); await w.sync.settled();
    assert.equal(w.asked.length, 1);
  } finally { await w.cleanup(); }
});

test('haiku answering nonsense changes nothing on the card, and is not asked again', async () => {
  const w = await world({ answer: '我觉得眨眼应该是 めとじ。' });
  try {
    w.load(oddModel()); await w.sync.settled();
    assert.equal(w.asked.length, 1);
    assert.equal(w.store.get(KEY)!.asked!.outcome, 'failed');
    assert.ok(w.store.get(KEY)!.checkedAt);
    assert.deepEqual([w.cards.at(-1)!.closeEyes.detected, w.cards.at(-1)!.blush.detected], [false, false]);
    w.load(oddModel()); await w.sync.settled();
    assert.equal(w.asked.length, 1);
  } finally { await w.cleanup(); }
});

test('when the host has no profile copy to match: the choices still apply, haiku is not asked and nothing is written', async () => {
  const w = await world({ hostProfile: 'none' });
  try {
    await w.store.update(KEY, record => ({ ...record, choices: { blush: 'off' } }));
    w.load(oddModel()); await w.sync.settled();
    assert.equal(w.asked.length, 0);
    assert.equal(w.store.get(KEY)!.checkedAt, null);
    assert.equal(w.cards.at(-1)!.blush.choice, 'off');
    assert.equal(w.sync.state.modelKey, null); assert.equal(w.sync.state.targetKey, KEY);
  } finally { await w.cleanup(); }
});

test('a model change in the middle of the check: the late answer does not reach the new model', async () => {
  const w = await world();
  try {
    w.load(oddModel());
    w.sync.modelCleared();
    await w.sync.settled();
    assert.equal(w.asked.length, 0, 'the check for a model no longer shown never starts');
    assert.deepEqual(w.cards, [], 'nothing reaches the stage for it');
    assert.equal(w.sync.state.loaded, false);
  } finally { await w.cleanup(); }
});

// ---------------------------------------------------------------- the character page

class Element {
  children: Element[] = []; parent: Element | null = null;
  id = ''; className = ''; textContent = ''; type = ''; checked = false; disabled = false; hidden = false;
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  onclick: (() => void) | null = null; onchange: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
function panel(card: ModelCapabilities | null, preview: CapabilityPreviewResult | Error = 'shown', adaptation: ModelAdaptation | null = null) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { createElement: (tag: string) => new Element(tag) } });
  const root = new Element('div'), choices: unknown[][] = [], previews: string[] = [], errors: string[] = [];
  const view = new ModelCapabilityPanel(root as unknown as HTMLElement, {
    preview: async id => { previews.push(id); if (preview instanceof Error) throw preview; return preview; },
    setChoice: async (...args) => { choices.push(args); }, onError: message => errors.push(message) });
  view.update({ modelKey: KEY, targetKey: KEY, card, record: null, checking: false, loaded: !!card, waitingForReload: false, adaptation });
  const rows = () => all(root).filter(node => node.dataset.capability);
  const of = (id: string) => { const row = rows().find(node => node.dataset.capability === id)!;
    return { row, toggle: all(row).find(node => node.dataset.modelCapability === 'switch')!, button: all(row).find(node => node.dataset.modelCapability === 'try')! }; };
  const status = () => all(root).find(node => node.className === 'model-capabilities-status')!.textContent;
  return { view, root, rows, of, status, choices, previews, errors, restore() {
    view.dispose(); if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else Reflect.deleteProperty(globalThis, 'document'); } };
}
/** The odd model's card as the names find it, with the user's choices. */
const toyCard = () => {
  const mesh = toThreeMesh(oddModel());
  try {
    const profile = new StageModelProfile(mesh, { reviewed: false }).namedProfile;
    return { card: async (choices: Partial<Record<ModelCapabilityId, CapabilityChoice>> = {}) => deriveModelCapabilities(profile, choices) };
  } finally { mesh.geometry.dispose(); }
};

test('「这个模型能做什么」: seven rows from the one table, each with its state, a switch and 试一下', async () => {
  const { card } = toyCard();
  const p = panel(await card());
  try {
    assert.deepEqual(p.rows().map(row => row.dataset.capability), [...MODEL_CAPABILITY_IDS]);
    assert.deepEqual(p.rows().map(row => all(row).find(node => node.tagName === 'strong')!.textContent),
      ['能闭眼', '能脸红', '有口型', '能做睡姿', '能做手势', '困的脸', '能流泪']);
    assert.match(all(p.of('mouth').row).find(node => node.className === 'model-capability-detail')!.textContent, /^有 · 名字认出/u);
    assert.match(all(p.of('closeEyes').row).find(node => node.className === 'model-capability-detail')!.textContent, /^缺眨眼表情 · /u, 'what is missing, exactly (T-213)');
    for (const id of MODEL_CAPABILITY_IDS) {
      const { toggle, button } = p.of(id);
      assert.equal(toggle.attributes.role, 'switch'); assert.equal(button.textContent, '试一下');
      assert.ok(/^[a-z0-9-]+$/u.test(toggle.id) && /^[a-z0-9-]+$/u.test(button.id), 'ids stay lowercase');
    }
    assert.deepEqual([p.of('mouth').toggle.checked, p.of('mouth').toggle.disabled], [true, false]);
    assert.deepEqual([p.of('closeEyes').toggle.checked, p.of('closeEyes').toggle.disabled], [false, true], 'what the model lacks cannot be turned on');
    // Registered for I-025 by their data attributes.
    assert.deepEqual(capability('model_capability_switch')?.controls, ['[data-model-capability=switch]']);
    assert.deepEqual(capability('model_capability_try')?.controls, ['[data-model-capability=try]']);
    assert.equal(CAPABILITY_ROWS.tears.title, '能流泪');
  } finally { p.restore(); }
});

test('the switch stores the choice for this model; 试一下 says what happened, and never asks the pet for what the model lacks', async () => {
  const { card } = toyCard();
  const p = panel(await card(), 'cannot');
  try {
    p.of('mouth').toggle.checked = false; p.of('mouth').toggle.onchange!(); await settle();
    assert.deepEqual(p.choices, [[KEY, 'mouth', 'off']]);
    assert.match(p.status(), /已关闭「有口型」/u);
    p.of('closeEyes').button.onclick!(); await settle();
    assert.deepEqual(p.previews, [], 'not sent');
    assert.match(p.status(), /这个模型做不了：能闭眼/u);
    p.of('mouth').button.onclick!(); await settle();
    assert.deepEqual(p.previews, ['mouth']);
    assert.match(p.status(), /还没准备好：有口型/u);
  } finally { p.restore(); }
  for (const [result, words] of [['shown', /已在桌宠上试了一下：有口型/u], ['pet-hidden', /桌宠没在显示/u]] as const) {
    const q = panel(await card(), result);
    try { q.of('mouth').button.onclick!(); await settle(); assert.match(q.status(), words); } finally { q.restore(); }
  }
  const off = panel(await card({ mouth: 'off' }), 'cannot');
  try { off.of('mouth').button.onclick!(); await settle(); assert.match(off.status(), /「有口型」关着/u); } finally { off.restore(); }
  const empty = panel(null);
  try {
    assert.match(empty.status(), /载入模型后/u);
    assert.ok(empty.rows().every(row => all(row).every(node => node.tagName === 'div' || node.tagName === 'label' || node.tagName === 'span'
      || node.tagName === 'strong' || node.tagName === 'small' || node.disabled)), 'nothing to press without a model');
  } finally { empty.restore(); }
});

test('the page in English uses the kept English copy', async () => {
  registerUiMessages({ en: ENGLISH_CHARACTER_UI_COPY, 'zh-CN': {} }); setUiLanguage('en');
  const { card } = toyCard();
  const p = panel(await card());
  try {
    const text = all(p.root).map(node => node.textContent).join('\n');
    assert.match(text, /What this model can do/u); assert.match(text, /Can close her eyes/u); assert.match(text, /Try it/u);
    assert.match(text, /Yes · found by name/u); assert.match(text, /Missing a blink expression/u);
  } finally { p.restore(); setUiLanguage('zh-CN'); }
});

test('T-213 她的动作 on this model: how many, which it cannot do and exactly what each lacks; a shared wrist name is said on 能做手势', async () => {
  // A toy body: no 上半身2 and no finger bones; plus a second bone named like the right wrist.
  const plain = toyModel({ pose: 'T', twist: true });
  const plainProfile = buildModelProfile(profileInput(plain));
  const p = panel(deriveModelCapabilities(plainProfile), 'shown', modelAdaptation(plainProfile));
  try {
    const block = all(p.root).find(node => node.id === 'model-capability-actions')!;
    // Universal skeleton step 1: the toy has no cheekPuff, mouthPucker or tongueOut, so the card now says so (the stage skips them too).
    // Skeleton step 2: no mouthPucker but "う": the pout counts as doable, as an approximation, said on its own line.
    assert.deepEqual(all(block).slice(1).map(node => node.textContent), ['她的动作：23 个里能做 16 个。', '做不了凑近看、鞠躬、道歉：缺胸（上半身2）',
      '做不了比心：缺左手手指、右手手指', '做不了指一指：缺右手手指', '做不了鼓腮：缺鼓腮的表情（cheekPuff）',
      '做不了吐舌头：缺吐舌的表情（tongueOut）', '撅嘴是近似的：没有嘟嘴的表情（mouthPucker），用口型“う”拼的，会轻一点。']);
    assert.equal(block.hidden, false);
  } finally { p.restore(); }
  const shared = toyModel({ pose: 'T', twist: true }), wrist = shared.bones.findIndex(bone => bone.name === '右手首');
  shared.bones.push({ ...shared.bones[wrist], position: [...shared.bones[wrist].position] as [number, number, number] });
  const sharedProfile = buildModelProfile(profileInput(shared));
  const q = panel(deriveModelCapabilities(sharedProfile), 'shown', modelAdaptation(sharedProfile));
  try {
    assert.equal(all(q.of('gesture').row).find(node => node.className === 'model-capability-detail')!.textContent, '缺右手腕（有重名骨骼） · 聊天时抬手比划、挥挥手');
    assert.deepEqual([q.of('gesture').toggle.checked, q.of('gesture').toggle.disabled], [false, true]);
    const lines = all(q.root).map(node => node.textContent);
    assert.ok(lines.includes('做不了打招呼、说再见、捂脸、遮嘴笑、张开手臂、抱抱、鼓掌、欢呼、叉腰、哈欠捂嘴、拿着吃：缺右手腕（有重名骨骼）'), lines.join('\n'));
    assert.ok(lines.includes('做不了指一指：缺右手腕（有重名骨骼）、右手手指'), 'every part a single action lacks, together');
  } finally { q.restore(); }
  registerUiMessages({ en: ENGLISH_CHARACTER_UI_COPY, 'zh-CN': {} }); setUiLanguage('en');
  const e = panel(deriveModelCapabilities(sharedProfile), 'shown', modelAdaptation(plainProfile));
  try {
    const text = all(e.root).map(node => node.textContent).join('\n');
    assert.match(text, /Missing right wrist \(shares its name with another bone\) · Hand gestures/u);
    assert.match(text, /Her actions: 16 of 23 can be done\./u);
    // Skeleton step 2: the pout is an approximation from "う", in English too.
    assert.match(text, /pout is an approximation: without a pucker shape \(mouthPucker\), it is built from the “う” mouth shape and looks a little lighter\./u);
    assert.match(text, /Cannot do lean in, bow, apology bow: missing chest \(upper body 2\)/u);
    assert.match(text, /Cannot do point: missing right-hand fingers/u);
  } finally { e.restore(); setUiLanguage('zh-CN'); }
});

test('the pet answers 试一下 with its own stage and reports back once', async () => {
  let listener: ((request: { requestId: string; id: any }) => void) | null = null;
  const reports: [string, boolean][] = [], asked: string[] = [];
  const stop = bindCapabilityPreview({ onModelCapabilityPreview: callback => { listener = callback; return () => { listener = null; }; },
    reportModelCapabilityPreview: async (requestId, ok) => { reports.push([requestId, ok]); } },
  () => ({ previewCapability: id => { asked.push(id); return id === 'blush'; } }));
  listener!({ requestId: 'r1', id: 'blush' }); listener!({ requestId: 'r2', id: 'tears' });
  await settle();
  assert.deepEqual(asked, ['blush', 'tears']); assert.deepEqual(reports, [['r1', true], ['r2', false]]);
  stop(); assert.equal(listener, null);
});

// ---------------------------------------------------------------- the internal channel (I-025)

test('the channel reads the same table, switches it through the page\'s own operation (with 撤回) and asks the pet to try', async () => {
  const w = await world();
  const relay = new CapabilityPreviewRelay({ id: () => 'p1', petSender: () => 12, timeoutMs: 50, send: request => { queueMicrotask(() => relay.report(12, request.requestId, true)); return true; } });
  try {
    w.load(oddModel()); await w.sync.settled();
    const handlers: Record<string, (...args: any[]) => unknown> = {
      getModelCapabilities: () => w.host.view(), setModelCapabilityChoice: (key, id, choice) => w.host.setChoice(key, id, choice),
      previewModelCapability: id => relay.request(id) };
    for (const name of Object.keys(handlers)) assert.ok(AGENT_HOST_OPERATIONS.includes(name), name);
    const senders = new Set<number>();
    const operations = new Map<string, IpcHandler>(Object.entries(handlers).map(([name, run]) => [name, (event: any, ...args: unknown[]) => { senders.add(event.sender.id); return run(...args); }]));
    const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send() {} } });
    const bridge = createHostBridge({ version: () => '0', controls: () => window(11), pet: () => window(12), operations, admit: (guard, run) => { guard(); return run(); },
      importCharacterCard: async () => { throw new Error('x'); }, loadModel: async () => { throw new Error('x'); }, commitPetBoolean: async () => { throw new Error('x'); },
      commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); }, replyLatency: () => [], broadcast: () => {}, interconnected: () => true });
    let undo: { run(guard: () => void): unknown } | undefined;
    const notices: string[] = [];
    const registry = new AgentToolRegistry(createAppTools(bridge), { enabled: () => true, interconnect: () => true, confirm: async () => true,
      notice: (_t, title, detail) => notices.push(`${title}：${detail ?? ''}`), called: (_summary, offer) => { undo = offer; } });
    const listed: any = await registry.call('list_model_capabilities', {});
    assert.ok(listed.ok);
    assert.deepEqual(listed.result.items.map((item: any) => [item.id, item.label, item.has, item.foundBy, item.on]).slice(0, 4),
      [['closeEyes', '能闭眼', true, 'haiku', true], ['blush', '能脸红', true, 'haiku', true], ['mouth', '有口型', true, 'name', true], ['sleepPose', '能做睡姿', true, 'haiku', true]]);
    assert.doesNotMatch(JSON.stringify(listed.result), /めとじ|くび|local:/u, 'no part names, no paths');
    // T-213: her actions by the stage's own rule, haiku's neck counted as on the card (the toy has no 上半身2 and no fingers).
    assert.deepEqual({ total: listed.result.actions.total, possible: listed.result.actions.possible, cannot: listed.result.actions.cannot },
      { total: 23, possible: 15, cannot: [{ actions: ['凑近看', '鞠躬', '道歉'], missing: ['胸（上半身2）'] }, { actions: ['比心'], missing: ['左手手指', '右手手指'] },
        { actions: ['指一指'], missing: ['右手手指'] },
        // Universal skeleton step 1: the face actions by the stage's face rule (this toy has no wink and none of the named shapes).
        // Step 2: the pout is an approximation from "う" (below); the wink lacks both eyes' own.
        { actions: ['鼓腮'], missing: ['鼓腮的表情（cheekPuff）'] },
        { actions: ['眨一只眼'], missing: ['单眼闭眼的表情（ウィンク）', '右眼单独闭的表情（ウィンク右）'] }, { actions: ['吐舌头'], missing: ['吐舌的表情（tongueOut）'] }] });
    assert.deepEqual(listed.result.actions.approximate, ['撅嘴：没有嘟嘴的表情（mouthPucker），用口型“う”拼的，会轻一点']);
    assert.deepEqual(listed.result.items.find((item: any) => item.id === 'gesture').missing, []);
    const off: any = await registry.call('set_model_capability', { id: 'blush', value: 'off' });
    assert.ok(off.ok, JSON.stringify(off));
    assert.equal(w.cards.at(-1)!.blush.enabled, false, 'the stage follows at once');
    assert.match(notices.at(-1)!, /关掉了「能脸红」/u);
    await undo!.run(() => {});
    assert.deepEqual(w.store.get(KEY)!.choices, {}, '撤回 goes back to following what was detected');
    assert.equal(w.cards.at(-1)!.blush.enabled, true);
    assert.equal(((await registry.call('set_model_capability', { id: 'tears', value: 'loud' })) as any).error.code, 'invalid_input');
    const tried: any = await registry.call('try_model_capability', { id: 'closeEyes' });
    assert.equal(tried.result.result, 'shown');
    assert.deepEqual([...senders], [11], 'always as the control window\'s own operations');
  } finally { await w.cleanup(); }
});

test('the channel cannot turn on what the model lacks', async () => {
  const w = await world({ answer: '{}' });
  try {
    w.load(oddModel()); await w.sync.settled();
    const operations = new Map<string, IpcHandler>([['getModelCapabilities', () => w.host.view()],
      ['setModelCapabilityChoice', (_event: any, key: string, id: any, choice: any) => w.host.setChoice(key, id, choice)]]);
    const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send() {} } });
    const bridge = createHostBridge({ version: () => '0', controls: () => window(11), pet: () => window(12), operations, admit: (guard, run) => { guard(); return run(); },
      importCharacterCard: async () => { throw new Error('x'); }, loadModel: async () => { throw new Error('x'); }, commitPetBoolean: async () => { throw new Error('x'); },
      commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); }, replyLatency: () => [], broadcast: () => {}, interconnected: () => true });
    const registry = new AgentToolRegistry(createAppTools(bridge), { enabled: () => true, interconnect: () => true, confirm: async () => true, notice: () => {}, called: () => {} });
    const refused: any = await registry.call('set_model_capability', { id: 'closeEyes', value: 'on' });
    assert.equal(refused.error.code, 'unavailable');
    assert.match(refused.error.message, /打不开/u);
    assert.deepEqual(w.store.get(KEY)!.choices, {});
  } finally { await w.cleanup(); }
});
