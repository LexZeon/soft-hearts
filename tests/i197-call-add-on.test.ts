import test from 'node:test';
import assert from 'node:assert/strict';
import { CALL_TEST, callWorld, deferred, until, type CallWorld } from './helpers/call-add-on-harness';
import { CallAddOn } from '../electron/voice/voice-call/add-on';

/**
 * I-197: in a call, from handing her a line until her VOICE starts, a clear line the user adds is joined to it and the
 * two are answered together. Four timings over the real voice host, session, archive and the persistent Claude chat on the fake CLI:
 * before the request is written, after it, text arrived but no sound (streaming, and written in full), after her voice started.
 * Each checks: added on or not, the process stayed warm (one spawn), unvoiced text never archived nor read, what she was told, one
 * archive and one reward per reply.
 */
const ADD_ON = '他在你开口前又补了一句';
const SHOWN = '已经显示出来的部分用户看到了';

/** The `replies`-th reply is written in full; her voice starts (it would wait for that, up to the hold); the utterance settles. */
async function settled(w: CallWorld, replies: number): Promise<void> {
  await until(() => w.starts().length === replies && w.completed.includes(w.starts()[replies - 1]), 'reply ' + replies);
  w.voiced(w.starts()[replies - 1]);
  await until(() => !!w.terminal(w.starts()[replies - 1]), 'reply ' + replies + ' counted');
  await until(() => w.events.some(event => event.type === 'continuation' && event.state === 'settled'), 'settled');
  await w.host.drain(); await w.service.flush();
}
/** After an add-on utterance, the next line goes to the same warm process with nothing resent (Claude's record lined up with the chat). */
async function nextLineStaysWarm(w: CallWorld): Promise<void> {
  const before = w.starts().length, users = (await w.claude.users()).length;
  w.quiet(); // she finished saying the reply that answered both
  await w.say('下一句');
  await until(() => w.starts().length === before + 1 && w.completed.includes(w.starts()[before]), 'next reply');
  w.voiced(w.starts()[before]);
  await until(() => w.events.filter(event => event.type === 'continuation' && event.state === 'settled').length === 2, 'next settled');
  assert.equal((await w.claude.spawns()).length, 1, 'still the same process');
  assert.deepEqual((await w.claude.users()).slice(users), ['下一句'], 'only the new line was written');
  const last = (await prompts(w)).at(-1)!;
  assert.ok(!last.includes(ADD_ON), 'the add-on line was for that one turn only');
}
async function prompts(w: CallWorld): Promise<string[]> {
  return (await w.claude.inputs()).filter(row => row.user !== undefined).map(row => row.prompt ?? '');
}
const assistantText = (record: any) => record.messages.filter((message: any) => message.role === 'assistant').map((message: any) => message.content).join('');

test('timing 1, before the request is written: the line joins the same request (one message, no interrupt, nothing dropped)', CALL_TEST, async () => {
  await callWorld(async w => {
    const gate = deferred<void>(); w.blockGroups(gate.promise);
    await w.say('第一句');
    w.advance(800);
    await w.say('第二句');
    const rows = w.rows();
    assert.equal(rows.at(-1)!.groupId, rows[0].groupId, 'the second line continues the first utterance');
    assert.equal(rows.at(-1)!.text, '第一句\n第二句');
    assert.deepEqual(await w.claude.users(), [], 'nothing was written yet');
    w.blockGroups(null); gate.resolve();
    await settled(w, 1);
    assert.deepEqual(await w.claude.users(), ['第一句\n第二句'], 'one request with both lines');
    assert.deepEqual(await w.claude.controls(), [], 'nothing was interrupted');
    assert.equal((await w.claude.spawns()).length, 1, 'the warm process was not closed');
    const prompt = (await prompts(w))[0];
    assert.ok(prompt.includes(ADD_ON) && !prompt.includes(SHOWN), 'she is told the one add-on line, nothing about a shown part');
    const records = w.records();
    assert.equal(records.length, 1, 'one archive');
    assert.equal(records[0].messages[0].content, '第一句\n第二句');
    assert.equal(assistantText(records[0]), '好哒，第一句\n第二句');
    assert.deepEqual(w.rewards, ['chat', 'appraisal'], 'one reward');
    assert.deepEqual(w.journal, [{ gapMs: 800, written: false, dropped: 0 }]);
  });
});

