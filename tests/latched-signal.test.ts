import test from 'node:test';
import assert from 'node:assert/strict';
import { latchSignal } from '../src/latched-signal';

// Mirrors the preload subscription: an IPC event reaches only the listeners registered at that moment.
function hostChannel() {
  const listeners = new Set<() => void>();
  return {
    subscribe: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    emit: () => { for (const listener of [...listeners]) listener(); },
    get size() { return listeners.size; },
  };
}

test('a recovery sent while the pet renderer is still starting is not lost', () => {
  // The old renderer subscribed only after its startup awaits: the early signal reached no one.
  const late = hostChannel(); let lateRuns = 0;
  late.emit();
  late.subscribe(() => { lateRuns++; });
  assert.equal(lateRuns, 0, 'reproduces the dropped recovery');

  const channel = hostChannel(); let runs = 0;
  const signal = latchSignal(channel.subscribe);
  channel.emit(); // during startup awaits
  assert.equal(runs, 0);
  signal.attach(() => { runs++; });
  assert.equal(runs, 1, 'delivered once the handler is ready');
});

test('repeated early signals run the handler once; later signals run it each time', () => {
  const channel = hostChannel(); let runs = 0;
  const signal = latchSignal(channel.subscribe);
  channel.emit(); channel.emit();
  signal.attach(() => { runs++; });
  assert.equal(runs, 1);
  channel.emit(); channel.emit();
  assert.equal(runs, 3);
});

test('without an early signal attaching runs nothing; dispose unsubscribes', () => {
  const channel = hostChannel(); let runs = 0;
  const signal = latchSignal(channel.subscribe);
  signal.attach(() => { runs++; });
  assert.equal(runs, 0);
  signal.dispose();
  assert.equal(channel.size, 0);
  channel.emit();
  assert.equal(runs, 0);
});
