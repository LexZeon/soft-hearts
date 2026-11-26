// The renderer entry's source text for tests that read it (overhaul step 5, docs/claude/2026-11-16-src-main-split.md). The code those
// tests read is moving from src/main.ts into src/wiring/*.ts; they read it here, across both, with the same assertions as before.
// Prefer importing a module over this: it is for checks that are about how the renderer is wired (order, guards, what is passed on).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** src/main.ts first, then src/wiring/*.ts in name order (repo-relative paths). */
export function rendererFiles(root = ROOT): string[] {
  const folder = path.join(root, 'src', 'wiring');
  const wiring = fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => name.endsWith('.ts')).sort().map(name => `src/wiring/${name}`) : [];
  return ['src/main.ts', ...wiring];
}

/**
 * A wiring file's text with the `export` keyword of each top-level declaration blanked out (same length, so positions and line
 * numbers stay): a declaration a test lifts out (`export function onStream`) reads as it did in src/main.ts.
 */
function withoutExports(file: string, text: string): string {
  if (file === 'src/main.ts') return text;
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cuts: [number, number][] = [];
  for (const statement of ast.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    for (const modifier of modifiers) if (modifier.kind === ts.SyntaxKind.ExportKeyword) {
      let end = modifier.end;
      while (text[end] === ' ') end++;
      cuts.push([modifier.getStart(ast), end]);
    }
  }
  let out = text;
  for (const [start, end] of cuts.reverse()) out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  return out;
}

/** Each renderer wiring file, read (exports blanked as above). */
export function rendererSources(root = ROOT): { file: string; text: string }[] {
  return rendererFiles(root).map(file => ({ file, text: withoutExports(file, fs.readFileSync(path.join(root, file), 'utf8')) }));
}

/**
 * All the renderer wiring's text, file after file (src/main.ts first): for text and regular-expression checks that used to read
 * src/main.ts, and for tests that parse it and lift declarations out by name.
 */
export function rendererSource(root = ROOT): string {
  return rendererSources(root).map(source => source.text).join('\n');
}
