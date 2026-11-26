/**
 * Unbound showcase (docs/claude/2026-11-14-lapwing-showcase.md): a 40–60 s performance whose choreography Claude writes live,
 * beat by beat, from a mood state. This module is pure (no Three.js, no Electron, no Claude): the closed vocabulary, the
 * validator (the program only clamps what is out of range and drops what is not in the vocabulary), the warm-morning mood
 * sampler, the "liveliness" knob from the mood, and the prompt text. The Claude call itself lives in the brain-interface module
 * electron/unbound/showcase/choreo-model.ts.
 *
 * A beat says *what* and *when* (and the feeling behind it, one sentence); the page's performer (src/unbound/showcase/performer.ts)
 * turns beats into layer-2 intents, and the body (springs, gait, arm reach) decides *how*, so nothing here is a keyframe.
 */
import type { MoodReading } from './director';

/** The vocabulary. Anything else Claude writes is dropped. */
export const SHOWCASE_KINDS = ['own-world', 'notice', 'approach', 'retreat', 'hand-face', 'wave', 'hand-sign', 'tilt', 'expression', 'glance', 'hold-gaze', 'blink-style', 'murmur'] as const;
export type ShowcaseKind = typeof SHOWCASE_KINDS[number];
export const SHOWCASE_EXPRESSIONS = ['confirm-smile', 'warm-smile', 'laugh', 'pout', 'shy', 'surprise', 'sly', 'content', 'yawn'] as const;
export type ShowcaseExpression = typeof SHOWCASE_EXPRESSIONS[number];
export const SHOWCASE_GLANCES = ['left', 'right', 'down', 'down-left', 'down-right', 'up-left', 'up-right'] as const;
export type ShowcaseGlance = typeof SHOWCASE_GLANCES[number];
export const SHOWCASE_BLINK_STYLES = ['calm', 'lively', 'sleepy', 'soft'] as const;
export type ShowcaseBlinkStyle = typeof SHOWCASE_BLINK_STYLES[number];
export type Side = 'left' | 'right';

export interface ShowcaseBeat {
  /** Seconds from the start of the whole performance. */
  at: number;
  /** Seconds (for state beats — own-world, notice, hold-gaze, approach, retreat, blink-style — how long it takes to settle in). */
  dur: number;
  kind: ShowcaseKind;
  /** 0..1. */
  intensity: number;
  /** One sentence: the feeling she means by it (for the record and the report; the body does not read it). */
  feel: string;
  side?: Side;
  /** own-world: eyes. */
  eyes?: 'open' | 'half' | 'closed';
  /** own-world: where she looks. */
  pitch?: 'up' | 'level' | 'down';
  /** approach / retreat: how far (0..1 of her range). approach: lean 0..1. */
  amount?: number;
  lean?: number;
  /** hand-face, and how (palm against it, the back of the hand, a fingertip). */
  where?: 'cheek' | 'chin' | 'mouth' | 'ear'; // round 9: 'ear' tucks her hair behind her ear
  how?: 'palm' | 'back' | 'fingertip';
  /** wave. */
  size?: 'big' | 'small';
  /** Round 11, hand-sign: a V by her cheek (offered in the prompt); a finger heart and pointing at you exist but are not offered yet (not readable at this framing, round 11 log). */
  sign?: 'v' | 'heart' | 'point';
  /** tilt (deg). */
  deg?: number;
  /** expression. */
  name?: ShowcaseExpression;
  onset?: 'quick' | 'slow';
  /** glance. */
  dir?: ShowcaseGlance;
  /** blink-style. */
  style?: ShowcaseBlinkStyle;
  /** murmur: the line she would be saying (shown nowhere, no sound) and its pinyin / romaji, stressed syllables in *…*: the mouth follows its vowels. */
  line?: string;
  pinyin?: string;
}

export interface ShowcaseSegment { beats: ShowcaseBeat[]; summary: string; dropped: number; clamped: number }

/** Ranges the validator clamps to. */
export const SHOWCASE_LIMITS = Object.freeze({
  totalMaxS: 62, durMinS: 0.3, durMaxS: 10, glanceMaxS: 1.6, waveMaxS: 5, tiltMaxDeg: 22, maxBeats: 48, feelMaxChars: 60, summaryMaxChars: 120,
});

