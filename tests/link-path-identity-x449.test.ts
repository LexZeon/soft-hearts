// Codex X-449 (C238, 2026-11-12): two profile folders that differ only by a space ("合成 Gene" / "合成Gene") were the same
// registration to the link check, because white space was dropped before comparing (to undo Ink wrapping a long list row).
// Now white space inside a path counts; only where the list was broken may it be missing or extra, and a wrapped row is never
// enough to change or remove a registration: that waits for `claude mcp get`. Folders below are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeCodeEntry, linkClaudeCode, ownLaunchLine, sameLaunch, spareName, unreadableFacts, wrappedLine, type ClaudeCodeLinkOptions } from '../electron/safety/agent-channel/claude-code-link';
import type { ShimLaunch } from '../electron/safety/agent-channel/setup-text';

const NAME = 'soft-hearts-next', SPARE = spareName(NAME);
const APP = 'C:\\apps\\soft hearts next';
const OURS = 'C:\\Users\\me\\AppData\\Roaming\\合成Gene', OTHER = 'C:\\Users\\me\\AppData\\Roaming\\合成 Gene';
const launch = (version: string, profile: string): ShimLaunch => ({ command: `${APP}\\${version}\\soft hearts next.exe`,
  args: [`${APP}\\${version}\\resources\\agent-channel\\soft-hearts-mcp.mjs`, '--profile', profile], env: { ELECTRON_RUN_AS_NODE: '1' } });
const NEW = launch('0.5.0', OURS), OLD_OURS = launch('0.4.0', OURS), OLD_OTHER = launch('0.4.0', OTHER), NEW_OTHER = launch('0.5.0', OTHER);
const line = (l: ShimLaunch) => [l.command, ...l.args].join(' ');
const row = (name: string, l: ShimLaunch) => `${name}: ${line(l)} - ✓ Connected`;
/** The row as Ink may draw it: broken at `at` (a character index into the row), white space at the break dropped. */
const broken = (text: string, at: number) => `${text.slice(0, at).trimEnd()}\n${text.slice(at).trimStart()}`;
const list = (...rows: string[]) => ['Checking MCP server health…', '', ...rows, ''].join('\n');
const getText = (l: ShimLaunch) => [`${NAME}:`, '  Scope: User config (available in all your projects)', '  Status: ✔ Connected', '  Type: stdio',
  `  Command: ${l.command}`, `  Args: ${l.args.join(' ')}`, ''].join('\n');

test('a space inside a folder name is part of its identity (the case Codex found)', () => {
  assert.equal(sameLaunch(line(NEW_OTHER), NEW), false);
  assert.equal(sameLaunch(line(NEW), NEW_OTHER), false);
  assert.equal(ownLaunchLine(line(OLD_OTHER), NEW), false, 'another profile is not ours');
  assert.equal(ownLaunchLine(line(OLD_OURS), NEW_OTHER), false);
  assert.equal(ownLaunchLine(line(OLD_OURS), NEW), true, 'our own profile, any version');
  assert.equal(sameLaunch(line(NEW), NEW), true);
  assert.equal(sameLaunch(line(NEW).replace(/\\/g, '/').toUpperCase(), NEW), true, 'case and slashes still do not matter');
});

test('a wrapped row still reads as the same launch wherever it was broken, and is marked as wrapped', () => {
  const text = row(NAME, NEW);
  for (const at of [30, 61, text.indexOf('soft hearts next.exe') + 4, text.indexOf('--profile') + 5, text.indexOf('合成') + 1]) {
    const entry = claudeCodeEntry(list(broken(text, at)), NAME);
    assert.ok(entry?.listed && entry.command, String(at));
    assert.equal(wrappedLine(entry.command!), true);
    assert.equal(sameLaunch(entry.command!, NEW), true, `broken at ${at}`);
    assert.equal(sameLaunch(entry.command!, NEW_OTHER), false, `broken at ${at}: not the other profile`);
  }
  const plain = claudeCodeEntry(list(text), NAME);
  assert.ok(plain?.listed && plain.command && !wrappedLine(plain.command), 'an unwrapped row is exact');
});

type Run = { code: number | null; stdout: string; stderr: string };
const ok = (stdout: string): Run => ({ code: 0, stdout, stderr: '' });
const none: Run = { code: 1, stdout: '', stderr: 'No MCP server found' };
function stub(listText: string, get: Record<string, Run>) {
  const calls: string[][] = [];
  const runner: ClaudeCodeLinkOptions['runner'] = async args => {
    calls.push([...args]);
    if (args[1] === 'list') return ok(listText);
    if (args[1] === 'get') return get[args[2]] ?? none;
    return ok('');
  };
  return { runner, calls, changes: () => calls.filter(call => call[1] === 'add' || call[1] === 'remove') };
}
const mark = (pending = false) => { const state = { pending, marks: [] as boolean[] }; return { state, journal: async (v: boolean) => { state.marks.push(v); state.pending = v; return true; } }; };

