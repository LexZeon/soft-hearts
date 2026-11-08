/**
 * Model lab reports (docs/claude/2026-11-02-model-lab.md): the per-model JSON
 * is the analysis itself; these render it as readable Markdown, and build the
 * cross-model summary (JSON and Markdown). Pure text, no file access.
 */
import { MORPH_SLOTS } from '../../shared/model-profile';
import type { Clearance, LabMotionResult, ModelReport } from './analyze';

export interface SummaryRow {
  id: string;
  ok: boolean;
  error: string | null;
  bundledGene: boolean;
  vertices: number | null;
  bones: number | null;
  morphs: number | null;
  restPose: string | null;
  restArmDeg: number | null;
  headsTall: number | null;
  heightToGene: number | null;
  missingCoreBones: string[];
  morphSlots: number | null;
  capsules: number | null;
  fittedBodyCheck: boolean | null;
  identity: boolean | null;
  motions: ModelReport['totals'];
  tightestTorso: { value: number; motion: string; seconds: number } | null;
  tightestHead: { value: number; motion: string; seconds: number } | null;
  ms: { profile: number; motions: number; total: number };
}
export interface LabSummary { generatedAt: string; tool: ModelReport['tool'] | null; motionCount: number; models: SummaryRow[] }

export function summaryRow(report: ModelReport): SummaryRow {
  const profile = report.profile;
  const tight = (entry: (Clearance & { motion: string }) | null) => entry && { value: entry.value, motion: entry.motion, seconds: entry.seconds };
  return {
    id: report.model.id, ok: report.ok, error: report.error, bundledGene: report.model.bundledGene,
    vertices: report.counts?.vertices ?? null, bones: report.counts?.bones ?? null, morphs: report.counts?.morphs ?? null,
    restPose: profile?.restPose.pose ?? null, restArmDeg: profile?.restPose.armDeg ?? null, headsTall: profile?.proportions.headsTall ?? null,
    heightToGene: profile?.relativeToGene.height ?? null, missingCoreBones: profile ? [...profile.bones.missingCore] : [],
    morphSlots: profile ? MORPH_SLOTS.filter(slot => profile.morphs[slot].index >= 0).length : null,
    capsules: report.collision ? report.collision.capsules.length : profile ? 0 : null, fittedBodyCheck: report.collision?.usedByCheck ?? (profile ? false : null),
    identity: report.retarget?.identity ?? null, motions: { ...report.totals },
    tightestTorso: tight(report.tightest.torso), tightestHead: tight(report.tightest.head),
    ms: { profile: report.timings.profileMs, motions: report.timings.motionsMs, total: report.timings.totalMs },
  };
}

export function buildSummary(reports: readonly ModelReport[], generatedAt: string, motionCount: number): LabSummary {
  return { generatedAt, tool: reports[0]?.tool ?? null, motionCount, models: reports.map(summaryRow) };
}

// ---------------------------------------------------------------- markdown

const cell = (value: unknown) => String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const row = (values: unknown[]) => `| ${values.map(cell).join(' | ')} |`;
const table = (head: string[], rows: unknown[][]) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
const yes = (value: boolean | null | undefined) => value === null || value === undefined ? '—' : value ? '是' : '否';
const STATUS: Record<LabMotionResult['status'], string> = { ok: 'ok', adjusted: 'adjusted（自动修正）', hidden: 'hidden（隐藏）' };
const margin = (entry: Clearance | null) => entry ? `${entry.value}（${entry.side === 'Left' ? '左' : '右'}，${entry.segment}，${entry.seconds}s）` : '—';

