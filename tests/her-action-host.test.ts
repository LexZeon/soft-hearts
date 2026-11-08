/**
 * 她的动作, host side (electron/her-action-host.ts): a test command's action becomes a short-lived cue to every window; only a
 * live cue resolves, only to its one pinned VMD (bytes hashed again here); the pet's answer settles the command once; with no
 * pet window or no answer the command says so instead of waiting forever.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HerActionHost } from '../electron/her-action-host';
import { HER_ACTION_CUE_MS, HER_ACTION_PACK, HER_ACTION_SPECS, type HerActionCue } from '../shared/her-actions';
import { catalogMotionFile } from './helpers/gene-stage-harness';
import { fakeTimers } from './helpers/test-command-fixtures';

function host(options: { visible?: boolean; file?: (packId: unknown, motionId: unknown) => Promise<string> } = {}) {
  const time = fakeTimers(), sent: HerActionCue[] = [], asked: string[] = [];
  const actions = new HerActionHost({
    send: cue => { sent.push(cue); }, petVisible: () => options.visible !== false,
    library: { resolvePreview: async (packId, motionId) => { asked.push(`${packId}/${motionId}`); return options.file ? options.file(packId, motionId) : fileURLToPath(catalogMotionFile(HER_ACTION_PACK, String(motionId))); } },
    register: async file => ({ path: file, url: `mmd-asset://${'e'.repeat(32)}/${path.basename(file)}`, name: path.basename(file) }),
    now: () => 1_000_000 + time.clock(), createId: (() => { let n = 0; return () => `cue${++n}`; })(), timers: time.timers,
  });
  return { actions, time, sent, asked };
}

test('play: a cue to every window, settled once by the pet\'s answer; no pet window or no answer is said at once / after the cue\'s life', async () => {
  const h = host();
  const pending = h.actions.play('two-hand-heart');
  assert.deepEqual(h.sent, [{ id: 'cue1', action: 'two-hand-heart', at: 1_000_000, expiresAt: 1_000_000 + HER_ACTION_CUE_MS }]);
  assert.equal(h.actions.report({ cueId: 'cue1', status: 'missing', missing: ['手指'], detail: '' }), true);
  assert.equal(h.actions.report({ cueId: 'cue1', status: 'played', missing: [], detail: '' }), true, 'a second answer changes nothing');
  assert.deepEqual(await pending, { status: 'missing', missing: ['手指'], detail: '' });
  assert.equal(h.actions.report({ cueId: 'nobody', status: 'played', missing: [], detail: '' }), false);
  assert.equal(h.actions.report({ cueId: 'cue1', status: 'exploded' }), false, 'a closed status set');

  const silent = h.actions.play('nod');
  h.time.advance(HER_ACTION_CUE_MS);
  assert.deepEqual(await silent, { status: 'no-answer', missing: [], detail: '' });
  assert.deepEqual(h.actions.live, [], 'an unanswered cue is gone after its life');

  const hidden = host({ visible: false });
  assert.deepEqual(await hidden.actions.play('clap'), { status: 'no-window', missing: [], detail: '' });
  assert.deepEqual(hidden.sent, [], 'nothing is sent without a pet window');
  await assert.rejects(host().actions.play('finger-heart'), /动作编号不正确/u, 'the failed prototype is not in the set');
});

test('resolve: only a live cue, only its pinned bytes (hashed again here); expired, unknown or altered is refused', async () => {
  const h = host();
  void h.actions.play('bow');
  const resource = await h.actions.resolve('cue1');
  assert.deepEqual({ ...resource, url: resource.url.replace(/e{32}/, 'E') }, { cueId: 'cue1', action: 'bow', packId: HER_ACTION_PACK, motionId: 'bow',
    url: 'mmd-asset://E/bow.vmd', sha256: HER_ACTION_SPECS.bow.sha256, durationMs: 66 / 30 * 1000 });
  assert.deepEqual(h.asked, [`${HER_ACTION_PACK}/bow`]);
  // Still resolvable after the pet answered (the other window may still be loading), until the cue's life ends.
  h.actions.report({ cueId: 'cue1', status: 'played', missing: [], detail: '' });
  assert.equal((await h.actions.resolve('cue1')).action, 'bow');
  h.time.advance(HER_ACTION_CUE_MS);
  await assert.rejects(h.actions.resolve('cue1'), /已经结束或失效/u);
  await assert.rejects(h.actions.resolve('never'), /已经结束或失效/u);
  await assert.rejects(h.actions.resolve(42), /已经结束或失效/u);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-her-action-'));
  try {
    const bytes = await readFile(catalogMotionFile(HER_ACTION_PACK, 'nod'));
    bytes[bytes.length - 1] ^= 1;
    const altered = path.join(directory, 'nod.vmd');
    await writeFile(altered, bytes);
    const tampered = host({ file: async () => altered });
    void tampered.actions.play('nod');
    await assert.rejects(tampered.actions.resolve('cue1'), /校验失败/u, 'bytes that are not the pinned clip');
    const swapped = host({ file: async () => fileURLToPath(catalogMotionFile(HER_ACTION_PACK, 'shake')) });
    void swapped.actions.play('nod');
    await assert.rejects(swapped.actions.resolve('cue1'), /校验失败/u, 'another action\'s clip');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
