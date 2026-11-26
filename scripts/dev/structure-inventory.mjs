#!/usr/bin/env node
// Structure inventory of soft hearts next (docs/claude/2026-11-15-overhaul-plan.md, step 1).
// Reads electron/, shared/ and src/ (scripts/ and tests/ are listed separately, never assigned to a part) and writes, into --out
// (default .local/structure/, git-ignored): inventory.json, inventory.md, main-wiring.md, switches.md.
// Repeatable and dependency free: `node scripts/dev/structure-inventory.mjs [--out dir] [--root dir]`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// PART_IDS here is every group a file can be in: the 12 parts plus the foundation and wiring groups (structure-parts.mjs GROUP_IDS).
import { PART_IDS as REAL_PART_IDS, GROUP_IDS as PART_IDS, PARTS, SOURCE_ROOTS, SEPARATE_ROOTS, SOURCE_EXTENSIONS, assignPart, isFoundation, isWiring, isContract, isContractClient, isPublicPage, foundationRule } from './structure-parts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.json', '.css'];

// ---------------------------------------------------------------------------------------------------------------------------
// Source masking: comments (and optionally string contents) become spaces, newlines and offsets are kept.

/** Replace comments (and, unless keepStrings, the inside of strings and templates) with spaces; same length, same newlines. */
export function maskCode(src, { keepStrings = false, strings = null } = {}) {
  // strings: an array that receives { start, end, quote } for every string and template literal (start/end are the content range)
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let prev = '';
  let prevWord = '';
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; blank(i, j); i = j; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      if (strings) strings.push({ start: i + 1, end: j, quote: c });
      if (!keepStrings) blank(i + 1, j);
      i = j + 1; prev = c; prevWord = ''; continue;
    }
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '}') { depth--; j++; continue; }
        if (depth > 0 && src[j] === '`') { // a nested template inside ${ }: skip it whole
          j++; while (j < n && src[j] !== '`') { if (src[j] === '\\') j++; j++; }
        }
        j++;
      }
      if (strings) strings.push({ start: i + 1, end: j, quote: '`' });
      if (!keepStrings) blank(i + 1, j);
      i = j + 1; prev = '`'; prevWord = ''; continue;
    }
    if (c === '/') { // division or a regular expression literal: a regex follows an operator, an opening bracket or a keyword
      const regexAllowed = prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || prevWord === 'return' || prevWord === 'typeof' || prevWord === 'case';
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          j++;
        }
        if (j < n && src[j] === '/') { blank(i + 1, j); i = j + 1; prev = ')'; prevWord = ''; continue; }
      }
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < n && /[\w$]/.test(src[j])) j++;
      prevWord = src.slice(i, j); prev = 'a'; i = j; continue;
    }
    prev = c; prevWord = ''; i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------------------------------------------------------
// Import parsing

/** A fast offset-to-line function (binary search over the line starts). */
export function makeLineAt(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

const FROM_RE = /(?:^|[;\n}])\s*(import|export)\s+(type\s+)?([\w\s{},*$]*?)\s*from\s*(['"])([^'"\n]+)\4/g;
const SIDE_EFFECT_RE = /(?:^|[;\n}])\s*import\s*(['"])([^'"\n]+)\1/g;
const DYNAMIC_RE = /\b(import|require)\(\s*(['"`])([^'"`\n$]+)\2\s*\)/g;

/** Local names an import clause brings in: `a, { b as c, type d }, * as e` gives [a, c, d, e]. */
export function clauseNames(clause) {
  const names = [];
  const braces = clause.match(/\{([^}]*)\}/);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const piece = part.trim().replace(/^type\s+/, '');
      if (!piece) continue;
      const m = piece.match(/(?:\S+)\s+as\s+(\S+)$/);
      names.push(m ? m[1] : piece);
    }
  }
  const rest = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+/, '');
  for (const piece of rest.split(',')) { const t = piece.trim(); if (/^[A-Za-z_$][\w$]*$/.test(t)) names.push(t); }
  return names;
}

/**
 * Every module specifier a source file loads: static imports, re-exports, side-effect imports, dynamic import() and require().
 * Returns [{ spec, kind: 'import'|'export'|'side-effect'|'dynamic'|'require', typeOnly, names, line }].
 */
export function parseImports(source) {
  const code = maskCode(source, { keepStrings: true });
  const lineAt = makeLineAt(code);
  const found = [];
  for (const m of code.matchAll(FROM_RE)) {
    const at = m.index + m[0].indexOf(m[1]);
    found.push({ spec: m[5], kind: m[1], typeOnly: !!m[2], names: m[1] === 'import' ? clauseNames(m[3]) : [], line: lineAt(at) });
  }
  for (const m of code.matchAll(SIDE_EFFECT_RE)) found.push({ spec: m[2], kind: 'side-effect', typeOnly: false, names: [], line: lineAt(m.index) });
  for (const m of code.matchAll(DYNAMIC_RE)) found.push({ spec: m[3], kind: m[1] === 'import' ? 'dynamic' : 'require', typeOnly: false, names: [], line: lineAt(m.index) });
  return found.sort((a, b) => a.line - b.line);
}

/** Resolve a relative specifier from a repo-relative file to a repo-relative path present in `fileSet`, or null. */
export function resolveImport(fromPath, spec, fileSet) {
  if (!spec.startsWith('.')) return null;
  const clean = spec.replace(/[?#].*$/, '');
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), clean));
  const candidates = [base];
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
  const swapped = base.replace(/\.(m?js)$/, '');
  if (swapped !== base) for (const ext of ['.ts', '.tsx', '.mts']) candidates.push(swapped + ext);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(`${base}/index${ext}`);
  return candidates.find((c) => fileSet.has(c)) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// File walking and the inventory

function walk(dir, root, out) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = `${dir}${e.name}`;
    if (e.isDirectory()) walk(`${rel}/`, root, out);
    else if (SOURCE_EXTENSIONS.includes(path.extname(e.name))) out.push(rel);
  }
}