/** UTF-8 text, PMX 2.1 and additional-UV morph conversions, in the words of docs/claude/2026-11-02-pmx-utf8.md. */
function conversionText(conversion: NonNullable<ModelReport['conversion']>): string {
  const parts: string[] = [];
  if (conversion.fromUtf8)
    parts.push(`文字 UTF-8 → UTF-16（${conversion.textFields} 个字段${conversion.replacedTextFields ? `，其中 ${conversion.replacedTextFields} 个有非法字节` : ''}）`);
  const down = conversion.downgrade;
  if (down) {
    const changes: string[] = [];
    if (down.qdefVertices) changes.push(`QDEF→BDEF4 ${down.qdefVertices} 个顶点`);
    if (down.flipMorphs) changes.push(`翻转表情→组表情 ${down.flipMorphs} 个`);
    if (down.impulseMorphs) changes.push(`冲量表情清空 ${down.impulseMorphs} 个（丢弃 ${down.impulseElements} 个冲量）`);
    if (down.softBodies) changes.push(`${down.softBodies} 个软体不读`);
    parts.push(`已从 PMX 2.1 降级为 2.0${changes.length ? `：${changes.join('，')}` : '（没有 2.1 特有内容，只改版本号）'}`);
  }
  const uv = conversion.additionalUvMorphs;
  if (uv) parts.push(`追加 UV 表情清空 ${uv.morphs} 个（丢弃 ${uv.elements} 个 UV 偏移；类型、名字、序号不变）`);
  return parts.join('；');
}