test('timing 2, written but no text yet: that turn is stopped on the warm process, the next turn answers both', CALL_TEST, async () => {
  await callWorld(async w => {
    await w.say('#wait:w 第一句');
    await until(async () => (await w.claude.users()).length === 1, 'first written');
    w.advance(1200);
    await w.say('第二句');
    await settled(w, 2);
    const [r1, r2] = w.starts();
    assert.equal(w.terminal(r1)?.dropped, true, 'the stopped reply is dropped');
    assert.deepEqual(await w.claude.users(), ['#wait:w 第一句', '第二句']);
    assert.deepEqual(await w.claude.controls(), ['interrupt']);
    assert.equal((await w.claude.spawns()).length, 1, 'the warm process was not closed');
    const second = (await prompts(w))[1];
    assert.ok(second.includes(ADD_ON) && second.includes('#wait:w 第一句') && !second.includes(SHOWN), 'one line, with the first line as context');
    assert.ok(w.cancelled.includes(r1), 'its reading was cleared');
    const records = w.records();
    assert.equal(records.length, 1);
    assert.equal(records[0].messages[0].content, '#wait:w 第一句\n第二句');
    assert.equal(assistantText(records[0]), w.text(r2), 'only the reply that answers both is archived');
    assert.deepEqual(w.rewards, ['chat', 'appraisal']);
    assert.deepEqual(w.journal, [{ gapMs: 1200, written: true, dropped: 0 }]);
    await nextLineStaysWarm(w);
  });
});

test('timing 3a, her text streaming but no sound: a short line ("对") still joins; what she wrote is never archived or read', CALL_TEST, async () => {
  await callWorld(async w => {
    await w.say('#hold:g 第一句');
    await until(() => w.starts().length === 1 && w.text(w.starts()[0]).length > 0, 'first text');
    const [r1] = w.starts(), unvoiced = w.read.get(r1)!;
    assert.ok(unvoiced.length > 0, 'the text reached the reading plan, but no sound yet');
    await w.say('对', { seconds: 0.3 });
    await settled(w, 2);
    const r2 = w.starts()[1];
    assert.equal(w.held.length, 0, 'no barge-in gate while she is silent');
    assert.equal(w.terminal(r1)?.dropped, true);
    assert.ok(w.cancelled.includes(r1) && !w.completed.includes(r1), 'its reading was cleared, never completed');
    assert.ok(w.stops >= 1, 'her reading queue was stopped');
    assert.deepEqual(await w.claude.controls(), ['interrupt']);
    assert.equal((await w.claude.spawns()).length, 1);
    const records = w.records();
    assert.equal(records.length, 1);
    assert.equal(records[0].messages[0].content, '#hold:g 第一句\n对');
    assert.equal(records[0].messages.filter((message: any) => message.role === 'assistant').length, 1, 'the unvoiced text is not archived: one reply, the one that answers both');
    assert.equal(assistantText(records[0]), w.text(r2));
    assert.deepEqual(w.rewards, ['chat', 'appraisal']);
    assert.equal(w.journal.length, 1);
    assert.equal(w.journal[0].written, true);
    assert.equal(w.journal[0].dropped, unvoiced.length, 'the dropped characters are counted');
    await nextLineStaysWarm(w);
  });
});

test('timing 3b, her reply written in full but not sounding yet: it waits for her voice; an add-on drops it', CALL_TEST, async () => {
  await callWorld(async w => {
    await w.say('第一句');
    const r1 = await until(() => w.starts().length === 1 && w.completed.length === 1, 'written in full').then(() => w.starts()[0]);
    assert.equal(w.terminal(r1), undefined, 'it does not count before her voice starts');
    // No wait needed (and no service.flush: it stops open turns, which keeps what they held): the host marks the reply complete for
    // the call's reading only after the leg's finish has awaited the archive chain, so anything written for it is already in the record.
    assert.equal(assistantText(w.records()[0]), '', 'nothing of it archived yet');
    await w.say('第二句');
    await settled(w, 2);
    assert.equal(w.terminal(r1)?.dropped, true);
    assert.deepEqual(await w.claude.controls(), [], 'nothing to interrupt: the turn had finished');
    assert.ok(w.stops >= 1, 'her reading queue was cleared (it held the written reply)');
    assert.equal((await w.claude.spawns()).length, 1);
    const second = (await prompts(w))[1];
    assert.ok(second.includes(ADD_ON) && !second.includes(SHOWN));
    const records = w.records();
    assert.equal(records.length, 1);
    assert.equal(assistantText(records[0]), '好哒，第二句', 'the first reply is not archived');
    assert.deepEqual(w.rewards, ['chat', 'appraisal']);
    assert.equal(w.journal[0].dropped, '好哒，第一句'.length);
  });
});

test('timing 3c, written in full and her voice starts: it stands, archived once; no add-on', CALL_TEST, async () => {
  await callWorld(async w => {
    await w.say('第一句');
    await until(() => w.completed.length === 1, 'written in full');
    const [r1] = w.starts();
    w.voiced(r1);
    await settled(w, 1);
    assert.equal(w.terminal(r1)?.complete, true);
    assert.equal(w.terminal(r1)?.dropped, undefined);
    assert.equal(assistantText(w.records()[0]), '好哒，第一句');
    assert.deepEqual(w.rewards, ['chat', 'appraisal']);
    assert.deepEqual(w.journal, []);
  });
});

