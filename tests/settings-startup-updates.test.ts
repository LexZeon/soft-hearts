// 2026-11-25 (docs/claude/2026-11-25-first-turn-empty.md): a window listened for settings broadcasts only at the end of its startup, so a
// change the host made meanwhile (the bundled model picking its card: persona and model) was lost; the next broadcast then looked like a
// card change and the control window cleared her conversation right after the user's first message. These drive the startup the way
// src/main.ts init() does (load first, a long startup, attach at the end) against a stand-in host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsStartup } from '../src/settings/startup-updates';

interface Host { persona: string; model: string | null }

function standInHost(initial: Host) {
  let current = { ...initial };
  const listeners = new Set<(next: Host) => void>();
  let reads = 0;
  return {
    subscribe(callback: (next: Host) => void) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    async read() { reads++; return { ...current }; },
    change(next: Partial<Host>) { current = { ...current, ...next }; for (const listener of listeners) listener({ ...current }); },
    get reads() { return reads; },
    get listening() { return listeners.size; },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a change made while the window starts reaches the handler once it attaches (the host is read again)', async () => {
  const host = standInHost({ persona: 'old card', model: null });
  const startup = settingsStartup<Host>({ subscribe: callback => host.subscribe(callback), read: () => host.read() });
  let settings = await startup.load(); // src/wiring/settings-wiring.ts loadSettings
  assert.equal(host.listening, 1, 'listening from the first read on');
  // ... the window's startup runs on (stage, mood, memory panels); meanwhile the bundled model picks its card:
  host.change({ model: 'gene.pmx' });
  host.change({ persona: 'Gene card' });
  const seen: Host[] = [];
  startup.attach(next => { seen.push(next); settings = next; }); // wireSettingsUpdates
  await tick();
  assert.deepEqual(settings, { persona: 'Gene card', model: 'gene.pmx' });
  assert.equal(seen.length, 1, 'one catch-up, the host read again (never the older broadcasts replayed)');
  // A later broadcast with the same card is not a change any more: the control window keeps her conversation.
  host.change({ model: 'gene.pmx' });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].persona, settings.persona);
});

test('nothing changed during startup: no extra read; later broadcasts go straight to the handler', async () => {
  const host = standInHost({ persona: 'card', model: 'm' });
  const startup = settingsStartup<Host>({ subscribe: callback => host.subscribe(callback), read: () => host.read() });
  await startup.load();
  const seen: Host[] = [];
  startup.attach(next => seen.push(next));
  await tick();
  assert.equal(host.reads, 1);
  assert.equal(seen.length, 0);
  host.change({ persona: 'edited' });
  assert.deepEqual(seen, [{ persona: 'edited', model: 'm' }]);
  startup.dispose();
  host.change({ persona: 'after' });
  assert.equal(seen.length, 1, 'disposed: no more deliveries');
  assert.equal(host.listening, 0);
});

test('the old order (read, then listen at the end of startup) loses the change: the case this replaces', async () => {
  const host = standInHost({ persona: 'old card', model: null });
  let settings = await host.read();
  host.change({ persona: 'Gene card', model: 'gene.pmx' }); // nobody listening yet
  host.subscribe(next => { settings = next; });
  await tick();
  assert.equal(settings.persona, 'old card', 'the window still holds the old card: the next broadcast would look like a card change');
});
