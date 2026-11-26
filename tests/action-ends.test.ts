// The one interruption arbiter of full-screen Unbound:
// the rules (shared/unbound/action-ends), the page's press (src/unbound/pull-input.ts: a tug while she acts, the pull once it is large),
// what a large pull ends on the page (src/unbound/action-now.ts), the words she is told and the journal's closed lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import {
  ACTION_END_KNOBS, ACTION_KINDS, END_CAUSES, USER_END_CAUSES, actionEndKnobs, endsAction, interruptedLine, isUserEndCause, pressSize, tugPoint,
} from '../shared/unbound/action-ends';
import { INSTRUCTION_WORDS } from '../shared/unbound/life/history';
import { CHAT_CLOSE_BLOCKS } from '../shared/unbound/close-moments';
import { CLOSE_BEAT_SKIP_BLOCKS, INTERRUPTED_ACTIONS, INTERRUPTED_BY } from '../shared/stage/journal-entries';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { UnboundPull, type StagePullHit, type UnboundPullFigure } from '../src/unbound/pull-input';
import { actionNow, endForPull, type ActionOwners } from '../src/unbound/action-now';
import { UNITS_PER_M } from '../src/unbound/figure';
import { clampFollowDepth, type UnboundPullMessage } from '../shared/unbound/pull';
import { STICK_KNOBS } from '../shared/unbound/pull-stick';

test('rules: the mouse moving, the wheel, a small press, typing and the keys never end any action; a click never ends the close family', () => {
  for (const kind of ACTION_KINDS) for (const cause of ['pointer', 'wheel', 'tug', 'typing', 'keys'] as const) assert.equal(endsAction(kind, cause), false, `${kind} ${cause}`);
  for (const kind of ['kiss', 'hug', 'look'] as const) {
    assert.equal(endsAction(kind, 'click'), false, `${kind}: a click on her body does not end it`);
    assert.equal(endsAction(kind, 'pull'), true, `${kind}: a large pull does`);
    for (const cause of ['call', 'waiting', 'reply', 'reading']) assert.equal(endsAction(kind, cause), false, `${kind} ${cause}`);
  }
  assert.equal(endsAction('life', 'click'), true, 'her other actions keep today\'s attention: a click, she pauses and turns to you');
  assert.equal(endsAction('walk', 'click'), true);
  for (const kind of ACTION_KINDS) assert.equal(endsAction(kind, 'pull'), true, `${kind}: a large pull ends everything`);
  assert.equal(endsAction('life', null), false); assert.equal(endsAction('life', 'nonsense'), false);
  assert.deepEqual([...USER_END_CAUSES], ['pull', 'click']);
  assert.ok(END_CAUSES.includes('pointer') && isUserEndCause('pull') && !isUserEndCause('pointer'));
});

test('a press is classified once: small (a tug) below the knob from the press point, large at it; a tug the body follows is held inside the radius', () => {
  const k = ACTION_END_KNOBS.largePullPx;
  assert.ok(k > STICK_KNOBS.deadZonePx * 3 && k < STICK_KNOBS.fullOffsetPx, `between the dead zone (${STICK_KNOBS.deadZonePx}) and the stick's full speed (${STICK_KNOBS.fullOffsetPx})`);
  assert.equal(pressSize(0, 0), 'tug'); assert.equal(pressSize(k - 0.5, 0), 'tug'); assert.equal(pressSize(0, -k), 'pull');
  assert.equal(pressSize(k * 0.8, k * 0.8), 'pull', 'by distance, any direction'); assert.equal(pressSize(NaN, 3), 'tug');
  const anchor = { x: 100, y: 100 }, held = tugPoint(anchor, { x: 100 + 5 * k, y: 100 });
  assert.ok(Math.hypot(held.x - 100, held.y - 100) < k && held.x > 100, 'bounded, toward the pointer');
  assert.deepEqual(tugPoint(anchor, { x: 110, y: 90 }), { x: 110, y: 90 }, 'inside: as it is');
  assert.equal(actionEndKnobs({ largePullPx: 1e6 }).largePullPx, k, 'out of range: the default');
  assert.equal(actionEndKnobs({ largePullPx: 90 }).largePullPx, 90);
});

test('the words she is told: which action, by what; closed, information only (no instruction word, no number)', () => {
  const line = interruptedLine([{ action: 'hug', by: 'pull', at: 0 }]);
  assert.equal(line, '你刚才正凑过去抱用户，用户用力把你拉开了，没做完。');
  assert.equal(interruptedLine([]), '');
  for (const action of ACTION_KINDS) for (const by of USER_END_CAUSES) {
    const words = interruptedLine([{ action, by, at: 0 }]);
    assert.ok(words && !/[0-9]/.test(words) && !INSTRUCTION_WORDS.some(w => words.includes(w)), words);
  }
});

