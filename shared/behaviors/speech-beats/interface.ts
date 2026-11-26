/**
 * 边说边演（每句回复都有 Claude 编排）的接口。方案：docs/claude/2026-11-19-per-reply-choreo-plan.md。
 * 晚："要像真人说话那样一边带着表情说。有时候回复不说话是纯表演的表情。有时候混着，一句话一个表情，一句话这样。"
 * "可以单独关，默认开"；"做，稳定版试过再开"。
 *
 * 做什么：她写回复时，可以在一句话前面写看不见的动作标记 ⟦词⟧（词只能是下面的封闭词表）。本模块是纯的（不调用模型、不碰时钟）：
 * 把流进来的字分成"给人看、给人听的字"和"动作拍子"，标记从不漏进字里。规则在 choose.ts，旋钮在 knobs.ts。
 *
 * 谁调用、怎么调用（第 2、3 步接上；第 1 步只有这些纯规则和测试 tests/speech-beats.test.ts）：
 *  1. 回复的流式回调：每段字先过 SpeechBeatFilter.push；气泡、朗读、聊天记录、日记、记忆只拿返回的 text。
 *  2. 回复结束调 end()，再取 summary()：performanceOnly 为真时，气泡不出字、不朗读，聊天页显示 describeBeats() 的灰色小字
 * 聊天记录存这行说明，让下一句的她和记忆知道刚才发生过什么。
 *  3. 舞台按拍子的 at（在去掉标记以后的字里的位置）跟着朗读或文字进度演。
 *
 * 底线（写死的，不是旋钮）：
 *  - 标记从不出现在 text 里：包括写坏的、词表外的、没闭合的 ⟦。词表外的整个丢掉，不演。
 *  - 拍子只是表演意图：只有词表里的词，不带路径、资源、权限，也不写心情（心情仍只由回复尾注写一次）。
 *  - 取消、打断、换了上下文的回复，舞台丢掉没演完的拍子，不补演（第 3 步）。
 */

/**
 * 封闭词表。除 kiss、hug 外都是 Unbound 展示词表里已有的动作（choose.ts 的 SPEECH_BEAT_SHOWCASE），不新造。
 * kiss、hug（I-185，问"这些opus自主会编排么？"→"加进去"）是 I-184 "贴近的时刻"那一家（shared/unbound/close-moments/）：
 * 全屏里走过来亲、抱（同一家的门和冷却），小窗里原地做（window-beats.ts），旧舞台不演；做不了时退到轻一点的（CLOSE_BEAT_LIGHTER）。
 */
export const SPEECH_BEAT_WORDS = [
  'look-you', 'look-away-left', 'look-away-right', 'look-down',
  'smile-small', 'smile-warm', 'laugh', 'shy', 'pout', 'surprise', 'sly', 'content',
  'tilt', 'hand-cheek', 'v',
  'lean-in', 'lean-back',
  'kiss', 'hug',
  'blink-slow',
] as const;
/**
 * I-193: the "go where" words. Full-screen Unbound only (the companion window skips them, and her per-turn sentence names
 * them only there): she writes one and the body walks there (shared/unbound/her-position/). The list is held equal to GO_WORDS in
 * shared/unbound/her-position/ask.ts by a test (the two parts do not import each other). They are not part of SPEECH_BEAT_WORDS (the stages' own list).
 */
export const SPEECH_BEAT_GO_WORDS = ['go-left', 'go-right', 'go-middle', 'come-near', 'go-far', 'go-corner', 'go-cursor', 'go'] as const;
export type SpeechBeatGoWord = typeof SPEECH_BEAT_GO_WORDS[number];
/**
 * I-193 numbers: `go` carries where to, ⟦go 30% 1.2m⟧: a whole percent across the screen
 * (\d{1,3}%) and/or told metres from the user (\d+(\.\d)?m), at least one. Only `go` takes digits; the filter drops any other marker with them,
 * and never shows or reads aloud any part of one (also when a chunk ends inside the number). Raw as she wrote them: the host clamps.
 */
export interface SpeechBeatGoTo { readonly percent?: number; readonly metres?: number }
/**
 * I-203 frames: the frames she places between her words for a kiss or a hug, in
 * full-screen Unbound where she walks up (her per-turn sentence names them only there, like the go words). `kiss` / `hug` (the start) stay close
 * words; these three come after one: `hug-held` her words after it wait until she is holding; `pause` her words stop a moment (⟦pause long⟧ a
 * longer one; any reply, not only a hug); `let-go` she lets go at this point in her words. Never shown, never read aloud (the filter takes them out).
 */
