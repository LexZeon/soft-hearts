/**
 * I-196: the small dot shown where a press on her began (the joystick's centre), with a faint ring the size of the dead zone.
 * It never takes the mouse (pointer-events: none) and holds no text. Shown while the press is held; hidden on release or cancel.
 */
export interface PullDotPorts { show(x: number, y: number): void; hide(): void }

export function createPullDot(doc: Document, deadZonePx: number): PullDotPorts {
  let root: HTMLElement | null = null;
  const make = (): HTMLElement => {
    const el = doc.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = `position:fixed;left:0;top:0;width:${deadZonePx * 2}px;height:${deadZonePx * 2}px;margin:${-deadZonePx}px 0 0 ${-deadZonePx}px;border-radius:50%;`
      + 'border:1px solid rgba(255,255,255,0.55);box-shadow:0 0 0 1px rgba(0,0,0,0.25);pointer-events:none;z-index:50;display:none;box-sizing:border-box;';
    const core = doc.createElement('div');
    core.style.cssText = 'position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgba(255,255,255,0.9);box-shadow:0 0 0 1px rgba(0,0,0,0.35);';
    el.appendChild(core);
    (doc.body ?? doc.documentElement).appendChild(el);
    return el;
  };
  return {
    show(x, y) { if (!Number.isFinite(x) || !Number.isFinite(y)) return; root ??= make(); root.style.transform = `translate(${x}px,${y}px)`; root.style.display = 'block'; },
    hide() { if (root) root.style.display = 'none'; },
  };
}
