// Unbound v1 step 3, sub-step 1 (docs/claude/2026-11-17-unbound-step3.md): the voice call goes on into Unbound and back, one owner,
// no drop, no double; her spoken reply reaches her Unbound bubble; the call's window learns she is out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallController, type VoiceCallPorts } from '../electron/voice/voice-call/controller';
import { callSurfaceShown } from '../electron/voice/voice-call/surface';
import { voiceReplyBubbleEvent } from '../electron/unbound/voice-bubble';
import { UnboundHost } from '../electron/unbound/host';
import { callReadsOut, type VoiceCallOwner, type VoiceCallView } from '../shared/voice/voice-call';

test('where a call can be seen: at home the call window and her pet window; out in Unbound her held pet window counts', () => {
  const at = (pet: boolean, controls: boolean, held: boolean) => ({ pet, controls, held });
  assert.equal(callSurfaceShown('pet', at(true, false, false)), true);
  assert.equal(callSurfaceShown('pet', at(false, false, false)), false, 'pet hidden at home: the call cannot be seen');
  assert.equal(callSurfaceShown('pet', at(false, false, true)), true, 'out in Unbound: her pet window is hidden only because she is out');
  assert.equal(callSurfaceShown('controls', at(true, true, false)), true);
  assert.equal(callSurfaceShown('controls', at(false, true, true)), true, 'a control-window call goes on while she is out');
  assert.equal(callSurfaceShown('controls', at(false, true, false)), false, 'at home the pet must be on screen too (as before)');
  assert.equal(callSurfaceShown('controls', at(true, false, false)), false, 'the call window itself hidden');
  assert.equal(callSurfaceShown('controls', at(false, false, true)), false, 'out, but the control window that holds the call is hidden');
});

function rig(start: VoiceCallOwner = 'pet') {
  const place = { pet: true, controls: true, held: false };
  let voice = { on: false, owner: null as VoiceCallOwner | null };
  const views: VoiceCallView[] = [], ends: string[] = [];
  let now = 1_000;
  const ports: VoiceCallPorts = {
    now: () => now,
    timers: { set: () => 0, clear: () => {} },
    voiceInput: () => voice,
    turnOnVoice: owner => { voice = { on: true, owner }; return true; },
    turnOffVoice: () => { voice = { on: false, owner: null }; },
    windowShown: owner => callSurfaceShown(owner, place),
    out: () => place.held,
    asleep: () => false,
    fillers: () => null,
    keepWarm: () => {},
    publish: view => views.push(view),
    journal: entry => { if (entry.event === 'end') ends.push(entry.reason); },
  };
  const call = new VoiceCallController(ports, 60_000);
  return { call, place, views, ends, start: () => call.start(start, 'button'), tick: (ms = 1000) => { now += ms; return call.check(); } };
}

test('going out keeps the call: no hang-up, the same owner, the window is told once that she is out; coming back the same', async () => {
  const r = rig('pet');
  await r.start();
  assert.equal(r.views.at(-1)!.out, undefined, 'at home: not out');
  // She goes out: her companion window hides because of it (electron/unbound/mode.ts enter: held first, then the hide).
  r.place.held = true; r.place.pet = false;
  const published = r.views.length;
  assert.equal(r.tick(), null, 'the call goes on');
  assert.equal(r.call.on, true); assert.equal(r.call.owner, 'pet', 'one owner, unchanged: the microphone never moves');
  assert.equal(r.views.length, published + 1, 'the window learns she is out once');
  assert.equal(r.views.at(-1)!.out, true);
  assert.equal(r.tick(), null); assert.equal(r.views.length, published + 1, 'nothing more while nothing changes');
  // Back home (mode.ts exit: the companion is shown in the same tick).
  r.place.held = false; r.place.pet = true;
  assert.equal(r.tick(), null);
  assert.equal(r.call.on, true); assert.equal(r.views.at(-1)!.out, undefined, 'home again: not out');
  assert.deepEqual(r.ends, [], 'never ended');
});

test('out in Unbound and then her window really gone (back home with the pet hidden): the call ends as before', async () => {
  const r = rig('pet');
  await r.start();
  r.place.held = true; r.place.pet = false; assert.equal(r.tick(), null);
  r.place.held = false; // she came back, but the companion had been hidden before she went out (mode.ts keeps it hidden)
  assert.equal(r.tick(), 'hidden');
  assert.deepEqual(r.ends, ['hidden']);
  assert.equal(r.views.at(-1)!.on, false); assert.equal(r.views.at(-1)!.out, undefined);
});

