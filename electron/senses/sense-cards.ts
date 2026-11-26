// I-137 (2026-11-15, option A): when the user's own message asks her to turn a sense on
// or off ("帮我开一下摄像头"), she may offer a card, the same kind as a setting card (electron/brain/chat-settings.ts); nothing changes
// until the user taps it, and the tap goes through the user's own switch (electron/safety/agent-channel/bridge.ts createPerceptionSwitches,
// the same host path set_perception and the companion's buttons use). She never suggests a sense on her own: the host only accepts a sense
// proposal on a turn whose user message asked for that sense, in that direction. The microphone is the existing 「语音输入」 card
// (voice_input, I-025); the face check is offered only while its component is installed (a card never starts a download).
// No Electron import: tests drive this module directly.
import type { FaceCheckPhase } from '../../shared/senses/face-check';
import { POSE_LOCAL_ONLY, POSE_RECOGNISES } from '../../shared/senses/pose-signals';
import type { AgentAppBridge, PerceptionFacts, PerceptionKind, SystemAudioPurpose } from '../safety';
import { AgentToolError, AgentToolRegistry, type AgentCallResult, type AgentRegistryOptions, type AgentToolDefinition } from '../safety';
import { argsObject, oneOf } from '../safety';
import { ASSISTANT_NAME } from '../../shared/foundation/assistant-name';

export const SENSE_CARD_IDS = Object.freeze(['sense_camera', 'sense_screen', 'sense_system_audio', 'sense_face_check'] as const);
export type SenseCardId = (typeof SENSE_CARD_IDS)[number];
export type SenseValue = 'pose' | 'images' | 'music' | 'movie' | 'on' | 'off';
export type SenseDirection = 'on' | 'off';
export const isSenseCardId = (value: unknown): value is SenseCardId => typeof value === 'string' && (SENSE_CARD_IDS as readonly string[]).includes(value);

/** What the cards read: the switches' facts and whether the face check's component is installed (its phase). */
export interface SenseFacts { perception: PerceptionFacts | null; facePhase: FaceCheckPhase | null }
/** The phases in which 认出是不是你's component is on this computer: turning it on starts no download. */
export const FACE_INSTALLED_PHASES: readonly FaceCheckPhase[] = Object.freeze(['idle', 'starting', 'ready']);
export const faceInstalled = (phase: FaceCheckPhase | null | undefined) => !!phase && FACE_INSTALLED_PHASES.includes(phase);

interface SenseChoice {
  value: SenseValue;
  /** The button (host text). */
  label: string;
  /** What this value turns on and how to turn it off, shown on the card (host text, at most 240 characters). */
  detail: string;
  kind: PerceptionKind;
  enabled: boolean;
  purposes: SystemAudioPurpose[];
}
export interface SenseCardSpec {
  id: SenseCardId;
  label: string;
  choices: readonly SenseChoice[];
  /** The card's 「现在：…」. */
  state(facts: PerceptionFacts): string;
  /** This value is already what the switches say (a proposal that changes nothing is dropped; a tap reads it again after). */
  satisfied(facts: PerceptionFacts, value: SenseValue): boolean;
  /** Words naming the sense, and phrases that ask for it to be on by themselves ("陪我听歌"). */
  words: RegExp;
  asksOn?: RegExp;
}

const OFF_HOW = '想关的时候点桌宠上的开关，或者跟她说。';
const choice = (value: SenseValue, label: string, detail: string, kind: PerceptionKind, enabled: boolean, purposes: SystemAudioPurpose[] = []): SenseChoice =>
  ({ value, label, detail, kind, enabled, purposes });

