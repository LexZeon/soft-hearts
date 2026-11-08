// I-037 新的反应方式 in the control window: the switch in 「隐私与设置」 (on by default in every version, 2026-11-07) and the
// current character's six 反应倾向 on the 角色页 (decided with the user, kept per character id, never in the card).
import { registerUiMessages } from '../../shared/ui-language';
import type { DispositionId } from '../../shared/behaviors/reactions/dispositions';
import type { ReactionDispositionsView, ReactionSwitchView, ReactionsBroadcast } from '../../shared/behaviors/reactions/views';
import { uiText } from './ui-language';

registerUiMessages({
  en: {
    '新的反应方式（试用）': 'New way of reacting (trial)',
    '被夸、报喜、撒娇、被关心、摸头、捏脸、喂点心时，她按自己的性格更敏感地反应': 'Praise, good news, coaxing, care, a pat, a pinch, a snack: she reacts more readily, by her own nature',
    '你每发一句话，你 Claude 里的 haiku 会和她的回答同时看一眼（第一个字照样马上出来），从反应清单里替她挑 0～2 个反应（脸红、害羞、开心、点头、比心……），再给这句话的心情变化（haiku 七成、她自己回复里的判断三成）。摸头、捏脸、喂点心不问 haiku，直接按分数做。会用你的 Claude 用量：每句话最多一次；上限每天 {0} 次打底，你每和她聊一句多 {1} 次，最多 {2} 次，超了当天只按她回复的语气挑。打开时「心情调整员」不再重复看你的消息。':
      'Each time you send a message, haiku in your Claude looks at it alongside her reply (her first character still comes at once), picks 0–2 reactions for her from the reaction list (blush, shy, happy, a nod, heart hands…) and gives the message’s mood change (70% haiku, 30% her own reply’s judgement). A pat, a pinch or a snack never asks haiku; the top score plays. It uses your Claude quota: at most one call per message; the daily limit starts at {0}, grows by {1} per message, and never goes above {2}; past it, only the tone of her reply is used. While on, the mood adjuster no longer reads your messages again.',
    '正在读取…': 'Loading…', '正在切换…': 'Switching…',
    '已开启 · 今天问了 {0} 次，最多 {1} 次': 'On · asked {0} times today, at most {1}', '已关闭 · 反应照原来的规则': 'Off · reactions follow the old rules',
    '（还没选过：这个版本默认{0}）': ' (not chosen yet: this version defaults to {0})', '开': 'on', '关': 'off',
    '她的反应倾向': 'Her reaction tendencies',
    '这六项决定她对你的话和动作有多敏感（50 一般）。只属于当前角色，存在本机，不写进角色卡；拖动马上生效。': 'These six set how readily she reacts to your words and touches (50 is ordinary). They belong to the current character, stay on this computer and are not written into the card; changes apply at once.',
    '现在用的是从角色卡推出来的值': 'Now using the values derived from her character card', '现在用的是你们定的值': 'Now using the values you set',
    '按角色卡推算': 'Use the card’s values', '还没有角色。': 'No character yet.',
    // shared/behaviors/reactions/dispositions.ts DISPOSITIONS
    '害羞': 'Shy', '黏人': 'Clingy', '活泼': 'Lively', '好哄': 'Easily soothed', '情绪起伏': 'Mood swings', '克制': 'Restrained',
    '被夸、被摸头、被捏脸时多容易脸红、低头害羞。': 'How easily she blushes or looks down shyly when praised, patted or pinched.',
    '多想亲近你：撒娇、比心这类亲近的反应。': 'How much she wants to be close: coaxing, heart hands and other close reactions.',
    '多爱用小动作表达：鼓掌、挥手、眨眼、歪头。': 'How much she uses small actions: clapping, waving, winking, tilting her head.',
    '被关心、被哄、听到好消息时多容易开心起来。': 'How easily she brightens up when cared for, soothed or told good news.',
    '反应来得多快多大：起伏大的人一点小事也会有反应。': 'How fast and how big her reactions are: with big swings, small things move her too.',
    '多会把反应收着：克制的人动作少、表情轻一点。': 'How much she holds her reactions in: a restrained one moves less and shows a lighter face.',
  },
  'zh-CN': {},
});

