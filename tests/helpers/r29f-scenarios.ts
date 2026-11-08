/**
 * R29f scenes on the real Stage frame loop (gene-stage-harness), shared by tests/r29f-smoothness.test.ts and
 * one-off probes. Each scene runs on a 60 Hz screen (refreshHz 60) with the stage's own frame clock at a given
 * fps setting; windows are measured with tests/helpers/smoothness.ts.
 */
import { EMPTY_CONTACT } from '../../src/stage/mood-feedback';
import { HerLifeStage, herLifeStageLoader } from '../../src/stage/her-life-stage';
import type { HerLifeActivity, HerLifeView } from '../../shared/her-life';
import { catalogAsset, geneStage, patContact, pointAtScalp, type GeneStage, type GeneStageOptions } from './gene-stage-harness';
import { measureWindow, type WindowMeasure } from './smoothness';

export interface Cue { at: number; act(h: GeneStage): void | Promise<void> }
export interface Scenario {
  name: string;
  seconds: number;
  options?: GeneStageOptions;
  setup?(h: GeneStage): void | Promise<void>;
  cues?: Cue[];
  during?(h: GeneStage, t: number): void;
  /**
   * [label, from (s), to (s), limit]: limit is the largest display Δω (°/s) allowed at the 60 fps setting, or null for a
   * window only reported (the R15 dance, confirmed by the user and left as it was; the dance clip's own fast content).
   */
  windows: [string, number, number, number | null][];
  extra?: string[];
}

function setHerLife(h: GeneStage, activity: HerLifeActivity): void {
  const view = h.stage.moodView;
  const herLife: HerLifeView = { activity, since: Date.now(), until: Date.now() + 600_000, source: 'rule', lookUp: null };
  h.stage.setMood({ ...view, revision: view.revision + 1, herLife });
}
async function herLifeReady(h: GeneStage): Promise<void> {
  const stage = h.stage;
  stage.herLife = new HerLifeStage(herLifeStageLoader({ mesh: () => stage.mesh, token: () => stage.moodView?.token ?? null, transform: () => undefined, unfit: () => false }));
  setHerLife(h, 'company');
  for (const id of ['thinking', 'sleepy']) stage.herLife.request(id);
  for (let i = 0; i < 400 && Object.values(stage.herLife.getState().clips).some(state => state === 'loading'); i++) await new Promise(resolve => setTimeout(resolve, 2));
}
async function playGesture(h: GeneStage): Promise<void> {
  const cue = { id: `g-${Math.random()}`, at: Date.now(), expiresAt: Date.now() + 60_000, intent: 'explain' as const, strength: 0.55, reason: 'test' };
  h.stage.moodView = { ...h.stage.moodView, gesture: cue };
  await h.stage.playChatGesture(cue, h.stage.moodView.token);
}
/** The host polls the cursor every 100 ms (src/main.ts pointerTimer); here it sweeps slowly across the screen. */
function mousePoll(h: GeneStage, t: number): void {
  const slot = Math.floor(t / 0.1);
  if (slot === (h as unknown as { lastPoll?: number }).lastPoll) return;
  (h as unknown as { lastPoll?: number }).lastPoll = slot;
  const at = slot * 0.1;
  h.stage.setPointer({ x: 0.7 * Math.sin(2 * Math.PI * at / 5), y: -0.05 + 0.25 * Math.sin(2 * Math.PI * at / 7) });
}
const her = (stage: any) => stage.setMusicSettings({ alwaysDance: false });

