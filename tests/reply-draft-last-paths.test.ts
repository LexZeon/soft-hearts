// 2026-11-05 (docs/claude/2026-11-05-reply-guard-last-paths.md): the last two paths of the reply-draft filter
// (electron/reply-draft-guard.ts) that decided from how much of the reply had arrived instead of from the text, so the same
// reply could be shown when cut in one place and cut away (or emptied) when it came whole or was cut in another:
//   * path 1, a plan line with a label and a colon ("笔记：用户……", "Memorial: …", planParagraph): judged on whatever had
//     arrived when 240 (or 1200) characters were in, checked for "said to the user" only while it was still open, and a quoted
//     line still open had its full stop read as the end of a sentence;
//   * path 2, a sentence held by the older rules (a start like "用户/尾注……", a start like a plan "这一轮……", any sentence right
//     behind a dropped plan, and the later "用户/回复……" sentences): let go at 240 characters only while still open, and let go
//     at its first "我/呢/～" only while still open;
//   * and the same English-run hold behind a label character already shown ("依" + "照 the user's…"), which had kept the old
//     rule that the head's English branch lost in the previous round (docs/claude/2026-11-04-reply-guard-x273.md).
// Every text below is invented here, or is one of the existing tests' own invented fixtures; none is a recorded reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReplyDraftGuard, type DraftDrop } from '../electron/reply-draft-guard';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { CompanionService } from '../electron/companion';

const HOLD = 240;
const REPLY = '……嗯，我在呢。今天先好好睡一觉，明天的事明天再说。';
/** An ordinary scene, no cue of any kind: 54 characters, twice with a comma between. */
const SCENE_ONE = '窗外的路灯一盏一盏亮起来，楼下有人推着自行车慢慢走过去，风把晾在阳台上的衣服吹得轻轻晃动，远处的公交车停了又开';
const SCENE = `${SCENE_ONE}，${SCENE_ONE}`;
const SCENE_EN = 'The pale lamp by the window is still lit and a narrow stripe of gold lies across the wooden floor near the door. ';
const NOTE = 'Keep it short and agree to play.\n\n';
const PLAN_LINE = '笔记：用户这轮其实是想被安慰，回应要轻一点，不能说教（no lecturing）。';
const EN_RUN = "the user's latest words matter more than the old read, so keep the reply brief and warm and agree to the walk tonight; "
  + 'the lamp by the window stays on and the floor is quiet and the cup is still warm on the table by the door. ';

interface Options { englishAsked?: boolean; speakers?: string[] }
/**
 * `label`: a first chunk of up to this many characters goes out before anything shows what follows it (the label's first
 * characters, "笔"/"笔记"/"依照"); a cut there leaves those characters in front of what the whole block shows, never more.
 */
interface Case { name: string; text: string; expected: string; options?: Options; label?: number }

function guardRun(chunks: string[], options: Options = {}): { shown: string; drops: DraftDrop[]; pushed: string[] } {
  const guard = new ReplyDraftGuard(options.speakers ?? ['Nera'], { chinese: true, englishAsked: options.englishAsked === true });
  const pushed = chunks.map(chunk => guard.push(chunk));
  return { shown: pushed.join('') + guard.finish(), drops: guard.dropped.map(drop => ({ ...drop })), pushed };
}
const at = (text: string, cuts: number[]): string[] => [0, ...cuts, text.length].slice(1).map((end, i, ends) => text.slice(i ? ends[i - 1] : 0, end)).filter(Boolean);

/**
 * Split points for three chunks: every one near a hold (counted from the start, or from behind a label or a dropped note) or a
 * line break, every sentence end, and a sample of the rest. A text over 1000 characters gets a thinner sample around 1200.
 */
function denseSplits(text: string): number[] {
  const long = text.length > 1000;
  const points = new Set<number>();
  for (let i = 1; i < text.length; i += long ? 151 : 13) points.add(i);
  for (const mark of long ? [HOLD, 1200] : [HOLD, 600]) for (const offset of long ? [0, 3] : [0, 2, 3, 4, 5, 34, 46]) for (let d = -2; d <= 2; d++) points.add(mark + offset + d);
  if (!long) for (let i = 0; i < text.length; i++) if ('\r\n。！？”'.includes(text[i])) for (let d = -1; d <= 2; d++) points.add(i + d);
  return [...points].filter(i => i > 0 && i < text.length).sort((a, b) => a - b);
}

