import assert from 'node:assert/strict';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeIsolation } from './lib/claude-smoke-fixture.mjs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// Private connection input is accepted on stdin only. Never log it, write it to a fixture,
// inherit it through an environment variable, or place it on a process command line.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace);
const output = path.join(workspace, '.local/emotional-voice-smoke');
const API_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer';
const MODEL = 'qwen-audio-3.1-tts-flash';
const VOICE = 'longanlingxin_v3.1';
const checked = [], errors = [], screenshots = [];
const watched = new WeakSet();
let connection = {}, instance, controls, pet, profile, settingsFile, claude;
let phase = 'private-stdin', report, liveMetrics;
const startedAt = Date.now();

function redact(value) {
  let text = String(value);
  const values = [connection.host, connection.key, connection.modelFile, connection.instruction];
  try { if (connection.host) values.push(new URL(connection.host).origin); } catch { /* Invalid input is reported generically. */ }
  for (const secret of values.filter(value => typeof value === 'string' && value)) {
    for (const variant of new Set([secret, secret.replaceAll('\\', '/'), secret.replaceAll('\\', '\\\\'), JSON.stringify(secret).slice(1, -1)]))
      text = text.replaceAll(variant, '[private configuration]');
  }
  return text;
}
function watch(page) {
  if (watched.has(page)) return;
  watched.add(page);
  page.on('pageerror', error => errors.push(redact(error.message)));
  page.on('console', message => { if (message.type() === 'error') errors.push(redact(message.text())); });
}
async function poll(page, predicate, argument, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await page.evaluate(predicate, argument)) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Application predicate timed out during ${phase}`);
}
async function pollMain(predicate, argument, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await instance.evaluate(predicate, argument)) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Host predicate timed out during ${phase}`);
}
const settings = () => controls.evaluate(() => window.desktop.getSettings());
const stats = page => page.evaluate(() => {
  const state = window.__emotionalVoiceSmoke;
  return { starts: state.starts.map(value => ({ ...value })), closes: state.closes,
    stops: state.stops, audioEvents: state.audioEvents, firstAudioMs: state.firstAudioMs,
    doneAt: state.doneAt, events: state.events.map(value => ({ ...value })) };
});
const network = () => instance.evaluate(() => ({ liveCalls: globalThis.__emotionalVoiceNetwork.liveCalls,
  mockCalls: globalThis.__emotionalVoiceNetwork.mockCalls, aborts: globalThis.__emotionalVoiceNetwork.aborts,
  livePayloadMatchesExpected: globalThis.__emotionalVoiceNetwork.livePayloadMatchesExpected,
  urls: [...globalThis.__emotionalVoiceNetwork.openedUrls] }));
async function idle() {
  await poll(controls, () => document.querySelector('#tts-playback-status')?.dataset.phase === 'idle');
}
async function saved() {
  await poll(controls, async () => {
    const value = await window.desktop.getSettings();
    return value.tts?.provider === 'bailian' && value.tts.apiKey === '••••••••'
      && document.querySelector('#tts-api-key')?.value === ''
      && !document.querySelector('#tts-save')?.disabled;
  });
}

