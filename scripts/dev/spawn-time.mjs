// How long does starting one Claude-chat process take on this machine? The fake Claude (scripts/lib/fake-claude.mjs) is started the way
// electron/brain/claude-process.ts starts the real one (spawn, shell false, windowsHide, three pipes, the same flags), N times:
//   node scripts/dev/spawn-time.mjs [--runs 10]
// Reported per run: `sync` = how long the spawn() call itself blocked the caller (this is what a main process feels), `spawnEvent` = until the
// 'spawn' event, `firstOutput` = until the fake Claude printed anything after being sent one line (0 if it did not). Plain `node -e 0` as a reference.
// Light (a few hundred ms in total); it uses no network and no profile. Docs: docs/claude/2026-11-18-soak.md ("按操作分开量").
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_CLAUDE_MARKER, verifyArguments } from '../lib/fake-claude.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runs = Math.max(1, Number(process.argv[process.argv.indexOf('--runs') + 1]) || 10);
const argv = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--strict-mcp-config', '--safe-mode',
  '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--system-prompt', 'spawn timing', '--model', 'timing'];
if (!verifyArguments(argv).ok) throw Error('the argv is not the companion chat argv');
const folder = mkdtempSync(path.join(os.tmpdir(), 'soft-hearts-spawn-time-'));

function once(file, args) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const child = spawn(file, args, { cwd: folder, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    const sync = performance.now() - t0;
    let spawnEvent = null, firstOutput = 0;
    child.once('spawn', () => { spawnEvent = performance.now() - t0; });
    child.stdout.once('data', () => { firstOutput = performance.now() - t0; setTimeout(() => child.kill(), 20); });
    child.once('close', () => resolve({ sync, spawnEvent, firstOutput }));
    child.on('error', () => resolve({ sync, spawnEvent, firstOutput }));
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
    child.stdin.write(line + '\n', () => {});
    setTimeout(() => child.kill(), 4000);
  });
}
const stats = list => { const sorted = [...list].sort((a, b) => a - b); return { min: sorted[0], median: sorted[sorted.length >> 1], max: sorted.at(-1) }; };
const fmt = value => value === undefined ? 'n/a' : value.toFixed(1);

const fake = [], plain = [];
for (let i = 0; i < runs; i++) fake.push(await once(process.execPath, [path.join(source, 'scripts', 'lib', 'fake-claude.mjs'), FAKE_CLAUDE_MARKER, path.join(folder, `spawn-${i}.jsonl`), ...argv]));
for (let i = 0; i < runs; i++) plain.push(await once(process.execPath, ['-e', '0']));
for (const [label, list] of [['fake Claude (node + fake-claude.mjs)', fake], ['plain node -e 0', plain]]) {
  const sync = stats(list.map(r => r.sync)), event = stats(list.filter(r => r.spawnEvent !== null).map(r => r.spawnEvent)), first = stats(list.filter(r => r.firstOutput > 0).map(r => r.firstOutput));
  console.log(`${label}, ${list.length} runs (ms, min / median / max): spawn() call blocked ${fmt(sync.min)} / ${fmt(sync.median)} / ${fmt(sync.max)}; 'spawn' event ${fmt(event.min)} / ${fmt(event.median)} / ${fmt(event.max)}; first output ${fmt(first.min)} / ${fmt(first.median)} / ${fmt(first.max)}`);
  console.log('  sync per run: ' + list.map(r => r.sync.toFixed(1)).join(', '));
}
rmSync(folder, { recursive: true, force: true });