export const SENSE_CARDS: readonly SenseCardSpec[] = Object.freeze([
  {
    id: 'sense_camera', label: '摄像头',
    choices: [
      // `camera` on is 「姿势识别」, what set_perception's camera means (I-036); a missing pose component refuses it (no download).
      choice('pose', '姿势识别（只在本机）', `打开摄像头的「姿势识别」：识别${POSE_RECOGNISES}；${POSE_LOCAL_ONLY}，画面不离开电脑。${OFF_HOW}`, 'camera_pose', true),
      choice('images', '发图片给她看', `打开摄像头的「发图片」：聊天时会附一张你的小画面发给 ${ASSISTANT_NAME}，她能看到你。${OFF_HOW}`, 'camera_images', true),
      choice('off', '关掉摄像头', '关掉摄像头（「发图片」和「姿势识别」都关）。以后想开再跟她说，或者点桌宠上的开关。', 'camera', false),
    ],
    state: facts => facts.cameraImages && facts.cameraPose ? '发图片和姿势识别都开着' : facts.cameraPose ? '姿势识别开着' : facts.cameraImages ? '发图片开着'
      : facts.camera ? '开着' : '关着',
    satisfied: (facts, value) => value === 'pose' ? facts.cameraPose === true : value === 'images' ? facts.cameraImages === true : !facts.camera,
    words: /摄像头|相机|镜头|姿势识别|\b(?:camera|webcam)\b/iu,
  },
  {
    id: 'sense_screen', label: '屏幕共享',
    choices: [
      choice('on', '打开屏幕共享', `打开屏幕共享：她能看到你的屏幕，聊天时会把屏幕画面发给 ${ASSISTANT_NAME}。${OFF_HOW}`, 'screen', true),
      choice('off', '关掉屏幕共享', '关掉屏幕共享，她就看不到你的屏幕了。', 'screen', false),
    ],
    state: facts => facts.screen ? '开着' : '关着',
    satisfied: (facts, value) => value === 'on' ? facts.screen : !facts.screen,
    words: /屏幕|\bscreen\b/iu,
    asksOn: /看(?:一?下|看)?我的?屏幕/u,
  },
  {
    id: 'sense_system_audio', label: '电脑声音',
    choices: [
      choice('music', '陪你听音乐', `打开「和她一起听」（陪听音乐）：她能听到电脑里正在放的声音。${OFF_HOW}`, 'system_audio', true, ['music']),
      choice('movie', '陪你看视频', `打开「和她一起听」（陪看视频）：她能听到电脑里正在放的声音，跟着你看的内容聊。${OFF_HOW}`, 'system_audio', true, ['movie']),
      choice('off', '关掉电脑声音', '关掉电脑声音（陪听音乐和陪看视频都关）。', 'system_audio', false, ['music', 'movie']),
    ],
    state: facts => facts.systemAudio.music && facts.systemAudio.movie ? '陪听音乐和陪看视频都开着' : facts.systemAudio.music ? '陪听音乐开着'
      : facts.systemAudio.movie ? '陪看视频开着' : '关着',
    satisfied: (facts, value) => value === 'music' ? facts.systemAudio.music : value === 'movie' ? facts.systemAudio.movie
      : !facts.systemAudio.music && !facts.systemAudio.movie,
    words: /电脑(?:里|上)?的?声音|系统声音|电脑音频|\bsystem audio\b/iu,
    asksOn: /(?:一起|陪我)听(?:歌|音乐|吧|一下|会儿)|(?:一起|陪我)看(?:视频|电影|剧|片|番)/u,
  },
  {
    id: 'sense_face_check', label: '认出是不是你（Beta）',
    choices: [
      choice('on', '打开认出是不是你（Beta）', '打开后，摄像头开着时她会在这台电脑上看一眼是不是你；只记你自己的脸，存的是一串数字不是照片，只在这台电脑上加密保存。'
        + '想关的时候在控制窗口的隐私页关，或者跟她说。', 'face_check', true),
      choice('off', '关掉认出是不是你（Beta）', '关掉认出是不是你（Beta）。已经记下的脸部数据还在，要删在控制窗口的隐私页删。', 'face_check', false),
    ],
    state: facts => facts.faceCheck ? '开着' : '关着',
    satisfied: (facts, value) => value === 'on' ? facts.faceCheck === true : facts.faceCheck !== true,
    words: /认出.{0,4}(?:是不是)?我|认(?:出)?我的?脸|认脸|人脸识别|面部识别|脸部识别|\bface (?:check|recognition)\b/iu,
  },
] as SenseCardSpec[]);
export const senseCard = (id: unknown): SenseCardSpec | undefined => SENSE_CARDS.find(spec => spec.id === id);

// A switch verb close to the sense's name. "开着吗" / "开了吗" ask about the state: not an ask to switch.
const ON_WORDS = /打开(?!了?[吗嘛么没？?])|开启(?!了?[吗嘛么没？?])|启用|开一?下|开开|开起来|开(?:吧|呗|啊)|开了(?![吗嘛么没？?])|帮我开|给我开|开个|\b(?:turn(?:ed)? on|enable|switch on)\b/iu;
const OFF_WORDS = /关掉(?!了?[吗嘛么没？?])|关闭(?!了?[吗嘛么没？?])|关一?下|关上|关了(?![吗嘛么没？?])|关(?:吧|呗)|停掉|停用|别(?:再)?(?:开|用)|不要(?:再)?(?:开|用)|不用了|\b(?:turn(?:ed)? off|disable|switch off)\b/iu;
const NEAR = 12;
/** Where a clause ends: a verb in the next clause is about something else ("关掉朗读，摄像头还好吗"). */
const CLAUSE = /[，。！？；,.!?;\n]/u;
/** The words around a match, at most NEAR characters each side and never past the clause it is in. */
function clauseAround(text: string, at: number, end: number): string {
  let from = Math.max(0, at - NEAR), to = Math.min(text.length, end + NEAR);
  for (let i = at - 1; i >= from; i--) if (CLAUSE.test(text[i])) { from = i + 1; break; }
  for (let i = end; i < to; i++) if (CLAUSE.test(text[i])) { to = i; break; }
  return text.slice(from, to);
}

