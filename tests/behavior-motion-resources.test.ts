import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import catalogData from '../shared/motion-catalog.json';
import type { MotionCatalog } from '../shared/motion-library';
import type { BehaviorFaceMotionId, BehaviorMotionCue } from '../shared/behavior-motion';
import { MotionLibrary } from '../electron/motion-library';
import { resolveBehaviorMotionResource } from '../electron/behavior-motion-bindings';

const pinned = [
  ['smile', '87cfd8818c6474a968ed83f8c6040d3a9657d8947a2eab7f47675a3fa50fb2b3'],
  ['embarrassed-smile', '1fe9d30181511c135b8fd9c8afb9795a29b197aa7da05a4a104c2c1e113296d3'],
  ['happy', '8da8b93dfc2dba19535246126558f82238c915ff8a90b2d05dfba17a333f903e'],
  ['laugh', '714c04a833285aacc7b75039d872fc852c6df75025296bae0a707e5bbb3e159e'],
  ['compassion', 'd90a4b147a5c87cb514aee1f6a44ae3c43beb13473039223897028f4847654f7'],
  ['in-trouble', '62754cb6c6912a75c1506b8bcc375a03dfdffe5a9c6fe7573c1f9152e44a2497'],
  ['disappointed', 'ae12bcab9288fed1b951c565871f4414debd81a45b81ef1b29472f373f751790'],
  ['disgust', '96944c44a88ac91ea7b87edfeccc677c8c83abf3cebeb76923ce3a95baf0f21f'],
  ['sentimental', 'f9f746e6c2fc660e21b5264a4282b8a155dbf8efdd3ce5d288ac834b5e71d8da'],
  ['sad', 'f7039798db01383d05febe7dcae03cb164ad6acee2015906459e9f6c425ba507'],
  ['convinced', '10e9afe2685408850935acbf5f54210098896a530c274ebf4f88a0e31ce0ce82'],
] as const;

const cue = (motion: BehaviorFaceMotionId = 'smile'): BehaviorMotionCue => ({
  id: 'face-cue', kind: 'state', bindingId: `face.${motion}`, semantic: 'mood.happy',
  at: 1_000, expiresAt: 12_500, strength: 0.45, stateKey: 'mood.happy:fixture',
});

async function directory(t: TestContext) {
  const target = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-behavior-resource-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(target)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('soft-hearts-behavior-resource-'));
    await rm(target, { recursive: true, force: true });
  });
  return target;
}

test('all eleven fixed face bindings resolve the reviewed source offline without installing or editing it', async t => {
  const target = await directory(t), cache = path.join(target, 'cache');
  let fetches = 0;
  const library = new MotionLibrary(cache, {
    bundledDirectory: path.resolve('assets/bundled'),
    fetch: (async () => { fetches++; throw new Error('must remain offline'); }) as typeof fetch,
  });
  const original = library.resolvePreview.bind(library), calls: [unknown, unknown][] = [];
  library.resolvePreview = async (pack, motion) => { calls.push([pack, motion]); return original(pack, motion); };
  for (const [motionId, sha256] of pinned) {
    const resource = await resolveBehaviorMotionResource(library, cue(motionId), 1_000);
    assert.deepEqual(calls.at(-1), ['gene', motionId]);
    assert.equal(resource.cueId, 'face-cue'); assert.equal(resource.bindingId, `face.${motionId}`);
    assert.equal(resource.packId, 'gene'); assert.equal(resource.motionId, motionId);
    assert.equal(resource.recipe, 'emotion-face'); assert.equal(resource.durationMs, 10_000);
    assert.equal(resource.sha256, sha256); assert.ok(path.isAbsolute(resource.path));
    assert.equal(Object.hasOwn(resource, 'url'), false);
    assert.equal(createHash('sha256').update(await readFile(resource.path)).digest('hex'), sha256);
  }
  assert.equal(fetches, 0); await assert.rejects(readdir(cache), /ENOENT/);
  assert.deepEqual(await readdir(target), []);
});

test('malformed, stale, expired, path-bearing or unsupported cues are rejected before library access', async () => {
  let calls = 0;
  const library = { resolvePreview: async () => { calls++; return ''; } };
  const missingKey = { ...cue() } as Partial<BehaviorMotionCue>; delete missingKey.stateKey;
  const invalid: unknown[] = [
    null, [], {}, missingKey,
    { ...cue(), path: 'private.vmd' }, { ...cue(), url: 'file:///private.vmd' },
    { ...cue(), packId: 'gene' }, { ...cue(), motionId: 'happy' }, { ...cue(), delta: { O: 20 } },
    { ...cue(), [Symbol('extra')]: 'invalid' },
    { ...cue(), bindingId: 'face.angry' }, { ...cue(), bindingId: '__proto__' },
    { ...cue(), bindingId: '../private.vmd' }, { ...cue(), kind: 'continuous' }, { ...cue(), kind: 'reserved' },
    { ...cue(), semantic: 'mood.not-real' }, { ...cue(), semantic: '../private.vmd' },
    { ...cue(), id: '' }, { ...cue(), id: '../other' }, { ...cue(), id: 'x'.repeat(161) },
    { ...cue(), strength: NaN }, { ...cue(), strength: Infinity }, { ...cue(), strength: 0 },
    { ...cue(), strength: -0.1 }, { ...cue(), strength: 0.70001 },
    { ...cue(), at: -1 }, { ...cue(), at: NaN }, { ...cue(), at: 1_001 },
    { ...cue(), expiresAt: 1_000 }, { ...cue(), expiresAt: Infinity }, { ...cue(), expiresAt: 12_501 },
    { ...cue(), stateKey: '' }, { ...cue(), stateKey: '  ' },
    { ...cue(), stateKey: 'x'.repeat(257) }, { ...cue(), stateKey: 'old\u0000new' },
  ];
  for (const value of invalid)
    await assert.rejects(resolveBehaviorMotionResource(library, value as BehaviorMotionCue, 1_000), /失效或不受支持/);
  for (const now of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2_501])
    await assert.rejects(resolveBehaviorMotionResource(library, cue(), now), /失效或不受支持/);
  assert.equal(calls, 0);
});

