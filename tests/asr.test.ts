import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { transcribeWav, validateWav } from "../electron/asr";
import { validateSettings, validateVoiceInput } from "../electron/validation";
import {
  KEY_SENTINEL,
  SettingsStore,
  resolveVoiceInputKey,
} from "../electron/settings";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { AssetRegistry } from "../electron/assets";

function wav(seconds = 1): ArrayBuffer {
  const value = new ArrayBuffer(44 + seconds * 32000);
  const bytes = new Uint8Array(value);
  const view = new DataView(value);
  const tag = (offset: number, text: string) =>
    bytes.set(new TextEncoder().encode(text), offset);
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, bytes.length - 44, true);
  return value;
}

test("WAV validation accepts supported PCM and skips padded metadata chunks", () => {
  const original = wav();
  assert.equal(validateWav(original), original);
  const extra = new ArrayBuffer(original.byteLength + 12);
  const bytes = new Uint8Array(extra);
  bytes.set(new Uint8Array(original, 0, 12));
  bytes.set(new TextEncoder().encode("JUNK"), 12);
  new DataView(extra).setUint32(16, 3, true);
  bytes.set([1, 2, 3, 0], 20);
  bytes.set(new Uint8Array(original, 12), 24);
  new DataView(extra).setUint32(4, bytes.length - 8, true);
  assert.equal(validateWav(extra), extra);
});

test("WAV validation rejects incorrect headers, formats, duration and truncated data", () => {
  assert.throws(() => validateWav(new Uint8Array(50)));
  assert.throws(() => validateWav(new ArrayBuffer(4_000_001)));
  assert.throws(() => validateWav(wav(21)), /20 秒/);
  assert.throws(() => validateWav(wav().slice(0, 100)), /文件头/);
  for (const [offset, value] of [
    [20, 3],
    [22, 2],
    [24, 44100],
    [28, 64000],
    [32, 4],
    [34, 32],
  ]) {
    const invalid = wav();
    new DataView(invalid).setUint16(offset, value, true);
    assert.throws(() => validateWav(invalid), /PCM WAV/);
  }
});

test("ASR sends bounded WAV as multipart with model, language and host-only key", async () => {
  let body = Buffer.alloc(0);
  let contentType: string | undefined;
  let authorization: string | undefined;
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/audio/transcriptions");
    contentType = request.headers["content-type"];
    authorization = request.headers.authorization;
    for await (const chunk of request)
      body = Buffer.concat([body, Buffer.from(chunk)]);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ text: "  测试语音。  " }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const text = await transcribeWav(
      {
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/`,
        model: "fixture-asr",
        language: "zh",
        apiKey: "fixture-secret",
      },
      wav(),
      new AbortController().signal,
    );
    assert.equal(text, "测试语音。");
    assert.equal(authorization, "Bearer fixture-secret");
    assert.match(contentType!, /^multipart\/form-data; boundary=/);
    const fields = body.toString("latin1");
    assert.ok(fields.includes('name="file"; filename="speech.wav"'));
    assert.ok(fields.includes("RIFF"));
    assert.ok(fields.includes('name="model"\r\n\r\nfixture-asr'));
    assert.ok(fields.includes('name="language"\r\n\r\nzh'));
    assert.ok(!fields.includes("fixture-secret"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("ASR cancellation aborts a waiting transcription and never returns stale text", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const controller = new AbortController();
    const result = transcribeWav(
      {
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        model: "fixture-asr",
        language: "",
      },
      wav(),
      controller.signal,
    );
    const reason = new Error("fixture user cancellation");
    setTimeout(() => controller.abort(reason), 30);
    await assert.rejects(result, error => error === reason);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("empty ASR text is a valid silent segment while malformed responses still fail", async () => {
  let result: unknown = { text: "  " };
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain multipart request */ }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "fixture-asr", language: "" };
  try {
    assert.equal(await transcribeWav(config, wav(), new AbortController().signal), "");
    result = { text: 12 };
    await assert.rejects(transcribeWav(config, wav(), new AbortController().signal), /文字格式/);
    result = null;
    await assert.rejects(transcribeWav(config, wav(), new AbortController().signal), /文字格式/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("ASR reports a closed local port clearly without exposing a raw fetch failure", async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await assert.rejects(transcribeWav({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "fixture", language: "zh" }, wav(), new AbortController().signal), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /无法连接语音识别服务/);
    assert.ok(error.message.includes(`http://127.0.0.1:${port}`)); assert.match(error.message, /ECONNREFUSED/);
    assert.ok(!error.message.includes("fetch failed")); return true;
  });
});

