// Codex T-112 round 033 (C089, fixed f764abe; 2026-11-03), ported: 27 cases against the production linkClaudeCode and
// InterconnectStore through a synthetic, in-memory `claude` (no process is started; nothing reads or writes the real
// ~/.claude.json). On f764abe 22 passed and 5 failed (B01-B05): the only usable spare was removed (B01-B03), and a
// same-named entry for another profile (B04) or a spare name the user reused (B05) was changed. Adapted after the fix:
// F02 (the old entry cannot be removed) now keeps the spare and the mark; B01 asserts the kept spare, not the old text.
// Codex's original: 研究成果/Codex/T-112/2026-11-03-round-033/c089.test.ts. docs/claude/2026-11-03-three-way-interconnect.md.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { linkClaudeCode, type ClaudeCodeLinkOptions, type ClaudeRun } from '../electron/agent-channel/claude-code-link';
import { InterconnectStore } from '../electron/agent-channel/interconnect';

const NAME = 'soft-hearts-next';
const SPARE = 'soft-hearts-next-update';
const PROFILE = 'Q:\\Synthetic Profiles\\soft-hearts-claude';
const launch = (version: string, profile = PROFILE) => ({
  command: 'Q:\\Synthetic Installs\\OneDrive - 验证\\soft hearts ' + version + '\\soft hearts.exe',
  args: ['Q:\\Synthetic Installs\\OneDrive - 验证\\soft hearts ' + version + '\\resources\\agent-channel\\soft-hearts-mcp.mjs', '--profile', profile],
  env: { ELECTRON_RUN_AS_NODE: '1' },
});
const OLD = launch('1.2.3'), CURRENT = launch('1.2.4');
const OTHER = launch('1.0.0', 'Q:\\Synthetic Profiles\\Manual Profile');
const asLine = (value: typeof OLD) => [value.command, ...value.args].join(' ');
const OLD_LINE = asLine(OLD), CURRENT_LINE = asLine(CURRENT), OTHER_LINE = asLine(OTHER);
const EXTERNAL = 'Q:\\Third-party\\unrelated.exe --manual';
const REST = 'Q:\\Other\\github.exe';
const add = (name: string) => ['mcp', 'add', '--transport', 'stdio', '--scope', 'user',
  '--env=ELECTRON_RUN_AS_NODE=1', name, '--', CURRENT.command, ...CURRENT.args];
const remove = (name: string) => ['mcp', 'remove', name, '--scope', 'user'];
const LIST = ['mcp', 'list'];
const successfulOrder = [LIST, add(SPARE), remove(NAME), add(NAME), remove(SPARE)];
const reply = (code: number | null, stdout = '', stderr = ''): ClaudeRun => ({ code, stdout, stderr });
const row = (name: string, value: string) => name + ': ' + value + ' - ✓ Connected';
type EntryMap = Record<string, string>;
type Fault = { at: number; kind: 'refusal' | 'before-timeout' | 'after-timeout' | 'collision'; replacement?: string };
type Trace = {
  kind: string; args?: string[]; code?: number | null; entries: EntryMap;
  usable: string[]; pending: boolean; output?: string; result?: unknown; stage: number;
};
const evidence: Record<string, Trace[]> = {};

