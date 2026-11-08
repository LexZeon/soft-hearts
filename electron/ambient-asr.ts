import type { VoiceInputConfig } from '../shared/contracts';
import type { AmbientLanguage, AmbientLanguageCode, AmbientLanguageDetection } from '../shared/ambient-audio';
import type { VoiceInputFailure } from '../shared/speech-failure';
import { validateWav } from './asr';
import { validateVoiceInput } from './validation';

export const AMBIENT_ASR_LIMITS = Object.freeze({ audioSeconds: 12, textCharacters: 4000, responseBytes: 256 * 1024, timeoutMs: 60_000 });
export interface AmbientAsrDependencies {
  fetch?: typeof fetch;
  timeoutMs?: number;
  timeoutSignal?(milliseconds: number): AbortSignal;
}
export interface AmbientAsrResult {
  text: string;
  language: AmbientLanguage;
  /** Provider contract scope, not an accuracy or complete language-coverage claim. */
  languageDetection?: AmbientLanguageDetection;
}
/** A transcription that did not happen; `failure` is its closed category (only that reaches the experience journal). */
export class AmbientAsrError extends Error {
  constructor(message: string, readonly failure: VoiceInputFailure = 'service') { super(message); }
}
const unknownLanguage = (): AmbientLanguage => ({ status: 'unknown', source: 'unverified' });
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const exact = (value: Record<string, unknown>, fields: readonly string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const rawField = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && !value.includes('\0');
const sampleCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 192_000;

/** SenseVoice v2.0.0 reports one of these actual model tags, not ISO guesses. */
function languageCode(value: string): string | null {
  const code = value.trim().toLowerCase().replace(/^<\|([a-z]+)\|>$/u, '$1');
  return ['zh', 'ja', 'en', 'ko', 'yue'].includes(code) ? code : null;
}

/** Actual model tags → the language of a segment: zh / ja / en are supported; any other tag (yue, ko …) is unsupported. */
export function classify(actual: string[]): AmbientLanguage {
  if (!actual.length) return { status: 'unknown', source: 'provider' };
  const supported = (code: string): code is AmbientLanguageCode => code === 'zh' || code === 'ja' || code === 'en';
  const unsupported = actual.find(code => !supported(code));
  if (unsupported) return { status: 'unsupported', language: unsupported, source: 'provider' };
  return actual.length === 1
    ? { status: 'detected', language: actual[0] as AmbientLanguageCode, source: 'provider' }
    : { status: 'mixed', languages: actual as AmbientLanguageCode[], source: 'provider' };
}

const sameLanguages = (value: unknown, expected: string[]) => Array.isArray(value) && value.length === expected.length && expected.every((code, index) => value[index] === code);

/** Flat legacy evidence can prove at most its single actual model tag. */
function legacyLanguage(evidence: Record<string, unknown>, hasText: boolean): AmbientLanguage {
  const allowed = ['source', 'raw_language', 'languages', 'scope', 'version'];
  if (Object.keys(evidence).some(key => !allowed.includes(key)) || !rawField(evidence.raw_language)
    || evidence.version !== undefined && evidence.version !== 1
    || evidence.scope !== undefined && !['single-model-tag', 'unknown-or-not-automatic'].includes(evidence.scope as string)) return unknownLanguage();
  const raw = languageCode(evidence.raw_language);
  const actual = raw && hasText && evidence.scope !== 'unknown-or-not-automatic' ? [raw] : [];
  return sameLanguages(evidence.languages, actual) ? classify(actual) : unknownLanguage();
}

function windowLanguage(evidence: Record<string, unknown>, hasText: boolean, expectedSamples?: number): Pick<AmbientAsrResult, 'language' | 'languageDetection'> {
  const invalid = () => ({ language: unknownLanguage() });
  const fields = ['version', 'source', 'mode', 'scope', 'sample_rate', 'sample_count', 'raw_language', 'has_text', 'windows', 'languages', 'window_analysis'];
  if (!exact(evidence, fields) || !sampleCount(expectedSamples) || !sampleCount(evidence.sample_count)
    || evidence.sample_count !== expectedSamples || evidence.sample_rate !== 16000 || !rawField(evidence.raw_language)
    || typeof evidence.has_text !== 'boolean' || evidence.has_text !== hasText
    || !['auto', 'forced-or-unknown'].includes(evidence.mode as string) || !Array.isArray(evidence.windows)) return invalid();
  let actual: string[];
  if (evidence.scope === 'whole-result') {
    if (evidence.windows.length || !['not-requested', 'skipped-empty', 'failed'].includes(evidence.window_analysis as string)
      || (evidence.window_analysis === 'skipped-empty') !== !hasText
      || evidence.window_analysis === 'failed' && evidence.mode !== 'auto') return invalid();
    const raw = languageCode(evidence.raw_language);
    actual = evidence.mode === 'auto' && hasText && raw ? [raw] : [];
  } else if (evidence.scope === 'subwindow-observations') {
    const count = Math.ceil(expectedSamples / 64_000);
    if (evidence.mode !== 'auto' || !hasText || evidence.window_analysis !== 'complete' || evidence.windows.length !== count || count > 3) return invalid();
    actual = [];
    let unknown = false;
    for (let index = 0; index < count; index++) {
      const window = record(evidence.windows[index]);
      const start = Math.floor(expectedSamples * index / count), end = Math.floor(expectedSamples * (index + 1) / count);
      if (!window || !exact(window, ['start_sample', 'end_sample', 'raw_language', 'raw_event', 'has_text'])
        || !Number.isSafeInteger(window.start_sample) || !Number.isSafeInteger(window.end_sample)
        || window.start_sample !== start || window.end_sample !== end || end - start > 64_000
        || !rawField(window.raw_language) || !rawField(window.raw_event) || typeof window.has_text !== 'boolean'
        // A <=4s request reuses its already-completed whole result, never a second tag.
        || count === 1 && (window.raw_language !== evidence.raw_language || window.has_text !== hasText)) return invalid();
      if (!window.has_text) continue;
      const code = languageCode(window.raw_language);
      if (!code) unknown = true;
      else if (!actual.includes(code)) actual.push(code);
    }
    if (unknown) actual = [];
  } else return invalid();
  if (!sameLanguages(evidence.languages, actual)) return invalid();
  return { language: classify(actual), languageDetection: { version: 2, scope: evidence.scope,
    windowAnalysis: evidence.window_analysis as NonNullable<AmbientAsrResult['languageDetection']>['windowAnalysis'] } };
}

/** Only the request's validated PCM sample count can bind v2 window evidence to audio. */
export function parseAmbientAsrResult(value: unknown, expectedSamples?: number): AmbientAsrResult {
  const result = record(value);
  if (!result || typeof result.text !== 'string' || result.text.length > AMBIENT_ASR_LIMITS.textCharacters || result.text.includes('\0'))
    throw new AmbientAsrError('系统音频识别服务返回的文字格式不正确。');
  const text = result.text.trim(), evidence = record(result.language_detection);
  if (!evidence || evidence.source !== 'sensevoice-model') return { text, language: unknownLanguage() };
  // Shape checks are neither server authentication nor recognition-quality validation.
  return { text, ...(evidence.version === 2 ? windowLanguage(evidence, !!text, expectedSamples) : { language: legacyLanguage(evidence, !!text) }) };
}

/** A checked 16 kHz mono PCM16 WAV of at most 12 seconds (both recognizers take only this). */
export function validateAmbientWav(wav: ArrayBuffer): { audio: ArrayBuffer; samples: number } {
  const audio = validateWav(wav), view = new DataView(audio), bytes = new Uint8Array(audio);
  // validateWav already checks chunk bounds, padding and 16kHz mono PCM16.
  // Count the data chunk, rather than rejecting valid short audio with metadata.
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    if (String.fromCharCode(...bytes.subarray(offset, offset + 4)) === 'data') {
      if (size > AMBIENT_ASR_LIMITS.audioSeconds * 32000) throw new AmbientAsrError('系统音频片段不能超过 12 秒。', 'other');
      return { audio, samples: size / 2 };
    }
    offset += 8 + size + size % 2;
  }
  throw new AmbientAsrError('系统音频片段的 WAV 数据不正确。', 'other');
}

