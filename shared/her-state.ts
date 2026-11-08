/**
 * I-017 "啥都是状态". Record: docs/claude/2026-11-03-her-state-line.md.
 *
 * What she hears and what her body is doing right now, as words for the turn's own perception line (shared/perception-rule.ts
 * perceptionTurnLine) and for the inner loop's 【此刻】. Only "is it there, what is it", never content or user data: she hears
 * sound and rhythm, not lyrics (a transcript is its own block, put there by the audio reading path, and only then may she know
 * words). Pure: no clock, no I/O.
 *
 * Whether her body moves to the music is the stage's choice (src/stage/music-choice.ts, M1), so the pet window reports it
 * through one narrow channel (StageStateReport, electron/her-state-host.ts); the host owns whether she may hear at all.
 */

/** The stage's music state: not hearing; hearing but quiet; music and she stays still; she nods along; she dances. */
export const STAGE_MUSIC_STATES = ['off', 'silent', 'still', 'nod', 'dance'] as const;
export type StageMusicState = typeof STAGE_MUSIC_STATES[number];
const isStageMusicState = (value: unknown): value is StageMusicState =>
  typeof value === 'string' && (STAGE_MUSIC_STATES as readonly string[]).includes(value);

/**
 * The pet window's report (preload `noteStageState`). `instance` is one random id per page load, `seq` counts up within it, so a
 * late or replayed report never overwrites a newer one (electron/her-state-host.ts). Nothing else is accepted: no text, no level.
 * I-016 adds one optional number, `beat`: the stage's fast "像音乐" score 0..1 (src/stage/music-likeness.ts), for the host's
 * slower music / show / talk / quiet judgement (electron/listen-kind-source.ts). A score, not a level or a signal.
 */
export interface StageStateReport { instance: string; seq: number; music: StageMusicState; always: boolean; beat?: number }
const REPORT_KEYS = ['instance', 'seq', 'music', 'always'] as const;
const OPTIONAL_KEYS = ['beat'] as const;
const INSTANCE = /^[A-Za-z0-9-]{8,64}$/u;

export function parseStageStateReport(value: unknown): StageStateReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Reflect.ownKeys(value), allowed: readonly string[] = [...REPORT_KEYS, ...OPTIONAL_KEYS];
  if (keys.length < REPORT_KEYS.length || keys.length > allowed.length || keys.some(key => typeof key !== 'string' || !allowed.includes(key))
    || REPORT_KEYS.some(key => !keys.includes(key))) return null;
  const read = (key: string) => { const d = Object.getOwnPropertyDescriptor(value, key); return d && 'value' in d ? d.value : undefined; };
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !('value' in d)) return null; }
  const instance = read('instance'), seq = read('seq'), music = read('music'), always = read('always'), beat = read('beat');
  if (typeof instance !== 'string' || !INSTANCE.test(instance) || !Number.isSafeInteger(seq) || (seq as number) < 1
    || !isStageMusicState(music) || typeof always !== 'boolean') return null;
  if (keys.includes('beat') && (typeof beat !== 'number' || !Number.isFinite(beat) || beat < 0 || beat > 1)) return null;
  return { instance, seq: seq as number, music, always, ...(keys.includes('beat') ? { beat: beat as number } : {}) };
}

/** Where the sound she may hear comes from (the audio-rhythm switch's source). */
export type HearingSource = 'system-audio' | 'microphone';
/**
 * What the sound is (I-016, docs/claude/2026-11-03-listen-kind.md: the host's smoothed music / show / talk judgement,
 * electron/listen-kind-source.ts). Before the host has settled on one: 'rhythm' when the stage's fast layer hears music in it,
 * 'sound' when it does not (absent: 'rhythm', the I-017 wording).
 */
export type HeardKind = 'rhythm' | 'music' | 'show' | 'talk' | 'sound';
export const HEARD_KINDS: readonly HeardKind[] = ['rhythm', 'music', 'show', 'talk', 'sound'];