function fake(id: string, options: {
  entries?: EntryMap; registered?: boolean; pending?: boolean; journalWritable?: boolean; usableOld?: boolean;
} = {}) {
  const entries = new Map(Object.entries(options.entries ?? { [NAME]: OLD_LINE, github: REST }));
  const usableLaunches = new Set([CURRENT_LINE, ...(options.usableOld === false ? [] : [OLD_LINE])]);
  let pending = options.pending ?? false, stage = 0, changes = 0;
  let fault: Fault | undefined;
  let listOverride: ClaudeRun | undefined;
  const trace: Trace[] = evidence[id] = [];
  const snapshot = (kind: string, data: Partial<Trace> = {}) => {
    trace.push({ kind, entries: Object.fromEntries(entries), usable: [...entries].filter(([n, value]) =>
      [NAME, SPARE].includes(n) && usableLaunches.has(value)).map(([name]) => name), pending, stage, ...data });
  };
  const invalid: string[][] = [];
  const invoke = async (overrides: Partial<ClaudeCodeLinkOptions> = {}) => {
    stage++;
    changes = 0;
    snapshot('startup');
    const result = await linkClaudeCode({
      name: NAME, launch: CURRENT, allowed: true, registeredBefore: options.registered ?? true,
      repointPending: pending, timeoutMs: 60_000,
      journal: async value => {
        const written = options.journalWritable !== false;
        if (written) pending = value;
        snapshot('journal', { result: { requested: value, written } });
        return written;
      },
      runner: async (args, timeoutMs) => {
        const call = [...args];
        let result: ClaudeRun;
        if (timeoutMs !== 60_000) invalid.push(call);
        if (args.join(' ') === 'mcp list') {
          const status = ([n, value]: [string,string]) =>
            n === NAME && value === OLD_LINE && options.usableOld === false ? n + ': ' + value + ' - ✗ Failed to connect — missing executable' : row(n, value);
          result = listOverride ?? reply(0, entries.size
            ? 'Checking MCP server health…\r\n\r\n' + [...entries].map(status).join('\r\n') + '\r\n'
            : 'No MCP servers configured.');
        } else {
          const isAdd = args[1] === 'add';
          const separator = args.indexOf('--');
          const name = isAdd ? args[separator - 1] : args[2];
          const expected = isAdd ? add(name) : remove(name);
          if (!name || ![NAME, SPARE].includes(name) || JSON.stringify(args) !== JSON.stringify(expected)) invalid.push(call);
          const injected = fault?.at === ++changes ? fault : undefined;
          if (injected?.kind === 'collision') {
            entries.set(name, injected.replacement ?? EXTERNAL);
            result = reply(1, '', 'MCP server already exists in user config');
          } else if (injected?.kind === 'refusal') {
            result = reply(1, '', 'synthetic refusal before mutation');
          } else if (injected?.kind === 'before-timeout') {
            result = reply(null, '', 'synthetic timeout before mutation');
          } else {
            if (isAdd) {
              if (entries.has(name)) result = reply(1, '', 'MCP server already exists in user config');
              else { entries.set(name, args.slice(separator + 1).join(' ')); result = reply(0); }
            } else {
              result = entries.delete(name) ? reply(0) : reply(1, '', 'not found in user scope');
            }
            if (injected?.kind === 'after-timeout') result = reply(null, '', 'synthetic timeout after mutation');
          }
        }
        snapshot('command', { args: call, code: result.code, output: result.stdout || result.stderr });
        return result;
      },
      ...overrides,
    });
    assert.deepEqual(invalid, [], 'CLI argument vector and timeout');
    snapshot('outcome', { result });
    return result;
  };
  return {
    invoke, trace,
    setFault(value?: Fault) { fault = value; },
    setList(value: ClaudeRun) { listOverride = value; },
    last: () => trace.at(-1)!,
    commands: () => trace.filter(event => event.stage === stage && event.kind === 'command').map(event => event.args),
  };
}
function assertFinal(sim: ReturnType<typeof fake>) {
  assert.equal(sim.last().entries[NAME], CURRENT_LINE);
  assert.equal(sim.last().entries[SPARE], undefined);
  assert.equal(sim.last().pending, false);
}

test('M01 migration order, exact args, write-ahead journal and idempotent next startup', async () => {
  const sim = fake('M01');
  assert.equal((await sim.invoke()).state, 'updated');
  assert.deepEqual(sim.commands(), successfulOrder);
  assert.deepEqual(sim.trace.map(e => e.kind), ['startup', 'command', 'journal', 'command', 'command', 'command', 'command', 'journal', 'outcome']);
  assert.deepEqual(sim.trace.filter(e => e.kind === 'command').map(e => e.usable), [[NAME], [NAME, SPARE], [SPARE], [SPARE, NAME], [NAME]]);
  assert.deepEqual(sim.trace.filter(e => e.kind === 'journal').map(e => e.pending), [true, false]);
  assert.deepEqual(sim.last().entries, { github: REST, [NAME]: CURRENT_LINE });
  assertFinal(sim);
  assert.equal((await sim.invoke()).state, 'linked');
  assert.deepEqual(sim.commands(), [LIST]);
});