export interface ReactionsPanelPorts {
  get(): Promise<ReactionSwitchView>;
  set(enabled: boolean): Promise<ReactionSwitchView>;
  changed?(callback: (view: ReactionsBroadcast) => void): () => void;
  error?(message: string): void;
}

export function reactionsStatus(view: ReactionSwitchView | null, busy = false): string {
  if (busy) return uiText('正在切换…');
  if (!view) return uiText('正在读取…');
  const base = view.enabled ? uiText('已开启 · 今天问了 {0} 次，最多 {1} 次', view.today, view.cap) : uiText('已关闭 · 反应照原来的规则');
  return view.chosen ? base : base + uiText('（还没选过：这个版本默认{0}）', uiText(view.defaultEnabled ? '开' : '关'));
}

/** 隐私与设置: the switch. */
export class ReactionsPanel {
  private readonly toggle: HTMLInputElement;
  private readonly status: HTMLParagraphElement;
  private readonly hint: HTMLElement;
  private view: ReactionSwitchView | null = null;
  private busy = false;
  private readonly unsubscribe: (() => void) | null;

  constructor(root: HTMLElement, private readonly ports: ReactionsPanelPorts) {
    const doc = root.ownerDocument;
    const heading = doc.createElement('h3'); heading.textContent = uiText('新的反应方式（试用）');
    const row = doc.createElement('label'); row.className = 'toggle-row';
    const copy = doc.createElement('span');
    const title = doc.createElement('strong'); title.textContent = uiText('被夸、报喜、撒娇、被关心、摸头、捏脸、喂点心时，她按自己的性格更敏感地反应');
    this.hint = doc.createElement('small');
    copy.append(title, this.hint);
    this.toggle = doc.createElement('input');
    this.toggle.type = 'checkbox'; this.toggle.id = 'reactions-enabled'; this.toggle.setAttribute('role', 'switch'); this.toggle.disabled = true;
    this.toggle.onchange = () => { void this.set(this.toggle.checked); };
    row.append(copy, this.toggle);
    this.status = doc.createElement('p'); this.status.className = 'hint'; this.status.setAttribute('role', 'status');
    root.replaceChildren(heading, row, this.status);
    let off: (() => void) | null = null;
    try { off = ports.changed?.(view => { this.view = view.switch; this.render(); }) ?? null; } catch { off = null; }
    this.unsubscribe = off;
    this.render();
    void ports.get().then(view => { this.view = view; this.render(); }, error => { this.ports.error?.(String(error)); this.render(); });
  }

  dispose(): void { this.unsubscribe?.(); }

  private async set(enabled: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try { this.view = await this.ports.set(enabled); }
    catch (error) { this.ports.error?.(String(error)); }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    this.toggle.checked = !!this.view?.enabled;
    this.toggle.disabled = !this.view || this.busy;
    this.hint.textContent = uiText('你每发一句话，你 Claude 里的 haiku 会和她的回答同时看一眼（第一个字照样马上出来），从反应清单里替她挑 0～2 个反应（脸红、害羞、开心、点头、比心……），再给这句话的心情变化（haiku 七成、她自己回复里的判断三成）。摸头、捏脸、喂点心不问 haiku，直接按分数做。会用你的 Claude 用量：每句话最多一次；上限每天 {0} 次打底，你每和她聊一句多 {1} 次，最多 {2} 次，超了当天只按她回复的语气挑。打开时「心情调整员」不再重复看你的消息。',
      this.view?.base ?? 120, this.view?.perChat ?? 2, this.view?.max ?? 800);
    this.status.textContent = reactionsStatus(this.view, this.busy);
  }
}

export interface ReactionDispositionsPanelPorts {
  get(): Promise<ReactionDispositionsView>;
  set(values: Partial<Record<DispositionId, number>> | null): Promise<ReactionDispositionsView>;
  changed?(callback: (view: ReactionsBroadcast) => void): () => void;
  error?(message: string): void;
}

