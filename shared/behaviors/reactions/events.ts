/**
 * I-037 能引出反应的事件类别：**唯一登记处**。加一种事件就在这里加一行（名字、给 haiku 的一句白话、走哪条路），
 * haiku 的系统提示词、候选表、答案校验、体验记录的白名单都从这张表生成；然后在反应清单（knobs.ts）里给想由它引出的反应
 * 写上基础分。说的话的类别由 haiku 判定；身体互动由主机直接认出（摸头、捏脸、喂点心）。
 *
 * - path 'words'：说的话。和 Opus 的回复并行问 haiku 一次：它判断是哪一类、在这一类的候选里选 0–2 个。
 * - path 'body'：身体互动。不等 haiku，直接做清单里分数最高的那一个（和现在一样快）。
 * - fallbackOnly：只在 haiku 没答（失败、超时、没额度）时，按她自己的回复尾注（暖心的语境）用；不给 haiku 看。
 */
export interface ReactionEventSpec {
  readonly label: string;
  /** 给 haiku 的一句白话：什么样的话算这一类。 */
  readonly describe: string;
  readonly path: 'words' | 'body';
  readonly fallbackOnly?: boolean;
}

export const REACTION_EVENTS = Object.freeze({
  praise: { label: '被夸', describe: '用户夸她：可爱、好看、厉害、做得好、喜欢她的某一点', path: 'words' },
  'good-news': { label: '报喜', describe: '用户告诉她自己的好消息：考过了、成功了、拿到了、终于做完了', path: 'words' },
  coax: { label: '撒娇', describe: '用户对她撒娇、黏她、要她陪、要抱抱、卖萌', path: 'words' },
  care: { label: '被关心', describe: '用户关心她：问她累不累、让她休息、说想她、心疼她', path: 'words' },
  warm: { label: '暖心的话', describe: '她自己的判断说这句话是暖心的（haiku 没答时才用）', path: 'words', fallbackOnly: true },
  pat: { label: '摸头', describe: '用户摸她的头', path: 'body' },
  pinch: { label: '捏脸', describe: '用户捏她的脸', path: 'body' },
  feed: { label: '喂点心', describe: '用户喂她吃点心', path: 'body' },
} satisfies Record<string, ReactionEventSpec>);

export type ReactionEventId = keyof typeof REACTION_EVENTS;
export const REACTION_EVENT_IDS = Object.freeze(Object.keys(REACTION_EVENTS) as ReactionEventId[]);
const spec = (id: ReactionEventId): ReactionEventSpec => REACTION_EVENTS[id];
/** haiku 能判的说话类别（不含只做兜底的）。 */
export const WORD_EVENT_IDS = Object.freeze(REACTION_EVENT_IDS.filter(id => spec(id).path === 'words' && !spec(id).fallbackOnly));
export const BODY_EVENT_IDS = Object.freeze(REACTION_EVENT_IDS.filter(id => spec(id).path === 'body'));
export const isReactionEventId = (value: unknown): value is ReactionEventId => typeof value === 'string' && (REACTION_EVENT_IDS as readonly string[]).includes(value);
