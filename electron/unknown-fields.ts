import { Buffer } from 'node:buffer';

/**
 * 不认识的字段照样保留、但不使用 (docs/claude/2026-11-04-keep-unknown-fields.md). Host only, no Electron.
 *
 * A newer version may write fields this version does not know into a file this version reads, normalizes and writes back
 * whole (settings.json, characters.json, relationship/<id>.json). Before this, the older version either dropped them on its
 * next save or refused the whole file, so going back one version and then forward again lost them. Now reading sets them
 * aside in an opaque {@link KeptFields}, which no logic reads; writing puts them back unchanged.
 *
 * - What counts as known is the store's {@link KnownFields} table, never "whatever the validator happened to output": a known
 *   field the validator drops on purpose (a plaintext key, a retired field) stays dropped.
 * - A known field is always written from the normalized value; a kept field never overrides it.
 * - A field whose name looks like a secret (or holds one), and everything over {@link KEPT_UNKNOWN_FIELDS_LIMIT}, is not kept
 *   (as before this change); one developer log line says which names and how big, never the content.
 * - When a known field is removed later, leave its name in the table (as retired), or older files keep it forever.
 */
export type KnownFields = { readonly [key: string]: true | KnownFields };

/** Per stored object (the settings file, one card, the cards file's top level, one relationship file), UTF-8 bytes of JSON. */
export const KEPT_UNKNOWN_FIELDS_LIMIT = 64 * 1024;

export interface UnknownFieldOptions {
  /** Which file (and record) this is, for the log line only, e.g. "characters.json 卡片 3". */
  label: string;
  limitBytes?: number;
  /** One developer log line when something is not kept; console.warn by default. */
  log?: (line: string) => void;
}

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => !!value && typeof value === 'object' && !Array.isArray(value);
/** Own data property even for names like "__proto__" (never a prototype change). */
const define = (target: Plain, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

const SECRET_WORDS = new Set(['key', 'keys', 'apikey', 'secret', 'secrets', 'token', 'tokens', 'password', 'passwords', 'passwd', 'pwd',
  'passphrase', 'credential', 'credentials', 'cookie', 'cookies', 'auth', 'authorization', 'bearer', 'encrypted', 'ciphertext', 'cipher']);
/** "apiKeyEncrypted", "tts_api_key", "AUTH-TOKEN" yes; "hotkey", "keyboard", "author" no. */
export function looksLikeSecretName(name: string): boolean {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).some(word => SECRET_WORDS.has(word.toLowerCase()));
}
function holdsSecretName(value: unknown, depth = 0): boolean {
  if (depth > 32) return true; // Absurd nesting is not worth keeping.
  if (Array.isArray(value)) return value.some(item => holdsSecretName(item, depth + 1));
  if (!isPlain(value)) return false;
  return Object.entries(value).some(([key, item]) => key === '__proto__' || looksLikeSecretName(key) || holdsSecretName(item, depth + 1));
}
/** A field name for the log: short and plain, so a broken file cannot put text into it. */
const logName = (name: string): string => name.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 60);

/**
 * What one stored object had that this version does not know. Opaque on purpose: nothing but {@link KeptFields.writeInto}
 * reads it; JSON.stringify gives {} and structuredClone (and so Electron IPC) gives {} too, so even a mistake that hands
 * it to a window shows nothing.
 */
