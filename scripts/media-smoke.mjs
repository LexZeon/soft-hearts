import { _electron as electron } from "playwright";
import { navigateControlPage } from "./lib/control-navigation.mjs";
import { createClaudeFixture } from "./lib/claude-smoke-fixture.mjs";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

// Source or packaged E2E: all profiles, devices, audio and images are synthetic.
// Never use the user's profile, real camera/microphone, screen pixels or services.
const output = path.resolve(".local/media-smoke");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "soft-media-e2e-"));
const profile = path.join(temporary, "profile");
const executable = process.env.MMD_TEST_EXE ? path.resolve(process.env.MMD_TEST_EXE) : null;
await mkdir(profile);
const wavPath = path.join(temporary, "original-fake-microphone.wav");
function originalWav() {
  const rate = 16000,
    duration = 15;
  const wav = Buffer.alloc(44 + rate * duration * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let sample = 0; sample < rate * 0.9; sample++) {
    const time = sample / rate;
    const value =
      0.22 * Math.sin(2 * Math.PI * 220 * time) +
      0.16 * Math.sin(2 * Math.PI * 997 * time);
    wav.writeInt16LE(Math.round(value * 32767), 44 + sample * 2);
  }
  return wav;
}
await writeFile(wavPath, originalWav());
const chats = [];
const chatConnections = [];
const transcriptions = [];
const checks = [];
const errors = [];
let holdAsr = false;
let instance, controls, pet;
let packaged = null;
let report;
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (request.url === "/v1/audio/transcriptions") {
      const form = await new Request("http://fixture/audio", {
        method: "POST",
        headers: request.headers,
        body,
      }).formData();
      const file = form.get("file");
      assert.ok(file && typeof file.arrayBuffer === "function");
      const wav = Buffer.from(await file.arrayBuffer());
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.readUInt32LE(24), 16000);
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt16LE(34), 16);
      assert.ok(wav.length > 8044 && wav.length <= 640044);
      assert.equal(form.get("model"), "fixture-asr");
      const record = { bytes: wav.length, completed: false, aborted: false };
      transcriptions.push(record);
      response.on("close", () => {
        record.aborted = !record.completed;
      });
      const finish = () => {
        record.completed = true;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            text: holdAsr ? "STALE_VOICE_NEVER_SEND" : "VOICE_FIXTURE_INPUT",
          }),
        );
      };
      if (holdAsr) {
        const timer = setTimeout(finish, 10000);
        response.on("close", () => clearTimeout(timer));
      } else finish();
      return;
    }
    // Chat no longer uses HTTP: it goes to the synthetic Claude Code below.
    response.writeHead(404).end();
  } catch (error) {
    errors.push(`mock: ${error.message}`);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs). Each record keeps a Chat
// Completions-style view so the checks below read the same: images become image_url parts of the user message.
// A persistent session's follow-up carries only unseen history; `spawn`/`opening` show session reuse.
const claude = await createClaudeFixture({
  root: temporary,
  respond: (turn) => {
    const text = turn.currentUser;
    chats.push({
      spawn: turn.spawn,
      opening: turn.opening,
      messages: [
        ...turn.messages.slice(0, -1),
        {
          role: "user",
          content: turn.images.length
            ? [{ type: "text", text }, ...turn.images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } }))]
            : text,
        },
      ],
    });
    const connection = { text, completed: false, aborted: false };
    chatConnections.push(connection);
    turn.delta("REPLY:");
    const timer = setTimeout(
      () => {
        connection.completed = true;
        turn.reply(text);
      },
      text === "WAIT_CROSS_WINDOW_STOP" ? 10000 : 500,
    );
    turn.onCancel(() => {
      clearTimeout(timer);
      connection.aborted = !connection.completed;
    });
  },
});
await writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({
    version: 1,
    model: null,
    motion: null,
    provider: claude.provider,
    voiceInput: { baseUrl, model: "fixture-asr", language: "zh", apiKey: "" },
    persona: "Synthetic local test companion.",
    pet: {
      visible: true,
      clickThrough: false,
      scale: 1,
      followMouse: false,
      fps: 24,
    },
    voice: { enabled: false, rate: 1, volume: 0 },
  }),
);