function countLines(text) {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

const bump = (map, key, by = 1) => { map[key] = (map[key] ?? 0) + by; };

/** Tarjan strongly connected components over a small graph {node: [neighbours]}. */
function components(graph) {
  let index = 0;
  const stack = [];
  const info = new Map();
  const result = [];
  const visit = (v) => {
    info.set(v, { index, low: index, on: true }); index++; stack.push(v);
    for (const w of graph[v] ?? []) {
      if (!info.has(w)) { visit(w); info.get(v).low = Math.min(info.get(v).low, info.get(w).low); }
      else if (info.get(w).on) info.get(v).low = Math.min(info.get(v).low, info.get(w).index);
    }
    if (info.get(v).low === info.get(v).index) {
      const comp = [];
      let w;
      do { w = stack.pop(); info.get(w).on = false; comp.push(w); } while (w !== v);
      result.push(comp);
    }
  };
  for (const v of Object.keys(graph)) if (!info.has(v)) visit(v);
  return result;
}

export function buildInventory(root = DEFAULT_ROOT) {
  const all = [];
  for (const dir of [...SOURCE_ROOTS, ...SEPARATE_ROOTS]) walk(dir, root, all);
  all.sort();
  const fileSet = new Set(all);
  const records = new Map();
  const unresolved = [];
  for (const file of all) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const isSource = SOURCE_ROOTS.some((r) => file.startsWith(r));
    const group = isSource ? 'source' : file.startsWith('tests/') ? 'tests' : 'scripts';
    const code = /\.(?:ts|tsx|mts|mjs|js)$/.test(file);
    const parsed = code ? parseImports(text) : [];
    const imports = [];
    for (const imp of parsed) {
      const target = resolveImport(file, imp.spec, fileSet);
      if (target) imports.push({ to: target, kind: imp.kind, typeOnly: imp.typeOnly, names: imp.names, line: imp.line });
      else if (imp.spec.startsWith('.')) unresolved.push({ from: file, spec: imp.spec, line: imp.line });
    }
    records.set(file, {
      path: file, group, part: isSource ? assignPart(file) : null,
      lines: countLines(text), bytes: Buffer.byteLength(text), imports, importedBy: [], testedBy: [], usedByScripts: [],
    });
  }
  for (const rec of records.values()) {
    for (const imp of rec.imports) {
      const target = records.get(imp.to);
      if (!target || target === rec) continue;
      if (rec.group === 'source') { if (!target.importedBy.includes(rec.path)) target.importedBy.push(rec.path); }
      else if (target.group === 'source') {
        const list = rec.group === 'tests' ? target.testedBy : target.usedByScripts;
        if (!list.includes(rec.path)) list.push(rec.path);
      }
    }
  }
  const sourceRecs = [...records.values()].filter((r) => r.group === 'source');
  const unassigned = sourceRecs.filter((r) => !r.part).map((r) => r.path);

  // per part numbers and the part-to-part edge counts (one edge per import statement between two source files)
  const parts = {};
  for (const id of PART_IDS) parts[id] = { id, name: PARTS[id].name, files: 0, lines: 0, bytes: 0, importsFromOtherParts: {}, importedByOtherParts: {}, byRoot: {}, tests: { files: 0, lines: 0 } };
  parts.unassigned = { id: 'unassigned', name: '未分配', files: 0, lines: 0, bytes: 0, importsFromOtherParts: {}, importedByOtherParts: {}, byRoot: {}, tests: { files: 0, lines: 0 } };
  for (const rec of sourceRecs) {
    const p = parts[rec.part ?? 'unassigned'];
    p.files++; p.lines += rec.lines; p.bytes += rec.bytes;
    bump(p.byRoot, rec.path.split('/')[0], 1);
    for (const imp of rec.imports) {
      const target = records.get(imp.to);
      if (!target || target.group !== 'source') continue;
      const from = rec.part ?? 'unassigned';
      const to = target.part ?? 'unassigned';
      if (from === to) continue;
      bump(p.importsFromOtherParts, to);
      bump(parts[to].importedByOtherParts, from);
    }
  }
  // tests: the part each test file imports most (a test for several parts is counted by its biggest share)
  const testPart = {};
  for (const rec of records.values()) {
    if (rec.group !== 'tests') continue;
    const tally = {};
    for (const imp of rec.imports) { const t = records.get(imp.to); if (t?.group === 'source') bump(tally, t.part ?? 'unassigned'); }
    const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    rec.testPart = best ? best[0] : null;
    rec.testParts = tally;
    if (best) { testPart[rec.path] = best[0]; parts[best[0]].tests.files++; parts[best[0]].tests.lines += rec.lines; }
  }

  // cycles between parts
  const graph = {};
  for (const id of PART_IDS) graph[id] = Object.keys(parts[id].importsFromOtherParts).filter((k) => k !== 'unassigned');
  const cycles = components(graph).filter((c) => c.length > 1).map((c) => c.sort());
  const mutual = [];
  for (let i = 0; i < PART_IDS.length; i++) for (let j = i + 1; j < PART_IDS.length; j++) {
    const a = PART_IDS[i]; const b = PART_IDS[j];
    const ab = parts[a].importsFromOtherParts[b] ?? 0;
    const ba = parts[b].importsFromOtherParts[a] ?? 0;
    if (ab && ba) mutual.push({ a, b, aToB: ab, bToA: ba });
  }
  mutual.sort((x, y) => Math.min(y.aToB, y.bToA) - Math.min(x.aToB, x.bToA));

  // the files that cross a part boundary most: imported from the most other parts
  const crossFiles = sourceRecs.map((r) => {
    const fromParts = new Set(r.importedBy.map((p) => records.get(p).part ?? 'unassigned').filter((p) => p !== (r.part ?? 'unassigned')));
    return { path: r.path, part: r.part, importedByParts: fromParts.size, importedBy: r.importedBy.length };
  }).filter((r) => r.importedByParts > 0).sort((a, b) => b.importedByParts - a.importedByParts || b.importedBy - a.importedBy);

  const separate = {};
  for (const group of ['tests', 'scripts']) {
    const recs = [...records.values()].filter((r) => r.group === group);
    separate[group] = { files: recs.length, lines: recs.reduce((s, r) => s + r.lines, 0) };
  }
  return { generated: new Date().toISOString(), root, records, parts, partOrder: PART_IDS, unassigned, cycles, mutual, crossFiles, separate, unresolved, testPart };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Reports

const partLabel = (id) => (id === 'unassigned' ? '未分配' : `${PARTS[id].n} ${PARTS[id].name}`);
const fmt = (n) => n.toLocaleString('en-US');

function jsonOutput(inv) {
  const files = {};
  for (const rec of inv.records.values()) {
    const entry = { path: rec.path, group: rec.group, part: rec.part, lines: rec.lines, bytes: rec.bytes,
      imports: [...new Set(rec.imports.map((i) => i.to))], importedBy: rec.importedBy };
    if (rec.group === 'source') { entry.testedBy = rec.testedBy; if (rec.usedByScripts.length) entry.usedByScripts = rec.usedByScripts; }
    if (rec.group === 'tests') { entry.testPart = rec.testPart; entry.testParts = rec.testParts; }
    files[rec.path] = entry;
  }
  return { generated: inv.generated, parts: inv.parts, cycles: { partCycles: inv.cycles, mutualPairs: inv.mutual }, unassigned: inv.unassigned,
    separate: inv.separate, unresolvedImports: inv.unresolved, files };
}

function inventoryMd(inv) {
  const L = [];
  const src = [...inv.records.values()].filter((r) => r.group === 'source');
  const totalLines = src.reduce((s, r) => s + r.lines, 0);
  L.push('# 程序结构清点', '');
  L.push(`由 \`node scripts/dev/structure-inventory.mjs\` 生成（${inv.generated.slice(0, 16).replace('T', ' ')} UTC），不要手改。分部规则在 \`scripts/dev/structure-parts.mjs\`。`, '');
  L.push(`源码 ${fmt(src.length)} 个文件、${fmt(totalLines)} 行（electron/ shared/ src/）；未分配 ${inv.unassigned.length} 个。`);
  L.push(`另有 tests/ ${fmt(inv.separate.tests.files)} 个文件 ${fmt(inv.separate.tests.lines)} 行，scripts/ ${fmt(inv.separate.scripts.files)} 个文件 ${fmt(inv.separate.scripts.lines)} 行（不分部）。`, '');
  L.push('| 部分 | 文件 | 行 | 其中 electron / shared / src | 测试文件 |', '|---|---:|---:|---|---:|');
  for (const id of [...inv.partOrder, 'unassigned']) {
    const p = inv.parts[id];
    if (id === 'unassigned' && !p.files) continue;
    L.push(`| ${partLabel(id)} | ${p.files} | ${fmt(p.lines)} | ${p.byRoot.electron ?? 0} / ${p.byRoot.shared ?? 0} / ${p.byRoot.src ?? 0} | ${p.tests.files} |`);
  }
  L.push('');
  const list = (arr) => arr.length ? arr.join('、') : '无';
  for (const id of [...inv.partOrder, 'unassigned']) {
    const p = inv.parts[id];
    if (!p.files) continue;
    const mine = src.filter((r) => (r.part ?? 'unassigned') === id);
    L.push(`## ${partLabel(id)}`, '', `${p.files} 个文件，${fmt(p.lines)} 行。`);
    L.push('', '最大的文件：');
    for (const r of [...mine].sort((a, b) => b.lines - a.lines).slice(0, 5)) L.push(`- \`${r.path}\` ${fmt(r.lines)} 行`);
    L.push('', '被引用最多的文件（来自本部分以外的引用数优先）：');
    const outside = (r) => r.importedBy.filter((x) => (inv.records.get(x).part ?? 'unassigned') !== id).length;
    for (const r of [...mine].sort((a, b) => outside(b) - outside(a) || b.importedBy.length - a.importedBy.length).slice(0, 5)) L.push(`- \`${r.path}\` 被 ${r.importedBy.length} 个文件引用（部分以外 ${outside(r)}）`);
    const dep = Object.entries(p.importsFromOtherParts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${partLabel(k)} ${v}`);
    const rev = Object.entries(p.importedByOtherParts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${partLabel(k)} ${v}`);
    L.push('', `用到别的部分（引用次数）：${list(dep)}`, `被别的部分用到：${list(rev)}`, '');
  }
  L.push('## 未分配的文件', '');
  if (inv.unassigned.length) for (const f of inv.unassigned) L.push(`- \`${f}\``);
  else L.push('无。');
  L.push('', '## 部分之间的环', '');
  if (inv.cycles.length) {
    for (const c of inv.cycles) L.push(`- 互相能走回来的一组：${c.map(partLabel).join('、')}`);
  } else L.push('没有环。');
  L.push('', '互相引用最多的成对部分（取两个方向里较小的那个排序）：', '');
  for (const m of inv.mutual.slice(0, 15)) L.push(`- ${partLabel(m.a)} -> ${partLabel(m.b)} ${m.aToB} 次；反过来 ${m.bToA} 次`);
  L.push('', '## 被最多别的部分用到的文件', '');
  for (const r of inv.crossFiles.slice(0, 15)) L.push(`- \`${r.path}\`（${partLabel(r.part ?? 'unassigned')}）：${r.importedByParts} 个别的部分、共 ${r.importedBy} 个文件引用`);
  L.push('', '## 找不到的相对引用', '');
  if (inv.unresolved.length) for (const u of inv.unresolved.slice(0, 20)) L.push(`- \`${u.from}:${u.line}\` 引用 \`${u.spec}\``);
  else L.push('无。');
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------
// main.ts wiring map

function matchClose(code, openIdx) {
  const open = code[openIdx];
  const close = { '(': ')', '{': '}', '[': ']' }[open];
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === open) depth++;
    else if (code[i] === close && --depth === 0) return i;
  }
  return -1;
}

