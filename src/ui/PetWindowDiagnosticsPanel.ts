import type { PetWindowDiagnosticsView } from '../../shared/contracts';
import { uiText } from './ui-language';

/** One readable line per entry; values are window facts only (booleans, numbers, short reasons). */
export function formatPetWindowDiagnostics(view: PetWindowDiagnosticsView): string {
  if (!view.enabled) return uiText('开发者模式关闭时不记录桌宠窗口诊断。');
  if (!view.entries.length) return uiText('还没有记录。启动、显示或一键恢复桌宠后再刷新。');
  return view.entries.map(entry => {
    const detail = Object.entries(entry.detail).map(([key, value]) => `${key}=${value}`).join(' ');
    return `${(entry.t / 1000).toFixed(2)}s ${entry.event}${detail ? ` ${detail}` : ''}`;
  }).join('\n');
}

/** Developer-only view of the host's bounded pet window log (R37). */
export class PetWindowDiagnosticsPanel {
  private readonly output: HTMLPreElement;
  private readonly refreshButton: HTMLButtonElement;
  constructor(parent: HTMLElement, private readonly load: () => Promise<PetWindowDiagnosticsView>) {
    const doc = parent.ownerDocument;
    const details = doc.createElement('details'); details.className = 'pet-window-diagnostics';
    const summary = doc.createElement('summary'); summary.textContent = uiText('桌宠窗口诊断');
    const hint = doc.createElement('p');
    hint.textContent = uiText('记录桌宠窗口的显示、隐藏、最小化、位置与画面状态，用于排查“看不见桌宠”。只在开发者模式下记录，不含聊天、设置或文件路径。');
    this.refreshButton = doc.createElement('button'); this.refreshButton.type = 'button';
    this.refreshButton.id = 'pet-window-diagnostics-refresh'; this.refreshButton.textContent = uiText('刷新诊断');
    this.refreshButton.addEventListener('click', () => void this.refresh());
    this.output = doc.createElement('pre'); this.output.id = 'pet-window-diagnostics-log';
    details.addEventListener('toggle', () => { if (details.open) void this.refresh(); });
    details.append(summary, hint, this.refreshButton, this.output);
    parent.append(details);
  }
  async refresh(): Promise<void> {
    this.refreshButton.disabled = true;
    try { this.output.textContent = formatPetWindowDiagnostics(await this.load()); }
    catch (error) { this.output.textContent = String(error); }
    finally { this.refreshButton.disabled = false; }
  }
}
