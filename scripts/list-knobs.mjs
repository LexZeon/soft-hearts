#!/usr/bin/env node
/**
 * I-020 "想改什么 → 改哪里"：扫每个功能的旋钮文件（shared/、src/、electron/ 下名为 knobs.ts 的文件），
 * 把每个旋钮上面那行"用户可能怎么说"（和可选的"怎么调"）整理成 handbook/knobs.md 的表。
 *
 *   node scripts/list-knobs.mjs           重新生成 handbook/knobs.md
 *   node scripts/list-knobs.mjs --check   只检查表是不是最新的（不是就退出码 1）
 *
 * 旋钮文件的写法（例子见 shared/behaviors/idle-gesture/knobs.ts）：
 *   - 文件头注释里一行"功能：……"，是这个功能在表里的名字；
 *   - 每个旋钮上面一行 `// 用户可能怎么说：……`，可选再一行 `// 怎么调：……`，下一行就是旋钮（`名字: 值`）。
 * tests/knobs-table.test.mjs 会检查表和代码对得上。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = ['shared', 'src', 'electron'];
const OUTPUT = path.join('handbook', 'knobs.md');

async function knobFiles(root) {
  const found = [];
  const walk = async dir => {
    let entries;
    try { entries = await readdir(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') await walk(rel); }
      else if (entry.name === 'knobs.ts') found.push(rel);
    }
  };
  for (const dir of SCAN) await walk(dir);
  return found.sort();
}

const braces = line => {
  // Knob files keep braces out of strings and comments; strip both to be safe.
  const code = line.replace(/\/\/.*$/, '').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '');
  return { open: (code.match(/\{/g) ?? []).length, close: (code.match(/\}/g) ?? []).length };
};

/** One knob file → its feature name and knobs ({ path, say, how }). */
export function parseKnobFile(text) {
  const lines = text.split(/\r?\n/);
  const feature = (/功能：(.+?)\s*(?:\*\/)?\s*$/m.exec(text)?.[1] ?? '').trim();
  const knobs = [], stack = [];
  let depth = 0, say = null, how = null;
  for (const line of lines) {
    const sayMatch = /^\s*\/\/\s*用户可能怎么说：(.+)$/.exec(line);
    if (sayMatch) { say = sayMatch[1].trim(); how = null; continue; }
    const howMatch = /^\s*\/\/\s*怎么调：(.+)$/.exec(line);
    if (howMatch) { if (say) how = howMatch[1].trim(); continue; }
    if (/^\s*(\/\/|\*|\/\*)/.test(line) || !line.trim()) continue;
    const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line)?.[1] ?? /^\s*export\s+const\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1] ?? null;
    if (say && key) { knobs.push({ path: [...stack.map(item => item.key), key].join('.'), say, how }); }
    say = null; how = null;
    const { open, close } = braces(line);
    if (key && open > close) stack.push({ key, depth: depth + 1 });
    depth += open - close;
    while (stack.length && stack[stack.length - 1].depth > depth) stack.pop();
  }
  return { feature, knobs };
}

const cell = value => String(value ?? '').replace(/\|/g, '｜').replace(/\s+/g, ' ').trim();

export async function knobTable(root = REPO_ROOT) {
  const files = await knobFiles(root);
  const sections = [];
  for (const file of files) {
    const { feature, knobs } = parseKnobFile(await readFile(path.join(root, file), 'utf8'));
    if (knobs.length) sections.push({ file, feature: feature || path.posix.dirname(file), knobs });
  }
  const out = [
    '<!-- 由 scripts/list-knobs.mjs 生成，别手改：改旋钮文件里的"用户可能怎么说"，再运行 node scripts/list-knobs.mjs。 -->',
    '# 想改什么 → 改哪里',
    '',
    '用户说"这里改一下"时照这张表找（I-020"想改哪里，只改一处"）。每一行来自一个旋钮文件里旋钮上面那行"用户可能怎么说"，所以表和代码永远对得上。',
    '',
    '- **改哪里**：旋钮文件和旋钮的名字，改那一个值就生效，别处不变（每个功能都有"一个旋钮"测试）。',
    '- **用新写法的功能**才在表里：能调的值都在自己文件夹的 `knobs.ts`，"她来挑"见 `shared/she-chooses.ts`。还没搬过来的写死规则见 `docs/claude/2026-11-03-hardcoded-rules-inventory.md`，那些要改时还得去代码里找。',
    '',
    '## 各功能用的写法',
    '',
    '| 功能 | 写法 | 旋钮文件 | 旋钮数 |',
    '|---|---|---|---|',
    ...sections.map(s => `| ${cell(s.feature)} | 新写法（她来挑 + 旋钮文件） | \`${s.file}\` | ${s.knobs.length} |`),
    '| 其他行为 | 旧写法（写死在代码里） | 见写死规则清单 | — |',
    '',
  ];
  for (const s of sections) {
    out.push(`## ${s.feature}`, '', `旋钮文件：\`${s.file}\``, '', '| 用户可能怎么说 | 改哪里 | 怎么调 |', '|---|---|---|');
    for (const knob of s.knobs) out.push(`| ${cell(knob.say)} | \`${cell(knob.path)}\` | ${cell(knob.how) || '—'} |`);
    out.push('');
  }
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const table = await knobTable();
  const target = path.join(REPO_ROOT, OUTPUT);
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = await readFile(target, 'utf8'); } catch { current = ''; }
    if (current !== table) { console.error(`${OUTPUT} 不是最新的：运行 node scripts/list-knobs.mjs`); process.exit(1); }
    console.log(`${OUTPUT} 是最新的。`);
  } else {
    await writeFile(target, table, 'utf8');
    console.log(`已生成 ${OUTPUT}。`);
  }
}
