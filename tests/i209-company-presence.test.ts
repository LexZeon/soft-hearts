// I-209 step 1: who is on the full-screen stage; step 3:
// who is on stage goes out through `present` (the brain seats them, the stage coordinator brings each one out as her own full screen).
// shared/unbound/company/presence.ts (the choice) and electron/unbound/company/host.ts through the real UnboundHost with fake windows:
// the default is nobody else, the panel adds and removes, never the one you talk with, at most three, the guard sends the last one back
// and says so, a switch of who you talk with keeps the same people, and nothing crosses outside the window she is shown in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanyChoice, COMPANY_MAX_PRESENT, UNBOUND_COMPANY_REQUESTS, type CompanyCard } from '../shared/unbound/company';
import { UnboundHost, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import { unboundSource } from '../electron/unbound/source';
import { companyPorts } from '../electron/unbound/company/ports';
import { UNBOUND_EVENTS, UNBOUND_REQUESTS } from '../shared/unbound/scene';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { Rect } from '../shared/unbound/world';

const CARDS: CompanyCard[] = [
  { id: 'gene', name: 'Gene', hasModel: true }, { id: 'vrm-a', name: 'A', hasModel: true }, { id: 'pmx-b', name: 'B', hasModel: true },
  { id: 'c-none', name: 'C', hasModel: false }, { id: 'pmx-d', name: 'D', hasModel: true },
];
const notice = (name: string, cap: number) => `${name}:${cap}`;

test('default: only the one you talk with; the panel adds and removes others, never her, never a card without a model, at most three', () => {
  const choice = new CompanyChoice();
  assert.deepEqual(choice.extrasFor('gene', CARDS), [], 'a user who never opens the panel sees exactly what they saw before');
  const look = choice.look('gene', CARDS, true);
  assert.equal(look.entries[0]!.id, 'gene'); assert.equal(look.entries[0]!.current, true); assert.equal(look.entries[0]!.present, true);
  assert.equal(choice.set('gene', false, 'gene', CARDS), false, 'the one you talk with cannot be sent back');
  assert.equal(choice.set('c-none', true, 'gene', CARDS), false, 'no model: nothing to show');
  assert.equal(look.entries.find(e => e.id === 'c-none')!.block, 'no-model');
  assert.equal(choice.set('vrm-a', true, 'gene', CARDS), true);
  assert.equal(choice.set('pmx-b', true, 'gene', CARDS), true);
  assert.deepEqual(choice.extrasFor('gene', CARDS), ['vrm-a', 'pmx-b']);
  assert.equal(1 + choice.extrasFor('gene', CARDS).length, COMPANY_MAX_PRESENT);
  assert.equal(choice.set('pmx-d', true, 'gene', CARDS), false, 'three on stage already');
  assert.equal(choice.look('gene', CARDS, true).entries.find(e => e.id === 'pmx-d')!.block, 'full');
  assert.equal(choice.set('vrm-a', false, 'gene', CARDS), true);
  assert.deepEqual(choice.extrasFor('gene', CARDS), ['pmx-b']);
  assert.equal(choice.set('../x', true, 'gene', [...CARDS, { id: '../x', name: 'x', hasModel: true }]), false, 'only card ids');
});

test('switching who you talk with keeps the same people on stage', () => {
  const choice = new CompanyChoice();
  choice.set('vrm-a', true, 'gene', CARDS);
  choice.switched('gene', 'vrm-a'); // you now talk with A: Gene takes her place as an extra
  assert.deepEqual(choice.extrasFor('vrm-a', CARDS), ['gene']);
  choice.switched('vrm-a', 'pmx-d'); // D was not on stage: the extras stay, A goes back as a switch always did
  assert.deepEqual(choice.extrasFor('pmx-d', CARDS), ['gene']);
});

test('the guard sends the last one added back, lowers the cap and words it; an old report does nothing; a new entry measures again', () => {
  const choice = new CompanyChoice();
  choice.set('vrm-a', true, 'gene', CARDS); choice.set('pmx-b', true, 'gene', CARDS);
  assert.equal(choice.drop(2, 'gene', CARDS, notice), null, 'a report from before B came: nothing');
  assert.equal(choice.drop(3, 'gene', CARDS, notice), 'pmx-b');
  assert.equal(choice.cap, 2); assert.equal(choice.notice, 'B:2');
  assert.deepEqual(choice.extrasFor('gene', CARDS), ['vrm-a']);
  assert.equal(choice.set('pmx-d', true, 'gene', CARDS), false, 'the lower cap holds this entry');
  assert.equal(choice.look('gene', CARDS, true).entries.find(e => e.id === 'pmx-d')!.block, 'cap');
  choice.entered();
  assert.equal(choice.cap, COMPANY_MAX_PRESENT); assert.equal(choice.notice, null);
  assert.deepEqual(choice.extrasFor('gene', CARDS), ['vrm-a'], 'who was sent back stays back');
});

// ---- through the real host -------------------------------------------------------------------------------------------------------

class FakeWindow implements UnboundWindowLike {
  readonly frame = {};
  visible = false; destroyed = false;
  readonly sent: { channel: string; value: unknown }[] = [];
  private gone: (() => void)[] = [];
  static ids = 77;
  readonly webContents = { id: FakeWindow.ids++, mainFrame: this.frame, send: (channel: string, value: unknown) => { this.sent.push({ channel, value }); }, isDestroyed: () => this.destroyed };
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.destroyed; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents() {}
  setBounds() {}
  onGone(callback: () => void) { this.gone.push(callback); }
  event(): UnboundIpcEvent { return { sender: { id: this.webContents.id, mainFrame: this.frame }, senderFrame: this.frame }; }
}
const flush = async () => { for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve)); };

