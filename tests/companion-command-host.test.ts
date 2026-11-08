import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompanionCommandHost, validCompanionAction, type CommandCommitResult } from '../electron/companion-command-host';
import type { CompanionCommandCandidate, CompanionCommandView } from '../shared/companion-commands';

test('volume actions admit only the fixed absolute integer-percent field without boolean or generic settings authority', () => {
  for (const value of [0, 40, 100]) assert.equal(validCompanionAction({ actionId: 'voice.set-volume', parameters: { value } }), true);
  for (const value of [NaN, Infinity, -Infinity, -1, 101, 40.5, true, '40', null])
    assert.equal(validCompanionAction({ actionId: 'voice.set-volume', parameters: { value } }), false);
  for (const action of [
    { actionId: 'voice.set-volume', parameters: { value: 40, enabled: true } },
    { actionId: 'voice.set-volume', parameters: { percent: 40 } },
    { actionId: 'voice.set-rate', parameters: { value: 40 } },
    { actionId: 'settings.patch', parameters: { value: 40 } },
    { actionId: 'pet.set-visible', parameters: { value: 40 } },
  ]) assert.equal(validCompanionAction(action), false);
});

const action = (value: boolean) => ({ actionId: 'pet.set-always-on-top' as const, parameters: { value } });
function fixture(candidate: CompanionCommandCandidate = { kind: 'explicit', action: action(true) }) {
  let time = 0, id = 0, value = false, revision = 0, context = 'card-model-owner', writes = 0;
  let commit: (v: boolean) => Promise<CommandCommitResult> = async desired => {
    if (desired === value) return { persistence: 'unchanged', presentation: 'applied', value };
    writes++; value = desired; revision++;
    return { persistence: 'saved', presentation: 'applied', value };
  };
  let enqueue = async <T>(job: () => Promise<T>): Promise<T> => job();
  const views: CompanionCommandView[] = [];
  const host = new CompanionCommandHost({ now: () => time, id: () => `choice-${++id}`,
    target: owner => owner === 7 && context ? { contextId: context, value, revision } : null,
    classify: () => candidate, format: r => `${r.status}/${r.persistence}/${r.presentation}`,
    enqueue: job => enqueue(job), commit: v => commit(v), publish: v => views.push(v) });
  const admit = (requestId = 'request1', source: 'current-human' | 'screen' | 'model' | 'history' | 'quoted' = 'current-human') =>
    host.admit({ requestId, owner: 7, window: 'controls', text: '保持桌宠置顶', source });
  return { host, admit, views, state: () => ({ value, revision, writes }),
    manual: (v: boolean) => { value = v; revision++; }, context: (v: string) => { context = v; },
    time: (v: number) => { time = v; }, candidate: (v: CompanionCommandCandidate) => { candidate = v; },
    commit: (v: typeof commit) => { commit = v; }, enqueue: (v: typeof enqueue) => { enqueue = v; } };
}
const ambiguous: CompanionCommandCandidate = { kind: 'clarify', prompt: '要让其他窗口能盖住桌宠吗？',
  choices: [{ label: '取消置顶', action: action(false) }, { label: '保持置顶', action: action(true) }] };