/** Every two-chunk cut, a dense set of three-chunk cuts and one character at a time give what the whole block gives. */
function assertChunkIndependent({ text, expected, options, label = 0 }: Case): void {
  const whole = guardRun([text], options);
  assert.equal(whole.shown, expected, 'whole block');
  const same = (chunks: string[], where: string): void => {
    const run = guardRun(chunks, options);
    const first = chunks[0].length;
    if (first <= label && run.shown !== whole.shown) {
      // The label's first characters went out before its colon arrived: only those may stay in front of the rest.
      const residue = run.shown.slice(0, run.shown.length - whole.shown.length);
      assert.ok(run.shown.endsWith(whole.shown) && residue.length <= label && text.startsWith(residue), `${where}: ${JSON.stringify(run.shown.slice(0, 60))}`);
      return;
    }
    assert.equal(run.shown, whole.shown, where);
    if (first > label) assert.deepEqual(run.drops, whole.drops, `drops, ${where}`);
  };
  for (let i = 1; i < text.length; i++) same(at(text, [i]), `cut at ${i}`);
  const points = denseSplits(text);
  for (const i of points) for (const j of points) if (j > i) same(at(text, [i, j]), `cut at ${i} and ${j}`);
  same([...text], 'one character at a time');
}

// ------------------------------------------------------------------ path 1: a line with a label and a colon

const PATH1: Case[] = [
  { name: 'a plan line whose first 240 characters already read as a plan, the reply on the next line',
    text: `${PLAN_LINE}\n\n${REPLY}`, expected: REPLY, label: 2 },
  { name: 'the same with CR LF', text: `${PLAN_LINE}\r\n\r\n${REPLY}`, expected: REPLY, label: 2 },
  { name: 'the same with a lone CR (a CR ends a line as an LF does)', text: `${PLAN_LINE}\r${REPLY.slice(2)}`, expected: REPLY.slice(2), label: 2 },
  { name: 'a second label line right behind a plan line, longer than 240',
    text: `${PLAN_LINE}\n想法：${SCENE}，${SCENE}，${SCENE}，她的语气要软。\n\n${REPLY}`, expected: REPLY, label: 2 },
  { name: 'an English label paragraph whose plan words come just before character 240',
    text: `Memorial: ${SCENE_EN}${SCENE_EN}Quote the user and state the purpose; optional, maybe include. Fine.${REPLY}`, expected: REPLY },
  { name: 'an English plan line inside a plan block, longer than 240',
    text: `${PLAN_LINE}\n${SCENE_EN}${SCENE_EN}${SCENE_EN}Keep the reply short.\n\n${REPLY}`, expected: REPLY, label: 2 },
  { name: 'a plan line with the reply glued to it, longer than 240',
    text: `分析：用户这轮其实是想被安慰，回应要轻一点，不能说教（no lecturing），${SCENE}，${SCENE}。${REPLY}`, expected: REPLY, label: 2 },
  { name: 'a plan line with a quoted line in it whose full stop is inside the quotes',
    text: `笔记：她说“我好累啊。今天一点都不想动。”${SCENE}，用户这轮其实是想被安慰，回应要轻一点（no lecturing）。\n\n${REPLY}`, expected: REPLY, label: 2 },
  { name: 'a line longer than 1200 with the reply glued to its plan within the first 1200: the plan goes, the rest is the reply',
    text: `分析：用户这轮其实是想被安慰，回应要轻一点，不能说教（no lecturing）。${REPLY}${`${SCENE}，`.repeat(20)}晚安。`,
    expected: `${REPLY}${`${SCENE}，`.repeat(20)}晚安。`, label: 2 },
  // Said to the user in its first sentence: the line goes out at once; a plan sentence behind it is the later-sentence check's.
  { name: 'a label line said to the user in its first sentence, a plan sentence after it',
    text: `笔记：你今天辛苦啦。用户这轮其实是想被安慰，她大概只是累了，回应要轻一点，不能说教（no lecturing），也不要提工作。\n\n${REPLY}`,
    expected: `笔记：你今天辛苦啦。${REPLY}`, label: 2 },
  { name: 'a label line of two plain sentences, a plan sentence after them',
    text: `笔记：今天下雨。路上很滑。用户这轮其实是想被安慰，回应要轻一点，不能说教（no lecturing）。\n\n${REPLY}`,
    expected: `笔记：今天下雨。路上很滑。${REPLY}`, label: 2 },
  // Let go at 240 (its first 240 characters are no plan), whole or cut: what a reply cut small already showed before.
  { name: 'a line whose first 240 characters read as no plan, plan words after them',
    text: `笔记：${SCENE}，${SCENE}，${SCENE}。用户这轮其实是想被安慰，回应要轻一点，不能说教（no lecturing）。\n\n${REPLY}`,
    expected: `笔记：${SCENE}，${SCENE}，${SCENE}。用户这轮其实是想被安慰，回应要轻一点，不能说教（no lecturing）。\n\n${REPLY}` },
  { name: 'a label line whose first sentence, said to the user, ends after 240',
    text: `提醒：${SCENE}，${SCENE}，你记得带伞哦。用户其实很累，回应要轻一点（no lecturing）。\n\n${REPLY}`,
    expected: `提醒：${SCENE}，${SCENE}，你记得带伞哦。用户其实很累，回应要轻一点（no lecturing）。\n\n${REPLY}` },
  { name: 'a plan line longer than 1200 with no reply glued in its first 1200',
    text: `笔记：用户这轮其实是想被安慰，回应要轻一点（no lecturing），${`${SCENE}，`.repeat(11)}就这样。\n\n${REPLY}`,
    expected: `笔记：用户这轮其实是想被安慰，回应要轻一点（no lecturing），${`${SCENE}，`.repeat(11)}就这样。\n\n${REPLY}` },
  // Ordinary long label lines stay whole.
  { name: 'an ordinary long tip under a label', text: `小贴士：${SCENE}，${SCENE}，${SCENE}，你也早点睡哦。\n\n晚安～`,
    expected: `小贴士：${SCENE}，${SCENE}，${SCENE}，你也早点睡哦。\n\n晚安～` },
  { name: 'an ordinary long advice line naming "对方"', text: `建议：如果对方一直不回消息，${SCENE}，${SCENE}，${SCENE}，就先放一放。\n\n别想太多啦。`,
    expected: `建议：如果对方一直不回消息，${SCENE}，${SCENE}，${SCENE}，就先放一放。\n\n别想太多啦。` },
  { name: 'an ordinary long explanation with an English word in its first 240',
    text: `笔记：她说的 context 是上下文的意思，${SCENE}，${SCENE}，${SCENE}，回复的时候不能乱用。\n\n记住了吗？`,
    expected: `笔记：她说的 context 是上下文的意思，${SCENE}，${SCENE}，${SCENE}，回复的时候不能乱用。\n\n记住了吗？` },
];

