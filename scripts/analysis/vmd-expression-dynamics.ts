/**
 * Expression dynamics of authored VMD clips: per universal morph slot, onset / rise (10-90%) / hold (>=90%) / fade (90-10%) /
 * overshoot, co-activation (lead/lag of slots within a clip), blinks and head / upper-body bone motion relative to the face.
 * Read-only analysis, no dependency beyond the repo's own parser source (three's bundled MMD parser) and shared slot aliases.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/analysis/vmd-expression-dynamics.ts [motionsDir] [--json out.json] [--md out.md]
 *
 * Default motionsDir is Gene's bundled motions (CC BY 4.0, "CG-CA Gene by Nagoya Institute of Technology and
 * Moonshot R&D Goal 1 Avatar Symbiotic Society"). Everything is sampled at the VMD frame rate (30 fps).
 */
// @ts-expect-error three ships no declaration for its bundled MMD parser.
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js';
import fs from 'node:fs';
import path from 'node:path';
import { MORPH_ALIASES, MORPH_SLOTS, normalizeProfileName, standardBoneOfName, type MorphSlot } from '../../shared/foundation/universal-skeleton';

const FPS = 30, MS = 1000 / FPS, BLINK_MAX_MS = 700;
const DEFAULT_DIR = 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/motions';
/** Gene-specific names the shared aliases do not cover (documented in the record; names are truncated to 15 bytes in VMD). */
const EXTRA_ALIASES: Readonly<Record<string, MorphSlot>> = { '口わらい': 'mouthSmile', 'にたり': 'mouthSmile' };
/** Authored families (by file name; the directory decides reaction). Hand-assigned, see the record. */
const FAMILY: Readonly<Record<string, string>> = {
  smile: 'smile', 'little-smile': 'smile', 'graceful-smile': 'smile', happy: 'smile', laugh: 'smile', 'annoyed-smile': 'smile', proud: 'smile', triumphant: 'smile', admiration: 'smile', crisp: 'smile',
  embarrassed: 'shy', 'embarrassed-smile': 'shy', ashamed: 'shy',
  sad: 'sad', disappointed: 'sad', sentimental: 'sad', compassion: 'sad', anxious: 'sad', stressed: 'sad',
  angry: 'anger', disgust: 'anger', 'sharp-eyes-suspicion': 'anger',
  afraid: 'fear', terrified: 'fear', stunned: 'fear',
  sleepy: 'idle', expectant: 'idle',
};
const aliasToSlot = new Map<string, MorphSlot>();
for (const slot of MORPH_SLOTS) for (const alias of MORPH_ALIASES[slot]) { const n = normalizeProfileName(alias); if (!aliasToSlot.has(n)) aliasToSlot.set(n, slot); }
for (const [name, slot] of Object.entries(EXTRA_ALIASES)) aliasToSlot.set(normalizeProfileName(name), slot);

interface Key { f: number; v: number }
export interface Episode { peak: number; peakMs: number; startsOn: boolean; onsetMs: number | null; t50Ms: number | null; riseMs: number | null; holdMs: number; fadeMs: number | null; endRatio: number; overshoot: boolean; overshootPct: number }

const quantile = (values: readonly number[], q: number): number | null => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const at = (s.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
};
const median = (values: readonly number[]) => quantile(values, 0.5);

function sampleKeys(keys: readonly Key[], frames: number): Float64Array {
  const out = new Float64Array(frames);
  const sorted = [...keys].sort((a, b) => a.f - b.f);
  let k = 0;
  for (let f = 0; f < frames; f++) {
    while (k + 1 < sorted.length && sorted[k + 1].f <= f) k++;
    const a = sorted[k], b = sorted[k + 1];
    out[f] = !a ? 0 : f <= a.f || !b ? a.v : a.v + (b.v - a.v) * (f - a.f) / (b.f - a.f);
  }
  return out;
}

