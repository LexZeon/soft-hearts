// Browser layout test for the control window's chat column (src/ui/layout.ts renderControls, src/style.css, src/mood.css).
// With developer mode on, the tall mood observer (MoodCompanion's .mood-controls-observer in .content-card) used to
// squeeze the chat list (#messages) to about 20 px (found by the test-commands work, docs/claude/2026-11-03-test-commands.md).
// The real markup and CSS are bundled with esbuild and laid out in headless Edge (Playwright channel "msedge"), or
// Playwright's own Chromium; skips when neither can start (as tests/scorer-page.test.mjs).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const tests = path.dirname(fileURLToPath(import.meta.url));

async function launch() {
  for (const options of [{ channel: 'msedge' }, {}]) {
    try { return await chromium.launch({ ...options, headless: true }); } catch { /* try the next one */ }
  }
  return null;
}
const browser = await launch();
after(() => browser?.close());
const skip = browser ? false : 'neither Edge nor Playwright Chromium could start on this machine';

/** The control window's own markup and the stylesheets that lay it out, as the app bundles them. */
async function bundle() {
  const result = await build({
    stdin: { contents: "import '../src/style.css'; import '../src/mood.css'; import { renderControls } from '../src/ui/layout'; window.renderControls = renderControls;",
      resolveDir: tests, loader: 'ts', sourcefile: 'control-layout-entry.ts' },
    bundle: true, write: false, format: 'iife', platform: 'browser', outdir: path.join(os.tmpdir(), 'soft-control-layout'), logLevel: 'silent',
    loader: { '.svg': 'text', '.png': 'dataurl' },
  });
  const file = extension => result.outputFiles.find(output => output.path.endsWith(extension))?.text ?? '';
  return { js: file('.js'), css: file('.css') };
}

/** Lays out the control window at `width`×`height`; `developer` shows the mood observer the way MoodCompanion mounts it. */
async function measure(code, { width, height, developer, history = false }) {
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${code.css}</style></head><body><div id="app"></div></body></html>`);
    await page.addScriptTag({ content: code.js });
    return await page.evaluate(([developer, history]) => {
      window.renderControls(document.getElementById('app'));
      // A long conversation (bubbles as src/main.ts renders them) in place of the welcome block.
      if (history) document.getElementById('messages').innerHTML = Array.from({ length: 80 }, (_, i) =>
        `<div class="message ${i % 2 ? 'assistant' : 'user'}"><div class="bubble">第 ${i + 1} 条消息，说得稍微长一点，好让它换行。</div></div>`).join('');
      const host = document.querySelector('.content-card');
      // MoodCompanion (src/ui/MoodCompanion.ts): an <aside class="mood-companion"> with a heading and a body holding the
      // developer panel, given .mood-controls-observer and prepended to .content-card (which becomes .mood-observer-host).
      const observer = document.createElement('aside');
      observer.className = 'mood-companion mood-controls-observer'; observer.hidden = !developer;
      observer.innerHTML = '<div class="mood-companion-heading"><strong>心情观察</strong><button type="button">收起</button></div>'
        + '<div class="mood-companion-body"><section class="mood-panel">' + Array.from({ length: 60 }, (_, i) => `<p class="mood-reason">第 ${i + 1} 行观察数据</p>`).join('') + '</section></div>';
      host.classList.add('mood-observer-host'); host.prepend(observer);
      const box = element => element.getBoundingClientRect();
      const card = box(host), messages = document.getElementById('messages'), composer = document.querySelector('.composer-wrap');
      const body = observer.querySelector('.mood-companion-body');
      return { card: card.height, cardBottom: card.bottom, messages: box(messages).height, composerBottom: box(composer).bottom,
        observer: developer ? box(observer).height : 0, observerScrolls: developer ? body.scrollHeight > body.clientHeight + 1 : false,
        messagesScroll: messages.scrollHeight > messages.clientHeight + 1 };
    }, [developer, history]);
  } finally { await page.close(); }
}

test('control window: with developer mode on, the chat list keeps a usable height, the input box stays whole and the mood observer scrolls inside itself', { skip }, async () => {
  const code = await bundle();
  assert.ok(code.js && code.css, 'bundled the control window');
  // The window's default size (1260×850) and its minimum (960×680, electron/main.ts); the list's floor is lower there.
  for (const [width, height, floor] of [[1260, 850, 160], [960, 680, 120]]) {
    for (const history of [false, true]) {
      const normal = await measure(code, { width, height, developer: false, history });
      const developer = await measure(code, { width, height, developer: true, history });
      const where = `${width}×${height}${history ? ', long history' : ''}`;
      if (process.env.CONTROL_LAYOUT_REPORT) console.log(where, JSON.stringify({ normal, developer }));
      assert.ok(developer.messages >= floor, `${where}: chat list ${developer.messages.toFixed(0)} px with the observer open (was about 20)`);
      assert.ok(developer.observer >= 96, `${where}: the observer still shows ${developer.observer.toFixed(0)} px`);
      assert.equal(developer.observerScrolls, true, `${where}: the observer scrolls its own content`);
      if (history) assert.equal(developer.messagesScroll, true, `${where}: a long history scrolls inside the list, it does not push the observer away`);
      for (const [name, layout] of [['normal', normal], ['developer', developer]])
        assert.ok(layout.composerBottom <= layout.cardBottom + 0.5, `${where} ${name}: the input box stays inside the card (${layout.composerBottom.toFixed(0)} > ${layout.cardBottom.toFixed(0)})`);
      // Normal mode: the chat column has the whole card, as before (the developer rules apply only while the observer is open).
      assert.ok(normal.messages > developer.messages && normal.messages >= 250, `${where}: normal chat list ${normal.messages.toFixed(0)} px`);
    }
  }
});