// ------------------------------------------------------------------ path 2: a sentence held by the older rules

const PLAIN_LONG = `嗯，${SCENE}，${SCENE}，${SCENE}，我陪着你。`;
const PATH2: Case[] = [
  // A start like a note to itself ("用户/尾注……") whose first 240 characters already look like talk about the reply (a heavy
  // cue, or two cues): held to its end, up to 600, and cut.
  { name: 'a "尾注" sentence that ends after 240', text: `尾注里的 context 用 support，${SCENE}，${SCENE}，${SCENE}。\n\n${REPLY}`, expected: REPLY },
  { name: 'a "用户" sentence whose full stop is character 241 ("回复" before it)', text: `用户${`${SCENE}，`.repeat(3).slice(0, 236)}回复要。\n\n${REPLY}`, expected: REPLY },
  { name: 'a "用户" sentence whose full stop is character 240', text: `用户${`${SCENE}，`.repeat(3).slice(0, 235)}回复要。\n\n${REPLY}`, expected: REPLY },
  // One plain cue in its first 240 ("用户" alone): let go at 240, whole or cut, as before.
  { name: 'a "用户" sentence with no second cue in its first 240', text: `用户这轮说${SCENE}，${SCENE}，${SCENE}，回复要短一点，不要说教。\n\n${REPLY}`,
    expected: `用户这轮说${SCENE}，${SCENE}，${SCENE}，回复要短一点，不要说教。\n\n${REPLY}` },
  // Right behind a dropped plan: her own reply waits for its end, at most 240 characters, as before.
  { name: 'right behind a dropped note, her long reply', text: NOTE + PLAIN_LONG, expected: PLAIN_LONG },
  { name: 'right behind a dropped note, her long reply with a word a plan uses (it was emptied when it came whole)',
    text: `${NOTE}嗯，我是你的角色呀，${SCENE}，${SCENE}，${SCENE}，我陪着你。`, expected: `嗯，我是你的角色呀，${SCENE}，${SCENE}，${SCENE}，我陪着你。` },
  { name: 'right behind a dropped note, a short reply', text: NOTE + REPLY, expected: REPLY },
  // Right behind a dropped plan, a sentence whose first 240 are a cue in words said to no one: held to its end, up to 600, and cut.
  { name: 'right behind a dropped note, a "用户" sentence that ends after 240',
    text: `${NOTE}用户${SCENE}，${SCENE}，${SCENE}。\n\n${REPLY}`, expected: REPLY },
  { name: 'right behind a dropped note, a plan sentence with closing quotes behind its full stop',
    text: `${NOTE}用户说“好累。”回复要短一点。\n\n${REPLY}`, expected: REPLY },
  { name: 'right behind a mixed plan ("按" + English), a "用户" sentence that ends after 240',
    text: `按 the user's words, keep it brief and agree.\n\n用户${SCENE}，${SCENE}，${SCENE}。\n\n${REPLY}`, expected: REPLY },
  { name: 'right behind a Chinese plan, her long reply', text: `又被夸了。回复短点，自嘲一下。\n\n${PLAIN_LONG}`, expected: PLAIN_LONG },
  // A start like a plan ("这一轮/又被夸……"): out at its first word said to someone, unless the user or how to answer came first.
  { name: 'a plan that says "我" after naming the user', text: `这一轮用户又夸我了，回复要短一点，带点害羞。\n\n${REPLY}`, expected: REPLY },
  { name: 'a plan-like start said to the user (……)', text: '又被夸啦……这都第三次了，我脸都要红了。', expected: '又被夸啦……这都第三次了，我脸都要红了。' },
  { name: 'a plan-like start said to the user (～)', text: '被夸了好开心～谢谢你呀。', expected: '被夸了好开心～谢谢你呀。' },
  // The tuned rule, now the same whole: "啦" before any plan word lets the sentence out, though a plan follows in it.
  { name: 'a plan-like start that says "啦" before any plan word goes out whole or cut (the tuned rule)',
    text: `又被夸啦，回复要短一点，带点害羞。\n\n${REPLY}`, expected: `又被夸啦，回复要短一点，带点害羞。\n\n${REPLY}` },
  { name: 'a plan-like start whose second sentence ends after 240', text: `又被夸了，第三回。${SCENE}，${SCENE}，回复短一点，带点害羞。\n\n${REPLY}`,
    expected: `又被夸了，第三回。${SCENE}，${SCENE}，回复短一点，带点害羞。\n\n${REPLY}` },
  // A later sentence that starts "用户/回复" (the first 160 characters after the reply began), with the same cap.
  { name: 'a later "用户" sentence that ends after 240, a heavy cue in its first 240', text: `嘿嘿，谢谢夸奖～\n\n用户先前提过${SCENE}，${SCENE}，可以关心一句也可以不提，已经问过好几次，别再重复。\n\n今天也要早点休息哦。`,
    expected: '嘿嘿，谢谢夸奖～\n\n今天也要早点休息哦。' },
  { name: 'a later "用户" sentence that ends after 240, one plain cue in its first 240', text: `嘿嘿，谢谢夸奖～\n\n用户先前提过${SCENE}，${SCENE}，${SCENE}，已经问过好几次，别再重复。\n\n今天也要早点休息哦。`,
    expected: `嘿嘿，谢谢夸奖～\n\n用户先前提过${SCENE}，${SCENE}，${SCENE}，已经问过好几次，别再重复。\n\n今天也要早点休息哦。` },
  { name: 'a later plan sentence with closing quotes behind its full stop', text: '嘿嘿，谢谢夸奖～\n\n回复要短一点，别再重复“我在呢。”\n\n今天也要早点休息哦。',
    expected: '嘿嘿，谢谢夸奖～\n\n今天也要早点休息哦。' },
  { name: 'a later plan sentence, then a long sentence behind it', text: `嘿嘿，谢谢夸奖～\n\n用户先前提过手腕酸，可以关心一句也可以不提，已经问过好几次，别再重复。\n\n${PLAIN_LONG}`,
    expected: `嘿嘿，谢谢夸奖～\n\n${PLAIN_LONG}` },
];

