#!/usr/bin/env node
// no-pet-ok-file: this check has to spell the word it forbids
// "Only gets fewer" check for the word "pet" meaning her or her window (I-160).
// The replacement word is companion; this check does not rename anything:
// it counts today's uses per file (scripts/dev/no-pet-baseline.json) and fails when a file gets more, when a new file has
// any, or when a new file NAME contains pet. Tests: tests/no-pet-check.test.ts (part of the normal suite).
//
//   node scripts/dev/no-pet-check.mjs             check; prints what is new
//   node scripts/dev/no-pet-check.mjs --lower     rewrite the baseline when things only got fewer
//   node scripts/dev/no-pet-check.mjs --init      write the baseline from today (first time only)
//   node scripts/dev/no-pet-check.mjs --report    print today's numbers by category (the audit, docs/claude/2026-11-19-no-pet-audit.md)
//
// Scope: code under src/ electron/ shared/ scripts/ tests/ (.ts .mts .mjs .js .cjs .html .css .json .ps1 .cs ...) and the .md files of
// handbook/, docs/claude/ and the READMEs of the code folders. Not scanned: node_modules, docs/archive and other docs (history), assets (third-party), the baselines and the generated test-parts.json (it only lists test file names).
// What counts: the word pet / pets as its own word or as a part of a camelCase / snake_case / kebab-case name (petWindow, isPet,
// PET_X, show_pet, pet-xxx). What does not: "pet name" (nickname), petal, carpet, repetition, competent and other words that
// merely contain the letters.
// Exemptions: a comment `no-pet-ok: why` on the same line or the line above (the reason is the point: write why), or
// `no-pet-ok-file: why` in the first 10 lines for a file that is about the word itself (this script, its test, the audit).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASELINE_FILE = 'scripts/dev/no-pet-baseline.json';
export const HINT = '不要用 pet 指她，用 companion；说她时用 she/her 或她的名字；确实不是指她（别的意思、对外必须保持的旧名字）就在同一行或上一行写 // no-pet-ok: 理由';
const SCOPE_DIRS = ['src/', 'electron/', 'shared/', 'scripts/', 'tests/', 'handbook/', 'docs/claude/'];
const CODE_EXT = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|html|css|json|ps1|cs|cmd|sh|svg)$/;
const SKIP = (f) => f === BASELINE_FILE || f === 'scripts/dev/hardcoded-zh-baseline.json' || f === 'scripts/dev/test-parts.json' || /(^|\/)node_modules\//.test(f);
const TS_EXT = /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/;
const MARK = /no-pet-ok(?:-file)?:/;
const FILE_MARK = /no-pet-ok-file:/;

export function inScope(f) {
  if (SKIP(f) || !SCOPE_DIRS.some((d) => f.startsWith(d))) return false;
  if (f.endsWith('.md')) return true; // handbook/, docs/claude/ and the READMEs of the code folders
  return CODE_EXT.test(f);
}

function listFiles(root) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', ...SCOPE_DIRS], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').map((f) => f.replace(/\\/g, '/')).filter(Boolean).filter(inScope);
}

/** Offsets of every "pet" that is a word or a camelCase / snake_case / kebab-case part of a name, without "pet name". */
export function petMatches(text) {
  const out = [];
  const runs = /[A-Za-z]+/g;
  let run;
  while ((run = runs.exec(text))) {
    const parts = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g;
    let part;
    while ((part = parts.exec(run[0]))) {
      if (!/^pets?$/i.test(part[0])) continue;
      const index = run.index + part.index;
      const len = part[0].length;
      const tail = text.slice(index + len, index + len + 8);
      if (/^[ -]names?(?![A-Za-z])/i.test(tail)) continue; // "pet name": a nickname, not her
      out.push({ index, len });
    }
  }
  return out;
}

/** Offsets -> category of the token holding them (TypeScript / JavaScript sources). Anything outside a token is a comment. */
function tokenSpans(file, text) {
  const kind = /\.m?[jt]sx?$|\.cjs$|\.cts$/.test(file) && !/\.(?:ts|mts|cts|tsx)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const spans = [];
  const push = (node, category) => spans.push([node.getStart(sf), node.getEnd(), category]);
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) push(node, 'identifier');
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const importish = node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || (ts.isCallExpression(node.parent) && /^(?:require|import)$/.test(node.parent.expression.getText(sf))));
      push(node, importish ? 'import-path' : /\s/.test(node.text) ? 'string-text' : 'string-key');
    } else if (ts.isRegularExpressionLiteral(node)) push(node, 'string-key');
    ts.forEachChild(node, visit);
  };
  visit(sf);
  spans.sort((a, b) => a[0] - b[0]);
  return spans;
}

const spanAt = (spans, pos) => {
  let lo = 0, hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pos < spans[mid][0]) hi = mid - 1; else if (pos >= spans[mid][1]) lo = mid + 1; else return spans[mid];
  }
  return null;
};