export class KeptFields {
  static readonly none = new KeptFields(null, {});
  readonly #fields: Plain | null;
  readonly #shape: KnownFields;
  private constructor(fields: Plain | null, shape: KnownFields) { this.#fields = fields; this.#shape = shape; }
  /** @internal splitUnknownFields only. */
  static of(fields: Plain | null, shape: KnownFields): KeptFields { return fields ? new KeptFields(fields, shape) : KeptFields.none; }
  get empty(): boolean { return this.#fields === null; }
  /** Dotted names of what is kept ("pet.newThing"), for tests and logs; never the values. */
  names(): string[] { return this.#fields ? paths(this.#fields, this.#shape, '').map(([name]) => name) : []; }
  /** UTF-8 bytes of what is kept, as JSON. */
  get size(): number { return this.#fields ? bytes(this.#fields) : 0; }
  toJSON(): Record<string, never> { return {}; }
  /**
   * A copy of `normalized` (about to be written) with the kept fields put back: each at its own place, after the known ones,
   * never over a field the normalized value has. Kept fields of a known object the normalized value no longer has go with it.
   */
  writeInto<T extends object>(normalized: T): T {
    const copy = structuredClone(normalized) as unknown as Plain;
    if (this.#fields) merge(copy, this.#fields, this.#shape);
    return copy as unknown as T;
  }
}

function paths(kept: Plain, shape: KnownFields, prefix: string): [string, number][] {
  return Object.entries(kept).flatMap(([key, value]): [string, number][] => {
    const name = prefix ? `${prefix}.${key}` : key, rule = Object.hasOwn(shape, key) ? shape[key] : undefined;
    return rule !== undefined && rule !== true && isPlain(value) ? paths(value, rule, name) : [[name, bytes(value)]];
  });
}

function merge(target: Plain, kept: Plain, shape: KnownFields): void {
  for (const [key, value] of Object.entries(kept)) {
    const rule = Object.hasOwn(shape, key) ? shape[key] : undefined;
    if (rule === undefined) { if (!Object.hasOwn(target, key)) define(target, key, structuredClone(value)); continue; }
    if (rule === true) continue;
    const inner = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isPlain(inner) && isPlain(value)) merge(inner, value, rule);
  }
}

function walk(value: Plain, shape: KnownFields, prefix: string, refused: string[]): { known: Plain; kept: Plain | null } {
  const known: Plain = {};
  let kept: Plain | null = null;
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key, rule = Object.hasOwn(shape, key) ? shape[key] : undefined;
    if (rule === true) { define(known, key, child); continue; }
    if (rule !== undefined) {
      if (!isPlain(child)) { define(known, key, child); continue; } // A known field of the wrong type: the validator decides, as before.
      const inner = walk(child, rule, name, refused);
      define(known, key, inner.known);
      if (inner.kept) define(kept ??= {}, key, inner.kept);
      continue;
    }
    if (key === '__proto__' || looksLikeSecretName(key) || holdsSecretName(child)) { refused.push(name); continue; }
    define(kept ??= {}, key, structuredClone(child));
  }
  return { known, kept };
}

export interface SplitFields {
  /** `raw` without the unknown fields (at every level the table names): what the store's own reading rules see. */
  known: Plain;
  kept: KeptFields;
  /** Unknown fields that are not kept (secret-like names, or all of them when over the limit). */
  dropped: string[];
}

/** Sets the unknown fields of one stored object aside. `raw` is not changed. */
export function splitUnknownFields(raw: Plain, shape: KnownFields, options: UnknownFieldOptions): SplitFields {
  const refused: string[] = [];
  const { known, kept } = walk(raw, shape, '', refused);
  const log = options.log ?? ((line: string) => console.warn(line));
  if (refused.length) log(`[未知字段] ${options.label}：名字像密钥或含密钥，没有保留：${refused.map(logName).join('、')}`);
  const limit = options.limitBytes ?? KEPT_UNKNOWN_FIELDS_LIMIT;
  if (kept && bytes(kept) > limit) {
    const rows = paths(kept, shape, '');
    log(`[未知字段] ${options.label}：共 ${bytes(kept)} 字节，超过 ${limit} 字节上限，没有保留：${rows.map(([name, size]) => `${logName(name)}（${size} 字节）`).join('、')}`);
    return { known, kept: KeptFields.none, dropped: [...refused, ...rows.map(([name]) => name)] };
  }
  return { known, kept: KeptFields.of(kept, shape), dropped: refused };
}
