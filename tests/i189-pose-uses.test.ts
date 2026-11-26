/**
 * I-189 what the local pose signals are used for:
 * attention (sure readings only, never one frame), nod / shake recognition and her yes/no question, the answer window, body time
 * (sitting, staring, posture), two people (a fixed note), the moments host's pose facts, the journal line, the signal's people count.
 * Synthetic signals only (no real person); fake clocks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_POSE_SIGNAL, parsePoseSignal, type PosePoint, type PoseSignal } from '../shared/senses/pose-signals';
import { AttentionTracker, attentionOf, awayForReading, parseUserAttention, turnedFromScreen } from '../shared/behaviors/pose-uses/attention';
import { asksYesNo, HeadGestureDetector, lastQuestion, zigzag } from '../shared/behaviors/pose-uses/nod';
import { PeopleWatch, PostureWatch, SittingClock, StareWatch } from '../shared/behaviors/pose-uses/body-time';
import { asksAboutSitting, gestureTurnText, sittingNote, twoPeopleNote } from '../shared/behaviors/pose-uses/lines';
import { parsePoseUseFact } from '../shared/behaviors/pose-uses/journal';
import { POSE_USES_KNOBS } from '../shared/behaviors/pose-uses/knobs';
import { PoseUsesHost, type PoseUseRow, type PoseUsesPorts } from '../electron/senses/pose-uses/host';
import { countPeople } from '../electron/senses/pose/pipeline';
import { PoseFeatureTracker } from '../electron/senses/pose/features';
import { momentPromptLine } from '../shared/behaviors/moments/prompt';
import { MOMENT_KINDS } from '../shared/behaviors/moments/interface';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { parseUserGazeReading } from '../shared/behaviors/gaze-attention/interface';

const MIN = 60_000;
const sig = (over: Partial<PoseSignal> = {}): PoseSignal => ({ ...EMPTY_POSE_SIGNAL, present: true, confidence: 0.9, facing: 'toward', facingConfidence: 0.8, posture: 'sitting', postureConfidence: 0.8, energy: 0.1, people: 1, ...over });
const shoulders = (y = 0.7): [PosePoint, PosePoint] => [{ x: 0.4, y }, { x: 0.6, y }];
/** 17 points with only the nose and the shoulders set (enough for the nod reader). */
const body = (nose: PosePoint, s: [PosePoint, PosePoint] = shoulders()): (PosePoint | null)[] => {
  const points: (PosePoint | null)[] = Array.from({ length: 17 }, () => null);
  points[0] = nose; points[5] = s[0]; points[6] = s[1];
  return points;
};

// ---------------------------------------------------------------- attention (#1, #2)

test('attention: one signal alone: turned only with a sure side/away vote; a low-confidence frame is unsure', () => {
  assert.equal(attentionOf(sig({ facing: 'side', facingConfidence: 0.9 })), 'turned');
  assert.equal(attentionOf(sig({ facing: 'away', facingConfidence: POSE_USES_KNOBS.attention.sureConfidence })), 'turned');
  assert.equal(attentionOf(sig({ facing: 'side', facingConfidence: 0.3 })), 'unsure', 'not sure enough');
  assert.equal(attentionOf(sig({ facing: 'toward', facingConfidence: 0.2 })), 'unsure');
  assert.equal(attentionOf(sig({ present: false })), 'gone');
  assert.equal(attentionOf(sig({ capability: 'presence-only', facing: 'side', facingConfidence: 0.9 })), 'unsure', 'presence only says nothing about facing');
});

