// Self-healing for our lines on the bridge's 真机占用.md (2026-11-16). A heavy job that is killed (sub-agent stopped, session
// interrupted) leaves its "Claude 重活 pid N（scripts/dev/presence.mjs）" line behind, and Codex then waits for hours. A line is
// stale when its process is gone, when the pid now belongs to some unrelated process (pids are reused), or when it is older than
// 12 hours. Only lines that start with "Claude 重活 pid" are ever touched; everything else, including line endings, stays byte for byte.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEAVY_LINE = /^Claude 重活 pid (\d+)（scripts\/dev\/presence\.mjs）/u;
export const MAX_LINE_AGE_MS = 12 * 60 * 60_000;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Is this command line one of ours: this repo's path, or one of the scripts that register heavy jobs. */
export function isOurCommand(commandLine, repo = REPO) {
  const text = String(commandLine ?? '').toLowerCase().replace(/\\/g, '/');
  const root = repo.toLowerCase().replace(/\\/g, '/');
  return text.includes(root) || /(?:presence|heavy|test-all)\.mjs/.test(text);
}

/** Command lines of these pids: Map pid → string | null (alive, line unreadable); a missing pid is gone. Throws when it cannot ask. */
export function readCommandLines(pids, run = execFileSync) {
  const ids = [...new Set(pids)].filter(Number.isSafeInteger);
  const map = new Map();
  if (!ids.length) return map;
  const filter = ids.map(id => `ProcessId=${id}`).join(' OR ');
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`;
  const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  for (const row of String(out).split(/\r?\n/)) {
    const [pid, ...rest] = row.split('\t');
    if (/^\d+$/.test(pid)) map.set(Number(pid), rest.join('\t').trim() || null);
  }
  return map;
}

/** The start time a line states in its second field ("2026-11-16 03:05 -08:00"), in ms; null when it is not readable. */
export function lineStart(line) {
  const match = /^[^｜]*｜\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?\s*(Z|[+-]\d{2}:\d{2})?/u.exec(line);
  if (!match) return null;
  const at = Date.parse(`${match[1]}T${match[2]}:00${match[3] ?? ''}`);
  return Number.isFinite(at) ? at : null;
}

/**
 * Remove our stale lines. `lookup(pids)` returns Map pid → command line (null = alive but unreadable); a pid missing from the map
 * is gone. When the lookup throws, only the age rule applies. Returns { text, removed: [line…] }.
 */
export function tidyOccupancy(text, { now = Date.now(), lookup = readCommandLines, isOurs = isOurCommand, maxAgeMs = MAX_LINE_AGE_MS } = {}) {
  const source = String(text);
  const parts = source.split(/(\r?\n)/); // text, separator, text, …: the separators are kept as they are
  const pids = [];
  for (let index = 0; index < parts.length; index += 2) { const heavy = HEAVY_LINE.exec(parts[index]); if (heavy) pids.push(Number(heavy[1])); }
  if (!pids.length) return { text: source, removed: [] };
  let found = null;
  try { found = lookup(pids); } catch { found = null; }
  const removed = [];
  const kept = [];
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const heavy = HEAVY_LINE.exec(line);
    let stale = false;
    if (heavy) {
      const start = lineStart(line);
      if (start !== null && now - start > maxAgeMs) stale = true;
      else if (found) {
        const pid = Number(heavy[1]);
        if (!found.has(pid)) stale = true;
        else { const command = found.get(pid); stale = command !== null && !isOurs(command); }
      }
    }
    if (stale) { removed.push(line); continue; }
    kept.push(line);
    if (index + 1 < parts.length) kept.push(parts[index + 1]);
  }
  return { text: removed.length ? kept.join('') : source, removed };
}
