import path from 'node:path';
import type { TestCommandNote, TestEffect } from '../../shared/test-command';
import type { ExpressionRecipe } from '../../shared/expression-preview';
import type { HerActionId, HerActionPlayResult } from '../../shared/her-actions';
import type { CompanionService } from '../companion';
import type { DiaryWriter } from '../diary/diary-writer';
import type { InnerLoop } from '../inner-loop/inner-loop';
import type { RpsHost } from '../rps/host';
import { cueBlocker, type CueGateState } from './cue-gate';
import type { InnerLoopAvailability, TestCommandDeps } from './entries';
import { TestCommandHost } from './host';

/** What electron/main.ts hands over: each reader is called only at the moment it is needed (nothing is captured early). */
export interface TestCommandPorts {
  companion(): CompanionService | undefined;
  innerLoop(): InnerLoop;
  rps(): RpsHost;
  diary(): DiaryWriter | undefined;
  /** I-006 第 1 步: electron/user-activity.ts (undefined before the app is ready). */
  userActivity?(): { pretend(kind: 'busy' | 'pause' | null): boolean } | undefined;
  /** I-006 第 3 步: electron/watch-along.ts. */
  watchAlong?(): { pretend(kind: 'video' | 'game' | null): void } | undefined;
  /** App setting `innerLoop` (default on). */
  innerLoopOn(): boolean;
  /** The conditions the automatic expression gate uses (see cue-gate.ts). */
  gate(): CueGateState;
  /** Sends a note line to the window that asked. */
  note(owner: number, note: TestCommandNote): void;
  /** Asks the windows to do one stage thing (a closed set). */
  effect(effect: TestEffect): void;
  /** E1: the same relay as the 「预览」 buttons (electron/expression-preview-host.ts); false when no pet window can show it. */
  expression(recipe: ExpressionRecipe): boolean;
  /** 她的动作 (T-211): electron/her-action-host.ts play(); the pet window's answer. */
  action(id: HerActionId): Promise<HerActionPlayResult>;
  /** The profile folder, or null before it exists. */
  directory(): string | null;
}

/**
 * Connects the registry to the features' existing interfaces (docs/claude/2026-11-03-test-commands.md). Everything an entry
 * can do is listed in `TestCommandDeps`; this file is the only place that knows which main-process objects answer each one.
 */
export function createTestCommands(ports: TestCommandPorts): TestCommandHost {
  const companion = () => ports.companion();
  // Before any character is active there is no mood yet and reading it throws: that is "no character".
  const moodView = () => { try { return companion()?.mood.get() ?? null; } catch { return null; } };
  const characterId = () => moodView()?.characterId || null;
  const deps: TestCommandDeps = {
    herLife: { start: activity => companion()?.herLifeStartNow(activity) ?? { ok: false, reason: 'no-character' } },
    innerLoop: {
      available: (): InnerLoopAvailability => {
        const mood = moodView();
        if (!mood?.characterId) return 'no-character';
        if (!ports.innerLoopOn()) return 'setting-off';
        return mood.expressions ? 'ok' : 'expressions-off';
      },
      blocker: () => cueBlocker(ports.gate()),
      force: kind => {
        ports.innerLoop().resetPacing();
        return companion()?.mood.forceAttention(kind) === true;
      },
    },
    relationship: {
      slowWarmUp: () => { const id = characterId(); return !!id && companion()?.relationship.view(id)?.slowWarmUp === true; },
      setStage: stage => { companion()!.relationship.setStageOverride(stage); },
    },
    userState: {
      set: state => {
        const id = characterId(), service = companion();
        if (!id || !service) return false;
        if (state === null) { service.userState.clear(id); return true; }
        service.userState.note(id, { state, confidence: 0.9, reason: '' });
        return true;
      },
    },
    needs: {
      start: id => {
        const view = moodView();
        if (!view?.characterId) return 'no-character';
        if (!view.expressions) return 'expressions-off';
        return companion()!.herNeeds.startNow(view.characterId, id) ? 'ok' : 'expressions-off';
      },
    },
    music: { rejudge: () => ports.effect('music-rejudge') },
    expression: { play: recipe => ports.expression(recipe) },
    mood: {
      set: label => companion()?.mood.setTestMood(label) ?? null,
      fatigue: phase => companion()?.mood.setTestFatigue(phase) === true,
    },
    rps: { invite: () => ports.rps().testInvite(), start: () => ports.rps().testStart() },
    diary: { writeNow: () => ports.diary()?.writeNow() ?? 'unavailable' },
    pose: { simulate: kind => companion()?.poseSimulate(kind) ?? 'no-character' },
    action: { play: id => ports.action(id) },
    userActivity: { pretend: kind => ports.userActivity?.()?.pretend(kind) === true ? 'ok' : 'switch-off' },
    watchAlong: { pretend: kind => { ports.watchAlong?.()?.pretend(kind); } },
  };
  return new TestCommandHost({
    developerMode: () => companion()?.mood.isDeveloperMode() === true,
    deps,
    note: ports.note,
    diagnosticsFile: () => { const directory = ports.directory(); return directory ? path.join(directory, 'dev', 'test-commands.jsonl') : null; },
  });
}