test('attention: a run needs minFrames sure frames; short unsure gaps do not break it; toward ends it at once; stale is unsure', () => {
  const t = new AttentionTracker();
  let now = 0;
  const feed = (s: PoseSignal, n: number, step = 200) => { for (let i = 0; i < n; i++) { t.note(s, now); now += step; } };
  feed(sig(), 10);
  assert.equal(t.read(now).state, 'toward');
  feed(sig({ facing: 'side', facingConfidence: 0.9 }), 1);
  assert.equal(t.read(now).state, 'unsure', 'one sure frame is not a run yet');
  feed(sig({ facing: 'side', facingConfidence: 0.9 }), 4);
  const turnedAt = now;
  feed(sig({ facing: 'side', facingConfidence: 0.2 }), 2); // 400 ms of blur
  feed(sig({ facing: 'side', facingConfidence: 0.9 }), 10);
  const r = t.read(now);
  assert.equal(r.state, 'turned');
  assert.ok(r.forMs >= now - turnedAt, `the run kept its start through the blur (${r.forMs} ms)`);
  feed(sig({ facing: 'side', facingConfidence: 0.2 }), 5); // 1 s of blur: longer than gapMs
  assert.equal(t.read(now).state, 'unsure', 'a long unsure stretch ends what was known');
  feed(sig({ facing: 'side', facingConfidence: 0.9 }), 5);
  feed(sig(), 1);
  assert.equal(t.read(now).state, 'toward', 'facing the screen again ends the turn at once');
  assert.equal(t.read(now + 10_000).state, 'unsure', 'no signal for a while: not known');
  // Gone: absent signals come every 2 s; the run continues across them.
  feed(sig({ present: false, facing: 'unknown', facingConfidence: 0 }), 4, 2_000);
  assert.equal(t.read(now).state, 'gone');
  assert.ok(t.read(now).forMs >= 6_000);
  t.forget();
  assert.equal(t.read(now).state, 'unsure', 'sensing off forgets');
});

test('#1 a single low-confidence frame never pauses: awayForReading needs sure frames held for awaySeconds', () => {
  const t = new AttentionTracker();
  let now = 0;
  for (let i = 0; i < 25; i++) { t.note(sig(i === 12 ? { facing: 'away', facingConfidence: 0.1 } : {}), now); now += 200; }
  assert.equal(awayForReading(t.read(now)), false);
  for (let i = 0; i < 6; i++) { t.note(sig({ facing: 'away', facingConfidence: 0.9 }), now); now += 200; }
  assert.equal(awayForReading(t.read(now)), false, '1.2 s turned: not yet');
  for (let i = 0; i < 5; i++) { t.note(sig({ facing: 'away', facingConfidence: 0.9 }), now); now += 200; }
  assert.equal(awayForReading(t.read(now)), true, 'past 2 s turned (sure): her reading may pause');
});

test('#2 a turned face counts only when sure: low-confidence side frames never hold a barge-in', () => {
  const low = new AttentionTracker(), high = new AttentionTracker();
  let now = 0;
  for (let i = 0; i < 20; i++) { low.note(sig({ facing: 'side', facingConfidence: 0.45 }), now); high.note(sig({ facing: 'side', facingConfidence: 0.85 }), now); now += 100; }
  assert.equal(turnedFromScreen(low.read(now)), false, 'not sure: her reading can be talked over as before');
  assert.equal(turnedFromScreen(high.read(now)), true, 'sure for 2 s: not talking over her');
  assert.equal(turnedFromScreen({ state: 'turned', forMs: 200 }), false, 'held a moment first');
  assert.equal(turnedFromScreen({ state: 'gone', forMs: 9_000 }), false, 'gone is not a turned face');
});

test('the attention reading the windows get: exact shape; userGaze carries it (or refuses a bad one)', () => {
  assert.deepEqual(parseUserAttention({ state: 'turned', forMs: 2500.4 }), { state: 'turned', forMs: 2500 });
  assert.equal(parseUserAttention({ state: 'turned', forMs: 1, extra: 1 }), null);
  assert.equal(parseUserAttention({ state: 'sideways', forMs: 1 }), null);
  const reading = { present: true, facing: 'side', energy: 0.1, point: null, screen: null };
  assert.deepEqual(parseUserGazeReading({ ...reading, attention: { state: 'turned', forMs: 900 } })?.attention, { state: 'turned', forMs: 900 });
  assert.equal(parseUserGazeReading(reading)?.attention, undefined, 'an older reading: not known');
  assert.equal(parseUserGazeReading({ ...reading, attention: { state: 'turned' } }), null);
});