test('the other profile\'s row, wrapped exactly at its space, is never re-pointed: read exactly first, and left alone', async () => {
  const text = row(NAME, OLD_OTHER), at = text.indexOf('合成 Gene') + 2;
  const listText = list(broken(text, at)); // reads "合成\nGene": without the exact reading it would pass for "合成Gene"
  // mcp get reads the exact launch: another profile's, so nothing changes.
  const exact = stub(listText, { [NAME]: ok(getText(OLD_OTHER)) }), m1 = mark();
  const shown = await linkClaudeCode({ name: NAME, launch: NEW, runner: exact.runner, allowed: true, registeredBefore: true, journal: m1.journal });
  assert.equal(shown.state, 'stale');
  assert.match(shown.message, /另一个配置目录/);
  assert.deepEqual(exact.changes(), []);
  assert.deepEqual(m1.state.marks, []);
  // mcp get cannot read it: unverified, nothing changes, and the diagnostics say why.
  const blind = stub(listText, {}), m2 = mark();
  const unread = await linkClaudeCode({ name: NAME, launch: NEW, runner: blind.runner, allowed: true, registeredBefore: true, journal: m2.journal });
  assert.equal(unread.state, 'unverified');
  assert.equal(unread.unreadable?.why, 'wrapped');
  assert.deepEqual(blind.changes(), []);
  assert.deepEqual(blind.calls.map(call => call[1]), ['list', 'get']);
});

test('our own older registration, wrapped, is re-pointed only after the exact reading confirms it is ours', async () => {
  const text = row(NAME, OLD_OURS);
  const claude = stub(list(broken(text, 70)), { [NAME]: ok(getText(OLD_OURS)) }), m = mark();
  const result = await linkClaudeCode({ name: NAME, launch: NEW, runner: claude.runner, allowed: true, registeredBefore: true, journal: m.journal });
  assert.equal(result.state, 'updated');
  assert.deepEqual(claude.calls.slice(0, 2).map(call => call[1]), ['list', 'get'], 'read exactly before the first change');
});

test('this launch, wrapped, with nothing pending: linked with the list alone (no extra command)', async () => {
  const claude = stub(list(broken(row(NAME, NEW), 64)), {});
  const result = await linkClaudeCode({ name: NAME, launch: NEW, runner: claude.runner, allowed: true, registeredBefore: true, journal: mark().journal });
  assert.equal(result.state, 'linked');
  assert.deepEqual(claude.calls, [['mcp', 'list']]);
});

test('a pending re-point is tidied (our spare removed) only on exact readings; a wrapped one keeps the spare and the mark', async () => {
  const wrappedList = list(broken(row(NAME, NEW), 64), broken(row(SPARE, NEW), 64));
  const sure = stub(wrappedList, { [NAME]: ok(getText(NEW)), [SPARE]: ok(getText(NEW)) }), m1 = mark(true);
  const tidied = await linkClaudeCode({ name: NAME, launch: NEW, runner: sure.runner, allowed: true, registeredBefore: true, repointPending: true, journal: m1.journal });
  assert.equal(tidied.state, 'linked');
  assert.deepEqual(sure.changes(), [['mcp', 'remove', SPARE, '--scope', 'user']]);
  assert.deepEqual(m1.state.marks, [false]);
  const unsure = stub(wrappedList, {}), m2 = mark(true);
  const kept = await linkClaudeCode({ name: NAME, launch: NEW, runner: unsure.runner, allowed: true, registeredBefore: true, repointPending: true, journal: m2.journal });
  assert.equal(kept.state, 'linked');
  assert.deepEqual(unsure.changes(), [], 'the spare stays');
  assert.equal(m2.state.pending, true, 'the mark stays for the next start');
});

// Codex X-451: a spare that is listed but cannot be read exactly is not known to be someone else's: during a pending re-point it
// is never removed and the mark is never cleared on its account, so the next start reads it again.
// (When the real name is gone, re-adding it is the ordinary recovery and still happens; only the spare and the mark are held.)
test('a pending re-point with an unreadable spare never touches the spare and keeps its mark, whatever the real name shows', async () => {
  const spareWrapped = broken(row(SPARE, NEW), 64);
  const cases = [
    { title: 'real name ours on an older version', list: list(row(NAME, OLD_OURS), spareWrapped), state: 'failed' },
    { title: 'real name another profile\'s', list: list(row(NAME, OLD_OTHER), spareWrapped), state: 'stale' },
    { title: 'real name gone (cut off after its removal)', list: list(spareWrapped), state: 'updated' },
  ];
  for (const item of cases) {
    const claude = stub(item.list, { [NAME]: ok(getText(OLD_OURS)) }), m = mark(true); // the spare's `mcp get` fails
    const result = await linkClaudeCode({ name: NAME, launch: NEW, runner: claude.runner, allowed: true, registeredBefore: true, repointPending: true, journal: m.journal });
    assert.equal(result.state, item.state, item.title);
    assert.equal(claude.changes().some(call => call[2] === SPARE), false, `${item.title}: the spare is never touched`);
    assert.equal(m.state.pending, true, `${item.title}: the mark stays`);
    assert.equal(m.state.marks.includes(false), false, `${item.title}: never cleared`);
  }
});

test('diagnostics: a wrapped app row that could not be read is "wrapped"; rows differing only by a space are "repeated-different"', () => {
  const text = row(NAME, NEW);
  assert.equal(unreadableFacts(list(broken(text, 50)), NAME, false).why, 'wrapped');
  // One list draws two copies of one row the same way (same width, same text).
  assert.equal(unreadableFacts(list(broken(text, 50), broken(text, 50)), NAME, false).why, 'repeated-same');
  assert.equal(unreadableFacts(list(text, row(NAME, NEW_OTHER)), NAME, false).why, 'repeated-different');
});
