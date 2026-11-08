import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderConfig } from '../shared/contracts';
import { codexCatalogSupportsVision, VisionProviderSupport } from '../electron/vision-support';

const catalog = (models: unknown[]) => JSON.stringify({ models });
const model = (slug: string, modalities: string[] = ['text', 'image']) => ({ slug, input_modalities: modalities });

test('Codex image support comes only from the selected model exact catalog metadata', () => {
  const raw = catalog([model('vision'), model('text-only', ['text'])]);
  assert.equal(codexCatalogSupportsVision(raw, 'vision'), true);
  assert.equal(codexCatalogSupportsVision(raw, ' vision '), true);
  assert.equal(codexCatalogSupportsVision(raw, 'text-only'), false);
  assert.equal(codexCatalogSupportsVision(raw, 'Vision'), false);
  assert.equal(codexCatalogSupportsVision(raw, 'unlisted-image-model'), false);
});

test('blank Codex model fails closed unless every possible catalog candidate confirms image input', () => {
  assert.equal(codexCatalogSupportsVision(catalog([model('one'), model('two')]), ''), true);
  assert.equal(codexCatalogSupportsVision(catalog([model('one'), model('two', ['text'])]), ''), false);
  assert.equal(codexCatalogSupportsVision(catalog([model('one'), { slug: 'missing' }]), ''), false);
  assert.equal(codexCatalogSupportsVision(catalog([]), ''), false);
});

test('malformed, missing and ambiguous selected-model capability metadata never grants image access', () => {
  for (const raw of ['', '{broken', 'null', '[]', '{}', '{"models":{}}',
    catalog([null]), catalog([{ slug: 'vision' }]), catalog([{ slug: 'vision', input_modalities: 'image' }]),
    catalog([{ slug: 'vision', input_modalities: [] }]), catalog([model('vision'), model('vision', ['text'])])])
    assert.equal(codexCatalogSupportsVision(raw, 'vision'), false);
});

test('an unrecognized Claude model name stays unverified until an ordinary host image request succeeds', async () => {
  const support = new VisionProviderSupport(), signal = new AbortController().signal;
  const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://127.0.0.1:1/v1', model: 'looks-like-vision' };
  assert.equal(await support.supports(provider, signal), false);
  support.noteImageSuccess(provider);
  assert.equal(await support.supports(provider, signal), true);
});

test('successful image evidence is isolated by stored connection and exact model', async () => {
  const support = new VisionProviderSupport(), signal = new AbortController().signal;
  const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://127.0.0.1:1/v1', model: 'audited' };
  support.noteImageSuccess(provider);
  for (const next of [{ ...provider, baseUrl: 'http://127.0.0.1:2/v1' }, { ...provider, model: 'other' }])
    assert.equal(await support.supports(next, signal), false);
  assert.equal(await new VisionProviderSupport().supports(provider, signal), false);
});

test('aborted capability checks cannot reuse even verified evidence or launch a Codex subprocess', async () => {
  const support = new VisionProviderSupport();
  const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://127.0.0.1:1/v1', model: 'audited' };
  support.noteImageSuccess(provider); const controller = new AbortController(); controller.abort();
  await assert.rejects(support.supports(provider, controller.signal), { name: 'AbortError' });
  await assert.rejects(support.supports({ ...provider, model: 'haiku' }, controller.signal), { name: 'AbortError' });
});

test('Claude image support follows the model name: Claude Code aliases and Claude model ids, unknown names fail closed', async () => {
  const support = new VisionProviderSupport(), signal = new AbortController().signal;
  const claude = (model: string): ProviderConfig => ({ kind: 'claude', baseUrl: 'http://127.0.0.1:11434/v1', model });
  for (const model of ['', 'haiku', 'sonnet', 'opus', 'opus[1m]', 'claude-sonnet-5-5', 'us.anthropic.claude-haiku-5-5'])
    assert.equal(await support.supports(claude(model), signal), true, model);
  for (const model of ['gpt-5', 'llava', 'my-model', 'claude', 'haiku-ish'])
    assert.equal(await support.supports(claude(model), signal), false, model);
});