/** One of: ui-text, comment, identifier, string-key, string-text, import-path, doc, other. */
function categoryOf(file, text, index, spans) {
  if (file.endsWith('.md')) return 'doc';
  if (TS_EXT.test(file)) {
    const span = spanAt(spans, index);
    if (!span) return 'comment';
    if (span[2] === 'string-text' && /^shared\/foundation\/ui-copy\..*\.en\.ts$/.test(file)) return 'ui-text';
    return span[2];
  }
  if (file.endsWith('.html')) {
    const before = text.lastIndexOf('<!--', index);
    if (before >= 0 && text.indexOf('-->', before) >= index) return 'comment';
    const lt = text.lastIndexOf('<', index), gt = text.lastIndexOf('>', index);
    return lt > gt ? 'identifier' : 'ui-text';
  }
  if (file.endsWith('.css')) {
    const before = text.lastIndexOf('/*', index);
    return before >= 0 && text.indexOf('*/', before) >= index ? 'comment' : 'identifier';
  }
  if (file.endsWith('.json')) return 'string-key';
  return 'other';
}

/** Hits in one file: [{ line, category, text }] (exemptions already removed). */
export function scanFile(file, text) {
  if (FILE_MARK.test(text.split(/\r?\n/).slice(0, 10).join('\n'))) return [];
  const matches = petMatches(text);
  if (!matches.length) return [];
  const lines = text.split(/\r?\n/);
  const lineStarts = [];
  let pos = 0;
  for (const l of text.split(/(?<=\n)/)) { lineStarts.push(pos); pos += l.length; }
  const lineOf = (i) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= i) lo = mid; else hi = mid - 1; } return lo; };
  const spans = TS_EXT.test(file) ? tokenSpans(file, text) : [];
  const hits = [];
  for (const m of matches) {
    const line = lineOf(m.index);
    if (MARK.test(lines[line] ?? '') || MARK.test(lines[line - 1] ?? '')) continue;
    const start = Math.max(0, m.index - 12);
    hits.push({ line: line + 1, category: categoryOf(file, text, m.index, spans), text: text.slice(start, m.index + m.len + 12).replace(/\s+/g, ' ') });
  }
  return hits;
}

/** True when the file or folder name itself carries the word. */
export const nameHasPet = (f) => petMatches(f.split('/').slice(-1)[0].replace(/\./g, ' ')).length > 0 || f.split('/').slice(0, -1).some((d) => petMatches(d).length > 0);

/** { counts: { file: n }, names: [file...] } for the repository. Files exempted by no-pet-ok-file are not listed. */
export function scanRepository(root = ROOT, withHits = false) {
  const counts = {};
  const names = [];
  const hits = {};
  for (const f of listFiles(root)) {
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const found = scanFile(f, text);
    if (found.length) { counts[f] = found.length; hits[f] = found; }
    if (nameHasPet(f) && !FILE_MARK.test(text.split(/\r?\n/).slice(0, 10).join('\n'))) names.push(f);
  }
  names.sort();
  return withHits ? { counts, names, hits } : { counts, names };
}

/** What is beyond the baseline: [{ file, now, was }] for counts, and the new file names. */
export function newOnes(now, baseline) {
  const counts = [];
  for (const [file, n] of Object.entries(now.counts)) {
    const was = baseline.counts?.[file] ?? 0;
    if (n > was) counts.push({ file, now: n, was });
  }
  const known = new Set(baseline.names ?? []);
  const names = now.names.filter((f) => !known.has(f));
  return { counts, names };
}

export function loadBaseline(root = ROOT) {
  const j = JSON.parse(fs.readFileSync(path.join(root, BASELINE_FILE), 'utf8'));
  return { counts: j.counts ?? {}, names: j.names ?? [] };
}

export const total = (counts) => Object.values(counts).reduce((n, v) => n + v, 0);

function save(root, now) {
  const sort = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const note = '"pet" 指她的写法的基线（scripts/dev/no-pet-check.mjs，I-160）。每个文件的数只能变少，新文件和文件名带 pet 的新文件不行。变少后 node scripts/dev/no-pet-check.mjs --lower 写回。';
  fs.writeFileSync(path.join(root, BASELINE_FILE), JSON.stringify({ note, counts: sort(now.counts), names: now.names }, null, 1) + '\n');
}

export function describeNew(fresh) {
  const lines = [];
  for (const f of fresh.counts) lines.push(`${f.file}: pet 从 ${f.was} 处变成 ${f.now} 处。${HINT}`);
  for (const f of fresh.names) lines.push(`${f}: 文件名带 pet 的新文件。${HINT}`);
  return lines;
}

export function main(argv, root = ROOT) {
  if (argv.includes('--report')) {
    const { counts, names, hits } = scanRepository(root, true);
    const byCategory = {};
    for (const list of Object.values(hits)) for (const h of list) byCategory[h.category] = (byCategory[h.category] ?? 0) + 1;
    console.log(JSON.stringify({ total: total(counts), files: Object.keys(counts).length, fileNamesWithPet: names.length, byCategory }, null, 1));
    return 0;
  }
  const now = scanRepository(root);
  if (argv.includes('--init')) { save(root, now); console.log(`written ${BASELINE_FILE}: ${total(now.counts)} uses in ${Object.keys(now.counts).length} files, ${now.names.length} file names`); return 0; }
  const baseline = loadBaseline(root);
  const fresh = newOnes(now, baseline);
  if (fresh.counts.length || fresh.names.length) { for (const l of describeNew(fresh)) console.error(l); return 1; }
  if (argv.includes('--lower')) { save(root, now); console.log(`baseline lowered to ${total(now.counts)}`); }
  else console.log(`pet 检查通过：基线 ${total(baseline.counts)} 处，现在 ${total(now.counts)} 处`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
