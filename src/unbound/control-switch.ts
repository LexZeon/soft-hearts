/**
 * Unbound U1: 「Unbound（试验）」 in the control window's developer panel (src/mood/MoodCompanion.ts mounts it; the panel is shown
 * only in developer mode, and the host refuses entering outside it). The switch, two knobs for her world (how far she stands
 * behind the screen, how far you sit from it), the floor-grid overlay, and one status line. Text via textContent only.
 */
import { UNBOUND_BODY_RANGES, type UnboundControlPatch, type UnboundControlView, type UnboundStance } from '../../shared/unbound/scene';
import { PEEK_KNOB_RANGES, type PeekView } from '../../shared/unbound/director';
import { LifeControls } from './life-controls';
import { WindowStyleSlider } from './window-style-slider';
import { uiText } from '../foundation/ui-language';

export interface UnboundControlApi {
  getUnbound(): Promise<UnboundControlView>;
  setUnbound(patch: UnboundControlPatch): Promise<UnboundControlView>;
  onUnbound(callback: (view: UnboundControlView) => void): () => void;
}

const STATE_WORDS: Record<UnboundControlView['state'], string> = { normal: '普通模式', entering: '正在进入…', unbound: '已进入 Unbound' };

/** One status line from the view (plain words and numbers). */
export function unboundStatusLine(view: UnboundControlView): string {
  const parts = [STATE_WORDS[view.state]];
  if (view.fullscreen) parts.push(uiText('有全屏程序在前面（她照样在上面）')); // I-199: information only
  if (view.screen) parts.push(`屏幕 ${view.screen.widthCm.toFixed(1)}×${view.screen.heightCm.toFixed(1)} cm（${view.screen.source === 'measured' ? '显示器报告' : view.screen.source === 'override' ? '手动' : '按 96 DPI 估计'}）`);
  const rt = view.stats?.roundTripMs;
  if (rt) parts.push(`穿透切换往返 p50 ${rt.p50.toFixed(1)} / p95 ${rt.p95.toFixed(1)} ms（${rt.n} 次）`);
  if (view.stats?.fps) parts.push(`${view.stats.fps.toFixed(0)} fps`);
  if (view.error) parts.push(`上次没进去：${view.error}`);
  const peek = view.peek;
  if (peek && view.state === 'unbound') parts.push(peekWords(peek));
  return parts.join(' · ');
}

export class UnboundSwitch {
  private readonly root: HTMLDetailsElement;
  private readonly active: HTMLInputElement;
  private readonly depth: HTMLInputElement;
  private readonly depthOut: HTMLOutputElement;
  private readonly viewer: HTMLInputElement;
  private readonly debug: HTMLInputElement;
  private readonly speech: HTMLInputElement;
  private readonly speed: HTMLInputElement;
  private readonly speedOut: HTMLOutputElement;
  private readonly step: HTMLInputElement;
  private readonly stepOut: HTMLOutputElement;
  private readonly stance: HTMLSelectElement;
  private readonly status: HTMLOutputElement;
  private readonly peek: PeekControls;
  private readonly life: LifeControls;
  private busy = false;

