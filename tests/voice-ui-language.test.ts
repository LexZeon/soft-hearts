import test from 'node:test';
import assert from 'node:assert/strict';
import { setUiLanguage, t, registerUiMessages } from '../shared/ui-language';
import { VOICE_UI_MESSAGES } from '../shared/voice-ui-messages';
import { VoiceContinuationStatus } from '../src/ui/VoiceContinuationStatus';
import { transcribeWav, validateWav } from '../electron/asr';
import { encodeWav } from '../src/ui/MediaInput';
import { DEFAULT_SETTINGS } from '../shared/defaults';
registerUiMessages(VOICE_UI_MESSAGES);

test('voice dictionaries cover the same fixed keys/placeholders and leave private placeholder text untouched', () => {
  const en = VOICE_UI_MESSAGES.en, zh = VOICE_UI_MESSAGES['zh-CN'];
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(value => value[1]).sort();
  for (const key of Object.keys(en)) {
    assert.ok(/^(?:voice|asr)\./.test(key)); assert.ok(en[key].trim()); assert.ok(zh[key].trim());
    assert.equal(/[\u3400-\u9fff]/.test(en[key]), false, key);
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), key);
  }
  try {
    setUiLanguage('en'); const privateText = '用户原文{origin}<keep>';
    assert.equal(t('voice.capture.rejected', { reason: privateText }), `The voice segment was not accepted (${privateText}). Voice input has paused.`);
  } finally { setUiLanguage('zh-CN'); }
});

test('actual continuation status uses English and refreshes only presentation while retaining current reply identity', () => {
  const output = { textContent: '', hidden: false, setAttribute() {} }, status = new VoiceContinuationStatus(output as any);
  const base = { epoch: 'epoch', owner: 'controls' as const, groupId: 'group' };
  try {
    setUiLanguage('en'); status.receive({ ...base, type: 'row', seq: 1, text: '用户原文' });
    status.receive({ ...base, type: 'start', replyId: 'first' });
    status.receive({ ...base, type: 'continuation', replyId: 'first', state: 'queued' }); assert.match(output.textContent, /queued.*separate follow-up/);
    status.receive({ ...base, type: 'start', replyId: 'second' });
    status.receive({ ...base, type: 'continuation', replyId: 'second', state: 'unconfirmed' }); assert.match(output.textContent, /will not be resent automatically/);
    setUiLanguage('zh-CN'); status.refresh(); assert.match(output.textContent, /不会自动重发/);
    status.receive({ ...base, type: 'continuation', replyId: 'first', state: 'settled' }); assert.match(output.textContent, /不会自动重发/);
    status.clear(); setUiLanguage('en'); status.refresh(); assert.equal(output.textContent, ''); assert.equal(output.hidden, true);
  } finally { setUiLanguage('zh-CN'); }
});

test('actual ASR English path keeps request audio/model/language and returned user text unchanged', async () => {
  const originalFetch = globalThis.fetch, calls: Array<{ url: string; init: RequestInit }> = [];
  const audio = encodeWav(new Float32Array(4096).fill(0.1));
  const config = { ...DEFAULT_SETTINGS.voiceInput!, baseUrl: 'http://127.0.0.1:13371/v1', model: 'fixture-model', language: 'zh', apiKey: 'fixture-key' };
  try {
    setUiLanguage('en'); globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init }); return new Response(JSON.stringify({ text: '  原始用户原话{reason}  ' }), { status: 200 });
    }) as typeof fetch;
    assert.equal(await transcribeWav(config, audio, new AbortController().signal), '原始用户原话{reason}');
    assert.equal(calls.length, 1); assert.equal(calls[0].url, config.baseUrl + '/audio/transcriptions');
    assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.redirect, 'error');
    const form = calls[0].init.body as FormData; assert.equal(form.get('model'), config.model); assert.equal(form.get('language'), 'zh');
    assert.deepEqual(new Uint8Array(await (form.get('file') as Blob).arrayBuffer()), new Uint8Array(audio));
    assert.equal(calls[0].init.headers && (calls[0].init.headers as Record<string, string>).Authorization, 'Bearer fixture-key');
  } finally { globalThis.fetch = originalFetch; setUiLanguage('zh-CN'); }
});

test('actual ASR errors localize safely without exposing raw transport content or retrying', async () => {
  const originalFetch = globalThis.fetch, audio = encodeWav(new Float32Array(4096));
  const config = { ...DEFAULT_SETTINGS.voiceInput!, baseUrl: 'http://127.0.0.1:13371/v1', model: 'fixture-model', language: 'zh', apiKey: 'fixture-key' };
  let calls = 0;
  try {
    setUiLanguage('en');
    globalThis.fetch = (async () => { calls++; throw Object.assign(Error('fixture-key RAW_PRIVATE_CONTENT'), { cause: { code: 'ECONNREFUSED' } }); }) as typeof fetch;
    await assert.rejects(transcribeWav(config, audio, new AbortController().signal), error => {
      assert.match((error as Error).message, /Cannot connect.*127\.0\.0\.1:13371.*ECONNREFUSED/);
      assert.doesNotMatch((error as Error).message, /fixture-key|RAW_PRIVATE/); return true;
    }); assert.equal(calls, 1);
    for (const [response, expected] of [[new Response('', { status: 403 }), /HTTP 403/],
      [new Response('not-json', { status: 200 }), /invalid JSON/], [new Response('{"text":4}', { status: 200 }), /invalid text format/]] as const) {
      calls = 0; globalThis.fetch = (async () => { calls++; return response; }) as typeof fetch;
      await assert.rejects(transcribeWav(config, audio, new AbortController().signal), expected); assert.equal(calls, 1);
    }
    assert.throws(() => validateWav(new ArrayBuffer(4)), /WAV audio no larger than 4 MB/);
    calls = 0; const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(transcribeWav(config, audio, cancelled.signal), { name: 'AbortError' }); assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; setUiLanguage('zh-CN'); }
});
