import test from 'node:test';
import assert from 'node:assert/strict';
import { MoodTouchChannel } from '../src/ui/mood-touch-channel';
import { DEFAULT_PET_INTERACTION_CONFIG, type PetInteractionConfig } from '../src/ui/PetInteraction';

class Port {
  onmessage: ((event: MessageEvent) => void) | null = null;
  peer: Port | null = null;
  messages: unknown[] = [];
  delayed = false;
  closed = false;
  postMessage(value: unknown): void {
    if (this.closed) throw Error('closed');
    const copy = structuredClone(value); this.messages.push(copy);
    if (!this.delayed) this.peer?.receive(copy);
  }
  receive(value: unknown): void { this.onmessage?.({ data: structuredClone(value) } as MessageEvent); }
  close(): void { this.closed = true; }
}
const pair = () => { const control = new Port(), pet = new Port(); control.peer = pet; pet.peer = control; return { control, pet }; };
const config = (): PetInteractionConfig => ({ ...DEFAULT_PET_INTERACTION_CONFIG, minSpeed: 0.2, maxSpeed: 2 });

test('controls apply only six validated runtime fields and resolve only with the actual pet acknowledgement', async t => {
  const ports = pair(); let applied = 0, actual = { ...DEFAULT_PET_INTERACTION_CONFIG };
  const control = new MoodTouchChannel({ isPet: false, token: () => 'role-model-one', createPort: () => ports.control });
  const pet = new MoodTouchChannel({ isPet: true, token: () => 'role-model-one', createPort: () => ports.pet,
    apply: value => { applied++; actual = { ...value }; return actual; } });
  t.after(() => { control.dispose(); pet.dispose(); });
  assert.deepEqual(await control.request(config()), config());
  assert.deepEqual(actual, config()); assert.equal(applied, 1);
  await assert.rejects(pet.request(config()), /不可用/);
  ports.pet.receive(ports.control.messages[0]);
  assert.equal(applied, 1, 'a repeated request only repeats the acknowledgement, never the reset/application');
  assert.equal(ports.pet.messages.length, 2);
  await assert.rejects(control.request({ ...config(), path: '/private/path' }));
  assert.equal(ports.control.messages.length, 1, 'unknown fields are rejected before transport');
});

test('wrong roles, stale scopes, malformed envelopes and unexpected capabilities cannot apply settings', t => {
  const ports = pair(); let applications = 0;
  const control = new MoodTouchChannel({ isPet: false, token: () => 'current', createPort: () => ports.control });
  const pet = new MoodTouchChannel({ isPet: true, token: () => 'current', createPort: () => ports.pet,
    apply: value => { applications++; return value; } });
  t.after(() => { control.dispose(); pet.dispose(); });
  const request = { kind: 'mood-touch-request', id: 'touch-one', token: 'current', config: config() };
  for (const value of [
    { ...request, token: 'old' }, { ...request, id: 'bad/id' }, { ...request, path: 'file:///private' },
    { ...request, config: { ...config(), provider: 'other' } }, { ...request, config: { ...config(), prepareMs: 0 } },
    { ...request, config: { minSpeed: 0.2 } }, { ...request, kind: 'execute' }, null, [],
  ]) ports.pet.receive(value);
  ports.control.receive(request);
  assert.equal(applications, 0);
  assert.ok(ports.pet.messages.every(value => (value as { ok: boolean }).ok === false));
});

test('a pending change cannot report success from a mismatched or malformed acknowledgement', async t => {
  const ports = pair(); ports.control.delayed = true;
  const control = new MoodTouchChannel({ isPet: false, token: () => 'one', createPort: () => ports.control });
  t.after(() => control.dispose());
  let settled = false;
  const result = control.request(config()).then(value => { settled = true; return value; });
  const request = ports.control.messages[0] as { id: string };
  const ack = { kind: 'mood-touch-ack', id: request.id, token: 'one', ok: true, config: config() };
  ports.control.receive({ ...ack, token: 'old' });
  ports.control.receive({ ...ack, arbitrary: true });
  ports.control.receive({ ...ack, config: { ...config(), maxSpeed: 100 } });
  await Promise.resolve(); assert.equal(settled, false);
  ports.control.receive(ack);
  assert.deepEqual(await result, config());
});

test('an absent acknowledgement times out as unconfirmed and unavailable ports remain explicit', async t => {
  const ports = pair(); ports.control.delayed = true;
  const control = new MoodTouchChannel({ isPet: false, token: () => 'one', createPort: () => ports.control, timeoutMs: 100 });
  const unavailable = new MoodTouchChannel({ isPet: false, token: () => 'one', createPort: () => { throw Error('not available'); } });
  t.after(() => { control.dispose(); unavailable.dispose(); });
  await assert.rejects(control.request(config()), /未确认/);
  await assert.rejects(unavailable.request(config()), /通道不可用.*未确认/);
});

test('scope invalidation and disposal reject retained requests and close the listener', async () => {
  const ports = pair(); ports.control.delayed = true;
  let token = 'old';
  const control = new MoodTouchChannel({ isPet: false, token: () => token, createPort: () => ports.control });
  const old = control.request(config()); token = 'new'; control.invalidate();
  await assert.rejects(old, /角色或模型已改变.*未确认/);
  const waiting = control.request(config()); control.dispose();
  await assert.rejects(waiting, /未确认/);
  assert.equal(ports.control.closed, true); assert.equal(ports.control.onmessage, null);
  await assert.rejects(control.request(config()), /不可用/);
});

test('the transport bounds pending requests and rejects instead of accumulating a queue', async t => {
  const ports = pair(); ports.control.delayed = true;
  const control = new MoodTouchChannel({ isPet: false, token: () => 'one', createPort: () => ports.control });
  t.after(() => control.dispose());
  const pending = Array.from({ length: 4 }, () => control.request(config()).catch(error => error));
  await assert.rejects(control.request(config()), /等待确认/);
  control.invalidate();
  assert.ok((await Promise.all(pending)).every(value => value instanceof Error));
});
