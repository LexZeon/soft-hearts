import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  normalizeModelPhysicsSettings,
  type ModelPhysicsSettings,
} from "../shared/model-physics";
import { atomicWriteFile, type AtomicFileWriter } from "./atomic-file";

function ownField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

/** Capture only setting primitives before an update waits behind another write. */
function updateSnapshot(input: unknown): unknown {
  const part = (key: "hair" | "chest") => {
    const value = ownField(input, key);
    const enabled = ownField(value, "enabled");
    const strength = ownField(value, "strength");
    return {
      enabled: typeof enabled === "boolean" ? enabled : undefined,
      strength: typeof strength === "number" ? strength : undefined,
    };
  };
  const quality = ownField(input, "quality");
  return {
    hair: part("hair"),
    chest: part("chest"),
    quality: typeof quality === "string" ? quality : undefined,
  };
}

/**
 * Host-owned sidecar, independent of settings.json understood by older builds.
 * The host supplies its file path; the stored schema contains presentation
 * settings only. Reading missing or invalid data never creates a new file.
 */
export class ModelPhysicsSettingsStore {
  private value = normalizeModelPhysicsSettings(undefined);
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly writeAtomic: AtomicFileWriter = atomicWriteFile,
  ) {}

  get current(): ModelPhysicsSettings {
    return structuredClone(this.value);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    // A failed write rejects its caller but cannot poison later operations.
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  load(fallback?: unknown): Promise<ModelPhysicsSettings> {
    const fallbackSettings = normalizeModelPhysicsSettings(fallback);
    return this.enqueue(async () => {
      let next = fallbackSettings;
      try {
        const raw: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
        const settings = ownField(raw, "settings");
        if (ownField(raw, "version") === 1 && settings && typeof settings === "object" && !Array.isArray(settings)) {
          // A recognized sidecar takes precedence over the legacy main file.
          next = normalizeModelPhysicsSettings(settings);
        }
      } catch {
        // Missing, unreadable or malformed data uses the explicitly supplied
        // migration fallback, otherwise both effects remain disabled.
      }
      this.value = next;
      return this.current;
    });
  }

  persist(input: unknown): Promise<ModelPhysicsSettings> {
    const snapshot = updateSnapshot(input);
    return this.enqueue(async () => {
      // Resolve partial updates against the last successfully committed value.
      const next = normalizeModelPhysicsSettings(snapshot, this.value);
      const data = JSON.stringify({ version: 1, settings: next }, null, 2);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await this.writeAtomic(this.filePath, data);
      this.value = next;
      return this.current;
    });
  }
}
