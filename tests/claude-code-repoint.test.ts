// I-014 / R46b follow-up (2026-11-03): every stable update installs into a new versioned folder, so the app's own
// registration in the user's Claude Code is pointed at the running version. Order: the new launch under a spare name,
// then the old entry goes, the new one under the real name, the spare goes; a write-ahead mark lets the next start finish
// or tidy a cut-off re-point. Never leaves nothing registered; never changes an entry the app did not register or cannot
// read. Only a fake `claude` that reads and writes a temporary file (tests/fixtures/fake-claude-mcp.mjs).
// docs/claude/2026-11-03-three-way-interconnect.md, "升级后改指向这个版本".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appLaunchLine, claudeCodeEntry, linkClaudeCode, sameLaunch, spawnClaudeRunner, spareName, type ClaudeCodeLinkOptions,
} from '../electron/agent-channel/claude-code-link';
import { registrationArguments, type ShimLaunch } from '../electron/agent-channel/setup-text';
import { INTERCONNECT_FILE, InterconnectStore } from '../electron/agent-channel/interconnect';
import { AgentChannelHost } from '../electron/agent-channel/host';

const NAME = 'soft-hearts-next', SPARE = spareName(NAME);
const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude-mcp.mjs', import.meta.url));
// Spaces, a " - " inside a folder name and Chinese, as on the user's machine (made-up folders).
const ROOT = 'C:\\Users\\me\\OneDrive - 公司\\文档\\soft hearts\\release\\stable';
const PROFILE = 'C:\\Users\\me\\AppData\\Roaming\\soft-hearts-claude';
const install = (version: string): ShimLaunch => ({ command: `${ROOT}\\${version}\\soft hearts next.exe`,
  args: [`${ROOT}\\${version}\\resources\\agent-channel\\soft-hearts-mcp.mjs`, '--profile', PROFILE], env: { ELECTRON_RUN_AS_NODE: '1' } });
const OLD = install('0.4.1-aaaa1111'), NEW = install('0.4.2-bbbb2222');
const line = (launch: ShimLaunch) => [launch.command, ...launch.args].join(' ');

interface FakeState {
  servers: string[]; calls: string[][]; commands: Record<string, string>; status?: Record<string, string>; rows?: string[]; wrap?: number;
  failList?: boolean; failAdd?: boolean | string[]; failRemove?: string[]; hang?: string[]; collide?: Record<string, string>;
}

