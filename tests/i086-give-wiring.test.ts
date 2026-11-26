/**
 * I-086 wiring: the opening choice gives a speech cue to "递给你点东西" (same cue, same quota); the inner loop asks for her own line
 * (focus 'give') and only a shown, committed line starts the stage; her folder gets the list as a text file and her picture as a
 * new PNG through its own checks; the companion window's overlay starts the stage, answers once, and never starts while blocked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProactiveSpeechGate } from '../electron/initiative/proactive-speech-gate';
import { InnerLoop, type InnerLoopDependencies, type InnerLoopMessage } from '../electron/initiative/inner-loop/inner-loop';
import { OpeningHost } from '../electron/brain/opening-host';
import { FixedOpeningChoice } from '../shared/behaviors/opening-choice/fake';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot, type MoodCue } from '../shared/foundation/mood';
import type { InnerLoopQuiet } from '../shared/initiative/inner-loop';
import type { MoodView } from '../shared/mood/mood-runtime';
import { HerFolderHost } from '../electron/initiative/her-folder/host';
import { GiveOverlay } from '../src/initiative/GiveOverlay';
import type { GiveAnswer, GiveEvent } from '../shared/behaviors/give/interface';
import type { GiveStageCue, GiveStageOutcome } from '../src/initiative/give-performance';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const awake: InnerLoopQuiet = { asleep: false, drowsy: false, night: false, quiet: false };
const temps: string[] = [];
test.after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'sh-i086w-')); temps.push(dir); return dir; };

function loopRig(answer: string, give: InnerLoopDependencies['give'] | undefined) {
  const state = { now: 1_000_000 };
  const gate = new ProactiveSpeechGate(() => state.now); gate.setScope('scope');
  const log = { released: [] as string[], offered: [] as InnerLoopMessage[], focus: [] as unknown[] };
  const loop = new InnerLoop({
    gate, clock: () => state.now, enabled: () => true, canStart: () => true, current: () => true,
    scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS, quiet: () => awake,
    prompt: (_claim, _allow, _quiet, _life, _play, focus) => { log.focus.push(focus); return 'prompt'; },
    decide: async () => ({ text: answer }), realize: () => {}, releaseSpeech: claim => { log.released.push(claim.id); },
    offer: message => { log.offered.push(message); }, present: async () => true, presentationCurrent: () => true, archive: async () => {},
    ...(give ? { give } : {}),
  });
  const cue = (id: string): MoodCue => ({ id, kind: 'speech', at: state.now, until: state.now + 3_000 } as MoodCue);
  return { loop, gate, log, cue, dispose: () => { loop.dispose(); gate.dispose(); } };
}

test('inner loop, focus give: refused without the host; her line first, the stage only once it is shown; none → nothing, quota back', async () => {
  const none = loopRig('{"action":"speak","text":"给你。"}', undefined);
  assert.equal(none.loop.offerOpportunity(none.cue('g0'), 'give'), false, 'no give host: the focus is refused');
  none.dispose();
  const delivered: [string, string][] = [];
  const r = loopRig('{"action":"speak","text":"给你，吃一口。"}', { delivered: (claim, text) => { delivered.push([claim.id, text]); } });
  assert.equal(r.loop.offerOpportunity(r.cue('g1'), 'give'), true);
  await flush();
  assert.deepEqual(r.log.focus, ['give']);
  assert.equal(r.log.offered.length, 1);
  assert.equal(delivered.length, 0, 'not before the line is shown');
  assert.equal(await r.loop.ack('g1'), true);
  assert.deepEqual(delivered, [['g1', '给你，吃一口。']]);
  r.dispose();
  const quiet = loopRig('{"action":"none"}', { delivered: (claim, text) => { delivered.push([claim.id, text]); } });
  assert.equal(quiet.loop.offerOpportunity(quiet.cue('g2'), 'give'), true);
  await flush();
  assert.equal(delivered.length, 1, 'she chose not to: nothing is handed over');
  assert.deepEqual(quiet.log.released, ['g2'], 'the quota goes back');
  quiet.dispose();
});

const REST = getMoodSnapshot(createMoodState(1_000), 1_000);
const VIEW = { characterId: 'gene', snapshot: REST, parameters: DEFAULT_MOOD_PARAMETERS } as Pick<MoodView, 'characterId' | 'snapshot' | 'parameters'>;
function fakeLoop(quiet = awake) {
  const calls: string[] = [];
  return { calls, offerOpportunity: (cue: unknown, focus?: string) => { calls.push(`${(cue as MoodCue).id}:${focus ?? '-'}`); return true; },
    canTake: () => true, claims: () => false, asleep: () => false, silence: () => true, restReminderDue: () => false, quietNow: () => ({ ...quiet }) };
}
let serial = 0;
const speech = (): MoodCue => ({ id: `gcue-${++serial}`, kind: 'speech', at: 10_000, until: 13_000 } as MoodCue);

test('opening choice: "递给你点东西" is there only when the host would hand something over and it is not her quiet time; chosen, the inner loop takes the cue', () => {
  const loop = fakeLoop(), chooser = new FixedOpeningChoice(['give', 'quiet']);
  let peek: { leans: { text: string; factor: number }[] } | null = { leans: [{ text: '亲近感高（O）', factor: 1.4 }] };
  const host = new OpeningHost({ loop, chooser, innerOn: () => true, developerMode: () => false, clock: () => 10_500, releaseSpeech: () => {}, give: { peek: () => peek } });
  assert.equal(host.claim(speech(), {}, VIEW), 'inner');
  assert.equal(chooser.asked[0].now.available.give, true);
  assert.deepEqual(chooser.asked[0].now.leans?.give, [{ text: '亲近感高（O）', factor: 1.4 }], 'the hormone reasons reach the choice');
  assert.match(loop.calls[0], /:give$/u);
  peek = null;
  assert.equal(host.claim(speech(), {}, VIEW), 'quiet', 'nothing to hand over: not a candidate');
  assert.equal(chooser.asked[1].now.available.give, undefined);
  const night = fakeLoop({ asleep: false, drowsy: false, night: true, quiet: true });
  peek = { leans: [] };
  const nightHost = new OpeningHost({ loop: night, chooser: new FixedOpeningChoice(['give', 'quiet']), innerOn: () => true, developerMode: () => false, clock: () => 10_500,
    releaseSpeech: () => {}, give: { peek: () => peek } });
  assert.equal(nightHost.claim(speech(), {}, VIEW), 'quiet', 'her quiet hours: never');
  const without = new OpeningHost({ loop: fakeLoop(), chooser: new FixedOpeningChoice(['give', 'quiet']), innerOn: () => true, developerMode: () => false, clock: () => 10_500, releaseSpeech: () => {} });
  assert.equal(without.claim(speech(), {}, VIEW), 'quiet', 'no give host: exactly as before');
});

async function folderHost() {
  const profile = temp(), parent = temp(), folder = path.join(parent, 'her');
  mkdirSync(folder);
  const host = new HerFolderHost({ profileDirectory: () => profile, pickFolder: async () => folder, openPath: async () => '', broadcast: () => {}, sendNote: () => {} });
  await host.load();
  await host.choose();
  return { host, folder };
}
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1]);

test('her folder: the list file is created, replaced while it is hers, left alone once you changed it; a picture is a new PNG, never a replacement', async () => {
  const { host, folder } = await folderHost();
  assert.deepEqual(await host.syncText(null, '我们的小东西.md', 'x'), { ok: false, why: 'stale' }, 'no ticket: nothing');
  const first = await host.syncText(host.beginKeepsake(), '我们的小东西.md', '# 我们的小东西\n- 一\n');
  assert.equal(first.ok, true);
  assert.equal(readFileSync(path.join(folder, '我们的小东西.md'), 'utf8'), '# 我们的小东西\n- 一\n');
  assert.equal((await host.syncText(host.beginKeepsake(), '我们的小东西.md', '# 我们的小东西\n- 一\n- 二\n')).ok, true, 'hers: replaced');
  writeFileSync(path.join(folder, '我们的小东西.md'), '我自己加了一句');
  assert.deepEqual(await host.syncText(host.beginKeepsake(), '我们的小东西.md', '# 新的\n'), { ok: false, why: 'stale' });
  assert.equal(readFileSync(path.join(folder, '我们的小东西.md'), 'utf8'), '我自己加了一句', 'your edit stays');
  assert.equal((await host.syncText(host.beginKeepsake(), '../出去.md', 'x')).ok, false, 'the name check holds');
  const picture = await host.keepPicture(host.beginKeepsake(), '她给你的图 2026-11-11', PNG);
  assert.deepEqual(picture, { ok: true, name: '她给你的图 2026-11-11.png', bytes: PNG.length });
  const again = await host.keepPicture(host.beginKeepsake(), '她给你的图 2026-11-11', PNG);
  assert.equal(again.ok && again.name, '她给你的图 2026-11-11（2）.png', 'a taken name gets a number; nothing is replaced');
  assert.equal((await host.keepPicture(host.beginKeepsake(), 'x', new TextEncoder().encode('not a png at all'))).ok, false);
  assert.equal((await host.keepPicture(host.beginKeepsake(), 'big', Uint8Array.from([...PNG, ...new Uint8Array(210 * 1024)]))).ok, false, 'the folder’s size cap');
  assert.equal((await host.keepPicture(host.beginKeepsake(), '..\\x', PNG)).ok, false, 'the stem goes through the name check');
  const ticket = host.beginKeepsake();
  await host.turnOff();
  assert.deepEqual(await host.keepPicture(ticket, 'late', PNG), { ok: false, why: 'stale' }, 'switched off since: nothing');
  assert.equal(existsSync(path.join(folder, 'late.png')), false);
});

// ---------------------------------------------------------------- the companion window's overlay (fake DOM)

class FakeElement {
  className = ''; hidden = false; textContent = ''; type = ''; title = ''; src = ''; alt = '';
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; children: FakeElement[] = []; attributes: Record<string, string> = {};
  onclick: (() => void) | null = null;
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
}
test('pet overlay: an offer starts the stage, a click takes it, the outcome is answered once; blocked → interrupted and nothing starts; the card shows', async () => {
  const answers: GiveAnswer[] = [], started: GiveStageCue[] = [], pictures: string[] = [];
  let listener: ((event: GiveEvent) => void) | null = null, outcome: ((id: string, o: GiveStageOutcome) => void) | null = null, taken = 0, withdrawn = 0, blocked = false;
  const frames: (() => void)[] = [];
  let anchor: { x: number; y: number; r: number } | null = null, now = 0;
  const parent = new FakeElement();
  const overlay = new GiveOverlay(parent as unknown as HTMLElement, {
    onGive: callback => { listener = callback; return () => { listener = null; }; },
    giveAnswer: async answer => { answers.push(answer); return true; }, givePicture: async input => { pictures.push(input.id); return true; }, saveGivePicture: async () => true,
  }, {
    startGive: (cue, onOutcome) => { started.push(cue); outcome = onOutcome ?? null; }, takeGive: () => { taken++; outcome?.(started.at(-1)!.id, 'taken'); return true; },
    withdrawGive: () => { withdrawn++; }, giveAnchor: () => anchor, captureGivePicture: () => 'data:image/png;base64,AAAA',
  }, { blocked: () => blocked, now: () => now, frame: callback => { frames.push(callback); return frames.length; }, cancelFrame: () => {}, document: { createElement: () => new FakeElement() as unknown as HTMLElement } });
  overlay.init();
  const offer: GiveEvent = { type: 'offer', id: 'give-1', item: 'snack', stage: 'hand', prop: 'snack', playful: false, picture: null, waitMs: 15000, capture: true };
  listener!(offer);
  assert.equal(started.length, 1);
  const target = parent.children[0];
  frames.shift()!();
  assert.equal(target.hidden, true, 'not out yet: no target');
  anchor = { x: 100, y: 200, r: 30 }; now = 100;
  frames.shift()!();
  assert.equal(target.style.outline, 'none', 'no focus ring around the target (2026-11-21)');
  assert.equal(target.title, '', 'no hover tooltip on the invisible target (2026-11-22)');
  assert.equal(target.hidden, false); assert.equal(target.style.left, '70px'); assert.equal(target.dataset.moodUi, 'true', 'a pet control area, never a pat');
  now = 900; frames.shift()!();
  assert.deepEqual(pictures, ['give-1'], 'her picture, once, after it settled in her hand');
  now = 1500; frames.shift()!();
  assert.deepEqual(pictures, ['give-1']);
  target.onclick!();
  await flush();
  assert.equal(taken, 1); assert.deepEqual(answers, [{ id: 'give-1', outcome: 'taken' }]);
  blocked = true;
  listener!({ ...offer, id: 'give-2' });
  await flush();
  assert.equal(started.length, 1, 'blocked (a pat, hidden): the stage does not start');
  assert.deepEqual(answers.at(-1), { id: 'give-2', outcome: 'interrupted' });
  listener!({ type: 'card', id: 'pic-1', line: '给你留一张。', picture: 'data:image/png;base64,AAAA' });
  const card = parent.children[1];
  assert.equal(card.hidden, false); assert.equal(card.children[1].textContent, '给你留一张。');
  overlay.dispose();
});
