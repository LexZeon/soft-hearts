/**
 * #11 主机这一侧的真实现：她来挑"动一动""看你一眼"的样子和表情（接口见 interface.ts，旋钮见 knobs.ts）。
 * 纯本地、零额度、不碰聊天提示词；只在内存里记最近几次。
 */
import { sheChooses, type SheChoosesCandidate, type SheChose } from '../../she-chooses';
import { selectBehaviorState, type BehaviorFaceBindingId } from '../../behavior-motion';
import { MOOD_LABELS } from '../../mood-runtime';
import { tendencyNow } from '../../mood-tendency';
import type { MoodCue, MoodLabel, MoodSnapshot, MoodTendency } from '../../mood';
import type { FatiguePhase } from '../../fatigue';
import type { HerContact } from '../../her-state';
import { IDLE_GESTURE_KNOBS, IDLE_FACE_IDS, IDLE_SHAPE_IDS, type IdleFaceId, type IdleFaceKnob, type IdleGestureKnobs,
  type IdleMoment, type IdleShapeId, type IdleShapeKnob } from './knobs';
import type { IdleGestureHost, IdleGestureKind, IdleGestureNow, IdleGesturePresentation, IdleGestureSource, IdleGestureView, IdleGestureWhy } from './interface';

const TENDENCIES: readonly MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];
const SERIOUS_MOODS = new Set<MoodLabel>(['concerned', 'disappointed', 'upset', 'longing', 'sad', 'tense-expectation']);
/** "这会儿……"：心情快照里最强的那项倾向。 */
const NOW_WORDS: Readonly<Record<MoodTendency | 'wistful', string>> = {
  playful: '这会儿有点调皮', close: '这会儿想黏着你', comfortable: '这会儿很放松', cautious: '这会儿有点拘谨', wistful: '还在想念的余韵里',
};
/** 角色卡性格：高于一般 / 低于一般。 */
const PERSONALITY_WORDS: Readonly<Record<MoodTendency, readonly [string, string]>> = {
  playful: ['性格：爱玩', '性格：不太爱玩'], close: ['性格：黏人', '性格：不太黏人'],
  comfortable: ['性格：随和', '性格：不太随和'], cautious: ['性格：谨慎', '性格：大胆'],
};
const TIMING_WORDS: Readonly<Record<IdleGestureSource, Readonly<Record<IdleGestureKind, string>>>> = {
  rule: { look: '闲着到了看你一眼的时候', motion: '闲着到了动一动的时候' },
  inner: { look: '她自己决定看你一眼', motion: '她自己决定动一动' },
  test: { look: '测试命令给的时机', motion: '测试命令给的时机' },
};
/** 最近几次"为什么"留多少条（只在内存）。 */
const KEEP_WHY = 8;
const KEEP_SOURCES = 32;

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const unit = (value: unknown): number => Math.min(1 - 1e-12, Math.max(0, finite(value, 0)));
const lerp = ([low, high]: readonly [number, number], t: number): number => Math.round((low + (high - low) * t) * 1e5) / 1e5;

/** MoodHost 交给"此刻"的原料。 */
export interface IdleGestureNowInput {
  readonly kind: IdleGestureKind;
  readonly source: IdleGestureSource;
  readonly snapshot: Pick<MoodSnapshot, 'primary' | 'companion' | 'context' | 'boredom'> & Partial<MoodSnapshot>;
  /** 角色卡性格（MoodParameters.weights）。 */
  readonly personality: Partial<Record<MoodTendency, number>> | null | undefined;
  /** 最近的摸头、捏脸、喂食（种类和时间）。 */
  readonly contacts: readonly { readonly kind: HerContact; readonly at: number }[];
  readonly fatiguePhase: FatiguePhase | null | undefined;
  readonly now: number;
}

