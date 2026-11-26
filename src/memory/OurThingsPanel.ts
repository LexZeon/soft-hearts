/**
 * I-086 我们的小东西 (control window, 记忆页): what you fed her and what she gave you, by date. All text is textContent; the host sends
 * plain views (shared/initiative/our-things.ts OurThingsView: no file names, no paths). A picture is fetched by the record's id; "存下来" asks
 * the host, which opens the native save dialog. Deleting removes the record and its picture.
 */
import { registerUiMessages } from '../../shared/foundation/ui-language';
import type { OurThingView, OurThingsView } from '../../shared/initiative';
import { uiText } from '../foundation/ui-language';
import { RecentlyDeleted, type RecycleApi } from '../foundation/recently-deleted';

registerUiMessages({
  en: {
    '我们的小东西': 'Our little things', '你喂她的点心，和她递给你的点心、靠垫、她留给你的图，按日子攒在这里。只存在这台电脑上的应用配置里；开着"她的文件夹"时也写一份进去。':
      'The snacks you fed her, and the snacks, the cushion and the pictures she gave you, kept here by date. Only in the app’s profile on this computer; with her folder on, a copy goes there too.',
    '你喂她的': 'You fed her', '她给你的': 'She gave you', '点心': 'snack', '靠垫': 'cushion', '一张图': 'a picture', '你接住了': 'you took it', '你没顾上接': 'you were busy',
    '删掉': 'Delete', '存下来': 'Save', '收好了': 'Saved', '还没有攒下什么。喂她点心（开着"允许记录"时），或者等她哪天递点什么给你。': 'Nothing yet. Feed her a snack (with recording on), or wait for her to hand you something.',
    '正在读取…': 'Reading…', '共 {0} 件': '{0} in all', '开关、点心和她给你的东西': 'Snacks and what she gave you',
    '你们俩': 'The two of you', '第一次牵手': 'held hands for the first time',
  },
  'zh-CN': {},
});

type Tr = (source: string, ...values: readonly unknown[]) => string;

/** One record's words: who gave what, and her line. Pure, for tests. */
export function ourThingWords(item: OurThingView, tr: Tr = uiText): { who: string; what: string; how: string; line: string } {
  // I-087: the first time you held hands is both of yours: no "who", no "taken".
  if (item.kind === 'first-hold') return { who: tr('你们俩'), what: tr('第一次牵手'), how: '', line: item.line };
  const what = item.kind === 'snack' ? (item.name ? `${tr('点心')} · ${item.name}` : tr('点心')) : tr(item.kind === 'cushion' ? '靠垫' : '一张图');
  const how = item.dir === 'gave' && item.taken !== undefined ? tr(item.taken ? '你接住了' : '你没顾上接') : '';
  return { who: tr(item.dir === 'fed' ? '你喂她的' : '她给你的'), what, how, line: item.line };
}

/** The records grouped by local date, newest day first (the view is already newest first). */
export function ourThingsByDay(items: readonly OurThingView[]): { day: string; items: OurThingView[] }[] {
  const out: { day: string; items: OurThingView[] }[] = [];
  for (const item of items) {
    const d = new Date(item.at), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const last = out.at(-1);
    if (last?.day === day) last.items.push(item); else out.push({ day, items: [item] });
  }
  return out;
}

export interface OurThingsPorts {
  get(): Promise<OurThingsView>;
  picture(id: string): Promise<string | null>;
  remove(id: string): Promise<OurThingsView>;
  save(id: string): Promise<boolean>;
  changed(callback: (view: OurThingsView) => void): () => void;
  error(message: string): void;
  /** I-144b 回收站: 「最近删除的」 under the list (a deleted one goes into the bin with its picture). Without both, no such list. */
  recycle?: RecycleApi;
  currentCharacterId?(): string;
}

export class OurThingsPanel {
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly pictures = new Map<string, string>();
  private recentlyDeleted: RecentlyDeleted | null = null;
  constructor(private readonly root: HTMLElement, private readonly ports: OurThingsPorts) {
    const title = document.createElement('h3'); title.textContent = uiText('我们的小东西');
    const note = document.createElement('p'); note.className = 'hint';
    note.textContent = uiText('你喂她的点心，和她递给你的点心、靠垫、她留给你的图，按日子攒在这里。只存在这台电脑上的应用配置里；开着"她的文件夹"时也写一份进去。');
    this.status = document.createElement('p'); this.status.className = 'hint'; this.status.textContent = uiText('正在读取…');
    this.list = document.createElement('div'); this.list.className = 'our-things-list';
    const recycleBox = document.createElement('div');
    root.replaceChildren(title, note, this.status, this.list, recycleBox);
    if (ports.recycle && ports.currentCharacterId) {
      this.recentlyDeleted = new RecentlyDeleted(recycleBox, { api: ports.recycle, kinds: ['our-thing'], characterId: ports.currentCharacterId,
        onRestored: () => { void ports.get().then(view => this.render(view)).catch(error => ports.error(String(error))); }, onError: message => ports.error(message) });
      void this.recentlyDeleted.init();
    } else recycleBox.hidden = true;
    ports.changed(view => this.render(view));
    void ports.get().then(view => this.render(view)).catch(error => ports.error(String(error)));
  }

  private render(view: OurThingsView): void {
    this.status.textContent = view.items.length ? uiText('共 {0} 件', String(view.items.length))
      : uiText('还没有攒下什么。喂她点心（开着"允许记录"时），或者等她哪天递点什么给你。');
    const nodes: HTMLElement[] = [];
    for (const group of ourThingsByDay(view.items)) {
      const day = document.createElement('h4'); day.className = 'our-things-day'; day.textContent = group.day;
      nodes.push(day);
      for (const item of group.items) nodes.push(this.row(item));
    }
    this.list.replaceChildren(...nodes);
  }

  private row(item: OurThingView): HTMLElement {
    const words = ourThingWords(item);
    const row = document.createElement('div'); row.className = `our-thing our-thing-${item.dir}`;
    if (item.picture) {
      const image = document.createElement('img'); image.className = 'our-thing-picture'; image.alt = words.what;
      const known = this.pictures.get(item.id);
      if (known) image.src = known;
      else void this.ports.picture(item.id).then(src => { if (src) { this.pictures.set(item.id, src); image.src = src; } }).catch(() => {});
      row.append(image);
    }
    const text = document.createElement('div'); text.className = 'our-thing-text';
    const head = document.createElement('div'); head.textContent = [words.who, words.what, words.how].filter(Boolean).join(' · ');
    text.append(head);
    if (words.line) { const line = document.createElement('div'); line.className = 'our-thing-line'; line.textContent = `"${words.line}"`; text.append(line); }
    row.append(text);
    const actions = document.createElement('div'); actions.className = 'our-thing-actions';
    if (item.picture) {
      const save = document.createElement('button'); save.type = 'button'; save.textContent = uiText('存下来');
      save.onclick = () => void this.ports.save(item.id).then(saved => { if (saved) save.textContent = uiText('收好了'); }).catch(error => this.ports.error(String(error)));
      actions.append(save);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = uiText('删掉');
    remove.onclick = () => void this.ports.remove(item.id).then(view => { this.pictures.delete(item.id); this.render(view); }).catch(error => this.ports.error(String(error)));
    actions.append(remove);
    row.append(actions);
    return row;
  }
}
