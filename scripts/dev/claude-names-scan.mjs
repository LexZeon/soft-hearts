#!/usr/bin/env node
// I-217: where does the app say "Claude" in a string? Lists every string or template piece in shared/, src/ and electron/ that holds the
// whole word Claude (comments, identifiers like setClaudeTasksEnabled and tests are not counted). The result is compared with
// scripts/dev/claude-names-allowlist.json by tests/claude-names.test.ts: a file that is not in the list, or has more such strings than
// listed, fails. The way out is to build the text from ASSISTANT_NAME / ASSISTANT_CLI_NAME (shared/foundation/assistant-name.ts), or, when
// the word has to stay (a dictionary key that t() swaps, text she reads about Claude), to add the file to the list with a class and a reason.
//
//   node scripts/dev/claude-names-scan.mjs               print counts per file
//   node scripts/dev/claude-names-scan.mjs --write       rewrite the counts in the list (keeps each file's class and why; new files need one added by hand)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ALLOWLIST_FILE = 'scripts/dev/claude-names-allowlist.json';
const WORD = /\bClaude\b/;

/**
 * The .ts files under shared/, src/ and electron/, walked on disk (2026-11-25: it used `git ls-files`, which lists nothing inside the
 * candidate build's exported source, a git-ignored folder with no repository of its own, so the guard failed there with every listed
 * file "stale"). Build output and dependencies are skipped.
 */
function sourceFiles(root) {
  const out = [], skip = new Set(['node_modules', 'dist', 'build', 'out', 'release', '.git']);
  const walk = rel => {
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = rel + '/' + entry.name;
      if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(next); }
      else if (entry.isFile()) out.push(next);
    }
  };
  for (const top of ['shared', 'src', 'electron']) walk(top);
  return out.sort();
}

/** Map file -> number of strings that hold the whole word Claude. */
export function scanClaudeNameLiterals(root = ROOT) {
  const counts = new Map();
  for (const raw of sourceFiles(root)) {
    const f = raw.replace(/\\/g, '/');
    if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (!WORD.test(text)) continue;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    let n = 0;
    const visit = node => {
      const piece = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
      if (piece && WORD.test(node.text)) n++;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (n) counts.set(f, n);
  }
  return counts;
}

export function readAllowlist(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, ALLOWLIST_FILE), 'utf8'));
}

/** Failures: files over their allowed count (or unlisted). `stale` are listed files that no longer need the entry. */
export function checkClaudeNames(counts, allowlist) {
  const failures = [], stale = [], files = allowlist.files ?? {};
  for (const [f, n] of counts) {
    const entry = files[f];
    if (!entry) failures.push(`${f}: ${n} string(s) name Claude directly; build them from ASSISTANT_NAME / ASSISTANT_CLI_NAME (shared/foundation/assistant-name.ts) or list the file in ${ALLOWLIST_FILE} with a class and a reason`);
    else if (n > entry.count) failures.push(`${f}: ${n} string(s) name Claude directly, the list allows ${entry.count}`);
  }
  for (const [f, entry] of Object.entries(files)) if (!counts.has(f) || counts.get(f) < entry.count) stale.push(f);
  return { failures, stale };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const counts = scanClaudeNameLiterals();
  if (process.argv.includes('--write')) {
    const data = readAllowlist();
    for (const f of Object.keys(data.files)) { if (counts.has(f)) data.files[f].count = counts.get(f); else delete data.files[f]; }
    const missing = [...counts.keys()].filter(f => !data.files[f]);
    fs.writeFileSync(path.join(ROOT, ALLOWLIST_FILE), JSON.stringify(data, null, 1) + '\n');
    console.log(missing.length ? `Not listed yet (add a class and a reason by hand):\n${missing.join('\n')}` : 'List updated.');
  } else {
    for (const [f, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${n}\t${f}`);
    console.log(`${counts.size} files, ${[...counts.values()].reduce((a, b) => a + b, 0)} strings`);
  }
}
