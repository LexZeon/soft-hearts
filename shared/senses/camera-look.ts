/**
 * I-084 看看我更聪明 (plan option 1 "可以"): the experience journal's one line
 * per chat turn while 「发图片」 is on — whether she saw the user this turn, and if not, why. Closed words only: never the picture, never
 * a word of the chat, never haiku's facts. Before this, "she did not look" left nothing to read back (the evening of 2026-11-11).
 *
 * The line is decided in two steps: what her reply itself carried (cameraLookFirst, when the message is sent), and, when that leaves
 * it open, what her own look after the reply did (I-040, electron/senses/sense-router/host.ts reports a SenseCameraResult when its turn ends).
 * Pure: electron/senses/camera-look-journal.ts keeps the open turns and writes the line.
 */

/** What she saw of the user this turn: a clear picture with her reply, her own look after it (I-040), only the small picture, nothing. */
export const CAMERA_LOOK_SEEN = ['clear', 'later', 'small', 'none'] as const;
export type CameraLookSeen = (typeof CAMERA_LOOK_SEEN)[number];
/** How the clear picture was asked for: the words, their meaning (I-084), 「让她看看我」 / the button, a yes to her offer, a photo by hand. */
export const CAMERA_LOOK_VIA = ['words', 'appearance', 'button', 'offer', 'photo'] as const;
export type CameraLookVia = (typeof CAMERA_LOOK_VIA)[number];
/**
 * Why there was no clear picture: nothing asked and no judgment ran; the judgment (I-040 haiku) said no, or gave no usable answer; held by a "别看"; asked, but no
 * frame came; her look was still going when the turn ended (a newer message, a stopped reply, she was not free in time); her look failed.
 */
export const CAMERA_LOOK_WHY = ['not-asked', 'judge-no', 'no-judgment', 'held', 'no-frame', 'cut-short', 'look-failed'] as const;
export type CameraLookWhy = (typeof CAMERA_LOOK_WHY)[number];

/*
 * 2026-11-21
 * said nothing about where the look broke, and "cut-short" nothing about how far it got. Closed words, added only to those lines.
 */
/**
 * Why no picture came: no window could take it (the camera's window missing or not on the screen); another picture was being taken; the
 * window's frame was refused (it was hidden, not the camera's owner, or a "别看" came meanwhile); the window gave nothing in time (its camera
 * not running); 「发图片」 off or held at the moment of taking; the look's own wait ran out; the picture came but the small model said nothing
 * usable; she saw, but her line about it failed.
 */
export const CAMERA_LOOK_MISSES = ['no-window', 'busy', 'refused', 'no-answer', 'off', 'slow', 'no-facts', 'no-line'] as const;
export type CameraLookMiss = (typeof CAMERA_LOOK_MISSES)[number];
/** How far a cut-short look got: still waiting for the judgment; judged yes and looking; seen, her line not said yet. */
export const CAMERA_LOOK_STAGES = ['judging', 'looking', 'unsaid'] as const;
export type CameraLookStage = (typeof CAMERA_LOOK_STAGES)[number];
/** What cut it: a newer message (or a change of character, model or conversation); her reply stopped or failed; too late; she was not free to say it. */
export const CAMERA_LOOK_ENDS = ['newer', 'reply-ended', 'late', 'not-free'] as const;
export type CameraLookEnd = (typeof CAMERA_LOOK_ENDS)[number];
/** The detail a turn's end hands over with its camera result (each part only where it applies). */
export interface CameraLookDetail { miss?: CameraLookMiss; stage?: CameraLookStage; end?: CameraLookEnd; /** 'later' only: her line was said in her full-screen bubble while she was out ("delivered out"). */ out?: true }

/** The journal line's own fields (shared/memory/journal.ts adds the type, the character and the time). */
export type CameraLookLine = { seen: 'clear'; via: CameraLookVia } | { seen: 'later'; out?: true } | ({ seen: 'small' | 'none'; why: CameraLookWhy } & CameraLookDetail);

/** I-040's camera part when its turn ended (electron/senses/sense-router/host.ts): looked and she had her say; the judgment said no; … */
export const SENSE_CAMERA_RESULTS = ['seen', 'judge-no', 'no-judgment', 'off', 'covered', 'cut-short', 'failed'] as const;
export type SenseCameraResult = (typeof SENSE_CAMERA_RESULTS)[number];