const KIND_SET = new Set<string>(SHOWCASE_KINDS);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clean = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max) : '';

/**
 * One segment from Claude's answer (a JSON object, possibly inside a ```json block or with words around it: the last object that
 * parses wins). Keeps beats inside [from, to) of the performance; clamps numbers; drops unknown kinds and unknown parameter words
 * (an unknown word falls back to the kind's default, which counts as clamped). Returns null when there is no usable beat at all.
 */
export function parseShowcaseSegment(answer: string, window: { from: number; to: number }): ShowcaseSegment | null {
  // One slip seen twice in round 3: a stray quote after the last field of a beat (`"feel":"…","}`). Repaired before parsing.
  const text = typeof answer === 'string' ? answer.replace(/,\s*"\s*\}/gu, '}') : '';
  const value = lastJsonObject(text);
  const raw = value && typeof value === 'object' ? (value as { beats?: unknown }).beats : undefined;
  if (Array.isArray(raw)) return validateBeats(raw, window, clean((value as { summary?: unknown }).summary, SHOWCASE_LIMITS.summaryMaxChars));
  // A slip in the JSON (seen once: a beat cut off at the end) should not cost the whole segment: keep every beat that parses.
  const salvaged = salvageBeats(text);
  if (!salvaged.length) return null;
  const summary = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(text)?.[1] ?? '';
  return validateBeats(salvaged, window, clean(summary, SHOWCASE_LIMITS.summaryMaxChars));
}

export function validateBeats(raw: readonly unknown[], window: { from: number; to: number }, summary = ''): ShowcaseSegment | null {
  const L = SHOWCASE_LIMITS;
  const from = Math.max(0, finite(window.from) ? window.from : 0), to = Math.min(L.totalMaxS, Math.max(from + 1, finite(window.to) ? window.to : L.totalMaxS));
  let dropped = 0, clamped = 0;
  const beats: ShowcaseBeat[] = [];
  const pick = <const T extends string>(v: unknown, allowed: readonly T[], fallback: NoInfer<T>): T => {
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    if (v !== undefined) clamped++;
    return fallback;
  };
  const num = (v: unknown, lo: number, hi: number, fallback: number) => {
    if (!finite(v)) { if (v !== undefined) clamped++; return fallback; }
    if (v < lo || v > hi) clamped++;
    return Math.min(hi, Math.max(lo, v));
  };
  for (const item of raw) {
    if (beats.length >= L.maxBeats) { dropped++; continue; }
    if (!item || typeof item !== 'object') { dropped++; continue; }
    const b = item as Record<string, unknown>;
    if (typeof b.kind !== 'string' || !KIND_SET.has(b.kind)) { dropped++; continue; }
    const kind = b.kind as ShowcaseKind;
    if (!finite(b.at)) { dropped++; continue; }
    if (b.at < from - 0.5 || b.at >= to) { dropped++; continue; }
    const at = num(b.at, from, to, from);
    const durMax = kind === 'glance' ? L.glanceMaxS : kind === 'wave' || kind === 'hand-sign' ? L.waveMaxS : L.durMaxS;
    const beat: ShowcaseBeat = { at, dur: num(b.dur, L.durMinS, durMax, kind === 'glance' ? 0.8 : 2.5), kind, intensity: num(b.intensity, 0, 1, 0.6), feel: clean(b.feel, L.feelMaxChars) };
    switch (kind) {
      case 'own-world': beat.side = pick(b.side, ['left', 'right'], 'left'); beat.eyes = pick(b.eyes, ['open', 'half', 'closed'], 'half'); beat.pitch = pick(b.pitch, ['up', 'level', 'down'], 'level'); break;
      case 'approach': beat.amount = num(b.amount, 0, 1, 0.6); beat.lean = num(b.lean, 0, 1, 0.4); break;
      case 'retreat': beat.amount = num(b.amount, 0, 1, 0.5); break;
      case 'hand-face': beat.where = pick(b.where, ['cheek', 'chin', 'mouth', 'ear'], 'cheek'); beat.side = pick(b.side, ['left', 'right'], 'right'); if (b.how !== undefined) beat.how = pick(b.how, ['palm', 'back', 'fingertip'], 'palm'); break;
      case 'wave': beat.size = pick(b.size, ['big', 'small'], 'small'); beat.side = pick(b.side, ['left', 'right'], 'right'); break;
      case 'hand-sign': beat.sign = pick(b.sign, ['v', 'heart', 'point'], 'v'); beat.side = pick(b.side, ['left', 'right'], 'right'); break;
      case 'tilt': beat.side = pick(b.side, ['left', 'right'], 'left'); beat.deg = num(b.deg, 0, L.tiltMaxDeg, 10); break;
      case 'expression': beat.name = pick(b.name, SHOWCASE_EXPRESSIONS, 'confirm-smile'); beat.onset = pick(b.onset, ['quick', 'slow'], beat.name === 'warm-smile' ? 'slow' : 'quick'); break;
      case 'glance': beat.dir = pick(b.dir, SHOWCASE_GLANCES, 'down-left'); break;
      case 'blink-style': beat.style = pick(b.style, SHOWCASE_BLINK_STYLES, 'calm'); break;
      case 'murmur': { const line = clean(b.line, 40), pinyin = clean(b.pinyin, 240).replace(/[^a-zA-Z\u00fc\u00dcvV*\s'-]/gu, ' ').replace(/\s+/gu, ' ').trim(); if (line) beat.line = line; if (pinyin) beat.pinyin = pinyin; break; }
      default: break;
    }
    beats.push(beat);
  }
  if (!beats.length) return null;
  beats.sort((a, b) => a.at - b.at);
  return { beats, summary, dropped, clamped };
}

/** Every beat object inside the "beats" array that parses on its own (strings and escapes respected; an unclosed string ends it). */
export function salvageBeats(text: string): unknown[] {
  if (typeof text !== 'string') return [];
  const at = text.indexOf('"beats"'), open = at >= 0 ? text.indexOf('[', at) : -1;
  if (open < 0) return [];
  const out: unknown[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = open + 1; i < Math.min(text.length, 200_000); i++) {
    const c = text[i];
    if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) { try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* this one is broken; the rest may not be */ } }
    else if (c === ']' && depth === 0) break;
  }
  return out;
}

/** Round 6: keeps at most `max` murmur beats (the earliest), drops the rest; returns the kept beats and how many were dropped. */
export function capMurmurs<T extends { kind: string }>(beats: readonly T[], max: number): { beats: T[]; dropped: number } {
  let seen = 0, dropped = 0;
  const kept = beats.filter(b => { if (b.kind !== 'murmur') return true; if (seen < Math.max(0, max)) { seen++; return true; } dropped++; return false; });
  return { beats: kept, dropped };
}

/**
 * Round 6: the moment a beat reads best on a still, from its start (s): a hand fully up, a smile at its peak, a surprise at its
 * widest, the middle of a held look. null: a beat with nothing to see (blink style).
 */
export function beatPeak(b: Pick<ShowcaseBeat, 'kind' | 'dur' | 'name' | 'onset'> & { where?: ShowcaseBeat['where'] }): number | null {
  const d = Math.max(0.3, b.dur);
  switch (b.kind) {
    case 'hand-face': if (b.where === 'ear') return Math.min(d - 0.6, 1.1); // round 10: the hair tuck, as the fingers reach the temple
    // falls through
    case 'wave': case 'hand-sign': return Math.min(d - 0.6, 1.5);
    case 'expression': return b.name === 'surprise' ? Math.min(d, 0.35) : b.name === 'warm-smile' ? Math.min(d, 1.5) : Math.min(d, (b.onset === 'slow' ? 0.9 : 0.5) + 0.2);
    case 'tilt': return Math.min(d - 0.2, 1.2);
    case 'approach': return d;
    case 'hold-gaze': case 'murmur': case 'glance': return d / 2;
    case 'own-world': return Math.min(d, 1.5);
    case 'notice': return Math.min(d, 1.0);
    case 'retreat': return d;
    default: return null;
  }
}

/** The last parseable JSON object in a text (Claude may wrap it in a code block or add words). */
export function lastJsonObject(text: string): unknown {
  if (typeof text !== 'string') return null;
  const s = text.slice(0, 200_000);
  // Forward scan of top-level objects (strings and escapes respected); the last one that parses wins.
  let found: unknown = null, depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') { if (depth > 0) inString = true; continue; }
    if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) {
      try { found = JSON.parse(s.slice(start, i + 1)); } catch { /* not JSON; keep looking */ }
    }
  }
  return found;
}

