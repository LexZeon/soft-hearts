/**
 * C2 角色页：一点就换 (confirmed with all four
 * recommended options): a card wall, one tile per character, plus a "新增角色" tile. "换成她" switches without asking
 * (switching back loses nothing); while she is talking the host waits for that line to end. Deleting asks, and by
 * default deletes only the card ("同时删除她的记忆" is unticked). The editor (CharacterCards) stays below the wall.
 * Text is set with textContent only; pictures are data URLs the host produced.
 *
 * Step two (not built here, see docs/claude/2026-11-03-character-model.md): dropping a character folder on this page
 * (it would land on the "新增角色" tile, addTile, next to addFromModelFile / addFromCardFile), and the last 3 characters
 * in the pet window (they can call window.desktop.switchCharacter, which already waits for her current line).
 */
import { uiText, uiTemplate } from './ui-language';
import { CHARACTER_TEXT_LIMITS, MAX_CHARACTER_CARDS, type CharacterCardState, type CharacterDraft } from '../../shared/character-cards';
import type { CharacterRosterEntry, CharacterRosterView } from '../../shared/character-roster';
import { cardUpdateSummaryLines, type CharacterCardUpdatePreview } from '../../shared/character-card-update';
import type { DesktopAPI } from '../../shared/contracts';
import type { CharacterCard } from '../../shared/character-cards';
import type { UnderstandingTrigger } from '../../shared/character-understanding';
import { CharacterUnderstandingPanel, type CharacterUnderstandingApi } from './CharacterUnderstanding';

export type CharacterPageApi = Pick<DesktopAPI, 'getCharacterRoster' | 'switchCharacter' | 'createCharacterForCurrentModel' | 'bindCharacterModelFile'
  | 'bindCharacterModel' | 'deleteCharacter' | 'importCharacterCard' | 'exportCharacterCard' | 'selectAsset' | 'saveCharacterCard'
  | 'copyCharacterResponse' | 'getCharacterCards' | 'onCharacterRoster' | 'saveCharacterAvatar'
  | 'previewCharacterCardUpdate' | 'applyCharacterCardUpdate' | 'discardCharacterCardUpdate'>
  /** I-018 理解讨论: present on the app's bridge; without it the page has no discussion. */
  & Partial<CharacterUnderstandingApi>;

/**
 * I-018: a card worth talking over on its own after it was imported or created: it has some persona besides the name
 * (a card made for a model with one line, C1, is not; "和 Claude 聊聊这个角色" still opens one any time).
 */
export function cardWorthDiscussing(card: Pick<CharacterCard, 'description' | 'personality' | 'scenario' | 'greeting' | 'examples' | 'systemPrompt'>): boolean {
  const text = [card.description, card.personality, card.scenario, card.greeting, card.examples, card.systemPrompt].map(value => value.trim()).join('');
  return [...text].length >= 40;
}
const understandingApi = (api: CharacterPageApi): CharacterUnderstandingApi | null =>
  api.startCharacterUnderstanding && api.getCharacterUnderstanding && api.replyCharacterUnderstanding && api.finishCharacterUnderstanding
    && api.retryCharacterUnderstanding && api.closeCharacterUnderstanding && api.saveCharacterUnderstanding && api.onCharacterUnderstanding
    ? api as CharacterUnderstandingApi : null;

