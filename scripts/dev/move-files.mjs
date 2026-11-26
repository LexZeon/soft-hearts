#!/usr/bin/env node
// Move source files and rewrite every reference to them (docs/claude/2026-11-16-move-tool.md; overhaul plan section 8, step 1).
//   node scripts/dev/move-files.mjs --plan plan.json [--dry-run] [--docs]    plan.json: [{ "from": "electron/a.ts", "to": "electron/mood/a.ts" }, ...]
//   node scripts/dev/move-files.mjs --from electron/a.ts --to electron/mood/a.ts [--dry-run]
//   A "from" ending in "/" moves the whole folder (every file under it) to the "to" folder.
// What is rewritten, in every tracked or not-ignored text file of the repo (electron/ shared/ src/ tests/ scripts/, root configs, html):
//   - relative import / export / dynamic import() / require() specifiers and any other relative string literal that resolves to a moved
//     file (new URL('../x.ts', import.meta.url), mock.module(...)), keeping the specifier style: with or without extension, .js for .ts, a folder index;
//   - the moved file's own relative specifiers;
//   - path text naming a moved file, in code, comments, json, html, cmd, ps1: 'electron/main.ts', '../electron/x.ts', `${root}/electron/x.ts`,
//     and path.join(root, 'electron', 'x.ts') (a run of string arguments is replaced by one literal);
//   - ?raw / ?url suffixes are kept.
// Line endings and everything outside the replaced text stay byte for byte. Refuses a missing source, an existing target, duplicate
// targets or sources, and a target outside the repo. Not rewritten: markdown (listed; --docs rewrites it), folder names, paths built at run time.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { maskCode, resolveImport } from './structure-inventory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
const CODE_EXT = /\.(?:ts|tsx|mts|mjs|cjs|js)$/;
const TEXT_EXT = /\.(?:ts|tsx|mts|mjs|cjs|js|json|html|css|cmd|ps1|yml|yaml)$/;
const DOC_EXT = /\.md$/;
const SKIP_DIRS = /^(?:node_modules|\.git|\.local|\.claude\/worktrees|dist|dist-electron|release|assets)\//;
const MAX_BYTES = 3 * 1024 * 1024;
const TOKEN_RE = /[\w.\-]+(?:[\\/][\w.\-]+)+/g;