/** 角色页: six sliders for the current character, and 「按角色卡推算」. */
export class ReactionDispositionsPanel {
  private readonly list: HTMLDivElement;
  private readonly status: HTMLParagraphElement;
  private readonly reset: HTMLButtonElement;
  private view: ReactionDispositionsView | null = null;
  private readonly inputs = new Map<DispositionId, { input: HTMLInputElement; value: HTMLOutputElement }>();
  private pending: Partial<Record<DispositionId, number>> = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribe: (() => void) | null;

  constructor(root: HTMLElement, private readonly ports: ReactionDispositionsPanelPorts) {
    const doc = root.ownerDocument;
    const heading = doc.createElement('h3'); heading.textContent = uiText('她的反应倾向');
    const intro = doc.createElement('p'); intro.className = 'hint';
    intro.textContent = uiText('这六项决定她对你的话和动作有多敏感（50 一般）。只属于当前角色，存在本机，不写进角色卡；拖动马上生效。');
    this.list = doc.createElement('div'); this.list.className = 'reaction-dispositions';
    this.status = doc.createElement('p'); this.status.className = 'hint'; this.status.setAttribute('role', 'status');
    this.reset = doc.createElement('button'); this.reset.type = 'button'; this.reset.className = 'subtle'; this.reset.id = 'reaction-dispositions-reset';
    this.reset.textContent = uiText('按角色卡推算');
    this.reset.onclick = () => { void this.apply(null); };
    root.replaceChildren(heading, intro, this.list, this.status, this.reset);
    let off: (() => void) | null = null;
    try { off = ports.changed?.(view => { this.view = view.dispositions; this.render(); }) ?? null; } catch { off = null; }
    this.unsubscribe = off;
    // The character may change while the control window is open: read again when it comes back into focus.
    root.ownerDocument.defaultView?.addEventListener('focus', () => { void this.refresh(); });
    this.render();
    void this.refresh();
  }

  dispose(): void { this.unsubscribe?.(); if (this.timer) clearTimeout(this.timer); }

  private async refresh(): Promise<void> {
    try { this.view = await this.ports.get(); } catch (error) { this.ports.error?.(String(error)); }
    this.render();
  }

  private async apply(values: Partial<Record<DispositionId, number>> | null): Promise<void> {
    try { this.view = await this.ports.set(values); } catch (error) { this.ports.error?.(String(error)); }
    this.render();
  }

  private render(): void {
    const view = this.view, doc = this.list.ownerDocument;
    if (!view?.characterId || !view.values) {
      this.list.replaceChildren(); this.inputs.clear();
      this.status.textContent = view ? uiText('还没有角色。') : uiText('正在读取…');
      this.reset.disabled = true;
      return;
    }
    if (this.inputs.size !== view.items.length) {
      this.inputs.clear();
      const rows = view.items.map(item => {
        const row = doc.createElement('label'); row.className = 'field';
        const name = doc.createElement('span'); name.textContent = uiText(item.label);
        const input = doc.createElement('input'); input.type = 'range'; input.min = '0'; input.max = '100'; input.step = '1'; input.id = `reaction-disposition-${item.id}`;
        const value = doc.createElement('output'); value.htmlFor.add(input.id);
        const hint = doc.createElement('small'); hint.className = 'hint'; hint.textContent = uiText(item.hint);
        input.oninput = () => { value.textContent = input.value; };
        input.onchange = () => {
          this.pending[item.id] = Number(input.value);
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => { this.timer = null; const values = this.pending; this.pending = {}; void this.apply(values); }, 250);
        };
        row.append(name, input, value, hint);
        this.inputs.set(item.id, { input, value });
        return row;
      });
      this.list.replaceChildren(...rows);
    }
    for (const [id, { input, value }] of this.inputs) {
      const n = view.values[id];
      if (doc.activeElement !== input) input.value = String(n);
      value.textContent = String(n);
    }
    this.status.textContent = uiText(view.stored ? '现在用的是你们定的值' : '现在用的是从角色卡推出来的值');
    this.reset.disabled = !view.stored;
  }
}