export interface CharacterPageOptions {
  api: CharacterPageApi;
  onError(message: string): void;
  /** An informational line (toast). */
  onNotice?(message: string): void;
  /** A card state the host returned (the app applies it everywhere, like a broadcast). */
  onState?(state: CharacterCardState): void;
  /** Open the editor below on this card / its mood and reactions / a blank new card. */
  onEdit?(id: string): void;
  onTune?(id: string): void;
  onBlank?(): void;
  /** The control window's preview: a half-body PNG of the model at this URL (MmdStage.captureCharacterAvatar). */
  capture?(modelUrl: string): Promise<string>;
  /** The model URL on stage now. */
  modelUrl?(): string;
  /** Milliseconds to let her settle into her pose before the automatic picture (default 1500). */
  captureDelayMs?: number;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** 今天 14:20 / 昨天 09:05 / 11月1日 (local time). */
export function lastChatText(at: number | null, now = Date.now()): string {
  if (at === null) return uiText('还没聊过');
  const day = (ms: number) => { const date = new Date(ms); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
  const date = new Date(at), time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return uiTemplate`上次聊天：今天 ${time}`;
  if (days === 1) return uiTemplate`上次聊天：昨天 ${time}`;
  return uiTemplate`上次聊天：${date.getMonth() + 1}月${date.getDate()}日`;
}

interface Tile {
  root: HTMLElement;
  status: HTMLOutputElement;
  menu: HTMLElement;
  confirm: HTMLElement;
  forget: HTMLInputElement;
  /** C3: "用角色卡文件更新" waiting for the user's OK on this tile. */
  update: HTMLElement;
  updateLines: HTMLElement;
  buttons: Map<string, HTMLButtonElement>;
}

export class CharacterPage {
  private view: CharacterRosterView | null = null;
  private cardState: CharacterCardState | null = null;
  private readonly tiles = new Map<string, Tile>();
  private busy = false;
  private disposed = false;
  private rendered = false;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private unsubscribe: (() => void) | null = null;
  private wall!: HTMLElement;
  private status!: HTMLOutputElement;
  private addButtons = new Map<string, HTMLButtonElement>();
  private readonly captured = new Set<string>();
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  /** C3: the one update the host is holding for a confirmation (it survives a repaint of the wall). */
  private pendingUpdate: CharacterCardUpdatePreview | null = null;
  /** I-018: the discussion with Claude about a character (above the wall). */
  private understanding: CharacterUnderstandingPanel | null = null;

  constructor(private readonly container: HTMLElement, private readonly options: CharacterPageOptions) {}

  async init(): Promise<void> {
    if (this.disposed || this.rendered) return;
    this.render();
    this.unsubscribe = this.options.api.onCharacterRoster(() => { void this.refresh(); });
    await Promise.all([this.refresh(), this.understanding?.init()]);
  }

  /**
   * I-018 和 Claude 聊聊这个角色: after an import or a new card (when it has some persona to talk about), after an
   * in-place update (only what changed), or when the user asks. It never blocks anything; the user can skip it.
   */
  async discuss(id: string, trigger: UnderstandingTrigger, changedFields: readonly string[] = [], card?: CharacterCard): Promise<void> {
    if (!this.understanding || this.disposed) return;
    if ((trigger === 'imported' || trigger === 'created') && card && !cardWorthDiscussing(card)) return;
    await this.understanding.start(id, trigger, changedFields);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.understanding?.dispose(); this.understanding = null;
    if (this.pendingUpdate) { void this.options.api.discardCharacterCardUpdate(this.pendingUpdate.token).catch(() => {}); this.pendingUpdate = null; }
    if (this.captureTimer) { clearTimeout(this.captureTimer); this.captureTimer = null; }
    this.tiles.clear(); this.addButtons.clear();
    this.container.replaceChildren();
  }

  /** The app's card state (broadcasts and returns): the wall follows it; a waiting switch shows on its tile. */
  applyCardState(state: CharacterCardState): void {
    if (this.disposed) return;
    const before = this.cardState;
    this.cardState = state;
    this.paintSwitching();
    if (!before || before.revision !== state.revision || before.activeId !== state.activeId || before.cards.length !== state.cards.length) void this.refresh();
  }

  /** C1: which card a loaded model went with, kept on the page until the next one. */
  showHint(text: string): void { if (!this.disposed && this.rendered) this.status.textContent = text; }

  /** The editor's "删除" comes here: the same confirmation on her tile (memories stay unless ticked). */
  askDelete(id: string): void {
    const tile = this.tiles.get(id);
    if (!tile || this.disposed) return;
    tile.menu.hidden = true; tile.confirm.hidden = false; tile.forget.checked = false;
    tile.root.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }

  /** The current roster (tests and the app's avatar step read it). */
  get roster(): CharacterRosterView | null { return this.view ? structuredClone(this.view) : null; }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        try {
          const view = await this.options.api.getCharacterRoster();
          if (this.disposed) return;
          this.view = view;
          this.paint();
        } catch (error) { this.error(error); }
      } while (this.refreshAgain && !this.disposed);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /**
   * The control window's stage finished showing a model. When the current card goes with it and has no picture of
   * her yet, take one after she settles (once per card and model this session; a failure just keeps the letter).
   */
  async modelShown(modelUrl: string): Promise<void> {
    if (this.disposed || !modelUrl || !this.options.capture) return;
    await this.refreshing;
    const active = this.view?.entries.find(entry => entry.active);
    if (!active || active.avatar.kind === 'snapshot' || !['ok', 'bundled'].includes(active.model.state)) return;
    const key = `${active.id}\0${modelUrl}`;
    if (this.captured.has(key)) return;
    this.captured.add(key);
    if (this.captureTimer) clearTimeout(this.captureTimer);
    await new Promise<void>(resolve => { this.captureTimer = setTimeout(() => { this.captureTimer = null; resolve(); }, this.options.captureDelayMs ?? 1500); });
    if (this.disposed || this.view?.activeId !== active.id || (this.options.modelUrl?.() ?? modelUrl) !== modelUrl) return;
    try { await this.saveAvatar(active.id, modelUrl); } catch { /* The name's letter stays; "重新截头像" can try again. */ }
  }

  private async saveAvatar(id: string, modelUrl: string): Promise<void> {
    const png = await this.options.capture!(modelUrl);
    await this.options.api.saveCharacterAvatar(id, modelUrl, png);
  }

  private render(): void {
    if (this.rendered) return;
    this.rendered = true;
    const section = element('section', 'settings-section character-page');
    section.id = 'character-wall';
    section.setAttribute('aria-label', uiText('角色卡片'));
    this.wall = element('div', 'character-wall');
    this.status = element('output', 'character-page-status');
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    const api = understandingApi(this.options.api);
    if (api) {
      const holder = element('div', 'character-understanding-holder');
      section.append(holder);
      this.understanding = new CharacterUnderstandingPanel(holder, { api, onError: message => this.options.onError(message), onState: state => this.accept(state) });
    }
    section.append(this.wall, this.status);
    this.container.replaceChildren(section);
  }

  private paint(): void {
    if (!this.view || this.disposed) return;
    this.wall.replaceChildren();
    this.tiles.clear();
    for (const entry of this.view.entries) this.wall.append(this.tile(entry));
    this.wall.append(this.addTile());
    this.paintSwitching();
    this.refreshButtons();
  }

  private tile(entry: CharacterRosterEntry): HTMLElement {
    const root = element('article', `character-tile${entry.active ? ' active' : ''}`);
    root.dataset.characterId = entry.id;
    root.setAttribute('aria-label', entry.name);
    const avatar = element('div', `character-tile-avatar avatar-${entry.avatar.kind}`);
    if (entry.avatar.dataUrl) { const image = element('img'); image.src = entry.avatar.dataUrl; image.alt = ''; avatar.append(image); }
    else avatar.append(element('span', 'character-tile-initial', entry.avatar.initial));
    const body = element('div', 'character-tile-body');
    const heading = element('div', 'character-tile-heading');
    heading.append(element('strong', 'character-tile-name', entry.name));
    if (entry.active) heading.append(element('span', 'character-tile-badge', uiText('正在陪着你')));
    body.append(heading);
    body.append(element('p', 'character-tile-tagline', entry.tagline || uiText('还没写性格，可以点「更多 → 编辑人设」补上。')));
    const buttons = new Map<string, HTMLButtonElement>();
    const button = (id: string, text: string, action: () => void, className = '') => {
      const node = element('button', className, text); node.type = 'button'; node.dataset.characterAction = id; node.onclick = action;
      buttons.set(id, node); return node;
    };
    const model = element('p', `character-tile-model model-${entry.model.state}`);
    if (entry.model.state === 'missing') model.append(button('rebind', uiTemplate`模型文件不在了（${entry.model.name ?? ''}），点这里重新选`, () => void this.bindFile(entry.id), 'link'));
    else model.textContent = entry.model.state === 'bundled' ? uiText('模型：预装 Gene')
      : entry.model.state === 'ok' ? uiTemplate`模型：${entry.model.name ?? ''}` : uiText('还没关联模型：换成她时用桌面上现在的模型');
    body.append(model);
    const meta = [entry.knownDay !== null ? uiTemplate`认识第 ${entry.knownDay} 天` : '', lastChatText(entry.lastChatAt)].filter(Boolean).join(' · ');
    body.append(element('p', 'character-tile-meta', meta));
    const actions = element('div', 'character-tile-actions');
    actions.append(button('switch', entry.active ? uiText('正在陪着你') : uiText('换成她'), () => void this.switchTo(entry.id), 'primary'));
    const more = button('more', uiText('更多'), () => { menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); }, 'subtle');
    more.setAttribute('aria-expanded', 'false');
    actions.append(more);
    const menu = element('div', 'character-tile-menu'); menu.hidden = true;
    menu.append(
      button('edit', uiText('编辑人设'), () => { menu.hidden = true; this.options.onEdit?.(entry.id); }),
      ...(this.understanding ? [button('understand', uiText('和 Claude 聊聊这个角色'), () => { menu.hidden = true; void this.discuss(entry.id, 'manual'); })] : []),
      button('update-file', uiText('用角色卡文件更新…'), () => { menu.hidden = true; void this.previewUpdate(entry.id); }),
      button('tune', uiText('心情和反应'), () => { menu.hidden = true; this.options.onTune?.(entry.id); }),
      button('bind-current', uiText('关联桌面上现在的模型'), () => void this.bindCurrent(entry.id)),
      button('bind-file', uiText('关联别的模型文件…'), () => void this.bindFile(entry.id)),
      button('avatar', uiText('重新截头像'), () => void this.retakeAvatar(entry.id)),
      button('duplicate', uiText('复制'), () => void this.duplicate(entry.id)),
      button('export', uiText('导出'), () => void this.exportCard(entry.id)),
      button('delete', uiText('删除'), () => { menu.hidden = true; confirm.hidden = false; forget.checked = false; }, 'danger'),
    );
    // Deleting cannot be undone, so it always asks; her memories stay unless the box is ticked.
    const confirm = element('div', 'character-tile-confirm'); confirm.hidden = true;
    confirm.setAttribute('role', 'group'); confirm.setAttribute('aria-label', uiText('确认删除'));
    confirm.append(element('p', '', uiTemplate`删除「${entry.name}」？删除不能撤回。默认只删这张角色卡，她的聊天记忆、日记和画像都会留着。`));
    const label = element('label', 'character-tile-forget'), forget = element('input');
    forget.type = 'checkbox'; forget.checked = false; forget.dataset.characterAction = 'forget-memories';
    label.append(forget, element('span', '', uiText('同时删除她的记忆（聊天记录、日记和画像、熟悉度和昵称、猜拳记录）')));
    const confirmActions = element('div', 'character-tile-confirm-actions');
    confirmActions.append(button('cancel-delete', uiText('取消'), () => { confirm.hidden = true; forget.checked = false; }, 'subtle'),
      button('confirm-delete', uiText('删除'), () => void this.remove(entry.id, forget.checked), 'danger'));
    confirm.append(label, confirmActions);
    // C3: updating from a card file always asks, listing what changes; a different name is flagged.
    const update = element('div', 'character-tile-confirm character-tile-update'); update.hidden = true;
    update.setAttribute('role', 'group'); update.setAttribute('aria-label', uiText('确认用角色卡文件更新'));
    const updateLines = element('div', 'character-update-lines');
    const updateActions = element('div', 'character-tile-confirm-actions');
    updateActions.append(button('cancel-update', uiText('取消'), () => this.cancelUpdate(), 'subtle'),
      button('confirm-update', uiText('更新她的人设'), () => void this.applyUpdate(entry.id), 'primary'));
    update.append(updateLines, updateActions);
    const status = element('output', 'character-tile-status'); status.setAttribute('role', 'status');
    root.append(avatar, body, actions, menu, confirm, update, status);
    const tile: Tile = { root, status, menu, confirm, forget, update, updateLines, buttons };
    this.tiles.set(entry.id, tile);
    this.paintUpdate(entry.id, tile);
    return root;
  }

