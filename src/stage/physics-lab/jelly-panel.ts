/**
 * 物理调参台: the "全身果冻（实验）" section (I-147 layers 2 and 3; docs/claude/2026-11-17-whole-body-jelly.md). Plain DOM,
 * textContent only. Edits the working tuning's `jelly` part and calls `changed`; the same sidecar saves it per model.
 */
import {
  FOLLOW_REGIONS, JELLY_BOUNDS, SOFT_REGIONS, TOUCH_SOFT_STRENGTH, defaultJellyTuning,
  type FollowRegion, type JellyTuning, type SoftRegion,
} from '../../../shared/stage/jelly-tuning';
import type { StageJellyState } from '../jelly/stage-jelly';
import { check, el, slider } from './lab-panel';

const FOLLOW_LABELS: Record<FollowRegion, string> = { spine: '脊柱', neck: '脖子', head: '头', shoulders: '肩', arms: '手臂' };
const SOFT_LABELS: Record<SoftRegion, string> = { belly: '腹部', hips: '臀部', thighs: '大腿', upperArms: '上臂', cheeks: '脸颊', chest: '胸部（模型没有胸部物理骨时）' };

export class JellyPanel {
  private readonly refreshers: (() => void)[] = [];
  private readonly live = el('p', 'hint');

  /** `found`: how many soft regions of each kind this model has (0: that kind is not on this model). */
  constructor(root: HTMLElement, private readonly tuning: () => JellyTuning, private readonly changed: () => void, found: Readonly<Record<SoftRegion, number>>) {
    const jelly = () => this.tuning();
    root.append(el('h2', '', '全身果冻（实验）'),
      el('p', 'hint', '默认都关。打开后桌宠和 Unbound 也用（保存后）。上限都很小：动作停下后 0.3 秒左右收回，不会瞬移。'));

    const follow = el('div'); root.append(follow);
    this.refreshers.push(check(follow, '第 2 层 跟随晃动：脊柱、脖子、头、肩、手臂开始动时稍微落后、停下时多走一点再回来',
      () => jelly().follow.enabled, value => { jelly().follow.enabled = value; changed(); }));
    for (const region of FOLLOW_REGIONS) {
      const box = el('details', 'group'), summary = el('summary'); summary.append(el('span', '', FOLLOW_LABELS[region])); box.append(summary); follow.append(box);
      const knobs = () => jelly().follow.regions[region];
      this.refreshers.push(slider(box, '频率', JELLY_BOUNDS.hz, 0.1, () => knobs().hz, value => { knobs().hz = value; changed(); }, ' Hz'));
      this.refreshers.push(slider(box, '阻尼比', JELLY_BOUNDS.damping, 0.05, () => knobs().damping, value => { knobs().damping = value; changed(); }));
      this.refreshers.push(slider(box, '最大角度', JELLY_BOUNDS.maxDeg, 0.5, () => knobs().maxDeg, value => { knobs().maxDeg = value; changed(); }, '°'));
    }
    follow.append(el('p', 'hint', '频率：回弹多快（每秒几下）；阻尼比：0 一直晃，1 不过冲；最大角度：这一段最多多转几度（软上限，接近但不超过）。'));

    const soft = el('div'); root.append(soft);
    this.refreshers.push(check(soft, '第 3 层 顶点果冻：腹部、臀部、大腿、上臂、脸颊（和没有胸部物理的胸部）随身体的加速度轻轻晃',
      () => jelly().soft.enabled, value => { jelly().soft.enabled = value; changed(); }));
    for (const region of SOFT_REGIONS) {
      const box = el('details', 'group'), summary = el('summary');
      summary.append(el('span', '', SOFT_LABELS[region]), el('span', 'badge', found[region] ? `${found[region]} 处` : '这个模型上没找到'));
      box.append(summary); soft.append(box);
      const knobs = () => jelly().soft.regions[region];
      this.refreshers.push(check(box, '启用', () => knobs().enabled, value => { knobs().enabled = value; changed(); }));
      this.refreshers.push(slider(box, '频率', JELLY_BOUNDS.hz, 0.1, () => knobs().hz, value => { knobs().hz = value; changed(); }, ' Hz'));
      this.refreshers.push(slider(box, '阻尼比', JELLY_BOUNDS.damping, 0.05, () => knobs().damping, value => { knobs().damping = value; changed(); }));
      this.refreshers.push(slider(box, '最大位移', JELLY_BOUNDS.maxOffset, 0.01, () => knobs().maxOffset, value => { knobs().maxOffset = value; changed(); }, '×'));
      this.refreshers.push(slider(box, '半径', JELLY_BOUNDS.radius, 0.05, () => knobs().radius, value => { knobs().radius = value; changed(); }, '×'));
      this.refreshers.push(slider(box, '衰减', JELLY_BOUNDS.falloff, 0.05, () => knobs().falloff, value => { knobs().falloff = value; changed(); }));
      this.refreshers.push(slider(box, '力度', JELLY_BOUNDS.gain, 0.05, () => knobs().gain, value => { knobs().gain = value; changed(); }, '×'));
    }
    soft.append(el('p', 'hint', '最大位移：占这个区域大小的比例；半径：乘在从模型量出来的区域大小上；衰减：越大越只有中间在动；力度：身体加速度推它多狠（1 是物理上的量）。'));

    // I-136 step 5d 碰了才软: only where and while she is touched (pulled, pinched); layer 3's regions and caps; off here = never.
    const touch = el('div'); root.append(touch);
    const row = el('label', 'row'), select = el('select');
    for (const [value, text] of [['default', '跟着版本（开发版开，稳定版关）'], ['on', '开'], ['off', '关']] as const) { const option = el('option', '', text); option.value = value; select.append(option); }
    row.append(el('span', '', '碰了才软：拉她、捏脸时，被碰的那一点轻轻陷下去再弹回来'), select); touch.append(row);
    const touchTuning = () => (jelly().touch ??= { enabled: null, strength: 1 });
    select.addEventListener('change', () => { touchTuning().enabled = select.value === 'default' ? null : select.value === 'on'; changed(); });
    this.refreshers.push(() => { const enabled = jelly().touch?.enabled; select.value = enabled === true ? 'on' : enabled === false ? 'off' : 'default'; });
    this.refreshers.push(slider(touch, '碰的力度', TOUCH_SOFT_STRENGTH, 0.05, () => jelly().touch?.strength ?? 1, value => { touchTuning().strength = value; changed(); }, '×'));
    touch.append(el('p', 'hint', '不碰时她和现在一模一样（不改材质）。陷下去最多是第 3 层各区域的「最大位移」，松手从当前样子弹回。保存后桌宠生效。'));
    root.append(this.live);
    this.refresh();
  }

  refresh(): void { for (const refresh of this.refreshers) refresh(); }

  numbers(state: StageJellyState | null, frameMs: number): void {
    const follow = state?.follow, soft = state?.soft;
    this.live.textContent = `果冻每帧用时（CPU）：跟随 ${follow ? `${follow.avgMs.toFixed(3)} ms，最大 ${follow.maxShownDeg.toFixed(2)}°` : '关'}；`
      + `顶点 ${soft ? `${soft.avgMs.toFixed(3)} ms，最大 ${(soft.maxShown * 100).toFixed(1)}% 区域大小，${soft.materials} 个材质` : '关'}。每帧总用时 ${frameMs.toFixed(2)} ms（这一帧的计算和画面提交；按下画面上的「量帧时间」才把显卡上的用时（顶点果冻在那里）算进去）。`;
  }
}

/** The working tuning's jelly part, created (all off) when the model's saved tuning has none. */
export function ensureJelly(tuning: { jelly?: JellyTuning }): JellyTuning { return tuning.jelly ??= defaultJellyTuning(); }