/**
 * Which senses this message of the user's asks to switch, and which way. Only a sense named with a switch verb close to it (or a
 * phrase that is itself an ask, "陪我听歌") counts; mentioning a sense, or asking whether it is on, does not.
 */
export function askedSenses(text: unknown): Map<SenseCardId, Set<SenseDirection>> {
  const asked = new Map<SenseCardId, Set<SenseDirection>>();
  if (typeof text !== 'string' || !text) return asked;
  const sample = text.slice(0, 4000);
  const add = (id: SenseCardId, direction: SenseDirection) => { const set = asked.get(id) ?? new Set<SenseDirection>(); set.add(direction); asked.set(id, set); };
  for (const spec of SENSE_CARDS) {
    if (spec.asksOn?.test(sample)) add(spec.id, 'on');
    const words = new RegExp(spec.words.source, `${spec.words.flags.replace('g', '')}g`);
    for (const match of sample.matchAll(words)) {
      const at = match.index ?? 0, around = clauseAround(sample, at, at + match[0].length);
      if (ON_WORDS.test(around)) add(spec.id, 'on');
      if (OFF_WORDS.test(around)) add(spec.id, 'off');
    }
  }
  return asked;
}

/** The values one turn may propose for each asked sense (the face check's "on" only while its component is installed). */
export type SenseAllowance = ReadonlyMap<SenseCardId, readonly SenseValue[]>;
export function senseAllowance(text: unknown, facts: SenseFacts): SenseAllowance {
  const allowed = new Map<SenseCardId, SenseValue[]>();
  for (const [id, directions] of askedSenses(text)) {
    const spec = senseCard(id)!;
    const values = spec.choices.filter(item => directions.has(item.value === 'off' ? 'off' : 'on'))
      .filter(item => !(id === 'sense_face_check' && item.value !== 'off' && !faceInstalled(facts.facePhase))).map(item => item.value);
    if (values.length) allowed.set(id, values);
  }
  return allowed;
}

/** This turn's sense items for the settings context, in the per-turn format (`id（名称，现在…，可选 "值"（说明））`). */
export function senseContextText(allowed: SenseAllowance, facts: SenseFacts): string {
  return [...allowed].map(([id, values]) => {
    const spec = senseCard(id)!;
    const now = facts.perception ? spec.state(facts.perception) : '未知';
    const options = spec.choices.filter(item => values.includes(item.value)).map(item => `${JSON.stringify(item.value)}（${item.label}）`).join(' / ');
    return `${id}（${spec.label}，现在${now}，可选 ${options}）`;
  }).join('；');
}

/** Said after the settings protocol on a turn whose message asked for a sense. */
export const SENSE_PROPOSAL_NOTE = '用户这句话请你开或关上面 sense_ 开头的感知：可以按同样格式附加，value 只能用列出的值；'
  + '用户点卡片之前什么都不会开，不要说已经打开、已经能看到或听到。';

export interface SenseProposal { spec: SenseCardSpec; value: SenseValue; options: SenseValue[]; reason: string }

/**
 * Strict parse of a sense proposal. Unknown keys, a sense this turn did not ask for, a value outside this turn's allowance, more than
 * four options, or a proposal the switches already satisfy → null.
 */
export function parseSenseProposal(data: Record<string, unknown>, allowed: SenseAllowance, facts: SenseFacts, cleanReason: (value: unknown) => string): SenseProposal | null {
  if (Object.keys(data).some(key => !['id', 'value', 'choices', 'reason'].includes(key))) return null;
  if (!isSenseCardId(data.id)) return null;
  const spec = senseCard(data.id)!, values = allowed.get(spec.id);
  if (!values) return null;
  const valid = (value: unknown): SenseValue | null => typeof value === 'string' && (values as readonly string[]).includes(value) ? value as SenseValue : null;
  const value = valid(data.value);
  if (!value) return null;
  if (data.choices !== undefined && (!Array.isArray(data.choices) || data.choices.length < 1 || data.choices.length > 4)) return null;
  const options: SenseValue[] = [value];
  for (const item of (data.choices as unknown[] | undefined) ?? []) {
    const extra = valid(item);
    if (!extra) return null;
    if (!options.includes(extra)) options.push(extra);
  }
  if (data.reason !== undefined && typeof data.reason !== 'string') return null;
  const perception = facts.perception;
  if (!perception || options.every(option => spec.satisfied(perception, option))) return null;
  return { spec, value, options, reason: cleanReason(data.reason) };
}

