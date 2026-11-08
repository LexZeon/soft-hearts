import test from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { R20ProactiveOffers, type R20ProactiveOfferDependencies } from '../electron/r20-proactive-offer';
import type { R20ProactiveOfferView } from '../shared/r20-proactive-offer';

const candidate = JSON.stringify({ question: '需要我先帮你梳理计划吗？', goal: '整理安排', plan: '先列出步骤和取舍。', scopeHint: '确认目标和范围' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function fixture(options: { generation?: Promise<string>; presentation?: Promise<boolean> } = {}) {
  let now = 10000, identity = 'card-provider-1', shown = true, generationCount = 0;
  const gate = new ProactiveSpeechGate(() => now); gate.setScope('gate-1');
  const archived: string[] = [], confirmations: Array<{ prompt: string; current: () => boolean }> = [], events: string[] = [];
  const surface = { waitForPresentation: async () => options.presentation ?? true, isPresentationCurrent: () => shown };
  const deps: R20ProactiveOfferDependencies = {
    gate, context: () => ({ identity, gateScope: 'gate-1', persona: '温和', mood: '平静' }),
    eligible: () => true, presentable: () => true, owner: () => 7, humanSender: sender => sender === 7, surface: () => surface,
    generate: async () => { generationCount++; return options.generation ?? candidate; },
    event: event => { events.push(event.type); },
    archive: async (offer, _at, current) => { if (current()) archived.push(offer.id); },
    openTaskConfirmation: (prompt, current) => { confirmations.push({ prompt, current }); },
    now: () => now, createId: () => 'test_offer',
  };
  const host = new R20ProactiveOffers(deps);
  const cue = (id = 'cue-1') => ({ id, kind: 'speech', until: now + 1000 });
  const note = () => host.noteCompleted('completed', '合成用户请求', '合成助手回复');
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const present = async (): Promise<R20ProactiveOfferView> => {
    note(); assert.equal(host.offerOpportunity(cue()), true); await settle();
    const offered = host.get().offer; assert.ok(offered);
    const accepted = await host.acknowledge(7, { id: offered.id, revision: offered.revision }); assert.ok(accepted);
    return accepted;
  };
  return { gate, host, cue, note, settle, present, archived, confirmations, events,
    setNow: (value: number) => { now = value; }, setIdentity: (value: string) => { identity = value; },
    setShown: (value: boolean) => { shown = value; }, generations: () => generationCount,
    close: () => { host.dispose(); gate.dispose(); } };
}

test('actual shared gate excludes another opportunity, and only one real presentation acknowledgement archives', async () => {
  const f = fixture();
  try {
    const occupied = f.gate.tryAcquire({ scope: 'gate-1', opportunityId: 'other', expiresAt: 20000 }, 'ambient'); assert.ok(occupied);
    f.note(); assert.equal(f.host.offerOpportunity(f.cue()), false); occupied.cancel();
    assert.equal(f.host.offerOpportunity(f.cue()), true); assert.equal(f.host.offerOpportunity(f.cue()), true);
    await f.settle(); const offered = f.host.get().offer; assert.ok(offered);
    assert.equal(f.generations(), 1); assert.deepEqual(f.archived, []);
    assert.equal(await f.host.acknowledge(99, { id: offered.id, revision: offered.revision }), null);
    const accepted = await f.host.acknowledge(7, { id: offered.id, revision: offered.revision }); assert.ok(accepted?.presented);
    assert.deepEqual(f.archived, [offered.id]);
    assert.equal(await f.host.acknowledge(7, { id: offered.id, revision: offered.revision }), null);
    assert.deepEqual(f.archived, [offered.id]); assert.equal(f.confirmations.length, 0);
  } finally { f.close(); }
});

test('view and affirmative only open plan/scope, and exact scope opens one existing confirmation draft', async () => {
  const f = fixture();
  try {
    let offer = await f.present();
    const respond = (requestId: string, action: 'view' | 'reply' | 'confirm', extra: Record<string, string> = {}) =>
      f.host.respond(7, { id: offer.id, revision: offer.revision, requestId, action, ...extra });
    let result = respond('view1', 'view'); assert.equal(result.status, 'shown-plan'); assert.ok(result.state.offer); offer = result.state.offer;
    assert.equal(respond('view1', 'view').status, 'stale', 'request id cannot be reused after revision changes');
    assert.equal(f.host.respond(99, { id: offer.id, revision: offer.revision, requestId: 'foreign', action: 'view' }).status, 'stale');
    result = respond('yes1', 'reply', { text: '可以' }); assert.equal(result.status, 'needs-scope'); assert.ok(result.state.offer); offer = result.state.offer;
    assert.equal(f.confirmations.length, 0);
    result = respond('done1', 'confirm', { goal: '整理会议记录', scope: '只规划步骤，不写入文件' });
    assert.equal(result.status, 'confirmation-opened'); assert.equal(f.confirmations.length, 1);
    assert.match(f.confirmations[0].prompt, /整理会议记录/u); assert.match(f.confirmations[0].prompt, /只规划步骤，不写入文件/u);
    assert.match(f.confirmations[0].prompt, /尚未执行/u); assert.equal(f.confirmations[0].current(), true);
    assert.equal(respond('done2', 'confirm', { goal: '另一目标', scope: '另一范围' }).status, 'stale');
    assert.equal(f.confirmations.length, 1); f.setIdentity('different-card'); assert.equal(f.confirmations[0].current(), false);
  } finally { f.close(); }
});

for (const action of ['decline', 'cancel'] as const) test(`${action} consumes the ticket without opening a task draft`, async () => {
  const f = fixture();
  try {
    const offer = await f.present();
    assert.equal(f.host.respond(7, { id: offer.id, revision: offer.revision, requestId: 'end1', action }).status,
      action === 'decline' ? 'declined' : 'cancelled');
    assert.equal(f.host.respond(7, { id: offer.id, revision: offer.revision, requestId: 'late1', action: 'view' }).status, 'stale');
    assert.equal(f.confirmations.length, 0); assert.equal(f.archived.length, 1);
  } finally { f.close(); }
});

test('expired and foreign revision answers cannot open a draft', async () => {
  const f = fixture();
  try {
    const offer = await f.present();
    assert.equal(f.host.respond(7, { id: offer.id, revision: offer.revision - 1, requestId: 'oldrev', action: 'view' }).status, 'stale');
    f.setNow(offer.expiresAt);
    assert.equal(f.host.respond(7, { id: offer.id, revision: offer.revision, requestId: 'expired', action: 'confirm', goal: '目标', scope: '范围' }).status, 'stale');
    assert.equal(f.confirmations.length, 0);
  } finally { f.close(); }
});

test('late generation after context change cannot emit, archive, or create a draft', async () => {
  const generation = deferred<string>(), f = fixture({ generation: generation.promise });
  try {
    f.note(); assert.equal(f.host.offerOpportunity(f.cue()), true); f.setIdentity('different-card'); f.host.sync();
    generation.resolve(candidate); await f.settle();
    assert.equal(f.host.get().offer, null); assert.deepEqual(f.events, []); assert.deepEqual(f.archived, []); assert.equal(f.confirmations.length, 0);
  } finally { f.close(); }
});

test('late native presentation acknowledgement after context change cannot archive or make an offer actionable', async () => {
  const presentation = deferred<boolean>(), f = fixture({ presentation: presentation.promise });
  try {
    f.note(); assert.equal(f.host.offerOpportunity(f.cue()), true); await f.settle();
    const offered = f.host.get().offer; assert.ok(offered);
    const ack = f.host.acknowledge(7, { id: offered.id, revision: offered.revision });
    f.setIdentity('different-card'); f.host.sync(); presentation.resolve(true);
    assert.equal(await ack, null); assert.deepEqual(f.archived, []); assert.equal(f.host.get().offer, null);
    assert.equal(f.host.respond(7, { id: offered.id, revision: offered.revision, requestId: 'late', action: 'view' }).status, 'stale');
    assert.equal(f.confirmations.length, 0);
  } finally { f.close(); }
});