test('the journal: one closed row per missed kiss / hug and per action you ended; its lists are the parts\' own lists', () => {
  assert.deepEqual([...CLOSE_BEAT_SKIP_BLOCKS], [...CHAT_CLOSE_BLOCKS]);
  assert.deepEqual([...INTERRUPTED_ACTIONS], [...ACTION_KINDS]);
  assert.deepEqual([...INTERRUPTED_BY], [...USER_END_CAUSES]);
  const missed = buildJournalEntry({ type: 'close-beat-skipped', characterId: 'c1', kind: 'hug', block: 'typing' }, 1_000);
  assert.ok(missed && (missed as { block?: string }).block === 'typing', JSON.stringify(missed));
  assert.match(describeJournalEntry(missed!, (s: string, ...a: unknown[]) => a.reduce<string>((t, v, i) => t.replace(`{${i}}`, String(v)), s)), /抱抱没有走过来做：你正在打字/);
  assert.equal(buildJournalEntry({ type: 'close-beat-skipped', characterId: 'c1', kind: 'dance', block: 'typing' }, 1_000), null);
  assert.equal(buildJournalEntry({ type: 'close-beat-skipped', characterId: 'c1', kind: 'hug', block: 'my words' }, 1_000), null, 'never free text');
  const ended = buildJournalEntry({ type: 'action-interrupted', characterId: null, action: 'kiss', by: 'pull' }, 1_000);
  assert.ok(ended && (ended as { action?: string }).action === 'kiss');
  assert.equal(buildJournalEntry({ type: 'action-interrupted', characterId: null, action: 'kiss', by: 'pointer' }, 1_000), null, 'the mouse is never a cause');
});

// ---- the page: what a press meets, and what a large pull ends ------------------------------------------------------------------------

function owners(state: Partial<{ director: boolean; phase: string | null; speech: boolean; acts: boolean; beats: boolean; life: boolean; walking: boolean }> = {}) {
  const log: string[] = [];
  const o: ActionOwners = {
    director: { active: state.director ?? false, phase: state.phase ?? 'hold', yieldTo: reason => log.push(`director:${reason}`) },
    speech: { active: state.speech ?? false, interrupt: reason => log.push(`speech:${reason}`) },
    acts: { active: state.acts ?? false, cancel: () => log.push('acts') },
    beats: { active: state.beats ?? false }, life: { active: state.life ?? false, walking: state.walking ?? false },
  };
  return { o, log };
}

test('page: what a press meets (the close family first); a large pull ends it through its owner; nothing for nothing', () => {
  assert.equal(actionNow(owners().o), null);
  assert.equal(actionNow(owners({ director: true, beats: true }).o), 'look');
  assert.equal(actionNow(owners({ speech: true }).o), 'opening');
  assert.equal(actionNow(owners({ beats: true, life: true }).o), 'beat');
  assert.equal(actionNow(owners({ life: true, walking: true }).o), 'walk');
  assert.equal(actionNow(owners({ life: true }).o), 'life');
  const close = owners({ director: true }); assert.equal(endForPull('hug', close.o), true); assert.deepEqual(close.log, ['director:pull']);
  const opening = owners({ speech: true }); endForPull('opening', opening.o); assert.deepEqual(opening.log, ['speech:pull']);
  const act = owners({ acts: true }); endForPull('act', act.o); assert.deepEqual(act.log, ['acts']);
  const life = owners({ life: true }); assert.equal(endForPull('life', life.o), true); assert.deepEqual(life.log, [], 'her own life gives way through the host (the pull it is told about)');
});

