// I-024 模型体检 in the host: the per-model record file, haiku asked at most once (names only), the page's checked matches,
// the user's on/off, and 试一下 relayed to the pet. Temporary directories and a fake haiku only; no Electron, no real Claude.
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { ModelCapabilityStore, MODEL_CAPABILITIES_FILE } from '../electron/model-capability-store';
import { CapabilityPreviewRelay, ModelCapabilityHost } from '../electron/model-capability-host';
import { MODEL_CHECK_SYSTEM_PROMPT, type ModelCapabilityUpdate, type ModelCheckRequest } from '../shared/model-capability-check';

const KEY = 'a'.repeat(64), OTHER = 'b'.repeat(64);
async function folder() { return mkdtemp(path.join(os.tmpdir(), 'soft-i024-')); }
const REQUEST: ModelCheckRequest = { names: { morphs: ['あ', 'めとじ', 'ほっぺ'], bones: ['頭', 'くび'] }, wanted: { morphs: ['blink', 'shy'], bones: ['neck'] } };

test('the record file: written atomically, read back, and a missing file is simply empty', async () => {
  const directory = await folder();
  try {
    const store = new ModelCapabilityStore(directory, { now: () => 1000 });
    await store.load();
    assert.equal(store.get(KEY), null);
    const { record, changed } = await store.update(KEY, before => ({ ...before, choices: { closeEyes: 'off' } }));
    assert.equal(changed, true);
    assert.deepEqual(record.choices, { closeEyes: 'off' });
    assert.equal((await store.update(KEY, before => before)).changed, false, 'the same record is not written again');
    const again = new ModelCapabilityStore(directory); await again.load();
    assert.deepEqual(again.get(KEY)?.choices, { closeEyes: 'off' });
    assert.deepEqual((await readdir(directory)).sort(), [MODEL_CAPABILITIES_FILE], 'no temporary file is left behind');
    await assert.rejects(store.update('not-a-hash', before => before));
    await assert.rejects(store.update(KEY, before => ({ ...before, choices: { tail: 'on' } as never })), /不正确/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a broken file does not crash: it counts as no records, and its bytes are kept aside before the first new write', async () => {
  const directory = await folder();
  try {
    const file = path.join(directory, MODEL_CAPABILITIES_FILE), broken = '{"version":1,"models":[{"modelKey":';
    await writeFile(file, broken);
    const store = new ModelCapabilityStore(directory, { now: () => Date.UTC(2026, 10, 4, 8) });
    await store.load();
    assert.equal(store.get(KEY), null);
    assert.equal(await readFile(file, 'utf8'), broken, 'loading never touches it');
    await store.update(KEY, before => ({ ...before, choices: { blush: 'off' } }));
    assert.ok(store.preservedAs);
    assert.equal(await readFile(store.preservedAs!, 'utf8'), broken, 'the original bytes are kept');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).models[0].record.choices, { blush: 'off' });
    // One bad row among good ones: the good ones are read; the file is still kept aside before it is rewritten.
    const mixed = JSON.stringify({ version: 1, models: [{ modelKey: OTHER, record: { nonsense: true } }, JSON.parse(await readFile(file, 'utf8')).models[0]] });
    await writeFile(file, mixed);
    const second = new ModelCapabilityStore(directory, { now: () => Date.UTC(2026, 10, 4, 9) }); await second.load();
    assert.deepEqual(second.get(KEY)?.choices, { blush: 'off' }); assert.equal(second.get(OTHER), null);
    await second.update(KEY, before => ({ ...before, choices: {} }));
    assert.equal(await readFile(second.preservedAs!, 'utf8'), mixed);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('when the broken file cannot be kept aside, it is never overwritten (records stay in memory for this session)', async () => {
  const directory = await folder();
  try {
    const file = path.join(directory, MODEL_CAPABILITIES_FILE);
    await writeFile(file, 'not json');
    const store = new ModelCapabilityStore(directory, { copy: async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } });
    await store.load();
    const { record } = await store.update(KEY, before => ({ ...before, choices: { tears: 'off' } }));
    assert.deepEqual(record.choices, { tears: 'off' });
    assert.deepEqual(store.get(KEY)?.choices, { tears: 'off' });
    assert.equal(await readFile(file, 'utf8'), 'not json');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** The host over a real store in a temporary folder, a fake haiku and the current model's key. */
async function host(options: { answer?: (prompt: string, system: string, signal: AbortSignal) => Promise<{ text: string }>; available?: () => boolean;
  developer?: boolean; timeoutMs?: number } = {}) {
  const directory = await folder();
  const store = new ModelCapabilityStore(directory); await store.load();
  const asked: { prompt: string; system: string }[] = [], broadcasts: ModelCapabilityUpdate[] = [], logs: string[] = [];
  let current: string | null = KEY;
  const capabilities = new ModelCapabilityHost({ store, current: async () => ({ modelKey: current, modelUrl: 'local://model' }), profile: async () => null,
    available: options.available ?? (() => true), developerMode: () => options.developer === true, log: line => logs.push(line),
    broadcast: update => broadcasts.push(update), timeoutMs: options.timeoutMs,
    ask: async (prompt, system, signal) => { asked.push({ prompt, system }); return (options.answer ?? (async () => ({ text: '{"morphs":{"blink":["めとじ"]},"bones":{"neck":["くび"]}}' })))(prompt, system, signal); } });
  return { capabilities, store, asked, broadcasts, logs, switchTo: (key: string | null) => { current = key; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('haiku sees only the part names and the slots, with its own system prompt; anything else a page sends is dropped', async () => {
  const h = await host();
  try {
    const page = { ...REQUEST, chat: '今天想你了', names: { ...REQUEST.names, diary: ['昨天的日记'] } };
    const result = await h.capabilities.ask(KEY, page);
    assert.equal(result.status, 'asked');
    assert.deepEqual(result.candidates, { morphs: { blink: ['めとじ'] }, bones: { neck: ['くび'] } });
    assert.equal(h.asked.length, 1);
    assert.equal(h.asked[0].system, MODEL_CHECK_SYSTEM_PROMPT);
    for (const secret of ['想你', '日记', 'local://']) assert.equal(h.asked[0].prompt.includes(secret), false, secret);
    for (const name of [...REQUEST.names.morphs, ...REQUEST.names.bones]) assert.ok(h.asked[0].prompt.includes(JSON.stringify(name).slice(1, -1)), name);
    await assert.rejects(h.capabilities.ask(OTHER, REQUEST), /模型已切换/u, 'only for the model shown now');
  } finally { await h.cleanup(); }
});

test('each model is asked once: again, at the same time, after a failure, after a non-JSON answer — the stored answer comes back', async () => {
  let release!: () => void;
  const h = await host({ answer: () => new Promise(resolve => { release = () => resolve({ text: '{"morphs":{"shy":["ほっぺ"]}}' }); }) });
  try {
    const first = h.capabilities.ask(KEY, REQUEST), second = h.capabilities.ask(KEY, REQUEST);
    await new Promise(resolve => setImmediate(resolve));
    release();
    assert.deepEqual([(await first).status, (await second).status], ['asked', 'asked']);
    assert.equal(h.asked.length, 1, 'two windows at once: one question');
    assert.deepEqual(await h.capabilities.ask(KEY, REQUEST), { status: 'stored', candidates: { morphs: { shy: ['ほっぺ'] }, bones: {} } });
    assert.equal(h.asked.length, 1);
  } finally { await h.cleanup(); }
  for (const answer of [async () => { throw new Error('offline'); }, async () => ({ text: '好的，我看看。眨眼大概是 めとじ' })]) {
    const failing = await host({ answer });
    try {
      assert.deepEqual(await failing.capabilities.ask(KEY, REQUEST), { status: 'failed', candidates: null });
      assert.equal(failing.store.get(KEY)?.asked?.outcome, 'failed', 'the failure is remembered');
      assert.deepEqual(failing.store.get(KEY)?.haiku, {}, 'and nothing changes on the card');
      assert.deepEqual(await failing.capabilities.ask(KEY, REQUEST), { status: 'stored', candidates: null });
      assert.equal(failing.asked.length, 1, 'never asked again');
    } finally { await failing.cleanup(); }
  }
});

test('a haiku that never answers times out as a failure; Claude unavailable means it is not asked and nothing is recorded', async () => {
  const slow = await host({ timeoutMs: 20, answer: (_p, _s, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  try {
    assert.deepEqual(await slow.capabilities.ask(KEY, REQUEST), { status: 'failed', candidates: null });
    assert.equal(slow.store.get(KEY)?.asked?.outcome, 'failed');
  } finally { await slow.cleanup(); }
  let available = false;
  const offline = await host({ available: () => available });
  try {
    assert.deepEqual(await offline.capabilities.ask(KEY, REQUEST), { status: 'unavailable', candidates: null });
    assert.equal(offline.asked.length, 0);
    assert.equal(offline.store.get(KEY), null, 'nothing recorded, so the next load asks once Claude is back');
    available = true;
    assert.equal((await offline.capabilities.ask(KEY, REQUEST)).status, 'asked');
    assert.equal(offline.asked.length, 1);
  } finally { await offline.cleanup(); }
});

test('the page reports what passed: only slots haiku named, the check is marked done, both windows hear it; the dev line has no names', async () => {
  const h = await host({ developer: true });
  try {
    await h.capabilities.ask(KEY, REQUEST);
    await assert.rejects(h.capabilities.saveCheck(KEY, { morphs: { shy: 4 } }), /haiku/u, 'shy was not one of haiku\'s answers');
    await assert.rejects(h.capabilities.saveCheck(KEY, { morphs: { blink: -1 } }));
    const record = await h.capabilities.saveCheck(KEY, { morphs: { blink: 1 }, bones: { neck: 1 } });
    assert.deepEqual(record.haiku, { morphs: { blink: 1 }, bones: { neck: 1 } });
    assert.ok(record.checkedAt);
    assert.deepEqual(h.broadcasts.map(update => update.modelKey), [KEY]);
    assert.deepEqual(h.capabilities.haikuFor(KEY), { morphs: { blink: 1 }, bones: { neck: 1 } }, 'sent with the cached profile on the next load');
    assert.equal(h.logs.length, 1);
    assert.match(h.logs[0], /问了 3 项，对上 2 项，\d+ 毫秒/u);
    for (const name of ['めとじ', 'くび', 'blink']) assert.equal(h.logs[0].includes(name), false, name);
    await h.capabilities.saveCheck(KEY, { morphs: { blink: 1 }, bones: { neck: 1 } });
    assert.equal(h.broadcasts.length, 1, 'the second window reporting the same result changes nothing');
    assert.equal(h.logs.length, 1);
  } finally { await h.cleanup(); }
  const quiet = await host({ developer: false });
  try {
    await quiet.capabilities.ask(KEY, REQUEST); await quiet.capabilities.saveCheck(KEY, {});
    assert.deepEqual(quiet.logs, [], 'no line outside developer mode');
    assert.equal(quiet.capabilities.haikuFor(KEY), null, 'nothing matched: nothing to send');
  } finally { await quiet.cleanup(); }
});

test("the user's on/off is stored per model and broadcast at once; null follows what was detected again", async () => {
  const h = await host();
  try {
    let record = await h.capabilities.setChoice(KEY, 'closeEyes', 'off');
    assert.deepEqual(record.choices, { closeEyes: 'off' });
    assert.deepEqual(h.broadcasts.at(-1), { modelKey: KEY, record });
    record = await h.capabilities.setChoice(KEY, 'closeEyes', null);
    assert.deepEqual(record.choices, {});
    await assert.rejects(h.capabilities.setChoice(KEY, 'wings', 'on'), /不正确/u);
    await assert.rejects(h.capabilities.setChoice(KEY, 'blush', 'maybe'), /不正确/u);
    await assert.rejects(h.capabilities.setChoice(OTHER, 'blush', 'off'), /模型已切换/u);
    h.switchTo(null);
    await assert.rejects(h.capabilities.setChoice(KEY, 'blush', 'off'), /模型已切换/u, 'no model: nothing is written');
  } finally { await h.cleanup(); }
});

test('试一下 goes to the pet and its stage answers: shown, cannot, not ready in time, pet hidden; only the pet may answer', async () => {
  const sent: { requestId: string; id: string }[] = [];
  let visible = true, count = 0;
  const relay = new CapabilityPreviewRelay({ id: () => `r${++count}`, petSender: () => 7, timeoutMs: 30,
    send: request => { if (!visible) return false; sent.push(request); return true; } });
  const shown = relay.request('closeEyes');
  relay.report(7, sent[0].requestId, true);
  assert.equal(await shown, 'shown');
  const cannot = relay.request('tears');
  assert.throws(() => relay.report(3, sent[1].requestId, true), /回执/u, 'the control window cannot answer for the pet');
  relay.report(7, sent[1].requestId, false);
  assert.equal(await cannot, 'cannot');
  assert.equal(await relay.request('blush'), 'not-ready');
  relay.report(7, sent[2].requestId, true); // late: ignored
  visible = false;
  assert.equal(await relay.request('gesture'), 'pet-hidden');
  await assert.rejects(relay.request('fly'), /能力编号/u);
  assert.deepEqual(sent.map(request => request.id), ['closeEyes', 'tears', 'blush']);
});