/** 把主机手里的东西整理成"此刻"。 */
export function idleGestureNow(input: IdleGestureNowInput, knobs: IdleGestureKnobs = IDLE_GESTURE_KNOBS): IdleGestureNow {
  const s = input.snapshot;
  const mood = (Object.hasOwn(MOOD_LABELS, s.primary) ? s.primary : 'calm') as MoodLabel;
  const serious = SERIOUS_MOODS.has(mood) || s.context === 'concern' || s.context === 'disappointment' || s.context === 'offense';
  const personality = Object.fromEntries(TENDENCIES.map(t => [t, Math.min(4, Math.max(0, finite(input.personality?.[t], 1)))])) as Record<MoodTendency, number>;
  const moments: IdleMoment[] = [];
  const within = (kind: HerContact, ms: number) => input.contacts.some(c => c.kind === kind && Number.isFinite(c.at) && input.now - c.at >= -1_000 && input.now - c.at <= ms);
  if (within('pat', knobs.moments.pat.withinMs)) moments.push('pat');
  if (within('pinch', knobs.moments.pinch.withinMs)) moments.push('pinch');
  if (within('food', knobs.moments.food.withinMs)) moments.push('food');
  if (finite(s.boredom, 0) >= knobs.moments.bored.from) moments.push('bored');
  if (input.fatiguePhase === 'drowsy' || input.fatiguePhase === 'light-drowsy') moments.push('drowsy');
  let moodFace: BehaviorFaceBindingId = 'face.in-trouble';
  try { moodFace = selectBehaviorState(s as MoodSnapshot).bindingId ?? 'face.in-trouble'; } catch { moodFace = 'face.in-trouble'; }
  // Only a tendency that is really there (回到基线时那一丝不算, shared/mood-tendency.ts): no "这会儿想黏着你" at rest.
  const tendency = tendencyNow(s);
  return { kind: input.kind, source: input.source, mood, serious, tendency, personality, moments, moodFace };
}

/** 一个候选此刻的理由：心情、这会儿的倾向、角色卡性格、此刻发生过的事。 */
function leanReasons(knob: IdleShapeKnob | IdleFaceKnob, now: Readonly<IdleGestureNow>, knobs: IdleGestureKnobs) {
  const reasons: { text: string; factor: number }[] = [];
  const mood = knob.mood?.[now.mood];
  if (mood !== undefined) reasons.push({ text: `心情：${MOOD_LABELS[now.mood]}`, factor: mood });
  if (now.tendency) { const lean = knob.now?.[now.tendency]; if (lean !== undefined) reasons.push({ text: NOW_WORDS[now.tendency], factor: lean }); }
  for (const trait of TENDENCIES) {
    const strength = knob.personality?.[trait];
    if (!strength) continue;
    const value = now.personality[trait], factor = Math.min(3, Math.max(0.2, 1 + strength * 2 * (value - 1)));
    if (Math.abs(factor - 1) >= 0.05) reasons.push({ text: PERSONALITY_WORDS[trait][value > 1 ? 0 : 1], factor });
  }
  for (const moment of now.moments) {
    const factor = knob.moments?.[moment];
    if (factor !== undefined) reasons.push({ text: knobs.moments[moment].label, factor });
  }
  return reasons;
}

function shapeCandidates(knobs: IdleGestureKnobs): SheChoosesCandidate<IdleShapeId, IdleGestureNow>[] {
  return IDLE_SHAPE_IDS.map(id => ({ id, label: knobs.shapes[id].label,
    weigh: now => ({ base: knobs.shapes[id].base[now.kind], reasons: leanReasons(knobs.shapes[id], now, knobs) }) }));
}
function faceCandidates(knobs: IdleGestureKnobs): SheChoosesCandidate<IdleFaceId, IdleGestureNow>[] {
  return IDLE_FACE_IDS.map(id => ({ id, label: knobs.faces[id].label,
    weigh: now => {
      const knob = knobs.faces[id];
      // Serious or not is a gate (a sad moment never smiles), not a reason of its own.
      const gate = Math.max(0, finite(knob.serious[now.serious ? 0 : 1], 0));
      return { base: knob.base[now.kind] * gate, reasons: leanReasons(knob, now, knobs) };
    } }));
}

/** 一次挑选的结果。 */
export interface IdleGestureChoice {
  readonly shape: IdleShapeId;
  readonly face: IdleFaceId;
  readonly shapeLabel: string;
  readonly faceLabel: string;
  readonly bindingId: BehaviorFaceBindingId | null;
  readonly smile: number;
  readonly amplitude: number;
  readonly eyes: number;
  readonly pace: number;
  readonly side: 1 | -1;
  readonly why: readonly string[];
  readonly weights: string;
}

