// I-071 v2 第三步: every entry point of 「转换成英文 / 中文角色」 runs the same job and the popup is required from each: the external
// Claude Code (with or without 三方互通), the Claude 助手 (the real service, endpoint, shim and host with the scripted Claude Code
// double), the 角色页 button (only asks the assistant) and the companion's 「带我去」 (navigation only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentChannelHost } from '../electron/safety/agent-channel/host';
import type { AgentConfirmRequest } from '../electron/safety/agent-channel/registry';
import { createConversionTools } from '../electron/cards/character-convert/tools';
import type { ConversionService } from '../electron/cards/character-convert/service';
import { assistantToolList } from '../electron/safety/assistant/endpoint';
import { AssistantService } from '../electron/safety/assistant/service';
import { AssistantStore, cleanHistory } from '../electron/safety/assistant/store';
import { ASSISTANT_SYSTEM_PROMPT } from '../electron/safety/assistant/prompt';
import { conversionLine, type AssistantConfirmView, type AssistantMessage } from '../shared/safety/assistant';
import { matchTakeMeThere, TAKE_ME_THERE } from '../shared/initiative/take-me-there';
import { CONVERSION_STEPS, type ConversionJobView, type ConversionPreview } from '../shared/cards/character-convert';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIM = path.join(root, 'scripts', 'soft-hearts-assistant-mcp.mjs');
const DOUBLE = path.join(root, 'tests', 'fixtures', 'assistant-claude-double.mjs');

const PREVIEW: ConversionPreview = {
  source: { id: 'card-1', name: '阿澄', language: 'zh-CN' }, target: 'en',
  names: [{ id: 'her-name', label: '她在新卡上的名字', text: '阿澄' }, { id: 'user-nickname', label: '她叫你的昵称', text: '小雨' }],
  counts: { notes: 2, notesCarried: 2, profileEntries: 1, diaryDays: 3, memes: 1, knownDays: 2, qualityDays: 1, metDate: '2026-10-20' },
  copied: ['人设：按意思翻成英文'], settings: { carried: [], off: ['「允许记录」：原来就关着'] }, notCopied: ['原始聊天记录'], voice: '同一个模型的朗读设置带过去', calls: 2, cost: '会用你自己的 Claude Code（sonnet，思考强度中）……不另外花钱。',
  persona: '[description]\n在海边长大的女孩',
};
const NAMES = [{ id: 'her-name', to: 'Cheng' }, { id: 'user-nickname', to: 'Rainy' }];

function fakeService() {
  const started: unknown[] = [];
  let view: ConversionJobView | null = null;
  const service = {
    get running() { return view?.state === 'running'; },
    preview: async (id: string) => { if (id !== 'card-1') throw new Error('这张角色卡不在了。'); return structuredClone(PREVIEW); },
    start: async (request: unknown) => {
      started.push(request);
      view = { id: 'job-1', sourceId: 'card-1', sourceName: '阿澄', target: 'en', state: 'running', steps: CONVERSION_STEPS.map(id => ({ id, status: 'waiting' })), startedAt: 1, cancellable: true };
      return structuredClone(view);
    },
    view: () => structuredClone(view),
    cancel: () => false,
    checkExtra: async (_id: string, extra: unknown[]) => extra,
  };
  return { service: service as unknown as ConversionService, started, finish: () => { view = { ...view!, state: 'done', newCardId: 'card-2', newName: 'Cheng', cancellable: false }; return structuredClone(view); } };
}

