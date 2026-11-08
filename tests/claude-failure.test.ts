import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyClaudeFailure, parseResetTime, parseRetryAfterMs } from '../shared/claude-failure';

// Samples. REAL = the text the user saw on this machine on 2026-11-02 (given in the task).
// RECALLED = formats Claude Code / Node / the Anthropic SDK are known to print, written from memory and
// not captured here; they are only as good as that memory, which is why anything unfamiliar is `other`.
const NOW = Date.UTC(2026, 10, 2, 18, 0, 0); // 2026-11-02 18:00Z = 10:00 in Los Angeles (PST), 02:00 Nov 3 in Shanghai.
const LA = 'America/Los_Angeles', SH = 'Asia/Shanghai';

const REAL_SESSION_LIMIT = "You've hit your session limit · resets 1:20pm (America/Los_Angeles)";
const REAL_CANT_REACH = "Can't reach the API server";
// Also REAL (coordinator, 2026-11-02): the session limit again, this time reported with HTTP 429 / rate_limit.
const REAL_SESSION_LIMIT_429 = "You've hit your session limit · resets 6:20pm (America/Los_Angeles)";
// REAL (coordinator, 2026-11-02, the "..." are the coordinator's own elisions): a TLS-inspecting proxy.
const REAL_CERTIFICATE = 'API Error: Unable to connect to API: SSL certificate verification failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE) ... TLS-inspecting corporate proxy ...';

test('REAL: a session limit delivered as HTTP 429 / rate_limit is still the allowance, not "too busy"', () => {
  const at = Date.UTC(2026, 10, 3, 1, 0, 0); // 17:00 in Los Angeles; 6:20pm is still ahead
  const expected = Date.UTC(2026, 10, 3, 2, 20); // 6:20pm PST on Nov 2
  assert.deepEqual(classifyClaudeFailure(REAL_SESSION_LIMIT_429, at, SH), { kind: 'quota', resumeAt: expected });
  // The wrapper below is a reconstruction of how it was reported; the point is that the limit text wins over 429 / rate_limit.
  const wrapped = `API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"${REAL_SESSION_LIMIT_429}"}}`;
  assert.deepEqual(classifyClaudeFailure(wrapped, at, SH), { kind: 'quota', resumeAt: expected });
  assert.deepEqual(classifyClaudeFailure(`${REAL_SESSION_LIMIT_429} (429 rate_limit)`, at, SH), { kind: 'quota', resumeAt: expected });
});

test('REAL: a certificate failure is its own kind, not "offline"', () => {
  assert.deepEqual(classifyClaudeFailure(REAL_CERTIFICATE, NOW), { kind: 'certificate' });
  const samples = [
    'API Error: Unable to connect to API: SSL certificate verification failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
    'unable to get local issuer certificate (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)',
    'Error: self-signed certificate in certificate chain (SELF_SIGNED_CERT_IN_CHAIN)',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED',
    'Hostname/IP does not match certificate\'s altnames (ERR_TLS_CERT_ALTNAME_INVALID)',
  ];
  for (const sample of samples) assert.deepEqual(classifyClaudeFailure(sample, NOW), { kind: 'certificate' }, sample);
  // Plain connection failures keep their own kind, even with the same "Unable to connect to API" opening.
  assert.deepEqual(classifyClaudeFailure('API Error: Unable to connect to API (ENOTFOUND)', NOW), { kind: 'network' });
  assert.deepEqual(classifyClaudeFailure('API Error: Unable to connect to API (ECONNRESET)', NOW), { kind: 'network' });
});

test('REAL: session limit with a reset time and a zone', () => {
  assert.deepEqual(classifyClaudeFailure(REAL_SESSION_LIMIT, NOW, SH), { kind: 'quota', resumeAt: Date.UTC(2026, 10, 2, 21, 20) });
  // The zone in the text wins over the machine's own zone.
  assert.equal(classifyClaudeFailure(REAL_SESSION_LIMIT, NOW, 'UTC').resumeAt, Date.UTC(2026, 10, 2, 21, 20));
});

test('REAL: cannot reach the API server is the network', () => {
  assert.deepEqual(classifyClaudeFailure(REAL_CANT_REACH, NOW), { kind: 'network' });
  assert.deepEqual(classifyClaudeFailure("API Error: Can't reach the API server. Check your connection.", NOW), { kind: 'network' });
});

