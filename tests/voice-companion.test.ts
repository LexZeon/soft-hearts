import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/companion';
import { MemoryStore } from '../electron/memory';
import type { VoiceTextLeg, VoiceTextSettlement } from '../electron/voice-text-continuation';

const provider = { kind: 'claude' as const, baseUrl: 'https://voice-fixture.invalid/v1', model: 'fixture' };
async function fixture(run: (service: CompanionService, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-voice-group-unit-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', provider, '公开原创测试角色'); await run(service, directory); }
  finally {
    await service.flush();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('soft-voice-group-unit-'));
    await rm(directory, { recursive: true, force: false });
  }
}
function leg(seq: number, text: string): VoiceTextLeg {
  return { replyId: 'reply-' + seq, groupId: 'voice-group', epoch: 'host-epoch', kind: seq === 1 ? 'initial' : 'continuation', merged: false,
    inputText: seq === 1 ? text : text.split('\n').at(-1)!, priorUserText: seq === 1 ? '' : text.split('\n').slice(0, -1).join('\n'),
    fromSeq: seq, throughSeq: seq, canonicalUserText: text, segments: [] };
}
function settled(seq: number, text: string, replyId: string | null): VoiceTextSettlement {
  return { groupId: 'voice-group', epoch: 'host-epoch', lastSeq: seq, canonicalUserText: text,
    status: replyId ? 'complete' : 'partial', appraisalReplyId: replyId, unsentSequences: [] };
}
function reply(persona: string, text: string): string {
  const marker = persona.match(/<sh-state-[a-f0-9]+>/)?.[0]; assert.ok(marker);
  return `${text}\n${marker}{"context":"support","delta":{"O":2},"confidence":0.9,"reason":"原创测试"}${marker.replace('<', '</')}`;
}

test('two real provider-leg protocols share one user original, one acceptance and one final appraisal; journal reopens correctly', async () => {
  await fixture(async (service, directory) => {
    const events: string[] = [], original = service.mood.event.bind(service.mood);
    service.mood.event = (...args) => { events.push(args[0].type); original(...args); };
    const group = await service.beginVoiceGroup('voice-group', '先说A', '公开角色');
    const visible: string[] = [];
    const first = await group.beginLeg(leg(1, '先说A'), value => visible.push(value));
    first.push(reply(first.persona, '先回应。')); assert.equal((await first.finish('complete')).hasAppraisal, true);
    assert.deepEqual(events, ['chat']); assert.equal(group.speechMood(), null);
    await group.extend('先说A\n不是A是B');
    const second = await group.beginLeg(leg(2, '先说A\n不是A是B'), value => visible.push(value));
    second.push(reply(second.persona, '按B回应。')); await second.finish('complete');
    await group.settle(settled(2, '先说A\n不是A是B', 'reply-2'));
    assert.deepEqual(events, ['chat', 'appraisal']);
    const archived = service.memory.read(group.scope, group.recordId)!;
    assert.deepEqual(archived.messages.map(value => [value.role, value.content, value.status]),
      [['user', '先说A\n不是A是B', 'complete'], ['assistant', '先回应。按B回应。', 'complete']]);
    assert.equal(visible.join(''), '先回应。按B回应。');
    await assert.rejects(async () => group.settle(settled(2, '先说A\n不是A是B', 'reply-2')));
    const fixed = new MemoryStore(directory); await fixed.load();
    assert.equal(fixed.getNotice(), undefined);
    assert.deepEqual(fixed.read(group.scope, group.recordId)!.messages, archived.messages);
  });
});

test('a failed correction cannot select the earlier successful appraisal', async () => {
  await fixture(async service => {
    const events: string[] = [], original = service.mood.event.bind(service.mood);
    service.mood.event = (...args) => { events.push(args[0].type); original(...args); };
    const group = await service.beginVoiceGroup('voice-group', 'A', '公开角色');
    const first = await group.beginLeg(leg(1, 'A'), () => {});
    first.push(reply(first.persona, '已回复A')); await first.finish('complete');
    await group.extend('A\nB'); const second = await group.beginLeg(leg(2, 'A\nB'), () => {});
    second.push('部分B'); await second.finish('error');
    await group.settle(settled(2, 'A\nB', null));
    assert.deepEqual(events, ['chat']); assert.equal(group.speechMood(), null);
    assert.equal(service.memory.read(group.scope, group.recordId)!.messages[1].status, 'stopped');
  });
});

test('context invalidation during actual finishTurn await prevents late appraisal, gesture and speech identity', async () => {
  await fixture(async service => {
    const events: string[] = [], originalEvent = service.mood.event.bind(service.mood);
    service.mood.event = (...args) => { events.push(args[0].type); originalEvent(...args); };
    const group = await service.beginVoiceGroup('voice-group', 'A', '公开角色');
    const first = await group.beginLeg(leg(1, 'A'), () => {});
    first.push(reply(first.persona, '完成正文')); await first.finish('complete');
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const originalFinish = service.memory.finishTurn.bind(service.memory);
    service.memory.finishTurn = async (...args) => { entered(); await barrier; return originalFinish(...args); };
    const settlement = group.settle(settled(1, 'A', 'reply-1')); await reached;
    const changing = service.context('other', provider, '另一角色');
    assert.equal(group.speechMood(), null); release(); await settlement; await changing;
    assert.deepEqual(events, ['chat']); assert.equal(group.speechMood(), null);
    assert.equal(service.currentScope().characterId, 'other');
  });
});