/** Observe every eventual result, while removing the abort listener on all paths. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function cancelBody(response: Response): void { try { void response.body?.cancel().catch(() => {}); } catch { /* Cleanup must not expose a transport error. */ } }

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > AMBIENT_ASR_LIMITS.responseBytes) {
    cancelBody(response);
    throw new AmbientAsrError('系统音频识别服务响应超过本机大小上限。');
  }
  if (!response.body) throw new AmbientAsrError('系统音频识别服务没有返回 JSON。');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > AMBIENT_ASR_LIMITS.responseBytes) throw new AmbientAsrError('系统音频识别服务响应超过本机大小上限。');
      try { text += decoder.decode(part.value, { stream: true }); }
      catch { throw new AmbientAsrError('系统音频识别服务返回了无效 JSON。'); }
    }
    try { text += decoder.decode(); return JSON.parse(text); }
    catch { throw new AmbientAsrError('系统音频识别服务返回了无效 JSON。'); }
  } finally {
    // Cancellation may wait on the source; do not let its promise hold shutdown.
    try { void reader.cancel().catch(() => {}); } catch { /* Already released. */ }
    reader.releaseLock();
  }
}

/** Separate system-audio request: automatic language detection, never forced UI language. */
export async function transcribeAmbientWav(config: VoiceInputConfig, wav: ArrayBuffer, signal: AbortSignal, dependencies: AmbientAsrDependencies = {}): Promise<AmbientAsrResult> {
  const { audio, samples } = validateAmbientWav(wav), input = validateVoiceInput(config);
  if (!input.model) throw new AmbientAsrError('请先填写系统音频识别模型。', 'other');
  signal.throwIfAborted();
  const milliseconds = dependencies.timeoutMs ?? AMBIENT_ASR_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 120_000) throw new AmbientAsrError('系统音频识别超时配置不正确。', 'other');
  const timeout = dependencies.timeoutSignal?.(milliseconds) ?? AbortSignal.timeout(milliseconds);
  const combined = AbortSignal.any([signal, timeout]);
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'system-audio.wav');
  form.append('model', input.model);
  form.append('response_format', 'verbose_json');
  form.append('language_detection_mode', 'sensevoice-windows-v2');
  try {
    combined.throwIfAborted();
    const pending = Promise.resolve((dependencies.fetch ?? fetch)(`${input.baseUrl}/audio/transcriptions`, {
      method: 'POST', body: form, headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {},
      signal: combined, redirect: 'error',
    })).then(response => {
      if (combined.aborted) { cancelBody(response); combined.throwIfAborted(); }
      return response;
    });
    const response = await abortable(pending, combined);
    if (!response.ok || response.redirected) {
      cancelBody(response);
      throw new AmbientAsrError(`系统音频识别服务返回 HTTP ${response.status}，请检查连接与识别模型。`);
    }
    const result = parseAmbientAsrResult(await boundedJson(response, combined), samples);
    combined.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) throw new AmbientAsrError('系统音频识别服务响应超时，请检查服务状态。', 'timeout');
    if (error instanceof AmbientAsrError) throw error;
    throw new AmbientAsrError('无法请求系统音频识别服务，请检查连接与服务状态。', 'unreachable');
  }
}