export interface HearingNow {
  /** The host's own switch ("允许她听到", 音频律动) and its source; null while it is off. */
  source: HearingSource | null;
  /** The pet window's latest fresh report; null when there is none, it is stale, or the window reloaded. */
  stage: { music: StageMusicState; always: boolean } | null;
  /** This turn already carries a transcript block (the audio reading path); only then may she know words. */
  transcript: boolean;
  kind?: HeardKind;
  /**
   * 2026-11-07: the local recognizer turned a piece of the computer's sound into words a moment ago (electron/listen-together/core.ts
   * spokenWithin). The stage's rhythm score cannot tell narration from silence ("静"); this can. Absent: not known / no.
   */
  speaking?: boolean;
}

/** Things done to her a moment ago (the mood host's contacts). */
export const HER_CONTACTS = ['pat', 'pinch', 'food'] as const;
export type HerContact = typeof HER_CONTACTS[number];
export const isHerContact = (value: unknown): value is HerContact => typeof value === 'string' && (HER_CONTACTS as readonly string[]).includes(value);
/** "A moment ago": typing a message after a pat takes a while. */
export const HER_CONTACT_RECENT_MS = 30_000;
/**
 * The mood note's "最近原因" for each contact (shared/mood.ts defaults for rua and food, electron/mood.ts for the cheek). When the
 * turn's mood note already names it, the perception line does not say it again.
 */
export const CONTACT_MOOD_REASON: Readonly<Record<HerContact, string>> = { pat: '有效摸头', pinch: '有效捏脸', food: '接受一份点心' };
const CONTACT_WORDS: Readonly<Record<HerContact, string>> = { pat: '摸了摸你的头', pinch: '捏了捏你的脸', food: '喂了你一份点心' };

export interface HerStateNow {
  hearing: HearingNow;
  /** Contacts a moment ago that the turn's mood note does not already name, newest first. */
  contacts: readonly HerContact[];
  /**
   * How much of the hearing to say on this turn (electron/her-state-host.ts decides; absent: 'full'). R28's first-token rule: the
   * full sentence on every turn measured +255.5 ms (12 pairs), and the brief one on every turn +678.5 ms (12 pairs, 10 slower):
   * not the length, she weighs the music in her reply. So the full sentence goes once per conversation and per switch change,
   * the brief one only on turns whose message is about it (asksAboutHearing), and nothing on the others ('none': exactly the
   * step-1 line; the fixed rule tells her to keep what she last knew).
   */
  say?: 'full' | 'brief' | 'none';
  /** I-019 喂食认图: what the snack a moment ago was, once recognized (electron/feed-recognition/host.ts recentFoodName). */
  food?: string;
  /**
   * I-006 第 1 步: one short sentence about whether the user is absorbed (shared/behaviors/user-activity/effects.ts userActivitySentence),
   * present only on the turn where that state changed; state and minutes only. Absent: nothing to say.
   */
  user?: string;
}

/**
 * The user's message touches what she hears or does ("你在干嘛""在听歌吗""这首歌唱的什么""你怎么在晃"). A miss only means
 * she answers from what she was told earlier in the conversation; a false hit only costs that one turn the brief sentence.
 */
const HEARING_TOPIC = /听|歌|曲|音乐|旋律|节奏|唱|跳|舞|晃|扭|摇|点头|干嘛|干啥|干什么|做什么|在忙|声音|吵|安静|bgm|music|song|dance|sing/iu;
export const asksAboutHearing = (text: unknown): boolean => typeof text === 'string' && HEARING_TOPIC.test(text.slice(0, 2_000));

const WHERE: Readonly<Record<HearingSource, string>> = { 'system-audio': '电脑里', microphone: '麦克风里' };
const KIND: Readonly<Record<HeardKind, string>> = { rhythm: '在放有节奏的声音（像是歌）', music: '在放歌', show: '在放剧或视频的声音', talk: '有人在说话',
  sound: '有声音（还听不出是歌还是说话）' };
