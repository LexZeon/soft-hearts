// R01 物理调参台: the button in the control window's developer panel (shown only in developer mode, like the panel). The host
// opens the lab only from the control window and only in developer mode (electron/wiring/physics-lab-wiring.ts).
import { uiText } from '../../foundation/ui-language';

export function mountPhysicsLabButton(parent: HTMLElement | null): HTMLButtonElement | null {
  const desktop = (globalThis as { window?: { desktop?: { openPhysicsLab?: () => Promise<boolean> } } }).window?.desktop;
  if (!parent || typeof desktop?.openPhysicsLab !== 'function') return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mood-physics-lab';
  button.textContent = uiText('物理调参台');
  button.title = uiText('打开物理调参台：分组调头发和胸部的物理参数，看实时数字，按模型保存');
  button.addEventListener('click', () => {
    button.disabled = true;
    void desktop.openPhysicsLab!().catch(() => {}).finally(() => { button.disabled = false; });
  });
  parent.append(button);
  return button;
}