test('timing 3d, written in full and no voice at all: after the wait it stands as before', CALL_TEST, async () => {
  await callWorld(async w => {
    await w.say('第一句');
    await until(() => w.completed.length === 1 && w.timers.length === 1, 'waiting for her voice');
    assert.equal(w.timers[0].ms, 6000);
    w.fire();
    await settled(w, 1);
    assert.equal(w.terminal(w.starts()[0])?.complete, true);
    assert.equal(assistantText(w.records()[0]), '好哒，第一句');
    assert.deepEqual(w.rewards, ['chat', 'appraisal']);
  });
});

test('timing 4, after her voice started: today\'s barge-in rules (a short line is held; a clear sentence interrupts, nothing dropped)', CALL_TEST, async () => {
  await callWorld(async w => {
    await w.say('#hold:g 第一句');
    await until(() => w.starts().length === 1 && w.text(w.starts()[0]).length > 0, 'first text');
    const [r1] = w.starts();
    w.voiced(r1);
    await w.say('对', { seconds: 0.3, expectHeld: true });
    assert.deepEqual(w.held, [{ kind: 'fragment', overHer: true }], 'a short line over her voice is held as before');
    await w.say('我想说一个完整的句子', { seconds: 1.2 });
    assert.deepEqual(w.interrupts, ['chars']); // I-204: three recognized characters
    await w.claude.release('g');
    await until(() => w.starts().length === 2 && w.completed.includes(w.starts()[1]), 'second reply');
    w.voiced(w.starts()[1]);
    await until(() => !!w.terminal(w.starts()[1]), 'second reply counted');
    await w.host.drain(); await w.service.flush();
    assert.equal(w.terminal(r1)?.dropped, undefined, 'a reply she has started saying is never dropped');
    assert.deepEqual(w.journal, []);
    const messages = w.records().flatMap(record => record.messages);
    assert.deepEqual(messages.filter((message: any) => message.role === 'user').map((message: any) => message.content), ['#hold:g 第一句', '我想说一个完整的句子'],
      'two utterances, each archived once');
    assert.ok(messages.some((message: any) => message.role === 'assistant' && message.content.startsWith('好哒，#hold:g 第一句')), 'the first reply is kept');
    assert.equal((await w.claude.spawns()).length, 1);
  });
});

test('the 22:29 timeline: the user was already talking when her voice started; the line that lands after it still joins (nothing of hers archived)', CALL_TEST, async () => {
  // Dev journal 2026-11-23 22:29: the second line was spoken 0.7 s after the first, her first sound came while it was still being
  // recognized; the window had closed, so it was a barge-in and the first reply's text stayed in the archive.
  await callWorld(async w => {
    await w.say('#hold:g 第一句', { seconds: 0.7 });
    await until(() => w.starts().length === 1 && w.text(w.starts()[0]).length > 0, 'first text');
    const [r1] = w.starts(), unvoiced = w.read.get(r1)!;
    w.advance(700);
    w.speechStart(); // the second line begins before she makes a sound
    w.voiced(r1);    // her voice starts while the user is still talking / the clip is being recognized
    assert.equal(w.addOn.open(r1), true, 'the line on its way keeps the window open');
    await w.say('我想说一个完整的句子', { seconds: 1.3 });
    await settled(w, 2);
    const r2 = w.starts()[1];
    assert.equal(w.terminal(r1)?.dropped, true, 'the first reply is dropped');
    assert.deepEqual(w.interrupts, [], 'not a barge-in');
    assert.deepEqual(w.held, []);
    assert.ok(w.cancelled.includes(r1) && !w.completed.includes(r1));
    const records = w.records();
    assert.equal(records.length, 1);
    assert.equal(records[0].messages[0].content, '#hold:g 第一句\n我想说一个完整的句子');
    assert.equal(assistantText(records[0]), w.text(r2), 'only the reply that answers both is archived');
    assert.deepEqual(w.rewards, ['chat', 'appraisal']);
    assert.equal(w.journal.length, 1);
    assert.equal(w.journal[0].dropped, unvoiced.length);
    assert.equal((await w.claude.spawns()).length, 1);
    await nextLineStaysWarm(w);
  });
});

