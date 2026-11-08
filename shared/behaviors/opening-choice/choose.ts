/**
 * #10 主机这一侧的真实现：她想找你说话时，从此刻真有的几件事里挑一件（接口见 interface.ts，旋钮见 knobs.ts）。
 * 纯本地、零额度：不截图、不录音、不调模型，不碰任何提示词；只在内存里记最近几次。
 */
import { sheChooses, type SheChoosesCandidate, type SheChose } from '../../she-chooses';
import { MOOD_LABELS } from '../../mood-runtime';
import { tendencyNow } from '../../mood-tendency';
import type { MoodLabel, MoodSnapshot, MoodTendency } from '../../mood';
import { OPENING_CANDIDATE_IDS, OPENING_CHOICE_KNOBS, type OpeningCandidateId, type OpeningCandidateKnob, type OpeningChoiceKnobs, type OpeningMoment } from './knobs';
import type { OpeningChoice, OpeningChoiceHost, OpeningNow, OpeningWhy } from './interface';

const TENDENCIES: readonly MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];
const NOW_WORDS: Readonly<Record<MoodTendency | 'wistful', string>> = {
  playful: '这会儿有点调皮', close: '这会儿想黏着你', comfortable: '这会儿很放松', cautious: '这会儿有点拘谨', wistful: '还在想念的余韵里',
};
const PERSONALITY_WORDS: Readonly<Record<MoodTendency, readonly [string, string]>> = {
  playful: ['性格：爱玩', '性格：不太爱玩'], close: ['性格：黏人', '性格：不太黏人'],
  comfortable: ['性格：随和', '性格：不太随和'], cautious: ['性格：谨慎', '性格：大胆'],
};
/** "说话"的几件（"这次不说"以外的）。 */
const SPEAKING = new Set<OpeningCandidateId>(['listen', 'screen', 'mood', 'play']);
const KEEP_WHY = 8;

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** 主机交给"此刻"的原料。 */
export interface OpeningNowInput {
  readonly available: OpeningNow['available'];
  readonly snapshot: Pick<MoodSnapshot, 'primary' | 'companion' | 'boredom' | 'lastInteractionAt'> & Partial<MoodSnapshot>;
  /** 角色卡性格（MoodParameters.weights）。 */
  readonly personality: Partial<Record<MoodTendency, number>> | null | undefined;
  /** 她正好有一件能说出口的小需要（只看不拿：HerNeedsHost.hasSpeechChance）。 */
  readonly need: boolean;
  /** 内心循环的安静规则（深夜、困了；睡着时根本不到这里）。 */
  readonly quiet: { readonly night: boolean; readonly drowsy: boolean };
  /** 上一次最后由谁去做（OpeningChoiceHost.last）。 */
  readonly last: { readonly id: OpeningCandidateId; readonly at: number } | null;
  /** I-006: the user is absorbed in something right now (shared/behaviors/user-activity); absent = no. Only leans toward "这次不要". */
  readonly busy?: boolean;
}

/** 把主机手里的东西整理成"此刻"。 */
export function openingNow(input: OpeningNowInput, knobs: OpeningChoiceKnobs = OPENING_CHOICE_KNOBS): OpeningNow {
  const s = input.snapshot;
  const mood = (Object.hasOwn(MOOD_LABELS, s.primary) ? s.primary : 'calm') as MoodLabel;
  const personality = Object.fromEntries(TENDENCIES.map(t => [t, Math.min(4, Math.max(0, finite(input.personality?.[t], 1)))])) as Record<MoodTendency, number>;
  const moments: OpeningMoment[] = [];
  if (input.need === true) moments.push('need');
  if (finite(s.boredom, 0) >= knobs.moments.bored.from) moments.push('bored');
  if (input.quiet?.night === true) moments.push('night');
  if (input.quiet?.drowsy === true) moments.push('drowsy');
  if (input.busy === true) moments.push('busy');
  // She chose to speak last time, and the user has not come since (a chat, pat or feeding after that choice).
  const last = input.last, seen = s.lastInteractionAt;
  if (last && SPEAKING.has(last.id) && Number.isFinite(last.at) && !(typeof seen === 'number' && Number.isFinite(seen) && seen >= last.at)) moments.push('unanswered');
  const available = {
    listen: input.available?.listen === true, screen: input.available?.screen === true,
    mood: input.available?.mood === true, play: input.available?.play === true,
  };
  return { available, mood, tendency: tendencyNow(s), personality, moments };
}

