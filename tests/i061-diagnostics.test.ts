// I-061 一键诊断: the journal's link-state line (shared/safety/claude-link-diag.ts + shared/memory/journal.ts) and the 「复制诊断信息」 text
// (shared/safety/diagnostics.ts). The boundary is fed hostile input: paths with the user name, token-looking strings, chat text in
// fields the formatter must never look at, an endpoint, an email, a private character's model name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LINK_FAILURES, claudeVersionOf, classifyLinkFailure, linkExplanation } from '../shared/safety/claude-link-diag';
import { buildJournalEntry, describeJournalEntry, readJournalLine } from '../shared/memory/journal';
import { diagnosticTime, formatDiagnostics, problemLabel, recentProblems, scrubDiagnostics, type DiagnosticsInput } from '../shared/safety/diagnostics';
import { buildDiagnostics, diagnosticChannel } from '../electron/safety/agent-channel/diagnostics';
import { AgentChannelHost } from '../electron/safety/agent-channel/host';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { uiText } from '../src/foundation/ui-language';
import { AgentChannelPanel } from '../src/safety/AgentChannelPanel';

const AT = new Date(2026, 10, 10, 7, 30).getTime();
const USER = 'yourname';
const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));

// ------------------------------------------------------------------ closed categories

test('Claude Code version: only a plain three-number version survives, from `claude --version` output or nothing', () => {
  assert.equal(claudeVersionOf('2.1.319 (Claude Code)\n'), '2.1.319');
  assert.equal(claudeVersionOf('claude 2.1.316'), '2.1.316');
  assert.equal(claudeVersionOf('error: C:\\Users\\yourname\\AppData\\claude.exe not found'), null);
  assert.equal(claudeVersionOf('1.2.3.4'), null, 'a longer dotted number is not a version');
  assert.equal(claudeVersionOf(undefined), null);
  assert.equal(claudeVersionOf({ toString: () => '2.1.319' }), null);
});

test('link failures become a category: the 2.1.319 refusal is "arguments", a timeout is "timeout", the text itself is never kept', () => {
  const real = '没能自动接上你的 Claude Code（Invalid environment variable format: soft-hearts-next-dev, environment variables should be added as: -e KEY1=value1 -e KEY2=value2）。可以复制下面的命令自己运行一次。';
  assert.equal(classifyLinkFailure(real), 'arguments');
  assert.equal(classifyLinkFailure('没能自动接上你的 Claude Code（没有在时限内结束）。可以复制下面的命令自己运行一次。'), 'timeout');
  assert.equal(classifyLinkFailure('没能自动接上你的 Claude Code（spawn C:\\Users\\yourname\\x\\claude.exe ENOENT）。'), 'cannot-start');
  assert.equal(classifyLinkFailure('没能自动接上你的 Claude Code（EACCES: permission denied, open .claude.json）。'), 'permission');
  assert.equal(classifyLinkFailure('没能自动接上你的 Claude Code（退出码 1）。'), 'exit-code');
  assert.equal(classifyLinkFailure('没能在配置目录里记下改动进度，为了不弄丢登记，这次没有改 soft-hearts-next。'), 'journal');
  assert.equal(classifyLinkFailure('soft-hearts-next 刚被别的登记占用了（不是这个配置自动登记的），没有动它。'), 'name-taken');
  assert.equal(classifyLinkFailure('没能把 soft-hearts-next 改成这个版本（退出码 1）。原来的登记没动。'), 'repoint');
  assert.equal(classifyLinkFailure('something nobody anticipated'), 'other');
  assert.equal(classifyLinkFailure(undefined), 'other');
  for (const failure of LINK_FAILURES) assert.ok(linkExplanation('failed', failure).includes('没能自动接上你的 Claude Code'));
});

// ------------------------------------------------------------------ the journal line

