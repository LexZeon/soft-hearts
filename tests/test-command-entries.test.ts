/**
 * D2 / I-008: every entry calls the existing interface of its feature (and only that), says what happened in one
 * "（测试：…）" line, refuses honestly, and has English copy. The features' own interfaces are tested in
 * test-command-features.test.ts; here they are fakes that record the calls.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestEntries, TEST_WAIT_MS } from '../electron/test-commands/entries';
import { testHelpLines } from '../electron/test-commands/match';
import { CUE_BLOCKERS } from '../electron/test-commands/cue-gate';
import { setUiLanguage } from '../shared/ui-language';
import { USER_STATE_FADE_MS } from '../shared/user-state';
import { fakeTestDeps } from './helpers/test-command-fixtures';
import { HER_ACTIONS, HER_ACTION_DETAILS, HER_ACTION_FINGER_PARTS, HER_ACTION_PART_NAMES, HER_ACTION_SPECS, type HerActionPlayResult } from '../shared/her-actions';

const HAN = /[㐀-鿿]/u;
function setup(over?: Parameters<typeof fakeTestDeps>[0]) {
  const fake = fakeTestDeps(over);
  const built = buildTestEntries(fake.deps);
  const later: string[] = [];
  const run = async (id: string) => {
    const entry = built.entries.find(item => item.id === id);
    assert.ok(entry, id);
    return entry.run({ note: text => later.push(text) });
  };
  return { ...fake, built, later, run };
}

test('each entry calls its own feature\'s existing interface with the right argument, and nothing else', async () => {
  const expected: [string, string[]][] = [
    ['L2.rules', ['herLife.start:null']], ['L2.daydream', ['herLife.start:daydream']], ['L2.humming', ['herLife.start:humming']],
    ['L2.thinking', ['herLife.start:thinking']], ['L2.drowsy', ['herLife.start:drowsy']], ['L2.company', ['herLife.start:company']],
    ['L1.motion', ['innerLoop.blocker', 'innerLoop.force:motion']], ['L1.speech', ['innerLoop.blocker', 'innerLoop.force:speech']],
    ['F3.new', ['relationship.setStage:new']], ['F3.warming', ['relationship.setStage:warming']], ['F3.familiar', ['relationship.setStage:familiar']],
    ['F3.close', ['relationship.setStage:close']], ['F3.old', ['relationship.setStage:old']], ['F3.reset', ['relationship.setStage:null']],
    ['F2.tired', ['userState.set:tired']], ['F2.annoyed', ['userState.set:annoyed']], ['F2.low', ['userState.set:low']],
    ['F2.happy', ['userState.set:happy']], ['F2.excited', ['userState.set:excited']], ['F2.clear', ['userState.set:null']],
    ['MOOD.calm', ['mood.set:calm']], ['MOOD.content', ['mood.set:content']], ['MOOD.close', ['mood.set:close']], ['MOOD.happy', ['mood.set:happy']],
    ['MOOD.excited', ['mood.set:excited']], ['MOOD.concerned', ['mood.set:concerned']], ['MOOD.disappointed', ['mood.set:disappointed']],
    ['MOOD.upset', ['mood.set:upset']], ['MOOD.longing', ['mood.set:longing']], ['MOOD.sad', ['mood.set:sad']], ['MOOD.relieved', ['mood.set:relieved']],
    ['MOOD.tense', ['mood.set:tense-expectation']], ['MOOD.drowsy', ['mood.fatigue:drowsy']], ['MOOD.sleepy', ['mood.fatigue:light-drowsy']], ['MOOD.asleep', ['mood.fatigue:asleep']],
    ['MOOD.reset', ['mood.set:null']],
    ['L4.lonely', ['needs.start:lonely']], ['L4.dream', ['needs.start:dream']], ['L4.lowEnergy', ['needs.start:lowEnergy']], ['L4.chatty', ['needs.start:chatty']],
    ['M1.rejudge', ['music.rejudge']], ['E1.surprise', ['expression.play:surprise']], ['E1.shy', ['expression.play:shy']],
    ['G1.invite', ['rps.invite']], ['G1.start', ['rps.start']], ['L3.diary', ['diary.writeNow']],
    ['P1.yawn', ['pose.simulate:yawn']], ['P1.stretch', ['pose.simulate:stretch']], ['P1.wave', ['pose.simulate:wave']],
    ['P1.sat', ['pose.simulate:sat']], ['P1.arrive', ['pose.simulate:arrive']],
    ['I006.busy', ['userActivity.pretend:busy']], ['I006.pause', ['userActivity.pretend:pause']],
    ['I006.video', ['watchAlong.pretend:video']], ['I006.game', ['watchAlong.pretend:game']], ['I006.clear', ['watchAlong.pretend:null', 'userActivity.pretend:null']],
    ['ACT.hello', ['action.play:hello-wave']], ['ACT.goodbye', ['action.play:goodbye-wave']], ['ACT.nod', ['action.play:nod']], ['ACT.shake', ['action.play:shake']],
    ['ACT.tilt', ['action.play:tilt']], ['ACT.lean', ['action.play:lean']], ['ACT.coverFace', ['action.play:cover-face']], ['ACT.hideLaugh', ['action.play:hide-laugh']],
    ['ACT.openArms', ['action.play:open-arms']], ['ACT.hug', ['action.play:air-hug']], ['ACT.clap', ['action.play:clap']], ['ACT.cheer', ['action.play:cheer']],
    ['ACT.bow', ['action.play:bow']], ['ACT.apology', ['action.play:apology-bow']], ['ACT.heart', ['action.play:two-hand-heart']],
    ['ACT.point', ['action.play:point']], ['ACT.akimbo', ['action.play:hands-on-hips']], ['ACT.yawnCover', ['action.play:cover-yawn']], ['ACT.eat', ['action.play:eat-mime']],
    ['ACT.cheekPuff', ['action.play:cheek-puff']], ['ACT.pout', ['action.play:pout']], ['ACT.wink', ['action.play:wink']], ['ACT.tongue', ['action.play:tongue-out']],
  ];
  const probe = setup();
  assert.deepEqual(probe.built.entries.map(entry => entry.id), expected.map(([id]) => id));
  for (const [id, calls] of expected) {
    const one = setup();
    const note = await one.run(id);
    assert.deepEqual(one.calls, calls, id);
    assert.match(note, /^（测试：.+）/u, `${id}: one test-note line`);
    assert.equal(one.time.pending, 0, `${id}: nothing left waiting`);
  }
});

test('L2: she starts the state she was asked to, or picks by her own rules; the notes name it; refusals say why', async () => {
  const picked = setup();
  picked.state.picked = 'humming';
  assert.match(await picked.run('L2.rules'), /挑了“哼歌”/u);
  assert.match(await setup().run('L2.daydream'), /已让她开始发呆/u);
  assert.match(await setup().run('L2.company'), /陪着你/u);
  const noCharacter = setup();
  noCharacter.state.life = { ok: false, reason: 'no-character' };
  assert.match(await noCharacter.run('L2.daydream'), /还没有选中角色/u);
  const paused = setup();
  paused.state.life = { ok: false, reason: 'expressions-off' };
  assert.match(await paused.run('L2.daydream'), /暂停自动表现/u);
});

test('F3: the stage is set (until restart); a card that does not warm up slowly is told so; a refusal is reported', async () => {
  const slow = setup();
  assert.match(await slow.run('F3.familiar'), /^（测试：已把熟悉度临时设成“熟悉”，重启后复原。）$/u);
  const plain = setup();
  plain.state.slowWarmUp = false;
  assert.match(await plain.run('F3.close'), /亲近.*没开“慢慢熟起来”/u);
  assert.match(await setup().run('F3.reset'), /取消临时阶段/u);
  const refused = setup();
  refused.state.stageThrows = true;
  assert.match(await refused.run('F3.new'), /没能设置熟悉度阶段/u);
});

test('F2: each state is set with its own fade time; clearing says so; no character is reported', async () => {
  const minutes: Record<string, number> = { tired: 90, annoyed: 45, low: 180, happy: 30, excited: 30 };
  for (const [state, expectedMinutes] of Object.entries(minutes)) {
    assert.equal(USER_STATE_FADE_MS[state as keyof typeof USER_STATE_FADE_MS] / 60_000, expectedMinutes);
    const note = await setup().run(`F2.${state}`);
    assert.ok(note.includes(`约 ${expectedMinutes} 分钟`), `${state}: ${note}`);
  }
  assert.match(await setup().run('F2.clear'), /已清除/u);
  const none = setup();
  none.state.userStateSet = false;
  assert.match(await none.run('F2.tired'), /还没有选中角色/u);
});

test('MOOD: each mood entry sets her mood by label and says which one; a card that shows another label is told; no character; restore; drowsy look', async () => {
  const happy = setup();
  assert.match(await happy.run('MOOD.happy'), /^（测试：已把她的心情设成“愉快”，之后按各通道自己的速度慢慢回到基线/u);
  assert.match(await setup().run('MOOD.disappointed'), /“失落”/u);
  assert.match(await setup().run('MOOD.sad'), /“伤感”/u);
  assert.match(await setup().run('MOOD.tense'), /“紧张期待”/u);
  const other = setup();
  other.state.moodShown = 'calm';
  assert.match(await other.run('MOOD.excited'), /想把她的心情设成“兴奋”，但这张角色卡的反应设置让现在显示的是“平静”/u);
  const none = setup();
  none.state.moodNoCharacter = true;
  for (const id of ['MOOD.happy', 'MOOD.drowsy', 'MOOD.sleepy', 'MOOD.reset']) assert.match(await none.run(id), /还没有选中角色/u, id);
  assert.match(await setup().run('MOOD.reset'), /心情已放回基线，临时的困倦样子也取消了/u);
  assert.match(await setup().run('MOOD.drowsy'), /明显困倦.*15 分钟/u);
  assert.match(await setup().run('MOOD.sleepy'), /有点困.*15 分钟/u);
  assert.match(await setup().run('MOOD.asleep'), /睡着了.*摸摸头或跟她说话会醒.*15 分钟/u);
});

test('L4: each small need is started by name; with automatic expressions paused or no character the note says so', async () => {
  assert.match(await setup().run('L4.lonely'), /她现在有点闷/u);
  assert.match(await setup().run('L4.dream'), /不开心的梦/u);
  assert.match(await setup().run('L4.lowEnergy'), /有点没精神/u);
  assert.match(await setup().run('L4.chatty'), /想找人说话/u);
  const paused = setup(); paused.state.need = 'expressions-off';
  assert.match(await paused.run('L4.lonely'), /暂停自动表现.*小需要/u);
  const none = setup(); none.state.need = 'no-character';
  assert.match(await none.run('L4.dream'), /还没有选中角色/u);
});

test('G1, M1 and L3: invitation and match are asked of the game; the music is asked to judge again; the diary reports its own state', async () => {
  assert.match(await setup().run('G1.invite'), /递出了猜拳邀请/u);
  const closed = setup();
  closed.state.rpsInvite = false; closed.state.rpsStart = false;
  assert.match(await closed.run('G1.invite'), /现在不行/u);
  assert.match(await closed.run('G1.start'), /现在不行/u);
  assert.match(await setup().run('G1.start'), /已直接开了一局猜拳/u);
  assert.match(await setup().run('M1.rejudge'), /重新判一次想不想跳/u);
  assert.match(await setup().run('E1.shy'), /已让她害羞一次/u); assert.match(await setup().run('E1.surprise'), /已让她做一次“惊喜”/u);
  const hidden = setup(); hidden.state.expressionShown = false;
  assert.match(await hidden.run('E1.shy'), /没有桌宠窗口能显示/u);
  const diary: [string, RegExp][] = [['started', /已让她现在补写日记/u], ['recording-off', /先打开“允许记录”/u], ['nothing-due', /没有需要补写的日子/u],
    ['busy', /正在写/u], ['unavailable', /现在没法写日记/u]];
  for (const [status, pattern] of diary) {
    const one = setup();
    one.state.diary = status as typeof one.state.diary;
    assert.match(await one.run('L3.diary'), pattern, status);
  }
});

test('L1: an opportunity that can start now is given at once, with the pacing reset done by the host', async () => {
  const motion = setup();
  assert.match(await motion.run('L1.motion'), /已给她一次小动作的时机/u);
  assert.deepEqual(motion.calls, ['innerLoop.blocker', 'innerLoop.force:motion']);
  const speech = setup();
  assert.match(await speech.run('L1.speech'), /已给她一次说话的时机/u);
  const refused = setup();
  refused.state.forced = false;
  assert.match(await refused.run('L1.speech'), /这次没给成：她这小时说话的次数用完了/u);
  refused.calls.length = 0;
  assert.match(await refused.run('L1.motion'), /这次没给成：她现在不在待机状态/u);
});

test('L1: a busy moment is waited out (the reason is named), then the opportunity is given once; nothing is given before', async () => {
  const waiting = setup();
  waiting.state.blocker = CUE_BLOCKERS.typing;
  const first = await waiting.run('L1.speech');
  assert.match(first, /现在不方便（你刚刚还在和她聊天）.*最多等 45 秒/u);
  assert.equal(waiting.calls.includes('innerLoop.force:speech'), false, 'not given while blocked');
  waiting.time.advance(10_000);
  assert.deepEqual(waiting.later, []);
  waiting.state.blocker = null;
  waiting.time.advance(600);
  assert.equal(waiting.calls.filter(call => call === 'innerLoop.force:speech').length, 1);
  assert.equal(waiting.later.length, 1);
  assert.match(waiting.later[0], /已给她一次说话的时机/u);
  waiting.time.advance(60_000);
  assert.equal(waiting.calls.filter(call => call === 'innerLoop.force:speech').length, 1, 'given once');
  assert.equal(waiting.time.pending, 0);
});

test('L1: it gives up after the wait and says why; a new L1 command replaces the waiting one; disposing cancels', async () => {
  const gaveUp = setup();
  gaveUp.state.blocker = CUE_BLOCKERS.speaking;
  await gaveUp.run('L1.motion');
  gaveUp.time.advance(TEST_WAIT_MS + 2_000);
  assert.equal(gaveUp.calls.some(call => call.startsWith('innerLoop.force')), false);
  assert.equal(gaveUp.later.length, 1);
  assert.match(gaveUp.later[0], /等了 45 秒她一直不方便（她正在说话）/u);
  assert.equal(gaveUp.time.pending, 0);

  const replaced = setup();
  replaced.state.blocker = CUE_BLOCKERS.typing;
  await replaced.run('L1.motion');
  await replaced.run('L1.speech');
  replaced.state.blocker = null;
  replaced.time.advance(1_000);
  assert.deepEqual(replaced.calls.filter(call => call.startsWith('innerLoop.force')), ['innerLoop.force:speech'], 'only the newer one fires');
  assert.equal(replaced.later.length, 1);

  const disposed = setup();
  disposed.state.blocker = CUE_BLOCKERS.hidden;
  await disposed.run('L1.motion');
  disposed.built.dispose();
  disposed.state.blocker = null;
  disposed.time.advance(5_000);
  assert.equal(disposed.calls.some(call => call.startsWith('innerLoop.force')), false);
});

test('L1: a switched-off inner loop, paused expressions or a missing character are refused without touching the loop', async () => {
  for (const [availability, pattern] of [['setting-off', /“内心循环”开关是关的/u], ['expressions-off', /暂停自动表现/u], ['no-character', /还没有选中角色/u]] as const) {
    const one = setup();
    one.state.availability = availability;
    assert.match(await one.run('L1.motion'), pattern, availability);
    assert.deepEqual(one.calls, [], availability);
  }
});

/** Every answer the pet window (or the host) can give for an action, with every fixed part name and detail the stage sends. */
const ACTION_RESULTS: HerActionPlayResult[] = [
  { status: 'played', missing: [], detail: '' },
  { status: 'missing', missing: Object.values(HER_ACTION_PART_NAMES).concat('手指') as string[], detail: '' },
  // T-213: which hand's fingers, and a part a clip cannot reach because another bone shares its name.
  { status: 'missing', missing: [...Object.values(HER_ACTION_FINGER_PARTS), ...Object.values(HER_ACTION_PART_NAMES).map(part => `${part}（有重名骨骼）`)], detail: '' },
  { status: 'unfit', missing: [], detail: '这个动作不适合当前模型' },
  { status: 'unfit', missing: Object.values(HER_ACTION_PART_NAMES) as string[], detail: HER_ACTION_DETAILS.structure },
  ...Object.values(HER_ACTION_DETAILS).map(detail => ({ status: 'busy' as const, missing: [], detail })),
  ...Object.values(HER_ACTION_DETAILS).map(detail => ({ status: 'failed' as const, missing: [], detail })),
  { status: 'failed', missing: [], detail: '' }, { status: 'busy', missing: [], detail: '' },
  { status: 'no-window', missing: [], detail: '' }, { status: 'no-answer', missing: [], detail: '' },
];

