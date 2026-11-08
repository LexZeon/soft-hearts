import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import catalogData from '../shared/motion-catalog.json';
import type { ChatGestureCue, ChatGestureAppraisal } from '../shared/chat-gesture';
import type { MotionCatalog } from '../shared/motion-library';
import type { ProviderConfig } from '../shared/contracts';
import { MoodHost } from '../electron/mood';
import { CompanionService, type CompanionTurn } from '../electron/companion';
import { MotionLibrary } from '../electron/motion-library';
import { resolveChatGestureResource, chatGestureDurationMs } from '../electron/chat-gesture';

const appraisal: ChatGestureAppraisal = { context: 'neutral', delta: {}, reason: '原创说明测试', gesture: 'explain' };
const cue = (intent: ChatGestureCue['intent'] = 'explain'): ChatGestureCue => ({
  id: 'original-cue', at: 1_000, expiresAt: 1_000 + chatGestureDurationMs(intent) + 1_500,
  intent, strength: 0.45, reason: '原创测试',
});
const provider: ProviderConfig = { kind: 'claude', baseUrl: 'https://synthetic.example/v1', model: 'fixture' };
const cleanupBeforeRemove = new Map<string, () => Promise<void>>();

async function directory(t: TestContext): Promise<string> {
  const target = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-chat-gesture-'));
  t.after(async () => {
    assert.equal(path.dirname(target), os.tmpdir());
    assert.ok(path.basename(target).startsWith('soft-hearts-chat-gesture-'));
    try { await cleanupBeforeRemove.get(target)?.(); }
    finally { cleanupBeforeRemove.delete(target); await rm(target, { recursive: true, force: true }); }
  });
  return target;
}
async function hostFixture(t: TestContext) {
  const target = await directory(t), clock = { now: 100_000 };
  const host = new MoodHost(target, () => {}, () => clock.now);
  await host.load(); host.activate('gene');
  cleanupBeforeRemove.set(target, () => host.flush());
  const accept = (id: string) => { const token = host.get().token; host.beginChatGesture(id, token); host.event({ type: 'chat', id }); return token; };
  return { host, clock, target, accept };
}
function wire(turn: CompanionTurn, gesture = 'explain'): string {
  const opening = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0]; assert.ok(opening);
  return `原创回复。\n${opening}${JSON.stringify({ ...appraisal, gesture, confidence: 0.9 })}${opening.replace('<', '</')}`;
}

test('chat resolver selects only the two pinned public clips offline without a cache or state change', async t => {
  const target = await directory(t), cache = path.join(target, 'cache');
  let fetches = 0;
  const library = new MotionLibrary(cache, { bundledDirectory: path.resolve('assets/bundled'),
    fetch: (async () => { fetches++; throw new Error('must remain offline'); }) as typeof fetch });
  const original = library.resolvePreview.bind(library), calls: [unknown, unknown][] = [];
  library.resolvePreview = async (pack, motion) => { calls.push([pack, motion]); return original(pack, motion); };
  for (const intent of ['explain', 'consider', 'upbeat'] as const) {
    const resource = await resolveChatGestureResource(library, cue(intent), 1_000);
    assert.equal(resource.cueId, 'original-cue'); assert.equal(resource.intent, intent);
    assert.ok(path.isAbsolute(resource.path)); assert.ok(!Object.hasOwn(resource, 'url'));
    assert.equal(resource.durationMs, intent === 'upbeat' ? 2_933.333 : 6_000);
    assert.deepEqual(calls.at(-1), intent === 'upbeat' ? ['mpi-embm-gestures', 'conversation-joy'] : ['genea-2022-gestures', 'speaking-gesture-2']);
    assert.match(resource.sha256, /^[a-f0-9]{64}$/);
  }
  await assert.rejects(readdir(cache), /ENOENT/); assert.equal(fetches, 0);
});

test('malformed, expired, path-bearing or unsupported cues cannot reach the motion library', async () => {
  let calls = 0; const library = { resolvePreview: async () => { calls++; return ''; } };
  for (const value of [
    { ...cue(), intent: 'none' }, { ...cue(), intent: '../private.vmd' }, { ...cue(), intent: '__proto__' },
    { ...cue(), path: 'private.vmd' }, { ...cue(), packId: 'gene' }, { ...cue(), id: '../other' },
    { ...cue(), strength: NaN }, { ...cue(), strength: 0.701 }, { ...cue(), strength: 0 },
    { ...cue(), expiresAt: 1_000 }, { ...cue(), expiresAt: 8_501 }, { ...cue(), at: 1_001 },
  ]) await assert.rejects(resolveChatGestureResource(library, value as ChatGestureCue, 1_000), /失效或不受支持/);
  assert.equal(calls, 0);
});