test("ASR identifies a server disconnect during the response", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain the fixture upload */ }
    response.writeHead(200, { "content-type": "application/json" }); response.flushHeaders();
    response.write('{"text":"'); response.socket!.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(transcribeWav({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "fixture", language: "" }, wav(), new AbortController().signal), /语音识别连接中断/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("ASR response-body timeout has a separate message from user cancellation", async context => {
  let timeout!: AbortController;
  let respond!: (init: RequestInit) => Response;
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 60_000, "the product timeout remains unchanged");
    return timeout.signal;
  });
  context.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => respond(init!));
  for (const cancelledByUser of [false, true]) {
    timeout = new AbortController();
    const user = new AbortController();
    const reason = cancelledByUser ? new Error("fixture user cancellation") : new DOMException("fixture body timeout", "TimeoutError");
    let started!: () => void;
    const bodyReadStarted = new Promise<void>(resolve => { started = resolve; });
    let response!: Response, combined!: AbortSignal, body!: ReadableStreamDefaultController<Uint8Array>;
    let finishPull: (() => void) | undefined;
    let settled = false, listening = false, aborts = 0;
    const detach = () => {
      if (listening) combined.removeEventListener("abort", onAbort);
      listening = false;
    };
    const endBody = (failure: unknown) => {
      if (settled) return;
      settled = true;
      detach();
      body.error(failure);
      finishPull?.();
    };
    const onAbort = () => { aborts++; endBody(combined.reason); };
    respond = init => {
      assert.ok(init.signal instanceof AbortSignal);
      combined = init.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
          controller.enqueue(new TextEncoder().encode('{"text":"'));
        },
        // No prefetch: this is reached only when the real Response.json()
        // consumer has read the partial JSON and is waiting for the body tail.
        pull() {
          started();
          return new Promise<void>(resolve => { finishPull = resolve; });
        },
        cancel() { settled = true; detach(); finishPull?.(); },
      }, { highWaterMark: 0 });
      response = new Response(stream, { headers: { "content-type": "application/json" } });
      combined.addEventListener("abort", onAbort, { once: true });
      listening = true;
      if (combined.aborted) onAbort();
      return response;
    };
    const result = transcribeWav({ baseUrl: "https://asr.example.test/v1", model: "fixture", language: "" }, wav(), user.signal);
    const rejected = assert.rejects(result, error => {
      if (cancelledByUser) assert.equal(error, reason, "user cancellation keeps its original reason");
      else {
        assert.ok(error instanceof Error);
        assert.match(error.message, /语音识别服务响应超时.*60 秒/);
        assert.ok(error.message.includes("https://asr.example.test"));
        assert.ok(!error.message.includes(reason.message));
      }
      return true;
    });
    try {
      await bodyReadStarted;
      (cancelledByUser ? user : timeout).abort(reason);
      await rejected;
      assert.equal(response.bodyUsed, true);
      assert.notEqual(combined, user.signal);
      assert.notEqual(combined, timeout.signal);
      assert.equal(combined.aborted, true);
      assert.equal(combined.reason, reason);
      assert.equal(timeout.signal.aborted, !cancelledByUser);
      assert.equal(user.signal.aborted, cancelledByUser);
      assert.equal(aborts, 1);
      assert.equal(listening, false, "the body fixture releases its abort listener");
    } finally {
      endBody(new Error("fixture cleanup"));
      await rejected;
    }
  }
});

test("ASR transport messages expose only a known error code and validated URL origin", async context => {
  let code = "CERT_HAS_EXPIRED";
  const secret = "NEVER_EXPOSE_FIXTURE_KEY";
  context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError(`fetch failed ${secret}`, { cause: { code, message: `https://private.example/path?key=${secret}`, headers: { Authorization: secret } } });
  });
  const config = { baseUrl: "https://asr.example.test:9443/private-path", model: "fixture", language: "zh", apiKey: secret };
  for (const candidate of ["CERT_HAS_EXPIRED", "ENOTFOUND", `UNKNOWN_${secret}`]) {
    code = candidate;
    await assert.rejects(transcribeWav(config, wav(), new AbortController().signal), error => {
      assert.ok(error instanceof Error); assert.ok(error.message.includes("https://asr.example.test:9443"));
      for (const forbidden of [secret, "private-path", "private.example", "Authorization", "fetch failed"]) assert.ok(!error.message.includes(forbidden));
      if (candidate === "CERT_HAS_EXPIRED") assert.match(error.message, /HTTPS 证书验证失败.*CERT_HAS_EXPIRED/);
      if (candidate === "ENOTFOUND") assert.match(error.message, /无法解析.*ENOTFOUND/);
      if (candidate.startsWith("UNKNOWN_")) assert.match(error.message, /无法请求语音识别服务/);
      return true;
    });
  }
});