/** The main episode of a series: around its global peak. Times are ms from the clip start. */
export function episodeOf(series: ArrayLike<number>): Episode | null {
  let peak = 0, at = 0;
  for (let i = 0; i < series.length; i++) if (series[i] > peak) { peak = series[i]; at = i; }
  if (peak <= 0) return null;
  const lo = peak * 0.1, hi = peak * 0.9;
  let s = at;
  while (s > 0 && series[s] > lo) s--;
  const startsOn = s === 0 && series[0] > lo;
  let u = s;
  while (u < at && series[u] < hi) u++;
  let mid = s;
  while (mid < at && series[mid] < peak * 0.5) mid++;
  let h0 = at, h1 = at;
  while (h0 > 0 && series[h0 - 1] >= hi) h0--;
  while (h1 + 1 < series.length && series[h1 + 1] >= hi) h1++;
  let e = h1;
  while (e + 1 < series.length && series[e] > lo) e++;
  const returned = series[e] <= lo;
  const plateau = [] as number[];
  for (let i = u; i < series.length && series[i] >= peak * 0.5; i++) plateau.push(series[i]);
  const plat = median(plateau) ?? peak;
  const ratio = peak / Math.max(plat, 1e-6);
  return {
    peak, peakMs: at * MS, startsOn, onsetMs: startsOn ? null : s * MS, t50Ms: startsOn ? null : mid * MS,
    riseMs: startsOn ? null : (u - s) * MS, holdMs: (h1 - h0 + 1) * MS, fadeMs: returned ? (e - h1) * MS : null,
    endRatio: series[series.length - 1] / peak, overshoot: ratio > 1.1, overshootPct: (ratio - 1) * 100,
  };
}

function angleBetween(a: readonly number[], b: readonly number[]): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI;
}

interface ClipResult {
  name: string; family: string; frames: number;
  slots: Partial<Record<MorphSlot, Episode & { keySpacingMs: number | null }>>;
  unmapped: Record<string, number>;
  blinks: { count: number; heldLid: number; closeMs: number[]; holdMs: number[]; openMs: number[]; times: number[]; nearOnset: boolean | null; firstOnsetMs: number | null };
  bones: Record<string, { keys: number; maxSpeed: number; peakDeg: number; onsetMs: number | null; riseMs: number | null; lagVsFaceMs: number | null }>;
  faceOnsetMs: number | null;
  series: Partial<Record<MorphSlot, Float64Array>>;
}