  /** The pending update's lines on her tile (or nothing). */
  private paintUpdate(id: string, tile = this.tiles.get(id)): void {
    if (!tile) return;
    const pending = this.pendingUpdate?.id === id ? this.pendingUpdate : null;
    tile.update.hidden = !pending;
    tile.updateLines.replaceChildren();
    if (!pending) return;
    tile.menu.hidden = true; tile.confirm.hidden = true;
    const name = this.view?.entries.find(entry => entry.id === id)?.name ?? pending.summary.name.before;
    tile.updateLines.append(element('p', 'character-update-title', uiTemplate`用这个文件更新「${name}」？还是同一个她，只换人设。`));
    for (const line of cardUpdateSummaryLines(pending.summary, uiText)) {
      const node = element('p', line.warning ? 'character-update-warning' : '', line.text);
      if (line.warning) node.setAttribute('role', 'alert');
      tile.updateLines.append(node);
    }
  }

  private addTile(): HTMLElement {
    const root = element('article', 'character-tile character-add');
    root.id = 'character-add';
    root.append(element('strong', 'character-tile-name', uiText('新增角色')));
    root.append(element('p', 'character-tile-tagline', uiText('名字和人设可以先留空，以后再补。')));
    const list = element('div', 'character-add-actions');
    this.addButtons.clear();
    const add = (id: string, text: string, action: () => void) => {
      const node = element('button', 'subtle', text); node.type = 'button'; node.dataset.characterAdd = id; node.onclick = action;
      this.addButtons.set(id, node); list.append(node);
    };
    add('current', uiText('用现在的模型'), () => void this.addFromCurrentModel());
    add('file', uiText('选模型文件'), () => void this.addFromModelFile());
    add('import', uiText('导入角色卡文件'), () => void this.addFromCardFile());
    add('blank', uiText('空白新建'), () => this.options.onBlank?.());
    root.append(list, element('small', 'hint', uiText('角色卡支持 soft hearts v1～v3 和 Tavern 格式。')));
    return root;
  }