export function renderModelMarkdown(report: ModelReport, generatedAt: string): string {
  const out: string[] = [];
  const m = report.model, t = report.timings;
  out.push(`# 模型实验台报告：${m.id}`, '');
  out.push(`- 生成时间：${generatedAt}`);
  out.push(`- 文件：${m.path}（${m.bytes} 字节，sha256 ${m.sha256.slice(0, 16)}…）${m.bundledGene ? '——这是内置 Gene（应用里核验过的 Gene 不做任何转换；这里按“未核验模型”跑一遍）' : ''}`);
  if (m.name) out.push(`- 模型名：${m.name.japanese || '—'} / ${m.name.english || '—'}`);
  if (report.conversion) out.push(`- 载入前转换（只在内存里，和应用的资源协议一样）：${conversionText(report.conversion)}`);
  out.push(`- 工具：model-lab v${report.tool.version} · 档案 v${report.tool.profileVersion} · 碰撞代理 v${report.tool.collisionProxyVersion} · 重定向 v${report.tool.retargetVersion}`);
  if (!report.ok) {
    out.push(`- **未完成**：${report.error}`);
  } else {
    const totals = report.totals;
    out.push(`- **结论**：${totals.motions} 个动作里 ${totals.usable} 个可用（ok ${totals.ok}，adjusted ${totals.adjusted}，hidden ${totals.hidden}）`);
  }
  out.push(`- 耗时：解析 ${t.parseMs} ms，建网格 ${t.meshMs} ms，档案+代理 ${t.profileMs} ms，重定向计划 ${t.planMs} ms，${report.motions.length} 个动作 ${t.motionsMs} ms`
    + `（中位 ${t.perMotionMs.median} ms，最慢 ${t.perMotionMs.max} ms${t.perMotionMs.slowest ? `：${t.perMotionMs.slowest}` : ''}），诊断 ${t.diagnosticsMs} ms，总计 ${t.totalMs} ms`);
  if (report.counts) {
    const c = report.counts;
    out.push(`- 规模：${c.vertices} 顶点（BDEF1 ${c.deform.bdef1} / BDEF2·SDEF ${c.deform.bdef2} / BDEF4 ${c.deform.bdef4}），${c.bones} 骨，${c.morphs} morph，`
      + `${c.rigidBodies} 刚体（动态 ${c.dynamicBodies}），付与 ${c.grants}，IK ${c.iks}`);
  }
  out.push('');
  const profile = report.profile;
  if (profile) {
    const b = profile.bones;
    out.push('## 1. 骨骼映射', '');
    out.push(table(['标准骨', '模型骨'], Object.entries(b.mapped).map(([slot, name]) => [slot, name])), '');
    out.push(`- 缺失：${b.missing.length ? b.missing.join('、') : '无'}`);
    out.push(`- 缺失的核心骨：${b.missingCore.length ? b.missingCore.join('、') : '无'}`);
    out.push(`- 有歧义：${b.ambiguous.length ? b.ambiguous.map(entry => `${entry.bone}（${entry.names.join(' / ')}）`).join('；') : '无'}`);
    const f = b.features;
    out.push(`- 特性：IK ${yes(f.ik)}，足 IK ${yes(f.legIk)}，腕捩 ${yes(f.armTwist)}，手捩 ${yes(f.wristTwist)}，グルーブ ${yes(f.groove)}，眼骨 ${f.eyes}`, '');

    out.push('## 2. 表情槽（15 个语义槽）', '');
    out.push(table(['槽', 'morph', '类型', '幅度/头高', '写入倍数', '被否掉的候选'], MORPH_SLOTS.map(slot => {
      const entry = profile.morphs[slot];
      return [slot, entry.name ?? '（缺）', entry.policy, entry.index >= 0 ? entry.amplitude : '—', entry.index >= 0 ? entry.scale : '—',
        entry.rejected.length ? entry.rejected.map(rejected => `${rejected.name}：${rejected.reason}`).join('；') : ''];
    })), '');
    const bindings = profile.bindings, scaled = Object.entries(bindings.scales).filter(([, scale]) => Math.abs(scale - 1) >= 0.005);
    out.push(`- 舞台实际写入：口型 ${bindings.mouth ?? '（无）'}，眨眼 ${bindings.blink ?? '（无）'}${bindings.blinkPartner ? ` + ${bindings.blinkPartner}` : ''}，`
      + `笑 ${bindings.smile ?? '（无）'}，困眉 ${bindings.sad ?? '（无）'}；校准倍数 ${scaled.length ? scaled.map(([name, scale]) => `${name}×${scale}`).join('，') : '都约为 1'}`, '');

    const p = profile.proportions, r = profile.relativeToGene, pose = profile.restPose;
    out.push('## 3. 初始姿势与比例', '');
    out.push(`- 初始姿势：${pose.pose}（上臂低于水平 ${pose.armDeg ?? '—'}°）`);
    const aligned = Object.entries(pose.alignedToGeneDeg);
    out.push(`- 手臂链与 Gene 的静止方向差（重定向据此校正）：${aligned.length ? aligned.map(([slot, deg]) => `${slot} ${deg}°`).join('，') : '—'}`);
    out.push(`- 身高 ${p.height}，头高 ${p.headSize}（${p.headsTall} 头身），肩宽 ${p.shoulderWidth ?? '—'}，臂长 ${p.armLength ?? '—'}，腿长 ${p.legLength ?? '—'}；眼线来源 ${p.eyeLine}，嘴来源 ${p.mouth}`);
    out.push(`- 相对 Gene：身高 ×${r.height}，腿长 ×${r.legLength ?? '—'}（位移缩放 ×${r.translation ?? '—'}），臂长 ×${r.armLength ?? '—'}，肩宽 ×${r.shoulderWidth ?? '—'}，头 ×${r.headSize}`, '');
  }
  const collision = report.collision;
  if (profile) {
    out.push('## 4. 碰撞代理', '');
    if (!collision) out.push('- 没有拟合出代理（缺少完整蒙皮权重），体检用粗略身体近似。', '');
    else {
      out.push(`- 体检使用代理：${yes(collision.usedByCheck)}${collision.usedByCheck ? '' : '（缺躯干段或头段，体检退回粗略近似）'}`, '');
      out.push(table(['段', '挂在', '半径', '轴长', '顶点'], collision.capsules.map(capsule => [capsule.segment, capsule.bone, capsule.radius, capsule.length, capsule.vertices])), '');
      out.push(`- 缺失段：${collision.missing.length ? collision.missing.join('、') : '无'}`);
      out.push(`- 排除：${collision.excluded.bones} 根骨、${collision.excluded.vertices} 个顶点（头发/裙子/饰品/物理骨）；`
        + `按链：${collision.excluded.roots.length ? collision.excluded.roots.map(root => `${root.name}（${root.bones}）`).join('、') : '—'}`, '');
    }
  }
  if (report.retarget) {
    const plan = report.retarget;
    out.push('## 5. 重定向计划', '');
    out.push(`- 恒等（骨架与 Gene 一致，原样播放、不体检）：${yes(plan.identity)}；位移缩放 ×${plan.scale}；无足 IK 时把脚烘焙成 FK：${yes(plan.bakeLegIk)}`);
    out.push(`- 回退折叠：${plan.folded.length ? plan.folded.join('；') : '无'}`);
    out.push(`- 丢弃（目标没有对应骨）：${plan.dropped.length ? plan.dropped.join('；') : '无'}`, '');
  }
  if (report.motions.length) {
    out.push(`## 6. ${report.motions.length} 个动作`, '');
    out.push('余量 = 手臂轴到胶囊轴的距离 ÷ 胶囊半径 ÷ 判定深度，**低于 1 判为穿模**；恒等计划的动作不体检（与 Gene 相同），余量仍按同一几何算出。', '');
    out.push(table(['动作', '时长 s', '结果', '原因 / 修正', '最紧余量·躯干', '最紧余量·头', '耗时 ms'], report.motions.map(motion => {
      const why = motion.status === 'hidden' ? motion.issues.map(issue => `${issue.check}: ${issue.where}（${issue.samples} 个抽样，最差 ${issue.worst}）`).join('；')
        : motion.status === 'adjusted' ? `${motion.before.map(issue => `${issue.check}: ${issue.where}`).join('；')} → ${motion.adjustments.join('；')}` : '';
      return [`${motion.key}（${motion.name}）`, motion.seconds, STATUS[motion.status], why, margin(motion.margin.torso), margin(motion.margin.head), motion.ms];
    })), '');
    const tight = report.tightest;
    out.push(`- 全部动作里最紧：躯干 ${tight.torso ? `${tight.torso.value}（${tight.torso.motion}，${tight.torso.seconds}s）` : '—'}；头 ${tight.head ? `${tight.head.value}（${tight.head.motion}，${tight.head.seconds}s）` : '—'}`, '');
  }
  if (report.watch.length) {
    out.push('## 7. 真机截图对照建议时刻', '');
    out.push(table(['动作', '结果', '原因', '时刻（秒）'], report.watch.map(entry => [entry.motion, entry.status, entry.reason, entry.seconds.join('、')])), '');
  }
  return `${out.join('\n')}\n`;
}