async function waitFor(condition, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function petClick(selector) {
  await pet.bringToFront();
  await pet.locator(selector).focus();
  await pet.locator(selector).click();
}
async function send(page, text) {
  await page.bringToFront();
  await page.locator("#chat-input").focus();
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-input").press("Enter");
}
async function replyBoth(text) {
  await controls.waitForFunction(
    (expected) =>
      [...document.querySelectorAll(".message.assistant .message-body")].at(-1)
        ?.textContent === expected,
    `REPLY:${text}`,
    { polling: 100 },
  );
  await pet.waitForFunction(
    (expected) =>
      document.getElementById("pet-answer-body")?.textContent === expected,
    `REPLY:${text}`,
    { polling: 100 },
  );
  await pet.waitForFunction(
    () => !document.getElementById("send-chat").classList.contains("hidden"),
    undefined,
    { polling: 100 },
  );
}
async function runtime(page = pet) {
  return page.evaluate(() => window.desktop.getRuntimeState());
}
try {
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MMD_TEST_EXE;
  instance = await electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [
      ...(executable ? [`--user-data-dir=${profile}`] : ["."]),
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
    env,
    timeout: 30000,
  });
  await claude.install(instance);
  await instance.firstWindow();
  const identity = await instance.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    profile: app.getPath("userData"),
  }));
  packaged = identity.packaged;
  assert.deepEqual(identity, { packaged: !!executable, profile });
  await waitFor(() => {
    controls = instance
      .windows()
      .find(
        (page) =>
          page.url().includes("index.html") &&
          !new URL(page.url()).searchParams.has("pet"),
      );
    pet = instance
      .windows()
      .find(
        (page) =>
          page.url().includes("index.html") &&
          new URL(page.url()).searchParams.has("pet"),
      );
    return controls && pet;
  }, "both app windows");
  for (const [kind, page] of [
    ["controls", controls],
    ["pet", pet],
  ]) {
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => errors.push(`${kind}: ${error.message}`));
    await page.waitForSelector("#chat-input");
    await page.waitForFunction(() => !!window.desktop?.getRuntimeState);
  }
  await controls.waitForSelector("#runtime-voice", { state: "attached" });
  await pet.waitForSelector("#pet-move-window", { state: "attached" });
  await instance.evaluate(({ desktopCapturer, nativeImage, screen }) => {
    globalThis.__fixtureScreenCaptures = 0;
    desktopCapturer.getSources = async () => {
      globalThis.__fixtureScreenCaptures++;
      const bytes = Buffer.alloc(32 * 32 * 4);
      for (let index = 0; index < bytes.length; index += 4) {
        bytes[index + 1] = 255;
        bytes[index + 3] = 255;
      }
      return [
        {
          id: "screen:fixture:0",
          name: "Original synthetic screen",
          display_id: String(screen.getPrimaryDisplay().id),
          thumbnail: nativeImage.createFromBitmap(bytes, {
            width: 32,
            height: 32,
          }),
          appIcon: null,
        },
      ];
    };
  });
  assert.deepEqual(await runtime(), {
    voiceInput: false,
    screenSharing: false,
    cameraSharing: false,
    voiceOwner: null,
    cameraOwner: null,
  });
  assert.deepEqual(
    await pet.evaluate(() => window.desktop.sharedAttachments()),
    [],
  );
  check(`isolated ${packaged ? "packaged" : "source"} profile and all media off on startup`);

  await send(pet, "FROM_PET");
  await controls.waitForFunction(
    () =>
      document.querySelector(".message.assistant .message-body")
        ?.textContent === "REPLY:",
  );
  await replyBoth("FROM_PET");
  // The pet keeps only shared text state; a separate lightweight native window
  // displays the reply beyond the model viewport instead of covering its face.
  await waitFor(() => instance.windows().some(page => page.url().endsWith('#soft-hearts-reply')), 'native reply window');
  const replyWindow = instance.windows().find(page => page.url().endsWith('#soft-hearts-reply'));
  assert.equal(await replyWindow.evaluate(() => typeof window.desktop), 'undefined');
  assert.equal(await pet.locator('#pet-answer').evaluate(node => node.classList.contains('hidden')), true);
  // This fixture deliberately has no MMD model/face anchor. Native mouth layout
  // and visible tail are covered with public Gene by reply-smoke.mjs.
  check("pet input streams to both windows and uses a separate isolated reply surface");
  await send(controls, "FROM_CONTROLS");
  await replyBoth("FROM_CONTROLS");
  assert.equal(chats.length, 2);
  // One shared conversation: the second turn either carries FROM_PET as history or continues the same
  // Claude Code session that already received it.
  assert.ok(
    chats[1].messages.some(
      (message) => message.role === "user" && message.content === "FROM_PET",
    ) || (chats[1].opening === false && chats[1].spawn === chats[0].spawn),
  );
  check(
    "controls input updates pet bubble and retains one shared conversation",
  );

  await petClick("#pet-screen-sharing");
  await waitFor(
    async () => (await runtime()).screenSharing,
    "screen toggle on",
  );
  assert.equal(
    await instance.evaluate(() => globalThis.__fixtureScreenCaptures),
    0,
  );
  // 识图第 1 步: an ordinary message carries no frame; asking her to look carries one (scripts/look-smoke.mjs covers the rest).
  await send(pet, "ORDINARY_WITH_SHARING");
  await replyBoth("ORDINARY_WITH_SHARING");
  assert.equal(typeof chats.at(-1).messages.at(-1).content, "string");
  assert.equal(
    await instance.evaluate(() => globalThis.__fixtureScreenCaptures),
    0,
  );
  await send(pet, "你看看我屏幕SYNTHETIC_SCREEN");
  await replyBoth("你看看我屏幕SYNTHETIC_SCREEN");
  assert.equal(
    chats
      .at(-1)
      .messages.at(-1)
      .content.filter((item) => item.type === "image_url").length,
    1,
  );
  assert.equal(
    await instance.evaluate(() => globalThis.__fixtureScreenCaptures),
    1,
  );
  await petClick("#pet-screen-sharing");
  await waitFor(
    async () => !(await runtime()).screenSharing,
    "screen toggle off",
  );
  assert.deepEqual(
    await pet.evaluate(() => window.desktop.sharedAttachments()),
    [],
  );
  check("screen sharing captures only when she is asked to look, and clears on disable");

  await petClick("#pet-camera-sharing"); // I-036: expands the two switches
  await petClick('#pet-camera-panel [data-camera-switch="cameraImages"]');
  await waitFor(
    async () => (await runtime()).cameraOwner === "pet",
    "pet camera ownership",
  );
  await waitFor(
    async () =>
      (await pet.evaluate(() => window.desktop.sharedAttachments({ text: "你看看我" }))).some(
        (item) => item.source === "camera",
      ),
    "fake camera frame",
  );
  await send(pet, "你看看我SYNTHETIC_CAMERA");
  await replyBoth("你看看我SYNTHETIC_CAMERA");
  const cameraImage = chats
    .at(-1)
    .messages.at(-1)
    .content.find((item) => item.type === "image_url").image_url.url;
  assert.match(cameraImage, /^data:image\/jpeg;base64,/);
  await controls.evaluate(() =>
    window.desktop.setRuntimeState({ cameraSharing: true }),
  );
  await waitFor(
    async () => (await runtime()).cameraOwner === "controls",
    "camera ownership transfer",
  );
  await assert.rejects(
    pet.evaluate(() =>
      window.desktop.publishCameraFrame("data:image/jpeg;base64,aGVsbG8="),
    ),
    /未开启|未授权/,
  );
  await controls.evaluate(() =>
    window.desktop.setRuntimeState({ cameraSharing: false }),
  );
  await waitFor(async () => !(await runtime()).cameraSharing, "camera off");
  assert.deepEqual(
    await pet.evaluate(() => window.desktop.sharedAttachments()),
    [],
  );
  check(
    "fake camera JPEG reaches chat, owner transfer revokes old publisher, off clears frames",
  );

  await send(controls, "TEXT_AFTER_SHARING_OFF");
  await replyBoth("TEXT_AFTER_SHARING_OFF");
  assert.equal(typeof chats.at(-1).messages.at(-1).content, "string");
  assert.equal(
    chats.at(-1).messages.filter((message) => message.role === "user").length,
    1,
  );
  check("sharing off removes old image and visual conversation context");

  await send(controls, "WAIT_CROSS_WINDOW_STOP");
  await pet.waitForFunction(
    () => document.getElementById("pet-answer-body")?.textContent === "REPLY:",
  );
  await petClick("#stop-chat");
  await waitFor(
    () => chatConnections.at(-1).aborted,
    "cross-window chat cancellation",
  );
  for (const page of [controls, pet]) {
    await page.waitForFunction(
      () => !document.getElementById("send-chat").classList.contains("hidden"),
    );
    assert.doesNotMatch(
      await page.locator("#toast").textContent(),
      /此任务属于另一个窗口/,
    );
  }
  check("pet stop cancels a controls-owned chat without an ownership error");

  const beforeRace = chats.length;
  await Promise.all([
    controls.evaluate(() => {
      document.getElementById("chat-input").value = "RACE_CONTROLS";
      document.getElementById("chat-form").requestSubmit();
    }),
    pet.evaluate(() => {
      document.getElementById("chat-input").value = "RACE_PET";
      document.getElementById("chat-form").requestSubmit();
    }),
  ]);
  await waitFor(
    () => chats.length > beforeRace,
    "simultaneous submission accepted",
  );
  const accepted = chats.at(-1).messages.at(-1).content;
  assert.ok(["RACE_CONTROLS", "RACE_PET"].includes(accepted));
  await replyBoth(accepted);
  assert.equal(chats.length, beforeRace + 1);
  for (const page of [controls, pet])
    await page.waitForFunction(
      () => !document.getElementById("send-chat").classList.contains("hidden"),
    );
  check(
    "simultaneous submissions yield one host-accepted conversation and both windows recover",
  );

  await pet.evaluate(() => {
    const node = document.getElementById("pet-voice-state");
    if (!node) throw new Error("Missing visible voice status");
    globalThis.__fixtureVoiceStates = [];
    const observer = new MutationObserver(() => {
      globalThis.__fixtureVoiceStates.push({
        text: node.textContent,
        hidden: node.classList.contains("hidden"),
      });
    });
    observer.observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    globalThis.__fixtureVoiceObserver = observer;
  });
  await petClick("#pet-voice-input");
  await waitFor(
    async () => (await runtime()).voiceOwner === "pet",
    "pet microphone ownership",
  );
  await instance.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().includes("index.html") && !new URL(win.webContents.getURL()).searchParams.has("pet"))
      ?.hide(),
  );
  assert.equal((await runtime()).voiceInput, true);
  await waitFor(
    () => transcriptions.length > 0,
    "fake microphone VAD to ASR",
    20000,
  );
  await replyBoth("VOICE_FIXTURE_INPUT");
  const statuses = await pet.evaluate(() => globalThis.__fixtureVoiceStates);
  for (const pattern of [/聆听/, /检测到声音/, /正在转写/])
    assert.ok(
      statuses.some((status) => pattern.test(status.text) && !status.hidden),
      `Visible voice state missing: ${pattern}`,
    );
  await petClick("#pet-voice-input");
  await waitFor(async () => !(await runtime()).voiceInput, "voice off");
  await pet.waitForFunction(
    () => {
      const node = document.getElementById("pet-voice-state");
      return node.textContent === "" && node.classList.contains("hidden");
    },
    undefined,
    { polling: 100 },
  );
  assert.equal(transcriptions.length, 1);
  check(
    "fake microphone passes VAD, 16k mono WAV ASR and automatic desktop chat",
  );
  check(
    "voice status visibly reports listening, detected sound and transcription, then clears when off",
  );

  await instance.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().includes("index.html") && !new URL(win.webContents.getURL()).searchParams.has("pet"))
      ?.show(),
  );
  await navigateControlPage(controls, "privacy");
  holdAsr = true;
  await controls.locator("#runtime-voice").check();
  await waitFor(
    async () => (await runtime()).voiceOwner === "controls",
    "controls microphone ownership",
  );
  await waitFor(() => transcriptions.length > 1, "second ASR begins", 20000);
  const count = chats.length;
  await controls.locator("#runtime-voice").uncheck();
  await waitFor(() => transcriptions[1].aborted, "in-flight ASR aborted");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(chats.length, count);
  assert.equal((await runtime()).voiceOwner, null);
  await assert.rejects(
    pet.evaluate(() => window.desktop.transcribeAudio(new ArrayBuffer(44))),
    /未开启|已停止/,
  );
  check("microphone off aborts pending ASR and never auto-sends stale text");

  const saved = JSON.parse(
    await readFile(path.join(profile, "settings.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(saved, "runtime"), false);
  assert.equal(Object.hasOwn(saved, "screenSharing"), false);
  assert.deepEqual(errors, []);
  claude.assertClean();
  report = {
    status: "PASS",
    packaged,
    checks,
    chatRequests: chats.length,
    asrRequests: transcriptions.length,
    mockOnly: true,
    fakeDevices: true,
    privateProfileUsed: false,
    modelLoaded: false,
    errors,
  };
  console.log(JSON.stringify(report));
} catch (error) {
  report = {
    status: "FAIL",
    packaged,
    checks,
    error: String(error),
    errors,
    chatRequests: chats.length,
    asrRequests: transcriptions.length,
    syntheticChatConnections: chatConnections,
    syntheticTranscriptions: transcriptions,
    runtime: pet ? await runtime().catch(() => null) : null,
    windowStates: await Promise.all(
      [
        ["controls", controls],
        ["pet", pet],
      ].map(async ([kind, page]) => ({
        kind,
        state: page
          ? await page
              .evaluate(() => ({
                reply:
                  document.querySelector("#pet-answer-body")?.textContent ??
                  [
                    ...document.querySelectorAll(
                      ".message.assistant .message-body",
                    ),
                  ].at(-1)?.textContent,
                chat: document.querySelector("#chat-state")?.textContent,
                input: document.querySelector("#chat-input")?.value,
              }))
              .catch(() => null)
          : null,
      })),
    ),
  };
  for (const [label, page] of [
    ["controls", controls],
    ["pet", pet],
  ])
    if (page)
      await page
        .screenshot({ path: path.join(output, `failure-${label}.png`) })
        .catch(() => {});
  console.error(JSON.stringify(report));
  throw error;
} finally {
  await instance?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const fakeClaude = await claude.close();
  if (report) report.fakeClaude = fakeClaude;
  const resolvedTemporary = path.resolve(temporary);
  assert.equal(path.dirname(resolvedTemporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolvedTemporary).startsWith('soft-media-e2e-'));
  await rm(resolvedTemporary, { recursive: true, force: true });
  if (report)
    await writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
}