function pullRig(during: () => 'hug' | 'life' | null, group: StagePullHit['group'] = 'torso') {
  const calls: string[] = [], messages: UnboundPullMessage[] = [], ended: string[] = [];
  let clock = 0;
  const figure: UnboundPullFigure = {
    pullHit: () => ({ part: group === 'arm' ? 'hand' : 'torso', side: group === 'arm' ? 'left' : null, group, heightPx: 400 } as StagePullHit),
    pullStart: () => { calls.push('start'); return true; }, pullTo: (_v, x, y) => { calls.push(`to ${Math.round(x)},${Math.round(y)}`); }, pullEnd: () => { calls.push('end'); },
    setPullStance: () => {}, pullShownM: () => ({ x: 0, z: 0 }), rootM: { x: 0, z: -2 }, followTo: () => { calls.push('walk'); }, setStance: () => {}, heightM: 1.5,
    get report() { return { steps: 0 }; },
  };
  const cam = new PerspectiveCamera(30, 1.6, 0.05 * UNITS_PER_M, 100 * UNITS_PER_M); cam.position.set(0, 1.25 * UNITS_PER_M, 0.55 * UNITS_PER_M); cam.updateMatrixWorld(true);
  const pulls = new UnboundPull({
    figure: () => figure, view: () => ({ camera: cam, width: 1600, height: 1000 }), eligible: () => true,
    send: async m => { messages.push(m); return m.phase === 'start' ? { accepted: true, stance: { willing: 1, compliance: 1, pace: 1, hesitateMs: 0, resist: 0 }, sleepy: 0 } : undefined; },
    clampX: x => x, clampDepth: d => clampFollowDepth(d, null), clock: () => clock,
    action: during, endAction: kind => { ended.push(kind); },
  });
  return { pulls, calls, messages, ended, tick: (ms = 16) => { clock += ms; pulls.frame(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('page: a small press or pull on her while she acts is a tug (her body gives, bounded; nothing ends; nothing sent); let go, she eases back', async () => {
  for (const group of ['torso', 'arm'] as const) {
    const r = pullRig(() => 'hug', group);
    assert.ok(r.pulls.down(800, 300));
    for (const [x, y] of [[806, 300], [820, 310], [840, 330], [800 + 40, 300 + 30]]) { r.pulls.move(x, y); r.tick(); }
    await flush();
    assert.equal(r.pulls.tugging, true, `${group}: a tug`);
    assert.equal(r.pulls.pulling, false, `${group}: not a pull`);
    assert.deepEqual(r.ended, [], `${group}: the hug goes on`);
    assert.deepEqual(r.messages, [], `${group}: nothing sent to the host (not a pull, not a touch)`);
    assert.ok(r.calls.includes('start') && r.calls.some(c => c.startsWith('to ')), `${group}: the body layer follows (the physics of a pull, bounded): ${r.calls.join(' | ')}`);
    assert.ok(!r.calls.includes('walk'), `${group}: she is not walked`);
    for (const c of r.calls.filter(c => c.startsWith('to '))) { const [x, y] = c.slice(3).split(',').map(Number); assert.ok(Math.hypot(x - 800, y - 300) < ACTION_END_KNOBS.largePullPx, c); }
    r.pulls.up(); await flush();
    assert.equal(r.calls.at(-1), 'end', `${group}: let go, the body eases back`);
    assert.equal(r.pulls.active, false);
    assert.deepEqual(r.messages, []);
  }
});

test('page: a large pull while she acts ends the action once and becomes the pull exactly as when she is free (the host is asked)', async () => {
  for (const group of ['torso', 'arm'] as const) {
    const r = pullRig(() => 'hug', group);
    assert.ok(r.pulls.down(800, 300));
    r.pulls.move(820, 300); r.tick();
    r.pulls.move(800 + ACTION_END_KNOBS.largePullPx + 5, 300); r.tick(); await flush(); r.tick(); await flush();
    assert.deepEqual(r.ended, ['hug'], `${group}: ended once`);
    assert.equal(r.pulls.tugging, false);
    assert.equal(r.messages[0]?.phase, 'start', `${group}: the pull asks the host as always`);
    r.pulls.move(800 + ACTION_END_KNOBS.largePullPx + 40, 300); r.tick(); await flush();
    assert.deepEqual(r.ended, ['hug'], `${group}: never twice`);
    r.pulls.up(); await flush();
  }
  const free = pullRig(() => null);
  assert.ok(free.pulls.down(800, 300)); free.pulls.move(830, 300); free.tick(); await flush();
  assert.equal(free.pulls.tugging, false, 'she is free: past the dead zone it is the pull at once, as before');
  assert.equal(free.messages[0]?.phase, 'start');
});

test('page: the wheel over her while she acts neither ends it nor walks her; free, it is the pull in steps as before', async () => {
  const r = pullRig(() => 'look' as never);
  r.pulls.wheel(800, 300, -100); r.tick(); await flush();
  assert.deepEqual(r.messages, []); assert.deepEqual(r.ended, []);
  const free = pullRig(() => null);
  free.pulls.wheel(800, 300, -100); free.tick(); await flush();
  assert.equal(free.messages[0]?.phase, 'start');
});

// 2026-11-23's hug "a little to one side" (hugSide) was replaced by I-203's hug end frame (the user's picture: her head on the screen's
// right, her face turned outward): tests/i203-close-frames.test.ts.
