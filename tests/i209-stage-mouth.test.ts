// I-209 three on stage, the mouths. The real hosts and the real stage coordinator with fake windows (tests/helpers/stage-world.ts); the
// voice's facts arrive as the control window sends them: a sentence becoming audible (the speech-face 'start' cue relaySpeechFace sends,
// key `${lineId}#${sentence}`) a moment before "speaking" turns on, and "speaking" off when the audio stops.
//  - the second one speaks: only her mouth moves, her speaking face hears her sentence;
//  - the user's case: Mumi's line held the floor and its end never counted (its "done" came after her voice had stopped), then One speaks:
//    before the fix Mumi's mouth moved with One's voice; now One's moves and Mumi's stays shut, and the floor is not left one line behind;
//  - a line never voiced (its reading failed) does not keep the next speaker's mouth;
//  - her page's mouth row is written under her own id; one character alone is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stageWorld, type StageWindow } from './helpers/stage-world';
import { MOUTH_ROW_GAP_MS } from '../electron/unbound/company/stage';
import { UNBOUND_EVENTS } from '../shared/unbound/scene';
import { UNBOUND_STAGE_REQUESTS } from '../shared/unbound/company';
import { MouthJournal } from '../src/unbound/mouth-journal';

const said = (win: StageWindow) => win.of(UNBOUND_EVENTS.speaking) as boolean[];
const faces = (win: StageWindow) => (win.of(UNBOUND_EVENTS.speechFace) as { kind: string; key?: string }[]).map(cue => cue.kind === 'stop' ? 'stop' : `${cue.kind}:${cue.key}`);
const start = (line: string, sentence = 0) => ({ kind: 'start', key: `${line}#${sentence}`, text: '……', voiced: true });
/** The control window reads one line aloud: each sentence becomes audible (its cue first, then the mouth flag), then the audio stops. */
function voice(w: ReturnType<typeof stageWorld>, line: string, sentences = 2): void {
  for (let i = 0; i < sentences; i++) {
    assert.equal(w.stage.speechFace(start(line, i)), true, 'on stage the coordinator takes her voice\'s facts');
    if (i === 0) w.host.speaking(true);
  }
  w.host.speaking(false);
}

test('three on stage, the second one speaks: only her mouth moves, and her speaking face hears her sentences', async () => {
  const w = stageWorld({ replyOwner: new Map([['r-a', 'vrm-a']]) });
  const main = await w.enter(), a = await w.bringOut('vrm-a'), b = await w.bringOut('pmx-b');
  w.host.stream({ id: 'r-a', kind: 'chat', type: 'delta', text: '我是A' });
  voice(w, 'r-a');
  assert.deepEqual(said(a), [true, false], 'her mouth opened with her voice and closed when it stopped');
  assert.deepEqual(said(main), [], 'the first one\'s mouth stays shut');
  assert.deepEqual(said(b), [], 'the third one\'s mouth stays shut');
  assert.deepEqual(faces(a), ['start:r-a#0', 'start:r-a#1'], 'her sentences reach her face');
  assert.deepEqual([...faces(main), ...faces(b)], [], 'nobody else\'s face hears them');
  w.host.exit(); w.host.quit();
});

test('the user\'s case ("刚刚one说话，确是mumi动嘴"): One speaks after Mumi; One\'s mouth moves, never Mumi\'s, line after line', async () => {
  // Mumi is pmx-b; One is the first one (gene in the rig). Her chime-in, then One's reply, then Mumi again, then One again.
  const owners = new Map([['m1', 'pmx-b'], ['o1', 'gene'], ['m2', 'pmx-b'], ['o2', 'gene']]);
  const w = stageWorld({ replyOwner: owners });
  const one = await w.enter(), gene = await w.bringOut('vrm-a'), mumi = await w.bringOut('pmx-b');
  // Mumi's line: its bubble starts (it takes the floor), her voice reads it, the voice stops BEFORE its "done" reaches the stage.
  w.host.stream({ id: 'm1', kind: 'chat', type: 'delta', text: 'Mumi 说' });
  voice(w, 'm1');
  w.host.stream({ id: 'm1', kind: 'chat', type: 'done', text: '' });
  assert.deepEqual(said(mumi), [true, false]);
  // One's reply.
  w.host.stream({ id: 'o1', kind: 'chat', type: 'delta', text: 'One 说' });
  voice(w, 'o1');
  w.host.stream({ id: 'o1', kind: 'chat', type: 'done', text: '' });
  assert.deepEqual(said(one), [true, false], 'One\'s voice moves One\'s mouth');
  assert.deepEqual(said(mumi), [true, false], 'and never Mumi\'s');
  // And again, both ways: the floor is never left one line behind.
  w.host.stream({ id: 'm2', kind: 'chat', type: 'delta', text: 'Mumi 又说' });
  voice(w, 'm2');
  assert.deepEqual(said(mumi), [true, false, true, false]);
  w.host.stream({ id: 'o2', kind: 'chat', type: 'delta', text: 'One 又说' });
  voice(w, 'o2');
  assert.deepEqual(said(one), [true, false, true, false]);
  assert.deepEqual(said(gene), [], 'Gene never spoke: her mouth never moved');
  w.host.exit(); w.host.quit();
});