function companyWorld() {
  const handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>();
  const windows: FakeWindow[] = [];
  const small = { visible: true, isDestroyed: () => false, isVisible() { return this.visible; }, isMinimized: () => false, getBounds: (): Rect => ({ x: 0, y: 0, width: 300, height: 400 }), setBounds: () => {}, hide() { this.visible = false; }, show() { this.visible = true; }, showInactive() { this.visible = true; } };
  const cardState = { active: 'gene', cards: [{ id: 'gene', name: 'Gene' }, { id: 'vrm-a', name: 'A', modelPath: 'C:\\m\\a.vrm' }, { id: 'pmx-b', name: 'B', modelPath: 'C:\\m\\b.pmx' }, { id: 'c-none', name: 'C' }] as { id: string; name: string; modelPath?: string }[] };
  const registered: string[] = [], notices: string[] = [], present: string[][] = [];
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\models\\gene.pmx', url: 'mmd-asset://t/gene.pmx', name: 'gene.pmx' } };
  const host = new UnboundHost({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); }, removeHandler: channel => { handlers.delete(channel); } },
    // no-pet-ok: UnboundHostPorts names (her small window)
    pet: () => small as never, petWanted: () => true, developerMode: () => false, source: () => unboundSource(settings, null), reviewed: async () => true,
    display: () => ({ bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true }),
    measure: async () => null, openWindow: () => { const win = new FakeWindow(); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    restored: () => {}, publish: () => {},
    company: companyPorts(() => ({
      cards: { modelCards: () => cardState.cards, presetGeneId: async () => 'gene', publicState: () => ({ activeId: cardState.active }) },
      models: { bundledModel: async () => ({ url: 'mmd-asset://bundled/gene.pmx' }), register: async file => { registered.push(file); return { url: `mmd-asset://tok/${encodeURIComponent(file.split('\\').pop()!)}` }; } },
    }), ids => { present.push([...ids]); }),
  });
  const notice = host.notice.bind(host);
  host.notice = (text: string) => { notices.push(text); notice(text); };
  const call = async (channel: string, win: FakeWindow, ...args: unknown[]) => handlers.get(channel)!(win.event(), ...args);
  const enter = async () => {
    host.enter(); await flush();
    const win = windows.at(-1)!;
    await call(UNBOUND_REQUESTS.ready, win, { ok: true, modelHeightM: 1.6 }); await flush();
    assert.equal(host.state, 'unbound');
    return win;
  };
  return { host, windows, handlers, call, enter, cardState, registered, notices, present, flush };
}