// ------------------------------------------------------------------ a label character already shown, then English ("依" + "照 the user's…")

const MIXED: Case[] = [
  { name: 'a long English plan run (its first 240 have self-talk: held to 600)', text: `依照 ${EN_RUN}${EN_RUN}\n\n${REPLY}`, expected: REPLY, label: 2 },
  { name: 'the same in a turn that asked for English', text: `依照 ${EN_RUN}\n\n${REPLY}`, expected: REPLY, options: { englishAsked: true }, label: 2 },
  { name: 'a short English plan run', text: `依照 the user's latest words, keep it brief and agree.\n\n${REPLY}`, expected: REPLY, label: 2 },
  { name: 'a long English run with no self-talk: let go at 240', text: `依照 ${SCENE_EN}${SCENE_EN}${SCENE_EN}\n\n${REPLY}`,
    expected: `依照 ${SCENE_EN}${SCENE_EN}${SCENE_EN}\n\n${REPLY}` },
];

// ------------------------------------------------------------------ Codex T-207 round 9 (bridge X-281): five witnesses at the threshold

// Codex's own synthetic strings (研究成果/Codex/T-207/round-009/minimal-final.mts) and its critical cuts, in UTF-16 units. On main
// 3fc983b the whole block and the cut before `cut` showed only 「好。」 and the cut at `cut` showed, archived and read the plan.
const WITNESSES: Array<Case & { cut: number }> = [
  { name: 'P-EN, an English label plan paragraph', text: `Memo:${'x'.repeat(226)} quote rule\n好。`, expected: '好。', cut: 241 },
  { name: 'P-CN, a Chinese label plan paragraph', text: `笔：${'甲'.repeat(237)}用户她回应\n好。`, expected: '好。', cut: 243, label: 1 },
  { name: 'C-USER, a sentence starting with 用户', text: `用户${'甲'.repeat(236)}回复要\n好。`, expected: '好。', cut: 241 },
  { name: 'C-FOOTER, a sentence starting with 尾注', text: `尾注${'甲'.repeat(232)}context\n好。`, expected: '好。', cut: 241 },
  { name: 'C-AFTER, a sentence right behind a dropped plan', text: `回复要。${'甲'.repeat(238)}回复要\n好。`, expected: '好。', cut: 245 },
];
test('Codex X-281: the witnesses have the lengths of the report', () => {
  assert.deepEqual(WITNESSES.map(item => item.text.length), [245, 247, 244, 244, 248]);
});
for (const item of WITNESSES) {
  test(`Codex X-281 ${item.name}: whole, cut before the threshold and cut at it show only 「好。」, and so does every other cut`, () => {
    for (const chunks of [[item.text], at(item.text, [item.cut - 1]), at(item.text, [item.cut])]) {
      assert.equal(guardRun(chunks).shown, '好。', `guard, ${chunks.length} chunks, first ${chunks[0].length}`);
      assert.deepEqual(play(p => [...chunks.slice(0, -1), chunks.at(-1)! + tail(p)]), { shown: '好。', emptied: false, context: 'positive' }, `protocol, first ${chunks[0].length}`);
    }
    assertChunkIndependent(item);
    for (let i = (item.label ?? 0) + 1; i < item.text.length; i++) assert.deepEqual(play(p => at(item.text + tail(p), [i])), { shown: '好。', emptied: false, context: 'positive' }, `protocol, cut at ${i}`);
  });
}