export function mainWiring(inv, mainPath = 'electron/main.ts', root = inv.root) {
  const rec = inv.records.get(mainPath);
  if (!rec) return null;
  const text = fs.readFileSync(path.join(root, mainPath), 'utf8');
  const code = maskCode(text); // comments and string contents blanked, so identifiers and brackets are real
  const lineAt = makeLineAt(code);
  const lines = text.split(/\r?\n/);

  // names imported from modules of each part
  const nameToPart = new Map();
  const importsByPart = {};
  for (const imp of parseImports(text)) {
    const target = resolveImport(mainPath, imp.spec, new Set(inv.records.keys()));
    const part = target ? (inv.records.get(target).part ?? 'unassigned') : 'external';
    const label = target ?? imp.spec;
    (importsByPart[part] ??= []).push({ file: label, names: imp.names, line: imp.line });
    if (target) for (const n of imp.names) nameToPart.set(n, part);
  }

  // top-level objects main.ts creates (indent 0, or indent 2 inside app.whenReady)
  const objects = [];
  const declRe = /^(\s{0,2})(let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=\n]+?))?\s*(?:=\s*(.*))?$/;
  const maskedLines = code.split(/\r?\n/);
  maskedLines.forEach((ml, i) => {
    const m = ml.match(declRe);
    if (!m) return;
    const [, , kind, name, type, init] = m;
    const idents = [...(`${type ?? ''} ${init ?? ''}`).matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]);
    const hit = idents.find((id) => nameToPart.has(id));
    const isObject = !!type || /\bnew\s+[A-Z]|\b[a-z][\w$]*\(|\b[A-Z][\w$]*\(/.test(init ?? '');
    if (!isObject) return;
    objects.push({ name, kind, line: i + 1, part: hit ? nameToPart.get(hit) : 'wiring', guess: !hit, via: hit ?? null, head: lines[i].trim().slice(0, 110) });
  });
  for (const o of objects) if (!o.guess) nameToPart.set(o.name, o.part);
  // helper functions declared in main.ts: the part they mostly call into (a guess; a function that only touches main's own state stays unmapped)
  const helperFns = [];
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/gm)) {
    const open = code.indexOf('{', code.indexOf(')', m.index));
    const close = open < 0 ? -1 : matchClose(code, open);
    if (close < 0) continue;
    const tally = {};
    for (const id of code.slice(m.index, close).matchAll(/[A-Za-z_$][\w$]*/g)) { const p = nameToPart.get(id[0]); if (p && p !== 'wiring' && p !== 'external') bump(tally, p); }
    const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (best) { helperFns.push({ name: m[1], line: lineAt(m.index), part: best[0] }); }
  }
  for (const f of helperFns) if (!nameToPart.has(f.name)) nameToPart.set(f.name, f.part);

  // IPC registrations
  const ipc = [];
  const regRe = /\b(host|scopedHost)\(\s*(['"`])([^'"`\n]+)\2/g;
  const rawCode = maskCode(text, { keepStrings: true });
  for (const m of rawCode.matchAll(regRe)) {
    const openIdx = m.index + m[1].length;
    const closeIdx = matchClose(code, openIdx);
    const body = code.slice(openIdx, closeIdx < 0 ? openIdx + 2000 : closeIdx);
    const tally = {};
    for (const id of body.matchAll(/[A-Za-z_$][\w$]*/g)) { const p = nameToPart.get(id[0]); if (p) bump(tally, p); }
    const nonCore = Object.entries(tally).filter(([p]) => p !== 'wiring' && p !== 'external');
    let part = 'wiring'; let note = '没有引用别的部分，按接线算（推测）';
    if (nonCore.length === 1) { part = nonCore[0][0]; note = '确定'; }
    else if (nonCore.length > 1) { nonCore.sort((a, b) => b[1] - a[1]); part = nonCore[0][0]; note = `推测，还引用了 ${nonCore.slice(1).map(([p]) => PARTS[p]?.name ?? p).join('、')}`; }
    else if (tally.core) { note = '只引用主干的东西'; }
    ipc.push({ method: m[3], helper: m[1], line: lineAt(m.index), part, note, controlOnly: !/,\s*false\s*\)\s*;?\s*$/.test(code.slice(Math.max(openIdx, (closeIdx < 0 ? openIdx : closeIdx) - 20), closeIdx + 1)) });
  }
  // other direct registrations
  const direct = [];
  for (const m of rawCode.matchAll(/\bipcMain\.(handle|on|once)\(\s*(['"`])([^'"`\n]+)\2/g)) direct.push({ channel: m[3], via: `ipcMain.${m[1]}`, line: lineAt(m.index) });
  const wiringCalls = [];
  for (const m of code.matchAll(/\b(register[A-Z][\w$]*|wire[A-Z][\w$]*|install[A-Z][\w$]*|[a-z][\w$]*Wiring)\(/g)) {
    const p = nameToPart.get(m[1]);
    if (p) wiringCalls.push({ name: m[1], line: lineAt(m.index), part: p });
  }
  return { mainPath, lines: rec.lines, importsByPart, objects, ipc, direct, wiringCalls, nameCount: nameToPart.size };
}

function wiringMd(inv, w) {
  const L = ['# electron/main.ts 接线图', ''];
  if (!w) return `${L.join('\n')}找不到 electron/main.ts。\n`;
  L.push(`由 \`node scripts/dev/structure-inventory.mjs\` 生成，不要手改。${w.lines} 行。这是重写接线（计划第 4 步）的地图：每一块接线要搬到哪个部分的接线模块。“推测”是按调用里用到哪些别的部分的名字猜的。`, '');
  const order = [...PART_IDS, 'unassigned', 'external'];
  L.push('## 一、这个文件引用了哪些部分', '');
  for (const id of order) {
    const list = w.importsByPart[id];
    if (!list) continue;
    const label = id === 'external' ? '外部包（node、electron 等）' : partLabel(id);
    L.push(`### ${label}（${list.length} 条引用）`, '');
    for (const e of list) L.push(`- 第 ${e.line} 行 \`${e.file}\`${e.names.length ? `：${e.names.join(', ')}` : ''}`);
    L.push('');
  }
  L.push('## 二、窗口调用的入口（host / scopedHost）', '');
  const byPart = {};
  for (const r of w.ipc) (byPart[r.part] ??= []).push(r);
  L.push(`共 ${w.ipc.length} 个。按部分：${order.filter((p) => byPart[p]).map((p) => `${PARTS[p]?.name ?? p} ${byPart[p].length}`).join('；')}。`);
  L.push(`另有直接的 ipcMain 注册 ${w.direct.length} 处${w.direct.length ? '：' + w.direct.map((d) => `第 ${d.line} 行 ${d.channel}`).join('、') : ''}（host/scopedHost 自己在内部注册 desk:*）。`, '');
  for (const id of order) {
    const list = byPart[id];
    if (!list) continue;
    L.push(`### ${partLabel(id)}（${list.length} 个）`, '', '| 行 | 入口 | 说明 |', '|---:|---|---|');
    for (const r of list) L.push(`| ${r.line} | \`desk:${r.method}\`${r.helper === 'scopedHost' ? '（scopedHost）' : ''} | ${r.note} |`);
    L.push('');
  }
  L.push('## 三、顶层创建的对象（缩进 0 或 2 的 let/const，带构造或调用）', '');
  const objBy = {};
  for (const o of w.objects) (objBy[o.part] ??= []).push(o);
  L.push(`共 ${w.objects.length} 个。`, '');
  for (const id of order) {
    const list = objBy[id];
    if (!list) continue;
    L.push(`### ${partLabel(id)}（${list.length} 个）`, '');
    for (const o of list) L.push(`- 第 ${o.line} 行 \`${o.name}\`${o.guess ? '（推测：声明里没有别的部分的名字）' : ''}：\`${o.head.replace(/`/g, "'")}\``);
    L.push('');
  }
  L.push('## 四、调用各部分接线函数的位置（register*/wire*/install*/*Wiring）', '');
  const wcBy = {};
  for (const c of w.wiringCalls) (wcBy[c.part] ??= []).push(c);
  for (const id of order) {
    const list = wcBy[id];
    if (!list) continue;
    L.push(`- ${partLabel(id)}：${list.map((c) => `${c.name}（第 ${c.line} 行）`).join('、')}`);
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------
// Switches

const SWITCH_NAME_RE = /(_ENABLED|_STABLE|_DEVELOPMENT|KNOBS|knobs)/;
const ENV_RE = /SOFT_HEARTS_[A-Z0-9_]+/g;

function functionBody(code, startIdx) {
  const open = code.indexOf('{', code.indexOf(')', startIdx));
  if (open < 0) return null;
  const close = matchClose(code, open);
  return close < 0 ? null : { open, close, text: code.slice(open, close + 1) };
}

/** Value of `return <expr>;` for a channel-switched enabled function, when the expression is simple enough to read statically. */
function evalSimple(expr, consts) {
  const e = expr.trim();
  if (e === 'true' || e === 'false') return e;
  if (e === '!packaged') return 'true when not packaged';
  if (/^[A-Z][A-Z0-9_]*$/.test(e) && consts[e] !== undefined) return `${consts[e]} (${e})`;
  return null;
}

function scanSwitches(inv, root) {
  const items = [];
  const channelLines = [];
  const envBy = {};
  for (const rec of inv.records.values()) {
    if (rec.group !== 'source' || !/\.(ts|tsx|mts|mjs|js)$/.test(rec.path)) continue;
    const text = fs.readFileSync(path.join(root, rec.path), 'utf8');
    const code = maskCode(text);
    const raw = maskCode(text, { keepStrings: true });
    const lineAt = makeLineAt(code);
    const envs = [...new Set([...raw.matchAll(ENV_RE)].map((m) => m[0]))];
    for (const e of envs) (envBy[e] ??= []).push(rec.path);
    const consts = {};
    for (const m of code.matchAll(/^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*(true|false)\b/gm)) consts[m[1]] = m[2];
    for (const m of code.matchAll(/^(?:export\s+)?(?:const|function)\s+([A-Za-z0-9_]*(?:Enabled|enabled))\b/gm)) {
      const name = m[1];
      const exported = /^export/.test(m[0]);
      const body = functionBody(code, m.index);
      const bodyText = body ? raw.slice(body.open, body.close + 1) : "";
      if (!/\bchannel\b|\bpackaged\b/.test(m[0] + code.slice(m.index, m.index + 200).split('\n')[0]) && !/\bpackaged\b/.test(bodyText)) continue;
      const item = { file: rec.path, line: lineAt(m.index), name, exported, kind: 'function', env: envs };
      const values = {};
      if (body) {
        for (const r of bodyText.matchAll(/if\s*\(\s*channel\s*===\s*'(development|stable)'\s*\)\s*return\s+([^;]+);/g)) values[r[1]] = evalSimple(r[2], consts);
        const finals = [...bodyText.matchAll(/^\s*return\s+([^;]+);\s*$/gm)];
        if (finals.length) values.source = evalSimple(finals[finals.length - 1][1], consts);
      }
      item.values = { stable: values.stable ?? null, development: values.development ?? null, source: values.source ?? null };
      items.push(item);
    }
    for (const m of code.matchAll(/^export\s+const\s+([A-Za-z0-9_]+)\s*(?::[^=\n]+)?=\s*([^\n]*)/gm)) {
      const name = m[1];
      if (!SWITCH_NAME_RE.test(name)) continue;
      const item = { file: rec.path, line: lineAt(m.index), name, exported: true, env: envs };
      const lit = m[2].trim().match(/^(true|false)\b/);
      if (lit) { item.kind = 'boolean'; item.value = lit[1]; }
      else if (/KNOBS|knobs/.test(name)) {
        item.kind = 'knobs';
        const open = code.indexOf('{', m.index + m[0].indexOf('='));
        const close = open >= 0 ? matchClose(code, open) : -1;
        const objText = close > 0 ? code.slice(open, close) : '';
        item.fields = [...objText.matchAll(/^\s{1,4}([A-Za-z_]\w*)\s*:/gm)].length;
        const en = objText.match(/^\s*(enabled|on)\s*:\s*(true|false)/m);
        if (en) item.enabledField = en[2];
      } else { item.kind = 'object'; item.head = m[2].trim().slice(0, 100); }
      items.push(item);
    }
    for (const m of code.matchAll(/===?\s*'(development|stable)'|channel\s*===\s*'(development|stable)'/g)) {
      if (rec.path === 'shared/brain/prompt-switches.ts') continue;
      channelLines.push({ file: rec.path, line: lineAt(m.index), channel: m[1] ?? m[2] });
    }
  }
  return { items, channelLines, envBy };
}

function classify(item) {
  if (item.kind === 'boolean') return item.value === 'true' ? '看起来永久开（常量 true）' : '看起来永久关（常量 false）';
  if (item.kind === 'function') {
    const v = item.values;
    const set = [v.stable, v.development, v.source];
    if (set.some((x) => x === null)) return '要读代码（有环境变量或别的条件）';
    const norm = set.map((x) => (/^true|not packaged/.test(x) ? 'on' : /^false/.test(x) ? 'off' : x));
    if (norm.every((x) => x === norm[0])) return norm[0] === 'on' ? '各渠道都开' : '各渠道都关';
    return `按渠道不同：稳定版 ${norm[0]}、开发版 ${norm[1]}、源码运行 ${norm[2]}`;
  }
  return '';
}

function switchesMd(inv, sw, root) {
  const L = ['# 试验开关和参数清单', '', '由 `node scripts/dev/structure-inventory.mjs` 生成，不要手改。取值只在代码里能直接读出来时才写；读不出来的写“要读代码”。', ''];
  const enabledFns = sw.items.filter((i) => i.kind === 'function');
  const bools = sw.items.filter((i) => i.kind === 'boolean');
  L.push('## 一、按渠道开关的函数（*Enabled(channel, packaged)）', '', '渠道三种：稳定版、开发版、源码运行（没打包，channel 为空）。', '');
  L.push('| 位置 | 函数 | 稳定版 | 开发版 | 源码运行 | 环境变量 | 看起来 |', '|---|---|---|---|---|---|---|');
  for (const f of enabledFns) L.push(`| ${f.file}:${f.line} | \`${f.name}\` | ${f.values.stable ?? '?'} | ${f.values.development ?? '?'} | ${f.values.source ?? '?'} | ${f.env.join('、') || '无'} | ${classify(f)} |`);
  L.push('', '## 二、提示词开关（shared/brain/prompt-switches.ts）', '');
  const ps = fs.readFileSync(path.join(root, 'shared/brain/prompt-switches.ts'), 'utf8');
  const psCode = maskCode(ps);
  const psLine = (name) => psCode.slice(0, psCode.indexOf(name)).split('\n').length;
  for (const name of ['PROMPT_SWITCHES_STABLE', 'PROMPT_SWITCHES_DEVELOPMENT']) {
    const m = psCode.match(new RegExp(`export const ${name}[^=]*=\\s*(\\{[^}]*\\})`));
    L.push(`- shared/brain/prompt-switches.ts:${psLine(`export const ${name}`)} \`${name}\` = \`${m ? m[1].replace(/\s+/g, ' ') : '?'}\``);
  }
  L.push('- 环境变量可以临时打开：' + [...(sw.items.find((i) => i.file === 'shared/brain/prompt-switches.ts')?.env ?? []), ...Object.keys(sw.envBy).filter((e) => e.startsWith('SOFT_HEARTS_PROMPT_'))].filter((e, i, a) => a.indexOf(e) === i).join('、'));
  L.push('- 现在两个渠道的 why、situation 都是关；route 和 relaxed 默认关（只靠环境变量）。看起来永久关，直到 I-139 门通过。', '');
  L.push('## 三、写死的 true / false 常量（名字带 _ENABLED / _STABLE / _DEVELOPMENT）', '');
  L.push('| 位置 | 常量 | 值 | 环境变量 | 看起来 |', '|---|---|---|---|---|');
  for (const b of bools) L.push(`| ${b.file}:${b.line} | \`${b.name}\` | ${b.value} | ${b.env.join('、') || '无'} | ${classify(b)} |`);
  L.push('', '## 四、参数表（*_KNOBS，shared/behaviors/**/knobs.ts 等）', '');
  const knobs = sw.items.filter((i) => i.kind === 'knobs').sort((a, b) => a.file.localeCompare(b.file));
  L.push(`共 ${knobs.length} 张。多数是数值，不是开关；带 enabled 字段的单列在后面。`, '', '| 位置 | 名字 | 字段数 | enabled 字段 |', '|---|---|---:|---|');
  for (const k of knobs) L.push(`| ${k.file}:${k.line} | \`${k.name}\` | ${k.fields} | ${k.enabledField ?? ''} |`);
  const others = sw.items.filter((i) => i.kind === 'object');
  if (others.length) {
    L.push('', '## 五、其他名字符合的导出', '');
    for (const o of others) L.push(`- ${o.file}:${o.line} \`${o.name}\` = \`${o.head.replace(/`/g, "'")}\``);
  }
  const knobsEnabledOnly = knobs.filter((k) => k.enabledField);
  L.push('', '## 六、看起来永久开或永久关的（清理候选）', '');
  const permanent = [...bools.map((b) => ({ ...b, why: classify(b) })), ...enabledFns.map((f) => ({ ...f, why: classify(f) })).filter((f) => /^各渠道/.test(f.why)), ...knobsEnabledOnly.map((k) => ({ ...k, why: `参数表里 enabled = ${k.enabledField}` }))];
  if (!permanent.length) L.push('没有。');
  for (const p of permanent) L.push(`- ${p.file}:${p.line} \`${p.name}\`：${p.why}`);
  L.push('', '“稳定版关、开发版和源码运行开”的函数是在等用户试用后推到稳定版的：', '');
  for (const f of enabledFns.filter((x) => /^按渠道不同/.test(classify(x)))) L.push(`- ${f.file}:${f.line} \`${f.name}\`：${classify(f)}`);
  L.push('', '## 七、环境变量（SOFT_HEARTS_*）', '', '| 变量 | 出现在 |', '|---|---|');
  for (const [e, files] of Object.entries(sw.envBy).sort()) L.push(`| ${e} | ${files.join('、')} |`);
  const perFile = {};
  for (const c of sw.channelLines) { const k = c.file; (perFile[k] ??= []).push(`${c.line}${c.channel === 'development' ? 'd' : 's'}`); }
  L.push('', '## 八、代码里直接写 channel === development / stable 的位置', '', `共 ${sw.channelLines.length} 处，${Object.keys(perFile).length} 个文件（d = development，s = stable）。`, '');
  for (const [file, spots] of Object.entries(perFile).sort()) L.push(`- ${file}：${spots.join('、')}`);
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------

export function writeReports(inv, outDir, root = inv.root) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'inventory.json'), JSON.stringify(jsonOutput(inv), null, 1) + '\n');
  fs.writeFileSync(path.join(outDir, 'inventory.md'), inventoryMd(inv));
  const wiring = mainWiring(inv, 'electron/main.ts', root);
  fs.writeFileSync(path.join(outDir, 'main-wiring.md'), wiringMd(inv, wiring));
  const sw = scanSwitches(inv, root);
  fs.writeFileSync(path.join(outDir, 'switches.md'), switchesMd(inv, sw, root));
  return { wiring, switches: sw };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Layer check (plan section 8): foundation below, parts in the middle, wiring on top.

export const LAYER_RULES = {
  'foundation-imports-part': { title: '基础引用了部分', what: 'A foundation file imports a file that is not foundation. Grouped by the part of the imported file.' },
  'part-imports-part-internal': { title: '部分伸进别的部分的内部', what: 'A part imports another part through a file that is not that part\'s public page (folder index). Grouped by the importing part.' },
  'imports-wiring': { title: '有人引用了接线', what: 'A file that is not wiring imports a wiring file (electron/main.ts, src/main.ts, *wiring.ts). Grouped by the importing part.' },
  'wiring-imports-other-internal': { title: '部分的接线伸进别的部分的内部', what: "A part's wiring file (electron/wiring/<part>-wiring.ts, wiring rewrite step 4) imports another part through a file that is not that part's public page; it may reach into its own part's internals only. Informational, target 0. Grouped by the wiring's part." },
  'imports-contract': { title: '部分直接引用了接口总表', what: 'A part file imports the renderer↔host contract (shared/contracts.ts: DesktopAPI and single-part wire types). Only the wiring, the preload (CONTRACT_CLIENTS) and the contract may. A foundation file importing it counts under foundation-imports-part instead. Grouped by the importing part.' },
};

/**
 * The violations of the three layer rules over source files (tests and scripts are not checked). One violation per importing file and
 * imported file pair, however many import statements join them.
 * Returns { violations: [{rule, part, from, fromPart, to, toPart, line, typeOnly}], counts: {rule: {total, byPart: {part: n}}}, foundation: [paths], wiring: [paths] }.
 */
/**
 * The part an electron/wiring/<part>-wiring.ts file wires, or null (the skeleton files, every other file). A part whose wiring is split
 * over two files names the second <part>-<what>-wiring.ts (wiring rewrite step 4h: brain-chat-wiring.ts, 大脑's chat turn): it is that
 * part's wiring too and is checked the same way.
 */
export function wiringFilePart(relPath) {
  const m = /^electron\/wiring\/([\w-]+)-wiring\.ts$/.exec(relPath.replace(/\\/g, '/'));
  if (!m) return null;
  return REAL_PART_IDS.find((id) => m[1] === id || m[1].startsWith(`${id}-`)) ?? null;
}

export function checkLayers(inv) {
  const violations = [];
  const seen = new Set();
  const foundation = [];
  const wiring = [];
  const contract = [];
  for (const rec of inv.records.values()) {
    if (rec.group !== 'source') continue;
    if (isFoundation(rec.path)) foundation.push(rec.path);
    if (isWiring(rec.path)) wiring.push(rec.path);
    if (isContract(rec.path)) contract.push(rec.path);
  }
  for (const rec of inv.records.values()) {
    if (rec.group !== 'source') continue;
    const fromFoundation = isFoundation(rec.path);
    const fromWiring = isWiring(rec.path);
    const fromContract = isContract(rec.path);
    const fromPart = rec.part ?? 'unassigned';
    for (const imp of rec.imports) {
      const target = inv.records.get(imp.to);
      if (!target || target.group !== 'source' || target.path === rec.path) continue;
      const toPart = target.part ?? 'unassigned';
      const key = (rule) => `${rule}|${rec.path}|${target.path}`;
      const push = (rule, part) => {
        if (seen.has(key(rule))) return;
        seen.add(key(rule));
        violations.push({ rule, part, from: rec.path, fromPart, to: target.path, toPart, line: imp.line, typeOnly: !!imp.typeOnly });
      };
      if (isWiring(target.path) && !fromWiring) push('imports-wiring', fromPart);
      if (fromFoundation) {
        if (!isFoundation(target.path) && !isWiring(target.path)) push('foundation-imports-part', toPart);
        continue;
      }
      if (isContract(target.path)) {
        if (!fromWiring && !fromContract && !isContractClient(rec.path)) push('imports-contract', fromPart);
        continue;
      }
      // A part's wiring file reaches only into its own part (wiring rewrite step 4); the other parts through their public pages.
      const ownPart = wiringFilePart(rec.path);
      // (a file inside another part's folder counts even when it is named *wiring.ts: it is that part's internals)
      if (ownPart && toPart !== ownPart && REAL_PART_IDS.includes(toPart) && !isFoundation(target.path) && !target.path.startsWith('electron/wiring/') && !isPublicPage(target.path, toPart))
        push('wiring-imports-other-internal', ownPart);
      if (fromWiring || fromContract || isFoundation(target.path) || isWiring(target.path)) continue;
      if (fromPart !== toPart && !isPublicPage(target.path, toPart)) push('part-imports-part-internal', fromPart);
    }
  }
  const counts = {};
  for (const id of Object.keys(LAYER_RULES)) counts[id] = { total: 0, byPart: {} };
  for (const v of violations) { counts[v.rule].total++; bump(counts[v.rule].byPart, v.part); }
  for (const id of Object.keys(counts)) counts[id].byPart = Object.fromEntries(Object.entries(counts[id].byPart).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  return { violations, counts, foundation: foundation.sort(), wiring: wiring.sort(), contract: contract.sort() };
}

/** The numbers the debt baseline stores: { rule: { total, byPart } }. */
export const debtSnapshot = (layers) => layers.counts;

/** Where the current counts are higher than the baseline: [{ rule, part|null, now, was }]. */
export function debtGrowth(counts, baseline) {
  const grown = [];
  for (const [rule, now] of Object.entries(counts)) {
    const was = baseline?.rules?.[rule] ?? { total: 0, byPart: {} };
    if (now.total > was.total) grown.push({ rule, part: null, now: now.total, was: was.total });
    for (const [part, n] of Object.entries(now.byPart)) {
      const w = was.byPart?.[part] ?? 0;
      if (n > w) grown.push({ rule, part, now: n, was: w });
    }
  }
  return grown;
}

export function layersMd(inv, layers) {
  const L = [];
  L.push('# 分层检查', '');
  L.push(`由 \`node scripts/dev/structure-inventory.mjs --check-layers\` 生成（${inv.generated.slice(0, 16).replace('T', ' ')} UTC），不要手改。规则见 docs/claude/2026-11-15-overhaul-plan.md 第八节，数据在 \`scripts/dev/structure-parts.mjs\`（FOUNDATION、WIRING、PART_FOLDERS）。`, '');
  L.push(`基础 ${layers.foundation.length} 个文件，接口总表 ${layers.contract?.length ?? 0} 个，接线 ${layers.wiring.length} 个文件。每条违规 = 一对（引用方、被引用方）文件。`, '');
  L.push('| 规则 | 违规 |', '|---|---:|');
  for (const [id, r] of Object.entries(LAYER_RULES)) L.push(`| ${r.title}（\`${id}\`） | ${layers.counts[id].total} |`);
  L.push('');
  L.push('基础文件：', '');
  for (const f of layers.foundation) L.push(`- \`${f}\`：${foundationRule(f)?.why ?? ''}`);
  L.push('');
  for (const [id, r] of Object.entries(LAYER_RULES)) {
    const mine = layers.violations.filter((v) => v.rule === id);
    L.push(`## ${r.title}（\`${id}\`）`, '', r.what, '', `共 ${mine.length} 条。`, '');
    if (!mine.length) continue;
    const byPart = {};
    for (const v of mine) (byPart[v.part] ??= []).push(v);
    for (const [part, list] of Object.entries(byPart).sort((a, b) => b[1].length - a[1].length)) {
      L.push(`### ${partLabel(part)}：${list.length}`, '');
      if (id === 'part-imports-part-internal') {
        const towards = {};
        for (const v of list) towards[v.toPart] = (towards[v.toPart] ?? 0) + 1;
        L.push(`伸向：${Object.entries(towards).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${partLabel(k)} ${n}`).join('、')}`, '');
      }
      for (const v of list.slice(0, 40)) L.push(`- \`${v.from}:${v.line}\` -> \`${v.to}\`${v.typeOnly ? '（仅类型）' : ''}`);
      if (list.length > 40) L.push(`- ……还有 ${list.length - 40} 条（完整清单在 .local/structure/layers.json）`);
      L.push('');
    }
  }
  return L.join('\n');
}

function parseArgs(argv) {
  const args = { out: null, root: DEFAULT_ROOT, checkLayers: false, strict: false, updateBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--root') args.root = path.resolve(argv[++i]);
    else if (argv[i] === '--check-layers') args.checkLayers = true;
    else if (argv[i] === '--strict') args.strict = true;
    else if (argv[i] === '--report') args.strict = false;
    else if (argv[i] === '--update-baseline') { args.checkLayers = true; args.updateBaseline = true; }
  }
  args.out = path.resolve(args.out ?? path.join(args.root, '.local', 'structure'));
  return args;
}

const BASELINE_FILE = 'scripts/dev/layer-debt.json';

/** --check-layers: write layers.md, print the counts, compare with the committed baseline. Returns the exit code. */
function runLayerCheck(inv, { out, root, strict, updateBaseline }) {
  const layers = checkLayers(inv);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'layers.md'), layersMd(inv, layers));
  fs.writeFileSync(path.join(out, 'layers.json'), JSON.stringify({ counts: layers.counts, violations: layers.violations }, null, 1) + '\n');
  const file = path.join(root, BASELINE_FILE);
  let baseline = null;
  try { baseline = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const total = Object.values(layers.counts).reduce((s, r) => s + r.total, 0);
  for (const [id, r] of Object.entries(LAYER_RULES)) console.log(`${r.title}: ${layers.counts[id].total}`);
  // A rule the baseline does not have yet is new: its first count becomes its baseline (printed), it is not "growth".
  const newRules = baseline ? Object.keys(layers.counts).filter((id) => !baseline.rules?.[id]) : [];
  const grown = baseline ? debtGrowth(layers.counts, baseline).filter((g) => !newRules.includes(g.rule)) : [];
  for (const id of newRules) console.log(`new rule ${id}: ${layers.counts[id].total} (not in the baseline yet${updateBaseline ? '; recorded now' : '; --update-baseline records it'})`);
  const grownText = grown.map((g) => `${g.rule}${g.part ? '/' + g.part : ''} ${g.was}->${g.now}`).join(', ');
  if (updateBaseline) {
    if (grown.length) { console.error(`debt grew, the baseline is not updated: ${grownText}`); return 1; }
    fs.writeFileSync(file, JSON.stringify({ note: 'Layer debt baseline (scripts/dev/structure-inventory.mjs --check-layers). Counts may only go down: tests/layer-check.test.mjs fails when they grow. Lower it with --update-baseline after a move that clears violations.', rules: debtSnapshot(layers) }, null, 1) + '\n');
    console.log(`baseline written to ${BASELINE_FILE}`);
  } else if (grown.length) console.log(`above the baseline: ${grownText}`);
  console.log(`written ${path.join(out, 'layers.md')}`);
  return strict && (total > 0 || grown.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { out, root, checkLayers: layerMode, strict, updateBaseline } = parseArgs(process.argv.slice(2));
  const inv = buildInventory(root);
  if (layerMode) process.exit(runLayerCheck(inv, { out, root, strict, updateBaseline }));
  const { wiring, switches } = writeReports(inv, out, root);
  const src = [...inv.records.values()].filter((r) => r.group === 'source');
  console.log(`源码 ${src.length} 个文件，${src.reduce((s, r) => s + r.lines, 0)} 行；未分配 ${inv.unassigned.length}；部分之间的环 ${inv.cycles.length} 组。`);
  for (const id of PART_IDS) console.log(`${String(PARTS[id].n).padStart(2)} ${PARTS[id].name}：${inv.parts[id].files} 个文件，${inv.parts[id].lines} 行`);
  console.log(`main.ts：${wiring?.ipc.length ?? 0} 个窗口入口，${wiring?.objects.length ?? 0} 个顶层对象；开关 ${switches.items.length} 项`);
  console.log(`已写入 ${out}`);
}