async function hostWith(t: test.TestContext, interconnect: boolean, answer: boolean) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sh-convert-entry-'));
  const fake = fakeService();
  const asked: AgentConfirmRequest[] = [];
  const host = new AgentChannelHost({ profileDirectory: dir, tools: createConversionTools(() => fake.service), confirm: async request => { asked.push(request); return answer; } });
  await host.init();
  await host.setInterconnect(interconnect);
  await host.setEnabled(true);
  t.after(async () => { await host.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  return { dir, host, fake, asked };
}

test('external Claude Code, 三方互通 off: the popup decides; 不转换 starts nothing', async t => {
  const { host, fake, asked } = await hostWith(t, false, false);
  const result = await host.registry.call('convert_character_language', { characterId: 'card-1', language: 'en', names: NAMES });
  assert.equal(result.ok, false);
  assert.equal((result as { error: { code: string } }).error.code, 'denied_by_user');
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.title, '把「阿澄」转成英文版？');
  assert.match(asked[0]!.detail, /会新建一个角色「Cheng」，原来的「阿澄」一个字都不动/);
  assert.match(asked[0]!.detail, /她叫你的昵称：「小雨」换成「Rainy」/);
  assert.match(asked[0]!.detail, /不另外花钱/);
  assert.deepEqual(asked[0]!.buttons, ['不转换', '开始转换']);
  assert.deepEqual(fake.started, []);
});

test('external Claude Code, 三方互通 on: the user\'s words are needed first, and the popup still opens (it is never skipped)', async t => {
  const { host, fake, asked } = await hostWith(t, true, true);
  const without = await host.registry.call('convert_character_language', { characterId: 'card-1', language: 'en', names: NAMES });
  assert.equal((without as { error: { code: string } }).error.code, 'needs_user_words');
  assert.equal(asked.length, 0);
  const withWords = await host.registry.call('convert_character_language', { characterId: 'card-1', language: 'en', names: NAMES, userWords: '把阿澄转成英文版' });
  assert.equal(withWords.ok, true);
  assert.equal(asked.length, 1, 'the popup opened although the words were there');
  assert.equal(fake.started.length, 1);
  assert.equal((withWords as { result: { jobId: string } }).result.jobId, 'job-1');
});

test('a name without the user\'s choice, or an unknown card, is refused before any popup', async t => {
  const { host, fake, asked } = await hostWith(t, false, true);
  const missing = await host.registry.call('convert_character_language', { characterId: 'card-1', language: 'en', names: NAMES.slice(0, 1) });
  assert.equal((missing as { error: { code: string; message: string } }).error.code, 'invalid_input');
  assert.match((missing as { error: { message: string } }).error.message, /她叫你的昵称.*还没选/);
  const unknown = await host.registry.call('convert_character_language', { characterId: 'nope', language: 'en', names: NAMES });
  assert.match((unknown as { error: { message: string } }).error.message, /不在了/);
  assert.equal(asked.length, 0);
  assert.deepEqual(fake.started, []);
  // The read tools need no popup and carry no memory text.
  const prepared = await host.registry.call('prepare_character_conversion', { characterId: 'card-1' });
  assert.equal(prepared.ok, true);
  assert.match(JSON.stringify(prepared), /offer_choices/);
  const status = await host.registry.call('get_character_conversion', {});
  assert.deepEqual((status as { result: { state: string } }).result.state, 'none');
});