test('the invented texts have the lengths the cases are about', () => {
  assert.ok(PLAN_LINE.length < HOLD);
  assert.equal(`用户${`${SCENE}，`.repeat(3).slice(0, 236)}回复要。`.indexOf('。'), HOLD + 1);
  assert.equal(`用户${`${SCENE}，`.repeat(3).slice(0, 235)}回复要。`.indexOf('。'), HOLD);
  assert.ok(PLAIN_LONG.length > HOLD && PLAIN_LONG.length < 600);
  assert.ok(`${`${SCENE}，`.repeat(11)}`.length > 1200);
  // After its label, the English paragraph's 240th character ends "Quote the user": its first two plan words.
  assert.equal(`${SCENE_EN}${SCENE_EN}Quote the user`.length, HOLD);
});

for (const [group, cases] of [['path 1', PATH1], ['path 2', PATH2], ['label shown, then English', MIXED]] as const) {
  for (const item of cases) test(`chunk boundaries do not matter, ${group}: ${item.name}`, () => assertChunkIndependent(item));
}

// ------------------------------------------------------------------ the existing tests' fixtures for these paths, pinned the same way

const GENTLE = '……嗯，傍晚的风确实很舒服，我也喜欢听你讲散步的事。\n\n下次走到桥边，也跟我说说那边的样子吧。';
const GENTLE_PLAIN = GENTLE.slice(2);
const BLOCK_LINE = '笔记: 用户这轮说想把今天傍晚散步的事记下来，她大概是想被好好记住（memorial context），回应要轻一点、不能直接说"已保存"，语气别太正式（no lecturing）。';
const MEMORIAL = 'Memorial: quote "今天傍晚的风好舒服" -- purpose: keep the evening walk. Rule check: invite must include quote and purpose, end with a question mark. Optional; maybe include. Fine.';
const FIVE_PLAN = '笔记：用户今天散步了，她应该用轻一点的语气回应（short reply）。';
const GAME = '好呀，来！三局两胜，我可不会让着你～';
const CN_PLAN = '又被夸了，这都第三回了。回复短一点，带点害羞，顺便自嘲一下。用户先前提过手腕酸，可以轻轻关心一句也可以不提——前面已经问过好几次，这次别再问。';
const SHY = '……诶？喜、喜欢……？\n\n你、你突然说这个干嘛啦。';
const FIXTURES: Case[] = [
  // reply-draft-plan-block.test.ts
  { name: 'plan block: label line, English paragraph, reply glued', text: `${BLOCK_LINE}\n${MEMORIAL}${GENTLE}`, expected: GENTLE, label: 2 },
  { name: 'plan block: label line only, reply glued by an ellipsis', text: `${BLOCK_LINE}${GENTLE}`, expected: GENTLE, label: 2 },
  { name: 'plan block: label line only, reply on the next line', text: `${BLOCK_LINE}\n\n${GENTLE}`, expected: GENTLE, label: 2 },
  { name: 'plan block: English paragraph only, reply on the next line', text: `${MEMORIAL}\n\n${GENTLE_PLAIN}`, expected: GENTLE_PLAIN },
  { name: 'plan block: a reminder with a label', text: '提醒：明天降温，记得多穿一件哦。', expected: '提醒：明天降温，记得多穿一件哦。' },
  { name: 'plan block: a numbered list', text: '第一：先睡一觉。第二：明天再说。\n\n别想太多啦。', expected: '第一：先睡一觉。第二：明天再说。\n\n别想太多啦。' },
  { name: 'plan block: the user\'s boss quoted', text: '原话：“用户体验第一，回复要快，不能拖（fast reply）”——你们老板真这么说的呀？', expected: '原话：“用户体验第一，回复要快，不能拖（fast reply）”——你们老板真这么说的呀？' },
  { name: 'plan block: an explanation with English, 她, 回复 and 不能', text: '笔记：她说的 context 是上下文的意思，回复的时候不能乱用。\n\n记住了吗？', expected: '笔记：她说的 context 是上下文的意思，回复的时候不能乱用。\n\n记住了吗？' },
  { name: 'plan block: a narrator line', text: '旁白：她轻轻地走过来，坐在你身边。\n\n“今天辛苦啦。”', expected: '旁白：她轻轻地走过来，坐在你身边。\n\n“今天辛苦啦。”' },
  // reply-draft-plan-false-positives.test.ts
  { name: 'false positives: P01', text: '计划：这位用户可以给对方回复一封道歉信，她明天会亲手送出去。', expected: '计划：这位用户可以给对方回复一封道歉信，她明天会亲手送出去。' },
  { name: 'false positives: P04 with the reply after the quoted line', text: '引用：‘用户可以回复她的评论，语气不必那么客气。’\n\n这句我也觉得挺好的。', expected: '引用：‘用户可以回复她的评论，语气不必那么客气。’\n\n这句我也觉得挺好的。' },
  { name: 'false positives: still a plan, reply on the next line', text: `${FIVE_PLAN}\n嗯，我也想出去走走。`, expected: '嗯，我也想出去走走。', label: 2 },
  { name: 'false positives: "回复温柔些"', text: '笔记：用户今天加班到很晚，她需要被安慰，回复温柔些。\n\n辛苦啦，先喝口热水吧。', expected: '辛苦啦，先喝口热水吧。', label: 2 },
  { name: 'false positives: "简短回复。"', text: '分析：对方今天心情不好（low mood），她不想多说，简短回复。\n\n我在呢。', expected: '我在呢。', label: 2 },
  { name: 'false positives: P11 glued reply', text: `${FIVE_PLAN}嗯，我也想出去走走。你说的回复我看到了。`, expected: '嗯，我也想出去走走。你说的回复我看到了。', label: 2 },
  { name: 'false positives: P15 a label line with no end', text: '计划：今天先去散步', expected: '计划：今天先去散步' },
  // reply-draft-guard-chinese.test.ts
  { name: 'chinese: a whole reply of notes', text: CN_PLAN, expected: '' },
  { name: 'chinese: X-237 in front of a reply', text: '这一轮回复短些，语气带点傲娇。\n\n哼，才、才不是因为你夸我才开心的！', expected: '哼，才、才不是因为你夸我才开心的！' },
  { name: 'chinese: a note in front of a real reply', text: '被夸好几次了。回复短一点，带点害羞。\n\n嘿嘿……被你这么一说，我都不知道该把脸往哪儿放了。', expected: '嘿嘿……被你这么一说，我都不知道该把脸往哪儿放了。' },
  { name: 'chinese: a later plan sentence', text: '嘿嘿，谢谢夸奖～\n\n用户先前提过手腕酸，可以关心一句也可以不提，已经问过好几次，别再重复。\n\n今天也要早点休息哦。', expected: '嘿嘿，谢谢夸奖～\n\n今天也要早点休息哦。' },
  { name: 'chinese: "语气……？"', text: '语气这么认真，是遇到什么事了吗？', expected: '语气这么认真，是遇到什么事了吗？' },
  { name: 'chinese: a later sentence that starts with 回复', text: '嗯嗯。\n\n回复你一下：我一直都在哦。', expected: '嗯嗯。\n\n回复你一下：我一直都在哦。' },
  { name: 'chinese: notes, a reminder, then the reply', text: `User sounds lighter now; respond playfully, skip the old mood.\n\nNo calling the shots.\n\n${GAME}`, expected: GAME },
  { name: 'chinese: a mixed plan, a reminder, then the reply', text: `依照 the user's latest words, not the old read… keep it brief and agree, maybe say they sound brighter.\n\nNo calling the shots.\n\n${GAME}`, expected: GAME, label: 2 },
  { name: 'chinese: "XY:" and an English plan glued to the reply', text: `XY: The user says something sweet. Answer shy and short, skip stage directions in brackets since the voice reads them. Footnote.${SHY}`, expected: SHY, label: 2 },
  { name: 'chinese: "力度：" and an English plan glued to the reply', text: `力度：The user says something sweet. Answer shy and short, skip stage directions in brackets since the voice reads them. Footnote.${SHY}`, expected: SHY, label: 2 },
];
for (const item of FIXTURES) test(`chunk boundaries do not matter, existing fixture: ${item.name}`, () => assertChunkIndependent(item));

