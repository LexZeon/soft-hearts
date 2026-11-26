// Runs tests/helpers/app-stand-in/run.ts in a child process (electron/main.ts keeps module state, so one app per process) and returns its
// report (flaky under the full suite's load, 11-17: the in-child waits are on events now and the kill timeout is STAND_IN_DEADLINE_MS, 600 s, and the tests' own timeouts follow it, 11-21; overhaul step 7, docs/claude/2026-11-17-isolation-step7.md). Each run gets a fresh temporary folder for its profile, removed after.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The longest one stand-in run may take before it is killed (a whole app booting under the full suite's load has taken minutes). Tests that run it set their node:test timeout from standInTimeout(runs), never lower. */
export const STAND_IN_DEADLINE_MS = 600_000;
/** node:test timeout for a test that runs the stand-in app `runs` times in a row: always longer than the kill deadline, so a stuck run fails with its own clear error, not with a bare cancellation. */
export const standInTimeout = (runs = 1): number => runs * STAND_IN_DEADLINE_MS + 60_000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface StandInReport {
  readyMs: number;
  dialogs: { title: string; text: string }[];
  quit: boolean;
  handlers: number;
  uncaught: string[];
  health: { mode: string; off: { part: string; unit: string; reason: string; when: string }[] } | null;
  clock?: string[];
  chat?: { call: unknown; events: { type: string; text: string }[] };
  claudeCalls?: { kind: string; writable: boolean }[];
  methods?: Record<string, { value?: unknown; error?: string; missing?: boolean }>;
  partHealthIpc?: { value?: { off: { part: string; unit: string }[] } } | null;
  partHealthSent?: string[];
  userAwaySent?: unknown[];
  /** Overhaul step 8: the calls the companion window made while its page loaded (before or after the shells closed), and the shells nothing filled. */
  early?: Record<string, { shellsOpen: boolean; answeredShellsOpen?: boolean; value?: unknown; error?: string; pending?: true }>;
  shellsOpen?: boolean;
  shellsUnfilled?: string[];
  loaded?: string[];
  loadedAtBoot?: string[];
  controlsVisible?: boolean;
  profile: string;
}

/** One app run under the stand-ins. `failPart`: SOFT_HEARTS_FAIL_PART; `methods`: desk: methods called once from the control window. */
export async function runStandIn(options: { failPart?: string; methods?: readonly string[]; idleSeconds?: number; waitMs?: number; early?: readonly string[]; loadMs?: number; env?: Readonly<Record<string, string>> } = {}): Promise<StandInReport> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-stand-in-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, SOFT_HEARTS_STAND_IN_ROOT: root, STAND_IN_METHODS: (options.methods ?? []).join(';;'),
      ...(options.idleSeconds !== undefined ? { STAND_IN_IDLE_SECONDS: String(options.idleSeconds) } : {}),
      ...(options.waitMs !== undefined ? { STAND_IN_WAIT_MS: String(options.waitMs) } : {}),
      ...(options.early ? { STAND_IN_EARLY_METHODS: options.early.join(';;') } : {}), ...(options.loadMs !== undefined ? { STAND_IN_LOAD_MS: String(options.loadMs) } : {}), ...(options.env ?? {}) };
    delete env.SOFT_HEARTS_FAIL_PART;
    if (!options.env?.SOFT_HEARTS_LATE_CONTROLS) delete env.SOFT_HEARTS_LATE_CONTROLS;
    if (options.failPart) env.SOFT_HEARTS_FAIL_PART = options.failPart;
    const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'tests', 'helpers', 'app-stand-in', 'run.ts')],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    // Decode across chunk borders: `out += chunk` decodes each chunk alone, and a Chinese character split between two pipe chunks came
    // out as U+FFFD (the six preinstalled cards made the report long enough to hit a border; it failed a candidate on 2026-11-25).
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const code = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(null); }, STAND_IN_DEADLINE_MS);
      child.on('exit', value => { clearTimeout(timer); resolve(value); });
    });
    const line = out.split(/\r?\n/).find(text => text.startsWith('STAND-IN-REPORT '));
    if (!line) throw new Error(`the stand-in app printed no report (exit ${code}): ${(err || out).slice(-1500)}`);
    return JSON.parse(line.slice('STAND-IN-REPORT '.length)) as StandInReport;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** Runs `jobs` with at most `limit` at a time, in order of results. */
export async function inBatches<T, R>(items: readonly T[], limit: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await job(items[index]); }
  }));
  return results;
}