test('a substituted local VMD or manifest cannot widen the independent hash whitelist', async t => {
  const target = await directory(t), file = path.join(target, 'original.vmd');
  const bytes = Buffer.alloc(74); bytes.write('Vocaloid Motion Data 0002'); await writeFile(file, bytes);
  await assert.rejects(resolveChatGestureResource({ resolvePreview: async () => file }, cue(), 1_000), /资源校验失败/);
  const actual = new MotionLibrary(path.join(target, 'cache'), { bundledDirectory: path.resolve('assets/bundled') });
  const wrong = await actual.resolvePreview('mpi-embm-gestures', 'conversation-joy');
  await assert.rejects(resolveChatGestureResource({ resolvePreview: async () => wrong }, cue(), 1_000), /资源校验失败/);
  await assert.rejects(resolveChatGestureResource({ resolvePreview: async () => 'relative.vmd' }, cue(), 1_000), /资源校验失败/);
});

test('chat resolution retains MotionLibrary notice validation and rejects a changed public notice', async t => {
  const target = await directory(t), bundle = path.join(target, 'bundle');
  const pack = (catalogData as MotionCatalog).packs.find(value => value.id === 'genea-2022-gestures')!;
  const motion = pack.motions.find(value => value.id === 'speaking-gesture-2')!;
  for (const file of [...pack.documents, motion]) {
    const relative = path.join(pack.source, pack.id, pack.revision, file.relativePath);
    const output = path.join(bundle, relative); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, await readFile(path.join('assets/bundled', relative)));
  }
  const library = new MotionLibrary(path.join(target, 'cache'), { bundledDirectory: bundle });
  assert.ok(await resolveChatGestureResource(library, cue(), 1_000));
  const notice = path.join(bundle, pack.source, pack.id, pack.revision, pack.documents[0].relativePath);
  const bytes = await readFile(notice); bytes[bytes.length - 1] ^= 1; await writeFile(notice, bytes);
  await assert.rejects(resolveChatGestureResource(library, cue(), 1_000), /预装资源缺失或损坏/);
});

test('a gesture is transient, detached and consumed once, including after its fixed TTL', async t => {
  const { host, clock, target, accept } = await hostFixture(t);
  const token = accept('one'), before = host.get().snapshot;
  const selected = host.requestChatGesture('one', appraisal, token); assert.ok(selected);
  assert.equal(selected.expiresAt - selected.at, 7_500);
  const id = selected.id; selected.strength = 0;
  assert.ok(host.get().gesture!.strength > 0); assert.equal(host.get().gesture?.id, id);
  assert.deepEqual(host.get().snapshot, before, 'performance does not apply another mood event or user timestamp');
  assert.equal(host.requestChatGesture('one', appraisal, token), null);
  await host.flush(); const saved = await readFile(path.join(target, 'mood-state.json'), 'utf8');
  assert.ok(!saved.includes(id)); assert.ok(!saved.includes('gesture'));
  for (let i = 0; i < 7; i++) { clock.now += 1_000; host.tick(false); }
  assert.equal(host.get().gesture?.expiresAt, selected.expiresAt, 'reads and ticks never renew the TTL');
  clock.now += 501; assert.equal(host.get().gesture, null);
  assert.equal(host.requestChatGesture('one', appraisal, host.get().token), null);
  const restored = new MoodHost(target, () => {}, () => clock.now); await restored.load(); restored.activate('gene');
  assert.equal(restored.get().gesture, null); await restored.flush();
});

test('old-token requests and scoped old cancellation preserve the newer cue; explicit lifecycle changes clear it', async t => {
  const { host, accept } = await hostFixture(t);
  const oldToken = accept('old'); assert.ok(host.requestChatGesture('old', appraisal, oldToken));
  host.invalidate(); assert.equal(host.get().gesture, null);
  const nextToken = accept('next'), next = host.requestChatGesture('next', appraisal, nextToken); assert.ok(next);
  host.cancelChatGesture('old'); assert.equal(host.get().gesture?.id, next.id);
  assert.equal(host.requestChatGesture('old', appraisal, oldToken), null); assert.equal(host.get().gesture?.id, next.id);
  host.activate('other'); assert.equal(host.get().gesture, null);
  const token = accept('other-request'); assert.ok(host.requestChatGesture('other-request', appraisal, token));
  host.setExpressions(false); host.setExpressions(true); assert.equal(host.get().gesture, null);
  assert.equal(host.requestChatGesture('other-request', appraisal, host.get().token), null);
});