async function launch() {
  const options = process.env.MMD_TEST_EXE ? { executablePath: process.env.MMD_TEST_EXE, args: [] } : { args: [appDirectory] };
  options.args.push(`--user-data-dir=${profile}`);
  // No chat: Claude Code is only an inert placeholder with an empty config folder; Codex is a missing path.
  claude ??= await createClaudeIsolation();
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE;
  instance = await electron.launch({ ...options, env, cwd: appDirectory, timeout: 30000 });
  instance.on('window', watch);
  await instance.firstWindow();
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath('userData'))), profile);
  for (let attempt = 0; attempt < 100; attempt++) {
    controls = undefined; pet = undefined;
    for (const page of instance.windows()) {
      watch(page);
      try {
        const url = new URL(page.url());
        if (!url.pathname.endsWith('/index.html')) continue;
        if (url.searchParams.has('pet')) pet = page; else controls = page;
      } catch { /* Auxiliary reply windows do not participate. */ }
    }
    if (controls && pet) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(controls && pet, 'the two trusted application windows exist');
  controls.setDefaultTimeout(15000); pet.setDefaultTimeout(15000);
  await controls.context().addInitScript(() => {
    const state = window.__emotionalVoiceSmoke = { starts: [], closes: 0, stops: 0, audioEvents: 0, firstAudioMs: null, doneAt: null, events: [] };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      state.starts.push({ at: performance.now(), scheduledAt: Number(args[0] ?? 0), contextTime: this.context.currentTime });
      return Reflect.apply(start, this, args);
    };
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (...args) { state.stops++; return Reflect.apply(stop, this, args); };
    const close = AudioContext.prototype.close;
    AudioContext.prototype.close = function (...args) { state.closes++; return Reflect.apply(close, this, args); };
  });
  await Promise.all([controls.reload(), pet.reload()]);
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(win => {
      const url = new URL(win.webContents.getURL());
      return url.pathname.endsWith('/index.html') && !url.searchParams.has('pet');
    });
    window?.show(); window?.focus(); window?.webContents.focus();
  });
  await controls.bringToFront();
  await controls.waitForFunction(() => typeof window.desktop?.synthesizeSpeech === 'function');
  await navigateControlPage(controls, 'providers');
  await controls.waitForSelector('#tts-provider');
  await poll(controls, async () => {
    const cards = await window.desktop.getCharacterCards();
    const active = cards.cards.find(card => card.id === cards.activeId);
    return !!active && document.querySelector('.emotional-voice-context')?.textContent?.includes(active.name);
  });
  for (const page of [controls, pet]) await page.evaluate(() => {
    const state = window.__emotionalVoiceSmoke;
    window.desktop.onSpeechEvent(event => {
      const at = performance.now();
      state.events.push({ id: event.id, type: event.type, at, cancelled: event.cancelled === true });
      if (event.type === 'audio') {
        state.audioEvents++;
        if (state.firstAudioMs === null && Number.isFinite(event.firstAudioMs)) state.firstAudioMs = event.firstAudioMs;
      }
      if (event.type === 'done') state.doneAt = at;
    });
  });
  await installNetworkHarness();
}

