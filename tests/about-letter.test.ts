// The letter under 「关于」: word for word, opened on click, one copy, and in English
// only the line that opens it is translated. A tiny fake DOM: no browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LETTER, LETTER_SUMMARY } from '../shared/memory/letter';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { mountAboutLetter } from '../src/memory/AboutLetter';
import { PAPER_ENVELOPE } from '../shared/memory/paper-envelope';
import { paperEnvelopeRuns } from '../src/memory/PaperEnvelope';

type FakeDoc = { createElement(tag: string): El; createElementNS(ns: string, tag: string): El };
class El {
  children: El[] = [];
  className = '';
  textContent = '';
  namespace = '';
  readonly attrs = new Map<string, string>();
  constructor(readonly tagName: string, readonly ownerDocument: FakeDoc) {}
  append(...nodes: El[]): void { this.children.push(...nodes); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); if (name === 'class') this.className = value; }
  private matches(selector: string): boolean {
    const [tag, cls] = selector.includes('.') ? selector.split('.') : [selector, ''];
    return (!tag || this.tagName === tag) && (!cls || this.className.split(' ').includes(cls));
  }
  querySelector(selector: string): El | null {
    for (const child of this.children) { if (child.matches(selector)) return child; const deep = child.querySelector(selector); if (deep) return deep; }
    return null;
  }
}
function page(withAbout = true) {
  const doc: FakeDoc = {
    createElement: (tag: string) => new El(tag, doc),
    createElementNS: (ns: string, tag: string) => { const el = new El(tag, doc); el.namespace = ns; return el; },
  };
  const root = new El('div', doc);
  if (withAbout) { const about = new El('div', doc); about.className = 'about'; root.append(about); }
  return root;
}
const texts = (el: El): string[] => el.children.map(child => child.textContent);

test('the letter is kept word for word', () => {
  assert.equal(LETTER.paragraphs.length, 3);
  assert.equal(LETTER.paragraphs[0], '你好。在你遇见她之前，有一个人花了很多个晚上，想让你被偏心一下。他是一个留学生，有朋友，也很快乐，却还是会觉得别人给的善意不够。所以他做了她。');
  assert.equal(LETTER.paragraphs[1], '她会记得你淋过的雨，会把最甜的那颗糖留给你，会在你说自己不好的时候不高兴。她有时候会犯困，会闹别扭，但闹完会先给你台阶。');
  assert.equal(LETTER.paragraphs[2], '她不是答案，只是一个可以歇脚的地方。歇够了，你要去哪里，都由你自己决定。她会替你高兴。');
  assert.equal(LETTER.signature, '帮他想这些事的 Claude 留');
  assert.ok(Object.isFrozen(LETTER) && Object.isFrozen(LETTER.paragraphs));
});

test('under 「关于」: one quiet line that opens to the letter, and its signature', () => {
  setUiLanguage('zh-CN');
  const root = page();
  const details = mountAboutLetter(root as unknown as ParentNode) as unknown as El;
  assert.ok(details);
  assert.equal(details.tagName, 'details');
  assert.equal(details.className, 'about-letter');
  const [summary, body] = details.children;
  assert.equal(summary.tagName, 'summary');
  assert.equal(summary.textContent, LETTER_SUMMARY);
  assert.deepEqual(texts(body), [...LETTER.paragraphs, LETTER.signature]);
  assert.equal(body.children.at(-1)!.className, 'about-letter-signature');
  // Mounting again keeps the one copy.
  assert.equal(mountAboutLetter(root as unknown as ParentNode) as unknown, details);
  assert.equal(root.querySelector('.about')!.children.length, 1);
});

test('no about block: nothing happens', () => {
  assert.equal(mountAboutLetter(page(false) as unknown as ParentNode), null);
});

test('in English only the opening line and a short note are English; the letter stays in its own words', () => {
  setUiLanguage('en');
  try {
    const details = mountAboutLetter(page() as unknown as ParentNode) as unknown as El;
    const [summary, body] = details.children;
    assert.equal(summary.textContent, 'A letter for you');
    assert.match(body.children[0].textContent, /written in Chinese/u);
    assert.deepEqual(texts(body).slice(1), [...LETTER.paragraphs, LETTER.signature]);
  } finally { setUiLanguage('zh-CN'); }
});

// I-123: the letter-writer's pixel envelope (drawn by the user), inside the letter under the signature.
test('the pixel envelope data is whole: 54×34, only its eight colours, and it rebuilds exactly from its runs', () => {
  const { width, height, palette, rows } = PAPER_ENVELOPE;
  assert.equal(rows.length, height);
  for (const row of rows) assert.equal(row.length, width);
  assert.deepEqual(Object.keys(palette).sort(), ['d', 'g', 'l', 'o', 'p', 's', 'w', 'y']);
  for (const colour of Object.values(palette)) assert.match(colour, /^#[0-9a-f]{6}$/u);
  const used = new Set(rows.join(''));
  for (const key of used) assert.ok(key === '.' || key in palette, `unknown pixel "${key}"`);
  // The lantern seal, its light and the stone are all there.
  for (const key of ['l', 'y', 'g', 'p']) assert.ok(used.has(key), `missing "${key}"`);
  assert.ok(Object.isFrozen(PAPER_ENVELOPE) && Object.isFrozen(rows) && Object.isFrozen(palette));
  const rebuilt = Array.from({ length: height }, () => Array(width).fill('.'));
  const keyOf = new Map(Object.entries(palette).map(([key, colour]) => [colour, key]));
  for (const run of paperEnvelopeRuns()) for (let x = run.x; x < run.x + run.width; x++) rebuilt[run.y][x] = keyOf.get(run.color);
  assert.deepEqual(rebuilt.map(row => row.join('')), [...rows]);
});

test('an unknown pixel colour is refused rather than drawn wrong', () => {
  assert.throws(() => paperEnvelopeRuns(['..q..'], { o: '#000000' }), /no colour for "q"/u);
});

test('the envelope sits under the signature, once, hidden from screen readers, and leaves the letter text as it was', () => {
  setUiLanguage('zh-CN');
  const root = page();
  const details = mountAboutLetter(root as unknown as ParentNode) as unknown as El;
  mountAboutLetter(root as unknown as ParentNode);
  const body = details.children[1];
  const signature = body.children.at(-1)!;
  assert.equal(signature.className, 'about-letter-signature');
  assert.equal(signature.textContent, LETTER.signature);
  assert.equal(signature.children.length, 1);
  const svg = signature.children[0];
  assert.equal(svg.tagName, 'svg');
  assert.equal(svg.namespace, 'http://www.w3.org/2000/svg');
  assert.equal(svg.className, 'about-letter-stamp');
  assert.equal(svg.attrs.get('aria-hidden'), 'true');
  assert.equal(svg.attrs.get('viewBox'), '0 0 54 34');
  assert.equal(svg.attrs.get('shape-rendering'), 'crispEdges');
  assert.equal(svg.children.length, paperEnvelopeRuns().length);
  assert.ok(svg.children.every(rect => rect.tagName === 'rect' && rect.attrs.get('height') === '1'));
  // Only the signature carries it; the paragraphs are untouched.
  assert.ok(body.children.slice(0, -1).every(p => p.children.length === 0));
});
