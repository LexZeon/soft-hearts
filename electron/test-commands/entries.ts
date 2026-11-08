import { t } from '../../shared/ui-language';
import type { HerLifeActivity } from '../../shared/her-life';
import type { RelationshipStage } from '../../shared/relationship';
import type { MoodLabel } from '../../shared/mood';
import type { HerNeedId } from '../../shared/her-needs';
import { MOOD_LABELS } from '../../shared/mood-runtime';
import type { TestFatiguePhase } from '../../shared/mood-presets';
import { USER_STATE_FADE_MS, type ActiveUserState } from '../../shared/user-state';
import type { TestEntryMeta } from './match';
import type { ExpressionRecipe } from '../../shared/expression-preview';
import type { PoseSimulation, PoseSimulationResult } from '../pose-reactions/host';
import { HER_ACTION_DETAILS, HER_ACTION_SPECS, type HerActionId, type HerActionPlayResult } from '../../shared/her-actions';

/**
 * The registry of test entries (D2 / I-008, docs/claude/2026-11-03-test-commands.md). Every entry only calls a feature's
 * existing local interface through `TestCommandDeps`, and every one is local and undoable. Deleting things, sending
 * messages, changing real settings and reading or writing files are deliberately NOT here (a test pins that).
 *
 * Adding a feature's test entry = one more row in `buildTestEntries` and its dependency in `TestCommandDeps`.
 */

export type HerLifeStart = { ok: true; activity: HerLifeActivity } | { ok: false; reason: 'no-character' | 'expressions-off' };
export type DiaryWriteNow = 'started' | 'recording-off' | 'nothing-due' | 'busy' | 'unavailable';
export type InnerLoopAvailability = 'ok' | 'setting-off' | 'expressions-off' | 'no-character';

