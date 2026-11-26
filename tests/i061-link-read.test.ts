// I-061 (2026-11-12 real-use sweep): the one-click diagnostics said 'unverified' at every start although the channel worked.
// The registration is now also read with `claude mcp get <name>` (fixed '  Label: value' lines) when the list row cannot be read,
// and the runner no longer cuts a multi-byte character in two. Folders below are made up (spaces, ' - ', Chinese).
import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeCodeEntry, claudeCodeGetCommand, linkClaudeCode, spawnClaudeRunner, type ClaudeCodeLinkOptions } from '../electron/safety/agent-channel/claude-code-link';
import type { ShimLaunch } from '../electron/safety/agent-channel/setup-text';

const NAME = 'soft-hearts-next', DEV = 'soft-hearts-next-dev';
const ROOT = 'C:\\Users\\me\\OneDrive - 公司\\文档\\AI桌宠-Claude\\release\\stable';
const PROFILE = 'C:\\Users\\me\\AppData\\Roaming\\soft-hearts-claude';
const install = (version: string): ShimLaunch => ({ command: `${ROOT}\\${version}\\win-arm64-unpacked\\soft hearts next.exe`,
  args: [`${ROOT}\\${version}\\win-arm64-unpacked\\resources\\agent-channel\\soft-hearts-mcp.mjs`, '--profile', PROFILE], env: { ELECTRON_RUN_AS_NODE: '1' } });
const OLD = install('aaaa1111'), NEW = install('bbbb2222');
const line = (launch: ShimLaunch) => [launch.command, ...launch.args].join(' ');
const getText = (launch: ShimLaunch, scope = 'User config (available in all your projects)', type = 'stdio') => [
  `${NAME}:`, `  Scope: ${scope}`, '  Status: ✔ Connected', `  Type: ${type}`, `  Command: ${launch.command}`, `  Args: ${launch.args.join(' ')}`,
  '  Environment:', '    ELECTRON_RUN_AS_NODE=1', '', `To remove this server, run: claude mcp remove ${NAME} -s user`, ''].join('\n');

test('mcp get (2.1.316 format): the launch line is Command + Args, only for a user-scope stdio entry', () => {
  assert.equal(claudeCodeGetCommand(getText(NEW)), line(NEW));
  assert.equal(claudeCodeGetCommand(getText(NEW, 'Local config (private to you in this project)')), null);
  assert.equal(claudeCodeGetCommand(getText(NEW, 'Project config (shared via .mcp.json)')), null);
  assert.equal(claudeCodeGetCommand(getText(NEW, undefined, 'http')), null);
  assert.equal(claudeCodeGetCommand('No MCP server found with name: soft-hearts-next\n'), null);
  assert.equal(claudeCodeGetCommand(getText(NEW) + getText(OLD)), null, 'two blocks: not told apart');
});

test('the 2.1.316 list with the stable and the development registration both present reads each row', () => {
  const list = ['Checking MCP server health…', '', 'claude.ai Claude Docs: https://example.invalid/mcp - ✔ Connected',
    `${DEV}: ${line(install('dev00000'))} - ✔ Connected`.replace(PROFILE, `${PROFILE}-dev`), `${NAME}: ${line(NEW)} - ✔ Connected`, ''].join('\n');
  assert.deepEqual(claudeCodeEntry(list, NAME), { listed: true, command: line(NEW) });
  assert.equal((claudeCodeEntry(list, DEV) as { command: string }).command.endsWith('soft-hearts-claude-dev'), true);
});

type Run = { code: number | null; stdout: string; stderr: string };
/** A stub `claude`: the list text and the `mcp get` answer; every call is kept. Add and remove always fail, so a re-point shows up as a call. */
function stub(list: string, get: Run) {
  const calls: string[][] = [];
  const runner: ClaudeCodeLinkOptions['runner'] = async args => { calls.push([...args]); return args[1] === 'list' ? { code: 0, stdout: list, stderr: '' } : args[1] === 'get' ? get : { code: 1, stdout: '', stderr: 'stub' }; };
  return { runner, calls };
}
const run = (runner: ClaudeCodeLinkOptions['runner']) => linkClaudeCode({ name: NAME, launch: NEW, runner, allowed: true, registeredBefore: true, timeoutMs: 20_000, journal: async () => true });
const ok = (stdout: string): Run => ({ code: 0, stdout, stderr: '' });

test('a list row that cannot be read is read with mcp get: this version is linked', async () => {
  // No status mark (a damaged or differently drawn list); the name listed twice; a status mark turned into U+FFFD.
  for (const list of [`${NAME}: ${line(NEW)}
`, `${NAME}: ${line(NEW)} - ✔ Connected
${NAME}: ${line(NEW)} - ✔ Connected
`, `${NAME}: ${line(NEW)} - � Connected
`]) {
    const claude = stub(list, ok(getText(NEW)));
    const result = await run(claude.runner);
    assert.equal(result.state, 'linked', list);
    assert.equal(result.unreadable, undefined);
    assert.deepEqual(claude.calls.map(call => call[1]), ['list', 'get']);
  }
});

test('an older registration that the list cannot show is re-pointed after mcp get reads it; one that mcp get cannot read is never touched', async () => {
  const hidden = `${NAME}: ${line(OLD)}
`;
  const old = stub(hidden, ok(getText(OLD)));
  const moved = await run(old.runner);
  assert.notEqual(moved.state, 'unverified');
  assert.equal(old.calls.some(call => call[1] === 'add'), true, 'the re-point started');
  for (const get of [{ code: 1, stdout: '', stderr: 'No MCP server found' }, ok(getText(OLD, 'Local config (private to you in this project)')), ok('')]) {
    const claude = stub(hidden, get);
    const result = await run(claude.runner);
    assert.equal(result.state, 'unverified');
    assert.deepEqual(claude.calls.map(call => call[1]), ['list', 'get'], 'nothing was added or removed');
  }
});

test('the runner keeps a multi-byte character together when a pipe read cuts it in two', async () => {
  const text = '✔ Connected 文档 桌宠';
  const script = `const b = Buffer.from(${JSON.stringify(text)}); process.stdout.write(b.subarray(0, 1)); setTimeout(() => { process.stdout.write(b.subarray(1, 8)); setTimeout(() => process.stdout.write(b.subarray(8)), 60); }, 60);`;
  const result = await spawnClaudeRunner(process.execPath, process.env, ['-e', script])([], 10_000);
  assert.equal(result.stdout, text);
});
