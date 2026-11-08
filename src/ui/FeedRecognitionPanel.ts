// I-019 in the control window's 「隐私与设置」: the switch "喂食时让她认出是什么" (default on: the user decided on 2026-11-03
// that the first feed does not ask). Off: she eats exactly as before and the picture never leaves the pet window.
import { registerUiMessages } from '../../shared/ui-language';
import type { FeedRecognitionView } from '../../shared/feed-recognition';
import { uiText } from './ui-language';

registerUiMessages({
  en: {
    '喂食认图': 'Recognizing snacks',
    '喂食时让她认出是什么': 'Let her recognize what you feed her',
    '图会缩小后交给你的 Claude：小模型看一眼认出是什么、她爱不爱吃，她再用自己的口吻说一句。图不保存、不进聊天记录；聊天里只记她那句话和吃的名字。关掉后和以前一样，只吃不认。':
      'The picture is shrunk and handed to your Claude: a small model sees what it is and whether she likes it, then she says a line in her own voice. The picture is never saved or added to chat; chat keeps only her line and the food’s name. Off: she just eats, as before.',
    '正在读取…': 'Loading…', '正在切换…': 'Switching…', '已开启 · 每次喂食都会认': 'On · every feed is recognized', '已关闭 · 只吃不认': 'Off · she just eats',
  },
  'zh-CN': {},
});

export interface FeedRecognitionPanelPorts {
  get(): Promise<FeedRecognitionView>;
  set(enabled: boolean): Promise<FeedRecognitionView>;
  changed?(callback: (view: FeedRecognitionView) => void): () => void;
  error?(message: string): void;
}

export function feedRecognitionStatus(view: FeedRecognitionView | null, busy = false): string {
  if (busy) return uiText('正在切换…');
  if (!view) return uiText('正在读取…');
  return view.enabled ? uiText('已开启 · 每次喂食都会认') : uiText('已关闭 · 只吃不认');
}

export class FeedRecognitionPanel {
  private readonly toggle: HTMLInputElement;
  private readonly status: HTMLParagraphElement;
  private view: FeedRecognitionView | null = null;
  private busy = false;
  private readonly unsubscribe: (() => void) | null;

  constructor(root: HTMLElement, private readonly ports: FeedRecognitionPanelPorts) {
    const doc = root.ownerDocument;
    const heading = doc.createElement('h3'); heading.textContent = uiText('喂食认图');
    const row = doc.createElement('label'); row.className = 'toggle-row';
    const copy = doc.createElement('span');
    const title = doc.createElement('strong'); title.textContent = uiText('喂食时让她认出是什么');
    const hint = doc.createElement('small');
    hint.textContent = uiText('图会缩小后交给你的 Claude：小模型看一眼认出是什么、她爱不爱吃，她再用自己的口吻说一句。图不保存、不进聊天记录；聊天里只记她那句话和吃的名字。关掉后和以前一样，只吃不认。');
    copy.append(title, hint);
    this.toggle = doc.createElement('input');
    this.toggle.type = 'checkbox'; this.toggle.id = 'feed-recognition-enabled'; this.toggle.setAttribute('role', 'switch'); this.toggle.disabled = true;
    this.toggle.onchange = () => { void this.set(this.toggle.checked); };
    row.append(copy, this.toggle);
    this.status = doc.createElement('p'); this.status.className = 'hint'; this.status.setAttribute('role', 'status');
    root.replaceChildren(heading, row, this.status);
    let off: (() => void) | null = null;
    try { off = ports.changed?.(view => { this.view = view; this.render(); }) ?? null; } catch { off = null; }
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
    this.status.textContent = feedRecognitionStatus(this.view, this.busy);
  }
}