type Check = {
  id: string; title: string; state: string; message: RegExp; entries: EntryMap; list?: string; registered?: boolean;
  variants?: string[]; journalWritable?: boolean; listError?: string; allowed?: boolean;
};
const checks: Check[] = [
  { id: 'M02', title: 'wrapped ANSI current launch is a no-op', state: 'linked', message: /已接上/,
    entries: { [NAME]: CURRENT_LINE }, list: '\u001b[32m' + NAME + ':\u001b[0m ' + CURRENT_LINE.slice(0, 71) + '\r\n' + CURRENT_LINE.slice(71) + ' - ✗ Failed to connect — synthetic status' },
  { id: 'M03', title: 'user registered same name with recognizable old shim', state: 'stale', message: /不是自动登记的/,
    registered: false, entries: { [NAME]: OLD_LINE } },
  { id: 'M04', title: 'redacted launch, missing status, duplicate scope or non-shim launch', state: 'unverified', message: /没能读出/,
    entries: { [NAME]: EXTERNAL },
    variants: [row(NAME, 'stdio'), NAME + ': ' + OLD_LINE, row(NAME, OLD_LINE) + '\n' + row(NAME, EXTERNAL), row(NAME, EXTERNAL)] },
  { id: 'M05', title: 'unowned temporary name is kept', state: 'stale', message: /已经被占用/,
    entries: { [NAME]: OLD_LINE, [SPARE]: EXTERNAL } },
  { id: 'M06', title: 'known name removed by user is not re-added', state: 'removed', message: /没有再加/,
    entries: { github: REST } },
  { id: 'M07', title: 'failed journal write prevents mutations', state: 'failed', message: /这次没有改/,
    journalWritable: false, entries: { [NAME]: OLD_LINE } },
  { id: 'M08', title: 'unrecognized error from list prevents mutations', state: 'failed', message: /没能自动接上/,
    entries: { [NAME]: OLD_LINE }, listError: 'error: unknown command' },
  { id: 'M09', title: 'isolated profile allowance denies all commands', state: 'skipped', message: /不会自动接上/,
    entries: { [NAME]: OLD_LINE }, allowed: false },
];
for (const item of checks) {
  test(item.id + ' ' + item.title, async () => {
    const variants = item.variants ?? [item.list];
    for (const [index, output] of variants.entries()) {
      const sim = fake(variants.length === 1 ? item.id : item.id + '.' + (index + 1), item);
      if (output) sim.setList(reply(0, output));
      if (item.listError) sim.setList(reply(1, '', item.listError));
      const result = await sim.invoke(item.allowed === false ? { allowed: false } : {});
      assert.equal(result.state, item.state);
      assert.match(result.message, item.message);
      assert.deepEqual(sim.commands(), item.allowed === false ? [] : [LIST]);
      assert.deepEqual(sim.last().entries, item.entries);
      assert.equal(sim.last().pending, false);
    }
  });
}

type Failure = {
  id: string; step: number; kind: Fault['kind']; state: string; remains: EntryMap; pending: boolean;
  why: RegExp;
};
const previousOnly = { [NAME]: OLD_LINE };
const both = { [NAME]: OLD_LINE, [SPARE]: CURRENT_LINE };
const spareOnly = { [SPARE]: CURRENT_LINE };
const currentAndSpare = { [NAME]: CURRENT_LINE, [SPARE]: CURRENT_LINE };
const currentOnly = { [NAME]: CURRENT_LINE };
const failures: Failure[] = [
  { id:'F01',step:1,kind:'refusal',state:'failed',remains:previousOnly,pending:false,why:/原来的登记没动/ },
  { id:'F02',step:2,kind:'refusal',state:'failed',remains:both,pending:true,why:/原来的 soft-hearts-next 没动；现在先用临时名字/ },
  { id:'F03',step:3,kind:'refusal',state:'failed',remains:spareOnly,pending:true,why:/临时名字/ },
  { id:'F04',step:4,kind:'refusal',state:'updated',remains:currentAndSpare,pending:true,why:/没能删掉/ },
  { id:'F05',step:1,kind:'before-timeout',state:'failed',remains:previousOnly,pending:true,why:/没能确认/ },
  { id:'F06',step:2,kind:'before-timeout',state:'failed',remains:both,pending:true,why:/没能确认/ },
  { id:'F07',step:3,kind:'before-timeout',state:'failed',remains:spareOnly,pending:true,why:/临时名字/ },
  { id:'F08',step:4,kind:'before-timeout',state:'updated',remains:currentAndSpare,pending:true,why:/没能删掉/ },
  { id:'F09',step:1,kind:'after-timeout',state:'failed',remains:both,pending:true,why:/没能确认/ },
  { id:'F10',step:2,kind:'after-timeout',state:'failed',remains:spareOnly,pending:true,why:/没能确认/ },
  { id:'F11',step:3,kind:'after-timeout',state:'failed',remains:currentAndSpare,pending:true,why:/临时名字/ },
  { id:'F12',step:4,kind:'after-timeout',state:'updated',remains:currentOnly,pending:true,why:/没能删掉/ },
];
for (const item of failures) {
  test(item.id + ' step ' + item.step + ' ' + item.kind + ' then restart', async () => {
    const sim = fake(item.id);
    sim.setFault({ at:item.step, kind:item.kind });
    const result = await sim.invoke();
    assert.equal(result.state, item.state);
    assert.match(result.message, item.why);
    assert.deepEqual(sim.last().entries, { github: REST, ...item.remains });
    assert.equal(sim.last().pending, item.pending);
    sim.setFault();
    assert.ok(['updated','linked'].includes((await sim.invoke()).state));
    assertFinal(sim);
    assert.ok(sim.trace.every(e => e.usable.length > 0), 'an assumed reachable old or current launch exists at each step');
    assert.equal(sim.last().entries.github, REST);
  });
}

