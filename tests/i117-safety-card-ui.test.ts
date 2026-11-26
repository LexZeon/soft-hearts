// I-117 the safety card as a window shows it (src/safety/SafetyCard.ts with its CSS), laid out in headless Edge or Playwright's Chromium
// with fake ports. Skips only when neither browser can start (as tests/capability-coverage.test.ts).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';

const tests = path.dirname(fileURLToPath(import.meta.url));
async function launch(): Promise<Browser | null> {
  for (const options of [{ channel: 'msedge' }, {}]) {
    try { return await chromium.launch({ ...options, headless: true }); } catch { /* try the next one */ }
  }
  return null;
}
const browser = await launch();
after(() => browser?.close());
const skip = browser ? false : 'neither Edge nor Playwright Chromium could start on this machine';

const ENTRY = `
import '../src/safety/safety-card.css';
import { SafetyCard, mountCrisisRegionSelect } from '../src/safety/SafetyCard';
const w = window as any;
w.answers = []; w.saved = [];
let listener: ((view: unknown) => void) | null = null;
w.push = (view: unknown) => listener?.(view);
w.mountCard = (kind: 'pet' | 'controls', initial: unknown) => new SafetyCard(document, {
  changed: callback => { listener = callback; return () => { listener = null; }; },
  get: async () => initial as any,
  answer: async value => { w.answers.push(value); return { open: false, id: value.id, region: 'US' }; },
}, kind);
w.mountSelect = () => mountCrisisRegionSelect(document.getElementById('crisis-region') as HTMLSelectElement, { set: value => w.saved.push(value), guess: () => 'CA' });
`;

async function page() {
  const result = await build({ stdin: { contents: ENTRY, resolveDir: tests, loader: 'ts', sourcefile: 'i117-card-entry.ts' }, bundle: true, write: false, format: 'iife',
    platform: 'browser', outdir: path.join(os.tmpdir(), 'soft-i117-card'), logLevel: 'silent' });
  const file = (extension: string) => result.outputFiles.find(output => output.path.endsWith(extension))?.text ?? '';
  const view = await browser!.newPage({ viewport: { width: 420, height: 640 } });
  await view.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${file('.css')}</style></head><body>
    <div class="pet-chat"><textarea id="chat-input"></textarea></div>
    <select id="crisis-region"><option value="auto">自动（按系统时区猜）</option><option value="US">美国</option><option value="CA">加拿大</option></select></body></html>`);
  await view.addScriptTag({ content: file('.js') });
  return view;
}

test('the card: shown on open, the region first and large, others folded, no 12356 outside the mainland; buttons answer and remove it', { skip }, async () => {
  const view = await page();
  try {
    await view.evaluate(() => (window as any).mountCard('pet', { open: false, id: '', region: 'other' }));
    assert.equal(await view.locator('[data-safety-card]').count(), 0, 'nothing before a clear sign');
    await view.evaluate(() => (window as any).push({ open: true, id: 'card-1', region: 'US' }));
    const card = view.locator('[data-safety-card]');
    assert.equal(await card.count(), 1);
    assert.equal(await card.getAttribute('data-safety-card'), 'US');
    assert.ok(await card.evaluate(node => node.classList.contains('in-pet')));
    assert.equal(await card.locator('.safety-card-line.is-primary .safety-card-number').textContent(), '988');
    assert.equal(await card.locator('.safety-card-sentence').textContent(), '如果你现在很难受，这里有能在现实里接住你的人。');
    assert.equal(await card.locator('details.safety-card-others').getAttribute('open'), null, 'the other regions start folded');
    const text = await card.textContent() ?? '';
    assert.ok(!text.includes('12356'), 'mainland line never outside the mainland');
    assert.ok(text.includes('9-8-8') && text.includes('1925') && text.includes('18111'));
    // Not modal: the chat input under it still takes focus and text.
    await view.locator('#chat-input').fill('还在');
    assert.equal(await view.locator('#chat-input').inputValue(), '还在');
    await card.locator('[data-safety-card-answer=safe]').click();
    assert.equal(await view.locator('[data-safety-card]').count(), 0);
    assert.deepEqual(await view.evaluate(() => (window as any).answers), [{ id: 'card-1', answer: 'safe' }]);
    // Another window answered: the host says closed, the card goes; an older card's close never closes a newer one.
    await view.evaluate(() => (window as any).push({ open: true, id: 'card-3', region: 'CN' }));
    assert.equal(await view.locator('.safety-card-line.is-primary .safety-card-number').textContent(), '12356');
    await view.evaluate(() => (window as any).push({ open: false, id: 'card-2', region: 'CN' }));
    assert.equal(await view.locator('[data-safety-card]').count(), 1);
    await view.evaluate(() => (window as any).push({ open: false, id: 'card-3', region: 'CN' }));
    assert.equal(await view.locator('[data-safety-card]').count(), 0);
    // Unknown region: only the local emergency number first.
    await view.evaluate(() => (window as any).push({ open: true, id: 'card-4', region: 'other' }));
    assert.equal(await view.locator('.safety-card-line.is-primary .safety-card-number').textContent(), '当地的紧急电话');
    await view.locator('[data-safety-card-answer=close]').click();
    assert.deepEqual((await view.evaluate(() => (window as any).answers)).at(-1), { id: 'card-4', answer: 'close' });
    // A malformed view is ignored.
    await view.evaluate(() => (window as any).push({ open: true, id: 'card-5', region: 'XX' }));
    assert.equal(await view.locator('[data-safety-card]').count(), 0);
  } finally { await view.close(); }
});

test('a window that opens while the card is up shows it at once (getSafetyCard); the settings select names the guess and saves', { skip }, async () => {
  const view = await page();
  try {
    await view.evaluate(() => (window as any).mountCard('controls', { open: true, id: 'card-7', region: 'HK' }));
    await view.waitForSelector('[data-safety-card]');
    assert.ok(await view.locator('[data-safety-card]').evaluate(node => node.classList.contains('in-controls')));
    assert.equal(await view.locator('.safety-card-line.is-primary .safety-card-number').textContent(), '18111');
    await view.evaluate(() => (window as any).mountSelect());
    assert.equal(await view.locator('#crisis-region option[value=auto]').textContent(), '自动（按系统时区猜：加拿大）');
    await view.selectOption('#crisis-region', 'US');
    assert.deepEqual(await view.evaluate(() => (window as any).saved), ['US']);
  } finally { await view.close(); }
});
