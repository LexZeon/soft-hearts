// I-189 体验记录 'pose-use': one closed line each time a pose use did something (shared/senses/journal-entries.ts builds and words it).
// Closed words and a number of seconds only: never a point, a picture, a word said or a description.

/** Which use: her reading paused for you, your turned face held a barge-in, a nod/shake answer, the two-people note, sitting numbers asked. */
export const POSE_USES = ['read-pause', 'barge-hold', 'nod', 'two-people', 'sitting-asked'] as const;
export type PoseUse = (typeof POSE_USES)[number];
/** What happened (closed). */
export const POSE_USE_EVENTS = ['paused', 'resumed', 'ended', 'held', 'nod', 'shake', 'told', 'not-sent'] as const;
export type PoseUseEvent = (typeof POSE_USE_EVENTS)[number];

export const POSE_USE_WORDS: Readonly<Record<PoseUse, string>> = {
  'read-pause': '你转开或走开时她的朗读', 'barge-hold': '通话里你侧过脸说话', nod: '你点头摇头回答她', 'two-people': '画面里好像还有一个人', 'sitting-asked': '你问今天坐了多久',
};
export const POSE_USE_EVENT_WORDS: Readonly<Record<PoseUseEvent, string>> = {
  paused: '停在一句说完的地方', resumed: '你转回来，接着念', ended: '你一直没回来，后面的只留在气泡里', held: '不算插她的话',
  nod: '点头，作为回答发了过去', shake: '摇头，作为回答发了过去', told: '告诉了她（只是资料）', 'not-sent': '认出来了，但这会儿没发',
};

/** The renderer's fact (noteJournalFact 'pose-use'): exact keys, closed words, seconds 0..86400. Null when anything is off. */
export function parsePoseUseFact(value: unknown): { use: PoseUse; event: PoseUseEvent; seconds?: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>, keys = Object.keys(v);
  if (!keys.every(key => key === 'use' || key === 'event' || key === 'seconds') || !(POSE_USES as readonly unknown[]).includes(v.use) || !(POSE_USE_EVENTS as readonly unknown[]).includes(v.event)) return null;
  if (v.seconds !== undefined && !(typeof v.seconds === 'number' && Number.isFinite(v.seconds) && v.seconds >= 0 && v.seconds <= 86_400)) return null;
  return { use: v.use as PoseUse, event: v.event as PoseUseEvent, ...(v.seconds !== undefined ? { seconds: Math.round(v.seconds as number) } : {}) };
}
