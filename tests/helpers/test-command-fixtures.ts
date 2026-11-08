import type { DiaryWriteNow, HerLifeStart, InnerLoopAvailability, TestCommandDeps } from '../../electron/test-commands/entries';
import type { HerLifeActivity } from '../../shared/her-life';
import type { MoodLabel } from '../../shared/mood';
import type { HerNeedId } from '../../shared/her-needs';
import type { TestFatiguePhase } from '../../shared/mood-presets';
import type { RelationshipStage } from '../../shared/relationship';
import type { ActiveUserState } from '../../shared/user-state';
import type { ExpressionRecipe } from '../../shared/expression-preview';
import type { HerActionId, HerActionPlayResult } from '../../shared/her-actions';

/** A fake clock and timer set for the one entry that waits (L1): `advance` runs due callbacks in order. */
export function fakeTimers() {
  let now = 0, next = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    clock: () => now,
    timers: {
      set: (callback: () => void, ms: number) => { const id = next++; pending.set(id, { at: now + ms, callback }); return id; },
      clear: (handle: unknown) => { pending.delete(handle as number); },
    },
    get pending() { return pending.size; },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]); now = due[1].at; due[1].callback();
      }
      now = end;
    },
  };
}

/** Fake feature interfaces: every call is recorded as "name:argument", every answer is settable. */
export function fakeTestDeps(over: Partial<TestCommandDeps> = {}) {
  const calls: string[] = [];
  const time = fakeTimers();
  const state = {
    life: { ok: true } as { ok: true } | { ok: false; reason: 'no-character' | 'expressions-off' },
    picked: 'daydream' as HerLifeActivity,
    availability: 'ok' as InnerLoopAvailability,
    blocker: null as string | null,
    forced: true,
    slowWarmUp: true,
    stageThrows: false,
    userStateSet: true,
    need: 'ok' as 'ok' | 'no-character' | 'expressions-off',
    moodNoCharacter: false,
    /** What the host says is shown after set(label); undefined = the requested label. */
    moodShown: undefined as MoodLabel | undefined,
    rpsInvite: true,
    rpsStart: true,
    diary: 'started' as DiaryWriteNow,
    /** E1: whether a pet window was there to show the preview. */
    expressionShown: true as boolean | undefined,
    /** P1 第二阶段: what the pose host answers. */
    pose: 'ok' as 'ok' | 'no-character' | 'expressions-off',
    /** I-006: what the user-activity host answers (the switch off = 'switch-off'). */
    userActivity: 'ok' as 'ok' | 'switch-off',
    /** 她的动作: what the pet window answers. */
    action: { status: 'played', missing: [], detail: '' } as HerActionPlayResult,
  };
  const deps: TestCommandDeps = {
    herLife: { start: (activity: HerLifeActivity | null): HerLifeStart => {
      calls.push(`herLife.start:${activity}`);
      return state.life.ok ? { ok: true, activity: activity ?? state.picked } : state.life;
    } },
    innerLoop: {
      available: () => state.availability,
      blocker: () => { calls.push('innerLoop.blocker'); return state.blocker; },
      force: kind => { calls.push(`innerLoop.force:${kind}`); return state.forced; },
    },
    relationship: {
      slowWarmUp: () => state.slowWarmUp,
      setStage: (stage: RelationshipStage | null) => { calls.push(`relationship.setStage:${stage}`); if (state.stageThrows) throw new Error('off'); },
    },
    userState: { set: (value: ActiveUserState | null) => { calls.push(`userState.set:${value}`); return state.userStateSet; } },
    needs: { start: (id: HerNeedId) => { calls.push(`needs.start:${id}`); return state.need; } },
    music: { rejudge: () => { calls.push('music.rejudge'); } },
    expression: { play: (recipe: ExpressionRecipe) => { calls.push(`expression.play:${recipe}`); return state.expressionShown ?? true; } },
    mood: {
      set: (label: MoodLabel | null) => { calls.push(`mood.set:${label}`); return state.moodNoCharacter ? null : (state.moodShown ?? label ?? 'calm'); },
      fatigue: (phase: TestFatiguePhase | null) => { calls.push(`mood.fatigue:${phase}`); return !state.moodNoCharacter; },
    },
    rps: { invite: () => { calls.push('rps.invite'); return state.rpsInvite; }, start: () => { calls.push('rps.start'); return state.rpsStart; } },
    diary: { writeNow: () => { calls.push('diary.writeNow'); return state.diary; } },
    pose: { simulate: kind => { calls.push(`pose.simulate:${kind}`); return state.pose; } },
    action: { play: async (id: HerActionId) => { calls.push(`action.play:${id}`); return state.action; } },
    userActivity: { pretend: kind => { calls.push(`userActivity.pretend:${kind}`); return state.userActivity; } },
    watchAlong: { pretend: kind => { calls.push(`watchAlong.pretend:${kind}`); } },
    clock: time.clock,
    timers: time.timers,
    ...over,
  };
  return { deps, calls, state, time };
}
