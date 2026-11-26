#!/usr/bin/env node
// "Only gets fewer" check for Chinese written straight into interface code (I-157).
// Interface copy must go through uiText / uiTemplate / uiHtml / uiMarkup / t so a language dictionary can translate it
// (shared/foundation/ui-languages.ts says how to add a language). Chinese in source that does NOT go through those is
// listed in scripts/dev/hardcoded-zh-baseline.json (today's debt); the baseline may only shrink, a new one fails the
// test (tests/hardcoded-zh-check.test.ts) with "route it through uiText and give English in ui-copy.*.en.ts".
//
//   node scripts/dev/hardcoded-zh-check.mjs             check; prints what is new
//   node scripts/dev/hardcoded-zh-check.mjs --lower     rewrite the baseline when things only got fewer
//   node scripts/dev/hardcoded-zh-check.mjs --init      write the baseline from today (first time only)
//
// What is scanned: every .ts under src/ plus the .html pages under src/ and the user-visible templates listed in EXTRA_FILES.
// What is NOT counted (not interface copy):
//   - comments (the scan reads string/template literals, never comments);
//   - a literal inside a call to uiText / uiTemplate(tag) / uiHtml(tag) / uiMarkup / t / registerUiMessages / translateUiCopy;
//   - a literal passed to console.*;
//   - a literal that is already a key of an English dictionary (ui-copy.*.ts files, or an `en: {...}` object): it can be translated;
//   - regular expressions (detectors, not copy);
//   - a line, or the line right above it, with a comment `ui-zh-ok: why` (developer-only text, text for the model,
//     a key translated at the place it is shown). The reason is the point: write why.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASELINE_FILE = 'scripts/dev/hardcoded-zh-baseline.json';
export const EXTRA_FILES = ['electron/brain/reply-html.ts'];
const CJK = /[㐀-鿿　-〿＀-￯]*[㐀-鿿]/;
const WRAPPERS = new Set(['uiText', 'uiTemplate', 'uiHtml', 'uiMarkup', 't', 'registerUiMessages', 'translateUiCopy']);
const MARK = /ui-zh-ok:/;

export const HINT = '请经过 uiText（或 uiTemplate / uiHtml），并在 shared/foundation/ui-copy.*.en.ts 里给英文；确实不是界面文字（开发者专用、给模型的话）就在同一行或上一行写 // ui-zh-ok: 理由';

function listFiles(root) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'src/', 'shared/foundation/', 'electron/', 'shared/voice/'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').map((f) => f.replace(/\\/g, '/')).filter(Boolean);
}

const tag = (node) => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : '';
const norm = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 60);
/** The Chinese runs of a text (Chinese characters and Chinese punctuation), one entry each, so a new word anywhere in a long chunk shows up. */
const zhRuns = (s) => (s.match(/[㐀-鿿　-〿＀-￯…·]+/g) ?? []).filter((r) => /[㐀-鿿]/.test(r)).map((r) => r.slice(0, 60));