// ---- mood ---------------------------------------------------------------------------------------------------------------------

/** "A warm morning": the range each value is drawn from (hormones 0..100, baseline 50; A 0..1; B, M 0..100). */
export const WARM_MORNING = Object.freeze({ D: [54, 72], O: [56, 76], E: [55, 72], N: [44, 66], C: [18, 42], A: [0.06, 0.3], B: [0, 30], M: [8, 45] } as const);

/** One mood inside the warm-morning range (`random` 0..1, e.g. Math.random). */
export function sampleWarmMorning(random: () => number): MoodReading {
  const r = (k: keyof typeof WARM_MORNING) => { const [lo, hi] = WARM_MORNING[k]; const v = lo + (hi - lo) * Math.min(1, Math.max(0, random())); return k === 'A' ? Math.round(v * 100) / 100 : Math.round(v); };
  return { D: r('D'), O: r('O'), E: r('E'), N: r('N'), C: r('C'), A: r('A'), B: r('B'), M: r('M') };
}

/**
 * The liveliness knob (docs/claude/2026-11-14-liveliness-research.md rule 11, first formula, untested): how big, quick and frequent
 * her movements are. Hormones decide *what* she wants (Claude reads them); this decides *how lively* the body does it.
 */
export function liveliness(mood: MoodReading, recentInteraction = 1): number {
  const d = mood.D / 100, n = mood.N / 100, c = mood.C / 100, a = mood.A;
  return Math.min(1, Math.max(0, 0.35 + 0.30 * (n - 0.5) + 0.20 * (d - 0.5) + 0.15 * Math.min(1, Math.max(0, recentInteraction)) - 0.35 * a - 0.20 * c));
}