test('a line that was never voiced (its reading failed) does not keep the next speaker\'s mouth', async () => {
  const w = stageWorld({ replyOwner: new Map([['r-a', 'vrm-a'], ['r-b', 'pmx-b']]) });
  const main = await w.enter(), a = await w.bringOut('vrm-a'), b = await w.bringOut('pmx-b');
  w.host.stream({ id: 'r-a', kind: 'chat', type: 'delta', text: 'A 说' }); // shown, never read aloud
  w.host.stream({ id: 'r-a', kind: 'chat', type: 'done', text: '' });
  w.host.stream({ id: 'r-b', kind: 'chat', type: 'delta', text: 'B 说' });
  voice(w, 'r-b');
  assert.deepEqual(said(b), [true, false], 'B\'s voice, B\'s mouth');
  assert.deepEqual(said(a), [], 'A never spoke aloud: her mouth never moved');
  assert.deepEqual(said(main), []);
  w.host.exit(); w.host.quit();
});

test('the mouth moves at once when the voice goes on to someone else\'s line without a pause (never two open)', async () => {
  const w = stageWorld({ replyOwner: new Map([['r-a', 'vrm-a'], ['r-b', 'pmx-b']]) });
  await w.enter(); const a = await w.bringOut('vrm-a'), b = await w.bringOut('pmx-b');
  w.stage.speechFace(start('r-a')); w.host.speaking(true);
  w.stage.speechFace(start('r-b')); // the voice is on B's line now, still sounding
  assert.deepEqual(said(a), [true, false], 'A\'s mouth closed');
  assert.deepEqual(said(b), [true], 'B\'s opened');
  w.host.speaking(false);
  assert.deepEqual(said(b), [true, false]);
  w.stage.speechFace({ kind: 'stop' });
  assert.ok([a, b].every(win => faces(win).includes('stop')), 'a stop reaches every window');
  w.host.exit(); w.host.quit();
});

test('alone on stage: her voice\'s facts go through the first host exactly as before', async () => {
  const w = stageWorld();
  const win = await w.enter();
  assert.equal(w.stage.speechFace(start('r1')), false, 'alone, the stage takes nothing (the wiring relays it to her window as before)');
  w.host.speaking(true); w.host.speaking(false);
  assert.deepEqual(said(win), [true, false]);
  w.host.exit(); w.host.quit();
});

test('her mouth row: from her own window, under her own id (the first one under her card); a stranger\'s or a flood is not taken', async () => {
  const w = stageWorld();
  let now = 0;
  (w.stage as unknown as { links: { clock: () => number } }).links.clock = () => now;
  const main = await w.enter(), a = await w.bringOut('vrm-a');
  const sentences = [{ word: 'none', peak: 0.8, floor: false, ceiling: false }];
  await w.call(UNBOUND_STAGE_REQUESTS.mouth, a, { sentences });
  await w.call(UNBOUND_STAGE_REQUESTS.mouth, a, { sentences }); // a flood: within the gap
  now += MOUTH_ROW_GAP_MS;
  await w.call(UNBOUND_STAGE_REQUESTS.mouth, main, { sentences });
  await w.call(UNBOUND_STAGE_REQUESTS.mouth, main, { sentences: [] });
  await w.call(UNBOUND_STAGE_REQUESTS.mouth, main, 'x');
  assert.deepEqual(w.mouths.map(row => row.id), ['vrm-a', 'gene'], 'each row under the one whose mouth it was');
  const stranger = { sender: { id: 99_999, mainFrame: {} }, senderFrame: {} };
  now += MOUTH_ROW_GAP_MS;
  await assert.rejects(Promise.resolve().then(() => w.handlers.get(UNBOUND_STAGE_REQUESTS.mouth)!(stranger as never, { sentences })), /未授权/);
  assert.equal(w.mouths.length, 2, 'a window not on stage writes nothing');
  w.host.exit(); w.host.quit();
});

test('her page logs her mouth while her voice moves it: one row per reply, after a quiet moment', () => {
  const rows: unknown[] = [];
  const page = new MouthJournal(async entry => { rows.push(entry); });
  const mouth = (voiced: boolean, aa: number) => ({ voiced, lastReading: { aa, floored: false, capped: false } });
  for (let i = 0; i < 30; i++) page.frame(1 / 60, mouth(true, 0.2 + i / 100), 'content');
  for (let i = 0; i < 60 * 2; i++) page.frame(1 / 60, mouth(false, 0), 'none');
  assert.equal(rows.length, 0, 'not before a quiet moment');
  for (let i = 0; i < 60 * 2; i++) page.frame(1 / 60, mouth(false, 0), 'none');
  assert.deepEqual(rows, [{ sentences: [{ word: 'content', peak: 0.49, floor: false, ceiling: false }] }]);
  for (let i = 0; i < 600; i++) page.frame(1 / 60, null, 'none');
  new MouthJournal(null).frame(1 / 60, mouth(true, 0.5), 'none'); // no window API (a preview): nothing sent, nothing thrown
  assert.equal(rows.length, 1, 'a shut mouth writes nothing');
});