export interface TestCommandDeps {
  /** L2 她自己的生活: start a state now (null = she picks one by her own rules). */
  herLife: { start(activity: HerLifeActivity | null): HerLifeStart };
  /** L1 内心循环: the loop's own opportunity, handed over now. */
  innerLoop: {
    available(): InnerLoopAvailability;
    /** The Chinese reason the opportunity cannot start right now (electron/test-commands/cue-gate.ts), or null. */
    blocker(): string | null;
    /** Gives her the opportunity (pacing reset, mood cue forced). False: the mood host refused (quota, a cue is showing, not idle). */
    force(kind: 'motion' | 'speech'): boolean;
  };
  /** F3 熟悉度: the hand-set stage that dev mode already has (until restart). */
  relationship: { slowWarmUp(): boolean; setStage(stage: RelationshipStage | null): void };
  /** F2 读懂你的情绪: her memory-only read of the user. False: no character yet. */
  userState: { set(state: ActiveUserState | null): boolean };
  /** L4 她也会需要你: she has this small need right now (counts for nothing against the day's limits). */
  needs: { start(id: HerNeedId): 'ok' | 'no-character' | 'expressions-off' };
  /** M1 音频律动由她决定: asks the stage to judge again at once. */
  music: { rejudge(): void };
  /** E1 惊喜 / 害羞 previews: every window's stage plays it on its model (the same request as the buttons). False: no pet window to show it. */
  expression: { play(recipe: ExpressionRecipe): boolean };
  /**
   * Her own mood (U-012, so M1 can be tried under each mood): `set(label)` puts it at that state and returns the label now
   * shown (null: developer mode off or no character); `set(null)` puts it back to the baseline (and cancels the temporary
   * drowsy look); `fatigue` gives her a temporary (light-)drowsy look, null cancels it.
   */
  mood: { set(label: MoodLabel | null): MoodLabel | null; fatigue(phase: TestFatiguePhase | null): boolean };
  /** G1 猜拳: her invitation buttons (no invitation quota spent), or a match right away. */
  rps: { invite(): boolean; start(): boolean };
  /** L3 日记: the writer's own pass, now, under the user profile's own recording switch. */
  diary: { writeNow(): DiaryWriteNow };
  /**
   * P1 第二阶段: as if local camera sensing saw it (no camera is opened). A yawn, a stretch or a wave is followed for sure (the chance
   * is skipped, nothing else); "坐了很久" gives her own stretch; "回来了" is an arrival. The pretend session lasts ten minutes.
   */
  pose: { simulate(kind: PoseSimulation): PoseSimulationResult };
  /**
   * 她的动作 (T-211, shared/her-actions.ts): every window's stage plays the action on its own model; the answer is the pet
   * window's (played, skipped for a missing part, busy…), or no pet window, or no answer in time.
   */
  action: { play(id: HerActionId): Promise<HerActionPlayResult> };
  /**
   * I-006 第 1 步: pretend the user is absorbed ('busy') or just stopped for a breather ('pause') for a few minutes, or stop pretending (null).
   * Reads nothing from the real keyboard and mouse. 'switch-off': the privacy switch 「知道你是不是在忙」 is off.
   */
  userActivity: { pretend(kind: 'busy' | 'pause' | null): 'ok' | 'switch-off' };
  /** I-006 第 3 步: pretend the user is watching a video or playing a game on the shared screen (null: stop). Reads no real screen; needs no screen sharing. */
  watchAlong: { pretend(kind: 'video' | 'game' | null): void };
  clock?: () => number;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export interface TestRunContext {
  /** A later note line (for entries that wait). */
  note(text: string): void;
}

export interface TestEntry extends TestEntryMeta {
  run(context: TestRunContext): string | Promise<string>;
}

export interface TestEntries {
  entries: readonly TestEntry[];
  /** Cancels a waiting entry (new command, window gone). */
  dispose(): void;
}

/** A waiting entry looks again this often, for at most TEST_WAIT_MS. */
const POLL_MS = 500;
export const TEST_WAIT_MS = 45_000;

const say = (key: string, params?: Record<string, string | number>) => t(key, params);
/** "我累" "我很累" "我好累" "我有点累" "用户累" …: the user speaking about themselves (the bare word is about her, see the MOOD entries). */
const self = (...words: string[]): string[] => words.flatMap(word => [`我${word}`, `我很${word}`, `我好${word}`, `我有点${word}`, `我特别${word}`, `我真${word}`, `用户${word}`, `用户很${word}`]);

const LIFE_STARTED: Readonly<Record<HerLifeActivity, string>> = {
  company: '（测试：已让她回到“陪着你”，不再忙自己的事。）',
  daydream: '（测试：已让她开始发呆。你不去碰她，她就一直发着呆；你一互动，她就抬起头。）',
  humming: '（测试：已让她开始哼歌（不出声，只有节奏和神情）。你一互动，她就抬起头。）',
  thinking: '（测试：已让她开始想事情。你一互动，她就抬起头。）',
  drowsy: '（测试：已让她开始犯困。你一互动，她就醒过来。）',
  watching: '（测试：已让她开始跟着看屏幕。需要“假装我在看视频”。）',
};
const LIFE_PICKED: Readonly<Record<HerLifeActivity, string>> = {
  company: '（测试：她按自己的心情和性格，选了继续陪着你。）',
  daydream: '（测试：她按自己的心情和性格，挑了“发呆”。你一互动，她就抬起头。）',
  humming: '（测试：她按自己的心情和性格，挑了“哼歌”（不出声）。你一互动，她就抬起头。）',
  thinking: '（测试：她按自己的心情和性格，挑了“想事情”。你一互动，她就抬起头。）',
  drowsy: '（测试：她按自己的心情和性格，选了犯困。你一互动，她就醒过来。）',
  watching: '（测试：她按自己的心情和性格，选了跟着看屏幕。）',
};
const NO_CHARACTER = '（测试：还没有选中角色，先选一个角色。）';

const POSE_DONE: Readonly<Record<PoseSimulation, string>> = {
  yawn: '（测试：假装摄像头看到你打了个哈欠。她零点几秒后跟着打一个（测试时一定跟；平时看性格和困意，大约十次跟两三次）。聊天、摸头这些一来她就让开。）',
  stretch: '（测试：假装摄像头看到你伸了个懒腰。她稍等一下也伸个小懒腰：挺胸、耸肩再放下、歪头、深呼吸、眯眼（测试时一定跟；平时大约十次跟两三次）。）',
  wave: '（测试：假装摄像头看到你冲她挥手。她稍等一下举手挥一挥回应你（测试时一定回应；平时看性格）。）',
  sat: '（测试：假装摄像头看到你已经坐了约 50 分钟。她自己伸个小懒腰活动一下，是她自己想动，不是提醒你。）',
  arrive: '（测试：假装摄像头看到你离开一会儿又回到电脑前。她抬眼看你一下，无聊少一点（不算一次互动）。）',
};

const NEED_STARTED: Readonly<Record<HerNeedId, string>> = {
  lonely: '（测试：她现在有点闷。摸摸头、喂点吃的或聊几句能哄好；没人理，它会淡掉并让她低落一点。）',
  dream: '（测试：她现在像是做了个不开心的梦。摸摸头、喂点吃的或聊几句能哄好；没人理，它会淡掉并让她低落一点。）',
  lowEnergy: '（测试：她现在有点没精神。摸摸头、喂点吃的或聊几句能哄好；没人理，它会淡掉并让她低落一点。）',
  chatty: '（测试：她现在无聊得想找人说话。摸摸头、喂点吃的或聊几句能哄好；没人理，它会淡掉并让她低落一点。）',
};

const STAGE_SET: Readonly<Record<RelationshipStage, string>> = {
  new: '（测试：已把熟悉度临时设成“初识”，重启后复原。）',
  warming: '（测试：已把熟悉度临时设成“熟起来”，重启后复原。）',
  familiar: '（测试：已把熟悉度临时设成“熟悉”，重启后复原。）',
  close: '（测试：已把熟悉度临时设成“亲近”，重启后复原。）',
  old: '（测试：已把熟悉度临时设成“老朋友”，重启后复原。）',
};

const USER_STATE_SET: Readonly<Record<ActiveUserState, string>> = {
  tired: '（测试：已让她读到你现在很累，约 {0} 分钟后淡去。从下一句聊天起，她会按这个状态对你。）',
  annoyed: '（测试：已让她读到你现在很烦，约 {0} 分钟后淡去。从下一句聊天起，她会按这个状态对你。）',
  low: '（测试：已让她读到你现在情绪低落，约 {0} 分钟后淡去。从下一句聊天起，她会按这个状态对你。）',
  happy: '（测试：已让她读到你现在很开心，约 {0} 分钟后淡去。从下一句聊天起，她会按这个状态对你。）',
  excited: '（测试：已让她读到你现在很兴奋，约 {0} 分钟后淡去。从下一句聊天起，她会按这个状态对你。）',
};

const CUE = {
  motion: {
    fired: '（测试：已给她一次小动作的时机。她要想一想才会动，也可能什么都不做；结果看开发者面板里的内心循环记录。）',
    refused: '（测试：这次没给成：她现在不在待机状态，或者正有一个提示在显示。）',
    waiting: '（测试：现在不方便（{0}）。等她方便了，马上给她一次小动作的时机，最多等 {1} 秒。）',
  },
  speech: {
    fired: '（测试：已给她一次说话的时机。她要想一想才会开口，也可能选择不说；结果看开发者面板里的内心循环记录。）',
    refused: '（测试：这次没给成：她这小时说话的次数用完了，或者正有一个提示在显示。）',
    waiting: '（测试：现在不方便（{0}）。等她方便了，马上给她一次说话的时机，最多等 {1} 秒。）',
  },
} as const;

/** The entries. Names, aliases and summaries are Chinese source text; the help list translates names and summaries. */
export function buildTestEntries(deps: TestCommandDeps): TestEntries {
  const clock = deps.clock ?? Date.now;
  const timers = deps.timers ?? {
    set: (callback: () => void, ms: number) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let waiting: unknown = null;
  const stopWaiting = () => { if (waiting !== null) { timers.clear(waiting); waiting = null; } };

  const life = (id: string, name: string, aliases: string[], summary: string, activity: HerLifeActivity | null): TestEntry => ({
    id, name, aliases, summary,
    run: () => {
      const started = deps.herLife.start(activity);
      if (!started.ok) return say(started.reason === 'no-character' ? NO_CHARACTER
        : '（测试：“暂停自动表现”开着，她不会做自己的事。先在心情面板里打开自动表现。）');
      return say((activity === null ? LIFE_PICKED : LIFE_STARTED)[started.activity]);
    },
  });

  const cue = (id: string, name: string, aliases: string[], summary: string, kind: 'motion' | 'speech'): TestEntry => ({
    id, name, aliases, summary,
    run: context => {
      stopWaiting();
      const availability = deps.innerLoop.available();
      if (availability === 'no-character') return say(NO_CHARACTER);
      if (availability === 'setting-off') return say('（测试：“内心循环”开关是关的，先在设置里打开。）');
      if (availability === 'expressions-off') return say('（测试：“暂停自动表现”开着，内心循环不会给她时机。先打开自动表现。）');
      const text = CUE[kind];
      const fire = () => say(deps.innerLoop.force(kind) ? text.fired : text.refused);
      const blocker = deps.innerLoop.blocker();
      if (!blocker) return fire();
      const started = clock();
      let last = blocker;
      const attempt = () => {
        waiting = null;
        const now = deps.innerLoop.blocker();
        if (!now) { context.note(fire()); return; }
        last = now;
        if (clock() - started >= TEST_WAIT_MS) {
          context.note(say('（测试：等了 {0} 秒她一直不方便（{1}），先取消了。方便的时候再打一次。）', { 0: TEST_WAIT_MS / 1000, 1: say(last) }));
          return;
        }
        waiting = timers.set(attempt, POLL_MS);
      };
      waiting = timers.set(attempt, POLL_MS);
      return say(text.waiting, { 0: say(blocker), 1: TEST_WAIT_MS / 1000 });
    },
  });

  const stage = (id: string, name: string, aliases: string[], summary: string, value: RelationshipStage | null): TestEntry => ({
    id, name, aliases, summary,
    run: () => {
      try { deps.relationship.setStage(value); } catch { return say('（测试：没能设置熟悉度阶段。先确认开发者模式开着。）'); }
      if (value === null) return say('（测试：已取消临时阶段，回到真实的熟悉度。）');
      const first = say(STAGE_SET[value]);
      return deps.relationship.slowWarmUp() ? first
        : `${first}${say('这张角色卡没开“慢慢熟起来”，现在看不出区别。')}`;
    },
  });

  const mood = (id: string, name: string, aliases: string[], summary: string, value: ActiveUserState | null): TestEntry => ({
    id, name, aliases, summary,
    run: () => {
      if (!deps.userState.set(value)) return say(NO_CHARACTER);
      return value === null ? say('（测试：已清除她读到的你的状态。）')
        : say(USER_STATE_SET[value], { 0: Math.round(USER_STATE_FADE_MS[value] / 60_000) });
    },
  });

  const need = (id: string, name: string, aliases: string[], summary: string, value: HerNeedId): TestEntry => ({
    id, name, aliases, summary,
    run: () => {
      const started = deps.needs.start(value);
      if (started === 'no-character') return say(NO_CHARACTER);
      if (started === 'expressions-off') return say('（测试：“暂停自动表现”开着，她不会露出小需要。先打开自动表现。）');
      return say(NEED_STARTED[value]);
    },
  });

  const herMood = (id: string, name: string, aliases: string[], summary: string, label: MoodLabel): TestEntry => ({
    id, name, aliases, summary,
    run: () => {
      const shown = deps.mood.set(label);
      if (shown === null) return say(NO_CHARACTER);
      const words = { 0: say(MOOD_LABELS[label]), 1: say(MOOD_LABELS[shown]) };
      return say(shown === label
        ? '（测试：已把她的心情设成“{0}”，之后按各通道自己的速度慢慢回到基线；你一和她互动（聊天、摸、喂），就按真实的来。想马上回去，打“测试：恢复心情”。）'
        : '（测试：想把她的心情设成“{0}”，但这张角色卡的反应设置让现在显示的是“{1}”。想马上回到基线，打“测试：恢复心情”。）', words);
    },
  });

  const pose = (id: string, name: string, aliases: string[], summary: string, kind: PoseSimulation): TestEntry => ({
    id, name, aliases, summary,
    run: () => {
      const result = deps.pose.simulate(kind);
      if (result === 'no-character') return say(NO_CHARACTER);
      if (result === 'expressions-off') return say('（测试：“暂停自动表现”开着，她不会有反应。先在心情面板里打开自动表现。）');
      return say(POSE_DONE[kind]);
    },
  });

  // I-006 第 1 步: pretend the user is absorbed / just paused. Nothing real is read; the pretence ends by itself or with "不再假装".
  const userActivity = (id: string, name: string, aliases: string[], summary: string, kind: 'busy' | 'pause' | null): TestEntry => ({
    id, name, aliases, summary,
    run: () => {
      if (kind === null) deps.watchAlong.pretend(null);
      if (deps.userActivity.pretend(kind) === 'switch-off') return say('（测试：隐私页的“知道你是不是在忙”是关着的，她不读这个。先打开它。）');
      return say(kind === 'busy' ? '（测试：假装你正在专心做事，约 10 分钟。她的无聊涨得慢，开口时更偏向这次不说，更常发呆、想事情、不出声哼歌，下一轮聊天会带一句“用户在专心做事”。不读你真实的键盘和鼠标。）'
        : kind === 'pause' ? '（测试：假装你忙了一阵刚停下来歇口气，约 5 分钟。下一轮聊天会带一句“刚停下来歇口气”。不读你真实的键盘和鼠标。）'
          : '（测试：不再假装，回到真实的状态。）');
    },
  });

  // I-006 第 3 步: pretend the shared screen shows a video / a game (nothing real is read, no sharing needed); "不再假装" ends it.
  const watchAlong = (id: string, name: string, aliases: string[], summary: string, kind: 'video' | 'game'): TestEntry => ({
    id, name, aliases, summary,
    run: () => {
      deps.watchAlong.pretend(kind);
      return say(kind === 'video' ? '（测试：假装你开着屏幕共享在看视频，约 10 分钟。她有机会转过去跟着看，眼睛朝她所在那块屏幕的中间看，晃得更轻，偶尔回头看你。不读真实的屏幕。“不再假装”结束。）'
        : '（测试：假装你开着屏幕共享在玩游戏，约 10 分钟。她有时跟着看、有时做自己的事，看她爱不爱玩。不读真实的屏幕。“不再假装”结束。）');
    },
  });

  // 她的动作 (T-211): one of Codex's actions, played now on every window's stage; the note is the pet window's own answer.
  const act = (id: string, action: HerActionId, aliases: string[], summary: string): TestEntry => ({
    id, name: `动作：${HER_ACTION_SPECS[action].name}`, aliases, summary,
    run: async () => {
      const spec = HER_ACTION_SPECS[action], name = say(spec.name);
      let result: HerActionPlayResult;
      try { result = await deps.action.play(action); } catch { result = { status: 'failed', missing: [], detail: '' }; }
      // T-213: the exact parts ("右手手指", "右手腕（有重名骨骼）": a clip cannot bind a bone whose name another bone shares).
      const parts = result.missing.map(part => { const shared = /^(.+)（有重名骨骼）$/u.exec(part); return shared ? say('{0}（有重名骨骼）', { 0: say(shared[1]) }) : say(part); })
        .join(say('、'));
      switch (result.status) {
        case 'played': return result.detail === HER_ACTION_DETAILS.approximate
          // Skeleton step 2: the model lacks the shape; the stage built it from its own near ones (the character page says which).
          ? say('（测试：她做了一次“{0}”（动的是{1}）。她的模型没有专门的表情，这次是用相近的表情拼的近似，角色页写了用的是哪些。看桌面上的她。）', { 0: name, 1: say(spec.parts) })
          : say('（测试：她做了一次“{0}”（动的是{1}）。看桌面上的她。）', { 0: name, 1: say(spec.parts) });
        case 'missing': return say('（测试：她的模型缺{0}，“{1}”这个动作跳过了，别的照常。）', { 0: parts, 1: name });
        case 'unfit': return result.detail === HER_ACTION_DETAILS.structure && result.missing.length
          ? say('（测试：她的模型里{0}没接在标准的位置上，做“{1}”会把它和身体扯开，所以跳过了；别的动作照常。）', { 0: parts, 1: name })
          : say('（测试：动作适配检查说“{0}”不适合她现在的模型，跳过了。）', { 0: name });
        case 'busy': return say('（测试：她现在不方便（{0}），这次没做“{1}”。）', { 0: say(result.detail || '正忙'), 1: name });
        case 'no-window': return say('（测试：现在没有桌宠窗口能显示。）');
        case 'no-answer': return say('（测试：已经让她做“{0}”，但桌宠窗口没有回音（可能还在载入模型）。）', { 0: name });
        default: return say('（测试：“{0}”没能播放（{1}）。）', { 0: name, 1: say(result.detail || '原因不明') });
      }
    },
  });

  const entries: TestEntry[] = [
    life('L2.rules', '去忙自己的事', ['去忙自己的事', '忙自己的事', '做自己的事', '去做自己的事', '自己的生活', '她自己的生活', '去忙吧', '让她忙起来'],
      '她按自己的心情和性格，立刻挑一件自己的事去做（发呆、哼歌、想事情之一）', null),
    life('L2.daydream', '发呆', ['发呆', '发个呆', '发发呆', '放空', '走神', '愣神'],
      '她立刻开始发呆（你一互动就收回）', 'daydream'),
    life('L2.humming', '哼歌', ['哼歌', '哼个歌', '哼小曲', '哼曲子', '哼着歌'],
      '她立刻开始哼歌（不出声，只有节奏和神情）', 'humming'),
    life('L2.thinking', '想事情', ['想事情', '想心事', '想点事', '思考', '沉思'],
      '她立刻开始想事情', 'thinking'),
    life('L2.drowsy', '犯困', ['犯困', '犯个困', '犯困了', '打瞌睡', '打个瞌睡', '打盹', '打个盹', '昏昏欲睡'],
      '她立刻开始犯困（只是犯困的样子，不会真的睡着）', 'drowsy'),
    life('L2.company', '陪着你', ['陪着你', '陪着我', '陪我', '回来陪我', '不忙了', '回到身边'],
      '她立刻回到“陪着你”，不再忙自己的事', 'company'),
    cue('L1.motion', '给她一次小动作的时机', ['小动作', '小动作时机', '做个小动作', '来个小动作', '让她动一动', '内心循环小动作'],
      '内心循环马上给她一次小动作的时机（照常调用模型、不绕过限制，只是不用等；她正忙时会等到她方便）', 'motion'),
    cue('L1.speech', '给她一次说话的时机', ['说话时机', '主动说话', '让她开口', '开口说话', '让她说话', '主动搭话', '搭话', '内心循环说话'],
      '内心循环马上给她一次说话的时机（照常调用模型、占用说话次数；她正忙时会等到她方便）', 'speech'),
    stage('F3.new', '熟悉度：初识', ['初识', '刚认识', '陌生', '新朋友', '设成初识'],
      '临时把熟悉度阶段设成“初识”（重启复原）', 'new'),
    stage('F3.warming', '熟悉度：熟起来', ['熟起来', '慢慢熟', '开始熟', '渐渐熟'],
      '临时把熟悉度阶段设成“熟起来”（重启复原）', 'warming'),
    stage('F3.familiar', '熟悉度：熟悉', ['熟悉', '已经熟悉', '熟了', '熟人'],
      '临时把熟悉度阶段设成“熟悉”（重启复原）', 'familiar'),
    stage('F3.close', '熟悉度：亲近', ['亲近', '亲密', '很亲', '关系近'],
      '临时把熟悉度阶段设成“亲近”（重启复原）', 'close'),
    stage('F3.old', '熟悉度：老朋友', ['老朋友', '老友', '老熟人', '多年好友'],
      '临时把熟悉度阶段设成“老朋友”（重启复原）', 'old'),
    stage('F3.reset', '熟悉度：恢复', ['熟悉度恢复', '恢复熟悉度', '取消临时阶段', '熟悉度还原', '恢复真实阶段', '取消熟悉度'],
      '取消临时阶段，回到真实的熟悉度', null),
    mood('F2.tired', '我很累', [...self('累', '疲惫', '疲倦'), '我累了', '累了', '好累', '很累', '用户累了'],
      '临时让她读到你现在很累（会随时间淡去）', 'tired'),
    mood('F2.annoyed', '我很烦', [...self('烦', '烦躁', '心烦'), '烦了', '我烦了'],
      '临时让她读到你现在很烦（会随时间淡去）', 'annoyed'),
    mood('F2.low', '我情绪低落', [...self('低落', '难过', '失落', '沮丧', '不开心'), '我心情不好', '心情不好'],
      '临时让她读到你现在情绪低落（会随时间淡去）', 'low'),
    mood('F2.happy', '我很开心', [...self('开心', '高兴', '快乐', '愉快'), '我心情好'],
      '临时让她读到你现在很开心（会随时间淡去）', 'happy'),
    mood('F2.excited', '我很兴奋', [...self('兴奋', '激动')],
      '临时让她读到你现在很兴奋（会随时间淡去）', 'excited'),
    mood('F2.clear', '清除读到的状态', ['清除状态', '清除情绪', '清除她读到的', '清掉她的判断', '忘掉我的情绪', '我平静', '我没事'],
      '清除她读到的你的状态', null),
    // Her own mood (U-012): the bare words ("开心", "难过", "困了") are about HER; "我…" and "用户…" above are about the user.
    herMood('MOOD.calm', '心情：平静', ['平静', '心情平静', '平静下来'], '把她的心情直接设成平静（回到基线）', 'calm'),
    herMood('MOOD.content', '心情：满足', ['满足', '心满意足', '惬意'], '把她的心情直接设成满足', 'content'),
    herMood('MOOD.close', '心情：亲近', ['心情亲近', '亲近的心情', '她很亲近', '变亲近'], '把她的心情直接设成亲近', 'close'),
    herMood('MOOD.happy', '心情：开心', ['开心', '高兴', '愉快', '快乐', '心情好', '变开心', '让她开心', '她很开心'], '把她的心情直接设成开心（愉快）', 'happy'),
    herMood('MOOD.excited', '心情：兴奋', ['兴奋', '激动', '变兴奋', '让她兴奋', '她很兴奋', '超兴奋'], '把她的心情直接设成兴奋', 'excited'),
    herMood('MOOD.concerned', '心情：担心', ['担心', '忧虑', '焦虑', '放心不下', '让她担心'], '把她的心情直接设成担心', 'concerned'),
    herMood('MOOD.disappointed', '心情：低落', ['低落', '失落', '沮丧', '让她低落', '她很低落'], '把她的心情直接设成低落（失落）', 'disappointed'),
    herMood('MOOD.upset', '心情：不满', ['不满', '生气', '不高兴', '闹脾气', '恼火', '让她生气', '她很生气'], '把她的心情直接设成不满', 'upset'),
    herMood('MOOD.longing', '心情：想念', ['想念', '思念', '想你', '让她想念', '她很想念'], '把她的心情直接设成想念', 'longing'),
    herMood('MOOD.sad', '心情：难过', ['难过', '伤感', '伤心', '悲伤', '让她难过', '她很难过'], '把她的心情直接设成难过（伤感）', 'sad'),
    herMood('MOOD.relieved', '心情：释然', ['释然', '松了口气', '如释重负'], '把她的心情直接设成释然', 'relieved'),
    herMood('MOOD.tense', '心情：紧张期待', ['紧张期待', '期待', '紧张', '忐忑', '又紧张又期待'], '把她的心情直接设成紧张期待', 'tense-expectation'),
    {
      id: 'MOOD.drowsy', name: '心情：困了', summary: '让她看起来明显困倦（只是样子，睡眠模型不动；15 分钟后自己恢复）',
      aliases: ['困了', '她困了', '很困', '好困', '困倦', '她很困'],
      run: () => say(deps.mood.fatigue('drowsy') ? '（测试：已让她看起来明显困倦（只是样子，不会真的睡着），15 分钟后自己恢复，或打“测试：恢复心情”。）' : NO_CHARACTER),
    },
    {
      id: 'MOOD.sleepy', name: '心情：有点困', summary: '让她看起来有点困（轻微困倦；15 分钟后自己恢复）',
      aliases: ['有点困', '有些困', '微困', '轻微困倦', '她有点困'],
      run: () => say(deps.mood.fatigue('light-drowsy') ? '（测试：已让她看起来有点困（轻微困倦），15 分钟后自己恢复，或打“测试：恢复心情”。）' : NO_CHARACTER),
    },
    {
      id: 'MOOD.asleep', name: '心情：睡着了', summary: '让她看起来睡着了：闭眼、睡姿、眼神不跟你（只是样子，睡眠模型不动；摸摸头或跟她说话就醒；15 分钟后自己恢复）',
      aliases: ['睡着了', '她睡着了', '让她睡着', '让她睡觉'],
      run: () => say(deps.mood.fatigue('asleep') ? '（测试：已让她看起来睡着了（只是样子），摸摸头或跟她说话会醒，15 分钟后自己恢复，或打“测试：恢复心情”。）' : NO_CHARACTER),
    },
    {
      id: 'MOOD.reset', name: '恢复心情', summary: '把她的心情放回基线，临时的困倦样子也取消',
      aliases: ['恢复心情', '心情恢复', '心情复原', '重置心情', '恢复基线', '心情回到基线', '恢复默认心情'],
      run: () => deps.mood.set(null) === null ? say(NO_CHARACTER) : say('（测试：心情已放回基线，临时的困倦样子也取消了。）'),
    },
    // L4 她也会需要你: the four small needs; the day's limits are not touched, so each can be tried again at once.
    need('L4.lonely', '小需要：有点闷', ['有点闷', '闷闷的', '她有点闷', '她需要你', '她也会需要你', '小需要', '想被摸摸头'],
      '她立刻有点闷，想要人陪（摸头、喂食、聊几句能哄好；不占当天的次数）', 'lonely'),
    need('L4.dream', '小需要：不开心的梦', ['做噩梦', '噩梦', '不开心的梦', '做了个梦', '梦见不开心的事'],
      '她立刻像是做了个不开心的梦，心里沉沉的（能哄好；不占当天的次数）', 'dream'),
    need('L4.lowEnergy', '小需要：没精神', ['没精神', '今天没精神', '有点没精神', '提不起劲', '没劲'],
      '她立刻有点没精神（能哄好；不占当天的次数）', 'lowEnergy'),
    need('L4.chatty', '小需要：想找人说话', ['想找人说话', '找人说话', '想聊天', '无聊得想聊天', '无聊想找人'],
      '她立刻无聊得想找人说话（能哄好；不占当天的次数）', 'chatty'),
    {
      id: 'M1.rejudge', name: '重新判一次想不想跳', summary: '让她立刻重新判一次想不想跳（要有音乐在放才看得出来）',
      aliases: ['想不想跳', '重新判', '重新判断', '重判', '判一次', '跳不跳', '要不要跳', '音乐律动', '律动', '让她重新判一次'],
      run: () => { deps.music.rejudge(); return say('（测试：已让她重新判一次想不想跳。要有音乐在放才看得出来，结果看开发者面板里的“想跳”一行。）'); },
    },
    // E1 惊喜 / 害羞: the same request as the 「预览」 buttons (角色页「心情和反应」, the developer mood panel); any model, missing parts skipped.
    {
      id: 'E1.surprise', name: '预览：惊喜', summary: '她马上做一次“惊喜”：眉毛一扬、眼睛睁大、小“o”嘴、头微微后仰，然后自然回落（任何模型，缺的部位跳过）',
      aliases: ['惊喜', '惊喜试作', '预览惊喜', '惊喜预览', '惊喜表情', '表情惊喜', '吃惊', '吃惊表情', '惊讶表情'],
      run: () => say(deps.expression.play('surprise') ? '（测试：已让她做一次“惊喜”。看桌面上的她；她的模型缺的部位会跳过。）' : '（测试：现在没有桌宠窗口能显示。）'),
    },
    {
      id: 'E1.shy', name: '预览：害羞', summary: '她马上害羞一次：垂眼看向一侧、低头侧转、脸红、抿嘴笑，然后回来（任何模型，缺的部位跳过）',
      aliases: ['害羞', '害羞试作', '预览害羞', '害羞预览', '害羞表情', '表情害羞', '不好意思', '脸红表情'],
      run: () => say(deps.expression.play('shy') ? '（测试：已让她害羞一次。看桌面上的她；她的模型缺的部位会跳过。）' : '（测试：现在没有桌宠窗口能显示。）'),
    },
    {
      id: 'G1.invite', name: '邀请猜拳', summary: '她马上递出猜拳邀请（出现两个按钮；不占用邀请次数）',
      aliases: ['邀请猜拳', '邀请玩猜拳', '猜拳邀请', '让她邀请我猜拳', '她邀请我', '发出邀请'],
      run: () => say(deps.rps.invite() ? '（测试：她递出了猜拳邀请，旁边出现了两个按钮。）'
        : '（测试：现在不行：桌宠没显示、没选中角色，或者正在玩。）'),
    },
    {
      id: 'G1.start', name: '直接开一局猜拳', summary: '直接开一局猜拳',
      aliases: ['开一局猜拳', '直接开一局', '来一局猜拳', '玩猜拳', '猜拳', '开始猜拳', '猜拳开局'],
      run: () => say(deps.rps.start() ? '（测试：已直接开了一局猜拳。）' : '（测试：现在不行：桌宠没显示、没选中角色，或者正在玩。）'),
    },
    {
      id: 'L3.diary', name: '立刻补写日记', summary: '让她现在补写前几天还没写的日记（要先打开“允许记录”，会用一次聊天模型的调用）',
      aliases: ['写日记', '补写日记', '日记', '立刻写日记', '现在写日记', '补日记', '写一篇日记', '补写一篇日记'],
      run: () => {
        switch (deps.diary.writeNow()) {
          case 'started': return say('（测试：已让她现在补写日记。只会补前几天里有聊天、还没写的日子；写好后在“用户画像”的日记里看。）');
          case 'recording-off': return say('（测试：先打开“允许记录”（在用户画像里），她才会写日记。这里不绕过它。）');
          case 'nothing-due': return say('（测试：没有需要补写的日子：前几天都写过了，或者没有聊天。）');
          case 'busy': return say('（测试：她正在写，等一下。）');
          default: return say('（测试：现在没法写日记：还没选中角色，或者聊天不是用 Claude。）');
        }
      },
    },
    // P1 第二阶段: as if the local camera sensing saw it (no camera is opened); the next ten minutes count as the user being here.
    pose('P1.yawn', '我打了个哈欠', ['我打了个哈欠', '我打哈欠', '我打了哈欠', '打哈欠', '打个哈欠', '哈欠'],
      '假装摄像头看到你打了个哈欠：她跟着打一个（测试时一定跟）', 'yawn'),
    pose('P1.stretch', '我伸了个懒腰', ['我伸了个懒腰', '我伸懒腰', '我伸了懒腰', '伸懒腰', '伸个懒腰'],
      '假装摄像头看到你伸了个懒腰：她跟着伸个小懒腰（测试时一定跟）', 'stretch'),
    pose('P1.wave', '我冲你挥手', ['我冲你挥手', '我挥手', '我冲她挥手', '挥手', '挥挥手', '我跟你招手'],
      '假装摄像头看到你冲她挥手：她举手挥一挥回应你（测试时一定回应）', 'wave'),
    pose('P1.sat', '我坐了很久', ['我坐了很久', '坐了很久', '坐很久', '我坐了好久', '久坐'],
      '假装摄像头看到你已经坐了约 50 分钟：她自己伸个小懒腰（她自己的需要，不提醒你）', 'sat'),
    pose('P1.arrive', '我回到电脑前', ['我回到电脑前', '回到电脑前', '我回来了', '我坐回来了'],
      '假装摄像头看到你离开一会儿又回来：她抬眼看你一下，无聊少一点（不算互动）', 'arrive'),
    // I-006 第 1 步 陪你做事: pretend (no real keyboard or mouse is read).
    userActivity('I006.busy', '假装我在忙', ['假装我在忙', '我在忙', '我很忙', '我在专心做事', '我正在专心做事', '我在埋头做事'],
      '假装你正在专心做事：她安静下来做自己的事，无聊涨得慢（不读真实的键盘鼠标）', 'busy'),
    userActivity('I006.pause', '假装我停下来', ['假装我停下来', '我停下来了', '我停下来歇一下', '我歇一下', '我歇口气', '我忙完了'],
      '假装你忙了一阵刚停下来歇口气（不读真实的键盘鼠标）', 'pause'),
    watchAlong('I006.video', '假装我在看视频', ['假装我在看视频', '我在看视频', '我在看剧', '我在追剧', '我在看电影'],
      '假装你开着屏幕共享在看视频：她转过去跟着看，偶尔回头看你（不读真实的屏幕）', 'video'),
    watchAlong('I006.game', '假装我在玩游戏', ['假装我在玩游戏', '我在玩游戏', '我在打游戏'],
      '假装你开着屏幕共享在玩游戏：她有时跟着看、有时做自己的事（不读真实的屏幕）', 'game'),
    userActivity('I006.clear', '不再假装', ['不再假装', '取消假装', '别假装了', '我不忙了'],
      '不再假装你的状态，回到真实的', null),
    // 她的动作 (T-211, Codex's prototypes): played as asked, on any model; a model without the parts skips it and says so.
    act('ACT.hello', 'hello-wave', ['打招呼', '打个招呼', '跟我打招呼', '她打招呼', '主动挥手', '挥手打招呼'],
      '她马上抬起右手，冲你挥两下打招呼，再放下（Codex 做的动作；模型缺部位就跳过）'),
    act('ACT.goodbye', 'goodbye-wave', ['说再见', '再见', '拜拜', '挥手再见', '挥手告别', '道别'],
      '她马上抬起右手，慢一点挥三下说再见，再放下'),
    act('ACT.nod', 'nod', ['点头', '点点头', '点个头'], '她马上点一下头（只动脖子和头）'),
    act('ACT.shake', 'shake', ['摇头', '摇摇头', '摇个头'], '她马上轻轻摇头（只动脖子和头）'),
    act('ACT.tilt', 'tilt', ['歪头', '歪歪头', '歪个头', '歪头卖萌'], '她马上歪一下头，停一会儿再回来'),
    act('ACT.lean', 'lean', ['凑近看', '凑近', '凑过来', '凑近一点', '探头看'], '她马上上身前倾凑近看一下，头抬着看你，再回去'),
    act('ACT.coverFace', 'cover-face', ['捂脸', '捂住脸', '双手捂脸', '捂脸害羞'], '她马上双手捂脸，停一会儿再放下'),
    act('ACT.hideLaugh', 'hide-laugh', ['遮嘴笑', '捂嘴笑', '遮着嘴笑', '偷笑'], '她马上用右手遮着嘴笑一下（笑的表情不在这个动作里）'),
    act('ACT.openArms', 'open-arms', ['张开手臂', '张开双臂', '张臂', '张开怀抱'], '她马上张开双臂，停一下再收回'),
    act('ACT.hug', 'air-hug', ['抱抱', '抱一下', '虚抱', '拥抱', '要抱抱'], '她马上张开双臂往前合拢，像隔着屏幕抱你一下'),
    act('ACT.clap', 'clap', ['鼓掌', '拍手', '鼓鼓掌', '拍拍手'], '她马上在胸前张开双手拍三下（手掌之间留一点缝，没有声音）'),
    act('ACT.cheer', 'cheer', ['欢呼', '举手欢呼', '欢呼一下', '双手举高'], '她马上双手举成 V 字欢呼，再放下'),
    act('ACT.bow', 'bow', ['鞠躬', '鞠个躬', '鞠一躬', '行礼'], '她马上鞠一躬（上身和头，脚不动）'),
    act('ACT.apology', 'apology-bow', ['道歉', '道歉鞠躬', '对不起', '浅鞠躬', '赔不是'], '她马上浅浅鞠一躬表示道歉'),
    act('ACT.heart', 'two-hand-heart', ['比心', '比个心', '双手比心', '比爱心', '爱心手势'], '她马上用双手在胸前比一个心（要有手指骨骼的模型才做）'),
    act('ACT.point', 'point', ['指一指', '指一下', '伸手指', '用手指'], '她马上抬起右手伸出食指指一下，再收回（方向是固定的，不看屏幕）'),
    act('ACT.akimbo', 'hands-on-hips', ['叉腰', '叉个腰', '双手叉腰', '两手叉腰'], '她马上双手叉腰，停一会儿再放下'),
    act('ACT.yawnCover', 'cover-yawn', ['哈欠捂嘴', '捂嘴打哈欠', '捂着嘴打哈欠', '她打哈欠'], '她马上打个哈欠，右手捂着嘴（嘴和眼睛是原来的哈欠；“暂停自动表现”开着时只有手）'),
    act('ACT.eat', 'eat-mime', ['拿着吃', '假装吃东西', '吃东西的动作', '拿东西吃'], '她马上右手像捏着一小块东西送到嘴边再放下（只有手；不喂食、不算奖励、不张嘴）'),
    // T-215: Codex's face shapes (morph only), through the stage's short exclusive on the mouth or the eyelids.
    act('ACT.cheekPuff', 'cheek-puff', ['鼓腮', '鼓个腮', '鼓起腮帮子', '鼓脸颊', '鼓起脸颊'], '她马上轻轻鼓一下腮帮子再放松（只有脸；她在说话、被喂、被摸时不做，说话一开始就收回）'),
    act('ACT.pout', 'pout', ['撅嘴', '撅个嘴', '噘嘴', '嘟嘴', '嘟个嘴'], '她马上撅一下嘴再放松（只有嘴；她在说话时不做，说话一开始就收回）'),
    act('ACT.wink', 'wink', ['眨一只眼', '眨只眼', '眨一下眼', '单眼眨', '眨单眼', '抛个媚眼'], '她马上眨一只眼（画面右边那只；另一只照常睁着，眼珠照常看你；她正闭着眼时不做）'),
    act('ACT.tongue', 'tongue-out', ['吐舌头', '吐舌', '吐个舌头', '吐吐舌头'], '她马上张嘴吐一下舌头再收回（只有嘴；她在说话时不做，说话一开始就收回）'),
  ];
  return { entries, dispose: stopWaiting };
}

