/**
 * 物理调参台: the side panel (plain DOM, textContent only). It edits one working tuning and calls `changed` (debounced by main.ts);
 * the numbers table is refreshed from the meter. Labels are Chinese (developer tool; the dev panel's other labels are too).
 */
import {
  AMMO_TUNING_DEFAULT, SPRING_TUNING_START, TUNING_BOUNDS, defaultGroupTuning,
  type ModelPhysicsTuning, type PhysicsGroupTuning,
} from '../../../shared/stage/physics-tuning';
import type { PhysicsQuality } from '../../../shared/stage/model-physics';
import type { GroupNumbers } from './meter';
import type { PhysicsGroupInfo } from './groups';

export interface PanelGroup extends PhysicsGroupInfo { label: string; long: boolean }

export interface PanelState {
  tuning: ModelPhysicsTuning;
  parts: { hair: { enabled: boolean; strength: number }; chest: { enabled: boolean; strength: number } };
  quality: PhysicsQuality;
}

export interface PanelHandlers {
  changed(): void;
  saveModel(): void;
  clearModel(): void;
  storePreset(slot: 'A' | 'B'): void;
  recallPreset(slot: 'A' | 'B'): void;
  reload(): void;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node;
}

export function slider(parent: HTMLElement, label: string, [min, max]: readonly [number, number], step: number, get: () => number, set: (value: number) => void, unit = ''): () => void {
  const row = el('div', 'row'), input = el('input'), out = el('output');
  input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
  const show = () => { const value = get(); input.value = String(value); out.textContent = `${Number(value.toFixed(3))}${unit}`; };
  input.addEventListener('input', () => { set(input.valueAsNumber); show(); });
  row.append(el('span', '', label), input, out); parent.append(row); show();
  return show;
}

export function check(parent: HTMLElement, label: string, get: () => boolean, set: (value: boolean) => void): () => void {
  const row = el('label', 'check'), box = el('input'); box.type = 'checkbox';
  box.addEventListener('change', () => set(box.checked));
  row.append(box, el('span', '', label)); parent.append(row);
  const show = () => { box.checked = get(); }; show(); return show;
}

export class LabPanel {
  private readonly refreshers: (() => void)[] = [];
  private readonly numbersBody = el('tbody');
  private readonly notice = el('div');
  private readonly savedLine = el('p', 'hint');
  private readonly stepLine = el('p', 'hint');
  private readonly presetButtons = new Map<string, HTMLButtonElement>();