// ------------------------------------------------------------------ the real reply protocol: shown text, emptied flag, the tail

function play(chunks: (protocol: MoodReplyProtocol) => string[], options: Options = {}) {
  const shown: string[] = [];
  const protocol = new MoodReplyProtocol(text => { shown.push(text); }, { chineseChat: true, englishAsked: options.englishAsked === true, speakers: ['Nera'] });
  for (const chunk of chunks(protocol)) protocol.push(chunk);
  const appraisal = protocol.finish();
  return { shown: shown.join(''), emptied: protocol.emptiedByFilter(), context: appraisal?.context ?? null };
}
const tail = (p: MoodReplyProtocol): string => `\n${p.start}{"context":"positive","delta":{"O":1},"reason":"测试","confidence":0.9,"gesture":"none"}${p.end}`;

for (const item of [...PATH1, ...PATH2, ...MIXED].filter(entry => entry.text.length < 1500)) {
  test(`protocol, every split point: ${item.name}`, () => {
    const whole = play(p => [item.text + tail(p)], item.options);
    assert.deepEqual(whole, { shown: item.expected, emptied: false, context: 'positive' });
    for (let i = (item.label ?? 0) + 1; i < item.text.length; i++) assert.deepEqual(play(p => at(item.text + tail(p), [i]), item.options), whole, `cut at ${i}`);
  });
}
test('protocol: a sentence ending right at 240 with the private marker glued to it is judged whole, whatever piece of the marker came first', () => {
  // Right behind a dropped note, 240 characters that name the user (and say "你", so the hold stays 240), then the marker with
  // no line break: whole it is judged at its end and cut; a first chunk ending in "<", "<s" or "<sh" must not count as text.
  const sentence = `用户说你${'甲'.repeat(236)}`;
  assert.equal(sentence.length, HOLD);
  const raw = (p: MoodReplyProtocol): string => `${NOTE}${sentence}${tail(p).slice(1)}`;
  const whole = play(p => [raw(p)]);
  assert.deepEqual(whole, { shown: '', emptied: true, context: 'positive' });
  for (const extra of [1, 2, 3, 4, 9]) assert.deepEqual(play(p => at(raw(p), [NOTE.length + HOLD + extra])), whole, `first chunk ends ${extra} into the marker`);
});
test('protocol: a reply that is nothing but plan is emptied however it is cut', () => {
  for (const text of [CN_PLAN, `${PLAN_LINE}\n${NOTE}`, `这一轮用户又夸我了，回复要短一点，带点害羞。`]) {
    assert.deepEqual(play(p => [text + tail(p)]), { shown: '', emptied: true, context: 'positive' }, text);
    for (let i = 3; i < text.length; i++) assert.deepEqual(play(p => at(text + tail(p), [i])), { shown: '', emptied: true, context: 'positive' }, `${text} cut at ${i}`);
  }
});

