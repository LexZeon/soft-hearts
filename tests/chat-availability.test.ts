import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatAvailability, failureText } from '../electron/chat-availability';
import { ClaudeFailureError } from '../electron/claude';
import { ClaudeTurnError } from '../electron/claude-process';
import type { ChatAvailabilityView, OutageLineKind } from '../shared/chat-availability';

const NOW = Date.UTC(2026, 10, 2, 18, 0, 0); // 10:00 in Los Angeles
const QUOTA = new ClaudeFailureError('Claude 暂时不可用', "You've hit your session limit · resets 1:20pm (America/Los_Angeles)");
const NETWORK = new ClaudeTurnError('Claude Code 意外退出，已停止。', 'crash', "Can't reach the API server");

function setup(options: { cards?: { key: string } } = {}) {
  const clock = { now: NOW };
  const card = options.cards ?? { key: 'card-a' };
  const views: ChatAvailabilityView[] = [];
  let worked = 0;
  const lines: Record<string, string[]> = {
    'card-a': ['A 额度一', 'A 额度二'], 'card-b': ['B 额度一'],
  };
  const availability = new ChatAvailability({
    now: () => clock.now, localZone: 'Asia/Shanghai', cardKey: () => card.key,
    line: (kind: OutageLineKind, pick: number) => kind === 'quota' ? (lines[card.key]?.[pick % lines[card.key].length] ?? null)
      : kind === 'recovered' ? `${card.key} 回来了` : null,
    changed: view => views.push(view), worked: () => { worked++; },
  });
  return { availability, clock, card, views, worked: () => worked };
}

test('a real quota failure makes chat unavailable with the reset time, and a working turn clears it', () => {
  const { availability, views } = setup();
  assert.deepEqual(availability.view(), { state: 'ok', checking: false });
  assert.equal(availability.isAvailable(), true);
  availability.failure(QUOTA);
  const view = availability.view();
  assert.equal(view.state, 'unavailable');
  assert.equal(view.kind, 'quota');
  assert.equal(view.resumeAt, Date.UTC(2026, 10, 2, 21, 20));
  assert.equal(view.since, NOW);
  assert.equal(views.at(-1)?.kind, 'quota');
  availability.success();
  assert.deepEqual(availability.view(), { state: 'ok', checking: false });
  assert.deepEqual(views.at(-1), { state: 'ok', checking: false, recovered: { line: 'card-a 回来了' } });
});

test('the detail text is classified, not the friendly message made from it', () => {
  assert.equal(failureText(QUOTA), "You've hit your session limit · resets 1:20pm (America/Los_Angeles)");
  assert.equal(failureText(NETWORK), "Can't reach the API server");
  assert.equal(failureText(new Error('无法启动 Claude Code，请确认已安装并能在终端运行 claude。')), '无法启动 Claude Code，请确认已安装并能在终端运行 claude。');
  assert.equal(failureText('plain'), 'plain');
  const { availability } = setup();
  availability.failure(NETWORK);
  assert.equal(availability.view().kind, 'network');
});

test('only the first failure of a kind speaks; the rest stay quiet until chat works again', () => {
  const { availability } = setup();
  const first = new ClaudeFailureError('x', "You've hit your session limit · resets 1:20pm (UTC)");
  const second = new ClaudeFailureError('x', "You've hit your session limit · resets 1:20pm (UTC)");
  availability.failure(first);
  assert.deepEqual(availability.notice(first), { kind: 'quota', speak: true, line: 'A 额度一' });
  assert.equal(availability.notice(first), availability.notice(first), 'asking twice about one error is the same answer');
  availability.failure(second);
  assert.deepEqual(availability.notice(second), { kind: 'quota', speak: false, line: null });
  // A different kind in the same outage is new information: she says it once.
  const network = new ClaudeFailureError('x', 'getaddrinfo ENOTFOUND api.anthropic.com');
  availability.failure(network);
  assert.deepEqual(availability.notice(network), { kind: 'network', speak: true, line: null });
  const again = new ClaudeFailureError('x', 'read ECONNRESET');
  availability.failure(again);
  assert.equal(availability.notice(again)?.speak, false);
  // Recovery clears what she has said; the next outage speaks again, with the next line.
  availability.success();
  const third = new ClaudeFailureError('x', "You've hit your session limit · resets 1:20pm (UTC)");
  availability.failure(third);
  assert.deepEqual(availability.notice(third), { kind: 'quota', speak: true, line: 'A 额度二' });
});

test('a failure that is shown nowhere (a voice turn) does not use up the one announcement', () => {
  const { availability } = setup();
  availability.failure(new ClaudeFailureError('x', "You've hit your session limit · resets 1:20pm (UTC)")); // never asked about
  const typed = new ClaudeFailureError('x', "You've hit your session limit · resets 1:20pm (UTC)");
  availability.failure(typed);
  assert.equal(availability.notice(typed)?.speak, true);
});

