import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultCharacterResponseProfile, validateCharacterResponseProfile,
  type CharacterResponseProfile, type CharacterResponseState,
} from '../shared/character-response';
import { exportCharacterWithResponse, parseCharacterResponseImport } from '../shared/character-response-portable';
import type { CharacterCardState } from '../shared/character-cards';
import { CharacterCardStore } from './character-cards';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';

const SIDECAR_FILE = 'character-response-settings.json';
const MAX_PROFILES = 128;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response storage');
  return value as Record<string, unknown>;
};
const only = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unknown response storage fields');
};
const equal = (left: CharacterResponseProfile, right: CharacterResponseProfile) => JSON.stringify(left) === JSON.stringify(right);

/** This sidecar contains only per-character templates, preserving both legacy data files. */
export class CharacterResponseStore {
  private profiles = new Map<string, CharacterResponseProfile>();
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private failure = '';
  private blocked = false;
  private readonly file: string;

  constructor(
    private readonly directory: string,
    private readonly characterIds: () => readonly string[],
    private readonly writeAtomic: AtomicFileWriter = atomicWriteFile,
  ) { this.file = path.join(directory, SIDECAR_FILE); }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const profiles = new Map<string, CharacterResponseProfile>();
    let revision = 0;
    try {
      if ((await stat(this.file)).size > 8_000_000) throw new Error('Response storage too large');
      const raw = object(JSON.parse(await readFile(this.file, 'utf8')));
      only(raw, ['version', 'revision', 'profiles']);
      if (raw.version !== 1 || !Array.isArray(raw.profiles) || raw.profiles.length > MAX_PROFILES
        || (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0)))
        throw new Error('Invalid response storage');
      revision = (raw.revision as number | undefined) ?? 0;
      for (const value of raw.profiles) {
        const record = object(value); only(record, ['characterId', 'profile']);
        if (typeof record.characterId !== 'string' || !uuid.test(record.characterId) || profiles.has(record.characterId))
          throw new Error('Invalid response character');
        profiles.set(record.characterId, validateCharacterResponseProfile(record.profile));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.profiles.clear(); this.revision = 0; this.blocked = true;
        this.failure = '反应细调无法读取，原 character-response-settings.json 已保留；修复并重新载入前不能覆盖。';
        return;
      }
    }
    // Loading does not prune IDs: an older application's legal save never clears this sidecar.
    this.profiles = profiles; this.revision = revision; this.blocked = false; this.failure = '';
  }

  private exists(id: string): boolean { return typeof id === 'string' && uuid.test(id) && this.characterIds().includes(id); }
  private assertCharacter(id: string): void {
    if (!this.exists(id)) throw new Error('角色卡不存在，请重新读取角色列表。');
  }
  private assertWritable(): void { if (this.blocked) throw new Error(this.failure); }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending;
  }
  get(id: string): CharacterResponseState {
    this.assertCharacter(id);
    return { characterId: id, revision: this.revision,
      profile: this.effectiveProfile(id), ...(this.failure ? { storageError: this.failure } : {}) };
  }
  /** Deleted/foreign IDs and a damaged optional sidecar can never affect live presentation. */
  effectiveProfile(id: string): CharacterResponseProfile {
    return !this.blocked && this.exists(id) && this.profiles.has(id)
      ? structuredClone(this.profiles.get(id)!) : defaultCharacterResponseProfile();
  }
  async save(id: string, value: unknown, expectedRevision?: number): Promise<CharacterResponseState> {
    const profile = validateCharacterResponseProfile(value);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
      return Promise.reject(new Error('反应细调修订号不正确。'));
    return this.mutate(async () => {
      this.assertWritable(); this.assertCharacter(id);
      if (expectedRevision !== undefined && expectedRevision !== this.revision)
        throw new Error('反应细调已有新修改，请重新读取后再保存。');
      if (equal(this.effectiveProfile(id), profile)) return this.get(id);
      let next = new Map(this.profiles);
      if (profile.rules.length) next.set(id, profile); else next.delete(id);
      // Only an explicit response save may reclaim confirmed deleted IDs when
      // needed for capacity. Loading or an older app's ordinary card save does not.
      if (next.size > MAX_PROFILES) {
        const currentIds = new Set(this.characterIds());
        next = new Map([...next].filter(([characterId]) => currentIds.has(characterId)));
      }
      if (next.size > MAX_PROFILES) throw new Error('反应细调存档数量已达上限，原模板已保留。');
      await this.persist(next);
      this.assertCharacter(id);
      return this.get(id);
    });
  }
  /** Host lifecycle only, after the corresponding base card deletion has succeeded. */
  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      this.assertWritable();
      if (typeof id !== 'string' || !uuid.test(id)) throw new Error('角色卡编号不正确。');
      if (!this.profiles.has(id)) return;
      const next = new Map(this.profiles); next.delete(id); await this.persist(next);
    });
  }
  private async persist(next: Map<string, CharacterResponseProfile>): Promise<void> {
    const revision = this.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('反应细调修订号已达上限。');
    const data = { version: 1, revision,
      profiles: [...next].map(([characterId, profile]) => ({ characterId, profile })) };
    await this.writeAtomic(this.file, JSON.stringify(data, null, 2));
    this.profiles = next; this.revision = revision;
  }
}

