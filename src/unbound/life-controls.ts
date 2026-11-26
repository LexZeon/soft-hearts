/**
 * Unbound v1 step 4: 「她自己的生活」 in the developer panel (src/unbound/control-switch.ts mounts it; the panel exists only in developer
 * mode, and the host refuses these requests outside it). What she does now and why nothing starts, "试一下" for each of her own
 * actions, "快进" (her day in a few minutes) and the starting numbers (this run only). Nothing here is a setting of the user's: the
 * user has no frequency knob (scope 定稿). Text via textContent only.
 */
import type { UnboundControlPatch, UnboundControlView } from '../../shared/unbound/scene';
import { LIFE_KNOB_RANGES, LIFE_KNOB_WORDS, type LifeKnobs } from '../../shared/unbound/life/mood-read';
import type { LifeView } from '../../shared/unbound/life/view';

const GAZE_WORDS: Record<LifeView['gaze'], string> = { peek: '凑过来的那一段', user: '你（你在和她互动）', facing: '你（你看着她，她看回来）', action: '她手上的小事', free: '没人管（走路、平常）' };

/** One line of what her own life is doing (plain words; never a program name). */
export function lifeWords(life: LifeView): string {
  const parts: string[] = [];
  parts.push(life.running ? `她在：${life.running.words}${life.running.easing ? '（收住中）' : ''}${life.running.trial ? '（试一下）' : ''}` : `现在不动：${life.why ?? '等时候'}`);
  parts.push(`视线归：${GAZE_WORDS[life.gaze]}`);
  if (life.doing) parts.push(`她读到：${life.doing}`);
  if (life.lastCue) parts.push(`刚注意到：${life.lastCue}`);
  if (life.rates) parts.push(`按心情：凑过来每小时 ${life.rates.peekPerHour} 次 · 换位置约 ${Math.round(life.rates.placeMinutes)} 分钟 · 小动作约 ${life.rates.smallMinutes.toFixed(1)} 分钟 · 停顿每分钟 ${life.rates.pausesPerMinute.toFixed(1)} 次`);
  if (life.fastForward) parts.push(`${life.fastForward.phase}（还剩 ${life.fastForward.leftS} 秒）`);
  return parts.join(' · ');
}

export class LifeControls {
  readonly root: HTMLElement;
  private readonly line: HTMLOutputElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly actions: HTMLElement;
  private readonly fast: HTMLButtonElement;
  private readonly knobs = new Map<keyof LifeKnobs, HTMLInputElement>();

  constructor(private readonly doc: Document, private readonly send: (patch: UnboundControlPatch) => Promise<void>) {
    this.root = doc.createElement('fieldset'); this.root.className = 'unbound-life';
    const legend = doc.createElement('legend'); legend.textContent = '她自己的生活（第 4 步）';
    const hint = doc.createElement('p');
    hint.textContent = '她自己换位置、换重心、回头看你、待机里停一下；凑过来也归这里排队。多久一次由她的心情和你在做什么定（下面是起点数字，只在这次运行有效）。“快进”把她的一天压成 6 分钟：你在忙、你停下来、她困了、平常，各一段。有了这里，凑过来的“每小时最多”改由心情给。';
    this.line = doc.createElement('output'); this.line.style.display = 'block';
    this.actions = doc.createElement('div');
    this.fast = doc.createElement('button'); this.fast.type = 'button'; this.fast.textContent = '快进她的一天';
    this.fast.addEventListener('click', () => void this.send({ lifeFast: this.fast.dataset.on !== '1' }));
    const knobBox = doc.createElement('div');
    for (const key of Object.keys(LIFE_KNOB_RANGES) as (keyof LifeKnobs)[]) {
      const [min, max] = LIFE_KNOB_RANGES[key];
      const input = doc.createElement('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = key.startsWith('peek') ? '1' : '0.5'; input.style.width = '5em';
      input.addEventListener('change', () => { const value = Number(input.value); if (Number.isFinite(value) && value >= min && value <= max) void this.send({ lifeKnobs: { [key]: value } }); });
      const label = doc.createElement('label'); label.style.display = 'inline-block'; label.style.marginRight = '1em';
      label.append(doc.createTextNode(`${LIFE_KNOB_WORDS[key]} `), input);
      knobBox.append(label);
      this.knobs.set(key, input);
    }
    this.root.append(legend, hint, this.line, this.actions, this.fast, knobBox);
  }

  render(view: UnboundControlView): void {
    const life = view.life;
    this.root.hidden = !life;
    if (!life) return;
    this.line.textContent = lifeWords(life);
    for (const action of life.actions) {
      let button = this.buttons.get(action.id);
      if (!button) {
        button = this.doc.createElement('button'); button.type = 'button';
        button.addEventListener('click', () => void this.send({ lifeTry: action.id }));
        this.buttons.set(action.id, button); this.actions.append(button);
      }
      button.textContent = `试一下：${action.words}`;
      button.title = action.notNow ? `她自己现在不会做：${action.notNow}` : action.inS !== null ? `她自己大约 ${action.inS} 秒后想做` : '';
      button.disabled = view.state !== 'unbound' || !!life.running;
    }
    this.fast.dataset.on = life.fastForward ? '1' : '0';
    this.fast.textContent = life.fastForward ? '停止快进' : '快进她的一天';
    this.fast.disabled = view.state !== 'unbound';
    for (const [key, input] of this.knobs) if (input.ownerDocument.activeElement !== input) input.value = String(life.knobs[key]);
  }
}