const weightLine = (chose: SheChose<string>) => chose.weights.map(w => `${w.label} ${w.weight}`).join(' · ');

/**
 * 挑一次：样子一次、表情一次，再在样子的范围里定幅度、快慢、方向。每次正好取 5 个随机数，顺序固定，
 * 所以改一个旋钮只影响它管的那一处（tests/idle-gesture.test.ts 的"一个旋钮"测试）。
 * 连着两次同样的样子和表情之后，第三次至少换一样（"不重复刚做过的"；Codex T-207 在默认卡上抓到过连着三次"抬眼看你 · 只是看着"：
 * 样子和表情各自只降低一次，两样一起再中一次并不难）：挑中的样子还是那个时，表情不挑那个；没有别的表情可挑时换样子；
 * 样子和表情都只有这一种可挑时（她此刻只能这样），照样做。最近挑过降多少照旧由 recent 旋钮管，这一条不是旋钮。
 */
export function chooseIdleGesture(now: IdleGestureNow, recent: { readonly shapes: readonly IdleShapeId[]; readonly faces: readonly IdleFaceId[] },
  random: () => number, knobs: IdleGestureKnobs = IDLE_GESTURE_KNOBS): IdleGestureChoice | null {
  // The two rolls are taken in their usual order whatever is left out below, so the count and order stay five.
  const shapeRoll = random(), faceRoll = random();
  const pick = <Id extends string>(candidates: readonly SheChoosesCandidate<Id, IdleGestureNow>[], history: readonly Id[], roll: number, without?: Id) =>
    sheChooses({ candidates: without === undefined ? candidates : candidates.filter(c => c.id !== without), now, random: () => roll, recent: history, recentFactors: knobs.recent });
  const shapes = shapeCandidates(knobs), faces = faceCandidates(knobs);
  const twice = recent.shapes.length >= 2 && recent.shapes[0] === recent.shapes[1] && Object.hasOwn(knobs.shapes, recent.shapes[0])
    && recent.faces.length >= 2 && recent.faces[0] === recent.faces[1] && Object.hasOwn(knobs.faces, recent.faces[0])
    ? { shape: recent.shapes[0], face: recent.faces[0] } : null;
  let shape = pick(shapes, recent.shapes, shapeRoll), face: SheChose<IdleFaceId> | null;
  let changed: 'shape' | 'face' | null = null;
  if (twice && shape?.id === twice.shape) {
    face = pick(faces, recent.faces, faceRoll, twice.face);
    if (face) changed = 'face';
    else {
      const other = pick(shapes, recent.shapes, shapeRoll, twice.shape);
      if (other) { shape = other; changed = 'shape'; }
      face = pick(faces, recent.faces, faceRoll);
    }
  } else face = pick(faces, recent.faces, faceRoll);
  const a = unit(random()), p = unit(random()), s = unit(random());
  if (!shape || !face) return null;
  const shapeKnob = knobs.shapes[shape.id], faceKnob = knobs.faces[face.id];
  const size = Math.min(3, Math.max(0, finite(knobs.size, 1)));
  const bindingId = faceKnob.bindingId === 'mood' ? now.moodFace : faceKnob.bindingId;
  const before = twice ? `前两次都是${knobs.shapes[twice.shape].label} · ${knobs.faces[twice.face].label}` : '';
  return {
    shape: shape.id, face: face.id, shapeLabel: shape.label, faceLabel: face.label, bindingId,
    smile: Math.min(1.5, Math.max(0, finite(faceKnob.smile, 1))),
    amplitude: Math.round(lerp(shapeKnob.amplitude, a) * size * 1e5) / 1e5, eyes: size, pace: lerp(shapeKnob.pace, p), side: s < 0.5 ? 1 : -1,
    why: [TIMING_WORDS[now.source][now.kind], ...shape.why, ...(changed === 'shape' ? [`${before}，这次换个样子`] : []),
      `表情：${face.label}——${[...face.why, ...(changed === 'face' ? [`${before}，这次换个表情`] : [])].join('；')}`],
    weights: `${weightLine(shape)}｜${weightLine(face)}`,
  };
}

