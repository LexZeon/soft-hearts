// I-025 漏项检查: every control of the settings window must be in the
// capability list (shared/capabilities.ts) or marked 不开放 there with a reason. The real control-window markup and every
// panel src/main.ts mounts in it (tests/fixtures/control-window-harness.ts, fake host, no Electron) are laid out in headless
// Edge (Playwright channel "msedge") or Playwright's Chromium, and every interactive element is checked against the list.
// Skips only when neither browser can start (as tests/control-chat-layout.test.mjs).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import { CAPABILITIES, capabilityPatterns } from '../shared/capabilities';
import {
  describeControl, parseControlPattern, unregisteredControls, unusedPatterns, type ControlDescriptor,
} from '../shared/capability-controls';

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

async function bundle() {
  const result = await build({
    stdin: { contents: "import '../src/style.css'; import '../src/mood.css'; import './fixtures/control-window-harness';",
      resolveDir: tests, loader: 'ts', sourcefile: 'capability-coverage-entry.ts' },
    bundle: true, write: false, format: 'iife', platform: 'browser', outdir: path.join(os.tmpdir(), 'soft-capability-coverage'), logLevel: 'silent',
    loader: { '.svg': 'text', '.png': 'dataurl' },
  });
  const file = (extension: string) => result.outputFiles.find(output => output.path.endsWith(extension))?.text ?? '';
  return { js: file('.js'), css: file('.css') };
}

interface Scan { mounted: string[]; unfilled: string[]; errors: string[]; controls: ControlDescriptor[]; planted: ControlDescriptor[] }
let scanned: Promise<Scan> | null = null;
/** One page for every test: mount, collect, then plant an unregistered switch and collect again. */
function scan(): Promise<Scan> {
  scanned ??= (async () => {
    const code = await bundle();
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${code.css}</style></head><body><div id="app"></div></body></html>`);
      await page.addScriptTag({ content: code.js });
      return await page.evaluate(async () => {
        const w = window as any;
        const result = await w.mountControlWindow(document.getElementById('app'));
        const controls = w.collectControls();
        w.plantUnregisteredControl();
        return { ...result, errors: [...w.harnessErrors], controls, planted: w.collectControls() };
      }).then(result => ({ ...result, errors: [...result.errors, ...errors] }));
    } finally { await page.close(); }
  })();
  return scanned;
}

const patterns = () => capabilityPatterns().map(({ pattern }) => parseControlPattern(pattern));

test('the harness mounts every panel of the settings window without errors, so the scan sees all of it', { skip }, async () => {
  const result = await scan();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.unfilled, [], `空着的面板位置没有挂上面板，扫描看不到它的控件：${result.unfilled.join('、')}（在 tests/fixtures/control-window-harness.ts 里挂上）`);
  for (const panel of ['agent-channel', 'local-asr', 'emotional-voice', 'character-page', 'motion-library', 'user-profile', 'memory'])
    assert.ok(result.mounted.includes(panel), panel);
  assert.ok(result.controls.length > 400, `only ${result.controls.length} controls: a panel did not render`);
});

test('every control of the settings window is in the capability list or marked 不开放 there', { skip }, async () => {
  const missing = unregisteredControls((await scan()).controls, patterns());
  assert.deepEqual(missing.map(describeControl), [],
    '这些控件既不在 shared/capabilities.ts 的清单里，也没写明不开放及原因。新功能要登记：能三方改的写清怎么改；不能的写明原因。');
});

test('every control pattern in the list still finds its control (renamed or removed controls show up here)', { skip }, async () => {
  const { controls } = await scan();
  assert.deepEqual(unusedPatterns(controls, patterns()).map(pattern => pattern.source), []);
});

test('a switch nobody registered makes the check fail (the deliberate omission)', { skip }, async () => {
  const { planted } = await scan();
  const missing = unregisteredControls(planted, patterns());
  assert.deepEqual(missing.map(control => control.id), ['planted-unregistered-switch']);
  assert.match(describeControl(missing[0]), /@privacy-window input:checkbox #planted-unregistered-switch —「一个没登记的新开关」/u);
});

test('taking one entry out of the list reports exactly its controls', { skip }, async () => {
  const { controls } = await scan();
  const without = CAPABILITIES.filter(entry => entry.id !== 'click_through');
  const missing = unregisteredControls(controls, capabilityPatterns(without).map(({ pattern }) => parseControlPattern(pattern)));
  assert.deepEqual(missing.map(control => control.id), ['click-through']);
});