test('host: nobody else by default; the panel brings one out (her model registered, no path told), who is on stage goes out only while she is out', async () => {
  const w = companyWorld();
  await w.host.company.set('vrm-a', true); await w.flush();
  assert.deepEqual(w.present, [], 'nothing is told while she is not out');
  const win = await w.enter();
  assert.deepEqual(w.present.at(-1), ['vrm-a'], 'once she is out, the one chosen before comes out too');
  await w.host.company.set('vrm-a', false); await w.flush();
  assert.deepEqual(w.present.at(-1), []);
  const scenes = () => win.sent.filter(m => m.channel === UNBOUND_EVENTS.scene).length, scenesBefore = scenes();
  let look = await w.host.company.look();
  assert.deepEqual(look.entries.map(e => [e.id, e.present, e.current, e.talking, e.block]), [['gene', true, true, true, null], ['vrm-a', false, false, false, null], ['pmx-b', false, false, false, null], ['c-none', false, false, false, 'no-model']]);
  look = await w.host.company.set('vrm-a', true); await w.flush();
  assert.equal(look.entries.find(e => e.id === 'vrm-a')!.present, true);
  assert.deepEqual(w.present.at(-1), ['vrm-a']);
  assert.deepEqual(w.registered, ['C:\\m\\a.vrm'], 'her model registered by the host (the page only ever gets its asset URL)');
  assert.equal(scenes(), scenesBefore, 'a change of company never sends a scene (a scene places the first one again)');
  assert.equal((await w.host.company.set('gene', false)).entries[0]!.present, true, 'the first one stays');
  await w.host.company.set('pmx-b', true); await w.flush();
  assert.deepEqual(w.present.at(-1), ['vrm-a', 'pmx-b']);
  w.host.exit(); await w.flush();
  assert.deepEqual(w.present.at(-1), [], 'she went back: everyone else goes too');
  w.host.quit();
});

test('host: the guard\'s verdict sends the last one back, says so beside her and in the panel; a switch keeps the same people', async () => {
  const w = companyWorld();
  const win = await w.enter();
  await w.host.company.set('vrm-a', true); await w.host.company.set('pmx-b', true); await w.flush();
  await w.call(UNBOUND_COMPANY_REQUESTS.guard, win, { present: 3, p95Ms: 31.2, budgetMs: 20.8 }); await w.flush();
  assert.deepEqual(w.present.at(-1), ['vrm-a']);
  const look = await w.host.company.look();
  assert.equal(look.cap, 2);
  assert.match(look.notice ?? '', /B/);
  assert.equal(w.notices.length, 1, 'one line beside her');
  await w.call(UNBOUND_COMPANY_REQUESTS.guard, win, { present: 1, p95Ms: 31.2, budgetMs: 20.8 }); await w.flush(); // malformed (alone): ignored
  assert.deepEqual(w.present.at(-1), ['vrm-a']);
  const other = new FakeWindow();
  await assert.rejects(Promise.resolve().then(() => w.handlers.get(UNBOUND_COMPANY_REQUESTS.guard)!(other.event(), { present: 2, p95Ms: 40, budgetMs: 20.8 })), /未授权/, 'another window is refused');
  w.cardState.active = 'vrm-a'; w.host.refresh(); await w.flush(); // you switch to A: Gene stays on stage as another one
  assert.deepEqual(w.present.at(-1), ['gene']);
  w.host.quit();
});