/** What she cannot make out without a transcript: lyrics in a song, lines in a show, words in talk. */
const UNHEARD: Readonly<Record<HeardKind, string>> = { rhythm: '你只听得到节奏，听不懂歌词', music: '你只听得到节奏，听不懂歌词', show: '你只听得到声音，听不懂台词',
  talk: '你只听得到声音，听不懂在说什么', sound: '你只听得到声音，听不懂内容' };
/** The computer's own talk is transcribed on this machine and kept in memory for ten minutes; it reaches her only when the user asks about it. */
const TALK_TRANSCRIBED = '本机在转写，用户问到内容时才会附上；没附就别编';
const unheard = (hearing: HearingNow, kind: HeardKind): string => kind === 'talk' && hearing.source === 'system-audio' ? `你只听得到声音（${TALK_TRANSCRIBED}）` : UNHEARD[kind];

/** The computer's sound has voices in it being transcribed (settled as talk, or words arrived while the kind is not music / show). */
const talkish = (hearing: HearingNow): boolean => hearing.source === 'system-audio'
  && (hearing.kind === 'talk' || (hearing.speaking === true && hearing.kind !== 'music' && hearing.kind !== 'show'));
/**
 * 2026-11-07: the stage says "silent" (its rhythm score cannot hear narration), but she must not say nothing is playing while the host
 * knows better. In plain words, from what the host knows: someone talking (being transcribed) / a song / a show or video / only the
 * rhythm / nothing audible; with no evidence either way it says so ("好像") instead of claiming silence.
 */
function silentPhrase(hearing: HearingNow, brief: boolean): string {
  const kind = hearing.kind;
  if (talkish(hearing))
    return hearing.transcript ? '有人在说话，内容以附的转写为准' : brief ? '有人在说话（本机在转写）' : `有人在说话（${TALK_TRANSCRIBED}）`;
  if (kind === 'talk') return '有人在说话，你听不懂在说什么';
  if (kind === 'show') return brief ? '在放剧或视频的声音，节奏不明显' : '在放剧或视频的声音，节奏不明显，你听不懂台词';
  if (kind === 'music') return '在放歌，节奏不明显';
  if (kind === 'rhythm') return '只听得到一点节奏，没有转写';
  return '这会儿好像没声音';
}
const BODY: Readonly<Record<'still' | 'nod' | 'dance', string>> = { still: '你没跟着动', nod: '你正跟着轻轻点头、晃一晃', dance: '你正跟着跳' };
export const HEARING_OFF = '你听不到声音。';

/** True when she cannot hear anything and has no transcript: the plain default, merged into the shortest line. */
export const hearingOff = (hearing: HearingNow): boolean => hearing.source === null && !hearing.transcript;

/** The hearing sentence, one of a few fixed shapes (each well under 70 characters). */
export function hearingWords(hearing: HearingNow): string {
  if (!hearing.source) return hearing.transcript ? '你听不到声音本身，只有附的那段声音转写。' : HEARING_OFF;
  const allowed = `用户让你听到${WHERE[hearing.source] ?? '电脑里'}的声音`;
  const kind = HEARD_KINDS.includes(hearing.kind as HeardKind) ? hearing.kind! : 'rhythm';
  const content = hearing.transcript ? '听到的内容只以附的转写为准' : unheard(hearing, kind);
  const stage = hearing.stage;
  if (!stage || stage.music === 'off') return `${allowed}；${hearing.transcript ? content : talkish(hearing) ? `现在有人在说话（${TALK_TRANSCRIBED}）` : '你只听得到声音和节奏，听不懂歌词'}。`;
  if (stage.music === 'silent') return `${allowed}，${silentPhrase(hearing, false)}。`;
  const body = BODY[stage.music] + (stage.music === 'dance' && stage.always ? '（用户设了让你一直跟着跳）' : '');
  return `${allowed}，现在${KIND[kind]}，${body}；${content}。`;
}