// ---------------------------------------------------------------- nod / shake (#3)

// a deliberate double nod / double shake at 10 fps, shoulders 0.2 of the frame wide (0.3 shoulder widths peak to peak).
const wave = (n: number, base: number, amp: number): number[] => Array.from({ length: n }, (_, i) => base + (amp * (1 - Math.cos(2 * Math.PI * i / (n - 1) * 2))) / 2);
const DOUBLE_NOD = wave(13, 0.45, 0.06);
const DOUBLE_SHAKE = wave(13, 0.5, 0.06);

test('#3 nod and shake from the nose against the shoulders; jitter, a single look down and body sway are nothing', () => {
  const run = (noses: PosePoint[], s?: (i: number) => [PosePoint, PosePoint]) => {
    const d = new HeadGestureDetector();
    let found: string | null = null;
    noses.forEach((nose, i) => { found ??= d.push(body(nose, s?.(i)), i * 100); });
    return found;
  };
  const ys = DOUBLE_NOD;
  assert.equal(run(ys.map(y => ({ x: 0.5, y }))), 'nod');
  const xs = DOUBLE_SHAKE;
  assert.equal(run(xs.map(x => ({ x, y: 0.45 }))), 'shake');
  assert.equal(run([0.45, 0.452, 0.448, 0.451, 0.449, 0.45, 0.452, 0.448].map(y => ({ x: 0.5, y }))), null, 'jitter');
  assert.equal(run([0.45, 0.47, 0.49, 0.5, 0.5, 0.5, 0.5, 0.5].map(y => ({ x: 0.5, y }))), null, 'looked down and stayed: one leg');
  assert.equal(run(ys.map(y => ({ x: 0.5, y })), i => shoulders(0.7 + ys[i] - 0.45)), null, 'the whole body moved with the head (sway, a shift in the chair)');
  assert.equal(run(xs.map((x, i) => ({ x, y: 0.45 + (i % 2) * 0.04 }))), null, 'both directions at once: neither');
  assert.equal(run(ys.slice(0, 7).map(y => ({ x: 0.5, y }))), null, 'one nod is not a deliberate answer any more (2026-11-24)');
  assert.deepEqual(zigzag([0, 0.06, 0, 0.06], 0.05), { legs: 3, range: 0.06 });
});

test('#3 her yes/no question: closed rules on her own last sentence (Chinese and English)', () => {
  for (const yes of ['你今天累了吗？', '那我们一起听首歌，好不好？', '要不要休息一下呀？', '我陪你，可以吗？（歪头）', '我们去散步吧？', '是不是有点冷～？',
    'Do you want some tea?', 'You okay?, right?', "That's fun, right?", 'Shall we keep going?']) assert.equal(asksYesNo(yes), true, yes);
  for (const no of ['你今天吃了什么？', '你想听哪首？', '要咖啡还是茶？', '今天天气真好。', '你累了吗？我先唱一首歌给你听。', 'What are you doing?', 'Tea or coffee?', '为什么呀？']) assert.equal(asksYesNo(no), false, no);
  assert.equal(lastQuestion('嗯嗯。那你要不要睡一会儿？'), '那你要不要睡一会儿');
});

