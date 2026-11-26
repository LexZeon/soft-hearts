// Motion-model spike (docs/claude/2026-11-14-motion-model-spike.md): the compared idle groups for the browser-side preview and
// video pages (data fetched over the preview host's own idlep:// scheme, from .local/ml/; nothing ships with the app).
// StayStill round (docs/claude/2026-11-14-staystill-idle.md): the model retrained on StayStill, its event library and its held-out
// test subjects as a second human reference, all optional (fetched only when the host serves them).
import { IDLE_DIM, type ContinuousIdleSource, type IdleSource } from '../../src/unbound/motion/idle-channels';
import { ProceduralIdle } from '../../src/unbound/motion/idle-procedural';
import { MatchingIdle, type IdleDatabase } from '../../src/unbound/motion/idle-matching';
import { IdleModel, ModelIdle, type IdleModelWeights } from '../../src/unbound/motion/idle-model';
import { IdleEvents, type IdleEventLibrary } from '../../src/unbound/motion/idle-events';
import { LEARNED_IDLE_EVENT_RATE, type LearnedIdle } from '../../src/unbound/motion/learned-idle';
import { UNBOUND_IDLE_MODEL, createBundledIdle } from '../../src/unbound/motion/bundled-idle';

export type IdleGroup = 'rest' | 'people' | 'procedural' | 'matching' | 'model' | 'model+events' | '100style+events' | 'ss-model' | 'ss-model-raw' | 'ss-model+events' | 'ss-model-raw+events' | 'ss-people' | 'unbound';
export const GROUP_LABELS: Record<IdleGroup, string> = {
  rest: '安静站着（现在的 Unbound）', people: '真人原样（参照，没参加训练）', procedural: '程序化', matching: '动作匹配', model: '小模型', 'model+events': '小模型 + 真人快动作',
  '100style+events': '100STYLE 小模型 + 快动作', 'ss-model': 'StayStill 小模型（校准增益）', 'ss-model-raw': 'StayStill 小模型', 'ss-model+events': 'StayStill 小模型（校准增益）+ 快动作', 'ss-model-raw+events': 'StayStill 小模型 + 快动作', 'ss-people': 'StayStill 真人原样（参照，没参加训练）',
  unbound: 'Unbound 现在用的（同一模型，拴绳 8 秒 + 软上限）',
};
/** Groups that need the StayStill files. */
export const STAYSTILL_GROUPS: readonly IdleGroup[] = ['ss-model', 'ss-model-raw', 'ss-model+events', 'ss-model-raw+events', 'ss-people', 'unbound'];

/**
 * Unbound's idle as the app plays it (docs/claude/2026-11-14-staystill-idle.md「接进 Unbound」): the StayStill files with the
 * manifest's settings (leash, soft bounds), as a whole LearnedIdle (the bounds act on the targets, not on the channels).
 */
export function makeGroupIdle(group: IdleGroup, seed: number, data: GroupData, heightM: number): LearnedIdle | null {
  if (group !== 'unbound' || !data.ssWeights || !data.ssEvents) return null;
  return createBundledIdle(heightM, { variant: UNBOUND_IDLE_MODEL.variant, settings: UNBOUND_IDLE_MODEL.settings, weights: data.ssWeights, events: data.ssEvents }, seed);
}

export interface GroupData {
  db: IdleDatabase; people: IdleDatabase & { segments: { style: string; start: number }[] }; weights: IdleModelWeights; events: IdleEventLibrary;
  ssWeights?: IdleModelWeights; ssEvents?: IdleEventLibrary; ssEventRate?: number; ssPeople?: IdleDatabase;
}

const f32 = async (url: string) => new Float32Array(await (await fetch(url)).arrayBuffer());
const optional = async <T>(load: () => Promise<T>): Promise<T | undefined> => { try { return await load(); } catch { return undefined; } };
const json = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
export async function fetchGroupData(): Promise<GroupData> {
  const meta = await json('idlep://data/wide.json'), pmeta = await json('idlep://data/people.json');
  const emeta = await json('idlep://data/events.json');
  const ss = await optional(() => json('idlep://data/ss-plan.json')) as { eventRate?: number } | undefined;
  return {
    db: { frames: await f32('idlep://data/wide.f32'), activity: await f32('idlep://data/wide-activity.f32'), segments: meta.segments, std: meta.std },
    people: { frames: await f32('idlep://data/people.f32'), activity: await f32('idlep://data/people-activity.f32'), segments: pmeta.segments, std: pmeta.std },
    weights: await json('idlep://data/model.json'),
    events: { events: await f32('idlep://data/events.f32'), frames: emeta.frames, perMinuteByActivityFifth: emeta.perMinuteByActivityFifth },
    ...(ss ? {
      ssWeights: await json('idlep://data/ss-model.json'),
      ssEvents: await optional(async () => { const m = await json('idlep://data/ss-events.json'); return { events: await f32('idlep://data/ss-events.f32'), frames: m.frames, perMinuteByActivityFifth: m.perMinuteByActivityFifth }; }),
      ssEventRate: ss.eventRate ?? 1,
      ssPeople: await optional(async () => { const m = await json('idlep://data/ss-people.json'); return { frames: await f32('idlep://data/ss-people.f32'), activity: await f32('idlep://data/ss-people-activity.f32'), segments: m.segments, std: m.std }; }),
    } : {}),
  };
}

export function makeGroupSource(group: IdleGroup, seed: number, data: GroupData): IdleSource | ContinuousIdleSource | null {
  switch (group) {
    case 'rest': return null;
    case 'people': return new MatchingIdle(data.people, { seed, searchEvery: 1e6, topK: 3 }); // whole stretches, joined smoothly at their ends
    case 'procedural': return new ProceduralIdle(seed);
    case 'matching': return new MatchingIdle(data.db, { seed });
    case 'model': return new ModelIdle(new IdleModel(data.weights), { seed });
    case 'model+events': case '100style+events': return new IdleEvents(new ModelIdle(new IdleModel(data.weights), { seed }), data.events, { seed: seed + 100, rateScale: LEARNED_IDLE_EVENT_RATE });
    case 'ss-model': return data.ssWeights ? new ModelIdle(new IdleModel(data.ssWeights), { seed }) : null;
    case 'ss-model-raw': return data.ssWeights ? new ModelIdle(new IdleModel(data.ssWeights), { seed, calibrated: false }) : null; // without the output gains (closer to the people on her body)
    case 'ss-model+events': return data.ssWeights && data.ssEvents ? new IdleEvents(new ModelIdle(new IdleModel(data.ssWeights), { seed }), data.ssEvents, { seed: seed + 100, rateScale: data.ssEventRate ?? 1 }) : null;
    case 'ss-model-raw+events': return data.ssWeights && data.ssEvents ? new IdleEvents(new ModelIdle(new IdleModel(data.ssWeights), { seed, calibrated: false }), data.ssEvents, { seed: seed + 100, rateScale: data.ssEventRate ?? 1 }) : null;
    case 'ss-people': return data.ssPeople ? new MatchingIdle(data.ssPeople, { seed, searchEvery: 1e6, topK: 3 }) : null;
    case 'unbound': return null; // a whole LearnedIdle: makeGroupIdle
  }
}