test("ASR preserves HTTP status errors and sanitizes invalid JSON responses", async () => {
  let status = 401;
  const secretBody = "INVALID_JSON_PRIVATE_RESPONSE";
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain the fixture upload */ }
    response.writeHead(status, { "content-type": "application/json" }); response.end(secretBody);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "fixture", language: "" };
  try {
    for (const next of [401, 500, 200]) {
      status = next;
      await assert.rejects(transcribeWav(config, wav(), new AbortController().signal), error => {
        assert.ok(error instanceof Error); assert.ok(!error.message.includes(secretBody));
        assert.match(error.message, next === 200 ? /返回了无效 JSON/ : new RegExp(`HTTP ${next}`)); return true;
      });
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("voice input settings validate URL identity and retain defaults in old profiles", () => {
  assert.throws(() => validateVoiceInput({ baseUrl: "file:///private" }));
  assert.throws(() =>
    validateVoiceInput({ baseUrl: "https://key:secret@example.test/v1" }),
  );
  assert.throws(() =>
    validateVoiceInput({ baseUrl: "https://example.test/v1?secret=key" }),
  );
  const next = { ...DEFAULT_SETTINGS };
  delete next.voiceInput;
  assert.deepEqual(
    validateSettings(next).voiceInput,
    DEFAULT_SETTINGS.voiceInput,
  );
  const previous = {
    baseUrl: "https://original.test/v1",
    model: "a",
    language: "zh",
    apiKey: "private-key",
  };
  assert.equal(
    resolveVoiceInputKey(
      { ...previous, model: "b", apiKey: KEY_SENTINEL },
      previous,
    ).apiKey,
    "private-key",
  );
  assert.equal(
    resolveVoiceInputKey(
      { ...previous, baseUrl: "https://new.test/v1", apiKey: KEY_SENTINEL },
      previous,
    ).apiKey,
    "",
  );
});

test("ASR keys are encrypted, redacted, restored, cleared and never stored plaintext", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "soft-asr-settings-"));
  const secret = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from([...text].reverse().join("")),
    decryptString: (bytes: Buffer) => [...bytes.toString()].reverse().join(""),
  };
  try {
    const store = new SettingsStore(directory, secret, new AssetRegistry());
    await store.load();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.voiceInput!.apiKey = "asr-private-key";
    const publicValue = await store.save(settings);
    assert.equal(publicValue.voiceInput!.apiKey, KEY_SENTINEL);
    const persisted = await readFile(
      path.join(directory, "settings.json"),
      "utf8",
    );
    assert.ok(!persisted.includes("asr-private-key"));
    assert.ok(persisted.includes("voiceInputApiKeyEncrypted"));
    const restored = new SettingsStore(directory, secret, new AssetRegistry());
    await restored.load();
    assert.equal(restored.current.voiceInput!.apiKey, "asr-private-key");
    const same = await restored.save(publicValue);
    assert.equal(restored.current.voiceInput!.apiKey, "asr-private-key");
    same.voiceInput!.baseUrl = "https://changed.test/v1";
    await restored.save(same);
    assert.equal(restored.current.voiceInput!.apiKey, "");
    assert.ok(
      !(await readFile(path.join(directory, "settings.json"), "utf8")).includes(
        "voiceInputApiKeyEncrypted",
      ),
    );
    const unavailable = new SettingsStore(
      directory,
      { ...secret, isEncryptionAvailable: () => false },
      new AssetRegistry(),
    );
    await unavailable.load();
    const missing = structuredClone(DEFAULT_SETTINGS);
    missing.voiceInput!.apiKey = "never-plain";
    await assert.rejects(unavailable.save(missing), /加密/);
    assert.ok(
      !(await readFile(path.join(directory, "settings.json"), "utf8")).includes(
        "never-plain",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