test('M10 production journal survives a fresh store between two migration attempts', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sh-c089-profile-'));
  const store = new InterconnectStore(directory);
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  await writeFile(store.file, JSON.stringify({ version:1, chosen:true, enabled:true, autoRegistered:[NAME] }), { flag:'wx' });
  await store.load();
  const sim = fake('M10');
  sim.setFault({ at:3, kind:'refusal' });
  const options = (active: InterconnectStore): Partial<ClaudeCodeLinkOptions> => ({
    registeredBefore: active.current.autoRegistered.includes(NAME),
    repointPending: active.current.repointing?.includes(NAME),
    journal: pending => active.markRepointing(NAME, pending),
  });
  assert.equal((await sim.invoke(options(store))).state, 'failed');
  assert.deepEqual(JSON.parse(await readFile(store.file, 'utf8')).repointing, [NAME]);
  assert.equal(sim.last().entries[SPARE], CURRENT_LINE);
  const reopened = new InterconnectStore(directory);
  await reopened.load();
  sim.setFault();
  assert.equal((await sim.invoke(options(reopened))).state, 'updated');
  assert.deepEqual(sim.commands(), [LIST, add(NAME), remove(SPARE)]);
  const persisted = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(persisted.repointing, undefined);
  assert.deepEqual(persisted.autoRegistered, [NAME]);
  assertFinal(sim);
});

test('B01 old executable unavailable, a refused formal remove must keep the new spare', async () => {
  const sim = fake('B01', { usableOld:false });
  sim.setFault({ at:2, kind:'refusal' });
  const result = await sim.invoke();
  assert.equal(result.state, 'failed');
  assert.match(result.message, /先用临时名字 soft-hearts-next-update 接着这个版本/);
  const failure = sim.last();
  assert.deepEqual(failure.entries, { github: REST, [NAME]: OLD_LINE, [SPARE]: CURRENT_LINE });
  assert.equal(failure.pending, true, 'the mark stays while the spare is kept');
  assert.ok(sim.trace.some(e => e.kind === 'command' && e.usable.includes(SPARE)));
  sim.setFault();
  await sim.invoke();
  assertFinal(sim);
  assert.ok(failure.usable.length > 0, 'first attempt deleted the only usable spare; old launch was already unavailable');
});

test('B02 collision during formal add must retain spare until actual formal launch is verified', async () => {
  const sim = fake('B02');
  sim.setFault({ at:3, kind:'collision' });
  const result = await sim.invoke();
  assert.equal(sim.last().entries[NAME], EXTERNAL, 'synthetic conflicting registration won');
  assert.notEqual(result.state === 'updated' && !sim.last().usable.length, true, 'reported updated and discarded only usable spare');
});

test('B03 pending recovery with unreadable formal entry should preserve its known usable spare', async () => {
  const sim = fake('B03', { pending:true, entries:{ [NAME]:EXTERNAL,[SPARE]:CURRENT_LINE } });
  sim.setList(reply(0, NAME + ': stdio\r\n' + row(SPARE, CURRENT_LINE)));
  const result = await sim.invoke();
  assert.equal(result.state, 'unverified');
  assert.equal(sim.last().entries[NAME], EXTERNAL);
  assert.equal(sim.last().entries[SPARE], CURRENT_LINE, 'unverified canonical entry did not justify deleting usable spare');
});

test('B04 historical marker does not establish ownership of a manually replaced formal name', async () => {
  const sim = fake('B04', { registered:true, entries:{ [NAME]:OTHER_LINE } });
  await sim.invoke();
  assert.equal(sim.last().entries[NAME], OTHER_LINE, 'another profile manually registered the same name and was overwritten');
});

test('B05 pending cleanup does not own a foreign replacement under the spare name', async () => {
  const sim = fake('B05', { pending:true, entries:{ [NAME]:CURRENT_LINE,[SPARE]:EXTERNAL } });
  await sim.invoke();
  assert.equal(sim.last().entries[SPARE], EXTERNAL, 'a user replacement under the temporary name was deleted');
});