  private paintSwitching(): void {
    const waiting = this.cardState?.switchingTo ?? this.view?.pendingSwitchId ?? null;
    for (const [id, tile] of this.tiles) {
      if (id === waiting) tile.status.textContent = uiText('等她说完这一句就换…');
      else if (tile.status.textContent === uiText('等她说完这一句就换…')) tile.status.textContent = '';
    }
  }

  private refreshButtons(): void {
    const count = this.view?.entries.length ?? 0, full = count >= MAX_CHARACTER_CARDS;
    for (const entry of this.view?.entries ?? []) {
      const tile = this.tiles.get(entry.id); if (!tile) continue;
      for (const button of tile.buttons.values()) button.disabled = this.busy;
      tile.buttons.get('switch')!.disabled ||= entry.active;
      tile.buttons.get('duplicate')!.disabled ||= full;
      tile.buttons.get('delete')!.disabled ||= count <= 1;
      tile.buttons.get('delete')!.title = count <= 1 ? uiText('至少保留一张角色卡') : '';
      // The preinstalled Gene goes with the preinstalled Gene model only (C1).
      for (const id of ['bind-current', 'bind-file']) {
        tile.buttons.get(id)!.disabled ||= entry.preset;
        tile.buttons.get(id)!.title = entry.preset ? uiText('预装的 Gene 卡只跟预装 Gene 模型走；想换模型可以先复制一张。') : '';
      }
      tile.buttons.get('avatar')!.disabled ||= !entry.active || !this.options.capture || !['ok', 'bundled'].includes(entry.model.state);
    }
    for (const [id, button] of this.addButtons) button.disabled = this.busy || (full && id !== 'blank');
  }