const posix = (p) => p.replace(/\\/g, '/');
const stripTrail = (t) => t.replace(/[.\-]+$/, '');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Every repo file (tracked, or untracked and not ignored), forward slashes. */
export function listRepoFiles(root) {
  const out = git(root, ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return out.split('\0').filter(Boolean).map(posix);
}

/** Validate a plan and expand folder moves. Returns { moves: [{from,to}], errors: [string] }. */
export function normalizePlan(raw, files, root) {
  const errors = [];
  const fileSet = new Set(files);
  const moves = [];
  for (const m of raw) {
    let from = posix(String(m.from ?? '')).replace(/^\.\//, '');
    let to = posix(String(m.to ?? '')).replace(/^\.\//, '');
    if (!from || !to) { errors.push(`missing from or to: ${JSON.stringify(m)}`); continue; }
    if (from.endsWith('/')) {
      if (!to.endsWith('/')) to += '/';
      const inside = files.filter((f) => f.startsWith(from));
      if (!inside.length) errors.push(`folder ${from} has no files`);
      for (const f of inside) moves.push({ from: f, to: to + f.slice(from.length) });
    } else moves.push({ from, to });
  }
  const sources = new Set();
  const targets = new Set();
  for (const m of moves) {
    if (m.to.startsWith('/') || /^[A-Za-z]:/.test(m.to) || path.posix.normalize(m.to).startsWith('..')) errors.push(`target outside the repo: ${m.to}`);
    if (!fileSet.has(m.from)) errors.push(`source does not exist: ${m.from}`);
    if (m.from === m.to) errors.push(`source and target are the same: ${m.from}`);
    if (sources.has(m.from)) errors.push(`source listed twice: ${m.from}`);
    if (targets.has(m.to)) errors.push(`two moves to the same target: ${m.to}`);
    sources.add(m.from); targets.add(m.to);
    if (fileSet.has(m.to) || fs.existsSync(path.join(root, m.to))) errors.push(`target already exists: ${m.to}`);
    // a parent of the target that is a file would make the folder impossible
    for (let d = path.posix.dirname(m.to); d && d !== '.'; d = path.posix.dirname(d)) if (fileSet.has(d)) errors.push(`target ${m.to} sits under a file ${d}`);
  }
  return { moves, errors };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Specifier rewriting

/** The new text of a relative specifier after the importer and/or the target moved, in the same style as the old one. */
export function rewriteSpecifier({ spec, fromOld, fromNew, targetOld, targetNew }) {
  const suffix = (spec.match(/[?#].*$/) ?? [''])[0];
  const clean = spec.slice(0, spec.length - suffix.length);
  const dirOld = path.posix.dirname(fromOld);
  const joined = path.posix.normalize(path.posix.join(dirOld, clean));
  const ext = path.posix.extname(targetOld);
  const noExt = targetOld.slice(0, targetOld.length - ext.length);
  const isIndex = /^index\./.test(path.posix.basename(targetOld));
  let style = 'full';
  if (joined === targetOld) style = 'full';
  else if (joined === noExt) style = 'none';
  else if (/\.m?js$/.test(clean) && joined.replace(/\.m?js$/, '') === noExt) style = clean.endsWith('.mjs') ? 'mjs' : 'js';
  else if (isIndex && joined === path.posix.dirname(targetOld)) style = 'dir';
  const extNew = path.posix.extname(targetNew);
  const noExtNew = targetNew.slice(0, targetNew.length - extNew.length);
  let target;
  if (style === 'full') target = targetNew;
  else if (style === 'none') target = noExtNew;
  else if (style === 'js') target = `${noExtNew}.js`;
  else if (style === 'mjs') target = `${noExtNew}.mjs`;
  else target = /^index\./.test(path.posix.basename(targetNew)) ? path.posix.dirname(targetNew) : noExtNew;
  let rel = path.posix.relative(path.posix.dirname(fromNew), target);
  // An extensionless target equal to the importer's own folder is a file next to a folder of the same name (electron/asr.ts from
  // electron/asr/x.ts): '.' would mean the folder's index, so step out and name it (parts 3).
  if (rel === '') rel = style === 'dir' ? '.' : `../${path.posix.basename(target)}`;
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel + suffix;
}

/** The name of the call whose argument list holds position `pos` (scans back over balanced parentheses), or ''. */
function enclosingCallName(text, pos) {
  let depth = 0;
  for (let k = pos - 1; k >= 0 && k > pos - 600; k--) {
    const c = text[k];
    if (c === ')') depth++;
    else if (c === '(') { if (depth === 0) return (text.slice(Math.max(0, k - 20), k).match(/[\w.$]*$/) ?? [''])[0]; depth--; }
    else if (c === ';' || c === '{' || c === '}') return '';
  }
  return '';
}

function lineOf(text, index) {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * All edits for one file: [{ start, end, text, kind }] over the original text, none overlapping.
 * ctx: { fileSet, moveMap: Map(old -> new), oldToNewSegs, fromDirs: Set(dir moved out of) }
 */
export function editsForFile(file, text, ctx, warnings) {
  const newFile = ctx.moveMap.get(file) ?? file;
  const fileMoved = newFile !== file;
  const edits = [];
  const taken = [];
  const free = (s, e) => !taken.some((t) => s < t.end && e > t.start);
  const add = (start, end, newText, kind) => {
    if (text.slice(start, end) === newText) return false;
    if (!free(start, end)) return false;
    edits.push({ start, end, text: newText, kind }); taken.push({ start, end });
    return true;
  };
  const isCode = CODE_EXT.test(file);
  const dir = path.posix.dirname(file);

  if (isCode) {
    const strings = [];
    const masked = maskCode(text, { keepStrings: true, strings });
    // 1. relative string literals that resolve to a file
    for (const s of strings) {
      if (s.quote === '`' && text.slice(s.start, s.end).includes('${')) continue;
      const spec = text.slice(s.start, s.end);
      if (!/^\.{1,2}\//.test(spec) || !/^[\w@.\-/?#=&]+$/.test(spec)) continue;
      const target = resolveImport(file, spec, ctx.fileSet);
      if (!target) {
        if (fileMoved && spec.length > 3 && /\.\w+$|\//.test(spec)) warnings.push(`${file}:${lineOf(text, s.start)}: relative path ${spec} does not resolve to a repo file; the moved file keeps it as written`);
        continue;
      }
      const targetNew = ctx.moveMap.get(target) ?? target;
      if (!fileMoved && targetNew === target) continue;
      const next = rewriteSpecifier({ spec, fromOld: file, fromNew: newFile, targetOld: target, targetNew });
      add(s.start, s.end, next, 'specifier');
    }
    // 2. path.join(root, 'electron', 'x.ts'): a run of string arguments naming a moved file becomes one literal
    const lits = strings.filter((s) => s.quote !== '`' || !text.slice(s.start, s.end).includes('${'));
    for (let i = 0; i < lits.length; i++) {
      // a run: literals separated only by commas
      let j = i;
      while (j + 1 < lits.length && /^['"`]\s*,\s*['"`]$/.test(text.slice(lits[j].end, lits[j + 1].start))) j++;
      if (j === i) continue;
      if (!/\b(?:join|resolve)$/.test(enclosingCallName(text, lits[i].start))) { i = j; continue; }
      const args = lits.slice(i, j + 1);
      const segsOf = (a) => text.slice(a.start, a.end).split('/').filter((x) => x !== '');
      for (let a = 0; a < args.length; a++) {
        const first = segsOf(args[a]);
        let skip = 0;
        while (skip < first.length && (first[skip] === '..' || first[skip] === '.')) skip++;
        // a literal that is only dot segments ('..') never starts the path: the next argument does (path.join(here, '..', 'shared', 'x'))
        if (skip === first.length) continue;
        const all = [...first.slice(skip)];
        let end = a;
        const tryMatch = () => {
          const key = all.join('/');
          return ctx.moveMap.has(key) ? key : null;
        };
        let key = tryMatch();
        while (!key && end + 1 < args.length) { end++; all.push(...segsOf(args[end])); key = tryMatch(); if (all.length > 12) break; }
        if (!key) continue;
        // where the path starts inside the first literal: after the leading dot segments
        const lit = text.slice(args[a].start, args[a].end);
        let cut = 0;
        for (let k = 0; k < skip; k++) { cut = lit.indexOf(first[k], cut) + first[k].length; if (lit[cut] === '/') cut++; }
        const startAt = args[a].start + cut;
        const endAt = args[end].end;
        const newPath = ctx.moveMap.get(key);
        // the quotes and commas between the arguments sit inside the replaced span, so the run collapses into one literal
        if (!add(startAt, endAt, newPath, 'join')) continue;
        if (fileMoved && skip) warnings.push(`${file}:${lineOf(text, args[a].start)}: path.join with ".." in a moved file: check the number of ".." by hand`);
        a = end;
      }
      i = j;
    }
  }

  // 3. path text: tokens that name a moved file (code, comments, json, html, scripts)
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = m[0];
    const start = m.index;
    const tok = stripTrail(token);
    const norm = posix(tok);
    const backslash = tok.includes('\\') && !tok.includes('/');
    const dots = (norm.match(/^(?:\.{1,2}\/)+/) ?? [''])[0];
    const rest = norm.slice(dots.length);
    let replacement = null;
    if (dots) {
      // relative to this file first
      const abs = path.posix.normalize(path.posix.join(dir, norm));
      const target = ctx.fileSet.has(abs) ? abs : null;
      if (target) {
        const targetNew = ctx.moveMap.get(target) ?? target;
        if (fileMoved || targetNew !== target) {
          let rel = path.posix.relative(path.posix.dirname(newFile), targetNew);
          if (!rel.startsWith('.')) rel = `./${rel}`;
          replacement = rel;
        }
      }
    }
    if (replacement === null && ctx.moveMap.has(rest)) replacement = dots + ctx.moveMap.get(rest);
    if (replacement === null) {
      const folder = rest.replace(/\/+$/, '');
      if (!/\.\w+$/.test(folder) && folder.includes('/') && ctx.fromDirs.has(folder)) ctx.folderMentions.push(`${file}:${lineOf(text, start)}: ${tok}`);
      continue;
    }
    if (backslash) replacement = replacement.replace(/\//g, '\\');
    add(start, start + tok.length, replacement, 'text');
  }
  return edits.sort((a, b) => a.start - b.start);
}

export function applyEdits(text, edits) {
  let out = '';
  let at = 0;
  for (const e of edits) { out += text.slice(at, e.start) + e.text; at = e.end; }
  return out + text.slice(at);
}

// ---------------------------------------------------------------------------------------------------------------------------

/** Compute the whole job without touching the disk. */
export function planMoves({ root = DEFAULT_ROOT, moves: rawMoves, docs = false }) {
  const files = listRepoFiles(root);
  const { moves, errors } = normalizePlan(rawMoves, files, root);
  if (errors.length) return { ok: false, errors, moves, changes: [], warnings: [], docsMentions: [] };
  const moveMap = new Map(moves.map((m) => [m.from, m.to]));
  const fileSet = new Set(files);
  const fromDirs = new Set(moves.map((m) => path.posix.dirname(m.from)));
  const ctx = { fileSet, moveMap, fromDirs, folderMentions: [] };
  const warnings = [];
  const changes = [];
  const docsMentions = [];
  for (const file of files) {
    if (SKIP_DIRS.test(file)) continue;
    const isText = TEXT_EXT.test(file);
    const isDoc = DOC_EXT.test(file);
    if (!isText && !isDoc) continue;
    let text;
    try {
      const st = fs.statSync(path.join(root, file));
      if (st.size > MAX_BYTES) continue;
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch { continue; }
    if (isDoc) {
      const edits = editsForFile(file, text, ctx, warnings).filter((e) => e.kind === 'text');
      if (!edits.length) continue;
      if (docs) changes.push({ file, newFile: moveMap.get(file) ?? file, text, edits, next: applyEdits(text, edits) });
      else docsMentions.push({ file, count: edits.length });
      continue;
    }
    const edits = editsForFile(file, text, ctx, warnings);
    if (edits.length) changes.push({ file, newFile: moveMap.get(file) ?? file, text, edits, next: applyEdits(text, edits) });
  }
  return { ok: true, errors: [], moves, changes, warnings, docsMentions, folderMentions: ctx.folderMentions };
}

/** Do it: git mv every file, then write the rewritten contents. */
export function applyPlan(result, root = DEFAULT_ROOT) {
  for (const m of result.moves) {
    fs.mkdirSync(path.dirname(path.join(root, m.to)), { recursive: true });
    try { git(root, ['mv', '--', m.from, m.to]); } catch { fs.renameSync(path.join(root, m.from), path.join(root, m.to)); }
  }
  for (const c of result.changes) fs.writeFileSync(path.join(root, c.newFile), c.next);
  // folders the moves emptied (rmdir only removes an empty folder)
  for (const m of result.moves) {
    for (let d = path.posix.dirname(m.from); d && d !== '.'; d = path.posix.dirname(d)) { try { fs.rmdirSync(path.join(root, d)); } catch { break; } }
  }
}

export const TSC_COMMAND = 'node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit';

export function report(result, { dryRun, root }) {
  const L = [];
  L.push(`${dryRun ? '[dry run] ' : ''}${result.moves.length} files to move, ${result.changes.length} files rewritten (${result.changes.reduce((s, c) => s + c.edits.length, 0)} edits).`);
  for (const m of result.moves) L.push(`  move ${m.from} -> ${m.to}`);
  if (dryRun) {
    for (const c of result.changes) {
      L.push(`  ${c.file}${c.newFile !== c.file ? ` (-> ${c.newFile})` : ''}`);
      for (const e of c.edits) L.push(`    line ${lineOf(c.text, e.start)} [${e.kind}]: ${c.text.slice(e.start, e.end)}  ->  ${e.text}`);
    }
  } else {
    const touched = new Set(result.changes.map((c) => c.newFile));
    for (const m of result.moves) touched.add(m.to);
    L.push(`  files touched (${touched.size}): ${[...touched].slice(0, 12).join(', ')}${touched.size > 12 ? ' ...' : ''}`);
  }
  if (result.docsMentions?.length) {
    L.push(`Markdown naming moved files, not rewritten (use --docs): ${result.docsMentions.map((d) => `${d.file} (${d.count})`).slice(0, 15).join(', ')}${result.docsMentions.length > 15 ? ` ... ${result.docsMentions.length} files` : ''}`);
  }
  if (result.folderMentions?.length) L.push(`Text naming a folder files were moved out of (check by hand, ${result.folderMentions.length}): ${result.folderMentions.slice(0, 15).join('; ')}`);
  for (const w of result.warnings) L.push(`warning: ${w}`);
  L.push(`Next: ${TSC_COMMAND}   and   node scripts/dev/test-affected.mjs`);
  return L.join('\n');
}

function parseArgs(argv) {
  const o = { plan: null, from: null, to: null, dryRun: false, docs: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') o.plan = argv[++i];
    else if (a === '--from') o.from = argv[++i];
    else if (a === '--to') o.to = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--docs') o.docs = true;
    else if (a === '--root') o.root = path.resolve(argv[++i]);
    else { console.error(`unknown argument ${a}`); process.exit(2); }
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let raw;
  if (o.plan) raw = JSON.parse(fs.readFileSync(path.resolve(o.plan), 'utf8'));
  else if (o.from && o.to) raw = [{ from: o.from, to: o.to }];
  else { console.error('usage: move-files.mjs --plan plan.json | --from a --to b  [--dry-run] [--docs]'); process.exit(2); }
  const result = planMoves({ root: o.root, moves: raw, docs: o.docs });
  if (!result.ok) { console.error(`refused:\n  ${result.errors.join('\n  ')}`); process.exit(1); }
  if (!o.dryRun) applyPlan(result, o.root);
  console.log(report(result, { dryRun: o.dryRun, root: o.root }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
