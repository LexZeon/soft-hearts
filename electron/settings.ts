import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppSettings,
  VoiceInputConfig,
} from "../shared/contracts";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { AssetRegistry } from "./assets";
import { migrateStoredSettings, validateSettings } from "./validation";
import { resolveTtsKey } from "./tts";
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';
import { KeptFields, splitUnknownFields, type KnownFields } from './unknown-fields';

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
  provider: { kind: true, baseUrl: true, model: true, apiKey: true },
  persona: true,
  pet: { visible: true, alwaysOnTop: true, clickThrough: true, followMouse: true, fps: true, breath: true, scale: true,
    size: { width: true, height: true } },
  voice: { enabled: true, voiceURI: true, rate: true, volume: true, moodInfluence: true, firstChunk: true, pauseTalk: true },
  voiceInput: { baseUrl: true, model: true, language: true, apiKey: true, engine: true },
  tts: { provider: true, apiHost: true, region: true, model: true, voice: true, instruction: true, emotion: true, rate: true,
    apiKey: true, introduced: true, styleBindings: true },
  agent: { workingDirectory: true, model: true, writable: true },
  innerLoop: true, proactiveTalk: true, experienceJournal: true,
  apiKeyEncrypted: true, voiceInputApiKeyEncrypted: true, ttsApiKeyEncrypted: true,
  // Retired: the oldest profiles' persona, read once into the first card (electron/gene-preinstalled-card.ts).
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
  } } : {}),
});

export class SettingsStore {
  current = structuredClone(DEFAULT_SETTINGS);
  /** Ciphertext of the retired chat-provider key, written back unchanged (see load()). */
  private retiredChatKey: string | undefined;
  /** What a newer version wrote that this one does not know: written back by persist(), never read (unknown-fields.ts). */
  private kept = KeptFields.none;
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
      if (typeof persisted.agent?.workingDirectory === "string")
        previous.agent.workingDirectory = persisted.agent.workingDirectory;
      for (const kind of ["model", "motion"] as const) {
        if (typeof persisted[kind]?.path === "string") {
          try {
            previous[kind] = await this.assets.register(persisted[kind]!.path);
          } catch {
            /* Moved or deleted local assets are not fatal. */
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
      }
      // Click-through keeps the saved choice across launches (穿透模式默认开启 — on by default, shared/defaults.ts).
      // Resuming it is safe: her body and the visible controls stay clickable (src/ui/pointer-passthrough.ts), and the tray and
      // Ctrl+Alt+P bring the window back. (It used to be forced off at every launch.)
      // Only a file this version could read keeps its unknown fields; `current` never sees them.
      if (!Array.isArray(raw))
        this.kept = splitUnknownFields(raw, SETTINGS_KNOWN_FIELDS, { label: "settings.json", ...(this.log ? { log: this.log } : {}) }).kept;
    } catch {
      this.current = structuredClone(DEFAULT_SETTINGS);
      this.kept = KeptFields.none;
    }
  }
  async persist(next: AppSettings): Promise<AppSettings> {
    const data = structuredClone(next) as AppSettings & {
      apiKeyEncrypted?: string;
      voiceInputApiKeyEncrypted?: string;
      ttsApiKeyEncrypted?: string;
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