export function renderSummaryMarkdown(summary: LabSummary): string {
  const out: string[] = ['# 模型实验台汇总', ''];
  out.push(`- 生成时间：${summary.generatedAt}`);
  if (summary.tool) out.push(`- 工具：model-lab v${summary.tool.version} · 档案 v${summary.tool.profileVersion} · 碰撞代理 v${summary.tool.collisionProxyVersion} · 重定向 v${summary.tool.retargetVersion}`);
  out.push(`- 动作：${summary.motionCount} 个预装动作（都按 Gene 审核过）`, '');
  out.push(table(['模型', '结果', '顶点/骨/morph', '初始姿势', '头身', '身高/Gene', '缺核心骨', '表情槽', '代理段', '恒等', 'ok / adjusted / hidden', '最紧·躯干', '最紧·头', '档案 ms', '动作 ms', '总 ms'],
    summary.models.map(model => [
      model.bundledGene ? `${model.id}（Gene）` : model.id, model.ok ? '完成' : `失败：${model.error}`,
      model.vertices === null ? '—' : `${model.vertices} / ${model.bones} / ${model.morphs}`,
      model.restPose ? `${model.restPose}（${model.restArmDeg ?? '—'}°）` : '—', model.headsTall, model.heightToGene,
      model.missingCoreBones.length ? model.missingCoreBones.join('、') : (model.restPose ? '无' : '—'),
      model.morphSlots === null ? '—' : `${model.morphSlots}/15`, model.capsules === null ? '—' : `${model.capsules}/15${model.fittedBodyCheck ? '' : '（体检未用）'}`,
      yes(model.identity), model.ok ? `${model.motions.ok} / ${model.motions.adjusted} / ${model.motions.hidden}` : '—',
      model.tightestTorso ? `${model.tightestTorso.value}（${model.tightestTorso.motion}）` : '—', model.tightestHead ? `${model.tightestHead.value}（${model.tightestHead.motion}）` : '—',
      model.ms.profile, model.ms.motions, model.ms.total,
    ])), '');
  out.push('每个模型的详细报告在 `<id>/report.md`（数据在 `<id>/report.json`）。余量低于 1 判为穿模。', '');
  return `${out.join('\n')}\n`;
}
