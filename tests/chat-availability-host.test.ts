import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatAvailability } from '../electron/chat-availability';
import { ClaudeFailureError } from '../electron/claude';
import {
  CHAT_AVAILABILITY_METHODS, CLAUDE_NETWORK_CONFIG_URL, CLAUDE_SETUP_URL, NETWORK_SETTINGS_URI,
  ChatAvailabilityHost, registerChatAvailabilityIpc,
} from '../electron/chat-availability-host';
import { OutageLineScheduler } from '../electron/outage-lines';
import { OUTAGE_LINE_KINDS, actionsFor, helpTopicFor } from '../shared/chat-availability';
import { CLAUDE_FAILURE_KINDS } from '../shared/claude-failure';

const LIMIT = new ClaudeFailureError('x', "You've hit your session limit · resets 1:20pm (America/Los_Angeles)");
const OFFLINE = new ClaudeFailureError('x', "Can't reach the API server");
const CERT = new ClaudeFailureError('x', 'API Error: Unable to connect to API: SSL certificate verification failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)');

function setup(options: { probe?: (signal: AbortSignal) => Promise<void>; platform?: NodeJS.Platform } = {}) {
  const availability = new ChatAvailability({ now: () => Date.UTC(2026, 10, 2, 18, 0) });
  const opened: string[] = [];
  const probes: AbortSignal[] = [];
  const host = new ChatAvailabilityHost({ availability, platform: options.platform ?? 'win32',
    probe: async signal => { probes.push(signal); await options.probe?.(signal); },
    openExternal: target => { opened.push(target); } });
  return { availability, host, opened, probes };
}

test('retry: a working answer clears the panel, a failing one shows the newest reason, and nothing is said in chat', async () => {
  let works = false;
  const { availability, host, probes } = setup({ probe: async () => { if (!works) throw OFFLINE; } });
  availability.failure(LIMIT);
  const seen: boolean[] = [];
  availability.subscribe(view => seen.push(view.checking));
  const failed = await host.retry();
  assert.equal(failed.state, 'unavailable');
  assert.equal(failed.kind, 'network', 'the latest failure replaces the old reason');
  assert.equal(failed.checking, false);
  assert.ok(seen.includes(true), 'the panel could show "trying…"');
  works = true;
  const back = await host.retry();
  assert.equal(back.state, 'ok');
  assert.equal(probes.length, 2);
  assert.ok(probes.every(signal => signal instanceof AbortSignal));
  assert.equal(availability.notice(OFFLINE)?.speak, true, 'a probe failure did not use up her one announcement');
});

test('retry: a press while one is running joins it instead of asking Claude twice', async () => {
  let release!: () => void, calls = 0;
  const { host } = setup({ probe: () => { calls++; return new Promise<void>(resolve => { release = resolve; }); } });
  const first = host.retry(), second = host.retry();
  assert.equal(first, second);
  release();
  assert.equal((await first).state, 'ok');
  assert.equal(calls, 1);
  const third = host.retry();
  assert.notEqual(third, first, 'a later press is a new check');
  release();
  await third;
  assert.equal(calls, 2);
});

test('help opens one of two fixed pages by problem, and the network button only the Windows network page', async () => {
  const { availability, host, opened } = setup();
  await host.openHelp();
  availability.failure(CERT);
  await host.openHelp();
  availability.success();
  availability.failure(new ClaudeFailureError('x', 'Not logged in · Please run /login'));
  await host.openHelp();
  await host.openNetworkSettings();
  assert.deepEqual(opened, [CLAUDE_SETUP_URL, CLAUDE_NETWORK_CONFIG_URL, CLAUDE_SETUP_URL, NETWORK_SETTINGS_URI]);
  assert.equal(NETWORK_SETTINGS_URI, 'ms-settings:network');
  assert.match(CLAUDE_SETUP_URL, /^https:\/\/code\.claude\.com\/docs\//);
  assert.match(CLAUDE_NETWORK_CONFIG_URL, /^https:\/\/code\.claude\.com\/docs\//);
  const other = setup({ platform: 'darwin' });
  await assert.rejects(other.host.openNetworkSettings());
  assert.deepEqual(other.opened, []);
});

test('the four IPC operations refuse every argument and otherwise do exactly one fixed thing', async () => {
  const { availability, host, opened, probes } = setup();
  availability.failure(OFFLINE);
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  registerChatAvailabilityIpc((method, operation) => { assert.ok(!registered.has(method), 'registered once'); registered.set(method, operation); }, host);
  assert.deepEqual([...registered.keys()].sort(), [...CHAT_AVAILABILITY_METHODS].sort());
  const hostile: unknown[][] = [['https://evil.example'], ['calc.exe'], [{ url: 'file:///C:/Windows/System32/cmd.exe' }], [null], [undefined], [0], ['', ''], [['ms-settings:privacy']]];
  for (const [method, operation] of registered) {
    for (const args of hostile) assert.throws(() => operation(...args), /不接受参数/, `${method}(${JSON.stringify(args)})`);
  }
  assert.deepEqual(opened, []);
  assert.deepEqual(probes, []);
  assert.equal((registered.get('getChatAvailability')!() as { kind: string }).kind, 'network');
  await registered.get('openClaudeHelp')!();
  await registered.get('openNetworkSettings')!();
  assert.deepEqual(opened, [CLAUDE_SETUP_URL, NETWORK_SETTINGS_URI]);
  await registered.get('retryChatAvailability')!();
  assert.equal(probes.length, 1);
});

test('every failure kind has plain-language actions, a retry among them, and only fixed action names', () => {
  for (const kind of CLAUDE_FAILURE_KINDS) {
    const actions = actionsFor(kind);
    assert.ok(actions.includes('retry'), kind);
    assert.ok(actions.every(action => ['retry', 'help', 'network-settings'].includes(action)), kind);
  }
  assert.deepEqual(actionsFor('network'), ['retry', 'network-settings']);
  assert.deepEqual(actionsFor('certificate'), ['retry', 'help']);
  assert.equal(helpTopicFor('certificate'), 'network-config');
  assert.equal(helpTopicFor('network'), 'setup');
  assert.equal(helpTopicFor(undefined), 'setup');
  for (const kind of CLAUDE_FAILURE_KINDS) assert.ok((OUTAGE_LINE_KINDS as readonly string[]).includes(kind));
});

test('preparing her lines: once, a little after chat works, only when the card has none and no chat is running', () => {
  const calls: string[] = [];
  const timers: (() => void)[] = [];
  let cached = false, busy = false, persona: string | null = 'card A';
  const scheduler = new OutageLineScheduler({
    bank: { lines: () => (cached ? ({} as never) : null), ensure: async text => { calls.push(text); return 'generated'; } },
    persona: () => persona, busy: () => busy,
    timers: { set: callback => { timers.push(callback); return timers.length; }, clear: () => { timers.length = 0; } },
  });
  scheduler.worked(); scheduler.worked(); scheduler.worked();
  assert.equal(timers.length, 1, 'repeated successes make one appointment');
  persona = 'card B'; // the character changed during the wait
  timers.shift()!();
  assert.deepEqual(calls, ['card B']);
  busy = true;
  scheduler.worked();
  timers.shift()!();
  assert.deepEqual(calls, ['card B'], 'not while a chat turn is running');
  busy = false; cached = true;
  scheduler.worked();
  assert.equal(timers.length, 0, 'nothing to prepare');
  cached = false; persona = null;
  scheduler.worked();
  assert.equal(timers.length, 0);
  persona = 'card C';
  scheduler.worked();
  scheduler.dispose();
  assert.equal(timers.length, 0);
});