/**
 * Round 5: one opening direction per run, drawn like the ending (no repeats within a batch); `start` is how the picture begins
 * before Claude's first beat (in her own world, or simply standing there looking at you).
 */
export const SHOWCASE_OPENINGS: readonly { text: string; start: 'away' | 'standing' }[] = Object.freeze([
  { text: '画面一开始她就已经在看着他了', start: 'standing' },
  { text: '一开始她背过脸去，然后慢慢转回来', start: 'away' },
  { text: '一开始她就凑在镜头前，离得很近', start: 'standing' },
  { text: '一开始她困困的，正打着哈欠', start: 'standing' },
  { text: '一开始她自己小声哼着歌', start: 'away' },
  { text: '一开始她低着头，在摆弄自己的头发', start: 'away' },
]);

/** Round 4: one ending direction per run, drawn by the program and handed to Claude with the situation. */
export const SHOWCASE_ENDINGS = Object.freeze([
  '在脸旁挥挥手',
  '害羞地转开，又偷偷回头瞄他一眼',
  '打个小哈欠，慢慢困得出神',
  '俏皮地嘟嘴，然后转开',
  '自己哼起歌，轻轻晃着',
  '忽然"啊！"地想起什么，眼睛一亮',
  '凑得很近，然后忍不住笑着退开',
  '安静下来，低头抿嘴笑',
]);

export const SHOWCASE_SITUATIONS = Object.freeze([
  '早上，她刚睡醒，头发还有点乱。你刚打开电脑。',
  '她一直在等你，等得有点久了。你终于来了。',
  '她正一个人小声哼着歌，没注意到你来了。',
  '她刚看到一件很好笑的事，憋着笑，想马上告诉你。',
  '深夜了，她有点困，但还想陪你一会儿。',
  '她刚收到一个好消息，开心得坐不住。',
  '她假装在生你的气（其实早就不气了），等你哄。',
  '下午，屋里很安静，她在发呆想事情。你回来了。',
  '她在偷偷练习一个表情，被你撞见了。',
  '她刚洗完脸，精神很好，想跟你说早上好。',
]);