function analyseClip(buffer: Buffer, name: string, family: string): ClipResult {
  const vmd = new MMDParser.Parser().parseVmd(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), true) as {
    morphs: { morphName: string; frameNum: number; weight: number }[]; motions: { boneName: string; frameNum: number; rotation: number[] }[] };
  const frames = Math.max(1, ...vmd.morphs.map((m) => m.frameNum), ...vmd.motions.map((m) => m.frameNum)) + 1;
  const byName = new Map<string, Key[]>();
  for (const m of vmd.morphs) { const l = byName.get(m.morphName) ?? []; l.push({ f: m.frameNum, v: m.weight }); byName.set(m.morphName, l); }
  const slotSeries: Partial<Record<MorphSlot, Float64Array>> = {};
  const slotSpacing: Partial<Record<MorphSlot, number[]>> = {};
  const unmapped: Record<string, number> = {};
  for (const [morph, keys] of byName) {
    const max = Math.max(...keys.map((k) => k.v));
    if (max <= 0.02) continue;
    const slot = aliasToSlot.get(normalizeProfileName(morph));
    if (!slot) { unmapped[morph] = Math.max(unmapped[morph] ?? 0, max); continue; }
    const s = sampleKeys(keys, frames), have = slotSeries[slot];
    if (!have) slotSeries[slot] = s; else for (let i = 0; i < frames; i++) have[i] = Math.max(have[i], s[i]);
    const fs2 = [...new Set(keys.filter((k) => k.v > 0.02).map((k) => k.f))].sort((a, b) => a - b);
    (slotSpacing[slot] ??= []).push(...fs2.slice(1).map((f, i) => (f - fs2[i]) * MS));
  }
  const slots: ClipResult['slots'] = {};
  for (const slot of MORPH_SLOTS) {
    const series = slotSeries[slot];
    if (!series) continue;
    const ep = episodeOf(series);
    if (ep) slots[slot] = { ...ep, keySpacingMs: median(slotSpacing[slot] ?? []) };
  }
  // Face onset: earliest rise of a non-blink slot with a real amplitude.
  const faceOnsets = (Object.entries(slots) as [MorphSlot, Episode][]).filter(([slot, ep]) => !slot.startsWith('blink') && ep.peak >= 0.3 && ep.onsetMs !== null).map(([, ep]) => ep.onsetMs!);
  const faceOnsetMs = faceOnsets.length ? Math.min(...faceOnsets) : null;
  // Blinks: pulses of the 'blink' slot (both-eye blink morph).
  const blinkSeries = slotSeries.blink;
  const blinks: ClipResult["blinks"] = { count: 0, heldLid: 0, closeMs: [], holdMs: [], openMs: [], times: [], nearOnset: null, firstOnsetMs: faceOnsetMs };
  if (blinkSeries) {
    for (let i = 1; i < frames - 1; i++) {
      if (blinkSeries[i] >= 0.5 && blinkSeries[i - 1] < 0.5) {
        let a = i; while (a > 0 && blinkSeries[a - 1] > 0.1) a--;
        let b = i; while (b + 1 < frames && blinkSeries[b + 1] >= 0.5) b++;
        let c = b; while (c + 1 < frames && blinkSeries[c + 1] > 0.1) c++;
        let top = i; for (let j = a; j <= c; j++) if (blinkSeries[j] > blinkSeries[top]) top = j;
        // A pulse wider than BLINK_MAX_MS at 50% is a held lid state (these clips use the blink morph that way), not a blink.
        if ((b - i + 1) * MS + (top - i) * MS <= BLINK_MAX_MS) {
          blinks.count++; blinks.times.push(i * MS); blinks.closeMs.push((top - a) * MS); blinks.holdMs.push((b - i + 1) * MS); blinks.openMs.push((c - b) * MS);
        } else blinks.heldLid++;
        i = c;
      }
    }
    if (faceOnsetMs !== null && blinks.count) blinks.nearOnset = blinks.times.some((t) => Math.abs(t - faceOnsetMs) <= 300);
  }
  // Bones: head / neck / upper body rotation relative to this clip's first key.
  const bones: ClipResult['bones'] = {};
  const boneKeys = new Map<string, { f: number; q: number[] }[]>();
  for (const m of vmd.motions) {
    const std = standardBoneOfName(m.boneName);
    if (std !== 'head' && std !== 'neck' && std !== 'upperBody' && std !== 'upperBody2') continue;
    (boneKeys.get(std) ?? boneKeys.set(std, []).get(std)!).push({ f: m.frameNum, q: m.rotation });
  }
  for (const [std, keys] of boneKeys) {
    keys.sort((a, b) => a.f - b.f);
    const base = keys[0].q;
    const series = new Float64Array(frames);
    let k = 0;
    for (let f = 0; f < frames; f++) {
      while (k + 1 < keys.length && keys[k + 1].f <= f) k++;
      const a = keys[k], b = keys[k + 1];
      const t = !b || f <= a.f ? 0 : (f - a.f) / (b.f - a.f);
      const da = angleBetween(base, a.q), db = b ? angleBetween(base, b.q) : da;
      series[f] = da + (db - da) * t; // angle to the start pose, linear between keys (bezier ignored)
    }
    const ep = episodeOf(series);
    let maxSpeed = 0;
    for (let f = 1; f < frames; f++) maxSpeed = Math.max(maxSpeed, Math.abs(series[f] - series[f - 1]) * FPS);
    if (!ep || ep.peak < 1) { bones[std] = { keys: keys.length, maxSpeed, peakDeg: ep?.peak ?? 0, onsetMs: null, riseMs: null, lagVsFaceMs: null }; continue; }
    bones[std] = { keys: keys.length, maxSpeed, peakDeg: ep.peak, onsetMs: ep.onsetMs, riseMs: ep.riseMs, lagVsFaceMs: ep.onsetMs !== null && faceOnsetMs !== null ? ep.onsetMs - faceOnsetMs : null };
  }
  return { name, family, frames, slots, unmapped, blinks, bones, faceOnsetMs, series: slotSeries };
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