  constructor(private readonly root: HTMLElement, private readonly state: PanelState, private readonly groups: readonly PanelGroup[],
    others: number, private readonly handlers: PanelHandlers) {
    root.replaceChildren();
    this.notice.id = 'notice';
    root.append(el('h2', '', '保存'), this.savedLine);
    const save = el('div', 'bar');
    const button = (text: string, action: () => void, title = '') => { const b = el('button', '', text); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', action); return b; };
    save.append(button('保存为这个模型的设置', () => handlers.saveModel(), '存在本机，按模型内容区分；桌宠和 Unbound 用它。不进模型文件，不进角色卡。'),
      button('恢复原样', () => handlers.clearModel(), '删掉这个模型保存的调参，桌宠回到没有调参台时的样子'),
      button('重新读取', () => handlers.reload()));
    root.append(save, this.notice);
    const presets = el('div', 'bar');
    for (const slot of ['A', 'B'] as const) {
      presets.append(button(`存到 ${slot}`, () => handlers.storePreset(slot)));
      const recall = button(`切到 ${slot}`, () => handlers.recallPreset(slot)); recall.disabled = true; this.presetButtons.set(slot, recall); presets.append(recall);
    }
    root.append(el('h2', '', '对比 A / B'), el('p', 'hint', '先存两套，来回切着看（只在这个窗口里，保存、恢复原样都不影响；换模型或关了窗口就没了）。'), presets);

    root.append(el('h2', '', '全局'));
    const global = el('div'); root.append(global);
    for (const part of ['hair', 'chest'] as const) {
      this.refreshers.push(check(global, part === 'hair' ? '头发物理（调参台里预览）' : '胸部物理（调参台里预览）',
        () => state.parts[part].enabled, value => { state.parts[part].enabled = value; handlers.changed(); }));
      this.refreshers.push(slider(global, part === 'hair' ? '头发强度' : '胸部强度', [0, 1], 0.05,
        () => state.parts[part].strength, value => { state.parts[part].strength = value; handlers.changed(); }));
    }
    global.append(el('p', 'hint', '上面这两项跟桌宠设置里的开关一样，只在这里预览；桌宠的开关仍在设置里改。'));
    const qualityRow = el('div', 'row'), quality = el('select');
    for (const [value, text] of [['low', '省电'], ['standard', '标准'], ['high', '细致']] as const) { const option = el('option', '', text); option.value = value; quality.append(option); }
    quality.addEventListener('change', () => { state.quality = quality.value as PhysicsQuality; handlers.changed(); });
    qualityRow.append(el('span', '', '物理质量'), quality, el('span')); global.append(qualityRow);
    this.refreshers.push(() => { quality.value = state.quality; });
    this.refreshers.push(slider(global, '物理子步', TUNING_BOUNDS.substepHz, 5, () => state.tuning.substepHz, value => { state.tuning.substepHz = value; handlers.changed(); }, ' Hz'));
    global.append(el('p', 'hint', '子步越细越稳（长辫子在 120 Hz 明显更稳），计算也越多。会自动取能整除求解间隔的值。'));
    this.refreshers.push(check(global, '手臂碰胸部（默认不碰：说话手势会把胸部弹开）', () => state.tuning.collisions.chestArms,
      value => { state.tuning.collisions.chestArms = value; handlers.changed(); }));
    this.refreshers.push(check(global, '头发碰身体（默认碰，按模型作者的设置）', () => state.tuning.collisions.hairBody,
      value => { state.tuning.collisions.hairBody = value; handlers.changed(); }));
    root.append(this.stepLine);

    root.append(el('h2', '', '分组'), el('p', 'hint', '每条头发链单独一组；最长的一组标了"最长"（长辫子一般是它）。弹簧骨骼是实验：每帧算，便宜，可以调得更 Q 弹。'));
    for (const group of groups) this.groupControls(root, group);
    if (others) root.append(el('p', 'hint', `另有 ${others} 组物理（裙子、披风、袖子、饰品等）只显示数量，这里不调、不运行。`));

    root.append(el('h2', '', '实时数字'), el('p', 'hint', '模型单位，最近一个动作循环。抖动：静止时每帧最大移动。意外步长：每帧移动的突变（越小越丝滑）。下垂：平均比动画低多少。摆幅：真的在晃多少。停稳：动作停下到不再动的秒数。'));
    const table = el('table', 'numbers'), head = el('tr');
    for (const text of ['分组', '抖动', '意外步长', '下垂', '摆幅', '拉伸', '穿进', '停稳']) head.append(el('th', '', text));
    const thead = el('thead'); thead.append(head); table.append(thead, this.numbersBody); root.append(table);
    this.refresh();
  }

  private groupControls(root: HTMLElement, group: PanelGroup): void {
    const box = el('details', 'group'), summary = el('summary');
    summary.append(el('span', '', group.label), el('span', 'badge', `${group.outputBones.length} 根骨`));
    if (group.long) summary.append(el('span', 'badge long', '最长'));
    box.append(summary); root.append(box);
    const tuning = (): PhysicsGroupTuning => this.state.tuning.groups[group.id] ??= defaultGroupTuning(group.part);
    const changed = () => this.handlers.changed();
    this.refreshers.push(check(box, '启用（关掉：这组跟着动画，不晃）', () => tuning().enabled, value => { tuning().enabled = value; changed(); }));
    this.refreshers.push(check(box, '单独设强度', () => tuning().strength !== null,
      value => { tuning().strength = value ? this.state.parts[group.part].strength : null; changed(); this.refresh(); }));
    this.refreshers.push(slider(box, '强度', TUNING_BOUNDS.strength, 0.05, () => tuning().strength ?? this.state.parts[group.part].strength,
      value => { tuning().strength = value; changed(); }));
    const engineRow = el('div', 'row'), engine = el('select');
    for (const [value, text] of [['ammo', 'Ammo（模型自带的刚体）'], ['spring', '弹簧骨骼（实验）']] as const) { const option = el('option', '', text); option.value = value; engine.append(option); }
    engineRow.append(el('span', '', '引擎'), engine, el('span')); box.append(engineRow);
    const ammo = el('div'), spring = el('div');
    box.append(ammo, spring);
    const showEngine = () => { engine.value = tuning().engine; ammo.hidden = tuning().engine !== 'ammo'; spring.hidden = tuning().engine !== 'spring'; };
    engine.addEventListener('change', () => { tuning().engine = engine.value === 'spring' ? 'spring' : 'ammo'; showEngine(); changed(); });
    this.refreshers.push(showEngine);
    const b = TUNING_BOUNDS;
    const ammoKnob = (label: string, key: keyof typeof AMMO_TUNING_DEFAULT, bounds: readonly [number, number]) =>
      this.refreshers.push(slider(ammo, label, bounds, 0.05, () => tuning().ammo[key], value => { tuning().ammo[key] = value; changed(); }, '×'));
    ammoKnob('阻尼', 'damping', b.damping); ammoKnob('弹簧', 'spring', b.spring); ammoKnob('角度限制', 'angleLimit', b.angleLimit);
    ammoKnob('重力', 'gravity', b.gravity); ammoKnob('质量', 'mass', b.mass);
    ammo.append(el('p', 'hint', '都是乘在模型作者设的数上：1 就是原样。阻尼最高到 1（Bullet 的上限）。'));
    const springKnob = (label: string, key: keyof typeof SPRING_TUNING_START.hair, bounds: readonly [number, number], step: number, unit = '') =>
      this.refreshers.push(slider(spring, label, bounds, step, () => tuning().springBone[key], value => { tuning().springBone[key] = value; changed(); }, unit));
    // Read as frequency + damping ratio (the way game jiggle tools state a spring): elastic 0..1 is 0.4..6 Hz.
    this.refreshers.push(slider(spring, '弹性（频率）', b.elastic, 0.02, () => tuning().springBone.elastic, value => { tuning().springBone.elastic = value; changed(); }, ''));
    const hz = el('p', 'hint'); spring.append(hz);
    this.refreshers.push(() => { hz.textContent = `= ${(0.4 + 5.6 * tuning().springBone.elastic).toFixed(1)} Hz 回弹（每秒弹几下）`; });
    springKnob('阻尼比', 'damping', b.springDamping, 0.02); springKnob('角度限制', 'angleLimit', b.springAngle, 1, '°');
    springKnob('重力', 'gravity', b.springGravity, 0.02); springKnob('惯性', 'inertia', b.inertia, 0.02);
    spring.addEventListener('input', () => this.refresh());
    spring.append(el('p', 'hint', '弹性：回弹的频率；阻尼比：0 一直弹，0.3 左右明显 Q 弹，1 不过冲；惯性：她动时这组落后多少。长链的下层关节阻尼比至少 0.75，防止越传越大。'));
  }

  refresh(): void { for (const refresh of this.refreshers) refresh(); }

  setPresetAvailable(slot: 'A' | 'B', available: boolean): void { const button = this.presetButtons.get(slot); if (button) button.disabled = !available; }

  setSaved(text: string): void { this.savedLine.textContent = text; }

  say(text: string, error = false): void { this.notice.textContent = text; this.notice.className = error ? 'error' : ''; }

  numbers(values: Record<string, GroupNumbers>, stepMs: number, springMs: number): void {
    const format = (value: number | null, digits = 4) => value === null ? '—' : value.toFixed(digits);
    this.numbersBody.replaceChildren(...this.groups.map(group => {
      const n = values[group.id], row = el('tr');
      row.append(el('td', '', group.label));
      for (const value of n ? [n.jitter, n.unexpectedStep, n.droop, n.swing, n.stretch, n.penetrationDepth] : [null, null, null, null, null, null]) row.append(el('td', '', format(value)));
      row.append(el('td', '', n?.settleSeconds === null || !n ? '—' : n.settleSeconds.toFixed(2)));
      return row;
    }));
    this.stepLine.textContent = `每帧物理用时：${stepMs.toFixed(2)} ms（其中弹簧骨骼 ${springMs.toFixed(2)} ms）`;
  }
}