/** How each value reads, for the prompt (plain words, so the model reasons about her, not about numbers). */
function moodWords(m: MoodReading): string {
  const level = (v: number) => v >= 66 ? '偏高' : v >= 56 ? '略高' : v <= 34 ? '偏低' : v <= 44 ? '略低' : '平常';
  return [
    `D（期待、好奇）${m.D}，${level(m.D)}`, `O（亲近、想挨着你）${m.O}，${level(m.O)}`, `E（舒服、安心）${m.E}，${level(m.E)}`,
    `N（兴奋、警觉）${m.N}，${level(m.N)}`, `C（紧张、压力）${m.C}，${level(m.C)}`, `A（困意 0..1）${m.A}${m.A >= 0.25 ? '，有一点困' : '，很清醒'}`,
    `B（无聊 0..100）${m.B}`, `M（想你 0..100）${m.M}${m.M >= 30 ? '，有点想你' : ''}`,
  ].join('；');
}

export const SHOWCASE_SYSTEM_PROMPT = [
  '你是一个动作编排者，给一个住在用户屏幕后面的 3D 女孩写一小段"只为他一个人录的随手视频"的分拍编排。',
  '她温柔、有点调皮，喜欢这个人。你不写台词，只写她的身体和脸在什么时候做什么、为什么。',
  '只输出一个 JSON 对象，不要任何别的文字。',
].join('\n');

/** Vocabulary as the model sees it (keep in step with SHOWCASE_KINDS and the validator). */
const VOCABULARY = `词表（kind 之外的字段按需要写，没写就用默认）：
- own-world：在自己的世界里看别处。side=left|right（往她自己的哪边看），eyes=open|half|closed，pitch=up|level|down。
- notice：注意到你，转过来看你。intensity 越大转得越快越干脆。
- hold-gaze：安静地、稳稳地看着你（几乎不动，只有呼吸和眨眼）。
- approach：朝你凑近。amount 0..1（多近），lean 0..1（上身探过来多少）。
- retreat：退开一点。amount 0..1。
- hand-face：手放在脸边。where=cheek|chin|mouth|ear（ear：把头发别到耳后，手指从太阳穴沿头发捋到耳后再放下），side=left|right（她自己的哪只手），how=palm（手心贴着）|back（手背贴脸颊）|fingertip（指尖点下巴）。dur 是手停在那里多久。
- wave：挥手。size=big|small（big：张开手掌在脸旁挥；small：胸前轻轻挥），side=left|right。dur ≤ 5。
- hand-sign：比个手势。sign=v（脸旁比 V，食指中指竖起），side=left|right。dur ≤ 5。
- tilt：歪头。side=left|right，deg 8..18。dur 是歪着多久，之后自己回正。
- expression：表情。name=confirm-smile（小确认笑，起得快）|warm-smile（暖笑，慢慢漾开，眼睛跟着弯）|laugh（笑出声，眯眼）|pout（嘟嘴）|shy（害羞，脸红、眼睛往下躲一下）|surprise（惊讶）|sly（半垂着眼、只翘一边嘴角的狡黠小坏笑）|content（闭着眼、下巴微抬、满足地抿嘴笑，1～2 秒）|yawn（打个小哈欠）。intensity 0..1，onset=quick|slow。dur 是这个表情持续多久。
- glance：看着他时，视线移开一下就回来（dir=left|right|down|down-left|down-right|up-left|up-right）；她在自己的世界里时，是偷偷瞄他一眼又回去。dur ≤ 1.6。
- murmur：她在小声跟你说一句话（画面里没有声音也没有字幕，只有嘴型）。line=她说的那句话（中文，≤20 字）。dur 约等于字数 ÷ 5 秒。
- blink-style：之后的眨眼风格。style=calm|lively|sleepy|soft。
每拍都有：at（从整段开头算的秒数，可以和别的拍重叠：不同种类可以叠加，比如凑近的同时歪头、笑），dur（秒），kind，intensity 0..1，feel（一句话：她这一下想表达什么，用中文）。`;