test('journal line: closed state, failure only on failed, a hostile version is dropped, extra fields never reach the line', () => {
  const ok = buildJournalEntry({ type: 'claude-link', characterId: null, state: 'failed', failure: 'arguments', version: '2.1.319', trigger: 'auto' }, AT)!;
  assert.deepEqual({ state: ok.type === 'claude-link' && ok.state, failure: ok.type === 'claude-link' && ok.failure, version: ok.type === 'claude-link' && ok.version }, { state: 'failed', failure: 'arguments', version: '2.1.319' });
  const hostile = buildJournalEntry({ type: 'claude-link', characterId: null, state: 'failed', failure: 'arguments', version: `C:\\Users\\${USER}\\claude.exe`, trigger: 'auto',
    message: 'a chat sentence', path: `C:\\Users\\${USER}`, command: 'claude mcp add --env=TOKEN=abcdefabcdefabcdefabcdef' }, AT)!;
  const json = JSON.stringify(hostile);
  assert.ok(!/yourname|chat sentence|TOKEN|mcp add/.test(json), json);
  assert.equal((hostile as { version?: string }).version, undefined);
  // The failure category is defaulted for a failed line without one, and refused on any other state.
  assert.equal((buildJournalEntry({ type: 'claude-link', characterId: null, state: 'failed', trigger: 'auto' }, AT) as { failure?: string }).failure, 'other');
  assert.equal(buildJournalEntry({ type: 'claude-link', characterId: null, state: 'linked', failure: 'timeout', trigger: 'auto' }, AT), null);
  assert.equal(buildJournalEntry({ type: 'claude-link', characterId: null, state: 'checking', trigger: 'auto' }, AT), null);
  assert.equal(buildJournalEntry({ type: 'claude-link', characterId: null, state: 'idle', trigger: 'auto' }, AT), null);
  assert.equal(buildJournalEntry({ type: 'claude-link', characterId: null, state: 'linked', trigger: 'by hand' }, AT), null);
  assert.equal(buildJournalEntry({ type: 'claude-link', characterId: null, state: 'failed', failure: 'C:\\Users\\yourname', trigger: 'auto' }, AT), null);
  // It reads back from a file line the same way.
  assert.deepEqual(readJournalLine(JSON.stringify(ok)), ok);
});

test('journal line reads in both languages and holds no path or command', () => {
  const entry = buildJournalEntry({ type: 'claude-link', characterId: null, state: 'failed', failure: 'arguments', version: '2.1.319', trigger: 'manual' }, AT)!;
  const zh = describeJournalEntry(entry, plain);
  assert.match(zh, /内部通道没能接上你的 Claude Code（Claude Code 不认我们给它的命令参数/);
  assert.match(zh, /Claude Code 2\.1\.319，你点了重新接上/);
  setUiLanguage('en');
  try {
    const en = describeJournalEntry(entry, uiText);
    assert.match(en, /could not link to your Claude Code \(Claude Code rejected the command arguments/);
    assert.ok(!/[\u4e00-\u9fff]/u.test(en), en);
    const unknown = describeJournalEntry(buildJournalEntry({ type: 'claude-link', characterId: null, state: 'linked', trigger: 'auto' }, AT)!, uiText);
    assert.match(unknown, /linked \(version unknown, automatic check\)/);
  } finally { setUiLanguage('zh-CN'); }
});

// ------------------------------------------------------------------ the diagnostics block

const entries = (extra: unknown[] = []) => [
  { type: 'speech', at: AT - 6 * 3_600_000, characterId: 'private-akiko', provider: 'bailian', failure: 'network' },
  { type: 'reply-check', at: AT - 5 * 3_600_000, residue: ['field-name'], marker: 'on', rules: [], before: 0, cut: 0, whole: false },
  { type: 'first-char', at: AT - 4 * 3_600_000, ms: 6200, pauseTalk: false, carried: false },
  { type: 'first-char', at: AT - 3.5 * 3_600_000, ms: 900, pauseTalk: false, carried: false },
  { type: 'claude-link', at: AT - 3 * 3_600_000, state: 'failed', failure: 'arguments', version: '2.1.319', trigger: 'auto' },
  ...extra,
];

function input(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return { app: { version: '0.9.4', commit: 'cf3c35ba1234567890abcdef1234567890abcdef', channel: 'stable' }, os: { platform: 'win32', release: '10.0.28000', arch: 'arm64' },
    claudeCodeVersion: '2.1.319', interconnect: true, channelOpen: true,
    link: { state: 'failed', failure: 'arguments', checkedAt: AT - 60_000 }, journalEnabled: true, entries: entries(), ...over };
}

test('the block: versions, system, channel and link state with its explanation, the last problems with times', () => {
  const text = formatDiagnostics(input());
  assert.match(text, /^soft hearts diagnostics\napp: 0\.9\.4 \(commit cf3c35ba1234\), channel stable\nsystem: Windows 11 10\.0\.28000, arm64\nClaude Code: 2\.1\.319\n/);
  assert.match(text, /internal channel: 三方互通 on, channel open/);
  assert.match(text, /link state: failed \(arguments\)\nlink meaning: 没能自动接上你的 Claude Code：Claude Code 不认我们给它的命令参数/);
  assert.match(text, new RegExp(`link last checked: ${diagnosticTime(AT - 60_000)}`));
  assert.match(text, /recent problems \(last 4, oldest first\):/);
  const list = text.split('\n').filter(line => line.startsWith('- '));
  assert.deepEqual(list.map(line => line.slice(19)), ['speech: network', 'reply-check residue', 'first-char 6.2 s', 'claude-link: failed (arguments)']);
  assert.ok(list.every(line => /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} /.test(line)), 'each problem has a time');
  assert.ok(!text.includes('first-char 0.9'), 'a fast reply is not a problem');
});

