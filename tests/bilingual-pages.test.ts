import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * I-232: every public page is the complete English first, then the complete Chinese, with a button at the very top
 * that jumps to the Chinese half. Layout, fixed (docs/claude/2026-11-26-bilingual-pages.md):
 *   # English heading / <p align="right"> button to #zh </p> / English half / --- / <a id="zh"></a> / button to #top / Chinese half.
 * This test only notices when someone later edits one half and not the other: same headings, fenced blocks and link targets.
 *
 * To add a page: put one line in PAGES (path from the repository root; zhImg / enImg are the two button picture paths as the page itself
 * writes them, relative to the page). README.md is NOT in this list: another test checks it.
 */
const PAGES: Array<{ file: string; images: string }> = [
  { file: 'START-HERE.md', images: 'docs/images/' },
  { file: 'docs/release-notes/v0.2.0.md', images: '../images/' },
  { file: 'docs/release-notes/v0.2.1.md', images: '../images/' },
  { file: 'ACKNOWLEDGEMENTS.md', images: 'docs/images/' },
  { file: 'docs/PORTING.md', images: 'images/' },
  { file: 'docs/FOR-AGENTS.md', images: 'images/' },
];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANCHOR = '<a id="zh"></a>';

/** Headings, fenced blocks and link targets of one half (fenced content is not scanned for headings or links). */
function describeHalf(text: string): { headings: number; fences: number; links: string[] } {
  let headings = 0;
  let fences = 0;
  let inFence = false;
  const prose: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { if (!inFence) fences += 1; inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^#{1,6}\s/.test(line)) headings += 1;
    prose.push(line);
  }
  const links = new Set<string>();
  for (const match of prose.join('\n').matchAll(/\]\(([^)\s]+)\)/g)) {
    if (!match[1].startsWith('#')) links.add(match[1]);
  }
  return { headings, fences, links: [...links].sort() };
}

for (const { file, images } of PAGES) {
  test(`${file}: the complete English first, the Chinese after, a button at the top, and the two halves match`, () => {
    const text = readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    assert.match(lines[0], /^# \S/, 'the first line is the English heading');
    assert.equal(lines[1], '');
    assert.equal(lines[2], `<p align="right"><a href="#zh"><img src="${images}lang-zh.svg" alt="中文" height="30"></a></p>`, 'the jump-to-Chinese button sits right under the first heading');

    assert.equal(text.split(ANCHOR).length - 1, 1, 'the anchor <a id="zh"></a> exists exactly once');
    const [english, chinese] = text.split(ANCHOR);
    assert.match(english.trimEnd(), /\n---$/, 'a horizontal rule closes the English half');
    assert.ok(chinese.trimStart().startsWith(`<p align="right"><a href="#top"><img src="${images}lang-en.svg" alt="English" height="30"></a></p>`), 'the button back to English follows the anchor');

    const zhBody = chinese.replace(/^\s*<p align="right">.*<\/p>\s*/, '');
    assert.match(zhBody, /^# \S/, 'the Chinese half starts with its own heading');
    assert.match(zhBody, /[一-鿿]/, 'the Chinese half is Chinese');
    const enBody = english.replace(/^[^\n]*\n\s*<p align="right">.*<\/p>\s*/, '');
    assert.doesNotMatch(enBody.split('\n').slice(0, 3).join('\n'), /^[一-鿿]/, 'the English half opens in English');

    const en = describeHalf(`# x\n${enBody}`);
    const zh = describeHalf(zhBody);
    assert.ok(en.headings > 0 && zh.headings > 0);
    assert.equal(en.headings, zh.headings, `headings: English ${en.headings}, Chinese ${zh.headings}`);
    assert.equal(en.fences, zh.fences, `fenced blocks: English ${en.fences}, Chinese ${zh.fences}`);
    assert.deepEqual(en.links, zh.links, 'both halves link to the same targets');
  });
}

test('START-HERE: both halves carry the same-steps note, both creator lines, and the key sentence', () => {
  const text = readFileSync(path.join(ROOT, 'START-HERE.md'), 'utf8').replace(/\r\n/g, '\n');
  const [english, chinese] = text.split(ANCHOR);
  assert.match(english, /two halves with the same steps/);
  assert.match(english, /do each step once, not once per language/);
  assert.match(chinese, /步骤完全相同/);
  assert.match(chinese, /每一步只做一次/);
  // the lines an installing agent says to the user exist in both halves
  assert.match(english, /From the creator: I hope you can feel the soft, gentle companionship dedicated to you\./);
  assert.match(chinese, /创作者想对你说：希望你能感受到这份献给你的温柔陪伴。/);
  assert.match(english, /I do not look at it and I do not handle it/);
  assert.match(chinese, /密钥你自己贴进这一栏，我不看也不经手/);
  // the four choices of step 6 (five with "leave it as it is") are in both
  for (const needle of ['Give her a voice with feeling', 'Talk to her by speaking', 'Switch to another preinstalled character, or make a character of your own', 'Load your own model', 'Leave it as it is'])
    assert.ok(english.includes(needle), needle);
  for (const needle of ['给她带感情的声音', '用说的和她聊', '换一个预装角色，或做一个自己的角色', '换上自己的模型', '先这样'])
    assert.ok(chinese.includes(needle), needle);
  // no key is ever asked for, read, typed or stored by the agent, in either language
  assert.match(english, /do not ask for it in the chat, you do not read it from a web page, the clipboard or any file, and you do not write it anywhere/);
  assert.match(chinese, /你不在聊天里要它，不从网页、剪贴板或任何文件里读它，也不把它写到任何地方/);
});