async function directory(t: test.TestContext, prefix = 'sh-repoint-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

async function fake(t: test.TestContext, state: Partial<FakeState>) {
  const file = path.join(await directory(t), 'state.json');
  await writeFile(file, JSON.stringify({ servers: [], commands: {}, ...state, calls: [] }));
  const runner = spawnClaudeRunner(process.execPath, { ...process.env, FAKE_CLAUDE_STATE: file }, [fakeClaude]);
  const read = async () => JSON.parse(await readFile(file, 'utf8')) as FakeState;
  /** The next start: failures gone, everything else as the last run left it. */
  const heal = async () => { const now = await read(); await writeFile(file, JSON.stringify({ ...now, failAdd: [], failRemove: [], hang: [] })); };
  return { runner, read, heal };
}

/** The profile's mark, in memory (the host keeps it in interconnect.json; see the store and host tests below). */
function memo(pending = false) {
  const state = { pending, marks: [] as boolean[], writable: true };
  const options = (): Pick<ClaudeCodeLinkOptions, 'repointPending' | 'journal'> => ({ repointPending: state.pending,
    journal: async value => { if (!state.writable) return false; state.marks.push(value); state.pending = value; return true; } });
  return { state, options };
}

const link = (runner: ClaudeCodeLinkOptions['runner'], extra: Partial<ClaudeCodeLinkOptions> = {}) =>
  linkClaudeCode({ name: NAME, launch: NEW, runner, allowed: true, registeredBefore: true, timeoutMs: 20_000, ...extra });
const add = (launch: ShimLaunch, name: string) => registrationArguments(launch, name);
const remove = (name: string) => ['mcp', 'remove', name, '--scope', 'user'];

// ---------------------------------------------------------------- reading the list

test('the list parser reads a launch line with spaces, " - " and Chinese in it, wrapped or not, behind every status', () => {
  const old = line(OLD);
  for (const status of ['✓ Connected', '! Needs authentication', '- Not configured', '✗ Failed to connect — spawn ENOENT',
    '⏸ Pending approval (run `claude` to approve)', '! Connected · tools fetch failed — boom', '✗ Connection error']) {
    const text = `Checking MCP server health…\n\ngithub: npx -y gh - ✓ Connected\n${NAME}: ${old} - ${status}\n${NAME}-dev: x - ✓ Connected\n`;
    assert.deepEqual(claudeCodeEntry(text, NAME), { listed: true, command: old }, status);
  }
  // Ink may wrap a long row at the terminal width: the row is joined again; white space does not count when comparing.
  const wrapped = `${NAME}: ${old.slice(0, 50)}\n${old.slice(50, 120)}\n${old.slice(120)} - ✓ Connected\nnext: y - ✓ Connected`;
  const entry = claudeCodeEntry(wrapped, NAME);
  assert.ok(entry?.listed && entry.command && sameLaunch(entry.command, OLD) && !sameLaunch(entry.command, NEW));
  assert.ok(sameLaunch(line(NEW).toUpperCase().replace(/\\/g, '/'), NEW), 'case and slash direction do not matter');
  assert.ok(sameLaunch([NEW.command, ...NEW.args].map(arg => `"${arg}"`).join(' '), NEW), 'quotes do not matter');
  assert.ok(appLaunchLine(old) && !appLaunchLine('stdio') && !appLaunchLine('node C:\\tools\\wrapper.js'));
  // Not readable: no status, twice, or not a list at all.
  assert.deepEqual(claudeCodeEntry(`${NAME}: ${old}\n`, NAME), { listed: true, command: null });
  assert.deepEqual(claudeCodeEntry(`${NAME}: a - ✓ Connected\n${NAME}: b - ✓ Connected\n`, NAME), { listed: true, command: null });
  assert.deepEqual(claudeCodeEntry('No MCP servers configured. Use `claude mcp add` to add a server.', NAME), { listed: false });
  assert.deepEqual(claudeCodeEntry(`${SPARE}: ${old} - ✓ Connected\n`, NAME), { listed: false }, 'the spare is another name');
  assert.equal(claudeCodeEntry('error: unknown command', NAME), null);
});

// ---------------------------------------------------------------- the update

test('an update: this profile\'s own registration still on the previous version is pointed at this one, spare first', async t => {
  for (const wrap of [0, 70]) {
    const claude = await fake(t, { servers: ['github', NAME], commands: { [NAME]: line(OLD) }, wrap });
    const mark = memo();
    const updated = await link(claude.runner, mark.options());
    assert.equal(updated.state, 'updated', `wrap ${wrap}`); assert.match(updated.message, /改成了这个版本/);
    const after = await claude.read();
    assert.deepEqual(after.calls, [['mcp', 'list'], add(NEW, SPARE), remove(NAME), add(NEW, NAME), remove(SPARE)],
      'the new launch is registered before the old one goes, and the real name is back before the spare goes');
    assert.deepEqual(after.servers.sort(), ['github', NAME]);
    assert.equal(after.commands[NAME], line(NEW)); assert.equal(after.commands.github, undefined, 'other servers untouched');
    assert.deepEqual(mark.state.marks, [true, false], 'marked before the first change, cleared once nothing is left over');
    // The next start finds this version: nothing more is run.
    const again = await link(claude.runner, mark.options());
    assert.equal(again.state, 'linked');
    assert.equal((await claude.read()).calls.length, after.calls.length + 1, 'no re-point on every start');
  }
});

test('the same launch line, whatever the case, slashes, quotes, wrapping or status, is left alone', async t => {
  const shown = [line(NEW).toUpperCase(), line(NEW).replace(/\\/g, '/'), [NEW.command, ...NEW.args].map(arg => `"${arg}"`).join(' ')];
  for (const command of shown) for (const status of ['✓ Connected', '✗ Failed to connect — spawn ENOENT', '- Not configured']) {
    const claude = await fake(t, { servers: [NAME], commands: { [NAME]: command }, status: { [NAME]: status }, wrap: 64 });
    const mark = memo();
    const result = await link(claude.runner, mark.options());
    assert.equal(result.state, 'linked', `${command} / ${status}`);
    assert.deepEqual((await claude.read()).calls, [['mcp', 'list']]);
    assert.deepEqual(mark.state.marks, []);
  }
});

test('a same-named entry the app did not register is not changed; 「重新接上」 points it at this version', async t => {
  const claude = await fake(t, { servers: [NAME], commands: { [NAME]: line(OLD) } });
  const mark = memo();
  const left = await link(claude.runner, { registeredBefore: false, ...mark.options() });
  assert.equal(left.state, 'stale'); assert.match(left.message, /不是自动登记的，所以没有改/); assert.match(left.message, /重新接上/);
  assert.deepEqual((await claude.read()).calls, [['mcp', 'list']]);
  const forced = await link(claude.runner, { registeredBefore: false, force: true, ...mark.options() });
  assert.equal(forced.state, 'updated');
  assert.equal((await claude.read()).commands[NAME], line(NEW));
});

test('an entry whose launch line cannot be read is never changed by itself, even when the app registered it', async t => {
  const cases: Partial<FakeState>[] = [
    { servers: [NAME], commands: { [NAME]: 'stdio ' } }, // a redacted listing
    { servers: [NAME], commands: { [NAME]: 'node C:\\tools\\my-wrapper.js' } }, // the user's own wrapper
    { servers: ['github'], rows: [`${NAME}: ${line(OLD)}`] }, // no status at all
    { servers: [NAME], commands: { [NAME]: line(OLD) }, rows: [`${NAME}: ${line(OLD)} - ✓ Connected`] }, // twice
  ];
  for (const state of cases) {
    const claude = await fake(t, state);
    const mark = memo();
    const result = await link(claude.runner, mark.options());
    assert.equal(result.state, 'unverified', JSON.stringify(state)); assert.match(result.message, /没能读出/);
    assert.deepEqual((await claude.read()).calls, [['mcp', 'list']]);
    assert.deepEqual(mark.state.marks, []);
  }
});

test('the user removing it is still respected after an update; a spare name taken by someone else stops the re-point', async t => {
  const gone = await fake(t, { servers: ['github'] });
  assert.equal((await link(gone.runner, memo().options())).state, 'removed');
  assert.deepEqual((await gone.read()).calls, [['mcp', 'list']]);
  const taken = await fake(t, { servers: [NAME, SPARE], commands: { [NAME]: line(OLD), [SPARE]: 'node C:\\mine.js' } });
  const mark = memo();
  const result = await link(taken.runner, mark.options());
  assert.equal(result.state, 'stale'); assert.match(result.message, /已经被占用/);
  assert.deepEqual((await taken.read()).calls, [['mcp', 'list']]); assert.deepEqual(mark.state.marks, []);
});

test('nothing is changed unless the mark is written first; without a journal nothing is re-pointed (as before)', async t => {
  const claude = await fake(t, { servers: [NAME], commands: { [NAME]: line(OLD) } });
  const mark = memo(); mark.state.writable = false;
  const result = await link(claude.runner, mark.options());
  assert.equal(result.state, 'failed'); assert.match(result.message, /这次没有改/);
  assert.deepEqual((await claude.read()).calls, [['mcp', 'list']]);
  assert.equal((await link(claude.runner)).state, 'linked');
  assert.deepEqual((await claude.read()).commands[NAME], line(OLD));
});

// ---------------------------------------------------------------- failures: never nothing registered

const FAILURES: Array<{ name: string; state: Partial<FakeState>; message: RegExp; pending: boolean; servers: Record<string, ShimLaunch> }> = [
  { name: 'the spare cannot be added', state: { failAdd: [SPARE] }, message: /原来的登记没动/, pending: false, servers: { [NAME]: OLD } },
  // Codex round 033 B01: the old program may be gone already, so the spare (this version) stays, and the mark.
  { name: 'the old entry cannot be removed', state: { failRemove: [NAME] }, message: /原来的 soft-hearts-next 没动；现在先用临时名字/, pending: true, servers: { [NAME]: OLD, [SPARE]: NEW } },
  { name: 'the real name cannot be added back', state: { failAdd: [NAME] }, message: /临时名字/, pending: true, servers: { [SPARE]: NEW } },
  { name: 'the spare cannot be removed', state: { failRemove: [SPARE] }, message: /没能删掉/, pending: true, servers: { [NAME]: NEW, [SPARE]: NEW } },
  { name: 'adding the spare hangs after it was done', state: { hang: [`add:${SPARE}`] }, message: /没能确认/, pending: true, servers: { [NAME]: OLD, [SPARE]: NEW } },
  { name: 'removing the old entry hangs after it was done', state: { hang: [`remove:${NAME}`] }, message: /没能确认/, pending: true, servers: { [SPARE]: NEW } },
  { name: 'adding the real name hangs after it was done', state: { hang: [`add:${NAME}`] }, message: /临时名字/, pending: true, servers: { [NAME]: NEW, [SPARE]: NEW } },
  { name: 'removing the spare hangs after it was done', state: { hang: [`remove:${SPARE}`] }, message: /没能删掉/, pending: true, servers: { [NAME]: NEW } },
];

test('a failure at any step leaves a working registration, says so, and the next start finishes or tidies it', async t => {
  for (const failure of FAILURES) {
    const claude = await fake(t, { servers: [NAME], commands: { [NAME]: line(OLD) }, ...failure.state });
    const mark = memo();
    const result = await link(claude.runner, { ...mark.options(), timeoutMs: failure.state.hang ? 1_500 : 20_000 });
    assert.match(result.message, failure.message, failure.name);
    const after = await claude.read();
    assert.deepEqual(Object.fromEntries(after.servers.map(name => [name, after.commands[name]])),
      Object.fromEntries(Object.entries(failure.servers).map(([name, launch]) => [name, line(launch)])), failure.name);
    assert.ok(after.servers.includes(NAME) || after.servers.includes(SPARE), `${failure.name}: never nothing registered`);
    assert.equal(mark.state.pending, failure.pending, `${failure.name}: the mark stays exactly while something is left over`);
    // The next start (the failure gone): this version under the real name, no spare, no mark.
    await claude.heal();
    const next = await link(claude.runner, mark.options());
    assert.ok(['updated', 'linked'].includes(next.state), `${failure.name}: ${next.state} ${next.message}`);
    const healed = await claude.read();
    assert.deepEqual(healed.servers, [NAME], failure.name); assert.equal(healed.commands[NAME], line(NEW), failure.name);
    assert.equal(mark.state.pending, false, failure.name);
  }
});

test('a cut-off re-point is finished even though the real name is missing (it was ours to remove), and retried while it fails', async t => {
  const claude = await fake(t, { servers: [SPARE], commands: { [SPARE]: line(NEW) }, failAdd: [NAME] });
  const mark = memo(true);
  const still = await link(claude.runner, mark.options());
  assert.equal(still.state, 'failed'); assert.match(still.message, /临时名字/);
  assert.deepEqual((await claude.read()).servers, [SPARE], 'the spare keeps her reachable'); assert.equal(mark.state.pending, true);
  await claude.heal();
  const done = await link(claude.runner, mark.options());
  assert.equal(done.state, 'updated');
  assert.deepEqual((await claude.read()).servers, [NAME]); assert.equal(mark.state.pending, false);
});

// Codex T-112 round 033 (B01-B05), here through the spawned fake; tests/claude-code-repoint-c089.test.ts has all 27 cases.
test('Codex round 033: the only working spare is kept until the real name is this version; other profiles\' and the user\'s entries are not ours', async t => {
  const MINE = 'node C:\\Users\\me\\mine.js', ELSEWHERE = line(OLD).replace(PROFILE, 'D:\\Another Profile\\soft-hearts-claude');
  const view = (state: FakeState) => Object.fromEntries(state.servers.map(name => [name, state.commands[name] ?? null]));

  // B01: the old program is gone and the old entry cannot be removed: the spare (this version) stays, and the mark.
  const b01 = await fake(t, { servers: [NAME], commands: { [NAME]: line(OLD) }, status: { [NAME]: '✗ Failed to connect — spawn ENOENT' }, failRemove: [NAME] });
  const m01 = memo();
  const r01 = await link(b01.runner, m01.options());
  assert.equal(r01.state, 'failed'); assert.match(r01.message, /先用临时名字 soft-hearts-next-update 接着这个版本/);
  assert.deepEqual(view(await b01.read()), { [NAME]: line(OLD), [SPARE]: line(NEW) }); assert.equal(m01.state.pending, true);
  await b01.heal();
  const before01 = (await b01.read()).calls.length;
  assert.equal((await link(b01.runner, m01.options())).state, 'updated');
  assert.deepEqual((await b01.read()).calls.slice(before01), [['mcp', 'list'], remove(NAME), add(NEW, NAME), remove(SPARE)],
    'the kept spare is the fallback until the real name is this version: it is not removed and added again first');
  assert.deepEqual(view(await b01.read()), { [NAME]: line(NEW) }); assert.equal(m01.state.pending, false);

  // B02: another entry takes the real name just before it is added back: "already exists" is not "done"; the spare stays.
  const b02 = await fake(t, { servers: [NAME], commands: { [NAME]: line(OLD) }, collide: { [NAME]: MINE } });
  const m02 = memo();
  const r02 = await link(b02.runner, m02.options());
  assert.equal(r02.state, 'failed'); assert.match(r02.message, /刚被别的登记占用了/);
  assert.deepEqual(view(await b02.read()), { [NAME]: MINE, [SPARE]: line(NEW) }); assert.equal(m02.state.pending, true);
  const again02 = await link(b02.runner, m02.options());
  assert.equal(again02.state, 'unverified'); assert.match(again02.message, /先留着它/);
  assert.deepEqual(view(await b02.read()), { [NAME]: MINE, [SPARE]: line(NEW) }, 'the next start changes nothing either');

  // B03: a pending re-point, the real name unreadable: the spare (this version) and the mark stay.
  const b03 = await fake(t, { servers: [SPARE], commands: { [SPARE]: line(NEW) }, rows: [`${NAME}: stdio`] });
  const m03 = memo(true);
  const r03 = await link(b03.runner, m03.options());
  assert.equal(r03.state, 'unverified'); assert.match(r03.message, /先留着它/);
  assert.deepEqual((await b03.read()).calls, [['mcp', 'list']]); assert.equal(m03.state.pending, true);

  // B04: registered by this profile once, now the user's entry for another profile: not ours, not changed.
  const b04 = await fake(t, { servers: [NAME], commands: { [NAME]: ELSEWHERE } });
  const m04 = memo();
  const r04 = await link(b04.runner, m04.options());
  assert.equal(r04.state, 'stale'); assert.match(r04.message, /另一个配置目录/);
  assert.deepEqual((await b04.read()).calls, [['mcp', 'list']]); assert.deepEqual(m04.state.marks, []);

  // B05: a pending re-point, the real name already this version, the spare name reused by the user: theirs stays.
  const b05 = await fake(t, { servers: [NAME, SPARE], commands: { [NAME]: line(NEW), [SPARE]: MINE } });
  const m05 = memo(true);
  assert.equal((await link(b05.runner, m05.options())).state, 'linked');
  assert.deepEqual((await b05.read()).calls, [['mcp', 'list']]);
  assert.deepEqual(view(await b05.read()), { [NAME]: line(NEW), [SPARE]: MINE }); assert.equal(m05.state.pending, false);
});

// ---------------------------------------------------------------- the mark in the profile, and the host

test('the store keeps the re-point mark across restarts and choices, and writes nothing over an unreadable file', async t => {
  const dir = await directory(t);
  const store = new InterconnectStore(dir);
  await store.load();
  assert.equal(await store.markRepointing(NAME, true), true);
  assert.deepEqual((await new InterconnectStore(dir).load()).repointing, [NAME]);
  await store.setEnabled(false);
  assert.deepEqual((await new InterconnectStore(dir).load()).repointing, [NAME], 'turning 三方互通 off keeps it');
  assert.equal(await store.markRepointing(NAME, false), true);
  const cleared = await new InterconnectStore(dir).load();
  assert.equal(cleared.repointing, undefined);
  assert.doesNotMatch(await readFile(path.join(dir, INTERCONNECT_FILE), 'utf8'), /repointing/);
  assert.equal(await store.markRepointing('Not A Name', true), false);
  await writeFile(path.join(dir, INTERCONNECT_FILE), '{broken');
  const broken = new InterconnectStore(dir); await broken.load();
  assert.equal(await broken.markRepointing(NAME, true), false, 'no re-point starts without its mark');
  assert.equal(await readFile(path.join(dir, INTERCONNECT_FILE), 'utf8'), '{broken');
});

test('host and store together: a re-point cut off by a failure is finished by the next start, and the name stays ours', async t => {
  const dir = await directory(t, 'sh-repoint-host-');
  const claude = await fake(t, { servers: [NAME], commands: { [NAME]: line(OLD) }, failAdd: [NAME] });
  // The same closure electron-wiring.ts builds, with the fake claude and this version's launch line.
  const start = async () => {
    const host = new AgentChannelHost({ profileDirectory: dir, tools: [], confirm: async () => false, linkDelayMs: 0,
      linkClaudeCode: (force, autoRegistered, repoint) => linkClaudeCode({ name: NAME, launch: NEW, runner: claude.runner, allowed: true, force,
        registeredBefore: autoRegistered.includes(NAME), repointPending: repoint.pending.includes(NAME), journal: pending => repoint.mark(NAME, pending) }) });
    await host.init();
    for (let i = 0; i < 400 && ['checking', 'idle'].includes(host.view().interconnect?.claudeCode.state ?? 'idle'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    return host;
  };
  // This profile registered it in an earlier version.
  const seed = new InterconnectStore(dir); await seed.load(); await seed.noteAutoRegistered(NAME);
  const first = await start();
  try {
    assert.equal(first.view().interconnect?.claudeCode.state, 'failed');
    assert.deepEqual((await new InterconnectStore(dir).load()).repointing, [NAME], 'the mark is in the profile');
    assert.deepEqual((await claude.read()).servers, [SPARE]);
  } finally { await first.dispose(); }
  await claude.heal();
  const second = await start();
  try {
    assert.equal(second.view().interconnect?.claudeCode.state, 'updated');
    const stored = await new InterconnectStore(dir).load();
    assert.equal(stored.repointing, undefined); assert.deepEqual(stored.autoRegistered, [NAME]);
    const after = await claude.read();
    assert.deepEqual(after.servers, [NAME]); assert.equal(after.commands[NAME], line(NEW));
  } finally { await second.dispose(); }
});

test('host: an entry the user registered is left alone until 「重新接上」, which makes it the app\'s own for the next update', async t => {
  const dir = await directory(t, 'sh-repoint-host-');
  const claude = await fake(t, { servers: [NAME], commands: { [NAME]: line(OLD) } });
  const host = new AgentChannelHost({ profileDirectory: dir, tools: [], confirm: async () => false, linkDelayMs: 0,
    linkClaudeCode: (force, autoRegistered, repoint) => linkClaudeCode({ name: NAME, launch: NEW, runner: claude.runner, allowed: true, force,
      registeredBefore: autoRegistered.includes(NAME), repointPending: repoint.pending.includes(NAME), journal: pending => repoint.mark(NAME, pending) }) });
  try {
    await host.init();
    for (let i = 0; i < 400 && ['checking', 'idle'].includes(host.view().interconnect?.claudeCode.state ?? 'idle'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(host.view().interconnect?.claudeCode.state, 'stale');
    assert.deepEqual((await new InterconnectStore(dir).load()).autoRegistered, []);
    await host.relinkClaudeCode();
    assert.equal(host.view().interconnect?.claudeCode.state, 'updated');
    assert.deepEqual((await new InterconnectStore(dir).load()).autoRegistered, [NAME], 'pointed at this version by the app: its own from now on');
    assert.equal((await claude.read()).commands[NAME], line(NEW));
  } finally { await host.dispose(); }
});