test('new chat, direct interaction and zero posture cancel current and pending performances without replay', async t => {
  const { host, accept } = await hostFixture(t);
  let token = accept('first'); assert.ok(host.requestChatGesture('first', appraisal, token));
  token = accept('pending'); assert.equal(host.get().gesture, null);
  host.interaction({ token, sessionId: 'head', type: 'phase', phase: 'rua' });
  host.interaction({ token, sessionId: 'head', type: 'phase', phase: 'idle' });
  assert.equal(host.requestChatGesture('pending', appraisal, token), null);
  token = accept('zero'); assert.ok(host.requestChatGesture('zero', appraisal, token));
  const parameters = host.get().parameters; parameters.intensity.posture = 0; host.applyTemplate('gene', parameters);
  assert.equal(host.get().gesture, null);
  token = accept('zero-new'); assert.equal(host.requestChatGesture('zero-new', appraisal, token), null);
  parameters.intensity.posture = 50; host.applyTemplate('gene', parameters);
  assert.equal(host.requestChatGesture('zero-new', appraisal, token), null, 'suppression consumes the accepted intent');
});

test('Companion creates one cue only for a complete current reply and strips the intent from original text', async t => {
  const target = await directory(t), service = new CompanionService(target, () => {});
  await service.load(); await service.context('gene', provider, 'Gene'); cleanupBeforeRemove.set(target, () => service.flush());
  const turn = await service.begin('complete', '原创说明请求', 'Gene', () => {}); turn.push('delta', wire(turn));
  await turn.finish('complete'); const id = service.mood.get().gesture?.id; assert.ok(id);
  await turn.finish('complete'); assert.equal(service.mood.get().gesture?.id, id);
  assert.equal(service.memory.read(turn.scope, turn.recordId)?.messages[1].content, '原创回复。');
  for (const status of ['stopped', 'error'] as const) {
    const other = await service.begin(status, '原创中断请求', 'Gene', () => {});
    assert.equal(service.mood.get().gesture, null); other.push('delta', wire(other)); await other.finish(status);
    assert.equal(service.mood.get().gesture, null);
  }
  const again = await service.begin('again', '原创请求', 'Gene', () => {}); again.push('delta', wire(again)); await again.finish('complete');
  assert.ok(service.mood.get().gesture); const reset = service.newConversation();
  assert.equal(service.mood.get().gesture, null, 'reset clears synchronously before the archive await'); await reset;
});

test('Companion captures expression generation before archive awaits and interaction can cancel pending setup', async t => {
  for (const change of ['model', 'interaction'] as const) {
    const target = await directory(t), service = new CompanionService(target, () => {});
    await service.load(); await service.context('gene', provider, 'Gene'); cleanupBeforeRemove.set(target, () => service.flush());
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(done => { entered = done; }), released = new Promise<void>(done => { release = done; });
    const original = service.memory.noteUserRecall.bind(service.memory);
    service.memory.noteUserRecall = async (...args) => { entered(); await released; return original(...args); };
    const pending = service.begin(`pending-${change}`, '原创准备中的请求', 'Gene', () => {}); await enteredPromise;
    if (change === 'model') service.mood.invalidate();
    else {
      const token = service.mood.get().token;
      service.mood.interaction({ token, sessionId: 'head', type: 'phase', phase: 'rua' });
      service.mood.interaction({ token, sessionId: 'head', type: 'phase', phase: 'idle' });
    }
    release(); const turn = await pending; turn.push('delta', wire(turn)); await turn.finish('complete');
    assert.equal(service.mood.get().gesture, null, `${change} during setup cannot produce a late gesture`);
    assert.equal(service.memory.read(turn.scope, turn.recordId)?.messages[1].content, '原创回复。');
  }
});

test('duplicate active setup cannot consume the original reply performance', async t => {
  const target = await directory(t), service = new CompanionService(target, () => {});
  await service.load(); await service.context('gene', provider, 'Gene'); cleanupBeforeRemove.set(target, () => service.flush());
  const original = await service.begin('same-id', '原创请求', 'Gene', () => {});
  await assert.rejects(service.begin('same-id', '重复请求', 'Gene', () => {}), /重复启动/);
  original.push('delta', wire(original)); await original.finish('complete');
  assert.ok(service.mood.get().gesture, 'the first accepted reply remains eligible exactly once');
});