test('archive refusal pauses continuation without another acceptance or candidate', async () => {
  await fixture(async service => {
    const group = await service.beginVoiceGroup('voice-group', 'A', '公开角色');
    service.memory.extendOpenUser = async () => false;
    await assert.rejects(group.extend('A\nB'));
    await assert.rejects(group.beginLeg(leg(2, 'A\nB'), () => {}));
    assert.equal(group.speechMood(), null); await assert.rejects(group.finish('error'));
    const record = service.memory.read(group.scope, group.recordId)!;
    assert.equal(record.messages.filter(value => value.role === 'user').length, 1);
    assert.equal(record.messages[0].content, 'A'); assert.equal(record.messages[1].status, 'error');
  });
});

test('same-tick revocation drains already accepted user extension and visible reply into their old archive', async () => {
  await fixture(async service => {
    const group = await service.beginVoiceGroup('voice-group', 'A', '公开角色');
    const visible: string[] = [], first = await group.beginLeg(leg(1, 'A'), value => visible.push(value));
    first.push('已显示的正文');
    const extension = group.extend('A\n已接受的补充');
    const cancelled = group.finish('stopped');
    first.push('取消后不得接收');
    await assert.rejects(extension); await cancelled;
    const record = service.memory.read(group.scope, group.recordId)!;
    assert.equal(record.messages[0].content, 'A\n已接受的补充');
    assert.equal(record.messages[1].content, '已显示的正文');
    assert.equal(record.messages[1].status, 'stopped');
    assert.equal(visible.join(''), '已显示的正文'); assert.equal(group.speechMood(), null);
  });
});

test('active-leg archive failure still attempts terminal archive and releases the streaming slot while reporting the error', async () => {
  await fixture(async service => {
    const group = await service.beginVoiceGroup('voice-group', 'A', '公开角色');
    const first = await group.beginLeg(leg(1, 'A'), () => {});
    const originalAppend = service.memory.appendAssistant.bind(service.memory);
    service.memory.appendAssistant = async () => { throw Error('fixture transient archive failure'); };
    first.push('不能丢失失败事实');
    await assert.rejects(group.finish('stopped'));
    service.memory.appendAssistant = originalAppend;
    assert.equal(service.memory.read(group.scope, group.recordId)!.messages[1].status, 'error');
    assert.equal(group.speechMood(), null);
    const next = await service.begin('after-archive-failure', '下一句', '公开角色', () => {});
    await next.finish('complete');
  });
});

// F4 (docs/claude/2026-11-03-draft-first-char.md): a leg whose whole reply was an internal draft is a failed reply, as in
// ordinary chat: nothing shown, no appraisal candidate, no reward, archived once as 'error'. Synthetic plans (X-237's sentence
// and a paraphrase), never a real reply.
const PLANS = ['这一轮回复短些，语气带点傲娇。', '又被夸了。回复短点，自嘲一下。'];
function rounds(service: CompanionService): { count: number } {
  const counted = { count: 0 }, original = service.relationship.noteRound.bind(service.relationship);
  service.relationship.noteRound = async (...args) => { counted.count++; return original(...args); };
  return counted;
}
function moodEvents(service: CompanionService): string[] {
  const events: string[] = [], original = service.mood.event.bind(service.mood);
  service.mood.event = (...args) => { events.push(args[0].type); original(...args); };
  return events;
}

test('a leg the draft filter emptied fails: no candidate, archived once as error, no appraisal, round or reading', async () => {
  for (const plan of PLANS) for (const chunked of [false, true]) await fixture(async service => {
    const events = moodEvents(service), counted = rounds(service);
    const group = await service.beginVoiceGroup('voice-group', '夸你一下', '公开角色');
    const visible: string[] = [];
    const only = await group.beginLeg(leg(1, '夸你一下'), value => visible.push(value));
    const raw = reply(only.persona, plan);
    if (chunked) for (const character of raw) only.push(character); else only.push(raw);
    const completion = await only.finish('complete');
    assert.deepEqual(completion, { status: 'error', coveredThroughSeq: 1, hasAppraisal: false }, plan);
    assert.equal((await only.finish('complete')).status, 'error', 'a repeated finish changes nothing');
    assert.equal(visible.join(''), '', 'not one character of the plan was shown');
    // The session settles a failed leg as partial (the user's words come back as a draft).
    await group.settle(settled(1, '夸你一下', null));
    assert.deepEqual(events, ['chat'], 'the mood never moves');
    assert.equal(counted.count, 0, 'no chat round');
    assert.equal(group.speechMood(), null, 'nothing is read aloud');
    const record = service.memory.read(group.scope, group.recordId)!;
    assert.deepEqual(record.messages.map(value => [value.role, value.content, value.status]),
      [['user', '夸你一下', 'complete'], ['assistant', '', 'error']], 'one failed reply, archived once');
    assert.equal(service.memory.list(group.scope).total, 1);
    await assert.rejects(async () => group.settle(settled(1, '夸你一下', null)), 'settled once');
  });
});