async function installNetworkHarness() {
  await instance.evaluate(({ shell }, expected) => {
    const originalFetch = globalThis.fetch;
    const state = globalThis.__emotionalVoiceNetwork = { mode: 'live', liveCalls: 0, mockCalls: 0, aborts: 0, openedUrls: [], livePayloadMatchesExpected: false };
    shell.openExternal = async url => { state.openedUrls.push(String(url)); };
    globalThis.fetch = async (input, init) => {
      let isTts = false;
      try { isTts = new URL(String(input)).pathname === expected.apiPath; } catch { /* Delegate non-URL requests. */ }
      if (!isTts) return originalFetch(input, init);
      if (state.mode === 'live') {
        state.liveCalls++;
        const payload = JSON.parse(String(init?.body));
        const instructionHash = process.getBuiltinModule('crypto').createHash('sha256').update(payload.input?.instruction ?? '').digest('hex');
        state.livePayloadMatchesExpected = payload.model === expected.model && payload.input?.voice === expected.voice
          && payload.input?.rate === 0.95 && payload.input?.format === 'pcm' && payload.input?.sample_rate === 24000
          && instructionHash === expected.instructionHash;
        return originalFetch(input, init);
      }
      state.mockCalls++;
      const encoder = new TextEncoder();
      const pcm = Buffer.alloc(24000 * 2).toString('base64');
      const wire = value => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
      const timers = [];
      let closed = false;
      let streamController;
      const clear = () => { closed = true; for (const timer of timers) clearTimeout(timer); };
      const abort = () => {
        state.aborts++; clear();
        try { streamController?.error(new DOMException('Fixture canceled', 'AbortError')); } catch { /* Already closed. */ }
      };
      const body = new ReadableStream({
        start(controller) {
          streamController = controller;
          if (init?.signal?.aborted) { abort(); return; }
          init?.signal?.addEventListener('abort', abort, { once: true });
          controller.enqueue(wire({ output: { audio: { data: pcm }, finish_reason: 'null' } }));
          timers.push(setTimeout(() => { if (!closed) controller.enqueue(wire({ output: { audio: { data: pcm }, finish_reason: 'null' } })); }, 650));
          timers.push(setTimeout(() => {
            if (closed) return;
            controller.enqueue(wire({ output: { finish_reason: 'stop' } }));
            clear(); controller.close(); init?.signal?.removeEventListener('abort', abort);
          }, 1200));
        },
        cancel() { clear(); init?.signal?.removeEventListener('abort', abort); },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    };
  }, { apiPath: API_PATH, model: MODEL, voice: VOICE,
    instructionHash: createHash('sha256').update(connection.instruction ?? '自然清晰，表达简洁。').digest('hex') });
}

async function importExternalModel() {
  assert.ok(connection.modelFile && path.isAbsolute(connection.modelFile), 'an absolute existing test model is required');
  await instance.evaluate(({ dialog }, file) => {
    globalThis.__emotionalVoiceOriginalDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, connection.modelFile);
  try {
    await navigateControlPage(controls, 'appearance');
    await controls.locator('#import-model').click();
    await poll(controls, async file => {
      const value = await window.desktop.getSettings();
      return value.model?.path === file && document.querySelector('.emotional-voice-context')?.textContent?.includes(value.model.name);
    }, connection.modelFile);
  } finally {
    await instance.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__emotionalVoiceOriginalDialog; delete globalThis.__emotionalVoiceOriginalDialog; });
  }
  await navigateControlPage(controls, 'providers');
}

async function assertEncrypted() {
  const current = await settings(), bytes = await readFile(settingsFile, 'utf8'), raw = JSON.parse(bytes);
  assert.ok(current.tts?.apiKey === '••••••••', 'public settings must contain only the saved-key sentinel');
  assert.ok(!JSON.stringify(current).includes(connection.key), 'public settings must not expose the key');
  assert.ok(!bytes.includes(connection.key), 'the settings file must not contain the plaintext key');
  assert.ok(!Object.hasOwn(raw.tts ?? {}, 'apiKey'), 'the persisted TTS object must omit its key');
  assert.ok(typeof raw.ttsApiKeyEncrypted === 'string' && raw.ttsApiKeyEncrypted.length > 0, 'OS-encrypted TTS key must be present');
  assert.equal(current.voice.enabled, false, 'manual preview must not turn on automatic reading');
}

try {
  if (process.stdin.isTTY) throw new Error('Provide private TTS connection JSON through stdin. This script does not accept credentials in arguments or environment variables.');
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const bytes of process.stdin) { input += bytes; if (input.length > 32000) throw new Error('Private stdin configuration is too large.'); }
  if (!input.trim()) throw new Error('Private stdin JSON is required for the single real cloud preview; no application was started.');
  try { connection = JSON.parse(input); } catch { throw new Error('Private stdin JSON is not valid.'); }
  input = '';
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)
    || !['host', 'key', 'region'].every(field => typeof connection[field] === 'string' && connection[field].trim()))
    throw new Error('Private stdin must contain nonempty host, key and region strings.');
  connection.host = connection.host.trim(); connection.key = connection.key.trim(); connection.region = connection.region.trim();
  if (connection.host.length > 2000 || connection.key.length > 2000 || connection.region.length > 80)
    throw new Error('Private connection fields exceed the supported local limits.');
  const api = new URL(connection.host);
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash || !['/', API_PATH].includes(api.pathname))
    throw new Error('The console API Host must be HTTPS and may contain only the exact SpeechSynthesizer endpoint suffix.');
  if (connection.instruction !== undefined && typeof connection.instruction !== 'string') throw new Error('The private instruction must be text.');
  if (connection.instruction?.length > 1000) throw new Error('The private instruction exceeds the supported local limit.');
  if (typeof connection.instruction === 'string') connection.instruction = connection.instruction.trim();
  if (connection.modelFile) {
    if (typeof connection.modelFile !== 'string' || !path.isAbsolute(connection.modelFile) || !/\.(pmx|pmd)$/i.test(connection.modelFile)) throw new Error('The supplied external model must be an absolute PMX/PMD file.');
    connection.modelFile = await realpath(connection.modelFile);
    assert.ok((await stat(connection.modelFile)).isFile(), 'the authorized external model exists');
  }
  const endpoint = api.origin + API_PATH;
  const instruction = connection.instruction ?? '自然清晰，表达简洁。';
  await mkdir(output, { recursive: true });
  profile = await mkdtemp(path.join(output, 'profile-')); settingsFile = path.join(profile, 'settings.json');
  phase = 'first-use-system-default';
  await launch();
  const initial = await settings();
  assert.equal(initial.voice.enabled, false);
  // Run the real stream and AudioContext timing checks silently on this machine.
  await controls.locator('#voice-volume').evaluate(input => {
    input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await poll(controls, async () => (await window.desktop.getSettings()).voice.volume === 0);
  assert.equal(initial.tts?.provider ?? 'system', 'system');
  assert.equal(await controls.locator('#tts-provider').inputValue(), 'system');
  assert.equal(await controls.locator('#tts-api-host').inputValue(), '');
  assert.equal(await controls.locator('#tts-instruction').inputValue(), '');
  assert.ok(await controls.locator('#tts-introduction').isVisible());
  assert.match(await controls.locator('#tts-introduction').textContent(), /自己的百炼账号/);
  assert.equal((await network()).liveCalls, 0);
  await controls.locator('#tts-introduction').screenshot({ path: path.join(output, 'first-use-prompt.png') });
  screenshots.push('first-use-prompt.png'); checked.push(phase);

  if (connection.modelFile) { phase = 'authorized-external-model'; await importExternalModel(); checked.push(phase); }
  phase = 'ui-save-and-os-key-encryption';
  await controls.locator('#tts-provider').selectOption('bailian');
  await controls.locator('#tts-api-host').fill(endpoint);
  await controls.locator('#tts-region').fill(connection.region);
  await controls.locator('#tts-model').fill(MODEL);
  await controls.locator('#tts-voice').fill(VOICE);
  await controls.locator('#tts-api-key').fill(connection.key);
  await controls.locator('#tts-emotion').selectOption('custom');
  await controls.locator('#tts-instruction').fill(instruction);
  assert.equal(await controls.locator('#tts-rate').inputValue(), '1');
  await controls.locator('#tts-rate').press('ArrowLeft');
  assert.equal(Number(await controls.locator('#tts-rate').inputValue()), 0.95);
  await controls.locator('#tts-save').click();
  await saved(); await assertEncrypted();
  assert.equal((await network()).liveCalls, 0, 'configuration alone cannot call the cloud');
  assert.equal(await controls.locator('#tts-api-key').inputValue(), '');
  await controls.locator('#tts-open-console').click(); await controls.locator('#tts-open-guide').click();
  await pollMain(() => globalThis.__emotionalVoiceNetwork.openedUrls.length === 2);
  const links = (await network()).urls;
  assert.deepEqual(links, ['https://bailian.console.aliyun.com/', 'https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide']);
  checked.push(phase);

  phase = 'restart-regrants-encrypted-key-and-style';
  await instance.close(); instance = undefined;
  await launch(); await saved(); await assertEncrypted();
  await poll(controls, expected => document.querySelector('#tts-instruction')?.value === expected, instruction);
  assert.ok(!(await controls.locator('#tts-introduction').isVisible()));
  assert.equal(await controls.locator('#tts-instruction').inputValue(), instruction);
  assert.equal(await controls.locator('#tts-voice').inputValue(), VOICE);
  checked.push(phase);

  phase = 'one-live-cloud-stream-and-actual-buffer-start';
  await controls.locator('#tts-preview-text').fill('你好，我已经接通情感语音。现在可以自然地陪你说话。');
  await controls.locator('#tts-preview').click();
  await poll(controls, () => window.__emotionalVoiceSmoke.starts.length > 0, undefined, 60000);
  await poll(controls, () => window.__emotionalVoiceSmoke.doneAt !== null, undefined, 60000);
  await idle();
  const live = await stats(controls), petLive = await stats(pet);
  const label = await controls.locator('#tts-playback-status').textContent();
  const playbackMatch = label.match(/开始出声\s*(\d+)\s*ms/);
  assert.ok(Number.isFinite(live.firstAudioMs) && live.firstAudioMs >= 0, 'the host reports an actual first-audio network measurement');
  assert.ok(playbackMatch, 'the UI reports the measured audible start (R02)');
  assert.ok(live.starts[0].at < live.doneAt, 'the first actual BufferSource.start happens before the transport done event');
  assert.ok(live.closes >= 0, 'R02: the warm AudioContext is reused between utterances, so it need not close');
  assert.equal(petLive.audioEvents, 0, 'manual control-window preview is not broadcast to the pet');
  assert.equal((await network()).liveCalls, 1, 'exactly one real paid synthesis request is used');
  assert.equal((await network()).livePayloadMatchesExpected, true, 'the live request uses the selected model, voice, scoped instruction and rate');
  await assertEncrypted();
  liveMetrics = { hostFirstAudioMs: live.firstAudioMs, measuredAudibleStartMs: Number(playbackMatch[1]),
    actualBufferStarts: live.starts.length, firstBufferSourceStartBeforeTransportDone: true,
    measurement: 'Network dispatch to first PCM bytes; separately, the audio clock reaching the first scheduled sample (R02). Not a physical loudspeaker measurement.' };
  await controls.locator('#tts-playback-status').screenshot({ path: path.join(output, 'live-latency.png') }); screenshots.push('live-latency.png');
  checked.push(phase);

  phase = 'mock-cancel-and-late-event-isolation';
  await instance.evaluate(() => { globalThis.__emotionalVoiceNetwork.mode = 'mock'; });
  const startCount = (await stats(controls)).starts.length;
  await controls.locator('#tts-preview').click();
  await poll(controls, count => window.__emotionalVoiceSmoke.starts.length > count, startCount);
  const oldEvents = (await stats(controls)).events, oldId = oldEvents.filter(event => event.type === 'audio').at(-1).id;
  const abortedBefore = (await network()).aborts;
  await controls.locator('#tts-stop').click(); await idle();
  await pollMain((_, previous) => globalThis.__emotionalVoiceNetwork.aborts > previous, abortedBefore);
  const nextStartCount = (await stats(controls)).starts.length;
  await controls.locator('#tts-preview').click();
  await poll(controls, count => window.__emotionalVoiceSmoke.starts.length > count, nextStartCount);
  const beforeLate = (await stats(controls)).starts.length;
  await instance.evaluate(({ BrowserWindow }, id) => {
    const owner = BrowserWindow.getAllWindows().find(win => {
      const url = new URL(win.webContents.getURL()); return url.pathname.endsWith('/index.html') && !url.searchParams.has('pet');
    });
    owner.webContents.send('desk:speech', { id, type: 'audio', data: Buffer.alloc(4800).toString('base64'), format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  }, oldId);
  await controls.waitForTimeout(80);
  assert.equal((await stats(controls)).starts.length, beforeLate, 'a canceled request cannot add audio to a newer preview');
  await controls.locator('#tts-stop').click(); await idle();
  assert.ok((await network()).aborts > abortedBefore, 'cancel reaches the host AbortSignal');
  checked.push(phase);

  phase = 'mock-owner-routing-and-wrong-window-cancel';
  const controlId = `owner_control_${Date.now()}`, petId = `owner_pet_${Date.now()}`;
  await controls.evaluate(id => { void window.desktop.synthesizeSpeech(id, 'owner control fixture').catch(() => {}); }, controlId);
  await poll(controls, id => window.__emotionalVoiceSmoke.events.some(event => event.id === id && event.type === 'audio'), controlId);
  assert.ok(!(await stats(pet)).events.some(event => event.id === controlId));
  const beforeWrongCancel = (await network()).aborts;
  await pet.evaluate(id => window.desktop.cancelSpeech(id), controlId);
  assert.equal((await network()).aborts, beforeWrongCancel, 'another window cannot cancel the current speech owner');
  await pet.evaluate(id => { void window.desktop.synthesizeSpeech(id, 'owner pet fixture').catch(() => {}); }, petId);
  await poll(pet, id => window.__emotionalVoiceSmoke.events.some(event => event.id === id && event.type === 'audio'), petId);
  assert.ok(!(await stats(controls)).events.some(event => event.id === petId));
  assert.ok((await stats(controls)).events.some(event => event.id === controlId && event.cancelled));
  await pet.evaluate(id => window.desktop.cancelSpeech(id), petId);
  checked.push(phase);

  phase = connection.modelFile ? 'character-and-model-style-bindings-remain-isolated' : 'character-style-binding-remains-isolated';
  const originalCards = await controls.evaluate(() => window.desktop.getCharacterCards());
  const created = await controls.evaluate(() => window.desktop.saveCharacterCard({ name: 'Neutral voice fixture', description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '' }));
  const otherId = created.cards.find(card => !originalCards.cards.some(original => original.id === card.id))?.id;
  assert.ok(otherId);
  await controls.evaluate(id => window.desktop.activateCharacterCard(id), otherId);
  await poll(controls, async id => (await window.desktop.getCharacterCards()).activeId === id && document.querySelector('#tts-instruction')?.value === '', otherId);
  await controls.evaluate(id => window.desktop.activateCharacterCard(id), originalCards.activeId);
  await poll(controls, expected => document.querySelector('#tts-instruction')?.value === expected, instruction);
  if (connection.modelFile) {
    await navigateControlPage(controls, 'appearance'); await controls.locator('#use-bundled-model').click();
    await poll(controls, async () => (await window.desktop.getSettings()).model?.name === 'gene.pmx');
    await navigateControlPage(controls, 'providers');
    await poll(controls, () => document.querySelector('#tts-instruction')?.value === '');
    await importExternalModel();
    await poll(controls, expected => document.querySelector('#tts-instruction')?.value === expected, instruction);
  }
  assert.equal((await settings()).tts.instruction, '', 'personal style must not become a global Gene/user default');
  await assertEncrypted(); checked.push(phase);

  phase = 'system-output-remains-selectable-without-a-cloud-call';
  const callsBeforeSwitch = (await network()).mockCalls;
  await controls.locator('#tts-provider').selectOption('system'); await controls.locator('#tts-save').click();
  await poll(controls, async () => (await window.desktop.getSettings()).tts?.provider === 'system' && !document.querySelector('#tts-save')?.disabled);
  assert.equal((await network()).mockCalls, callsBeforeSwitch);
  assert.equal((await settings()).voice.enabled, false);
  assert.equal((await network()).liveCalls, 1);
  assert.deepEqual(errors, []);
  checked.push(phase);
  report = { status: 'PASS', packaged: !!process.env.MMD_TEST_EXE, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    checked, screenshots, testedExternalModel: !!connection.modelFile, liveRequests: 1, liveMetrics,
    mockRequests: (await network()).mockCalls, keyEncryptedAndRedacted: true, automaticVoiceStayedOff: true,
    ownerRoutingIsolated: true, personalStyleStayedScoped: true, characterScopeVerified: true,
    modelScopeVerified: !!connection.modelFile, liveModelVoiceStyleAndRateVerified: true, errors };
} catch (error) {
  process.exitCode = 1;
  report = { status: 'FAILED', phase, checked, screenshots, liveMetrics, errors, failure: redact(error instanceof Error ? error.stack : String(error)) };
} finally {
  if (instance) await instance.close().catch(() => {});
  if (profile) await writeFile(path.join(output, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
  console.log(redact(JSON.stringify(report, null, 2)));
}