test('reset times: 12-hour, 24-hour, rolling to tomorrow, and daylight saving in the named zone', () => {
  // Today's 1:20pm in Los Angeles has not happened yet at 10:00 PST.
  assert.equal(parseResetTime('resets 1:20pm (America/Los_Angeles)', NOW), Date.UTC(2026, 10, 2, 21, 20));
  // After it has passed, the next one is tomorrow.
  assert.equal(parseResetTime('resets 1:20pm (America/Los_Angeles)', Date.UTC(2026, 10, 2, 22, 0)), Date.UTC(2026, 10, 3, 21, 20));
  // Summer: Los Angeles is UTC-7, so the same wall clock is an hour earlier in UTC.
  assert.equal(parseResetTime('resets 1:20pm (America/Los_Angeles)', Date.UTC(2026, 6, 1, 12, 0)), Date.UTC(2026, 6, 1, 20, 20));
  // No minutes, no zone: the machine's zone (Shanghai is UTC+8: 3pm = 07:00Z; NOW is 02:00 Nov 3 there, so Nov 3).
  assert.equal(parseResetTime('5-hour limit reached ∙ resets 3pm', NOW, SH), Date.UTC(2026, 10, 3, 7, 0));
  // 12am / 12pm.
  assert.equal(parseResetTime('resets 12am (UTC)', NOW), Date.UTC(2026, 10, 3, 0, 0));
  assert.equal(parseResetTime('resets 12pm (UTC)', Date.UTC(2026, 10, 2, 1, 0)), Date.UTC(2026, 10, 2, 12, 0));
  // 24-hour clock, with a zone, and "at".
  assert.equal(parseResetTime('usage limit reached, resets 13:20 (Europe/Paris)', NOW), Date.UTC(2026, 10, 3, 12, 20));
  assert.equal(parseResetTime('limit reached. Resets at 9:05 (Asia/Shanghai)', NOW), Date.UTC(2026, 10, 3, 1, 5));
  // A date and a weekday.
  assert.equal(parseResetTime("You've hit your weekly limit · resets Nov 5, 3pm (America/Los_Angeles)", NOW), Date.UTC(2026, 10, 5, 23, 0));
  assert.equal(parseResetTime('resets Nov 5 at 3pm (America/Los_Angeles)', NOW), Date.UTC(2026, 10, 5, 23, 0));
  assert.equal(parseResetTime('resets Fri 9am (Asia/Shanghai)', NOW), Date.UTC(2026, 10, 6, 1, 0)); // Fri Nov 6 09:00 CST
  // Relative and the older epoch suffix.
  assert.equal(parseResetTime('resets in 2 hours', NOW), NOW + 2 * 3_600_000);
  assert.equal(parseResetTime('Claude AI usage limit reached|1793600000', 1_793_500_000_000), 1_793_600_000_000);
});

test('reset times that cannot be placed give nothing instead of a guess', () => {
  assert.equal(parseResetTime('resets 15', NOW), null, 'a bare number could be anything');
  assert.equal(parseResetTime('resets 1:20pm (Not/AZone)', NOW), null);
  assert.equal(parseResetTime('resets 25:61', NOW), null);
  assert.equal(parseResetTime('resets 13pm (UTC)', NOW), null);
  assert.equal(parseResetTime('resets Feb 30, 3pm (UTC)', NOW), null);
  assert.equal(parseResetTime('Claude usage limit reached|1700000000', NOW), null, 'an epoch in the past is not a wait');
  assert.equal(parseResetTime('your limit will reset sometime', NOW), null);
  assert.equal(parseResetTime('resets 3 more minutes', NOW), null);
  assert.equal(classifyClaudeFailure("You've hit your session limit · resets 1:20pm (Not/AZone)", NOW).resumeAt, undefined);
  assert.equal(classifyClaudeFailure("You've hit your session limit · resets 1:20pm (Not/AZone)", NOW).kind, 'quota');
});

test('quota: every fixed phrase, with the reset time when there is one', () => {
  const samples = [
    REAL_SESSION_LIMIT,
    "You've hit your weekly limit · resets Nov 5, 3pm (America/Los_Angeles)",
    "You've hit your Opus limit · resets 3pm (America/Los_Angeles)",
    "You’ve hit your limit · resets 2am (Asia/Shanghai)",
    'Claude AI usage limit reached|1793600000',
    'Claude usage limit reached|1793600000',
    '5-hour limit reached ∙ resets 3pm',
    'Credit balance is too low',
    'API Error: usage limit exceeded for this organization',
  ];
  for (const sample of samples) assert.equal(classifyClaudeFailure(sample, 1_793_500_000_000, SH).kind, 'quota', sample);
  assert.equal(classifyClaudeFailure('Credit balance is too low', NOW).resumeAt, undefined);
  // A quota text that also tells the user to /login is still a quota.
  assert.equal(classifyClaudeFailure("You've hit your session limit · resets 1:20pm (UTC). Run /login to use another account.", NOW).kind, 'quota');
});