test('host: no company port (an older wiring): nothing changes, nobody else is told', async () => {
  const w = companyWorld();
  (w.host as unknown as { ports: { company?: unknown } }).ports.company = undefined;
  await w.enter();
  assert.deepEqual(w.present, []);
  assert.deepEqual((await w.host.company.look()).entries, []);
  w.host.quit();
  assert.equal(w.handlers.has(UNBOUND_COMPANY_REQUESTS.guard), false, 'quit removes the company handlers too');
});

test('the panel rows say who your words go to (the one you clicked last), and only someone on stage can be that', () => {
  const choice = new CompanyChoice();
  choice.set('vrm-a', true, 'gene', CARDS);
  const talking = (to: string | null) => choice.look('gene', CARDS, true, to).entries.filter(e => e.talking).map(e => e.id);
  assert.deepEqual(talking(null), ['gene']);
  assert.deepEqual(talking('vrm-a'), ['vrm-a']);
  assert.deepEqual(talking('pmx-b'), ['gene'], 'not on stage: your words go to the first one');
});

test('the panel: 「谁在场」 lists the one you talk with first (no button), brings one out and sends her back; the guard\'s line shows', async t => {
  const { installPetWindow } = await import('./helpers/pet-window-dom'); // no-pet-ok: the existing helper's name
  const { createSourceChoices, DeviceSources } = await import('../shared/senses');
  const { localCallDeviceStorage } = await import('../shared/voice');
  const dom = installPetWindow(t); // no-pet-ok: the existing helper's name
  const { document } = dom;
  const root = document.createElement('section'); root.id = 'panel'; const button = document.createElement('button');
  document.body.append(button, root);
  const choice = new CompanyChoice(), sent: [string, boolean][] = [];
  const api = { senses: async () => ({ camera: true, microphone: true, screen: true, audio: true }), panel: async () => {},
    screenSourceMenu: async () => ({ choice: null, entries: [] }), chooseScreenSource: async () => ({ choice: null }),
    company: async () => choice.look('gene', CARDS, true),
    setCompany: async (id: string, on: boolean) => { sent.push([id, on]); choice.set(id, on, 'gene', CARDS); return choice.look('gene', CARDS, true); } };
  const storage = localCallDeviceStorage({ getItem: () => null, setItem() {} });
  const { SensesPanel } = await import('../src/unbound/input-senses');
  const panel = new SensesPanel(document as unknown as Document, root as unknown as HTMLElement, button as unknown as HTMLElement, api,
    createSourceChoices(api, new DeviceSources({ enumerate: async () => [], storage, watch: () => () => {}, deviceChange: () => () => {} })));
  dom.beforeClose(() => panel.dispose());
  await panel.show(); await flush();
  const rows = () => root.querySelectorAll('.senses-row[data-sense="company"]') as unknown as { dataset: Record<string, string>; querySelector(s: string): { click(): void; disabled?: boolean } | null }[];
  assert.equal(rows().length, CARDS.length);
  assert.equal(rows()[0]!.dataset.id, 'gene'); assert.equal(rows()[0]!.querySelector('button'), null, 'the one you talk with has no button');
  assert.equal(rows().find(r => r.dataset.id === 'c-none')!.querySelector('button')!.disabled, true, 'no model: cannot come out');
  rows().find(r => r.dataset.id === 'vrm-a')!.querySelector('[data-action="company-add"]')!.click(); await flush();
  assert.deepEqual(sent, [['vrm-a', true]]);
  assert.equal(rows().find(r => r.dataset.id === 'vrm-a')!.dataset.present, 'true');
  rows().find(r => r.dataset.id === 'vrm-a')!.querySelector('[data-action="company-remove"]')!.click(); await flush();
  assert.deepEqual(sent, [['vrm-a', true], ['vrm-a', false]]);
  choice.set('vrm-a', true, 'gene', CARDS); choice.set('pmx-b', true, 'gene', CARDS); choice.drop(3, 'gene', CARDS, notice);
  await panel.refresh(); await flush();
  assert.equal(root.querySelector('.not-heard')?.textContent, 'B:2', 'the guard\'s line shows under the rows');
});