  private setStatus(message: string, id?: string): void {
    if (this.disposed) return;
    const tile = id ? this.tiles.get(id) : undefined;
    (tile?.status ?? this.status).textContent = message;
  }
  private error(error: unknown, id?: string): void {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus(message, id);
    this.options.onError(message);
  }
  private async operation(action: () => Promise<void>, id?: string): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true; this.refreshButtons();
    try { await action(); } catch (error) { this.error(error, id); }
    finally { if (!this.disposed) { this.busy = false; this.refreshButtons(); } }
  }
  private accept(state: CharacterCardState | null): void {
    if (!state || this.disposed) return;
    this.options.onState?.(state);
    this.applyCardState(state);
  }

  /** "换成她": no confirmation; switching back is one more click and loses nothing. */
  async switchTo(id: string): Promise<void> {
    await this.operation(async () => {
      this.setStatus(uiText('正在换成她…'), id);
      const state = await this.options.api.switchCharacter(id);
      this.accept(state);
      this.setStatus(state.activeId === id ? '' : uiText('已经换成了另一个角色。'), id);
    }, id);
  }
  private async bindCurrent(id: string): Promise<void> {
    await this.operation(async () => {
      this.accept(await this.options.api.bindCharacterModel(id, true));
      this.setStatus(uiText('已关联桌面上现在的模型。'), id);
    }, id);
  }
  private async bindFile(id: string): Promise<void> {
    await this.operation(async () => {
      const state = await this.options.api.bindCharacterModelFile(id);
      if (!state) return;
      this.accept(state);
      this.setStatus(uiText('已关联新的模型文件。'), id);
    }, id);
  }
  private async retakeAvatar(id: string): Promise<void> {
    const url = this.options.modelUrl?.() ?? '';
    await this.operation(async () => {
      if (!url || !this.options.capture) throw new Error(uiText('先换成她，再截头像。'));
      await this.saveAvatar(id, url);
      this.setStatus(uiText('头像已更新，只存在这台电脑上。'), id);
    }, id);
  }
  /** 复制: her persona, mood template and reactions; the model link and picture stay with the original. */
  private async duplicate(id: string): Promise<void> {
    await this.operation(async () => {
      const cards = await this.options.api.getCharacterCards();
      const source = cards.cards.find(card => card.id === id);
      if (!source) throw new Error(uiText('角色卡不存在。'));
      const { id: _id, modelName: _model, ...fields } = source;
      const draft: CharacterDraft = { ...fields, name: uiTemplate`${source.name} 副本`.slice(0, CHARACTER_TEXT_LIMITS.name) };
      const before = new Set(cards.cards.map(card => card.id));
      const state = await this.options.api.saveCharacterCard(draft);
      const created = state.cards.find(card => !before.has(card.id));
      this.accept(state);
      if (!created) throw new Error(uiText('未能确认复制出的角色，请重新读取角色卡。'));
      try { await this.options.api.copyCharacterResponse(id, created.id); }
      catch { this.options.onError(uiText('角色已复制，反应细调没能一起复制；可以在「心情和反应」里重试。')); }
      this.setStatus(uiText('已复制。'), created.id);
    }, id);
  }
  /**
   * C3 用角色卡文件更新…: the host opens the file and says what it would change; nothing is written until the user
   * presses "更新她的人设" on her tile. Same card, same id: her chats, diary, profile and familiarity stay hers.
   */
  private async previewUpdate(id: string): Promise<void> {
    await this.operation(async () => {
      const preview = await this.options.api.previewCharacterCardUpdate(id);
      if (!preview || this.disposed) return;
      if (this.pendingUpdate) void this.options.api.discardCharacterCardUpdate(this.pendingUpdate.token).catch(() => {});
      this.pendingUpdate = null;
      if (preview.summary.unchanged) {
        void this.options.api.discardCharacterCardUpdate(preview.token).catch(() => {});
        for (const tileId of this.tiles.keys()) this.paintUpdate(tileId);
        this.setStatus(uiText('文件里的人设和她现在的一模一样，不需要更新。'), id);
        return;
      }
      this.pendingUpdate = preview;
      for (const tileId of this.tiles.keys()) this.paintUpdate(tileId);
      this.tiles.get(id)?.root.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }, id);
  }
  private cancelUpdate(): void {
    const pending = this.pendingUpdate;
    if (!pending) return;
    this.pendingUpdate = null;
    void this.options.api.discardCharacterCardUpdate(pending.token).catch(() => {});
    this.paintUpdate(pending.id);
  }
  private async applyUpdate(id: string): Promise<void> {
    const pending = this.pendingUpdate;
    if (!pending || pending.id !== id) return;
    await this.operation(async () => {
      this.pendingUpdate = null;
      this.paintUpdate(id);
      const state = await this.options.api.applyCharacterCardUpdate(pending.token);
      this.accept(state);
      const name = state.cards.find(card => card.id === id)?.name ?? pending.summary.name.after;
      // On the page's own line too: the wall repaints after a card change.
      const message = uiTemplate`已更新「${name}」的人设；她的聊天、日记、画像和熟悉度都还在。`;
      this.setStatus(message, id); this.setStatus(message);
      if (state.notice) this.options.onError(state.notice);
      // I-018: Claude goes over what changed with the user (skippable; her chats are not part of it).
      void this.discuss(id, 'updated', pending.summary.changedFields);
    }, id);
  }
  private async exportCard(id: string): Promise<void> {
    await this.operation(async () => {
      if (await this.options.api.exportCharacterCard(id)) this.setStatus(uiText('角色卡已导出（不带头像、模型路径和记忆）。'), id);
    }, id);
  }
  private async remove(id: string, forgetMemories: boolean): Promise<void> {
    await this.operation(async () => {
      const state = await this.options.api.deleteCharacter(id, { forgetMemories });
      this.accept(state);
      this.setStatus(forgetMemories ? uiText('角色卡和她的记忆都删掉了。') : uiText('角色卡已删除，她的记忆还留着。'));
    }, id);
  }
  /** 新增 · 用现在的模型: a new card that goes with the model on stage; she becomes the current one. */
  private async addFromCurrentModel(): Promise<void> {
    await this.operation(async () => {
      const state = await this.options.api.createCharacterForCurrentModel();
      this.accept(state);
      this.options.onEdit?.(state.activeId);
    });
  }
  /** 新增 · 选模型文件: the model goes on stage and picks its card (C1): its own, a matching one, or a new one. */
  private async addFromModelFile(): Promise<void> {
    await this.operation(async () => {
      const asset = await this.options.api.selectAsset('model');
      if (asset) await this.refresh();
    });
  }
  /** 新增 · 导入角色卡文件 (soft hearts v1–v3, Tavern): a new card without a model; "换成她" uses the model on stage. */
  private async addFromCardFile(): Promise<void> {
    await this.operation(async () => {
      const before = new Set(this.view?.entries.map(entry => entry.id) ?? []);
      const state = await this.options.api.importCharacterCard();
      if (!state) return;
      this.accept(state);
      const created = state.cards.find(card => !before.has(card.id));
      this.setStatus(created ? uiTemplate`已导入「${created.name}」；点「换成她」开始陪你。` : uiText('角色卡已导入。'));
      // I-018: Claude says how it reads her before she starts (skippable; "换成她" works right away).
      if (created) void this.discuss(created.id, 'imported', [], created);
    });
  }
}