interface HostRig { host: PoseUsesHost; s: { now: number; line: { text: string; at: number } | null; busy: boolean; can: boolean }; sent: string[]; rows: PoseUseRow[] }
function hostRig(over: Partial<PoseUsesPorts> = {}): HostRig {
  const s = { now: 1_000_000, line: null as { text: string; at: number } | null, busy: false, can: true };
  const sent: string[] = [], rows: PoseUseRow[] = [];
  const host = new PoseUsesHost({ clock: () => s.now, dayKey: () => 'd1', language: () => 'zh-CN', herLine: () => s.line, herBusy: () => s.busy, canAnswer: () => s.can,
    answer: text => { sent.push(text); return true; }, journal: row => { rows.push(row); }, ...over });
  return { host, s, sent, rows };
}
/** Feed a nod (or shake) as signals 100 ms apart, the user facing the screen. */
function gesture(r: HostRig, kind: 'nod' | 'shake') {
  const noses = kind === 'nod' ? DOUBLE_NOD.map(y => ({ x: 0.5, y })) : DOUBLE_SHAKE.map(x => ({ x, y: 0.45 }));
  for (const nose of noses) { r.host.note(sig({ points: body(nose), face: nose })); r.s.now += 100; }
}
const still = (r: HostRig, ms: number) => { for (let t = 0; t < ms; t += 500) { r.host.note(sig({ points: body({ x: 0.5, y: 0.45 }), face: { x: 0.5, y: 0.45 } })); r.s.now += 500; } };

test('#3 a nod right after her yes/no question becomes the user\'s answer, once; its turn gets one private line', () => {
  const r = hostRig();
  r.s.line = { text: '要不要喝点水？', at: r.s.now };
  still(r, 1_500);
  gesture(r, 'nod');
  assert.deepEqual(r.sent, [gestureTurnText('nod')]);
  assert.deepEqual(r.rows.at(-1), { use: 'nod', event: 'nod' });
  assert.match(r.host.chatTurn('（点头）'), /不是用户打的字.*点了点头/u);
  assert.equal(r.host.chatTurn('（点头）'), '', 'the note is taken once');
  gesture(r, 'nod');
  assert.equal(r.sent.length, 1, 'one answer per question');
});

test('#3 a nod is an answer only within the window after a yes/no question (and only while she was asking)', () => {
  const late = hostRig();
  late.s.line = { text: '要不要喝点水？', at: late.s.now };
  still(late, (POSE_USES_KNOBS.nod.windowSeconds + 2) * 1000);
  assert.equal(late.host.answerOpen(), false);
  gesture(late, 'nod');
  assert.deepEqual(late.sent, [], 'too late: a nod is just a nod');

  const busy = hostRig();
  busy.s.line = { text: 'Do you want some tea?', at: busy.s.now }; busy.s.busy = true;
  still(busy, 20_000);
  assert.equal(busy.host.answerOpen(), false, 'she is still reading: a nod now is listening (2026-11-24)');
  gesture(busy, 'nod');
  assert.deepEqual(busy.sent, []);
  busy.s.busy = false; still(busy, 2_000);
  gesture(busy, 'shake');
  assert.deepEqual(busy.sent, ['（摇头）']);

  const open = hostRig();
  open.s.line = { text: '你今天吃了什么？', at: open.s.now };
  still(open, 1_000);
  gesture(open, 'nod');
  assert.deepEqual(open.sent, [], 'not a yes/no question');

  const blocked = hostRig();
  blocked.s.line = { text: '要不要喝点水？', at: blocked.s.now }; blocked.s.can = false;
  still(blocked, 1_000);
  gesture(blocked, 'nod');
  assert.deepEqual(blocked.sent, [], 'typing, a call or a running turn: not sent');
  blocked.s.can = true; blocked.s.line = { text: '要不要喝点水？', at: blocked.s.now }; still(blocked, 2_000);
  gesture(blocked, 'nod');
  assert.deepEqual(blocked.sent, [gestureTurnText('nod')], 'after typing stopped (and a quiet moment) a nod to a question still counts');

  const turned = hostRig();
  turned.s.line = { text: '要不要喝点水？', at: turned.s.now };
  still(turned, 1_000);
  for (const y of DOUBLE_NOD) { turned.host.note(sig({ facing: 'side', facingConfidence: 0.9, points: body({ x: 0.5, y }) })); turned.s.now += 100; }
  assert.deepEqual(turned.sent, [], 'a nod while facing away from her is not an answer');
});

