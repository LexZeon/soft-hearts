import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { fatiguePanelView, fatigueRestLine } from '../src/ui/fatigue-panel-view';
import { MoodPanel } from '../src/ui/MoodPanel';

test('missing, invalid version and later disconnection have no invented zero', () => {
  const absent = fatiguePanelView(undefined);
  assert.deepEqual(absent, { connected:false, A:null, F:null, W:null, phase:null, entryReady:null, storageError:null });
  assert.deepEqual(fatiguePanelView({ version:2, A:0 }), absent);
  assert.deepEqual(fatiguePanelView(null), absent);
});
test('frozen v1 snapshot displays bounded values without coercion or clipping', () => {
  const view = fatiguePanelView({ version:1, A:0, F:0.512, W:1, phase:'micro-awake', sleepEntryReady:false });
  assert.equal(view.A, 0); assert.equal(view.F, 51.2); assert.equal(view.W, 100);
  assert.equal(view.phase, '轻微唤醒'); assert.equal(view.entryReady, false);
  const invalid = fatiguePanelView({version:1, A:-0.01, F:NaN, W:1.01, phase:'unknown', sleepEntryReady:'true'});
  assert.equal(invalid.A,null); assert.equal(invalid.F,null); assert.equal(invalid.W,null);
  assert.equal(invalid.phase,null); assert.equal(invalid.entryReady,null);
  assert.equal(fatiguePanelView({version:1, A:'0', F:Infinity, W:null}).A,null);
});
test('mapper does not mutate snapshot or interpret card data as fatigue', () => {
  const card = Object.freeze({baseline:Object.freeze({D:55,O:50,E:50,N:48,C:45})});
  const before = JSON.stringify(card);
  assert.equal(fatiguePanelView(card).connected,false);
  assert.equal(JSON.stringify(card),before);
  const snap = Object.freeze({version:1, A:0.2, F:0.3, W:0.1, phase:'asleep', sleepEntryReady:true});
  const raw = JSON.stringify(snap); assert.equal(fatiguePanelView(snap).entryReady,true); assert.equal(JSON.stringify(snap),raw);
});

test('actual panel clears unknown meter and disables wake on explicit disconnect', () => {
  class Node {
    className = ''; textContent = ''; dataset = {}; hidden = false; disabled = false;
    value: string | number = ''; children: Node[] = [];
    setAttribute() {} addEventListener() {} append(...nodes: Node[]) { this.children.push(...nodes); } remove() {}
  }
  const original = globalThis.document;
  Object.assign(globalThis, { document: { createElement: () => new Node() } });
  try {
    const panel = new MoodPanel(new Node() as unknown as HTMLElement, { onApply() {}, onRestore() {}, onWake() {} });
    const internal = panel as unknown as { adenosine: Node; adenosineMeter: Node; fatigueSummary: Node; wakeButton: Node };
    assert.equal(internal.adenosine.textContent, '尚未接入'); assert.equal(internal.adenosineMeter.hidden, true); assert.equal(internal.wakeButton.disabled, true);
    const channels = { D:50,O:50,E:50,N:50,C:50 };
    const state = { primary:'calm', companion:null, values:channels, trend:channels, fast:{}, boredom:0, longing:0, lastInteractionAt:null, reason:'', event:null };
    const params = { baseline:channels, sensitivity:channels, weights:{playful:1,close:1,comfortable:1,cautious:1}, intensity:{expression:50,gaze:50,posture:50,playful:50,text:50}, blush:{enabled:true,intensity:50,size:50} };
    const view = { characterId:'a', revision:1, snapshot:state, parameters:params, fatigue:{version:1,A:0,F:0.4,W:0.2,phase:'asleep',sleepEntryReady:false} };
    panel.update(view as never);
    assert.equal(internal.adenosine.textContent, '0.0'); assert.equal(internal.adenosineMeter.hidden, false); assert.equal(internal.wakeButton.disabled, false);
    assert.match(internal.fatigueSummary.textContent, /活动来源尚未全部接入/);
    panel.clearFatigue();
    assert.equal(internal.adenosine.textContent, '尚未接入'); assert.equal(internal.adenosineMeter.hidden, true); assert.equal(internal.wakeButton.disabled, true);
  } finally { Object.assign(globalThis, { document: original }); }
});

test('I-022 developer line: the last time off screen counted as rest, hidden when there is none', () => {
  const note = { kind: 'closed', at: 0, awayMs: 8 * 3_600_000 + 2 * 60_000, countedMs: 8 * 3_600_000 + 2 * 60_000, exact: true, before: { A: 0.75, F: 0.69 }, after: { A: 0.03, F: 0.1 } };
  assert.equal(fatigueRestLine(note), '作息：上次关了 8 小时 2 分（准确） · 按休息算 8 小时 2 分 · 困意积累 75 → 3 · 困倦 69 → 10');
  assert.match(fatigueRestLine({ ...note, exact: false }), /上次没正常退出，估的上限/);
  assert.match(fatigueRestLine({ ...note, kind: 'paused', awayMs: 40_000, countedMs: 40_000 }), /^作息：电脑睡眠／应用停住 40 秒 · 按休息算 40 秒/);
  for (const bad of [undefined, null, {}, { ...note, kind: 'nap' }, { ...note, awayMs: -1 }, { ...note, after: { A: 2, F: 0 } }]) assert.equal(fatigueRestLine(bad), '');
  class Node {
    className = ''; textContent = ''; dataset = {}; hidden = false; disabled = false;
    value: string | number = ''; children: Node[] = [];
    setAttribute() {} addEventListener() {} append(...nodes: Node[]) { this.children.push(...nodes); } remove() {}
  }
  const original = globalThis.document;
  Object.assign(globalThis, { document: { createElement: () => new Node() } });
  try {
    const panel = new MoodPanel(new Node() as unknown as HTMLElement, { onApply() {}, onRestore() {}, onWake() {} });
    const line = (panel as unknown as { fatigueRestLine: Node }).fatigueRestLine;
    assert.equal(line.hidden, true);
    const channels = { D:50,O:50,E:50,N:50,C:50 };
    const state = { primary:'calm', companion:null, values:channels, trend:channels, fast:{}, boredom:0, longing:0, lastInteractionAt:null, reason:'', event:null };
    const params = { baseline:channels, sensitivity:channels, weights:{playful:1,close:1,comfortable:1,cautious:1}, intensity:{expression:50,gaze:50,posture:50,playful:50,text:50}, blush:{enabled:true,intensity:50,size:50} };
    const fatigue = { version:1, A:0.03, F:0.1, W:0, phase:'awake', sleepEntryReady:true };
    panel.update({ characterId:'a', revision:1, snapshot:state, parameters:params, fatigue:{ ...fatigue, rest:note } } as never);
    assert.equal(line.hidden, false); assert.match(line.textContent, /上次关了 8 小时 2 分/);
    panel.update({ characterId:'a', revision:2, snapshot:state, parameters:params, fatigue } as never);
    assert.equal(line.hidden, true, 'not in developer mode: no rest in the view, no line');
    panel.update({ characterId:'a', revision:3, snapshot:state, parameters:params, fatigue:{ ...fatigue, rest:note } } as never);
    panel.clearFatigue(); assert.equal(line.hidden, true); assert.equal(line.textContent, '');
  } finally { Object.assign(globalThis, { document: original }); }
});
