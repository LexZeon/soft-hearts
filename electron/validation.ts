import { DEFAULT_SETTINGS } from "../shared/defaults";
import { claudeModelOrDefault } from "../shared/claude-model";
import { DEFAULT_TTS_CONFIG } from "../shared/tts";
import { validateTtsConfig } from "./tts";
import { validateUserProfileExpected } from '../shared/user-profile-ui';
import { validPauseTalkCut } from '../shared/behaviors/pause-talk/choose';
import { proactiveTalk } from '../shared/behaviors/inner-rhythm/knobs';
import type {
  AppSettings,
  AssetSaveBaseline,
  ChatRequest,
  ProviderConfig,
  VoiceInputConfig,
  VoiceInputEngine,
} from "../shared/contracts";

const text = (value: unknown, max = 1000): string =>
  typeof value === "string" ? value.slice(0, max) : "";
const finite = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;
/**
 * Chat always goes through the user's own Claude Code (Claude-only edition).
 * - "claude" and the Codex edition's "codex" keep their saved base URL and model,
 *   so the chat-memory scope (companion.ts memoryProviderScope) stays the same.
 * - The retired "openai" / "ollama" kinds (and anything unknown) become a fresh
 *   default Claude connection: their model names mean nothing to Claude Code.
 * No key is read or returned; an old encrypted chat key is left untouched on disk
 * (electron/settings.ts) and never decrypted.
 */
export function validateProvider(value: unknown): ProviderConfig {
  const p = (value && typeof value === "object" ? value : {}) as { kind?: unknown; baseUrl?: unknown; model?: unknown };
  const defaults = DEFAULT_SETTINGS.provider;
  if (p.kind !== "claude" && p.kind !== "codex") return { kind: "claude", baseUrl: defaults.baseUrl, model: "" };
  return {
    kind: "claude",
    baseUrl: text(p.baseUrl, 2000).trim().replace(/\/+$/, "") || defaults.baseUrl,
    model: text(p.model, 200).trim(),
  };
}
/**
 * The R20 task model (`agent.model`, passed to `claude -p --model`). Profiles from the
 * Codex edition or the OpenAI-compatible/Ollama era can still carry their model names
 * (gpt-5-codex, o4-mini, qwen3:8b…), which Claude Code would reject, and there is no
 * longer a field to change them. Anything that is not a Claude model becomes "" (Claude
 * Code's default); the next save writes the cleaned value.
 */
export function validateAgentModel(value: unknown): string {
  return claudeModelOrDefault(text(value, 200));
}
/** An HTTP(S) service base without credentials, query or fragment (speech recognition service). */
export function validateServiceBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("API 地址必须为不含凭据、查询参数的 HTTP(S) 地址。");
  return url.href.replace(/\/+$/, "");
}
export function validateVoiceInput(value: unknown): VoiceInputConfig {
  const input = (
    value && typeof value === "object" ? value : {}
  ) as Partial<VoiceInputConfig>;
  const defaults = DEFAULT_SETTINGS.voiceInput!;
  const baseUrl = validateServiceBaseUrl(text(input.baseUrl, 2000).trim().replace(/\/+$/, "") || defaults.baseUrl);
  return {
    baseUrl,
    model: text(input.model === undefined ? defaults.model : input.model, 200).trim(),
    language:
      input.language === undefined
        ? defaults.language
        : text(input.language, 30).trim(),
    apiKey: text(input.apiKey, 2000),
    engine: voiceInputEngine(input.engine, baseUrl),
  };
}
/**
 * 识别方式. A setting saved before it existed has no engine: if its address is still the
 * shipped default (nothing ran there — "现在语音输入输入不了"), it moves to the app's own local recognizer; an address
 * the user changed keeps the compatible interface. Nothing else in the setting changes.
 */
export function voiceInputEngine(value: unknown, baseUrl: string): VoiceInputEngine {
  if (value === 'local' || value === 'compatible') return value;
  return baseUrl === validateServiceBaseUrl(DEFAULT_SETTINGS.voiceInput!.baseUrl) ? 'local' : 'compatible';
}
/** R29f: settings.json version written from now on. */
export const SETTINGS_VERSION = 2;
/**
 * R29f, once per file: a version-1 settings file whose render rate is still the old default 30 moves to the new
 * default 60. Run on a stored file only (SettingsStore.load), never on a save: a 30 or 24 the user picks later is
 * saved as version 2 and kept. Returns a copy when it changes something.
 */
