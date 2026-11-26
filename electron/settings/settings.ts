import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppSettings,
  AssetRef,
  VoiceInputConfig,
} from "../../shared/foundation/settings";
import { DEFAULT_SETTINGS } from "../../shared/foundation/defaults";
import { AssetRegistry } from "../foundation/assets";
import { migrateStoredSettings, validateSettings } from "./validation";
import { keepMemoryPin, storedMemoryPin, withStoredMemoryPin } from "./memory-pin";
import { resolveTtsKey } from "../voice";
import { atomicWriteFile, type AtomicFileWriter } from '../foundation/atomic-file';
import { KeptFields, splitUnknownFields, type KnownFields } from '../foundation/unknown-fields';

export const KEY_SENTINEL = "••••••••";
/**
 * Every settings.json field this version knows (docs/claude/2026-11-04-keep-unknown-fields.md); anything else a newer
 * version wrote is kept aside and written back, never used. A field listed here is read only by validateSettings and the
 * key handling below, exactly as before: the key ciphertexts and the plaintext key fields a validator drops stay dropped.
 * Add a new field here together with validateSettings (tests/keep-unknown-fields.test.ts checks every field it writes);
 * a field that is retired stays listed, so older files do not keep it forever. Asset references are whole values: their
 * own unknown parts would otherwise follow a different model or motion.
 */
export const SETTINGS_KNOWN_FIELDS: KnownFields = {
  version: true, model: true, motion: true, motionLayers: true,
  camera: { yaw: true, pitch: true, distance: true, targetY: true, targetX: true, targetZ: true, fov: true },
  provider: { kind: true, baseUrl: true, model: true, memoryModel: true, apiKey: true },
  persona: true,
  pet: { visible: true, alwaysOnTop: true, clickThrough: true, followMouse: true, fps: true, breath: true, scale: true,
    size: { width: true, height: true } },
  voice: { enabled: true, voiceURI: true, rate: true, volume: true, moodInfluence: true, firstChunk: true, pauseTalk: true },
  voiceInput: { baseUrl: true, model: true, language: true, apiKey: true, engine: true },
  tts: { provider: true, apiHost: true, region: true, model: true, voice: true, instruction: true, emotion: true, rate: true,
    apiKey: true, introduced: true, styleBindings: true, fishApiKey: true, fishVoiceId: true, fishMonthlyCapUsd: true },
  agent: { workingDirectory: true, model: true, writable: true },
  innerLoop: true, proactiveTalk: true, selfLook: true, experienceJournal: true, crisisRegion: true,
  apiKeyEncrypted: true, voiceInputApiKeyEncrypted: true, ttsApiKeyEncrypted: true, ttsFishApiKeyEncrypted: true,
  // Retired: the oldest profiles' persona, read once into the first card (electron/cards/gene-preinstalled-card.ts).
  systemPrompt: true,
};
export function resolveVoiceInputKey(
  next: VoiceInputConfig,
  previous?: VoiceInputConfig,
): VoiceInputConfig {
  if (next.apiKey !== KEY_SENTINEL) return next;
  return {
    ...next,
    apiKey: next.baseUrl === previous?.baseUrl ? previous.apiKey : "",
  };
}
export interface SecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export const publicSettings = (settings: AppSettings): AppSettings => ({
  ...structuredClone(settings),
  ...(settings.voiceInput
    ? {
        voiceInput: {
          ...settings.voiceInput,
          apiKey: settings.voiceInput.apiKey ? KEY_SENTINEL : "",
        },
      }
    : {}),
  ...(settings.tts ? { tts: {
    ...structuredClone(settings.tts),
    apiKey: settings.tts.apiKey ? KEY_SENTINEL : "",
    // I-070: the Drama 3 key is redacted the same way; windows and the internal channel only learn that one is saved.
    fishApiKey: settings.tts.fishApiKey && settings.tts.fishApiKey !== KEY_SENTINEL ? KEY_SENTINEL : "",
  } } : {}),
});

