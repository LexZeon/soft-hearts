// 2026-11-24 (section 抱抱手势, the 「抱抱」 gesture goes too by the default decision):
// the small window never plays the air-hug gesture while SPEECH_BEAT_WINDOW.windowCloseMoments is off, from any path (the test command, the host's
// issue, the words she may pick); the answer says why; the knob on brings it back; full-screen Unbound is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { HerActionHost } from '../electron/actions/her-action-host';
import { HER_ACTIONS, type HerActionCue } from '../shared/actions/her-actions';
import { CHAT_ACTION_OF, CHAT_ACTION_WORDS } from '../shared/brain/chat-actions';
import { WINDOW_CLOSE_GESTURES, windowGestureRefusal } from '../shared/behaviors/speech-beats/window-close';
import { buildTestEntries } from '../electron/safety/test-commands/entries';
import { fakeTestDeps } from './helpers/test-command-fixtures';

/** The host as electron/wiring/actions-wiring.ts builds it: `refuse` asks the rule only for the small window (not while she is out in full-screen Unbound). */
function host(over: { fullScreen?: boolean; knobOn?: boolean } = {}) {
  const sent: HerActionCue[] = [];
  const actions = new HerActionHost({
    send: cue => { sent.push(cue); }, petVisible: () => true, // no-pet-ok: the host port's existing name (the companion window is shown)
    refuse: action => windowGestureRefusal(action, over.knobOn === true, over.fullScreen === true),
    library: { resolvePreview: async () => '' }, register: async file => ({ path: file, url: `mmd-asset://${'e'.repeat(32)}/${path.basename(file)}`, name: path.basename(file) }),
  });
  return { actions, sent };
}

test('the rule: only the hug gesture, only while the knob is off, and it says why', () => {
  assert.deepEqual(WINDOW_CLOSE_GESTURES, ['air-hug']);
  assert.match(windowGestureRefusal('air-hug', false) ?? '', /小窗里暂时没有「抱抱」/u);
  assert.equal(windowGestureRefusal('air-hug'), windowGestureRefusal('air-hug', false), 'the default is the knob (off)');
  assert.equal(windowGestureRefusal('air-hug', true), null, 'the knob on brings it back');
  for (const id of HER_ACTIONS) if (id !== 'air-hug') assert.equal(windowGestureRefusal(id, false), null, id + ' is not touched');
  assert.equal(windowGestureRefusal(undefined, false), null);
  assert.equal(windowGestureRefusal('air-hug', false, true), null, 'full-screen Unbound is unchanged');
});

test('the small window never plays air-hug: no cue is sent, the answer says why (the test command and the host)', async () => {
  const h = host();
  const result = await h.actions.play('air-hug');
  assert.equal(result.status, 'window-off');
  assert.match(result.detail, /抱抱/u);
  assert.equal(h.sent.length, 0, 'nothing was sent to the stage');
  assert.deepEqual(h.actions.live, [], 'no cue is left waiting');
  assert.equal(h.actions.issue('air-hug'), null, 'a cue riding on a reaction is refused too');
  void h.actions.play('nod');
  assert.equal(h.sent.length, 1, 'the other actions still go');
});

test('the knob on, or her full-screen window: air-hug is sent as before', () => {
  for (const over of [{ knobOn: true }, { fullScreen: true }]) {
    const h = host(over);
    void h.actions.play('air-hug');
    assert.deepEqual(h.sent.map(cue => cue.action), ['air-hug'], JSON.stringify(over));
    assert.ok(h.actions.issue('air-hug'));
  }
});

test('the words she may pick never include a hug gesture (she is not offered it in the window)', () => {
  for (const word of CHAT_ACTION_WORDS) assert.equal(windowGestureRefusal(CHAT_ACTION_OF[word], false), null, word);
});

test('the test command 「抱抱」 says it is off in the small window, plainly; the others are as before', async () => {
  const fake = fakeTestDeps({ action: { play: async action => windowGestureRefusal(action, false)
    ? { status: 'window-off', missing: [], detail: windowGestureRefusal(action, false)! } : { status: 'played', missing: [], detail: '' } } });
  const entries = buildTestEntries(fake.deps).entries;
  const run = (id: string) => entries.find(entry => entry.id === id)!.run({ note: () => {} });
  const hug = await run('ACT.hug');
  assert.match(hug, /“抱抱”在小窗里先关着了，没做；全屏的她照常有/u);
  assert.match(hug, /放回来/u);
  assert.match(await run('ACT.openArms'), /她做了一次“张开双臂”|她做了一次/u, 'open-arms is not the hug gesture');
});