export function migrateStoredSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.version === 'number' ? raw.version : 0;
  const pet = raw.pet as Record<string, unknown> | undefined;
  if (version >= SETTINGS_VERSION || !pet || typeof pet !== 'object' || pet.fps !== 30) return raw;
  return { ...raw, pet: { ...pet, fps: 60 } };
}
export function validateSettings(
  value: unknown,
  previous: AppSettings = DEFAULT_SETTINGS,
): AppSettings {
  if (!value || typeof value !== "object") throw new Error("设置格式不正确。");
  const s = value as AppSettings;
  const d = DEFAULT_SETTINGS;
  const size = s.pet?.size ?? (s.pet?.scale === previous.pet.scale ? previous.pet.size : undefined);
  return {
    version: SETTINGS_VERSION,
    // File access is granted by a native picker, never by arbitrary renderer paths.
    model: s.model === null ? null : previous.model,
    motion: s.motion === null ? null : previous.motion,
    ...(previous.motionLayers ? { motionLayers: {
      gesture: s.motionLayers?.gesture === null ? null : previous.motionLayers.gesture,
      expression: s.motionLayers?.expression === null ? null : previous.motionLayers.expression,
    } } : {}),
    camera: {
      yaw: finite(s.camera?.yaw, d.camera.yaw, -180, 180),
      pitch: finite(s.camera?.pitch, d.camera.pitch, -80, 80),
      distance: finite(s.camera?.distance, d.camera.distance, 1, 500),
      targetY: finite(s.camera?.targetY, d.camera.targetY, -1000, 1000),
      targetX: finite(s.camera?.targetX, d.camera.targetX, -1000, 1000),
      targetZ: finite(s.camera?.targetZ, 0, -1000, 1000),
      fov: finite(s.camera?.fov, d.camera.fov, 12, 80),
    },
    provider: validateProvider(s.provider),
    persona: text(s.persona, 12000),
    pet: {
      visible: bool(s.pet?.visible, d.pet.visible),
      alwaysOnTop: bool(s.pet?.alwaysOnTop, d.pet.alwaysOnTop),
      clickThrough: bool(s.pet?.clickThrough, d.pet.clickThrough),
      followMouse: bool(s.pet?.followMouse, d.pet.followMouse),
      fps: [24, 30, 60].includes(s.pet?.fps) ? s.pet.fps : d.pet.fps,
      breath: finite(s.pet?.breath, d.pet.breath, 0, 1),
      scale: finite(s.pet?.scale, 1, 0.5, 2),
      ...(size ? { size: {
        width: Math.round(finite(size.width, 400, 200, 4096)),
        height: Math.round(finite(size.height, 560, 200, 4096)),
      } } : {}),
    },
    voice: {
      enabled: bool(s.voice?.enabled, d.voice.enabled),
      voiceURI: text(s.voice?.voiceURI, 500),
      rate: finite(s.voice?.rate, 1, 0.5, 2),
      volume: finite(s.voice?.volume, 0.8, 0, 1),
      moodInfluence: Math.round(finite(s.voice?.moodInfluence, d.voice.moodInfluence ?? 50, 0, 100)),
      firstChunk: s.voice?.firstChunk === 'comma' ? 'comma' : 'sentence', // I-029: anything else is the whole-sentence default
      ...(s.voice?.pauseTalk === true ? { pauseTalk: true } : {}), // F7 停停说说: only an explicit true turns it on; off is absent
    },
    voiceInput: validateVoiceInput(
      s.voiceInput ?? previous.voiceInput ?? d.voiceInput,
    ),
    ...(s.tts !== undefined || previous.tts !== undefined
      ? { tts: validateTtsConfig(s.tts ?? previous.tts ?? DEFAULT_TTS_CONFIG) } : {}),
    agent: {
      workingDirectory: previous.agent.workingDirectory,
      model: validateAgentModel(s.agent?.model),
      writable: bool(s.agent?.writable, false),
    },
    // An older settings file has no such key: it gets the default (on).
    innerLoop: bool(s.innerLoop, d.innerLoop),
    // 她主动找你说话: an older file has none (适中); anything unknown reads as 适中.
    proactiveTalk: proactiveTalk(s.proactiveTalk),
    // 体验记录: off unless the stored file says on (the control window's save never changes it, electron/main.ts).
    experienceJournal: s.experienceJournal === true,
  };
}
export function validateAssetBaseline(value: unknown): AssetSaveBaseline {
  const record = value as Record<string, unknown> | null;
  const validPath = (item: unknown) => item === null || (typeof item === "string" && item.length <= 32768);
  const layers = record?.motionLayers as Record<string, unknown> | undefined;
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).some(key => !["model", "motion", "motionLayers"].includes(key))
    || !validPath(record.model) || !validPath(record.motion)
    || (layers !== undefined && (!layers || typeof layers !== "object" || Array.isArray(layers)
      || Object.keys(layers).some(key => key !== "gesture" && key !== "expression")
      || !validPath(layers.gesture) || !validPath(layers.expression))))
    throw new Error("资源保存基线格式不正确。");
  return record as unknown as AssetSaveBaseline;
}