test('unknowns say unknown, a link never checked says so, a journal that is off lists nothing', () => {
  const text = formatDiagnostics(input({ app: { version: 'x', commit: 'nothex', channel: 'beta' }, claudeCodeVersion: undefined, link: null, journalEnabled: false,
    os: { platform: 'plan9', release: 'weird', arch: 'mips' } }));
  assert.match(text, /app: unknown \(commit unknown\), channel unknown/);
  assert.match(text, /system: unknown OS unknown version, unknown arch/);
  assert.match(text, /Claude Code: unknown/);
  assert.match(text, /link state: not checked in this run/);
  assert.match(text, /the experience log is off, so none are listed/);
  assert.equal(formatDiagnostics(input({ entries: [] })).includes('recent problems: none in the recent log'), true);
});

test('only the last five problems are listed, newest last', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ type: 'pause-stuck', at: AT + i * 60_000, what: 'speech-route' }));
  const found = recentProblems(many);
  assert.equal(found.length, 5);
  assert.deepEqual(found.map(item => item.at), many.slice(4).map(item => item.at));
});

test('hostile input: paths with the user name, token-looking strings, chat text in other fields, an endpoint, an email, a private model name never reach the text', () => {
  const tokens = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const hostile = formatDiagnostics({
    app: { version: `0.9.4 C:\\Users\\${USER}\\AppData`, commit: `C:\\Users\\${USER}\\x`, channel: `C:\\Users\\${USER}` },
    os: { platform: 'win32', release: `10.0.28000 ${USER}@example.com`, arch: `x64 ${tokens}` },
    claudeCodeVersion: `2.1.319 ${tokens}`,
    interconnect: `\\\\.\\pipe\\soft-hearts-${USER}-token-${tokens}`, channelOpen: 'http://127.0.0.1:5555/?token=' + tokens,
    link: { state: `failed ${USER}`, failure: `C:\\Users\\${USER}\\claude.exe`, checkedAt: `C:\\Users\\${USER}` },
    journalEnabled: true,
    entries: [
      // chat text, a character's model name and a path sitting in fields the formatter must not copy
      { type: 'speech', at: AT, failure: `network ${tokens}`, characterId: 'akiko-private-model.pmx', text: '今天我好想你，我妈妈的电话是 13800000000', path: `C:\\Users\\${USER}\\akiko.pmx` },
      { type: 'reply-check', at: AT, residue: ['field-name', `C:\\Users\\${USER}`], reply: '亲爱的，晚安', before: 3, cut: 0, rules: [], marker: 'on', whole: false },
      { type: 'first-char', at: AT, ms: 7000, message: 'my password is hunter2', model: 'Akiko-Private-Model' },
      { type: 'claude-link', at: AT, state: 'failed', failure: `C:\\Users\\${USER}`, version: `C:\\Users\\${USER}\\claude.exe`, command: `claude mcp add --env=KEY=${tokens}` },
      { type: 'app', at: AT, event: 'start', stopped: 'unclean', version: `0.1 ${USER}`, commit: tokens },
      { type: 'mood-event', at: AT, source: 'touch', reason: 'chat text again' },
    ],
  });
  for (const forbidden of [USER, 'Users', 'AppData', tokens.slice(0, 20), 'sk-ant', 'example.com', '127.0.0.1', 'pipe', 'token=', '今天我好想你', '13800000000', '亲爱的', '晚安',
    'hunter2', 'akiko', 'Akiko', '.pmx', 'mcp add', 'KEY=', 'password', 'C:\\']) assert.ok(!hostile.includes(forbidden), `"${forbidden}" leaked:\n${hostile}`);
  // What is allowed is the closed category, so the problems are still listed, with the hostile detail replaced.
  assert.match(hostile, /speech: other/);
  assert.match(hostile, /reply-check residue/);
  assert.match(hostile, /first-char 7\.0 s/);
  assert.match(hostile, /claude-link: failed \(other\)/);
  assert.match(hostile, /app: previous run did not end cleanly/);
  assert.ok(!hostile.includes('mood-event'), 'a line that is not a problem is not listed');
  assert.match(hostile, /app: unknown \(commit unknown\), channel unknown/);
});