test('她的动作: each entry asks for its own action and says what the pet window answered (played, skipped for a missing part, busy, none)', async () => {
  for (const [id, action] of [['ACT.hello', 'hello-wave'], ['ACT.apology', 'apology-bow'], ['ACT.heart', 'two-hand-heart']] as const) {
    const one = setup();
    assert.match(await one.run(id), new RegExp(`^（测试：她做了一次“${HER_ACTION_SPECS[action].name}”（动的是${HER_ACTION_SPECS[action].parts.replace(/[()（）]/g, '.')}）。看桌面上的她。）$`, 'u'));
    assert.deepEqual(one.calls, [`action.play:${action}`]);
  }
  const missing = setup(); missing.state.action = { status: 'missing', missing: ['胸（上半身2）', '手指'], detail: '' };
  assert.equal(await missing.run('ACT.bow'), '（测试：她的模型缺胸（上半身2）、手指，“鞠躬”这个动作跳过了，别的照常。）');
  const busy = setup(); busy.state.action = { status: 'busy', missing: [], detail: HER_ACTION_DETAILS.contact };
  assert.equal(await busy.run('ACT.hug'), '（测试：她现在不方便（你正在摸她或喂她），这次没做“抱抱”。）');
  const unfit = setup(); unfit.state.action = { status: 'unfit', missing: [], detail: '' };
  assert.match(await unfit.run('ACT.cheer'), /适配检查说“欢呼”不适合/u);
  // T-213: exactly what this model lacks; a body part hanging elsewhere names that part.
  const shared = setup(); shared.state.action = { status: 'missing', missing: ['右手腕（有重名骨骼）', '右手手指'], detail: '' };
  assert.equal(await shared.run('ACT.point'), '（测试：她的模型缺右手腕（有重名骨骼）、右手手指，“指一指”这个动作跳过了，别的照常。）');
  const structure = setup(); structure.state.action = { status: 'unfit', missing: ['头部'], detail: HER_ACTION_DETAILS.structure };
  assert.equal(await structure.run('ACT.bow'), '（测试：她的模型里头部没接在标准的位置上，做“鞠躬”会把它和身体扯开，所以跳过了；别的动作照常。）');
  const none = setup(); none.state.action = { status: 'no-window', missing: [], detail: '' };
  assert.match(await none.run('ACT.clap'), /没有桌宠窗口能显示/u);
  const silent = setup(); silent.state.action = { status: 'no-answer', missing: [], detail: '' };
  assert.match(await silent.run('ACT.tilt'), /已经让她做“歪头”，但桌宠窗口没有回音/u);
  const thrown = setup({ action: { play: async () => { throw new Error('gone'); } } });
  assert.match(await thrown.run('ACT.nod'), /^（测试：“点头”没能播放（原因不明）。）$/u, 'a failing host is a note, not an error');
  // Every action of the closed set has exactly one entry.
  const actions = setup().built.entries.filter(entry => entry.id.startsWith('ACT.')).map(entry => entry.name.replace('动作：', ''));
  assert.deepEqual(actions.sort(), HER_ACTIONS.map(action => HER_ACTION_SPECS[action].name).sort());
});