/** 一个候选此刻的理由：心情、这会儿的倾向、角色卡性格、此刻的事。 */
function reasonsFor(knob: OpeningCandidateKnob, now: Readonly<OpeningNow>, knobs: OpeningChoiceKnobs) {
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

function candidates(now: Readonly<OpeningNow>, without: readonly OpeningCandidateId[], knobs: OpeningChoiceKnobs): SheChoosesCandidate<OpeningCandidateId, OpeningNow>[] {
  return OPENING_CANDIDATE_IDS
    .filter(id => !without.includes(id) && (id === 'quiet' || now.available[id] === true))
    .map(id => ({ id, label: knobs.candidates[id].label, weigh: moment => ({ base: knobs.candidates[id].base, reasons: reasonsFor(knobs.candidates[id], moment, knobs) }) }));
}

const weightLine = (chose: SheChose<string>) => chose.weights.map(w => `${w.label} ${w.weight}`).join(' · ');

/**
 * 挑一次。正好取一个随机数（没有候选时也取），所以改一个旋钮只影响它管的那一处。
 * `recent`：最近最后由谁去做的，最新的在前；`without`：这次已经试过、做不成的。
 */
export function chooseOpening(now: OpeningNow, recent: readonly OpeningCandidateId[], random: () => number,
  knobs: OpeningChoiceKnobs = OPENING_CHOICE_KNOBS, without: readonly OpeningCandidateId[] = []): OpeningChoice | null {
  const chose = sheChooses({ candidates: candidates(now, without, knobs), now, random, recent, recentFactors: knobs.recent });
  if (!chose) return null;
  return { id: chose.id, label: chose.label, why: [...chose.why], weights: weightLine(chose) };
}

/** 真实现（接口见 interface.ts OpeningChoiceHost）。 */
export class OpeningChoiceDirector implements OpeningChoiceHost {
  private readonly history = new Map<string, { ids: OpeningCandidateId[]; last: { id: OpeningCandidateId; at: number } | null }>();
  private readonly log: (OpeningWhy & { characterId: string })[] = [];
  private readonly knobs: OpeningChoiceKnobs;
  private readonly random: () => number;

  constructor(options: { knobs?: OpeningChoiceKnobs; random?: () => number } = {}) {
    this.knobs = options.knobs ?? OPENING_CHOICE_KNOBS;
    this.random = options.random ?? Math.random;
  }

  choose(characterId: string, now: OpeningNow, without: readonly OpeningCandidateId[] = []): OpeningChoice | null {
    const history = this.history.get(characterId);
    try { return chooseOpening(now, history?.ids ?? [], this.random, this.knobs, without); } catch { return null; }
  }

  settle(characterId: string, id: OpeningCandidateId, at: number): void {
    if (!characterId || !(OPENING_CANDIDATE_IDS as readonly string[]).includes(id)) return;
    const history = this.history.get(characterId) ?? { ids: [], last: null };
    history.ids = [id, ...history.ids].slice(0, Math.max(1, this.knobs.recent.length));
    history.last = { id, at: finite(at, 0) };
    this.history.set(characterId, history);
    while (this.history.size > 64) this.history.delete(this.history.keys().next().value!);
  }

  last(characterId: string): { readonly id: OpeningCandidateId; readonly at: number } | null {
    const last = this.history.get(characterId)?.last;
    return last ? { ...last } : null;
  }

  note(characterId: string, why: OpeningWhy): void {
    if (!characterId) return;
    this.log.unshift({ characterId, at: why.at, from: why.from, label: why.label, why: [...why.why], weights: why.weights });
    this.log.splice(KEEP_WHY * 4);
  }

  recent(characterId: string): readonly OpeningWhy[] {
    return this.log.filter(entry => entry.characterId === characterId).slice(0, KEEP_WHY)
      .map(({ characterId: _, ...entry }) => ({ ...entry, why: [...entry.why] }));
  }
}
