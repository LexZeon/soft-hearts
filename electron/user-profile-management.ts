import type {
  UserDiaryClearRequest, UserDiaryDeleteRequest, UserDiaryEditRequest, UserProfileDeleteRequest, UserProfileEditRequest, UserProfileToggleRequest,
} from '../shared/user-profile-ui';
import { UserProfileStore, type UserProfileScope, type UserProfileView } from './user-profile';

function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('用户画像操作格式不正确。');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key)))
    throw Error('用户画像操作格式不正确。');
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('用户画像操作格式不正确。');
    result[name] = descriptor.value;
  }
  return result;
}

/** Narrow management surface; renderer operations cannot select a scope or path. */
export class UserProfileManagement {
  private epoch = 0;
  private ready = false;
  private scopeKey: string | null = null;
  private activating: Promise<UserProfileView | null> | null = null;
  private disposed = false;
  constructor(private readonly store: UserProfileStore,
    private readonly changed: (view: UserProfileView | null) => void,
    private readonly currentScope?: () => UserProfileScope | null,
    /**
     * The user turned "允许记录" off or cleared the diary of the shown scope: what else the app remembers about the
     * user for this character goes the same way (G1's match counts, electron/rps/store.ts `forget`).
     */
    private readonly forgotten?: (scope: UserProfileScope, reason: 'recording-off' | 'diary-cleared') => void) {}
  private forget(reason: 'recording-off' | 'diary-cleared'): void {
    let scope: UserProfileScope | null = null;
    try { scope = this.currentScope?.() ?? null; } catch { scope = null; }
    if (!scope) return;
    try { this.forgotten?.(scope, reason); } catch { /* The profile change already happened; the sidecar reports its own failure. */ }
  }

  activate(scope: UserProfileScope): Promise<UserProfileView | null> {
    if (this.disposed) return Promise.resolve(null);
    const key = JSON.stringify([scope.characterId, scope.providerScope]);
    if (this.scopeKey === key) return this.activating ?? Promise.resolve(this.get());
    const epoch = ++this.epoch;
    this.scopeKey = key;
    this.ready = false;
    this.publish(null);
    // Store activation invalidates old proof/context synchronously, before I/O.
    const operation = this.store.activate(scope).then(view => {
      if (this.disposed || epoch !== this.epoch || !view) return null;
      this.ready = true;
      const current = this.get();
      if (!current) { this.ready = false; this.publish(null); return null; }
      this.publish(current);
      return current;
    }).catch(() => {
      if (!this.disposed && epoch === this.epoch) { this.ready = false; this.publish(null); }
      return null; // Optional profile failure must not reject ordinary chat/startup.
    }).finally(() => { if (this.activating === operation) this.activating = null; });
    this.activating = operation;
    return operation;
  }

  get(): UserProfileView | null {
    if (this.disposed || !this.ready) return null;
    try {
      if (this.currentScope) {
        const scope = this.currentScope();
        if (!scope || JSON.stringify([scope.characterId, scope.providerScope]) !== this.scopeKey) return null;
      }
      return this.store.view();
    } catch { return null; }
  }
  setEnabled(input: UserProfileToggleRequest | unknown): UserProfileView {
    const value = this.expected(input, ['enabled']);
    if (typeof value.enabled !== 'boolean') throw Error('用户画像开关不正确。');
    const view = this.store.setEnabled(value.enabled);
    if (!value.enabled) this.forget('recording-off');
    this.publish(view);
    return view;
  }
  async edit(input: UserProfileEditRequest | unknown): Promise<UserProfileView> {
    const value = this.expected(input, ['id', 'edit']);
    const edit = record(value.edit, ['text', 'kind']);
    if (typeof value.id !== 'string' || typeof edit.text !== 'string' || typeof edit.kind !== 'string'
      || !['fact', 'preference', 'pending_inference'].includes(edit.kind)) throw Error('用户画像编辑不正确。');
    return this.finishManagement(() => this.store.editEntry(value.id as string,
      { text: edit.text as string, kind: edit.kind as UserProfileEditRequest['edit']['kind'] }, value.revision as number));
  }
  async delete(input: UserProfileDeleteRequest | unknown): Promise<UserProfileView> {
    const value = this.expected(input, ['id']);
    if (typeof value.id !== 'string') throw Error('用户画像删除操作不正确。');
    return this.finishManagement(() => this.store.deleteEntry(value.id as string, value.revision as number));
  }
  /** L3: an edited day is kept as written by the user and never rewritten automatically. */
  async editDiary(input: UserDiaryEditRequest | unknown): Promise<UserProfileView> {
    const value = this.expected(input, ['date', 'text']);
    if (typeof value.date !== 'string' || typeof value.text !== 'string') throw Error('日记修改不正确。');
    return this.finishManagement(() => this.store.editDiary(value.date as string, value.text as string, value.revision as number));
  }
  async deleteDiary(input: UserDiaryDeleteRequest | unknown): Promise<UserProfileView> {
    const value = this.expected(input, ['date']);
    if (typeof value.date !== 'string') throw Error('日记删除操作不正确。');
    return this.finishManagement(() => this.store.deleteDiary(value.date as string, value.revision as number));
  }
  async clearDiary(input: UserDiaryClearRequest | unknown): Promise<UserProfileView> {
    const value = this.expected(input, []);
    const view = await this.finishManagement(() => this.store.clearDiary(value.revision as number));
    this.forget('diary-cleared');
    return view;
  }
  cancelPending(): void {
    if (this.disposed) return;
    this.store.cancelPending();
    this.publish(this.get());
  }
  suspendScope(): void {
    if (this.disposed) return;
    this.epoch++; this.ready = false; this.scopeKey = null;
    this.store.deactivate(); this.publish(null);
  }
  publishCurrent(): void { this.publish(this.get()); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.epoch++; this.ready = false; this.scopeKey = null;
    this.store.dispose(); this.publish(null);
  }
  private expected(input: unknown, fields: readonly string[]): Record<string, unknown> {
    const value = record(input, ['scopeId', 'generation', 'revision', ...fields]);
    const current = this.get();
    if (!current || typeof value.scopeId !== 'string' || !/^[a-f0-9]{64}$/.test(value.scopeId)
      || !Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.revision)
      || value.scopeId !== current.scopeId || value.generation !== current.generation || value.revision !== current.revision)
      throw Error('用户画像已变化，请重新读取后再操作。');
    return value;
  }
  private async finishManagement(operation: () => Promise<UserProfileView>): Promise<UserProfileView> {
    const epoch = this.epoch;
    try {
      const pending = operation();
      this.publishCurrent(); // The store has synchronously revoked old in-flight context.
      const view = await pending;
      if (this.disposed || epoch !== this.epoch || !this.get()) throw Error('用户画像已切换，请重新打开。');
      this.publish(view);
      return view;
    } catch {
      if (!this.disposed && epoch === this.epoch) this.publishCurrent();
      // Filesystem failures may contain a private path; never expose their text.
      throw Error('用户画像未能保存，请重新读取后重试。');
    }
  }
  private publish(view: UserProfileView | null): void {
    try { this.changed(view); } catch { /* Viewer failure cannot retain consent or proofs. */ }
  }
}