const BRIEF_BODY: Readonly<Record<'still' | 'nod' | 'dance', string>> = { still: '你没跟着动', nod: '你正跟着轻轻点头', dance: '你正跟着跳' };
const BRIEF_KIND: Readonly<Record<HeardKind, string>> = { rhythm: '在放有节奏的声音', music: '在放歌', show: '在放剧或视频的声音', talk: '有人在说话', sound: '有声音' };
const BRIEF_UNHEARD: Readonly<Record<HeardKind, string>> = { rhythm: '听不懂歌词', music: '听不懂歌词', show: '听不懂台词', talk: '听不懂在说什么', sound: '听不懂内容' };

/**
 * The same facts, shortest, for a turn about them after the full sentence was told in this conversation: still self-contained (a
 * rebuilt session no longer sees the earlier turn's line), still honest about words.
 */
export function briefHearingWords(hearing: HearingNow): string {
  if (!hearing.source) return hearing.transcript ? '只有附的声音转写。' : HEARING_OFF;
  const where = WHERE[hearing.source] ?? '电脑里';
  const kind = HEARD_KINDS.includes(hearing.kind as HeardKind) ? hearing.kind! : 'rhythm';
  const stage = hearing.stage;
  if (!stage || stage.music === 'off') return `你听得到${where}的声音，${hearing.transcript ? '内容以转写为准' : talkish(hearing) ? '有人在说话，本机在转写，问到才附' : '听不懂歌词'}。`;
  if (stage.music === 'silent') return `${where}${silentPhrase(hearing, true)}。`;
  const words = hearing.transcript ? '内容以转写为准' : kind === 'talk' && hearing.source === 'system-audio' ? '本机在转写，问到才附' : BRIEF_UNHEARD[kind];
  return `${where}${BRIEF_KIND[kind]}，${BRIEF_BODY[stage.music]}${stage.music === 'dance' && stage.always ? '（一直跟着跳）' : ''}；${words}。`;
}

/** I-019: a recognized food's name may stand in for "一份点心" (a short, plain name; anything else keeps the generic words). */
const FOOD_NAME = /^[^\s<>{}\[\]【】`\\|/:："'“”‘’]{1,12}$/u;

/** "用户刚才摸了摸你的头、喂了你一份点心。" ('' for none); with I-019's recognized `food`: "……、喂你吃了草莓蛋糕。". */
export function contactWords(contacts: readonly HerContact[], food?: string): string {
  const kinds = [...new Set(contacts.filter(isHerContact))].slice(0, HER_CONTACTS.length);
  const words = (kind: HerContact) => kind === 'food' && typeof food === 'string' && FOOD_NAME.test(food) ? `喂你吃了${food}` : CONTACT_WORDS[kind];
  return kinds.length ? `用户刚才${kinds.map(words).join('、')}。` : '';
}

/**
 * The contacts worth a word on this turn: a moment ago, and not already the "最近原因" of the turn's mood note (the persona this
 * turn carries). Newest first.
 */
export function contactsToTell(recent: readonly { kind: HerContact; at: number }[], persona: string, now: number): HerContact[] {
  const said = (kind: HerContact) => persona.includes(`最近原因：${CONTACT_MOOD_REASON[kind]}`);
  return [...recent].filter(item => isHerContact(item.kind) && Number.isFinite(item.at) && now - item.at >= -1_000 && now - item.at <= HER_CONTACT_RECENT_MS)
    .sort((a, b) => b.at - a.at).map(item => item.kind).filter((kind, index, all) => all.indexOf(kind) === index && !said(kind));
}

/** The transcript block the audio reading path puts into a chat turn (electron/ambient-comments.ts ambientContextText). */
export const carriesTranscript = (persona: string): boolean => persona.includes('<external-audio-data>');

/** Longest the state words may add to the turn's line (all combinations are tested against it). */
export const HER_STATE_MAX = 110;

/**
 * The inner loop's one line in its 【此刻】 ('' while she hears nothing: its fixed rule says what is not written is not heard).
 * Her own activity is the inner loop's own words (shared/inner-loop.ts), so it is not here.
 */
export function hearingInnerLoopLine(hearing: HearingNow): string {
  return hearingOff(hearing) ? '' : hearingWords(hearing);
}