export class SettingsStore {
  current = structuredClone(DEFAULT_SETTINGS);
  /** Ciphertext of the retired chat-provider key, written back unchanged (see load()). */
  private retiredChatKey: string | undefined;
  /** What a newer version wrote that this one does not know: written back by persist(), never read (unknown-fields.ts). */
  private kept = KeptFields.none;
  /**
   * 2026-11-26 (docs/claude/2026-11-26-update-blank-card.md): set by the bundled assets' start (electron/wiring/actions-wiring.ts) before
   * load(). Asked only when the saved stage model cannot be read: this install's copy of the same preinstalled model, or null (the stage
   * stays empty as before). A readable path and a user's own model are never replaced. settings.json is not rewritten here.
   */
  relocateUnreadableModel?: (storedPath: string) => Promise<AssetRef | null>;
  constructor(
    readonly directory: string,
    private secret: SecretStorage,
    readonly assets: AssetRegistry,
    private readonly writeAtomic: AtomicFileWriter = atomicWriteFile,
    private readonly log?: (line: string) => void,
  ) {}
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.kept = KeptFields.none;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(
        await readFile(path.join(this.directory, "settings.json"), "utf8"),
      );
    } catch {
      return;
    }
    // The retired OpenAI-compatible/Ollama chat key: kept byte-for-byte, never decrypted or used.
    this.retiredChatKey = typeof raw.apiKeyEncrypted === "string" ? raw.apiKeyEncrypted : undefined;
    try {
      // R29f: a version-1 file on the old default 30 fps moves to 60 once (validation.ts).
      const persisted = migrateStoredSettings(raw) as unknown as AppSettings;
      const previous = structuredClone(DEFAULT_SETTINGS);
      // I-222: where her memory is filed: the stored pin, or (a file from before 0.2.0) the model it is filed under today (memory-pin.ts).
      const pin = storedMemoryPin(persisted.provider);
      previous.provider.memoryModel = pin.model;
      if (typeof persisted.agent?.workingDirectory === "string")
        previous.agent.workingDirectory = persisted.agent.workingDirectory;
      for (const kind of ["model", "motion"] as const) {
        if (typeof persisted[kind]?.path === "string") {
          try {
            previous[kind] = await this.assets.register(persisted[kind]!.path);
          } catch {
            /* Moved or deleted local assets are not fatal. */
            if (kind === "model") previous.model = await this.relocateUnreadableModel?.(persisted.model!.path).catch(() => null) ?? null;
          }
        }
      }
      if (persisted.motionLayers && typeof persisted.motionLayers === "object") {
        previous.motionLayers = { gesture: null, expression: null };
        for (const layer of ["gesture", "expression"] as const) {
          const file = persisted.motionLayers[layer]?.path;
          if (typeof file !== "string" || path.extname(file).toLowerCase() !== ".vmd") continue;
          try {
            previous.motionLayers[layer] = await this.assets.register(file);
          } catch {
            /* Missing overlays clear only their own channel. */
          }
        }
      }
      this.current = validateSettings(persisted, previous);
      if (this.current.voiceInput) {
        this.current.voiceInput.apiKey = "";
        if (
          typeof raw.voiceInputApiKeyEncrypted === "string" &&
          this.secret.isEncryptionAvailable()
        ) {
          try {
            this.current.voiceInput.apiKey = this.secret.decryptString(
              Buffer.from(raw.voiceInputApiKeyEncrypted, "base64"),
            );
          } catch {
            /* A moved profile can no longer decrypt its key. */
          }
        }
      }
      if (this.current.tts) {
        // A legacy or manually edited plaintext field never becomes a fallback key.
        this.current.tts.apiKey = "";
        if (typeof raw.ttsApiKeyEncrypted === "string" && this.secret.isEncryptionAvailable()) {
          try {
            this.current.tts.apiKey = this.secret.decryptString(Buffer.from(raw.ttsApiKeyEncrypted, "base64"));
          } catch {
            /* A moved profile cannot decrypt its former machine's key. */
          }
        }
        // I-070: the Drama 3 key has its own ciphertext; a plaintext field in the file is never used.
        this.current.tts.fishApiKey = "";
        if (typeof raw.ttsFishApiKeyEncrypted === "string" && this.secret.isEncryptionAvailable()) {
          try {
            this.current.tts.fishApiKey = this.secret.decryptString(Buffer.from(raw.ttsFishApiKeyEncrypted, "base64"));
          } catch {
            /* Same: a moved profile cannot decrypt it. */
          }
        }
      }
      // Click-through keeps the saved choice across launches (穿透模式默认开启 — on by default, shared/foundation/defaults.ts).
      // Resuming it is safe: her body and the visible controls stay clickable (src/stage/pointer-passthrough.ts), and the tray and
      // Ctrl+Alt+P bring the window back. (It used to be forced off at every launch.)
      // Only a file this version could read keeps its unknown fields; `current` never sees them.
      if (!Array.isArray(raw))
        this.kept = splitUnknownFields(raw, SETTINGS_KNOWN_FIELDS, { label: "settings.json", ...(this.log ? { log: this.log } : {}) }).kept;
      // I-222: a file from before the pin gets it written back now, before any window or channel save can change the chat model; nothing
      // else in the file changes. If the write fails the pin is still held here and rides on the next save (persist keeps it).
      if (pin.fresh && !Array.isArray(raw)) {
        try { await this.writeAtomic(path.join(this.directory, "settings.json"), JSON.stringify(withStoredMemoryPin(raw, pin.model), null, 2)); }
        catch { this.log?.("settings.json: memory pin not written yet; the next save writes it"); }
      }
    } catch {
      this.current = structuredClone(DEFAULT_SETTINGS);
      this.kept = KeptFields.none;
    }
  }
  async persist(next: AppSettings): Promise<AppSettings> {
    next = keepMemoryPin(next, this.current); // I-222: no save moves her memory (memory-pin.ts)
    const data = structuredClone(next) as AppSettings & {
      apiKeyEncrypted?: string;
      voiceInputApiKeyEncrypted?: string;
      ttsApiKeyEncrypted?: string;
      ttsFishApiKeyEncrypted?: string;
    };
    // A stray renderer field can never become a stored key; only the old ciphertext survives.
    delete (data.provider as { apiKey?: unknown }).apiKey;
    if (this.retiredChatKey !== undefined) data.apiKeyEncrypted = this.retiredChatKey;
    const voiceKey = data.voiceInput?.apiKey;
    if (data.voiceInput) delete data.voiceInput.apiKey;
    if (voiceKey) {
      if (!this.secret.isEncryptionAvailable())
        throw new Error("系统密钥加密不可用，无法保存语音识别 API Key。");
      data.voiceInputApiKeyEncrypted = this.secret
        .encryptString(voiceKey)
        .toString("base64");
    }
    const ttsKey = data.tts?.apiKey;
    if (data.tts) delete data.tts.apiKey;
    if (ttsKey) {
      if (!this.secret.isEncryptionAvailable())
        throw new Error("系统密钥加密不可用，无法保存百炼语音 API Key。");
      data.ttsApiKeyEncrypted = this.secret.encryptString(ttsKey).toString("base64");
    }
    // I-070: Drama 3's key, encrypted apart from Bailian's. A redacted value is never stored as a key: it means the saved one.
    let fishKey = data.tts?.fishApiKey;
    if (fishKey === KEY_SENTINEL) fishKey = this.current.tts?.fishApiKey === KEY_SENTINEL ? "" : this.current.tts?.fishApiKey;
    if (data.tts) delete data.tts.fishApiKey;
    if (fishKey) {
      if (!this.secret.isEncryptionAvailable())
        throw new Error("系统密钥加密不可用，无法保存 Drama 3（Fish Audio）的 API Key。");
      data.ttsFishApiKeyEncrypted = this.secret.encryptString(fishKey).toString("base64");
    }
    if (next.tts && next.tts.fishApiKey === KEY_SENTINEL) next = { ...next, tts: { ...next.tts, fishApiKey: fishKey ?? "" } };
    const file = path.join(this.directory, "settings.json");
    // A save (from any window or the internal channel) can never add an unknown field: validateSettings drops them; only
    // the ones the file itself had come back.
    await this.writeAtomic(file, JSON.stringify(this.kept.writeInto(data), null, 2));
    this.current = next;
    return publicSettings(next);
  }
  async save(value: unknown): Promise<AppSettings> {
    const next = validateSettings(value, this.current);
    if (next.voiceInput)
      next.voiceInput = resolveVoiceInputKey(
        next.voiceInput,
        this.current.voiceInput,
      );
    if (next.tts) next.tts = resolveTtsKey(next.tts, this.current.tts);
    return this.persist(next);
  }
}