export const senseChoice = (spec: SenseCardSpec, value: SenseValue) => spec.choices.find(item => item.value === value)!;

/** The card's receipt after the tap: what is on now, and how to turn it off. */
export function senseAppliedMessage(spec: SenseCardSpec, value: SenseValue): string {
  if (value === 'off') return `已${senseChoice(spec, value).label}。以后想开再跟她说，或者点桌宠上的开关。`;
  return `已打开${spec.label}（${senseChoice(spec, value).label}）。${spec.id === 'sense_face_check' ? '想关的时候在控制窗口的隐私页关，或者跟她说。' : OFF_HOW}`;
}

/** What the card's tool returns: whether the value held before the tap and after it. */
export interface SenseOutcome { before: boolean; after: boolean }

type SenseBridge = Pick<AgentAppBridge, 'perception' | 'setPerception' | 'windows' | 'faceCheckPhase'>;
const unavailable = (message: string) => new AgentToolError('unavailable', message);

/**
 * The card's one tool, for the card's own registry only (never the external channel). The tap is the consent, as for the 「语音输入」
 * card (`cardConsent`): reversible tier, the "由 Claude 操作" notice, an audit line `chat_set_sense`. It switches through the bridge's
 * setPerception, the user's own switches' host path.
 */
export function senseCardTool(bridge: SenseBridge): AgentToolDefinition<{ spec: SenseCardSpec; choice: SenseChoice }> {
  const facts = (): PerceptionFacts => {
    const value = bridge.perception?.();
    if (!value) throw unavailable('这个版本还不能在聊天里开关感知。');
    return value;
  };
  const faceReady = () => { try { return faceInstalled(bridge.faceCheckPhase?.() ?? null); } catch { return false; } };
  return {
    name: 'set_sense', title: '开关感知', tier: 'reversible',
    validate: raw => {
      const args = argsObject(raw, ['id', 'value']);
      const spec = senseCard(oneOf(args.id, SENSE_CARD_IDS, 'id '))!;
      const value = oneOf(args.value, spec.choices.map(item => item.value), 'value ');
      return { spec, choice: senseChoice(spec, value) };
    },
    prepare: input => {
      if (!bridge.setPerception) throw unavailable('这个版本还不能在聊天里开关感知。');
      if (input.choice.enabled && input.choice.kind !== 'face_check') {
        const pet = bridge.windows().pet;
        if (!pet || !pet.visible || pet.minimized) throw unavailable('请先让桌宠显示出来，感知在桌宠上打开。');
      }
      // A card never starts a download: the face check turns on only while its component is installed (checked again below).
      if (input.choice.kind === 'face_check' && input.choice.enabled && !faceReady())
        throw unavailable('认出是不是你的识别组件还没装好；卡片不会替你下载，要用请在控制窗口的隐私页自己打开。');
      return input;
    },
    noticeDetail: input => input.choice.enabled && input.spec.choices.length > 2 ? `打开${input.spec.label}：${input.choice.label}` : input.choice.label,
    run: async (input, context) => {
      const before = input.spec.satisfied(facts(), input.choice.value);
      if (!before) {
        if (input.choice.kind === 'face_check' && input.choice.enabled && !faceReady())
          throw unavailable('认出是不是你的识别组件还没装好；卡片不会替你下载。');
        await bridge.setPerception!(input.choice.kind, input.choice.enabled, input.choice.purposes, context.check);
      }
      return { before, after: input.spec.satisfied(facts(), input.choice.value) } satisfies SenseOutcome;
    },
  };
}

export type SenseCardApplier = (id: SenseCardId, value: SenseValue) => Promise<AgentCallResult>;
/** A registry holding only the card's tool (like chatSettingApplier): the tap is the consent, so the channel's switch does not matter. */
export function senseCardApplier(bridge: SenseBridge,
  options: Pick<AgentRegistryOptions, 'confirm' | 'notice' | 'audit' | 'confirmLock'>): SenseCardApplier {
  const registry = new AgentToolRegistry([senseCardTool(bridge)], {
    ...options, enabled: () => true,
    notice: (tool, title, detail) => { try { options.notice?.(tool, title, detail); } catch { /* A missing window must not block the change. */ } },
    audit: entry => options.audit?.({ ...entry, tool: `chat_${entry.tool}` }),
  });
  return (id, value) => registry.call('set_sense', { id, value });
}