test('an emptied leg is never rewarded, even when a caller settles it as complete with its reply id', async () => {
  await fixture(async service => {
    const events = moodEvents(service), counted = rounds(service);
    const group = await service.beginVoiceGroup('voice-group', 'A', '公开角色');
    const first = await group.beginLeg(leg(1, 'A'), () => {});
    first.push(reply(first.persona, '先回应。')); await first.finish('complete');
    await group.extend('A\n夸你一下');
    const second = await group.beginLeg(leg(2, 'A\n夸你一下'), () => {});
    second.push(reply(second.persona, PLANS[0]));
    assert.equal((await second.finish('complete')).status, 'error');
    await group.settle(settled(2, 'A\n夸你一下', 'reply-2'));
    assert.deepEqual(events, ['chat']); assert.equal(counted.count, 0); assert.equal(group.speechMood(), null);
    const record = service.memory.read(group.scope, group.recordId)!;
    assert.deepEqual(record.messages.map(value => [value.content, value.status]), [['A\n夸你一下', 'complete'], ['先回应。', 'error']],
      'what the first leg really said stays; the utterance is one failed reply');
  });
});

test('an emptied leg that is stopped, cancelled or outlived by a context change is not turned into a failure', async () => {
  // Stopped: the filter's verdict is never asked for.
  await fixture(async service => {
    const group = await service.beginVoiceGroup('voice-group', '夸你一下', '公开角色');
    const only = await group.beginLeg(leg(1, '夸你一下'), () => {});
    only.push(reply(only.persona, PLANS[0]));
    assert.equal((await only.finish('stopped')).status, 'stopped');
    await group.settle(settled(1, '夸你一下', null));
    assert.equal(service.memory.read(group.scope, group.recordId)!.messages[1].status, 'stopped');
  });
  // The context changed before the leg finished: a late finish stays a stop.
  await fixture(async service => {
    const events = moodEvents(service);
    const group = await service.beginVoiceGroup('voice-group', '夸你一下', '公开角色');
    const only = await group.beginLeg(leg(1, '夸你一下'), () => {});
    only.push(reply(only.persona, PLANS[0]));
    const scope = group.scope, recordId = group.recordId;
    await service.context('other', provider, '另一角色');
    assert.equal((await only.finish('complete')).status, 'stopped');
    await group.finish('stopped').catch(() => {});
    assert.deepEqual(events, ['chat']);
    assert.equal(service.memory.read(scope, recordId)?.messages[1]?.status, 'stopped');
  });
  // Emptied, then the user cancelled before the settlement: the later stop wins, archived once.
  await fixture(async service => {
    const group = await service.beginVoiceGroup('voice-group', '夸你一下', '公开角色');
    const only = await group.beginLeg(leg(1, '夸你一下'), () => {});
    only.push(reply(only.persona, PLANS[0]));
    assert.equal((await only.finish('complete')).status, 'error');
    await group.finish('stopped');
    assert.equal(service.memory.read(group.scope, group.recordId)!.messages[1].status, 'stopped');
    assert.equal(group.speechMood(), null);
  });
  // Emptied, settled, and the context changed before the archive was closed: a stop, like any outdated reply.
  await fixture(async service => {
    const group = await service.beginVoiceGroup('voice-group', '夸你一下', '公开角色');
    const only = await group.beginLeg(leg(1, '夸你一下'), () => {});
    only.push(reply(only.persona, PLANS[0]));
    assert.equal((await only.finish('complete')).status, 'error');
    const scope = group.scope, recordId = group.recordId;
    const settling = group.settle(settled(1, '夸你一下', null));
    const changing = service.context('other', provider, '另一角色');
    await settling; await changing;
    assert.equal(service.memory.read(scope, recordId)!.messages[1].status, 'stopped');
  });
});

test('a leg whose draft was cut but whose reply still shows completes as before', async () => {
  await fixture(async service => {
    const events = moodEvents(service);
    const group = await service.beginVoiceGroup('voice-group', '夸你一下', '公开角色');
    const visible: string[] = [];
    const only = await group.beginLeg(leg(1, '夸你一下'), value => visible.push(value));
    only.push(reply(only.persona, `${PLANS[0]}\n\n哼，才不是因为你夸我才开心的！`));
    assert.deepEqual(await only.finish('complete'), { status: 'complete', coveredThroughSeq: 1, hasAppraisal: true });
    await group.settle(settled(1, '夸你一下', 'reply-1'));
    assert.equal(visible.join(''), '哼，才不是因为你夸我才开心的！');
    assert.deepEqual(events, ['chat', 'appraisal']);
    assert.equal(service.memory.read(group.scope, group.recordId)!.messages[1].status, 'complete');
    assert.ok(group.speechMood());
  });
});