test('the last-pass scrub removes a path, an address, an email and a long token even if one slipped into the text', () => {
  const out = scrubDiagnostics(`a C:\\Users\\${USER}\\x b /Users/${USER}/y c \\\\server\\share\\z d ${USER}@mail.example e https://example.com/a?token=1 f ${'A1b2'.repeat(8)} g 2.1.319 h cf3c35ba1234`);
  assert.ok(!out.includes(USER) && !out.includes('example') && !out.includes('A1b2'), out);
  assert.match(out, /g 2\.1\.319 h cf3c35ba1234/);
});

test('problem labels: every label comes from a closed set', () => {
  assert.equal(problemLabel({ type: 'draft-filter', whole: true }), 'draft-filter: whole reply removed');
  assert.equal(problemLabel({ type: 'draft-filter', whole: false }), null);
  assert.equal(problemLabel({ type: 'claude-link', state: 'linked' }), null);
  assert.equal(problemLabel({ type: 'claude-link', state: 'missing' }), 'claude-link: missing');
  assert.equal(problemLabel({ type: 'motion', kind: 'block' }), 'motion: color block');
  assert.equal(problemLabel({ type: 'reading-time', result: 'unread', why: 'failed' }), 'reading: failed');
  assert.equal(problemLabel('a chat sentence'), null);
  assert.equal(problemLabel(null), null);
  assert.equal(diagnosticChannel('stable'), 'stable');
  assert.equal(diagnosticChannel('development'), 'dev');
  assert.equal(diagnosticChannel(undefined), 'source');
});

// ------------------------------------------------------------------ the host: link checks are remembered and reported