test('login expired: the messages Claude Code prints for a missing or dead login', () => {
  const samples = [
    'Not logged in · Please run /login',
    'Invalid API key · Please run /login',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}',
    'Failed to authenticate. API Error: 401 Invalid bearer token',
    'OAuth token has been revoked',
  ];
  for (const sample of samples) assert.deepEqual(classifyClaudeFailure(sample, NOW), { kind: 'login-expired' }, sample);
});

test('network: the codes and phrases of a connection that did not work', () => {
  const samples = [
    REAL_CANT_REACH,
    'API Error: Unable to connect to API (ENOTFOUND)',
    'getaddrinfo ENOTFOUND api.anthropic.com',
    'read ECONNRESET',
    'connect ETIMEDOUT 160.79.104.10:443',
    'API Error: Connection error.',
    'API Error: Request timed out.',
    'TypeError: fetch failed',
    'getaddrinfo EAI_AGAIN api.anthropic.com',
  ];
  for (const sample of samples) assert.deepEqual(classifyClaudeFailure(sample, NOW), { kind: 'network' }, sample);
});

test('not found: the app\'s own words and the shell\'s', () => {
  const samples = [
    '未找到 Claude Code。请先安装官方 Claude Code 并运行 claude 完成登录，或把 CLAUDE_PATH 设为 claude.exe 的完整路径。',
    '无法启动 Claude Code，请确认已安装并能在终端运行 claude。',
    'CLAUDE_PATH 指向的 Claude Code 可执行文件不存在。',
    'spawn claude ENOENT',
    "'claude' is not recognized as an internal or external command, operable program or batch file.",
    'bash: claude: command not found',
  ];
  for (const sample of samples) assert.deepEqual(classifyClaudeFailure(sample, NOW), { kind: 'not-found' }, sample);
});

test('rate limited: 429 and overloaded, with the wait when the text gives one', () => {
  const body = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\'s rate limit."}}';
  assert.deepEqual(classifyClaudeFailure(body, NOW), { kind: 'rate-limited' });
  assert.deepEqual(classifyClaudeFailure('429 Too Many Requests. retry-after: 30', NOW), { kind: 'rate-limited', resumeAt: NOW + 30_000 });
  assert.deepEqual(classifyClaudeFailure('API Error: 429 rate_limit_error. Please try again in 2 minutes.', NOW), { kind: 'rate-limited', resumeAt: NOW + 120_000 });
  assert.deepEqual(classifyClaudeFailure('{"retry_after": 45, "error": "rate_limit"}', NOW), { kind: 'rate-limited', resumeAt: NOW + 45_000 });
  assert.equal(classifyClaudeFailure('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', NOW).kind, 'rate-limited');
  assert.equal(classifyClaudeFailure('API Error: Overloaded', NOW).kind, 'rate-limited');
  assert.equal(classifyClaudeFailure('Too many requests', NOW).kind, 'rate-limited');
  assert.equal(parseRetryAfterMs('retry-after: 0'), null);
  assert.equal(parseRetryAfterMs('retry-after: 99999999'), null, 'a wait above a day is not a wait');
  assert.equal(parseRetryAfterMs('no wait here'), null);
});

test('anything else, including texts that merely look related, is other', () => {
  const samples = [
    '', '   ', undefined, null, 42, {},
    'Claude 回复超时，已停止。',
    'Claude 没有返回文字。请检查 Claude Code 登录状态。', // mentions the login, but the cause is unknown
    "error: unknown option '--safe-mode'",
    'Claude 输出过长，已停止。',
    'Claude 聊天通道意外请求了工具，已停止。',
    '这轮聊天所属的角色或对话已改变。',
    'Claude Code 意外退出，已停止。',
    'I counted 401 apples and 429 pears', // bare numbers next to no error word
    'The limit of my patience resets daily',
    'something went wrong',
  ];
  for (const sample of samples) assert.deepEqual(classifyClaudeFailure(sample, NOW), { kind: 'other' }, String(sample));
});

test('classification reads only a bounded prefix and never throws', () => {
  const long = 'x'.repeat(100_000) + REAL_SESSION_LIMIT;
  assert.deepEqual(classifyClaudeFailure(long, NOW), { kind: 'other' });
  assert.doesNotThrow(() => classifyClaudeFailure('resets \u0000 99:99 (((', NOW));
});