export interface CharacterResponseImportResult {
  state: CharacterCardState;
  characterId: string;
  responseSaved: boolean;
  notice?: string;
  /** A bounded, validated draft for retrying this same ID; never import the file again. */
  retryProfile?: CharacterResponseProfile;
}

/** Coordinates the two small stores without extending legacy card or mood schemas. */
export class CharacterResponseService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly cards: CharacterCardStore, private readonly responses: CharacterResponseStore) {}
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending;
  }
  get(id: string): CharacterResponseState { return this.responses.get(id); }
  async save(id: string, profile: unknown, expectedRevision?: number): Promise<CharacterResponseState> {
    const validated = validateCharacterResponseProfile(profile);
    return this.mutate(() => this.responses.save(id, validated, expectedRevision));
  }
  copy(sourceId: string, targetId: string): Promise<CharacterResponseState> {
    return this.mutate(async () => {
      const source = this.responses.get(sourceId), target = this.responses.get(targetId);
      if (source.storageError || target.storageError) throw new Error(source.storageError ?? target.storageError);
      if (equal(source.profile, target.profile)) return target;
      if (target.profile.rules.length) throw new Error('目标角色已有反应细调，原模板已保留，未自动覆盖。');
      return this.responses.save(targetId, source.profile, target.revision);
    });
  }
  export(id: string): string {
    const response = this.responses.get(id);
    if (response.storageError) throw new Error(response.storageError);
    return exportCharacterWithResponse(this.cards.export(id), response.profile);
  }
  async import(text: string): Promise<CharacterResponseImportResult> {
    const parsed = parseCharacterResponseImport(text);
    return this.mutate(async () => {
      const before = new Set(this.cards.publicState().cards.map(card => card.id));
      const state = await this.cards.import(parsed.baseText);
      const created = state.cards.filter(card => !before.has(card.id));
      if (created.length !== 1) throw new Error('角色已导入，但无法确认新编号，请重新读取角色列表，勿重复导入。');
      const characterId = created[0].id;
      if (!parsed.profile.rules.length) return { state, characterId, responseSaved: true };
      try {
        await this.responses.save(characterId, parsed.profile);
        return { state, characterId, responseSaved: true };
      } catch {
        const notice = '角色卡已导入，反应细调尚未保存；请在这张新卡上重试保存细调，勿重复导入。';
        return { state: { ...state, notice }, characterId, responseSaved: false, notice,
          retryProfile: structuredClone(parsed.profile) };
      }
    });
  }
  remove(id: string): Promise<CharacterCardState> {
    return this.mutate(async () => {
      const state = await this.cards.remove(id);
      try { await this.responses.remove(id); return state; }
      catch {
        return { ...state, notice: '角色卡已删除，旧反应细调暂未清理；该编号已停用，不会影响其他角色。' };
      }
    });
  }
}