/** A late whole-settings save must not clear a newer native/host asset selection. */
export function preserveStaleAssetClears(next: AppSettings, current: AppSettings, baseline: AssetSaveBaseline): void {
  for (const kind of ["model", "motion"] as const) {
    if (next[kind] === null && baseline[kind] !== (current[kind]?.path ?? null)) next[kind] = current[kind];
  }
  if (!current.motionLayers || !next.motionLayers) return;
  for (const layer of ["gesture", "expression"] as const) {
    // Legacy saves lack a layer baseline; their nulls cannot clear later layer selections.
    if (next.motionLayers[layer] === null
      && baseline.motionLayers?.[layer] !== (current.motionLayers[layer]?.path ?? null))
      next.motionLayers[layer] = current.motionLayers[layer];
  }
}
export function validateChatRequest(value: unknown): ChatRequest {
  if (!value || typeof value !== "object")
    throw new Error("聊天请求格式不正确。");
  const r = value as ChatRequest;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(r.id)) throw new Error("请求编号不正确。");
  if (
    !Array.isArray(r.messages) ||
    !r.messages.length ||
    r.messages.length > 200
  )
    throw new Error("聊天记录格式不正确。");
  const currentUser = r.messages.at(-1);
  if (typeof currentUser?.content === 'string' && currentUser.content.length > 16000)
    throw new Error('这条消息超过 16000 字符，请缩短或分开发送；本次没有发送，避免丢失末尾要求。');
  let removedUser = r.messages.slice(0, -24).some(m => m?.role === 'user');
  const messages = r.messages.slice(-24).map((m) => {
    if (
      !m ||
      !["user", "assistant"].includes(m.role) ||
      typeof m.content !== "string"
    )
      throw new Error("消息格式不正确。");
    let content = m.content;
    if (content.length > 16000) {
      // Preserve a long historical reply's setup and continuation point, with
      // an explicit omission instead of passing its cut prefix as the full text.
      const note = '（此条旧消息较长，中段已省略；保留开头与结尾，仅作历史资料。）\n';
      const gap = '\n[历史中段省略]\n';
      const head = content.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, '');
      const tail = content.slice(-(16000 - note.length - gap.length - head.length)).replace(/^[\uDC00-\uDFFF]/, '');
      content = note + head + gap + tail;
    }
    return { role: m.role, content };
  });
  if (messages.at(-1)?.role !== "user")
    throw new Error("最后一条消息必须来自用户。");
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  while (total > 48000 && messages.length > 1) {
    const removed = messages.shift()!;
    total -= removed.content.length;
    if (removed.role === 'user') removedUser = true;
  }
  // Do not keep answers to an evicted user. Uncut greetings and consecutive
  // roles are valid; this is only a boundary repair after actual eviction.
  if (removedUser) {
    while (messages.length > 1 && messages[0].role === 'assistant') messages.shift();
  }
  const attachments = Array.isArray(r.attachments)
    ? r.attachments.slice(0, 2).map((a) => {
        if (
          !a ||
          !["screen", "camera"].includes(a.source) ||
          typeof a.dataUrl !== "string" ||
          !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
            a.dataUrl,
          ) ||
          a.dataUrl.length > 4_000_000
        )
          throw new Error("图片附件不正确或超过 3 MB。");
        // 帧的来源: a shared frame's ticket goes on for the chat handler to check (electron/look-attachments.ts admit); one that is
        // not a short string becomes "" and so matches nothing: the frame is dropped, never passed as the user's own snapshot.
        const ticket = (a as { shareTicket?: unknown }).shareTicket;
        return { source: a.source, dataUrl: a.dataUrl,
          ...(ticket !== undefined ? { shareTicket: typeof ticket === 'string' && ticket.length <= 100 ? ticket : '' } : {}) };
      })
    : [];
  const profileField = Object.getOwnPropertyDescriptor(value, 'profile');
  if (profileField && !Object.hasOwn(profileField, 'value')) throw new Error('用户画像消息范围不正确。');
  const profile = validateUserProfileExpected(profileField?.value);
  // Timing metadata only (developer latency log); never authority, ordering or content.
  const sentAt = typeof r.sentAt === 'number' && Number.isSafeInteger(r.sentAt) && r.sentAt > 0 ? r.sentAt : undefined;
  // F7 停停说说: an id and a count only (a malformed one is simply absent); the host reads the text from its own copy.
  const pauseCut = validPauseTalkCut(r.pauseCut);
  return { id: r.id, messages, attachments, ...(profile ? { profile } : {}), ...(sentAt !== undefined ? { sentAt } : {}), ...(pauseCut ? { pauseCut } : {}) };
}