  constructor(parent: HTMLElement, private readonly api: UnboundControlApi) {
    const doc = parent.ownerDocument;
    const text = (tag: 'summary' | 'p' | 'label', value: string) => { const node = doc.createElement(tag); node.textContent = value; return node; };
    const input = (type: string, id: string, attributes: Record<string, string> = {}) => {
      const node = doc.createElement('input'); node.type = type; node.id = id;
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      return node;
    };
    this.root = doc.createElement('details'); this.root.className = 'unbound-switch';
    const summary = text('summary', 'Unbound（试验）');
    const hint = text('p', '她离开桌宠小窗，站进屏幕后面的世界：离得远就小，凑近就大；拉“她离屏幕”她会走过去。点不到她的地方，鼠标照常点到下面的窗口。只在开发者模式下可用；关掉这里、关掉开发者模式或退出应用，都会回到普通桌宠。');
    this.active = input('checkbox', 'unbound-active');
    const activeLabel = text('label', ''); activeLabel.append(this.active, doc.createTextNode(' 进入 Unbound'));
    this.depth = input('range', 'unbound-depth', { min: '0.6', max: '15', step: '0.1' });
    this.depthOut = doc.createElement('output');
    const depthLabel = text('label', '她离屏幕 '); depthLabel.append(this.depth, this.depthOut, doc.createTextNode(' 米'));
    this.viewer = input('number', 'unbound-viewer', { min: '30', max: '120', step: '1' });
    const viewerLabel = text('label', '你离屏幕 '); viewerLabel.append(this.viewer, doc.createTextNode(' 厘米'));
    const [s0, s1] = UNBOUND_BODY_RANGES.walkSpeedMps, [l0, l1] = UNBOUND_BODY_RANGES.stepLengthM;
    this.speed = input('range', 'unbound-walk-speed', { min: String(s0), max: String(s1), step: '0.05' });
    this.speedOut = doc.createElement('output');
    const speedLabel = text('label', '走路速度 '); speedLabel.append(this.speed, this.speedOut, doc.createTextNode(' 米/秒'));
    this.step = input('range', 'unbound-step-length', { min: String(l0 * 100), max: String(l1 * 100), step: '1' });
    this.stepOut = doc.createElement('output');
    const stepLabel = text('label', '步长 '); stepLabel.append(this.step, this.stepOut, doc.createTextNode(' 厘米'));
    this.stance = doc.createElement('select'); this.stance.id = 'unbound-stance';
    for (const [value, words] of [['both', '双脚'], ['left', '左脚单脚站'], ['right', '右脚单脚站']] as const) {
      const option = doc.createElement('option'); option.value = value; option.textContent = words; this.stance.append(option);
    }
    const stanceLabel = text('label', '站姿 '); stanceLabel.append(this.stance);
    this.debug = input('checkbox', 'unbound-debug');
    const debugLabel = text('label', ''); debugLabel.append(this.debug, doc.createTextNode(' 地面网格和数字'));
    // E3 (docs/claude/2026-11-14-unbound-night-e3-speech.md): experiment, off by default, this run only.
    this.speech = input('checkbox', 'unbound-speech-beat');
    const speechLabel = text('label', ''); speechLabel.append(this.speech, doc.createTextNode(' 试验：开口前先看你、停半拍，气泡出来时轻轻点头'));
    this.status = doc.createElement('output'); this.status.id = 'unbound-status';
    for (const label of [activeLabel, depthLabel, viewerLabel, speedLabel, stepLabel, stanceLabel, debugLabel, speechLabel]) label.style.display = 'block';
    this.peek = new PeekControls(doc, patch => this.send(patch));
    this.life = new LifeControls(doc, patch => this.send(patch)); // step 4: her own life (src/unbound/life-controls.ts)
    const windowEngine = new WindowStyleSlider(doc); // I-154 / I-176: 「个人感」 (src/unbound/window-style-slider.ts)
    this.root.append(summary, hint, activeLabel, depthLabel, viewerLabel, speedLabel, stepLabel, stanceLabel, debugLabel, speechLabel, this.peek.root, this.life.root, windowEngine.root, this.status);
    this.speech.addEventListener('change', () => void this.send({ speechBeat: this.speech.checked }));
    parent.append(this.root);
    this.active.addEventListener('change', () => void this.send({ active: this.active.checked }));
    this.depth.addEventListener('input', () => { this.depthOut.textContent = Number(this.depth.value).toFixed(1); });
    this.depth.addEventListener('change', () => void this.send({ depthM: Number(this.depth.value) }));
    this.viewer.addEventListener('change', () => { const cm = Math.round(Number(this.viewer.value)); if (cm >= 30 && cm <= 120) void this.send({ viewerDistanceCm: cm }); });
    this.debug.addEventListener('change', () => void this.send({ debug: this.debug.checked }));
    this.speed.addEventListener('input', () => { this.speedOut.textContent = Number(this.speed.value).toFixed(2); });
    this.speed.addEventListener('change', () => void this.send({ walkSpeedMps: Number(this.speed.value) }));
    this.step.addEventListener('input', () => { this.stepOut.textContent = String(Math.round(Number(this.step.value))); });
    this.step.addEventListener('change', () => void this.send({ stepLengthM: Math.round(Number(this.step.value)) / 100 }));
    this.stance.addEventListener('change', () => void this.send({ stance: this.stance.value as UnboundStance }));
    api.onUnbound(view => this.render(view));
    // 2026-11-19: the view read here goes stale when developer mode is turned on after the control window loaded (the host
    // sends no new view for that), so opening the section reads it again.
    this.root.addEventListener('toggle', () => { if (this.root.open) this.refresh(); });
    this.refresh();
  }