export const SCENARIOS: Scenario[] = [
  { name: 'idle', seconds: 10, windows: [['待机（站着、呼吸、小动作）', 1, 10, 3.3]] },
  { name: 'mouse', seconds: 10, during: mousePoll, extra: ['左目'], windows: [['跟鼠标（光标每 100 ms 读一次）', 1, 10, 5]] },
  { name: 'her-life', seconds: 16, options: { herLife: true }, setup: herLifeReady,
    cues: [{ at: 2, act: h => setHerLife(h, 'thinking') }, { at: 10, act: h => setHerLife(h, 'company') }],
    windows: [['L2 想事情：进', 2, 9, 3.6], ['L2 想事情：出', 10, 16, 3.6]] },
  { name: 'her-life-switch', seconds: 9, options: { herLife: true }, setup: herLifeReady,
    cues: [{ at: 2, act: h => setHerLife(h, 'daydream') }, { at: 3, act: h => setHerLife(h, 'humming') }, { at: 3.8, act: h => setHerLife(h, 'daydream') },
      { at: 6, act: h => { h.stage.setBodyInputBlocked(true); h.stage.setTyping(true); } }, { at: 6.4, act: h => { h.stage.setTyping(false); h.stage.setBodyInputBlocked(false); } }],
    windows: [['L2 状态中途切换', 2, 6, 3.6], ['L2 让位又回来（打字 0.4 s）', 6, 9, 3.6]] },
  { name: 'chat-gesture', seconds: 6, options: { chatGesture: { packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2' } },
    cues: [{ at: 2, act: playGesture }, { at: 3.5, act: h => h.stage.setTyping(true) }, { at: 4.5, act: h => h.stage.setTyping(false) }],
    windows: [['聊天手势：开始', 1.9, 3.4, 30], ['聊天手势：被打字打断', 3.45, 5.5, 18]] },
  { name: 'pat', seconds: 7, cues: [{ at: 3, act: pointAtScalp }, { at: 5.1, act: h => h.stage.setMoodContact({ ...EMPTY_CONTACT }) }],
    during: (h, t) => { if (t >= 3.6 && t < 5.1) h.stage.setMoodContact(patContact(t)); },
    windows: [['摸头：开始', 3.5, 4.4, 3.3], ['摸头：松手', 5, 6.5, 3.3]] },
  { name: 'feed', seconds: 8,
    during: (h, t) => {
      if (t >= 3 && t < 5.6) h.stage.setMoodContact({ ...EMPTY_CONTACT, feeding: true, prepared: t > 4.4, near: Math.min(1, (t - 3) / 1.2), x: 0, y: 0.3, accepted: t > 5 });
      else if (t >= 5.6 && t < 5.7) h.stage.setMoodContact({ ...EMPTY_CONTACT });
    },
    windows: [['喂食：靠近、张嘴、咬下、离开', 2.9, 7, 15]] },
  { name: 'pat-music', seconds: 8, options: { music: true }, cues: [{ at: 3, act: pointAtScalp }, { at: 5.1, act: h => h.stage.setMoodContact({ ...EMPTY_CONTACT }) }],
    during: (h, t) => { if (t >= 3.6 && t < 5.1) h.stage.setMoodContact(patContact(t)); },
    windows: [['律动中摸头', 3.5, 7.5, null]] },
  { name: 'm1-nod', seconds: 12, options: { music: false, primary: 'calm' }, setup: h => her(h.stage),
    cues: [{ at: 1, act: h => h.stage.setMusicEnabled(true) }, { at: 9, act: h => h.stage.setMusicEnabled(false) }],
    windows: [['M1 点头：开始', 1, 5, 4], ['M1 点头：停', 9, 12, 3.3]] },
  { name: 'm1-dance', seconds: 12, options: { music: false, primary: 'happy' }, setup: h => her(h.stage),
    cues: [{ at: 1, act: h => h.stage.setMusicEnabled(true) }, { at: 9, act: h => h.stage.setMusicEnabled(false) }],
    windows: [['M1 跳舞：开始（R15 的舞）', 1, 4, null], ['跳舞：停（R15 已确认）', 9, 12, null]] },
  { name: 'r29e', seconds: 7.2, options: { layers: { pose: catalogAsset('gene', 'stand'), gesture: catalogAsset('genea-2022-gestures', 'speaking-gesture-2'), expression: null } },
    cues: [{ at: 5.1, act: h => h.stage.loadMotions({ pose: catalogAsset('fnoji-dances', 'split-dance'), gesture: null, expression: null }, false) }],
    windows: [['R29e 换成 split-dance（过渡期）', 5.1, 6.7, null]] },
];

export interface ScenarioResult { scenario: string; window: string; fps: number; limit: number | null; measure: WindowMeasure }

export async function runScenario(scenario: Scenario, fps: number, extra: Partial<GeneStageOptions> = {}): Promise<ScenarioResult[]> {
  const h = await geneStage({ ...scenario.options, fps, refreshHz: 60, extraBones: scenario.extra, ...extra });
  try {
    await scenario.setup?.(h);
    const pending = [...(scenario.cues ?? [])].sort((a, b) => a.at - b.at);
    const callbacks = Math.round(scenario.seconds * 60);
    for (let i = 0; i < callbacks; i++) {
      const t = h.time();
      while (pending.length && pending[0].at <= t + 1e-9) await pending.shift()!.act(h);
      scenario.during?.(h, t);
      h.tick();
    }
    return scenario.windows.map(([window, from, to, limit]) => ({ scenario: scenario.name, window, fps, limit, measure: measureWindow(h, from, to, scenario.extra ?? []) }));
  } finally { h.close(); }
}

const f1 = (value: number) => value.toFixed(1);
export function reportRow(result: ScenarioResult): string {
  const m = result.measure;
  return `| ${result.window} | ${result.fps} | ${f1(m.display.maxDv)}（${m.worstBone} @${m.display.maxAt.toFixed(2)}s） | ${f1(m.rendered.maxDv)} | ${m.renderedSpikes} | ${m.displayHolds} | ${m.guard} |`;
}

