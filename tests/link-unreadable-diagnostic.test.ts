// 2026-11-12 diagnostic: why a listed registration was `unverified`, as a category and two small numbers, never text.
// docs/claude/2026-11-12-link-unreadable-diagnostic.md. No linking decision changes (tests/claude-code-repoint.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { linkClaudeCode, unreadableFacts, type ClaudeRun } from '../electron/safety/agent-channel/claude-code-link';
import { AgentChannelHost } from '../electron/safety/agent-channel/host';
import { buildJournalEntry } from '../shared/memory/journal';

const NAME = 'soft-hearts-next', PROFILE = 'C:\\Users\\me\\AppData\\Roaming\\soft-hearts-claude';
const launch = (version: string) => ({ command: `C:\\Apps\\${version}\\soft hearts next.exe`, args: [`C:\\Apps\\${version}\\soft-hearts-mcp.mjs`, '--profile', PROFILE], env: {} });
const text = (l: { command: string; args: string[] }) => [l.command, ...l.args].join(' ');
const HEADER = 'Checking MCP server health…';
const ROW = (l = launch('1')) => `${NAME}: ${text(l)} - ✔ Connected`;

test('each category comes out of a synthetic list', () => {
  assert.deepEqual(unreadableFacts(`${HEADER}\n\n${ROW()}\n${ROW()}\n`, NAME, false), { why: 'repeated-same', rows: 2, headerRepeated: false });
  // the same row again, differing only in case and slash direction
  assert.equal(unreadableFacts(`${HEADER}\n${ROW()}\n${HEADER}\n${ROW().replace(/\\/g, '/').toUpperCase().replace('SOFT-HEARTS-NEXT:', `${NAME}:`)}`, NAME, false).why, 'repeated-same');
  assert.equal(unreadableFacts(`${HEADER}\n${HEADER}\n${ROW()}\n${ROW()}`, NAME, false).headerRepeated, true);
  assert.deepEqual(unreadableFacts(`${ROW(launch('1'))}\n${ROW(launch('2'))}\n${ROW(launch('3'))}`, NAME, false), { why: 'repeated-different', rows: 3, headerRepeated: false });
  assert.deepEqual(unreadableFacts(`${HEADER}\n${NAME}: ${text(launch('1'))}\n`, NAME, false), { why: 'no-status', rows: 1, headerRepeated: false });
  assert.deepEqual(unreadableFacts(`${NAME}: node C:\\tools\\wrapper.js - ✔ Connected\n`, NAME, false), { why: 'not-app-line', rows: 1, headerRepeated: false });
  assert.equal(unreadableFacts(`${ROW()}\n`, NAME, true).why, 'cut-off');
  assert.equal(unreadableFacts(`${Array(12).fill(ROW()).join('\n')}`, NAME, false).rows, 9, 'capped at 9');
});

const stub = (run: Partial<ClaudeRun>) => async (): Promise<ClaudeRun> => ({ code: 0, stdout: '', stderr: '', ...run });
const check = (stdout: string, extra: Partial<ClaudeRun> = {}, registeredBefore = true, current = launch('2')) =>
  linkClaudeCode({ name: NAME, launch: current, runner: stub({ stdout, ...extra }), allowed: true, registeredBefore, journal: async () => true });

test('only an unverified result carries the facts; the decision is unchanged', async () => {
  const twice = await check(`${HEADER}\n${ROW()}\n${ROW()}\n`);
  assert.equal(twice.state, 'unverified'); assert.deepEqual(twice.unreadable, { why: 'repeated-same', rows: 2, headerRepeated: false });
  const cut = await check(`${NAME}: ${text(launch('1'))}\n`, { code: 1, stderr: 'boom' });
  assert.equal(cut.state, 'unverified'); assert.equal(cut.unreadable?.why, 'cut-off');
  const noStatus = await check(`${NAME}: ${text(launch('1'))}\n`);
  assert.equal(noStatus.state, 'unverified'); assert.equal(noStatus.unreadable?.why, 'no-status');
  const linked = await check(`${ROW(launch('2'))}\n`);
  assert.equal(linked.state, 'linked'); assert.ok(!('unreadable' in linked));
  const stale = await check(`${ROW(launch('1'))}\n`, {}, false);
  assert.equal(stale.state, 'stale'); assert.ok(!('unreadable' in stale));
});

async function recorded(state: string, unreadable: unknown) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sh-unreadable-')), checks: any[] = [];
  const host = new AgentChannelHost({ profileDirectory: dir, tools: [], confirm: async () => true, linkDelayMs: 0, linkChecked: c => { checks.push(c); },
    linkClaudeCode: async () => ({ state: state as never, name: NAME, message: `read ${PROFILE} here`, ...(unreadable ? { unreadable: unreadable as never } : {}) }) });
  try { await host.init(); await host.relinkClaudeCode(); } finally { await host.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); }
  return checks.at(-1);
}

test('the journal record holds the category, a count and a flag, and nothing else', async () => {
  const unverified = await recorded('unverified', { why: 'repeated-same', rows: 2, headerRepeated: true });
  assert.equal(unverified.unreadable, 'repeated-same'); assert.equal(unverified.rows, 2); assert.equal(unverified.headerRepeated, true);
  assert.ok(!JSON.stringify(unverified).includes('Roaming'));
  const linked = await recorded('linked', { why: 'repeated-same', rows: 2, headerRepeated: true });
  for (const key of ['unreadable', 'rows', 'headerRepeated']) assert.ok(!(key in linked), key);
});

test('the journal validator drops unknown categories and bad numbers', () => {
  const entry = (extra: object, state = 'unverified') => buildJournalEntry({ type: 'claude-link', characterId: null, state, trigger: 'auto', ...extra } as never, 1_700_000_000_000) as any;
  const ok = entry({ unreadable: 'no-status', rows: 1, headerRepeated: true });
  assert.deepEqual([ok.unreadable, ok.rows, ok.headerRepeated], ['no-status', 1, true]);
  const unknown = entry({ unreadable: 'C:\\Users\\me\\x', rows: 2, headerRepeated: true });
  for (const key of ['unreadable', 'rows', 'headerRepeated']) assert.ok(!(key in unknown), key);
  assert.ok(!('rows' in entry({ unreadable: 'cut-off', rows: 'two' })));
  assert.ok(!('rows' in entry({ unreadable: 'cut-off', rows: 99 })));
  assert.ok(!('unreadable' in entry({ unreadable: 'cut-off' }, 'linked')), 'not kept for other states');
});