test('the exact start-age and strength boundaries are admitted for state and reaction once recipes', async t => {
  const target = await directory(t);
  const library = new MotionLibrary(path.join(target, 'cache'), { bundledDirectory: path.resolve('assets/bundled') });
  const state = { ...cue(), strength: 0.7 };
  const reaction: BehaviorMotionCue = { ...cue('convinced'), kind: 'reaction', semantic: 'cue.reunion', stateKey: 'response-once', strength: Number.EPSILON };
  assert.equal((await resolveBehaviorMotionResource(library, state, 2_500)).bindingId, 'face.smile');
  assert.equal((await resolveBehaviorMotionResource(library, reaction, 2_500)).bindingId, 'face.convinced');
});

test('path type, source header, size and exact per-binding bytes remain independently bounded', async t => {
  const target = await directory(t), invalidFile = path.join(target, 'invalid.vmd');
  const resolve = (file: string) => resolveBehaviorMotionResource({ resolvePreview: async () => file }, cue(), 1_000);
  await assert.rejects(resolve('relative.vmd'), /资源校验失败/);
  await assert.rejects(resolve(target), /资源校验失败/);
  for (const bytes of [Buffer.alloc(29), Buffer.alloc(74), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    await writeFile(invalidFile, bytes);
    await assert.rejects(resolve(invalidFile), /资源校验失败/);
  }
  const fake = Buffer.alloc(74); fake.write('Vocaloid Motion Data 0002'); await writeFile(invalidFile, fake);
  await assert.rejects(resolve(invalidFile), /资源校验失败/);
  const library = new MotionLibrary(path.join(target, 'cache'), { bundledDirectory: path.resolve('assets/bundled') });
  const otherAllowedFace = await library.resolvePreview('gene', 'happy');
  await assert.rejects(resolve(otherAllowedFace), /资源校验失败/, 'another approved face cannot substitute for smile');
  const oldChatGesture = await library.resolvePreview('mpi-embm-gestures', 'conversation-joy');
  await assert.rejects(resolve(oldChatGesture), /资源校验失败/, 'M004 does not widen this face allowlist');
});

test('a symlink to an otherwise approved source is refused', async t => {
  const target = await directory(t), link = path.join(target, 'linked.vmd');
  const library = new MotionLibrary(path.join(target, 'cache'), { bundledDirectory: path.resolve('assets/bundled') });
  const original = await library.resolvePreview('gene', 'smile');
  try { await symlink(original, link, 'file'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows does not permit test symlink creation'); return; }
    throw error;
  }
  await assert.rejects(resolveBehaviorMotionResource({ resolvePreview: async () => link }, cue(), 1_000), /资源校验失败/);
});

test('a replaced catalog cannot authorize substituted bytes and notice validation is retained', async t => {
  const target = await directory(t), bundle = path.join(target, 'bundle');
  const catalog = structuredClone(catalogData) as MotionCatalog;
  const pack = catalog.packs.find(value => value.id === 'gene')!;
  const motion = pack.motions.find(value => value.id === 'smile')!;
  const source = (relative: string) => path.join('assets/bundled', pack.source, pack.id, pack.revision, relative);
  const destination = (relative: string) => path.join(bundle, pack.source, pack.id, pack.revision, relative);
  for (const file of [...pack.documents, motion]) {
    const output = destination(file.relativePath); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, await readFile(source(file.relativePath)));
  }
  const library = new MotionLibrary(path.join(target, 'cache'), { bundledDirectory: bundle });
  assert.ok(await resolveBehaviorMotionResource(library, cue(), 1_000));
  const output = destination(motion.relativePath), bytes = await readFile(output);
  bytes[bytes.length - 1] ^= 1; await writeFile(output, bytes);
  motion.sha256 = createHash('sha256').update(bytes).digest('hex');
  const replacedCatalog = new MotionLibrary(path.join(target, 'other-cache'), { catalog, bundledDirectory: bundle });
  assert.equal(await replacedCatalog.resolvePreview('gene', 'smile'), path.resolve(output));
  await assert.rejects(resolveBehaviorMotionResource(replacedCatalog, cue(), 1_000), /资源校验失败/);
  await writeFile(output, await readFile(source(motion.relativePath)));
  const notice = destination(pack.documents[0].relativePath), noticeBytes = await readFile(notice);
  noticeBytes[noticeBytes.length - 1] ^= 1; await writeFile(notice, noticeBytes);
  await assert.rejects(resolveBehaviorMotionResource(library, cue(), 1_000), /预装资源缺失或损坏/);
});

test('a caller mutation across the library await cannot change the admitted cue or binding', async t => {
  const target = await directory(t), request = cue();
  const library = new MotionLibrary(path.join(target, 'cache'), { bundledDirectory: path.resolve('assets/bundled') });
  const resolved = await resolveBehaviorMotionResource({ resolvePreview: async (pack, motion) => {
    assert.equal(pack, 'gene'); assert.equal(motion, 'smile');
    request.id = 'mutated'; request.bindingId = 'face.happy';
    return library.resolvePreview(pack, motion);
  } }, request, 1_000);
  assert.equal(resolved.cueId, 'face-cue'); assert.equal(resolved.bindingId, 'face.smile');
  assert.equal(resolved.motionId, 'smile'); assert.equal(resolved.sha256, pinned[0][1]);
});