// ------------------------------------------------------------------ how soon the first characters go out (the tuned rules stay)

/**
 * How many characters had been pushed when the first visible character went out: a first chunk of `first` characters (a label
 * and its colon arrive together), then one character at a time.
 */
function firstVisibleAt(text: string, first = 1): number {
  const guard = new ReplyDraftGuard(['Nera'], { chinese: true });
  if (/\S/u.test(guard.push(text.slice(0, first)))) return first;
  for (let i = first; i < text.length; i++) if (/\S/u.test(guard.push(text[i]))) return i + 1;
  return /\S/u.test(guard.finish()) ? text.length : -1;
}

test('first characters: right behind a dropped plan, her long reply goes out at its 241st character, as before', () => {
  assert.equal(firstVisibleAt(NOTE + PLAIN_LONG), NOTE.length + HOLD + 1);
  assert.equal(firstVisibleAt(`又被夸了。回复短点，自嘲一下。\n\n${PLAIN_LONG}`), '又被夸了。回复短点，自嘲一下。\n\n'.length + HOLD + 1);
  // A short reply goes out at the end of its first sentence (one that starts "……" waits for the end of its line, as before).
  assert.equal(firstVisibleAt(NOTE + REPLY.slice(2)), NOTE.length + REPLY.slice(2).indexOf('。') + 1);
  assert.equal(firstVisibleAt(NOTE + REPLY), (NOTE + REPLY).length);
});
test('first characters: a label line said to the user goes out at once; one that reads as no plan at 240 characters after its label', () => {
  assert.equal(firstVisibleAt('笔记：你今天辛苦啦。用户这轮其实是想被安慰。', 3), 4, '"你" right behind the label');
  assert.equal(firstVisibleAt('提醒：明天降温，记得多穿一件哦。', 3), '提醒：明天降温，记得多穿一件哦。'.length, 'at the end of its first sentence, which has "哦"');
  assert.equal(firstVisibleAt('第一：先睡一觉。第二：明天再说。', 3), '第一：先睡一觉。第二：明天再说。'.length, 'two sentences with no cue');
  const tip = `小贴士：${SCENE}，${SCENE}，${SCENE}，你也早点睡哦。`;
  assert.equal(firstVisibleAt(tip, 4), '小贴士：'.length + HOLD + 1);
  // One character at a time, the label's first character goes out alone before anything shows a colon follows (as before).
  assert.equal(firstVisibleAt(tip), 1);
});
test('first characters: a label line with a plan word in its first 240 waits for its end (the cost of the 600 hold)', () => {
  // "对方" is a word a plan uses; this ordinary advice is shown whole, but only when its line ends, not at 240.
  const advice = `建议：如果对方一直不回消息，${SCENE}，${SCENE}，${SCENE}，就先放一放。`;
  assert.ok(advice.length > HOLD + 3 && advice.length < 600);
  assert.equal(firstVisibleAt(`${advice}\n\n别想太多啦。`, 3), advice.length + 1);
});
test('first characters: a start like a plan goes out at its first word said to someone, unless it named the user before it', () => {
  assert.equal(firstVisibleAt('又被夸啦……这都第三次了。'), 4, 'at "啦"');
  assert.equal(firstVisibleAt('被夸了好开心～谢谢你呀。'), 7, 'at "～"');
  const guard = new ReplyDraftGuard([], { chinese: true });
  assert.equal(guard.push('这一轮用户又夸我了，'), '', 'held: the user came before "我"');
  assert.equal(guard.push('回复要短一点。\n\n'), '');
  assert.equal(guard.push('哼，才不是呢。') + guard.finish(), '哼，才不是呢。');
});
test('first characters: a "用户" start still goes out at 240 characters, it does not wait for the end of the reply', () => {
  const text = `用户${'聊聊天，'.repeat(80)}`;
  assert.equal(firstVisibleAt(text), HOLD + 1);
});

