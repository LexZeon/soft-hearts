// 2026-11-24 (再续, docs/claude/2026-11-24-watch-turns-off.md): 「和她一起看」 still turned itself off, and almost every row in the journal said
// "user". Two paths wrote down a window step as the user's hand: (1) the companion page stopped the computer's sound whenever the PAGE was hidden
// (Unbound holds her window hidden while she is out; a window covered by a full-screen video is hidden to the page too), and the host noted any
// OFF intent as the user's; (2) Unbound's way back puts the switches as they were (screen off, sound off) through the user's own switch paths.
// Only the user's hand counts as 'user' now.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { beforeEach, test } from 'node:test';
import ts from 'typescript';
import { MediaRuntime } from '../electron/senses/media-runtime';
import { WatchOffDetector, asNotUsers, clearWatchOffCause, offAsNotUsers, offCauseOfIntent, noteWatchOffCause, onWatchUserOff } from '../electron/senses/watch-off-notice';
import { buildJournalEntry } from '../shared/memory/journal';
import { WATCH_OFF_WHYS, type WatchOffWhy } from '../shared/senses';

const OWNER = 'pet' as const; // no-pet-ok: the media owner id of the companion window
beforeEach(() => clearWatchOffCause());

function rig() {
  const media = new MediaRuntime();
  let clock = 1_000_000;
  const rows: WatchOffWhy[] = [];
  const detector = new WatchOffDetector({ on: () => media.state.screenSharing, ended: why => rows.push(why), now: () => clock });
  media.update({ screenSharing: true }, OWNER); detector.tick();
  return { media, rows, tick: () => { clock += 1000; detector.tick(); } };
}

test('an off intent for the computer\'s sound is the user\'s only while she is on the screen', () => {
  assert.equal(offCauseOfIntent({ enabled: false, source: 'system-audio' }, true), 'user');
  assert.equal(offCauseOfIntent({ enabled: false, source: 'system-audio' }, false), 'window-hidden', 'her page stopping the capture because the window left is not a hand');
});

test('an intent that is not an off of the computer\'s sound says nothing about 一起看', () => {
  assert.equal(offCauseOfIntent({ enabled: false, source: 'microphone' }, true), null, 'the microphone\'s cells never end 一起看 (the voice turns switch them all the time)');
  assert.equal(offCauseOfIntent({ enabled: true, source: 'system-audio' }, true), null);
});

test('Unbound\'s way back: the screen it puts back off is written as that, and the user-off listeners are not told', async () => {
  const { media, rows, tick } = rig();
  let heard = 0; const stop = onWatchUserOff(() => { heard++; });
  const switches = { async set(_kind: string, enabled: boolean) { media.update({ screenSharing: enabled }, OWNER); }, read: () => 'x' };
  await offAsNotUsers(switches, 'unbound-exit')!.set('screen', false);
  tick(); stop();
  assert.deepEqual(rows, ['unbound-exit']);
  assert.equal(heard, 0, 'the user did not turn anything off, so a pause waiting to resume is not cancelled');
});

test('switching ON through the same wrapper is untouched, and the scope ends with the step (the next user off is "user")', async () => {
  const { media, rows, tick } = rig();
  const calls: Array<[string, boolean]> = [];
  const switches = { async set(kind: string, enabled: boolean) { calls.push([kind, enabled]); media.update({ screenSharing: enabled }, OWNER); } };
  const wrapped = offAsNotUsers(switches, 'unbound-exit')!;
  await wrapped.set('screen', true);
  assert.deepEqual(calls, [['screen', true]]);
  await wrapped.set('screen', false); tick();
  media.update({ screenSharing: true }, OWNER); tick();
  media.update({ screenSharing: false }, OWNER); tick(); // the user's click, after the step
  assert.deepEqual(rows, ['unbound-exit', 'user']);
});

test('a step that throws still ends its scope', async () => {
  await assert.rejects(asNotUsers('unbound-exit', async () => { throw new Error('x'); }));
  const { media, rows, tick } = rig();
  media.update({ screenSharing: false }, OWNER); tick();
  assert.deepEqual(rows, ['user']);
});

test('only the user\'s hand is "user": her window going and a reset are their own words, another window going ends nothing', () => {
  const cases: Array<[string, (m: MediaRuntime) => void, WatchOffWhy[]]> = [
    ['the user switches the screen off', m => { m.update({ screenSharing: false }, OWNER); }, ['user']],
    ['her window is gone', m => { m.dropOwner(OWNER); }, ['window-gone']],
    ['reset', m => { m.reset(); }, ['reset']],
    ['another window is gone', m => { m.dropOwner('controls'); }, []],
  ];
  for (const [name, act, want] of cases) {
    const { media, rows, tick } = rig();
    act(media); tick();
    assert.deepEqual(rows, want, name);
  }
});

test('the page being hidden stops the reading only when the host says the window is off the screen', async () => {
  const source = await readFile(new URL('../src/voice/AudioReadingClient.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('AudioReadingClient.ts', source, ts.ScriptTarget.Latest, true);
  const klass = tree.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'AudioReadingClient') as ts.ClassDeclaration;
  const method = klass.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(tree) === 'documentHidden')!;
  assert.ok(method, 'the page-hidden step is its own method');
  const script = ts.transpile(`class Client { ${method.getText(tree)} }; globalThis.Client = Client;`, { target: ts.ScriptTarget.ES2022 });
  const context = vm.createContext({}); vm.runInContext(script, context);
  const client = new context.Client(); let stops = 0; client.stop = async () => { stops++; };
  await client.documentHidden(true); // Unbound holds her window hidden while she is out; a covered window is hidden to the page too
  assert.equal(stops, 0, 'before the fix the page-hidden step stopped every reading, and 一起看 ended at each of those moments');
  await client.documentHidden(false);
  assert.equal(stops, 1);
});

test('the journal accepts the new word', () => {
  assert.ok((WATCH_OFF_WHYS as readonly string[]).includes('unbound-exit'));
  const line = buildJournalEntry({ type: 'watch-off', characterId: 'gene', why: 'unbound-exit' }, 1_000);
  assert.ok(line && (line as { why?: string }).why === 'unbound-exit');
});