test('another character speaks for itself even in the middle of an outage', () => {
  const { availability, card } = setup();
  const one = new ClaudeFailureError('x', "You've hit your session limit · resets 1:20pm (UTC)");
  availability.failure(one);
  assert.equal(availability.notice(one)?.line, 'A 额度一');
  card.key = 'card-b';
  const two = new ClaudeFailureError('x', "You've hit your session limit · resets 1:20pm (UTC)");
  availability.failure(two);
  assert.deepEqual(availability.notice(two), { kind: 'quota', speak: true, line: 'B 额度一' });
});

test('safety stops, a changed conversation and non-errors are not outages', () => {
  const { availability, views } = setup();
  for (const error of [
    new ClaudeFailureError('Claude 聊天通道意外请求了工具，已停止。', '', true),
    new ClaudeTurnError('Claude 聊天通道意外请求了工具，已停止。', 'unsafe'),
    new ClaudeTurnError('这轮聊天所属的角色或对话已改变。', 'closed'),
  ]) {
    availability.failure(error);
    assert.equal(availability.notice(error), undefined);
  }
  assert.equal(availability.view().state, 'ok');
  assert.equal(views.length, 0);
  assert.equal(availability.notice(new Error('never reported')), undefined);
  assert.equal(availability.notice('a string'), undefined);
  assert.equal(availability.notice(null), undefined);
});

test('unrecognised failures are reported as other and clear on the next success', () => {
  const { availability } = setup();
  const error = new ClaudeTurnError('Claude 回复超时，已停止。', 'timeout');
  availability.failure(error);
  assert.equal(availability.view().kind, 'other');
  assert.deepEqual(availability.notice(error), { kind: 'other', speak: true, line: null });
});

test('background callers: the wait depends on the cause, and login or a missing Claude Code never ends by itself', () => {
  const { availability, clock } = setup();
  availability.failure(QUOTA);
  assert.equal(availability.isAvailable(), false);
  clock.now = Date.UTC(2026, 10, 2, 21, 19);
  assert.equal(availability.isAvailable(), false, 'one minute before the stated reset');
  clock.now = Date.UTC(2026, 10, 2, 21, 21);
  assert.equal(availability.isAvailable(), true, 'one try may go through after the reset time');
  availability.failure(QUOTA); // that try failed again, without a usable time now (the reset has passed)
  assert.equal(availability.isAvailable(), false);
  availability.success();

  clock.now = NOW;
  availability.failure(NETWORK);
  assert.equal(availability.isAvailable(), false);
  clock.now = NOW + 61_000;
  assert.equal(availability.isAvailable(), true);
  availability.success();

  for (const detail of ['Not logged in · Please run /login', 'spawn claude ENOENT']) {
    clock.now = NOW;
    availability.failure(new ClaudeFailureError('x', detail));
    clock.now = NOW + 30 * 24 * 3_600_000;
    assert.equal(availability.isAvailable(), false, detail);
    availability.success();
  }
  assert.equal(availability.isAvailable(), true);
});

test('a rate limit with a stated wait resumes after exactly that wait', () => {
  const { availability, clock } = setup();
  availability.failure(new ClaudeFailureError('x', '429 Too Many Requests. retry-after: 30'));
  assert.equal(availability.view().resumeAt, NOW + 30_000);
  clock.now = NOW + 29_000;
  assert.equal(availability.isAvailable(), false);
  clock.now = NOW + 61_000;
  assert.equal(availability.isAvailable(), true);
});

test('the kind and the reset time follow the latest failure while "since" stays', () => {
  const { availability, clock } = setup();
  availability.failure(new ClaudeFailureError('x', 'Credit balance is too low'));
  assert.equal(availability.view().resumeAt, undefined);
  clock.now = NOW + 5 * 60_000;
  availability.failure(QUOTA);
  const view = availability.view();
  assert.equal(view.since, NOW);
  assert.equal(view.resumeAt, Date.UTC(2026, 10, 2, 21, 20));
  availability.failure(NETWORK);
  assert.equal(availability.view().kind, 'network');
  assert.equal(availability.view().resumeAt, undefined, 'a reset time belongs to the quota failure, not to the network one');
});

test('views are published only when something visible changed; checking is part of the view', () => {
  const { availability, views } = setup();
  availability.success(); availability.success();
  assert.equal(views.length, 0, 'nothing was wrong and nothing changed');
  availability.failure(NETWORK);
  availability.failure(NETWORK);
  assert.equal(views.length, 1);
  availability.setChecking(true);
  assert.equal(availability.view().checking, true);
  availability.setChecking(true);
  availability.setChecking(false);
  assert.deepEqual(views.map(view => view.checking), [false, true, false]);
  const seen: ChatAvailabilityView[] = [];
  const stop = availability.subscribe(view => seen.push(view));
  availability.success();
  stop();
  availability.failure(NETWORK);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, 'ok');
});

test('the worked hook runs on every success and never breaks chat', () => {
  const { availability, worked } = setup();
  availability.success(); availability.success();
  assert.equal(worked(), 2);
  const fragile = new ChatAvailability({ worked: () => { throw new Error('boom'); }, line: () => { throw new Error('boom'); }, changed: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => { fragile.failure(NETWORK); fragile.notice(NETWORK); fragile.success(); });
});