async function withHost(t: test.TestContext, linker: () => Promise<{ state: any; name: string; message: string; claudeVersion?: string }>, checks: unknown[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sh-i061-'));
  const host = new AgentChannelHost({ profileDirectory: dir, tools: [], confirm: async () => true, linkClaudeCode: async () => linker(), linkDelayMs: 0,
    linkChecked: check => { checks.push(check); }, now: () => AT });
  t.after(async () => { await host.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  return host;
}

test('a finished link check is handed to the journal with a category and the version, and the diagnostics block carries it', async t => {
  const checks: unknown[] = [];
  const message = '没能自动接上你的 Claude Code（Invalid environment variable format: soft-hearts-next）。可以复制下面的命令自己运行一次。';
  const host = await withHost(t, async () => ({ state: 'failed', name: 'soft-hearts-next', message, claudeVersion: '2.1.319' }), checks);
  await host.init();
  await host.relinkClaudeCode();
  assert.deepEqual(checks, [{ state: 'failed', failure: 'arguments', version: '2.1.319', trigger: 'manual', at: AT }]);
  assert.ok(!JSON.stringify(checks).includes('Invalid environment'), 'Claude Code\'s own words are not passed on');
  const facts = host.diagnosticFacts();
  assert.equal(facts.interconnect, true); assert.equal(facts.channelOpen, true); assert.equal(facts.claudeVersion, '2.1.319');
  const text = buildDiagnostics(host, { commit: 'cf3c35ba12', channel: 'development', journalEnabled: true, entries: () => entries() },
    { version: '0.9.4', platform: 'win32', release: '10.0.22631', arch: 'x64' });
  assert.match(text, /app: 0\.9\.4 \(commit cf3c35ba12\), channel dev/);
  assert.match(text, /system: Windows 11 10\.0\.22631, x64/);
  assert.match(text, /link state: failed \(arguments\)/);
  assert.ok(!text.includes('Invalid environment') && !text.includes('soft-hearts-next'), text);
});

test('a linker that throws is a failed check; a journal that throws never undoes the check', async t => {
  const checks: unknown[] = [];
  const dir = await mkdtemp(path.join(tmpdir(), 'sh-i061-'));
  const host = new AgentChannelHost({ profileDirectory: dir, tools: [], confirm: async () => true, linkDelayMs: 0, now: () => AT,
    linkClaudeCode: async () => { throw new Error(`boom at C:\\Users\\${USER}\\x`); }, linkChecked: check => { checks.push(check); throw new Error('journal broke'); } });
  t.after(async () => { await host.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  await host.init();
  await host.relinkClaudeCode();
  assert.equal(checks.length, 1);
  assert.equal((checks[0] as { state: string }).state, 'failed');
  assert.ok(!JSON.stringify(checks).includes(USER));
  assert.equal(host.diagnosticFacts().link?.state, 'failed');
});

// ------------------------------------------------------------------ the control window's button

class Element {
  children: Element[] = []; className = ''; textContent: string | null = ''; type = ''; checked = false; disabled = false; hidden = false;
  dataset: Record<string, string> = {}; onchange: (() => void) | null = null; onclick: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = [...children]; }
  setAttribute() {}
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const flush = () => new Promise(resolve => setImmediate(resolve));

test('the button asks the host for the text and copies exactly that; it is hidden when the host has no such call', async () => {
  (globalThis as any).document = { createElement: (tag: string) => new Element(tag) };
  const copied: string[] = [], errors: string[] = [];
  const base = { get: async () => ({ enabled: false, listening: false, connections: 0, lastAction: null }), setEnabled: async () => ({}) as any, changed: () => () => {},
    copy: async (text: string) => { copied.push(text); }, error: (message: string) => errors.push(message) };
  const root = new Element('div');
  new AgentChannelPanel(root as any, { ...base, diagnostics: async () => 'soft hearts diagnostics\napp: test' });
  const wrap = all(root).find(node => node.className === 'agent-channel-diagnostics')!;
  const button = all(root).find(node => node.dataset.agentChannel === 'copy-diagnostics')!;
  assert.equal(wrap.hidden, false); assert.equal(button.textContent, '复制诊断信息');
  button.onclick!(); await flush();
  assert.deepEqual(copied, ['soft hearts diagnostics\napp: test']);
  assert.equal(button.textContent, '已复制');
  assert.deepEqual(errors, []);
  const none = new Element('div');
  new AgentChannelPanel(none as any, base);
  assert.equal(all(none).find(node => node.className === 'agent-channel-diagnostics')!.hidden, true);
  const failing = new Element('div');
  new AgentChannelPanel(failing as any, { ...base, diagnostics: async () => { throw new Error('no'); } });
  all(failing).find(node => node.dataset.agentChannel === 'copy-diagnostics')!.onclick!(); await flush();
  assert.equal(errors.length, 1);
});