test('the Claude 助手: prepare, then convert behind its own popup; the progress line follows the job and is kept', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sh-convert-assistant-'));
  const fake = fakeService();
  const host = new AgentChannelHost({ profileDirectory: dir, tools: createConversionTools(() => fake.service), confirm: async () => { throw new Error('the native dialog is never used'); } });
  await host.init();
  const asked: AssistantConfirmView[] = [];
  let scenario: unknown = { steps: [] };
  const logFile = path.join(dir, 'double.jsonl');
  const service: AssistantService = new AssistantService({
    registry: surface => host.surfaceRegistry(surface), store: new AssistantStore(dir), shim: { command: process.execPath, args: [SHIM] },
    emit: event => { if (event.type === 'confirm') { asked.push(event.request); setTimeout(() => service.answer(event.request.id, true), 5); } },
    undo: id => host.undo(id), binary: process.execPath, leadingArgs: [DOUBLE], tempRoot: dir, conversion: { view: () => fake.service.view() },
    env: () => ({ ...process.env, ASSISTANT_DOUBLE_SCENARIO: JSON.stringify(scenario), ASSISTANT_DOUBLE_LOG: logFile }),
  });
  t.after(async () => { await service.dispose(); await host.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  scenario = { steps: [
    { call: { tool: 'prepare_character_conversion', args: { characterId: 'card-1' } } },
    // The model even passes userWords: ignored, the popup decides.
    { call: { tool: 'convert_character_language', args: { characterId: 'card-1', language: 'en', names: NAMES, userWords: '用户说直接转' } } },
    { text: '开始转了。' },
  ] };
  await service.send('把阿澄转成英文版');
  await service.idle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.title, '把「阿澄」转成英文版？');
  assert.equal(fake.started.length, 1);
  const message = (await service.view()).messages.at(-1)! as AssistantMessage;
  const line = message.parts.find(part => part.kind === 'conversion');
  assert.ok(line && line.kind === 'conversion' && line.job.state === 'running');
  // The job finishes later: the same line shows the result, and the history keeps it.
  service.conversionChanged(fake.finish());
  const updated = (await service.view()).messages.at(-1)!.parts.find(part => part.kind === 'conversion');
  assert.ok(updated && updated.kind === 'conversion' && updated.job.state === 'done' && updated.job.newName === 'Cheng');
  assert.match(conversionLine((updated as { job: ConversionJobView }).job), /转好了，新角色「Cheng」/);
  // The history is written in the background: read it until it has the result (a fixed 50 ms wait failed under a full-suite load, 2026-11-22).
  const done = (s: ReturnType<typeof cleanHistory>) => !!s.at(-1)?.parts.some(part => part.kind === 'conversion' && part.job.state === 'done');
  let stored = cleanHistory([]);
  for (let waited = 0; waited < 5_000 && !done(stored); waited += 25) {
    await new Promise(resolve => setTimeout(resolve, 25));
    try { stored = cleanHistory(JSON.parse(await readFile(path.join(dir, 'assistant', 'history.json'), 'utf8'))); } catch { /* not written yet */ }
  }
  assert.ok(done(stored), 'the history keeps the finished line');
  // The tool list the assistant sees: no userWords, and the popup is named.
  const tool = assistantToolList(host.surfaceRegistry({ enabled: () => true, confirm: async () => false }).names()).find(item => item.name === 'convert_character_language')!;
  assert.doesNotMatch(JSON.stringify(tool), /userWords/);
  assert.match(tool.description, /一定会弹窗/);
  assert.match(ASSISTANT_SYSTEM_PROMPT, /prepare_character_conversion/);
});

test('a conversion still running at a restart reads as not finished (it was rolled back), never as running', () => {
  const [message] = cleanHistory([{ id: 'm', role: 'assistant', at: 1, status: 'done', parts: [{ kind: 'conversion', job: {
    id: 'job-1', sourceId: 'a', sourceName: '阿澄', target: 'en', state: 'running', steps: [{ id: 'backup', status: 'done' }], startedAt: 1, cancellable: true } }] }]);
  const part = message!.parts[0]!;
  assert.ok(part.kind === 'conversion' && part.job.state === 'failed' && part.job.cancellable === false && /已经撤回/.test(part.job.error!));
});

test('the pet: asking her to be converted gives 「带我去」 the character page (navigation only); the interface language does not', () => {
  for (const text of ['把你转成英文版吧', '我想要一个英文版的你', 'can you convert you to English', 'make an English version of you'])
    assert.equal(matchTakeMeThere(text), 'convert-character', text);
  for (const text of ['把界面换成英文', '我在学英文', '你会说英文吗', '别把你转成英文版']) assert.notEqual(matchTakeMeThere(text), 'convert-character', text);
  assert.equal(TAKE_ME_THERE['convert-character'].leafId, 'character-wall');
  assert.equal(TAKE_ME_THERE['claude-assistant'].leafId, 'assistant-chat');
});