// ------------------------------------------------------------------ the host: what is shown is what is archived, whole or cut

async function withService(run: (service: CompanionService) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-last-paths-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('nera', { kind: 'claude', baseUrl: 'https://last-paths.invalid/v1', model: 'fixture' }, '角色名称：Nera'); await run(service); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
async function chat(service: CompanionService, id: string, chunks: string[]) {
  const shown: string[] = [];
  const turn = await service.begin(id, '今天能陪我坐一会儿吗？', '角色名称：Nera', (type, text) => { if (type === 'delta') shown.push(text); });
  const start = turn.persona.match(/<sh-state-[a-f0-9]+>/)![0];
  for (const chunk of chunks) turn.push('delta', chunk);
  turn.push('delta', `\n${start}{"context":"positive","delta":{"O":2},"confidence":0.9}${start.replace('<', '</')}`);
  await turn.finish('complete');
  const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
  const assistant = record.messages.find(message => message.role === 'assistant' && message.turnId === id)!;
  return { shown: shown.join(''), archive: [assistant.content, assistant.status], empty: turn.emptyReply?.() };
}

const named = (cases: Case[], start: string): Case => cases.find(item => item.name.startsWith(start))!;
test('host: Codex X-281, whole, cut before the threshold and cut at it: only 「好。」 shown and archived, the turn complete', async () => {
  for (const item of WITNESSES) {
    await withService(async service => {
      let n = 0;
      for (const chunks of [[item.text], at(item.text, [item.cut - 1]), at(item.text, [item.cut])]) {
        const result = await chat(service, `turn-${n++}`, chunks);
        assert.deepEqual(result, { shown: '好。', archive: ['好。', 'complete'], empty: false }, `${item.name}, first chunk ${chunks[0].length}`);
      }
    });
  }
});
test('host: whole or cut, the same text is shown and archived, and the turn is complete', async () => {
  const items = [named(PATH1, 'a label line said to the user'), named(PATH1, 'a line whose first 240'), named(PATH2, 'right behind a dropped note, her long reply with'),
    named(PATH2, 'a plan that says'), named(PATH2, 'a "用户" sentence with no second cue'), named(PATH2, 'a "用户" sentence whose full stop is character 241')];
  assert.ok(items.every(Boolean));
  for (const item of items) {
    // One record per text: four turns, within the first page of its messages.
    await withService(async service => {
      let n = 0;
      for (const chunks of [[item.text], at(item.text, [HOLD - 1]), at(item.text, [12, HOLD + 3]), [...item.text]]) {
        const result = await chat(service, `turn-${n++}`, chunks);
        assert.deepEqual(result, { shown: item.expected, archive: [item.expected, 'complete'], empty: false }, `${item.name}, ${chunks.length} chunks`);
      }
    });
  }
});