test('speech began before her voice but came back with no words: she is heard as normal, the reply stands and is archived once', CALL_TEST, async () => {
  await callWorld(async w => {
    await w.say('第一句');
    await until(() => w.completed.length === 1, 'written in full');
    const [r1] = w.starts();
    w.speechStart();
    w.voiced(r1);
    assert.equal(w.addOn.open(r1), true, 'waiting for what the user began to say');
    assert.equal(w.terminal(r1), undefined);
    await w.sayNoise();
    assert.equal(w.addOn.open(r1), false, 'nothing came of it: her voice counts');
    await settled(w, 1);
    assert.equal(w.terminal(r1)?.complete, true);
    assert.equal(assistantText(w.records()[0]), '好哒，第一句', 'archived once, in full');
    assert.deepEqual(w.rewards, ['chat', 'appraisal']);
    assert.deepEqual(w.journal, []);
  });
});

test('speech that never resolves does not hold her voice back for good (the wait ends at the add-on hold)', CALL_TEST, async () => {
  await callWorld(async w => {
    await w.say('第一句');
    await until(() => w.completed.length === 1, 'written in full');
    const [r1] = w.starts();
    w.speechStart();
    w.voiced(r1);
    assert.equal(w.addOn.open(r1), true);
    await until(() => w.timers.length >= 1, 'a timer');
    w.fire();
    assert.equal(w.addOn.open(r1), false);
    await settled(w, 1);
    assert.equal(w.terminal(r1)?.complete, true);
  });
});

test('speech that began after her voice is not an add-on: today\'s barge-in rules', CALL_TEST, async () => {
  await callWorld(async w => {
    await w.say('#hold:g 第一句');
    await until(() => w.starts().length === 1 && w.text(w.starts()[0]).length > 0, 'first text');
    const [r1] = w.starts();
    w.voiced(r1);
    w.speechStart(); // she is already sounding: this is talking over her
    assert.equal(w.addOn.open(r1), false);
    await w.say('我想说一个完整的句子', { seconds: 1.2 });
    assert.deepEqual(w.interrupts, ['chars']);
    assert.equal(w.terminal(r1)?.dropped, undefined);
  });
});

test('the add-on window: filler keeps the echo guard; hang-up and done close it; a late voiced or request changes nothing', () => {
  let call = true, now = 0;
  const timers: { callback: () => void }[] = [];
  const addOn = new CallAddOn({ now: () => now, inCall: () => call, timers: { set: callback => { const t = { callback }; timers.push(t); return t; }, clear() {} } });
  addOn.handed('r1', 'controls');
  assert.equal(addOn.open('r1'), true);
  assert.equal(addOn.herVoice(() => true), false, 'silent while her voice has not started');
  addOn.filler(true);
  assert.equal(addOn.herVoice(() => false), true, 'her filler counts as her voice (echo guard)');
  addOn.filler(false);
  addOn.firstChar('r1', true);
  assert.equal(addOn.open('r1'), true, 'text alone is not an answer while she reads aloud');
  addOn.voiced('r1');
  assert.equal(addOn.open('r1'), false);
  assert.equal(addOn.request('r1'), false, 'after her voice: no add-on');
  addOn.handed('r2', 'controls');
  addOn.firstChar('r2', false);
  assert.equal(addOn.open('r2'), false, 'no reading in the call: her first character answers');
  addOn.handed('r3', 'controls');
  call = false;
  assert.equal(addOn.open('r3'), false, 'not in a call');
  call = true; addOn.clear();
  assert.equal(addOn.open('r3'), false, 'hang-up clears it');
  call = false; addOn.handed('r4', 'controls'); call = true;
  assert.equal(addOn.open('r4'), false, 'outside a call nothing opens');
});

test('the call host passes the verified speech start to the add-on window (VoiceCallHost.heard)', CALL_TEST, async () => {
  const { VoiceCallHost } = await import('../electron/voice/voice-call/host');
  const media = { voiceInput: false, voiceOwner: null as null | string };
  const host = new VoiceCallHost({ now: () => Date.now(), media: () => media as never,
    turnOnVoice: owner => { media.voiceInput = true; media.voiceOwner = owner; return true; }, turnOffVoice() {}, windowShown: () => true, asleep: () => false,
    ttsConfig: () => null, characterId: () => 'c1', mood: () => ({}), keepWarm() {}, broadcast() {}, journal() {}, directory: () => null, synthesize: async () => {} });
  try {
    await host.set('controls', true, 'button');
    host.addOn.handed('r1', 'controls');
    host.heard(); // the window's speech-start
    host.addOn.voiced('r1');
    assert.equal(host.addOn.open('r1'), true, 'a line begun before her voice keeps the window open');
    host.addOn.settled();
    assert.equal(host.addOn.open('r1'), false);
    host.addOn.handed('r2', 'controls');
    host.addOn.voiced('r2'); host.heard();
    assert.equal(host.addOn.open('r2'), false, 'speech that began after her voice: no');
  } finally { host.dispose(); }
});
