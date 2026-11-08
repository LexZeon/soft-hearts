// 2026-11-04: with developer mode on, the app froze for seconds at a time (the isolated smoke ran out of time; both windows
// answered a trivial call after ~5 s). The router asked "is developer mode on?" through `mood.get().developerMode`, and
// get() builds the mood view, whose 调度台 line asks the router, which asked get() again... until the stack overflowed and a
// catch swallowed it. Every view build in developer mode did that. electron/main.ts now reads `mood.isDeveloperMode()`, and
// the view no longer lets the router's source re-enter it.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MoodHost } from '../electron/mood';
import { ModuleRouter } from '../electron/module-router/router';

async function withHost(run: (host: MoodHost) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-mood-router-reentry-'));
  const host = new MoodHost(directory, () => {}, () => Date.UTC(2026, 10, 4, 20));
  try { await host.load(); host.activate('card'); await run(host); }
  finally { await host.flush(); await rm(directory, { recursive: true, force: true }); }
}

test('developer mode: a 调度台 source that reads the mood view back is asked once, not until the stack overflows', async () => {
  await withHost(host => {
    let calls = 0;
    host.setModuleRouterSource(() => { calls++; host.get(); return []; });
    host.setDeveloperMode(true);
    calls = 0;
    const started = performance.now();
    host.get();
    assert.equal(calls, 1, 'the source ran once for this view (it used to run thousands of times, one per stack frame)');
    assert.ok(performance.now() - started < 200, 'building the view stays quick');
  });
});

test('developer mode: the router wired as electron/main.ts wires it keeps the view quick and still shows its line', async () => {
  await withHost(async host => {
    let reads = 0;
    const router = new ModuleRouter({
      ask: async () => '{"calls":[]}', available: () => true,
      developerMode: () => { reads++; return host.isDeveloperMode(); }, changed: () => host.moduleRouterChanged(),
    });
    host.setModuleRouterSource(() => router.recent());
    host.setDeveloperMode(true);
    router.userTurn('turn-1', '今天好累');
    reads = 0;
    const started = performance.now();
    for (let i = 0; i < 20; i++) host.get();
    assert.ok(performance.now() - started < 500, `20 view builds took ${Math.round(performance.now() - started)} ms`);
    assert.ok(reads <= 40, `developer mode was read ${reads} times for 20 views`);
    assert.equal(host.get().moduleRouterWhy?.length, 1, 'the panel still gets the message line');
    host.setDeveloperMode(false);
    assert.equal(host.get().moduleRouterWhy, undefined, 'developer mode off: no line');
    router.dispose();
  });
});
