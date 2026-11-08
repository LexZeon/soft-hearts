import type { VoiceInputConfig } from "../shared/contracts";
import { validateVoiceInput } from "./validation";
import type { VoiceInputFailure } from '../shared/speech-failure';
import { t, registerUiMessages } from '../shared/ui-language';
import { VOICE_UI_MESSAGES } from '../shared/voice-ui-messages';
registerUiMessages(VOICE_UI_MESSAGES);

/** A compatible-interface failure with its closed category (shared/speech-failure.ts); the message is unchanged. */
export class AsrError extends Error {
  constructor(message: string, readonly failure: VoiceInputFailure) { super(message); }
}

const TRANSPORT_MESSAGES: Record<string, string> = {
  ECONNREFUSED: 'asr.transport.refused',
  ENOTFOUND: 'asr.transport.dns', EAI_AGAIN: 'asr.transport.dns',
  ECONNRESET: 'asr.transport.disconnected', UND_ERR_SOCKET: 'asr.transport.disconnected',
  ETIMEDOUT: 'asr.transport.connectTimeout', UND_ERR_CONNECT_TIMEOUT: 'asr.transport.connectTimeout',
  CERT_HAS_EXPIRED: 'asr.transport.certificate', DEPTH_ZERO_SELF_SIGNED_CERT: 'asr.transport.certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'asr.transport.certificate', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'asr.transport.certificate',
  ERR_TLS_CERT_ALTNAME_INVALID: 'asr.transport.certificate',
};

/** Only known codes and the validated origin may cross IPC; never include raw transport errors. */
function transportError(error: unknown, signal: AbortSignal, timeout: AbortSignal, origin: string): Error {
  signal.throwIfAborted();
  if (timeout.aborted) return new AsrError(t('asr.transport.responseTimeout', { origin }), 'timeout');
  const failure = error as { code?: unknown; cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } } | null;
  const codes = [failure?.code, failure?.cause?.code, ...(Array.isArray(failure?.cause?.errors) ? failure.cause.errors.map(item => item?.code) : [])];
  const code = codes.find((value): value is string => typeof value === "string" && Object.hasOwn(TRANSPORT_MESSAGES, value));
  return new AsrError(code ? t('asr.transport.detail', { message: t(TRANSPORT_MESSAGES[code]), origin, code }) : t('asr.transport.unknown', { origin }), 'unreachable');
}

export function validateWav(value: unknown): ArrayBuffer {
  if (
    !(value instanceof ArrayBuffer) ||
    value.byteLength < 44 ||
    value.byteLength > 4_000_000
  )
    throw new Error(t('asr.wav.size'));
  const bytes = new Uint8Array(value);
  const view = new DataView(value);
  const tag = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (
    tag(0) !== "RIFF" ||
    tag(8) !== "WAVE" ||
    view.getUint32(4, true) + 8 !== value.byteLength
  )
    throw new Error(t('asr.wav.header'));
  let formatFound = false;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) throw new Error(t('asr.wav.truncated'));
    if (type === "fmt ") {
      if (
        formatFound ||
        size < 16 ||
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 2, true) !== 1 ||
        view.getUint32(start + 4, true) !== 16000 ||
        view.getUint32(start + 8, true) !== 32000 ||
        view.getUint16(start + 12, true) !== 2 ||
        view.getUint16(start + 14, true) !== 16
      )
        throw new Error(t('asr.wav.format'));
      formatFound = true;
    } else if (type === "data") {
      if (dataBytes || size === 0 || size % 2)
        throw new Error(t('asr.wav.data'));
      dataBytes = size;
    }
    offset = end + (size % 2);
  }
  if (
    !formatFound ||
    !dataBytes ||
    offset !== bytes.length ||
    dataBytes > 20 * 32000
  )
    throw new Error(t('asr.wav.duration'));
  return value;
}

export async function transcribeWav(
  config: VoiceInputConfig,
  wav: ArrayBuffer,
  signal: AbortSignal,
): Promise<string> {
  const audio = validateWav(wav);
  const input = validateVoiceInput(config);
  if (!input.model) throw new Error(t('asr.model.required'));
  signal.throwIfAborted();
  const origin = new URL(input.baseUrl).origin;
  const timeout = AbortSignal.timeout(60000);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
  form.append("model", input.model);
  if (input.language) form.append("language", input.language);
  let response: Response;
  try {
    response = await fetch(`${input.baseUrl}/audio/transcriptions`, {
      method: "POST",
      body: form,
      headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {},
      signal: AbortSignal.any([signal, timeout]),
      redirect: "error",
    });
  } catch (error) { throw transportError(error, signal, timeout, origin); }
  if (!response.ok)
    throw new AsrError(
      t('asr.response.http', { status: response.status }), 'service',
    );
  let result: unknown;
  try { result = await response.json(); }
  catch (error) {
    signal.throwIfAborted();
    if (!timeout.aborted && error instanceof SyntaxError) throw new AsrError(t('asr.response.json', { origin }), 'service');
    throw transportError(error, signal, timeout, origin);
  }
  signal.throwIfAborted();
  if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string" || result.text.length > 4000)
    throw new AsrError(t('asr.response.text'), 'service');
  return result.text.trim();
}