export const SPEECH_BEAT_FRAME_WORDS = ['hug-held', 'pause', 'let-go'] as const;
export type SpeechBeatFrameWord = typeof SPEECH_BEAT_FRAME_WORDS[number];
export type SpeechBeatWord = typeof SPEECH_BEAT_WORDS[number] | SpeechBeatGoWord | SpeechBeatFrameWord;
/** I-185: the close-moment words (not showcase beats; each stage plays them its own way). */
export const SPEECH_BEAT_CLOSE_WORDS = ['kiss', 'hug'] as const;
export type SpeechBeatCloseWord = typeof SPEECH_BEAT_CLOSE_WORDS[number];
/** The words the showcase performer plays as they are. */
export type SpeechBeatShowcaseWord = Exclude<SpeechBeatWord, SpeechBeatCloseWord | SpeechBeatGoWord | SpeechBeatFrameWord>;
/** I-203: the one suffix a `pause` takes (⟦pause long⟧: about twice as long). Only after `pause`; any other word ignores it. */
export const SPEECH_BEAT_PAUSE_LONG = 'long' as const;

/** 舞台的哪条通道演它：表情和看向两个舞台都有；身体动作先只在 Unbound 引擎上演（方案「哪个身体演」）。 */
export type SpeechBeatChannel = 'expression' | 'gaze' | 'eyes' | 'body';

/**
 * I-175 "做多久"：标记里词后面可以加一个封闭的英文后缀，形如 ⟦pout once⟧、⟦smile-warm line⟧。
 * once = 只做一下（这一拍自己的时长）；line = 只带这一句（到这句念完的停顿）；不写 = 照现在（挂到同一条通道的下一拍或说完）。
 * 标记里从不写中文，过滤器只认英文字母、空格和连字符（I-193 起只有 go 后面还认数字、小数点、% 和 m：SpeechBeatGoTo）。规则见 how-long.ts（I-175 第 1 步写在 part-mix，第 3 步挪到这里：读它的是边说边演的两处）。
 */
export const SPEECH_BEAT_HOWS = ['once', 'line'] as const;
export type SpeechBeatHow = typeof SPEECH_BEAT_HOWS[number];

/** 一拍：word 落在去掉标记以后的字的第 at 个位置（JS 字符串下标）之前，也就是说到那里时开始演。how：她写的"做多久"（没写就没有这个字段）。 */
export interface SpeechBeat { readonly word: SpeechBeatWord; readonly at: number; readonly how?: SpeechBeatHow | typeof SPEECH_BEAT_PAUSE_LONG; readonly goTo?: SpeechBeatGoTo }

/** 一段流进来的字过滤以后：给人看、给人听的字，和这一段里新出现的拍子。 */
export interface SpeechBeatChunk { readonly text: string; readonly beats: readonly SpeechBeat[] }

/**
 * 第 2 步：主机发给两个窗口的（StreamEvent 的 'beats'，同一条回复的 id）。
 *  - beats：新落下的拍子，位置是显示的字里的（开关开着才有；关着时舞台不演）。
 *  - final：回复完成时最多一次（这条有拍子时才有）：只演不说吗、灰色小字、这一轮进她历史的字（null：不进）。
 */
export interface SpeechBeatsEvent {
  /** I-195: one small grey line under her reply when she left herself an alarm ("（她记了件事）"; never what she wrote). */
  readonly note?: string;
  readonly beats?: readonly SpeechBeat[];
  readonly final?: { readonly performanceOnly: boolean; readonly line: string; readonly history: string | null };
}

/** 整条回复过滤完以后。 */
export interface SpeechBeatSummary {
  /** 去掉标记以后的全文。 */
  readonly text: string;
  readonly beats: readonly SpeechBeat[];
  /** 整条只演不说：有拍子，字里没有文字、数字或表情符号（只剩空白和标点）。 */
  readonly performanceOnly: boolean;
  /** 丢掉的标记数：词表外的、写坏的 ⟦、超过上限的。 */
  readonly dropped: number;
  /** I-195: the bodies of her alarm markers ⟪…⟫ (never in `text`); the alarm parser reads them (shared/behaviors/alarms/parse.ts). */
  readonly alarms?: readonly string[];
}

/**
 * I-175：舞台为什么让挂着的拍子落下（舞台的 speechBeatsRelease）。'ended'：这条回复说完了；'cancelled'：停止、清空、出错；'new'：新的回复开始；
 * 'line'：带"这一句"的拍子念到了这句的停顿（只有挂到这句的落下）。'cancelled' 和 'new' 时舞台还丢掉排着等停顿的（闭嘴类形态：从不晚补）。
 */
export type SpeechBeatRelease = 'ended' | 'cancelled' | 'new' | 'line';