const RULES = `怎么写（不是剧本，没有固定的起承转合）：
- 每一个动作都要有原因，feel 写的就是原因；没有原因的时候就安静，不要为了动而动。安静地看着他也是一种表达。
- 由她此刻的心情决定这一段的样子：要不要先在自己的世界里、什么时候看他、凑不凑近、凑几次、用哪种笑、怎么收尾（道别、只是安静看着、又回到自己的事里……都行），都按心情来，不要套一个固定的顺序。
- 心情怎么读：亲近（O）和想你（M）高，就更想挨近、看着他；期待（D）和兴奋（N）高，就更活泼、动作多；舒服（E）高，就松弛、慢；紧张（C）高就收着点；困（A）就慢一点、眼睛半垂、眨眼慢。
- 真人的节奏：热闹一阵、安静一阵；表情会变，但不用刻意定时；歪头时左右交替；视线移开一下就回来。
- 词表里的每样都只是"可以用"，不是"要用"：手放脸边、张开手掌在脸旁挥手、比手势、凑近、退开，按心情挑，可以不用。
- 像给一个人随手录的、有点调皮的家庭录像，不是偶像表演。`;

export interface ShowcasePromptInput { mood: MoodReading; situation: string; window: { from: number; to: number }; part: 1 | 2; total: number; previous?: { beats: readonly ShowcaseBeat[]; summary: string };
  /** How the picture starts before the first beat: she is in her own world (the live version covers the wait so), or just standing there. */
  opening?: 'away' | 'standing';
  /** Round 4, drawn per run by the program: how the performance ends (a direction, not a script), and about how many lines she murmurs (0–5). */
  ending?: string; talk?: number;
  /** Round 5: the opening direction drawn for this run. */
  openingText?: string }

/** The user prompt for one segment. Part 1 opens (she is in her own world when it starts); part 2 continues and ends with goodbye. */
export function showcasePrompt(input: ShowcasePromptInput): string {
  const { mood, situation, window, part, total } = input;
  const lines = [
    `情境：${situation}`,
    `她此刻的心情（激素 0..100，50 是平常）：${moodWords(mood)}。`,
    `整段约 ${Math.round(total)} 秒，分两段写。这一次写第 ${part} 段：从第 ${window.from.toFixed(1)} 秒到第 ${window.to.toFixed(1)} 秒（at 必须落在这个范围里）。`,
  ];
  // Round 4: how much she talks and how it ends are drawn by the program per run (a hint, not a script); Claude composes the rest.
  // Round 6: a hard maximum (Claude wrote 1–2 more than the hint every time); the program also drops any beyond it (capMurmurs).
  if (input.talk !== undefined) lines.push(input.talk === 0 ? '这次她不说话：不要写 murmur（哼歌也不要），只用表情和动作。' : `这次整段里她最多小声说 ${input.talk} 句话（murmur，写在 line 里）。这是上限：可以少，绝对不要多，多写的会被丢掉。`);
  if (part === 1 && input.openingText) lines.push(`这次开场的方向：${input.openingText}——按你的方式演出来，不用照搬。`);
  else if (part === 1) lines.push(input.opening === 'away' ? '画面开始前她在自己的世界里（还没看他）。第一段从哪里开始、什么时候看他，按心情决定。' : '画面开始时她站在那里，可能在看他，也可能在想自己的事——第一拍你来定。');
  else {
    const prev = input.previous;
    if (prev) lines.push(`第 1 段写了：${prev.summary || '（没写概要）'}。最后几拍：${prev.beats.slice(-6).map(b => `${b.at.toFixed(1)}s ${b.kind}${b.name ? `(${b.name})` : ''}`).join('、')}。接着往下写，别重复同样的组合。`);
    lines.push(input.ending ? `这是最后一段。这次结尾的方向：${input.ending}——按你的方式演出来，不用照搬，也不要再加一个别的收尾。` : '这是最后一段，怎么结束按心情。');
  }
  lines.push(VOCABULARY, RULES, '只输出这样的 JSON（合法的 JSON，每个字段都写完整）：{"summary":"这一段一句话的概要","beats":[{"at":2.5,"dur":3,"kind":"tilt","side":"left","deg":12,"intensity":0.5,"feel":"……"},{"at":4,"dur":2,"kind":"murmur","line":"……","intensity":0.5,"feel":"……"}]}，拍数 6～20。');
  return lines.join('\n\n');
}