test('a call cannot start from a hidden pet at home, but can while she is out (the button on the control window)', async () => {
  const r = rig('pet');
  r.place.pet = false;
  await assert.rejects(r.start(), /显示出来/);
  r.place.held = true;
  const view = await r.start();
  assert.equal(view.on, true); assert.equal(view.out, true);
});

test('calling her by name starts a call only in the window listening for it, only while it listens', async () => {
  const r = rig('pet');
  let wake: VoiceCallOwner | null = null;
  (r.call as unknown as { ports: VoiceCallPorts }).ports.wake = () => wake;
  r.place.held = true; r.place.pet = false;
  await assert.rejects(r.call.start('pet', 'name'), /没有在听/);
  wake = 'controls';
  await assert.rejects(r.call.start('pet', 'name'), /没有在听/, 'another window listens');
  wake = 'pet';
  assert.equal(r.call.view().wake, 'pet', 'the windows learn who listens');
  const view = await r.call.start('pet', 'name');
  assert.equal(view.on, true); assert.equal(view.wake, undefined, 'in a call nobody listens for her name');
});

test('the call window reads her replies while hidden only while the call says she is out, and only the call window', () => {
  const view = (patch: Partial<VoiceCallView>): VoiceCallView => ({ on: true, owner: 'pet', since: 1, ended: null, fillers: null, ...patch });
  assert.equal(callReadsOut(view({ out: true }), 'pet'), true);
  assert.equal(callReadsOut(view({}), 'pet'), false, 'at home: the hidden window reads nothing (as before)');
  assert.equal(callReadsOut(view({ out: true }), 'controls'), false, 'not the call window');
  assert.equal(callReadsOut(view({ out: true, on: false }), 'pet'), false, 'no call');
  assert.equal(callReadsOut(null, 'pet'), false);
});

test('her spoken reply becomes her Unbound bubble: visible text, its end, a failure or a retraction; nothing of the user', () => {
  const event = (value: unknown) => voiceReplyBubbleEvent('desk:voice-conversation', value);
  const base = { epoch: 'e', owner: 'pet', groupId: 'g' };
  assert.deepEqual(event({ ...base, type: 'delta', replyId: 'r1', text: '嗯，' }), { id: 'r1', kind: 'chat', type: 'delta', text: '嗯，' });
  assert.deepEqual(event({ ...base, type: 'terminal', replyId: 'r1', complete: true }), { id: 'r1', kind: 'chat', type: 'done', text: '' });
  assert.deepEqual(event({ ...base, type: 'terminal', replyId: 'r1', complete: false, superseded: true }), { id: 'r1', kind: 'chat', type: 'done', text: '' }, 'merged: what showed stays');
  assert.deepEqual(event({ ...base, type: 'terminal', replyId: 'r1', complete: false }), { id: 'r1', kind: 'chat', type: 'error', text: '' });
  assert.deepEqual(event({ ...base, type: 'cancelled', replyId: 'r1' }), { id: 'r1', kind: 'chat', type: 'error', text: '' });
  assert.equal(event({ ...base, type: 'row', seq: 1, text: '你好呀' }), null, 'the user\'s own words never go into her bubble');
  assert.equal(event({ ...base, type: 'draft', text: '草稿' }), null);
  assert.equal(event({ ...base, type: 'speech', replyId: 'r1', text: '整句' }), null);
  assert.equal(event({ ...base, type: 'delta', replyId: 'bad id!', text: 'x' }), null);
  assert.equal(voiceReplyBubbleEvent('desk:stream', { type: 'delta', replyId: 'r1', text: 'x' }), null, 'other channels: nothing');
});

test('UnboundHost.voiceReply streams exactly those events into her bubble (and nothing else)', () => {
  const streamed: unknown[] = [];
  const host = Object.create(UnboundHost.prototype) as UnboundHost;
  (host as unknown as { stream(event: unknown): void }).stream = event => { streamed.push(event); };
  host.voiceReply('desk:voice-conversation', { epoch: 'e', owner: 'pet', type: 'delta', groupId: 'g', replyId: 'r1', text: '在呢。' });
  host.voiceReply('desk:voice-conversation', { epoch: 'e', owner: 'pet', type: 'row', groupId: 'g', seq: 1, text: '在吗' });
  host.voiceReply('desk:memory-changed', undefined);
  assert.deepEqual(streamed, [{ id: 'r1', kind: 'chat', type: 'delta', text: '在呢。' }]);
});