/** What the message carried when it was sent; `asked`: its words asked her to look at the user; `miss`: why the asked-for picture did not come. */
export interface CameraLookTurn { via: CameraLookVia | null; small: boolean; held: boolean; asked: boolean; miss?: CameraLookMiss | null }

/** The line, or that it waits for her own look (I-040): `small` says whether the small picture went. */
export function cameraLookFirst(turn: CameraLookTurn): { line: CameraLookLine } | { waits: { small: boolean } } {
  if (turn.via) return { line: { seen: 'clear', via: turn.via } };
  const seen = turn.small ? 'small' : 'none';
  if (turn.held) return { line: { seen, why: 'held' } };
  if (turn.asked) return { line: { seen, why: 'no-frame', ...(turn.miss && CAMERA_LOOK_MISSES.includes(turn.miss) ? { miss: turn.miss } : {}) } };
  return { waits: { small: turn.small } };
}

const LATER_WHY: Readonly<Record<Exclude<SenseCameraResult, 'seen'> | 'untaken', CameraLookWhy>> = {
  'judge-no': 'judge-no', 'no-judgment': 'no-judgment', off: 'no-frame', covered: 'not-asked', 'cut-short': 'cut-short', failed: 'look-failed', untaken: 'not-asked',
};

/** The line once her own look is over; 'untaken': no look was going to happen (the feature off, no character, nothing on). */
export function cameraLookLater(small: boolean, result: SenseCameraResult | 'untaken', detail: CameraLookDetail = {}): CameraLookLine {
  if (result === 'seen') return detail.out === true ? { seen: 'later', out: true } : { seen: 'later' };
  const why = LATER_WHY[result];
  // The detail only where it says something: a miss on a failed look, how far a cut-short look got and what cut it.
  const miss = why === 'look-failed' && detail.miss && CAMERA_LOOK_MISSES.includes(detail.miss) ? { miss: detail.miss } : {};
  const stage = why === 'cut-short' && detail.stage && CAMERA_LOOK_STAGES.includes(detail.stage) ? { stage: detail.stage } : {};
  const end = why === 'cut-short' && detail.end && CAMERA_LOOK_ENDS.includes(detail.end) ? { end: detail.end } : {};
  return { seen: small ? 'small' : 'none', why, ...miss, ...stage, ...end };
}

/** Plain words for the journal (shared/memory/journal.ts; English in shared/foundation/ui-copy.journal.en.ts). */
export const CAMERA_LOOK_SEEN_WORDS: Readonly<Record<CameraLookSeen, string>> = {
  clear: '这一轮她看清了你', later: '她回完话又看了你一眼', small: '这一轮她只有你的小图', none: '这一轮她没看到你',
};
export const CAMERA_LOOK_VIA_WORDS: Readonly<Record<CameraLookVia, string>> = {
  words: '你叫她看的', appearance: '你问到自己的样子', button: '你点了按钮', offer: '她问要不要看，你说好', photo: '你拍给她的',
};
export const CAMERA_LOOK_WHY_WORDS: Readonly<Record<CameraLookWhy, string>> = {
  'not-asked': '没人叫她看', 'judge-no': '她判断这句不用看', 'no-judgment': '这句要不要看，没判断出来', held: '你说过别看', 'no-frame': '叫她看了，但没拿到画面',
  'cut-short': '没等她判断完或看完，这一轮就过去了', 'look-failed': '她想看，没看成',
};
export const CAMERA_LOOK_MISS_WORDS: Readonly<Record<CameraLookMiss, string>> = {
  'no-window': '没有能拍的窗口', busy: '正在拍另一张', refused: '拍到的画面没被收下', 'no-answer': '摄像头那边没回画面', off: '那一刻发图片关着或你说了别看',
  slow: '等太久了', 'no-facts': '拍到了，但没看出什么', 'no-line': '看到了，但那句话没说出来',
};
export const CAMERA_LOOK_STAGE_WORDS: Readonly<Record<CameraLookStage, string>> = { judging: '还在判断要不要看', looking: '判断要看，正在看', unsaid: '看到了，还没来得及说' };
/** 2026-11-21: a 'later' look whose line was said in her full-screen bubble (she was out). */
export const CAMERA_LOOK_OUT_WORD = '她在全屏里说了';
export const CAMERA_LOOK_END_WORDS: Readonly<Record<CameraLookEnd, string>> = { newer: '你又说了一句', 'reply-ended': '她的回复停了', late: '太晚了', 'not-free': '她一直没空说' };