interface Current {
  characterId: string;
  cueId: string;
  kind: IdleGestureKind;
  source: IdleGestureSource;
  at: number;
  choice: IdleGestureChoice | null;
  committed: boolean;
  hidden: boolean;
}

/** 真实现（接口见 interface.ts IdleGestureHost）。 */
export class IdleGestureDirector implements IdleGestureHost {
  private readonly history = new Map<string, { shapes: IdleShapeId[]; faces: IdleFaceId[] }>();
  private readonly log: (IdleGestureWhy & { characterId: string })[] = [];
  private readonly sources = new Map<string, IdleGestureSource>();
  private current: Current | null = null;
  private readonly knobs: IdleGestureKnobs;
  private readonly random: () => number;
  private readonly clock: () => number;

  constructor(options: { knobs?: IdleGestureKnobs; random?: () => number; clock?: () => number } = {}) {
    this.knobs = options.knobs ?? IDLE_GESTURE_KNOBS;
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? Date.now;
  }

  note(cueId: string, source: IdleGestureSource): void {
    if (typeof cueId !== 'string' || !cueId || !['rule', 'inner', 'test'].includes(source)) return;
    this.sources.delete(cueId); this.sources.set(cueId, source);
    while (this.sources.size > KEEP_SOURCES) this.sources.delete(this.sources.keys().next().value!);
  }

  present(characterId: string, cue: MoodCue | null, now: (source: IdleGestureSource) => IdleGestureNow | null): IdleGesturePresentation | null {
    if (!cue || (cue.kind !== 'look' && cue.kind !== 'motion') || typeof cue.id !== 'string' || !characterId) return null;
    const current = this.current;
    if (current && current.cueId === cue.id && current.characterId === characterId) return current.hidden ? null : this.presentation(current);
    // A pending choice that never reached a window (no settle since) is dropped, never remembered.
    const source = this.sources.get(cue.id) ?? 'rule';
    const next: Current = { characterId, cueId: cue.id, kind: cue.kind, source, at: finite(cue.at, this.clock()), choice: null, committed: false, hidden: false };
    this.current = next;
    let moment: IdleGestureNow | null = null;
    try { moment = now(source); } catch { moment = null; }
    if (moment) {
      const recent = this.history.get(characterId) ?? { shapes: [], faces: [] };
      try { next.choice = chooseIdleGesture({ ...moment, kind: cue.kind, source }, recent, this.random, this.knobs); } catch { next.choice = null; }
    }
    return this.presentation(next);
  }

  hide(cueId: string): void {
    const current = this.current;
    if (current && current.cueId === cueId && !current.committed) current.hidden = true;
  }

  settle(): void {
    const current = this.current;
    if (!current || current.committed || current.hidden || !current.choice) return;
    current.committed = true;
    const choice = current.choice, keep = Math.max(1, this.knobs.recent.length);
    const history = this.history.get(current.characterId) ?? { shapes: [], faces: [] };
    history.shapes = [choice.shape, ...history.shapes].slice(0, keep);
    history.faces = [choice.face, ...history.faces].slice(0, keep);
    this.history.set(current.characterId, history);
    this.log.unshift({ characterId: current.characterId, at: current.at, kind: current.kind, source: current.source,
      shape: choice.shapeLabel, face: choice.faceLabel, why: [...choice.why], weights: choice.weights });
    this.log.splice(KEEP_WHY * 4);
  }

  recent(characterId: string): readonly IdleGestureWhy[] {
    return this.log.filter(entry => entry.characterId === characterId).slice(0, KEEP_WHY)
      .map(({ characterId: _, ...entry }) => ({ ...entry, why: [...entry.why] }));
  }

  private presentation(current: Current): IdleGesturePresentation | null {
    const choice = current.choice;
    if (!choice) return null;
    const view: IdleGestureView = { cueId: current.cueId, kind: current.kind, shape: choice.shape, side: choice.side,
      amplitude: choice.amplitude, eyes: choice.eyes, pace: choice.pace, smile: choice.smile };
    return { view, bindingId: choice.bindingId };
  }
}