const fmt = (v: number | null | undefined, digits = 0) => v === null || v === undefined ? '-' : v.toFixed(digits);

export function buildReport(dir: string): { md: string; json: unknown } {
  const clips: ClipResult[] = [];
  for (const sub of ['expression', 'reaction', 'pose']) {
    const folder = path.join(dir, sub);
    if (!fs.existsSync(folder)) continue;
    for (const file of fs.readdirSync(folder).filter((f) => f.endsWith('.vmd')).sort()) {
      const name = file.replace(/\.vmd$/, '');
      clips.push(analyseClip(fs.readFileSync(path.join(folder, file)), `${sub}/${name}`, sub === 'reaction' ? 'reaction' : sub === 'pose' ? 'pose' : FAMILY[name] ?? 'other'));
    }
  }
  const lines: string[] = [];
  const out = (s = '') => lines.push(s);
  out(`# Gene 样例动作的表情动态（脚本生成，勿手改）`);
  out();
  out(`来源：${dir}，${clips.length} 个 VMD，30 fps。口径见 docs/claude/2026-11-14-gene-expression-dynamics.md。时间单位 ms，峰值 0..1。`);
  out(`起始已在高位（起手就带着表情）的片段不算起势/上升；片段结束仍没回落的不算回落。`);
  out();
  const families = [...new Set(clips.map((c) => c.family))];
  const SLOTS_SHOWN = MORPH_SLOTS.filter((s) => s !== 'blinkLeft' && s !== 'blinkRight' && !['a', 'i', 'u', 'e', 'o'].includes(s));
  out(`## 一、每个家族 × 通用槽（中位数；括号内为样本数 n，峰值 >= 0.3 才计）`);
  out();
  out(`| 家族 | 槽 | n | 峰值 | 起势 ms | 上升 10→90% ms | 保持 >=90% ms | 回落 90→10% ms | 回落占比 | 过冲占比 | 关键帧间距 ms |`);
  out(`|---|---|---|---|---|---|---|---|---|---|---|`);
  const collect = (fam: string | null, slot: MorphSlot) => clips.filter((c) => (!fam || c.family === fam) && (c.slots[slot]?.peak ?? 0) >= 0.3).map((c) => c.slots[slot]!);
  const row = (label: string, slot: MorphSlot, eps: (Episode & { keySpacingMs: number | null })[]) => {
    if (!eps.length) return;
    const fadeDone = eps.filter((e) => e.fadeMs !== null);
    out(`| ${label} | ${slot} | ${eps.length} | ${fmt(median(eps.map((e) => e.peak)), 2)} | ${fmt(median(eps.map((e) => e.onsetMs).filter((v): v is number => v !== null)))} | ${fmt(median(eps.map((e) => e.riseMs).filter((v): v is number => v !== null)))} | ${fmt(median(eps.map((e) => e.holdMs)))} | ${fmt(median(fadeDone.map((e) => e.fadeMs!)))} | ${fadeDone.length}/${eps.length} | ${eps.filter((e) => e.overshoot).length}/${eps.length} | ${fmt(median(eps.map((e) => e.keySpacingMs).filter((v): v is number => v !== null)))} |`);
  };
  for (const fam of families) for (const slot of SLOTS_SHOWN) row(fam, slot, collect(fam, slot));
  out();
  out(`## 二、全部片段合计（每个槽）`);
  out();
  out(`| 槽 | n | 峰值中位 | 上升 p25 / 中位 / p75 | 保持 中位 | 回落 p25 / 中位 / p75 | 过冲 |`);
  out(`|---|---|---|---|---|---|---|`);
  for (const slot of MORPH_SLOTS.filter((s) => s !== 'blinkLeft' && s !== 'blinkRight')) {
    const eps = collect(null, slot);
    if (!eps.length) continue;
    const rises = eps.map((e) => e.riseMs).filter((v): v is number => v !== null), fades = eps.map((e) => e.fadeMs).filter((v): v is number => v !== null);
    out(`| ${slot} | ${eps.length} | ${fmt(median(eps.map((e) => e.peak)), 2)} | ${fmt(quantile(rises, 0.25))} / ${fmt(median(rises))} / ${fmt(quantile(rises, 0.75))} | ${fmt(median(eps.map((e) => e.holdMs)))} | ${fmt(quantile(fades, 0.25))} / ${fmt(median(fades))} / ${fmt(quantile(fades, 0.75))} | ${eps.filter((e) => e.overshoot).length}/${eps.length} |`);
  }
  out();
  out(`## 三、共同激活（同一片段内两个槽都 >= 0.3；领先 = 第二个槽升到 50% 的时刻减第一个槽的，负数 = 第二个先动）`);
  out();
  out(`| 槽 A | 槽 B | 片段数 | 领先 中位 ms | 领先 p25 ~ p75 | 曲线相关 中位 |`);
  out(`|---|---|---|---|---|---|`);
  const pairs: { a: MorphSlot; b: MorphSlot; leads: number[]; corr: number[] }[] = [];
  const active = MORPH_SLOTS.filter((s) => !s.startsWith('blink') && !['a', 'i', 'u', 'e', 'o'].includes(s));
  for (let x = 0; x < active.length; x++) for (let y = x + 1; y < active.length; y++) {
    const a = active[x], b = active[y], leads: number[] = [], corr: number[] = [];
    for (const c of clips) {
      const ea = c.slots[a], eb = c.slots[b];
      if (!ea || !eb || ea.peak < 0.3 || eb.peak < 0.3) continue;
      if (ea.t50Ms !== null && eb.t50Ms !== null) leads.push(eb.t50Ms - ea.t50Ms);
      corr.push(pearson(c.series[a]!, c.series[b]!));
    }
    if (corr.length >= 3) pairs.push({ a, b, leads, corr });
  }
  pairs.sort((p, q) => q.corr.length - p.corr.length || (median(q.corr) ?? 0) - (median(p.corr) ?? 0));
  for (const p of pairs.slice(0, 24)) out(`| ${p.a} | ${p.b} | ${p.corr.length} | ${fmt(median(p.leads))} | ${fmt(quantile(p.leads, 0.25))} ~ ${fmt(quantile(p.leads, 0.75))} | ${fmt(median(p.corr), 2)} |`);
  out();
  out(`## 四、眨眼`);
  out();
  const withBlink = clips.filter((c) => c.blinks.count > 0);
  const allClose = withBlink.flatMap((c) => c.blinks.closeMs), allHold = withBlink.flatMap((c) => c.blinks.holdMs), allOpen = withBlink.flatMap((c) => c.blinks.openMs);
  const intervals = withBlink.flatMap((c) => c.blinks.times.slice(1).map((t, i) => t - c.blinks.times[i]));
  out(`含"眨眼"槽脉冲的片段 ${withBlink.length}/${clips.length}，共 ${withBlink.reduce((n, c) => n + c.blinks.count, 0)} 次。闭合 中位 ${fmt(median(allClose))} ms（p25 ${fmt(quantile(allClose, 0.25))} ~ p75 ${fmt(quantile(allClose, 0.75))}），闭着 ${fmt(median(allHold))} ms，睁开 ${fmt(median(allOpen))} ms；同一片段内相邻两次间隔中位 ${fmt(median(intervals))} ms（n=${intervals.length}）。`);
  const nearable = withBlink.filter((c) => c.blinks.nearOnset !== null);
  out(`表情起势前后 300 ms 内有眨眼的片段：${nearable.filter((c) => c.blinks.nearOnset).length}/${nearable.length}。`);
  out();
  out(`| 片段 | 次数 | 时刻 ms | 表情起势 ms |`);
  out(`|---|---|---|---|`);
  for (const c of withBlink) out(`| ${c.name} | ${c.blinks.count} | ${c.blinks.times.map((t) => fmt(t)).join(', ')} | ${fmt(c.faceOnsetMs)} |`);
  const held = clips.filter((c) => c.blinks.heldLid > 0);
  out();
  out(`眨眼槽被当作"持续的眼睑状态"用（50% 宽度超过 ${BLINK_MAX_MS} ms，不算眨眼）的片段：${held.length}/${clips.length}，${held.map((c) => c.name.split('/')[1]).join('、') || '无'}。`);
  out();
  out(`## 五、头和上身（相对该片段第一个关键帧的旋转角，贝塞尔插值忽略，取线性近似）`);
  out();
  out(`| 骨 | 有动作的片段 | 峰值角度 中位 / 最大 (度) | 起势晚于脸 中位 ms | 上升 中位 ms | 关键帧数 中位 / 最大 | 最大角速度 中位 / 最大 (度/秒) |`);
  out(`|---|---|---|---|---|---|---|`);
  for (const bone of ['head', 'neck', 'upperBody', 'upperBody2']) {
    const rows = clips.map((c) => c.bones[bone]).filter((b) => b && b.peakDeg >= 1);
    if (!rows.length) continue;
    out(`| ${bone} | ${rows.length}/${clips.length} | ${fmt(median(rows.map((b) => b.peakDeg)), 1)} / ${fmt(Math.max(...rows.map((b) => b.peakDeg)), 1)} | ${fmt(median(rows.map((b) => b.lagVsFaceMs).filter((v): v is number => v !== null)))} | ${fmt(median(rows.map((b) => b.riseMs).filter((v): v is number => v !== null)))} | ${fmt(median(rows.map((b) => b.keys)))} / ${fmt(Math.max(...rows.map((b) => b.keys)))} | ${fmt(median(rows.map((b) => b.maxSpeed)))} / ${fmt(Math.max(...rows.map((b) => b.maxSpeed)))} |`);
  }
  out();
  out(`## 六、每个片段（长度、各槽峰值与起势）`);
  out();
  out(`| 片段 | 家族 | 长度 ms | 脸起势 ms | 槽（峰值@峰值时刻ms，上升ms） |`);
  out(`|---|---|---|---|---|`);
  for (const c of clips) out(`| ${c.name} | ${c.family} | ${fmt(c.frames * MS)} | ${fmt(c.faceOnsetMs)} | ${(Object.entries(c.slots) as [MorphSlot, Episode][]).filter(([s, e]) => !s.startsWith('blink') && e.peak >= 0.3 && !['a', 'i', 'u', 'e', 'o'].includes(s)).map(([s, e]) => `${s} ${e.peak.toFixed(2)}@${fmt(e.peakMs)}${e.riseMs === null ? ' (起手即有)' : ` r${fmt(e.riseMs)}`}`).join('；')} |`);
  out();
  const unmapped = new Map<string, number>();
  for (const c of clips) for (const [k, v] of Object.entries(c.unmapped)) unmapped.set(k, (unmapped.get(k) ?? 0) + 1 + 0 * v);
  out(`## 七、没映射到通用槽的活动形态（出现在几个片段）`);
  out();
  out([...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `${k}(${n})`).join('、'));
  out();
  const json = clips.map(({ series: _series, ...rest }) => rest);
  return { md: lines.join('\n') + '\n', json };
}

if (process.argv[1] && /vmd-expression-dynamics/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const take = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const jsonOut = take('--json'), mdOut = take('--md');
  const { md, json } = buildReport(args[0] ?? DEFAULT_DIR);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(json, null, 1));
  if (mdOut) fs.writeFileSync(mdOut, md); else process.stdout.write(md);
}