// ---------------------------------------------------------------- body time (#4-#6) and two people (#7)

test('#6 sitting: told once at firstMinutes, again at againMinutes, never more; a stand-up or a long absence starts over', () => {
  const c = new SittingClock();
  let now = 0;
  const feed = (s: PoseSignal, ms: number) => { for (let t = 0; t < ms; t += 2_000) { c.note(s, now, 'd'); now += 2_000; } };
  feed(sig(), 59 * MIN);
  assert.equal(c.take(now), null);
  feed(sig(), 2 * MIN);
  const first = c.take(now);
  assert.ok(first && first.minutes >= 60 && first.todayMinutes >= 60 && first.standUps === 0, JSON.stringify(first));
  assert.equal(c.take(now), null, 'once');
  feed(sig(), 90 * MIN);
  assert.ok((c.take(now)?.minutes ?? 0) >= 150, 'again much later');
  feed(sig(), 120 * MIN);
  assert.equal(c.take(now), null, 'no third time in the same stretch');
  feed(sig({ posture: 'standing', postureConfidence: 0.9 }), 10_000);
  assert.equal(c.facts(now).standUps, 1);
  assert.equal(c.minutes(now), 0);
  feed(sig(), 30 * MIN);
  feed(sig({ present: false, facing: 'unknown', facingConfidence: 0, posture: 'unknown', postureConfidence: 0 }), 3 * MIN);
  assert.equal(c.facts(now).standUps, 2, 'away from the seat for minutes counts as getting up');
  assert.match(sittingNote(c.facts(now)), /今天一共坐了约 \d+ 分钟，起身过 2 次/u);
});

test('#5 staring: still and facing the screen for long, once; then looking away for awaySeconds is a fact too', () => {
  const w = new StareWatch();
  let now = 0;
  const feed = (s: PoseSignal, ms: number) => { for (let t = 0; t < ms; t += 1_000) { w.note(s, now, 'd'); now += 1_000; } };
  feed(sig({ energy: 0.05 }), 20 * MIN);
  feed(sig({ facing: 'side', facingConfidence: 0.9, energy: 0.3 }), 10_000); // a glance
  feed(sig({ energy: 0.05 }), 21 * MIN);
  assert.deepEqual(w.take(now), { kind: 'staring', minutes: 41 });
  assert.equal(w.take(now), null);
  feed(sig({ facing: 'side', facingConfidence: 0.9, energy: 0.3 }), 40_000);
  const away = w.take(now);
  assert.equal(away?.kind, 'away');
  assert.ok((away?.awaySeconds ?? 0) >= POSE_USES_KNOBS.staring.awaySeconds);
  const moving = new StareWatch();
  now = 0;
  for (let t = 0; t < 60 * MIN; t += 1_000) { moving.note(sig({ energy: 0.4 }), now, 'd'); now += 1_000; }
  assert.equal(moving.take(now), null, 'moving about: not staring');
});

test('#4 posture: slumped most of the window for slumpMinutes; very close for closeMinutes; capped a day', () => {
  const w = new PostureWatch();
  let now = 0;
  const feed = (s: PoseSignal, ms: number) => { for (let t = 0; t < ms; t += 2_000) { w.note(s, now, 'd'); now += 2_000; } };
  feed(sig({ posture: 'slumped', postureConfidence: 0.8 }), 15 * MIN);
  assert.equal(w.take(now), null);
  feed(sig({ posture: 'slumped', postureConfidence: 0.8 }), 8 * MIN);
  assert.deepEqual(w.take(now)?.posture, 'slumped');
  const close = new PostureWatch();
  now = 0;
  for (let t = 0; t < 6 * MIN; t += 2_000) { close.note(sig({ points: body({ x: 0.5, y: 0.4 }, [{ x: 0.2, y: 0.8 }, { x: 0.75, y: 0.8 }]) }), now, 'd'); now += 2_000; }
  assert.deepEqual(close.take(now), { posture: 'close', minutes: 6 });
  const unsure = new PostureWatch();
  now = 0;
  for (let t = 0; t < 40 * MIN; t += 2_000) { unsure.note(sig({ posture: 'slumped', postureConfidence: 0.3 }), now, 'd'); now += 2_000; }
  assert.equal(unsure.take(now), null, 'not sure it is a slump');
});