test('English: every note and the help list read in English, with no Chinese left', async () => {
  setUiLanguage('en');
  try {
    const ids = setup().built.entries.map(entry => entry.id);
    const texts: string[] = [];
    for (const id of ids) texts.push(await setup().run(id));
    // The other branches of each entry.
    for (const life of [{ ok: false, reason: 'no-character' }, { ok: false, reason: 'expressions-off' }] as const) {
      const one = setup(); one.state.life = life; texts.push(await one.run('L2.daydream'));
    }
    for (const activity of ['company', 'daydream', 'humming', 'thinking', 'drowsy'] as const) {
      const one = setup(); one.state.picked = activity; texts.push(await one.run('L2.rules'), await one.run(`L2.${activity}`));
    }
    for (const availability of ['setting-off', 'expressions-off', 'no-character'] as const) {
      const one = setup(); one.state.availability = availability; texts.push(await one.run('L1.speech'));
    }
    for (const blocker of Object.values(CUE_BLOCKERS)) {
      const one = setup(); one.state.blocker = blocker; texts.push(await one.run('L1.motion'), await one.run('L1.speech')); one.time.advance(TEST_WAIT_MS + 2_000); texts.push(...one.later);
    }
    const refused = setup(); refused.state.forced = false; texts.push(await refused.run('L1.motion'), await refused.run('L1.speech'));
    const plain = setup(); plain.state.slowWarmUp = false; texts.push(await plain.run('F3.old'));
    const stage = setup(); stage.state.stageThrows = true; texts.push(await stage.run('F3.new'));
    const none = setup(); none.state.userStateSet = false; texts.push(await none.run('F2.low'));
    for (const need of ['expressions-off', 'no-character'] as const) { const one = setup(); one.state.need = need; texts.push(await one.run('L4.chatty')); }
    const noMoodCharacter = setup(); noMoodCharacter.state.moodNoCharacter = true; texts.push(await noMoodCharacter.run('MOOD.happy'), await noMoodCharacter.run('MOOD.drowsy'));
    const differentLabel = setup(); differentLabel.state.moodShown = 'calm'; texts.push(await differentLabel.run('MOOD.upset'));
    const closed = setup(); closed.state.rpsInvite = false; closed.state.rpsStart = false; texts.push(await closed.run('G1.invite'), await closed.run('G1.start'));
    for (const status of ['recording-off', 'nothing-due', 'busy', 'unavailable'] as const) {
      const one = setup(); one.state.diary = status; texts.push(await one.run('L3.diary'));
    }
    for (const result of ACTION_RESULTS) { const one = setup(); one.state.action = result; texts.push(await one.run('ACT.heart'), await one.run('ACT.nod')); }
    const translated = (await import('../shared/ui-language')).t;
    texts.push(...testHelpLines(setup().built.entries, translated));
    for (const text of texts) assert.equal(HAN.test(text), false, text);
    assert.ok(texts.some(text => text.startsWith('(Test: ')));
  } finally { setUiLanguage('zh-CN'); }
});
