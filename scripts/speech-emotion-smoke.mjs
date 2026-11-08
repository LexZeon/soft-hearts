import assert from 'node:assert/strict';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// Disposable Gene profile, public character cards, silent PCM and loopback fixtures only.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace);
const output = path.join(workspace, '.local/speech-emotion-smoke');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-emotion-smoke-'));
const body = '今天我们有一件事要一起完成。我会在这里陪着你。';
const longBody = body.repeat(Math.ceil(4100 / body.length)).slice(0, 4100);
const personas = [{
  key: 'reserved', name: '公开内敛样例', identity: '内敛样例', source: 'personality',
  sentence: '内敛样例说话克制含蓄，喜悦也轻轻表达，语气沉稳而留白。',
}, {
  key: 'outgoing', name: '公开外向样例', identity: '外向样例', source: 'legacy-systemPrompt',
  sentence: '外向样例口吻活泼开朗，开心时热情，关心时坦率直接。',
}];
const contexts = ['neutral', 'positive', 'concern'];
const feeling = context => context === 'positive' ? '开心和欣喜' : context === 'concern' ? '关心、支持或安慰' : '平静自然';
const legacyBackground = '背景条目：这段公开背景不应作为声音指令整体传入。';
const checked = [], errors = [];
const personaMatrix = [];
let instance, controls, pet, report, phase = 'launch';
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs): a fixed body plus this turn's state tail.
const claude = await createClaudeFixture({ respond: turn => {
  const marker = turn.text.match(/<sh-state-[a-f0-9]+>/)?.[0];
  assert.ok(marker);
  const last = turn.currentUser ?? '';
  const context = last.includes('positive') ? 'positive' : last.includes('concern') ? 'concern' : 'neutral';
  const tail = marker + JSON.stringify({ context, delta: {}, reason: 'public fixture', confidence: 0.99, gesture: 'none' }) + marker.replace('<', '</');
  return (last.includes('long-reply') ? longBody : body) + '\n' + tail;
} });
async function poll(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error(`Timed out: ${label}`);
}
const stats = () => instance.evaluate(() => ({ payloads: globalThis.__speechEmotionPayloads, remote: globalThis.__speechEmotionRemote }));
function assertInstruction(payload, persona, context) {
  assert.equal(payload.input.voice, 'longanlingxin_v3.1');
  assert.equal(payload.input.rate, 0.9);
  assert.ok(payload.input.instruction.includes(persona.sentence), `${persona.key}: actual card speech excerpt is required`);
  assert.ok(payload.input.instruction.startsWith('角色口吻参考：\n'), 'The instruction must lead with the actual active character reference.');
  const current = payload.input.instruction.split('\n').find(line => line.startsWith('本轮语气：'));
  assert.ok(current?.includes(feeling(context)), `${persona.key}: current ${context} feeling is required`);
  assert.ok(payload.input.instruction.indexOf(persona.sentence) < payload.input.instruction.indexOf('本轮语气：'));
  for (const alternative of contexts.filter(value => value !== context))
    assert.ok(!current.includes(feeling(alternative)), 'The current-feeling line must not enumerate alternative moods.');
  assert.doesNotMatch(payload.input.instruction, /内敛的角色开心|外向的角色可以|同一种开心或安慰/);
  for (const other of personas.filter(value => value.key !== persona.key))
    assert.ok(!payload.input.instruction.includes(other.identity), `${persona.key}: another card identity must not leak`);
  assert.ok(!payload.input.instruction.includes(legacyBackground), 'Do not forward a complete legacy persona as a voice instruction.');
}
async function rejectedContext(page, id, replyId, label) {
  const before = (await stats()).payloads.length;
  await page.evaluate(async value => window.desktop.synthesizeSpeech(value.id, value.body, { replyId: value.replyId }), { id, replyId, body });
  await poll(() => page.evaluate(id => window.__speechEmotionEvents.some(event => event.id === id && event.type === 'error' && !event.cancelled), id), label);
  assert.equal((await stats()).payloads.length, before, `${label}: rejected context must not reach HTTP synthesis`);
  assert.equal(await page.evaluate(id => window.__speechEmotionEvents.some(event => event.id === id && ['audio', 'done'].includes(event.type)), id), false);
}
try {
  const environment = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile }); delete environment.ELECTRON_RUN_AS_NODE;
  instance = await electron.launch({ ...(process.env.MMD_TEST_EXE ? {
    executablePath: path.resolve(process.env.MMD_TEST_EXE), args: [`--user-data-dir=${profile}`],
  } : { args: [appDirectory, `--user-data-dir=${profile}`] }), env: environment, cwd: appDirectory });
  await claude.install(instance);
  await instance.firstWindow();
  await poll(async () => {
    const pages = instance.windows();
    controls = pages.find(page => /index\.html(?:\?|$)/.test(page.url()) && !new URL(page.url()).searchParams.has('pet'));
    pet = pages.find(page => /index\.html(?:\?|$)/.test(page.url()) && new URL(page.url()).searchParams.has('pet'));
    return controls && pet && await controls.evaluate(() => !!window.desktop);
  }, 'trusted windows');
  for (const page of [controls, pet]) page.on('pageerror', error => errors.push(error.message));
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  await poll(() => instance.evaluate(({ BrowserWindow }) => {
    const panel = BrowserWindow.getAllWindows().find(win => {
      try { const url = new URL(win.webContents.getURL()); return url.pathname.endsWith('/index.html') && !url.searchParams.has('pet'); }
      catch { return false; }
    });
    // Product shows this window only after both initial loadWindow promises resolve.
    return !!panel?.isVisible() && !panel.webContents.isLoadingMainFrame();
  }), 'product initial load and show complete');
  // Chat runs through the fake Claude Code process; no renderer HTTP is allowed at all.
  await instance.evaluate(({ BrowserWindow, session }) => {
    globalThis.__speechEmotionPayloads = []; globalThis.__speechEmotionRemote = 0;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      globalThis.__speechEmotionRemote++;
      callback({ cancel: true });
    });
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://tts-fixture.example/api/v1/services/audio/tts/SpeechSynthesizer') return original(url, init);
      const payload = JSON.parse(String(init.body)); globalThis.__speechEmotionPayloads.push(payload);
      const data = Buffer.alloc(48000).toString('base64');
      return new Response(`data: ${JSON.stringify({ output: { audio: { data }, finish_reason: 'stop' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    const panel = BrowserWindow.getAllWindows().find(win => {
      try { const url = new URL(win.webContents.getURL()); return /index\.html$/.test(url.pathname) && !url.searchParams.has('pet'); }
      catch { return false; }
    });
    panel.show(); panel.focus();
  });
  await controls.bringToFront();
  const cardIds = await controls.evaluate(async ({ provider, personas, legacyBackground }) => {
    await window.desktop.useBundledModel();
    const ids = [];
    for (const persona of personas) {
      const original = await window.desktop.getCharacterCards();
      const state = await window.desktop.saveCharacterCard({ name: persona.name, description: '',
        personality: persona.source === 'personality' ? persona.sentence : '', scenario: '', greeting: '', examples: '',
        systemPrompt: persona.source === 'legacy-systemPrompt' ? `${legacyBackground}\n说话方式：${persona.sentence}` : '' });
      const card = state.cards.find(card => !original.cards.some(previous => previous.id === card.id));
      if (!card) throw new Error('Public character fixture was not saved.');
      if (persona.source === 'legacy-systemPrompt' && card.personality !== '') throw new Error('Legacy fixture must have no personality field content.');
      ids.push(card.id);
    }
    await window.desktop.activateCharacterCard(ids[0]);
    const settings = await window.desktop.getSettings();
    if (settings.model?.name !== 'gene.pmx') throw new Error('Public Gene model was not selected.');
    settings.provider = { ...settings.provider, ...provider };
    settings.voice = { ...settings.voice, enabled: true, volume: 0 };
    settings.tts = { provider: 'bailian', apiHost: 'https://tts-fixture.example', region: 'fixture', model: 'qwen-audio-3.1-tts-flash',
      voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom', rate: 0.9, apiKey: 'not-a-real-key', introduced: true, styleBindings: [] };
    await window.desktop.saveSettings(settings);
    return ids;
  }, { provider: claude.provider, personas, legacyBackground });
  assert.equal(cardIds.length, 2);
  // Direct fixture save uses the real host API; reload only after initial loads settle.
  await poll(() => instance.evaluate(({ BrowserWindow }) => {
    const pages = BrowserWindow.getAllWindows().filter(win => { try { return new URL(win.webContents.getURL()).pathname.endsWith('/index.html'); } catch { return false; } });
    return pages.length === 2 && pages.every(win => !win.webContents.isLoadingMainFrame());
  }), 'startup complete before fixture reload');
  await controls.reload();
  await poll(() => controls.evaluate(() => document.querySelector('#tts-provider')?.value === 'bailian'), 'reloaded saved voice configuration');
  for (const page of [controls, pet]) await page.evaluate(() => {
    window.__speechEmotionEvents = [];
    window.desktop.onSpeechEvent(event => window.__speechEmotionEvents.push({ id: event.id, type: event.type, cancelled: !!event.cancelled }));
  });
  await controls.evaluate(() => {
    window.__speechEmotionAudio = { starts: [], ends: [] };
    const OriginalAudio = window.AudioContext;
    window.AudioContext = class extends OriginalAudio {
      createBufferSource() {
        const source = super.createBufferSource(), start = source.start.bind(source);
        source.start = (...args) => { window.__speechEmotionAudio.starts.push(performance.now()); return start(...args); };
        source.addEventListener('ended', () => window.__speechEmotionAudio.ends.push(performance.now()));
        return source;
      }
    };
    window.desktop.onChatStarted(event => { window.__speechEmotionChatId = event.id; });
  });
  await navigateControlPage(controls, 'chat');
  checked.push('isolated-gene-public-cards-and-muted-fake-provider');
  let previousCardReplyId;
  for (const [personaIndex, persona] of personas.entries()) {
    phase = `${persona.key}-activate`;
    await controls.evaluate(id => window.desktop.activateCharacterCard(id), cardIds[personaIndex]);
    await poll(() => controls.evaluate(async id => {
      const cards = await window.desktop.getCharacterCards(), settings = await window.desktop.getSettings();
      return cards.activeId === id && settings.model?.name === 'gene.pmx'
        && settings.tts.voice === 'longanlingxin_v3.1' && settings.tts.rate === 0.9
        && settings.tts.instruction === '' && settings.tts.styleBindings.length === 0;
    }, cardIds[personaIndex]), `${persona.key} active card with unchanged model, voice and neutral static style`);
    if (previousCardReplyId) {
      await rejectedContext(controls, 'previous-character', previousCardReplyId, 'previous card reply context rejected after activation');
      checked.push('switching-character-rejects-previous-reply-context');
    }
    for (const context of contexts) {
      const index = personaMatrix.length;
      phase = `${persona.key}-${context}`;
      await controls.locator('#chat-input').fill(`public emotion fixture ${context}`);
      await controls.locator('#chat-input').press('Enter');
      await poll(async () => (await stats()).payloads.length === index + 1, phase + ' synthesis');
      await poll(() => controls.evaluate(count => window.__speechEmotionAudio.starts.length === count, index + 1), phase + ' actual PCM start');
      if (index === 2) {
        const replyId = await controls.evaluate(() => window.__speechEmotionChatId);
        await rejectedContext(pet, 'wrong-owner', replyId, 'wrong window reply context');
      }
      await poll(() => controls.evaluate(count => window.__speechEmotionAudio.ends.length === count
        && document.querySelector('#tts-playback-status')?.dataset.phase === 'idle', index + 1), phase + ' final playback');
      const payload = (await stats()).payloads[index];
      assert.equal(payload.input.text, body);
      assertInstruction(payload, persona, context);
      personaMatrix.push({ persona: persona.key, source: persona.source, mood: context, instruction: payload.input.instruction,
        voice: payload.input.voice, rate: payload.input.rate });
      checked.push(phase + '-actual-card-and-current-feeling-to-http-and-final-playback');
    }
    previousCardReplyId = await controls.evaluate(() => window.__speechEmotionChatId);
  }
  const lastId = await controls.evaluate(() => window.__speechEmotionChatId);
  await rejectedContext(controls, 'completed-replay', lastId, 'completed reply replay');
  assert.equal((await stats()).payloads.length, 6); checked.push('wrong-window-and-completed-replay-cannot-synthesize');
  phase = 'long-reply';
  await controls.locator('#chat-input').fill('public neutral long-reply'); await controls.locator('#chat-input').press('Enter');
  await poll(async () => (await stats()).payloads.length === 9, 'three long reply segments');
  await poll(() => controls.evaluate(() => window.__speechEmotionAudio.starts.length === 9), 'three long PCM sources scheduled');
  const longId = await controls.evaluate(() => window.__speechEmotionChatId);
  const before = await controls.evaluate(() => ({ phase: document.querySelector('#tts-playback-status')?.dataset.phase,
    ends: window.__speechEmotionAudio.ends.length }));
  assert.notEqual(before.phase, 'idle');
  await controls.evaluate(async () => window.desktop.setMoodDeveloperMode(true));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.notEqual(await controls.evaluate(() => document.querySelector('#tts-playback-status')?.dataset.phase), 'idle');
  await poll(() => controls.evaluate(() => document.querySelector('#tts-playback-status')?.dataset.phase === 'idle'), 'long reply PCM drain');
  const longPayloads = (await stats()).payloads.slice(6, 9);
  assert.equal(longPayloads.length, 3);
  assert.equal(longPayloads.map(value => value.input.text).join(''), longBody);
  assert.equal(new Set(longPayloads.map(value => value.input.instruction)).size, 1);
  for (const payload of longPayloads) assertInstruction(payload, personas[1], 'neutral');
  const audio = await controls.evaluate(() => window.__speechEmotionAudio);
  assert.equal(audio.starts.length, 9); assert.equal(audio.ends.length, 9);
  checked.push('long-reply-three-segments-mood-updates-and-final-pcm-drain');
  await controls.evaluate(() => window.desktop.newConversation());
  await controls.locator('#chat-input').fill('public positive new-conversation'); await controls.locator('#chat-input').press('Enter');
  await poll(async () => (await stats()).payloads.length === 10, 'new conversation reply');
  await poll(() => controls.evaluate(() => window.__speechEmotionAudio.starts.length === 10), 'new conversation actual PCM start before stale request');
  const rejectedAt = await controls.evaluate(async ({ replyId, body }) => {
    if (window.__speechEmotionAudio.ends.length !== 9) throw new Error('New sample already ended before stale-context exercise.');
    await window.desktop.synthesizeSpeech('stale-conversation', body, { replyId });
    return performance.now();
  }, { replyId: longId, body });
  await poll(() => controls.evaluate(() => window.__speechEmotionEvents.some(event => event.id === 'stale-conversation' && event.type === 'error' && !event.cancelled)), 'old conversation context rejected by real IPC');
  await poll(() => controls.evaluate(() => document.querySelector('#tts-playback-status')?.dataset.phase === 'idle'), 'new reply survives old context');
  assert.equal((await stats()).payloads.length, 10);
  assertInstruction((await stats()).payloads[9], personas[1], 'positive');
  const finalAudio = await controls.evaluate(() => window.__speechEmotionAudio);
  assert.equal(finalAudio.starts.length, 10); assert.equal(finalAudio.ends.length, 10);
  const finalPlaybackMs = finalAudio.ends[9] - finalAudio.starts[9];
  assert.ok(finalPlaybackMs >= 900, 'stale context must not truncate the one-second final PCM');
  assert.ok(rejectedAt < finalAudio.ends[9], 'stale context was rejected while new PCM was still playing');
  checked.push('new-conversation-rejects-old-context-without-cancelling-new-audio');
  assert.equal((await stats()).remote, 0); assert.deepEqual(errors, []);
  claude.assertClean(); assert.deepEqual((await claude.evidence(instance)).denied, []);
  report = { status: 'PASS', packaged: !!process.env.MMD_TEST_EXE, checked, errors, syntheticTtsRequests: 10,
    personas: 2, moodsPerPersona: 3, personaMatrix, legacyStyleExtractionVerified: true, staticInstructionEmpty: true,
    sameGeneVoiceAndRateAcrossPersonas: true, oldCharacterContextRejectedByIpc: true,
    segmentedTextExact: true, segmentedInstructionExact: true, segmentedInstruction: longPayloads[0].input.instruction,
    actualBufferStarts: finalAudio.starts.length, actualBufferEnds: finalAudio.ends.length,
    finalPlaybackMs, staleContextRejectedBeforePlaybackEnd: true,
    realCloudRequests: 0, normalProfileUsed: false, volume: 0, subjectiveEmotionListeningVerified: false };
} catch (error) { report = { status: 'FAIL', phase, checked, errors, message: error.message }; process.exitCode = 1; }
finally {
  if (instance) await instance.close().catch(() => {});
  report.fakeClaude = await claude.close();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