test('#7 two people: only after sustainSeconds of a count of two; once an episode; a new episode after the other person left', () => {
  const w = new PeopleWatch();
  let now = 0;
  const feed = (people: number, ms: number) => { for (let t = 0; t < ms; t += 500) { w.note(sig({ people }), now); now += 500; } };
  feed(2, 5_000);
  assert.equal(w.take(), false, 'not held long enough');
  feed(1, 500); feed(2, 9_000);
  assert.equal(w.take(), false, 'one frame of one person restarts the count');
  feed(2, 2_000);
  assert.equal(w.take(), true);
  assert.equal(w.take(), false, 'once an episode');
  feed(1, 3 * MIN);
  feed(2, 11_000);
  assert.equal(w.take(), true, 'came back later: a new episode');
});

test('#7 the two-people note is one fixed sentence: no count, no position, no picture, no description', () => {
  assert.equal(twoPeopleNote(), '（应用提示：摄像头本机看到，画面里好像还有一个人。只是资料。）');
  assert.equal(twoPeopleNote.length <= 1, true, 'it takes nothing but the language');
  const r = hostRig();
  for (let t = 0; t < 15_000; t += 500) { r.host.note(sig({ people: 2, points: body({ x: 0.5, y: 0.45 }), face: { x: 0.31, y: 0.62 } })); r.s.now += 500; }
  const line = r.host.chatTurn('在干嘛');
  assert.equal(line, twoPeopleNote());
  assert.doesNotMatch(line, /0\.\d|data:|image|base64|左|右|男|女/u);
  assert.equal(r.host.chatTurn('在干嘛'), '', 'once');
  assert.deepEqual(r.rows.at(-1), { use: 'two-people', event: 'told' });
});

test('#6 sitting numbers reach her only when the user asks; the host hands pose facts to the moments host', () => {
  assert.equal(asksAboutSitting('我今天坐了多久？'), true);
  assert.equal(asksAboutSitting('Have I been sitting too long?'), true);
  assert.equal(asksAboutSitting('晚上吃什么'), false);
  const r = hostRig();
  for (let t = 0; t < 61 * MIN; t += 2_000) { r.host.note(sig({ energy: 0.3 })); r.s.now += 2_000; }
  assert.equal(r.host.chatTurn('晚上吃什么'), '', 'not asked: no report');
  assert.match(r.host.chatTurn('我今天坐了多久？'), /连续坐了约 6\d 分钟/u);
  const fact = r.host.moment();
  assert.equal(fact?.kind, 'sitting');
  assert.match(momentPromptLine(fact!), /^摄像头本机看到：用户已经连续坐了约 6\d 分钟没起身。（今天一共坐了约 6\d 分钟，起身过 0 次。）$/u);
  assert.equal(r.host.moment(), null, 'taken');
  r.host.sensing(false);
  assert.equal(r.host.moment(), null, 'sensing off: nothing');
  assert.equal(r.host.chatTurn('我今天坐了多久？'), '', 'forgotten');
});

