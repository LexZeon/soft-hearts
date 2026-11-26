#!/usr/bin/env node
// "Only gets smaller" size check (overhaul 2026-11-16, plan section 8 item 2). Before the overhaul electron/main.ts grew from about
// 218 KB to 361 KB because nothing stopped it; big files cost context and make parallel sub-agents collide. The data is
// scripts/dev/size-debt.json; tests/size-check.test.mjs fails in the normal suite when a rule is broken.
//
//   node scripts/dev/size-check.mjs                      check; when all is well, lower the pins of files that shrank (written to the data file)
//   node scripts/dev/size-check.mjs --no-write           check only
//   node scripts/dev/size-check.mjs --repin <path> --reason "why"   deliberately pin a file at its size today (a diff shows it)
//   node scripts/dev/size-check.mjs --repin-handlers --reason "why" deliberately set the handler count to today's
//   node scripts/dev/size-check.mjs --init               write the data file from today's numbers (first time only)
//
// Rules:
//   hotspots: pinned at their size, may only shrink (no slack). Same for the count of host(/scopedHost( registrations in electron/main.ts.
//   pinned big files (over the limit when pinned): may grow by `slack` over the pin for ordinary feature work; beyond that: split first or re-pin.
//   every other file: at most `limit` bytes (new files and small files that grow past it).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_FILE = 'scripts/dev/size-debt.json';
export const HOTSPOTS = ['electron/main.ts', 'src/main.ts', 'shared/contracts.ts', 'electron/safety/preload.ts'];
const SOURCE_DIRS = ['electron/', 'src/', 'shared/', 'scripts/'];
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/;
const HANDLER = /^[ \t]*(?:host|scopedHost)\(/gm;
const NOTE = 'Size debt baseline (scripts/dev/size-check.mjs). Hotspots and the handler count may only shrink; other big files may grow by slack; new files at most limit bytes. Shrinking lowers the pins automatically; raising one is deliberate: node scripts/dev/size-check.mjs --repin <path> --reason "why" (the reason shows in the diff).';

/** Source files (tracked or new, not ignored, still on disk) with their byte sizes. */
export function scanSizes(root = ROOT) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', ...SOURCE_DIRS], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = new Map();
  for (const raw of out.split('\0')) {
    const f = raw.replace(/\\/g, '/');
    if (!f || !SOURCE_EXT.test(f)) continue;
    try { files.set(f, fs.statSync(path.join(root, f)).size); } catch { /* deleted but still listed */ }
  }
  return files;
}

/** Count of host( / scopedHost( registrations at the start of a line in the given source text. */
export function countHandlers(text) {
  return (text.match(HANDLER) ?? []).length;
}

/**
 * files: Map path -> bytes; handlers: current count; debt: the data file.
 * Returns { failures: [{ path, kind, now, limit, message }], shrunk: [{ path, was, now }], stale: [path] }.
 */
export function checkSizes({ files, handlers, debt }) {
  const { slack, limit } = debt;
  const hot = debt.hotspots ?? {};
  const pinned = debt.pinned ?? {};
  const failures = [];
  const shrunk = [];
  const stale = [];
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  for (const [p, pin] of Object.entries(hot)) {
    const now = files.get(p);
    if (now === undefined) { stale.push(p); continue; }
    if (now > pin.bytes) failures.push({ path: p, kind: 'hotspot', now, limit: pin.bytes, message: `${p} 是热点文件，只能变小：现在 ${now} 字节，钉住的是 ${pin.bytes}（${kb(now)} > ${kb(pin.bytes)}）。把新东西放进别的文件；确实要涨就 --repin 并写理由` });
    else if (now < pin.bytes) shrunk.push({ path: p, was: pin.bytes, now });
  }
  if (debt.handlers && typeof handlers === 'number') {
    if (handlers > debt.handlers.count) failures.push({ path: debt.handlers.file, kind: 'handlers', now: handlers, limit: debt.handlers.count, message: `${debt.handlers.file} 里 host(/scopedHost( 注册只能变少：现在 ${handlers}，钉住的是 ${debt.handlers.count}。新的处理函数放进各部分的接线文件` });
    else if (handlers < debt.handlers.count) shrunk.push({ path: `${debt.handlers.file}#handlers`, was: debt.handlers.count, now: handlers });
  }
  for (const p of Object.keys(pinned)) if (!files.has(p)) stale.push(p);
  for (const [p, now] of files) {
    if (hot[p]) continue;
    const pin = pinned[p];
    if (pin) {
      if (now > pin.bytes + slack) failures.push({ path: p, kind: 'pinned', now, limit: pin.bytes + slack, message: `${p} 已经很大（钉住 ${kb(pin.bytes)}，允许多 ${kb(slack)}）：现在 ${kb(now)}。先拆这个文件；确实不拆就 --repin 并写理由` });
      else if (now < pin.bytes) shrunk.push({ path: p, was: pin.bytes, now });
    } else if (now > limit) {
      failures.push({ path: p, kind: 'over-limit', now, limit, message: `${p} 是 ${kb(now)}，超过单个文件 ${kb(limit)} 的上限。先拆开；确实不拆就 --repin 并写理由` });
    }
  }
  failures.sort((a, b) => a.path.localeCompare(b.path));
  return { failures, shrunk, stale };
}