/** Chinese property names of dictionaries: every key in ui-copy.*.ts, and in any object that is the value of an `en` property. */
export function dictionaryKeys(root, files) {
  const keys = new Set();
  const take = (obj) => {
    for (const p of obj.properties) {
      const n = p.name;
      if (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CJK.test(n.text)) keys.add(norm(n.text));
    }
  };
  for (const f of files) {
    if (!/\.ts$/.test(f)) continue;
    const isCopy = /^shared\/foundation\/ui-copy\..*\.ts$/.test(f);
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    if (!isCopy && !/\ben\s*:/.test(text)) continue;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const parent = node.parent;
        if (isCopy || (parent && ts.isPropertyAssignment(parent) && tag(parent.name) === 'en') || (parent && ts.isPropertyAssignment(parent) && ts.isStringLiteral(parent.name) && parent.name.text === 'en')) take(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return keys;
}

function insideWrapper(node) {
  for (let cur = node.parent, child = node; cur; child = cur, cur = cur.parent) {
    if (ts.isCallExpression(cur) && cur.expression !== child) {
      const callee = cur.expression;
      if (WRAPPERS.has(tag(callee))) return true;
      if (ts.isPropertyAccessExpression(callee) && tag(callee.expression) === 'console') return true;
    }
    if (ts.isStatement(cur)) return false;
  }
  return false;
}

/** The fixed text of a template tagged with uiTemplate / uiHtml is translated as a whole, so it is not hard-coded. */
function isTaggedChunk(node) {
  const template = ts.isTemplateHead(node) ? node.parent : ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.parent.parent : node;
  const tagged = template?.parent;
  return !!tagged && ts.isTaggedTemplateExpression(tagged) && tagged.template === template && WRAPPERS.has(tag(tagged.tag));
}

/** Hard-coded Chinese literals in one TypeScript source: [{ line, text }]. */
export function scanTs(file, text, translatable = new Set()) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = text.split(/\r?\n/);
  const found = [];
  const ok = (line) => MARK.test(lines[line] ?? '') || MARK.test(lines[line - 1] ?? '');
  const add = (node, value) => {
    if (!CJK.test(value)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    if (ok(line) || insideWrapper(node) || isTaggedChunk(node)) return;
    const key = norm(value);
    if (translatable.has(key) || translatable.has(norm(value.replace(/\$\{[^}]*\}/g, '{0}')))) return;
    for (const run of zhRuns(value)) found.push({ line: line + 1, text: run });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Lines of an HTML page that show Chinese outside comments: [{ line, text }]. */
export function scanHtml(file, text) {
  const blanked = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = blanked.split(/\r?\n/);
  const raw = text.split(/\r?\n/);
  const found = [];
  lines.forEach((line, i) => {
    if (!CJK.test(line) || MARK.test(raw[i]) || MARK.test(raw[i - 1] ?? '')) return;
    const visible = line.replace(/<[^>]*>/g, ' ');
    const attrs = [...line.matchAll(/\b(?:title|placeholder|aria-label|alt|data-prompt)=["']([^"']*)["']/g)].map((m) => m[1]).join(' ');
    const bits = `${visible} ${attrs}`;
    for (const run of zhRuns(bits)) found.push({ line: i + 1, text: run });
  });
  return found;
}

/** { file: [text, ...] } for the whole repository (sorted; a text repeats once per occurrence). */
export function scanRepository(root = ROOT) {
  const files = listFiles(root);
  const translatable = dictionaryKeys(root, files);
  const result = {};
  for (const f of files) {
    const inScope = (f.startsWith('src/') && /\.(?:ts|html)$/.test(f)) || EXTRA_FILES.includes(f);
    if (!inScope) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const hits = f.endsWith('.html') ? scanHtml(f, text) : scanTs(f, text, translatable);
    if (hits.length) result[f] = hits.map((h) => h.text).sort((a, b) => a.localeCompare(b));
  }
  return result;
}

/** What is in `now` beyond `baseline`: [{ file, text }] (multiset difference per file). */
export function newOnes(now, baseline) {
  const out = [];
  for (const [file, list] of Object.entries(now)) {
    const left = new Map();
    for (const t of baseline[file] ?? []) left.set(t, (left.get(t) ?? 0) + 1);
    for (const t of list) {
      const n = left.get(t) ?? 0;
      if (n > 0) left.set(t, n - 1); else out.push({ file, text: t });
    }
  }
  return out;
}

export function loadBaseline(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, BASELINE_FILE), 'utf8')).files ?? {};
}

export function countBaseline(files) {
  return Object.values(files).reduce((n, l) => n + l.length, 0);
}

function save(root, files) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  const note = '写死的中文基线（scripts/dev/hardcoded-zh-check.mjs）。只能变少；新的写死中文请经过 uiText 并在 ui-copy.*.en.ts 里给英文。变少后 node scripts/dev/hardcoded-zh-check.mjs --lower 写回。';
  fs.writeFileSync(path.join(root, BASELINE_FILE), JSON.stringify({ note, files: sorted }, null, 1) + '\n');
}

export function main(argv, root = ROOT) {
  const now = scanRepository(root);
  if (argv.includes('--init')) { save(root, now); console.log(`written ${BASELINE_FILE}: ${countBaseline(now)} literals in ${Object.keys(now).length} files`); return 0; }
  const baseline = loadBaseline(root);
  const fresh = newOnes(now, baseline);
  if (fresh.length) {
    for (const f of fresh) console.error(`${f.file}: 写死的中文「${f.text}」。${HINT}`);
    return 1;
  }
  if (argv.includes('--lower')) { save(root, now); console.log(`baseline lowered to ${countBaseline(now)}`); }
  else console.log(`写死中文检查通过：基线 ${countBaseline(baseline)} 处，现在 ${countBaseline(now)} 处`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