test('pose facts are information only: closed lines, no suggestion, no reaction wording', () => {
  const lines = [
    momentPromptLine({ kind: 'posture', facts: { posture: 'slumped', minutes: 22 } }),
    momentPromptLine({ kind: 'posture', facts: { posture: 'close', minutes: 6 } }),
    momentPromptLine({ kind: 'staring', facts: { minutes: 41 } }),
    momentPromptLine({ kind: 'staring-away', facts: { minutes: 41, awaySeconds: 25 } }),
    momentPromptLine({ kind: 'sitting', facts: { minutes: 95, todayMinutes: 300, standUps: 3 } }),
  ];
  for (const line of lines) {
    assert.match(line, /^摄像头本机看到：/u);
    assert.doesNotMatch(line, /提醒|建议|应该|记得|休息一下|站起来走走|你可以|要不要|夸|真棒/u, line);
  }
  assert.ok((['posture', 'staring', 'staring-away', 'sitting'] as const).every(kind => (MOMENT_KINDS as readonly string[]).includes(kind)));
});

test('the pose-use journal line: closed words and seconds only; the renderer fact is exact', () => {
  const entry = buildJournalEntry({ type: 'pose-use', characterId: 'gene', use: 'read-pause', event: 'resumed', seconds: 12 }, 1000);
  assert.ok(entry);
  const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));
  assert.match(describeJournalEntry(entry!, plain), /本机姿势：你转开或走开时她的朗读（你转回来，接着念，约 12 秒）/u);
  assert.equal('text' in (buildJournalEntry({ type: 'pose-use', characterId: 'gene', use: 'read-pause', event: 'resumed', text: '你好' }, 1000) ?? {}), false, 'rebuilt from closed fields only');
  assert.equal(buildJournalEntry({ type: 'pose-use', characterId: 'gene', use: 'read-pause', event: 'waved' }, 1000), null);
  assert.equal(parsePoseUseFact({ use: 'nod', event: 'nod', picture: 'x' }), null);
  assert.equal(parsePoseUseFact({ use: 'read-pause', event: 'paused', seconds: -1 }), null);
  const r = hostRig();
  assert.equal(r.host.fact({ use: 'read-pause', event: 'ended', seconds: 90 }), true);
  assert.equal(r.host.fact({ use: 'two-people', event: 'told' }), false, 'a window cannot claim the host\'s own uses');
  assert.match(r.host.chatTurn('嗯？'), /念到一半时.*没有念出来/u);
  assert.equal(r.host.chatTurn('嗯？'), '');
});

// ---------------------------------------------------------------- the signal's people count

test('people: confident, separate boxes only; the signal says the lowest of the last three detections', () => {
  const box = (x1: number, score = 0.9, w = 200) => ({ x1, y1: 50, x2: x1 + w, y2: 450, score });
  assert.equal(countPeople([box(10), box(400)], 640, 480), 2);
  assert.equal(countPeople([box(10), box(20)], 640, 480), 1, 'the same person twice');
  assert.equal(countPeople([box(10), box(400, 0.35)], 640, 480), 1, 'not confident');
  assert.equal(countPeople([box(10), box(400, 0.9, 10)], 640, 480), 1, 'too small');
  const tracker = new PoseFeatureTracker();
  const scores = new Float32Array(17).fill(0.9), kpts = new Float32Array(34);
  for (let i = 0; i < 17; i++) { kpts[i * 2] = 300 + (i % 3) * 10; kpts[i * 2 + 1] = 100 + i * 15; }
  let t = 1000;
  const push = (people?: number) => { tracker.push({ t, detected: true, detScore: 0.9, kpts, scores, width: 640, height: 480, ...(people !== undefined ? { people } : {}) }); t += 200; };
  push(1); push(2); push(); push(2);
  assert.equal(tracker.signal().people, 1, 'one of the last three said one');
  push(2);
  assert.equal(tracker.signal().people, 2);
  const parsed = parsePoseSignal(tracker.signal());
  assert.equal(parsed?.people, 2);
  const { people: _people, ...older } = tracker.signal();
  assert.equal(parsePoseSignal(older)?.people, 0, 'a signal without the count reads as 0');
  assert.equal(parsePoseSignal({ ...tracker.signal(), people: 7 }), null);
});