  /** Read the host's view again and show it. */
  refresh(): void {
    void this.api.getUnbound().then(view => this.render(view), () => { this.status.textContent = '读不到 Unbound 的状态。'; });
  }

  private async send(patch: UnboundControlPatch): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { this.render(await this.api.setUnbound(patch)); }
    catch (error) { this.status.textContent = error instanceof Error ? error.message : String(error); if (patch.active !== undefined) this.active.checked = false; }
    finally { this.busy = false; }
  }

  render(view: UnboundControlView): void {
    // The section is never hidden here: the developer panel around it only shows in developer mode anyway. Hiding it on a
    // stale "not available" (2026-11-19) also hid 「桌宠用 Unbound 引擎（实验）」 inside it, which does not need Unbound at all.
    this.active.checked = view.state !== 'normal';
    this.active.disabled = !view.available && view.state === 'normal';
    if (focused(this.depth) !== this.depth) { this.depth.value = String(view.depthM); this.depthOut.textContent = view.depthM.toFixed(1); }
    if (focused(this.viewer) !== this.viewer) this.viewer.value = String(Math.round(view.viewerDistanceCm));
    if (view.body) {
      if (focused(this.speed) !== this.speed) { this.speed.value = String(view.body.walkSpeedMps); this.speedOut.textContent = view.body.walkSpeedMps.toFixed(2); }
      if (focused(this.step) !== this.step) { this.step.value = String(Math.round(view.body.stepLengthM * 100)); this.stepOut.textContent = String(Math.round(view.body.stepLengthM * 100)); }
      if (focused(this.stance) !== this.stance) this.stance.value = view.body.stance;
    }
    this.debug.checked = view.debug;
    this.speech.checked = view.speechBeat === true;
    this.peek.render(view);
    this.life.render(view);
    this.status.textContent = unboundStatusLine(view);
  }
}

/** The element being edited right now (its value is left alone while the user moves it). */
const focused = (element: HTMLElement) => element.ownerDocument.activeElement;

const PHASE_WORDS: Record<string, string> = { notice: '注意到镜头', walk: '走过来', lean: '凑近', hold: '贴着镜头看', back: '退开', settle: '走回去', done: '结束' };
const CANCEL_WORDS: Record<string, string> = { input: '你动了鼠标或键盘', reply: '她要说话', fullscreen: '有全屏程序', timeout: '超时' };
/** One short phrase for the status line: what the peek is doing, or why not now, and how the last one went. */
export function peekWords(peek: PeekView): string {
  const parts: string[] = [];
  if (peek.phase) parts.push(`凑到镜头前：${PHASE_WORDS[peek.phase] ?? peek.phase}${peek.trial ? '（试一下）' : ''}`);
  else parts.push(peek.blocked ? `凑到镜头前：现在不会（${peek.blocked}）` : '凑到镜头前：等合适的时候');
  if (peek.last) parts.push(`上一次${peek.last.cancelled ? `因为${CANCEL_WORDS[peek.last.cancelled] ?? peek.last.cancelled}退开了` : '看完了'}${peek.last.answered ? '，你回应了她' : ''}`);
  parts.push(`这一小时 ${peek.inLastHour} 次`);
  return parts.join('，');
}