export function loadDebt(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, DATA_FILE), 'utf8'));
}

function saveDebt(root, debt) {
  const pinned = Object.fromEntries(Object.entries(debt.pinned ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(root, DATA_FILE), JSON.stringify({ ...debt, pinned }, null, 1) + '\n');
}

/** Lower the pins of everything that shrank; drop pins of files gone or now under the limit. Mutates and returns debt. */
export function lowerPins(debt, files, handlers) {
  for (const p of Object.keys(debt.hotspots ?? {})) { const now = files.get(p); if (now !== undefined && now < debt.hotspots[p].bytes) debt.hotspots[p].bytes = now; }
  for (const p of Object.keys(debt.pinned ?? {})) {
    const now = files.get(p);
    if (now === undefined || now <= debt.limit) delete debt.pinned[p];
    else if (now < debt.pinned[p].bytes) debt.pinned[p].bytes = now;
  }
  if (debt.handlers && typeof handlers === 'number' && handlers < debt.handlers.count) debt.handlers.count = handlers;
  return debt;
}

/** A fresh data file from today's numbers. */
export function initialDebt(files, handlersFile, handlers, reason) {
  const limit = 40 * 1024;
  const debt = { note: NOTE, limit, slack: 4 * 1024, hotspots: {}, handlers: { file: handlersFile, count: handlers, reason }, pinned: {} };
  for (const h of HOTSPOTS) if (files.has(h)) debt.hotspots[h] = { bytes: files.get(h), reason };
  for (const [p, n] of files) if (n > limit && !debt.hotspots[p]) debt.pinned[p] = { bytes: n, reason };
  return debt;
}

export function currentHandlers(root, debt) {
  if (!debt?.handlers) return null;
  try { return countHandlers(fs.readFileSync(path.join(root, debt.handlers.file), 'utf8')); } catch { return null; }
}

export function main(argv, root = ROOT) {
  const files = scanSizes(root);
  const date = new Date().toISOString().slice(0, 10);
  if (argv.includes('--init')) {
    const text = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
    saveDebt(root, initialDebt(files, 'electron/main.ts', countHandlers(text), `${date} baseline when the check was added`));
    console.log(`written ${DATA_FILE}`);
    return 0;
  }
  const debt = loadDebt(root);
  const handlers = currentHandlers(root, debt);
  const reasonAt = argv.indexOf('--reason');
  const reason = reasonAt >= 0 ? argv[reasonAt + 1] : '';
  const repinAt = argv.indexOf('--repin');
  if (repinAt >= 0 || argv.includes('--repin-handlers')) {
    if (!reason || reason.startsWith('--')) { console.error('重新钉住要写一句理由：--reason "为什么"'); return 2; }
    if (repinAt >= 0) {
      const p = argv[repinAt + 1]?.replace(/\\/g, '/');
      const now = files.get(p);
      if (now === undefined) { console.error(`找不到源文件 ${p}`); return 2; }
      if (debt.hotspots[p]) debt.hotspots[p] = { bytes: now, reason: `${date} ${reason}` };
      else debt.pinned[p] = { bytes: now, reason: `${date} ${reason}` };
      console.log(`${p} 钉在 ${now} 字节：${reason}`);
    } else {
      debt.handlers.count = handlers;
      debt.handlers.reason = `${date} ${reason}`;
      console.log(`处理函数个数钉在 ${handlers}：${reason}`);
    }
    saveDebt(root, debt);
    return 0;
  }
  const result = checkSizes({ files, handlers, debt });
  for (const f of result.failures) console.error(`失败：${f.message}`);
  for (const p of result.stale) console.log(`提示：钉住的 ${p} 已经不在（搬走或改名了）；下次成功的检查会清掉它`);
  const loose = Object.keys(debt.pinned).filter((p) => (files.get(p) ?? 0) <= debt.limit);
  if (!result.failures.length && !argv.includes('--no-write') && (result.shrunk.length || result.stale.length || loose.length)) {
    saveDebt(root, lowerPins(debt, files, handlers));
    for (const s of result.shrunk) console.log(`变小了：${s.path} ${s.was} -> ${s.now}，钉住的数字已降低（记得提交 ${DATA_FILE}）`);
  }
  if (!result.failures.length) console.log(`大小检查通过：${files.size} 个源文件，${Object.keys(debt.pinned).length} 个大文件钉着，${Object.keys(debt.hotspots).length} 个热点，处理函数 ${handlers}`);
  return result.failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