test('explicit host human command consumes once and reports actual save', async () => {
  const f = fixture(), ticket = f.admit()!;
  const result = await f.host.run(ticket);
  assert.equal(result?.receipt?.status, 'saved'); assert.equal(result?.receipt?.value, true);
  assert.equal(f.state().writes, 1); assert.equal(await f.host.run(ticket), null);
  assert.equal(f.admit(), null);
});
test('ambiguity is inert; repeated or cross-window choice cannot commit twice', async () => {
  const f = fixture(ambiguous), offer = await f.host.run(f.admit()!);
  assert.equal(f.state().writes, 0); assert.equal(offer?.choices.length, 3);
  const request = { requestId: 'request1', choiceId: offer!.choices[1].choiceId };
  assert.equal(await f.host.choose(8, request), null);
  const replies = await Promise.all([f.host.choose(7, request), f.host.choose(7, request)]);
  assert.equal(f.state().writes, 1); assert.equal(replies.filter(Boolean).length, 1);
});
test('cancel is host-issued single use and has no write', async () => {
  const f = fixture(ambiguous), offer = await f.host.run(f.admit()!);
  const c = { requestId: 'request1', choiceId: offer!.choices[2].choiceId };
  assert.equal((await f.host.choose(7, c))?.receipt?.status, 'cancelled');
  assert.equal(await f.host.choose(7, c), null); assert.equal(f.state().writes, 0);
});
test('model/screen/history/quoted admissions grant nothing and cannot cancel a human offer', async () => {
  const f = fixture(ambiguous), offer = await f.host.run(f.admit()!);
  for (const source of ['model', 'screen', 'history', 'quoted'] as const) assert.equal(f.admit(source, source), null);
  assert.equal((await f.host.choose(7, { requestId: 'request1', choiceId: offer!.choices[2].choiceId }))?.receipt?.status, 'cancelled');
  assert.equal(f.state().writes, 0);
});
test('unknown actions, coercion, extra fields and prototype payloads are refused', () => {
  for (const bad of [ { kind: 'explicit', action: { actionId: 'shell', parameters: { value: true } } },
    { kind: 'explicit', action: { ...action(true), confirmed: true } },
    { kind: 'explicit', action: { actionId: 'pet.set-always-on-top', parameters: { value: 'true' } } },
    Object.assign(Object.create({ authority: true }), { kind: 'explicit', action: action(true) }) ]) {
    const f = fixture(bad as CompanionCommandCandidate); assert.throws(() => f.admit()); assert.equal(f.state().writes, 0);
  }
});
test('only exact request/choice identities are accepted', async () => {
  const f = fixture(ambiguous), offer = await f.host.run(f.admit()!);
  assert.equal(await f.host.choose(7, { requestId: 'other', choiceId: offer!.choices[0].choiceId }), null);
  assert.equal(await f.host.choose(7, { requestId: 'request1', choiceId: 'forged' }), null);
  await assert.rejects(f.host.choose(7, { requestId: 'request1', choiceId: offer!.choices[0].choiceId, confirmed: true }));
  assert.equal(await f.host.run({ opaque: {} }), null); assert.equal(f.state().writes, 0);
});
test('expiry and changed character/model/hidden target reject stale choice', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => f.time(60_000),
    (f: ReturnType<typeof fixture>) => f.context('different-card'), (f: ReturnType<typeof fixture>) => f.context('')]) {
    const f = fixture(ambiguous), offer = await f.host.run(f.admit()!); change(f);
    assert.equal((await f.host.choose(7, { requestId: 'request1', choiceId: offer!.choices[1].choiceId }))?.receipt?.status, 'expired');
    assert.equal(f.state().writes, 0);
  }
});
test('a new current human turn and stale cancel do not affect the newer turn', async () => {
  const f = fixture(ambiguous), old = await f.host.run(f.admit()!);
  const next = await f.host.run(f.admit('request2')!); f.host.invalidate('request1');
  assert.equal(await f.host.choose(7, { requestId: 'request1', choiceId: old!.choices[1].choiceId }), null);
  assert.equal((await f.host.choose(7, { requestId: 'request2', choiceId: next!.choices[1].choiceId }))?.receipt?.status, 'saved');
});
test('related revision catches ABA even when the boolean returned to its old value', async () => {
  const f = fixture(ambiguous), offer = await f.host.run(f.admit()!);
  f.manual(true); f.manual(false);
  assert.equal((await f.host.choose(7, { requestId: 'request1', choiceId: offer!.choices[1].choiceId }))?.receipt?.status, 'conflict');
  assert.equal(f.state().writes, 0);
});
test('CAS runs inside the shared serialized queue, not before it', async () => {
  const f = fixture(); f.enqueue(async job => { f.manual(true); return job(); });
  assert.equal((await f.host.run(f.admit()!))?.receipt?.status, 'conflict'); assert.equal(f.state().writes, 0);
});
test('failed-before-commit result is distinct from actual saved/presentation failure', async () => {
  const f = fixture(); f.commit(async () => ({ persistence: 'not-committed', presentation: 'not-requested' }));
  assert.equal((await f.host.run(f.admit()!))?.receipt?.status, 'failed'); assert.equal(f.state().value, false);
  const g = fixture(); g.commit(async v => { g.manual(v); return { persistence: 'saved', presentation: 'failed', value: v }; });
  const receipt = (await g.host.run(g.admit()!))!.receipt!;
  assert.equal(receipt.status, 'saved'); assert.equal(receipt.presentation, 'failed'); assert.equal(g.state().value, true);
});
test('an adapter throw is unknown commit status, never an invented not-saved result', async () => {
  const f = fixture(); f.commit(async () => { throw Error('no acknowledgement'); });
  assert.equal((await f.host.run(f.admit()!))?.receipt?.persistence, 'unknown');
});
test('cancel during issued save cannot claim not-committed or overwrite a newer turn', async () => {
  const f = fixture(); let release!: () => void;
  f.commit(async value => { await new Promise<void>(r => { release = r; }); f.manual(value);
    return { persistence: 'saved', presentation: 'applied', value }; });
  const pending = f.host.run(f.admit()!); await Promise.resolve();
  f.host.invalidate('request1');
  assert.equal(f.views.at(-1)?.receipt?.persistence, 'unknown');
  f.candidate(ambiguous); await f.host.run(f.admit('request2')!);
  const count = f.views.length; release(); assert.equal(await pending, null);
  assert.equal(f.views.length, count); assert.equal(f.state().value, true);
});
test('none preserves ordinary chat and an unavailable target never executes an explicit command', async () => {
  const f = fixture({ kind: 'none' }); assert.equal(f.admit(), null); assert.equal(f.views.length, 0);
  const g = fixture(); g.context('');
  assert.equal((await g.host.run(g.admit()!))?.receipt?.status, 'expired'); assert.equal(g.state().writes, 0);
});