/** U2 (docs/claude/2026-11-12-unbound-peek.md): 「试一下：凑到镜头前」 and the peek's knobs. */
class PeekControls {
  readonly root: HTMLElement;
  private readonly idle: HTMLInputElement;
  private readonly cooldown: HTMLInputElement;
  private readonly perHour: HTMLInputElement;
  private readonly softness: HTMLInputElement;
  private readonly softnessOut: HTMLOutputElement;
  private readonly button: HTMLButtonElement;

  constructor(doc: Document, send: (patch: UnboundControlPatch) => Promise<void>) {
    this.root = doc.createElement('fieldset'); this.root.className = 'unbound-peek';
    const legend = doc.createElement('legend'); legend.textContent = '凑到镜头前';
    const hint = doc.createElement('p');
    hint.textContent = '你一会儿没动电脑时，她偶尔会走过来，把一只眼睛凑到镜头前看你。这时点击照常穿过去；一动鼠标或键盘她就退开。“试一下”马上来一次（不管冷却），点完请把手从鼠标上拿开。';
    const number = (id: string, [min, max]: readonly [number, number], step: string) => {
      const node = doc.createElement('input'); node.type = 'number'; node.id = id; node.min = String(min); node.max = String(max); node.step = step; return node;
    };
    this.idle = number('unbound-peek-idle', PEEK_KNOB_RANGES.idleSeconds, '5');
    this.cooldown = number('unbound-peek-cooldown', PEEK_KNOB_RANGES.cooldownMinutes, '1');
    this.perHour = number('unbound-peek-per-hour', PEEK_KNOB_RANGES.perHour, '1');
    this.softness = doc.createElement('input'); this.softness.type = 'range'; this.softness.id = 'unbound-peek-softness'; this.softness.min = '0'; this.softness.max = '1'; this.softness.step = '0.05';
    this.softnessOut = doc.createElement('output');
    this.button = doc.createElement('button'); this.button.type = 'button'; this.button.textContent = '试一下：凑到镜头前';
    const label = (words: string, input: HTMLElement, after = '') => { const node = doc.createElement('label'); node.style.display = 'block'; node.append(doc.createTextNode(words), input); if (after) node.append(doc.createTextNode(after)); return node; };
    const softLabel = label('镜头虚化（贴近时） ', this.softness); softLabel.append(this.softnessOut);
    this.root.append(legend, hint, label('没动电脑多久后 ', this.idle, ' 秒'), label('两次之间至少 ', this.cooldown, ' 分钟'), label('每小时最多 ', this.perHour, ' 次'), softLabel, this.button);
    const knob = (input: HTMLInputElement, key: 'peekIdleSeconds' | 'peekCooldownMinutes' | 'peekPerHour' | 'peekSoftness', [min, max]: readonly [number, number]) =>
      input.addEventListener('change', () => { const value = Number(input.value); if (Number.isFinite(value) && value >= min && value <= max) void send({ [key]: value }); });
    knob(this.idle, 'peekIdleSeconds', PEEK_KNOB_RANGES.idleSeconds);
    knob(this.cooldown, 'peekCooldownMinutes', PEEK_KNOB_RANGES.cooldownMinutes);
    knob(this.perHour, 'peekPerHour', PEEK_KNOB_RANGES.perHour);
    knob(this.softness, 'peekSoftness', PEEK_KNOB_RANGES.softness);
    this.softness.addEventListener('input', () => { this.softnessOut.textContent = Number(this.softness.value).toFixed(2); });
    this.button.addEventListener('click', () => void send({ peekNow: true }));
  }

  render(view: UnboundControlView): void {
    const peek = view.peek;
    this.root.hidden = !peek;
    if (!peek) return;
    const set = (input: HTMLInputElement, value: number) => { if (focused(input) !== input) input.value = String(value); };
    set(this.idle, peek.knobs.idleSeconds); set(this.cooldown, peek.knobs.cooldownMinutes); set(this.perHour, peek.knobs.perHour); set(this.softness, peek.knobs.softness);
    this.softnessOut.textContent = peek.knobs.softness.toFixed(2);
    this.button.disabled = view.state !== 'unbound' || !!peek.phase;
  }
}
