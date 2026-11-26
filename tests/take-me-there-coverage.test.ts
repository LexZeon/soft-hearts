// I-163 (new features were missing from 带我去 / 帮我打开). The guard: every page, section, switch, panel and
// developer-panel tool the app has must have a 带我去 destination or be listed as not navigable with a reason. The registries are the
// app's own: the control window's navigation, the capability list (kept complete for the control window by capability-coverage), the
// panels the wiring mounts and the developer panel's tools. A new one without an entry fails here, and the message says what to add.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES } from '../shared/settings/capabilities';
import { CONTROL_NAVIGATION, isNavigationGroup, type ControlNavigationNode } from '../src/settings/control-navigation-state';
import { TAKE_ME_THERE, TAKE_ME_THERE_IDS } from '../shared/initiative/take-me-there';
import { CAPABILITY_PLACES, CONSENT_PLACES, NOT_NAVIGABLE_LEAVES, PANEL_PLACES, takeMeThereGaps, type CoverageInput } from '../shared/initiative/take-me-there-coverage';
import { ENGLISH_UI_COPY } from '../shared/foundation/ui-copy.en';
import { TakeMeThere } from '../electron/initiative/take-me-there';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const leavesOf = (nodes: readonly ControlNavigationNode[]): string[] => nodes.flatMap(node => isNavigationGroup(node) ? leavesOf(node.children) : [node.id]);

/** The panels and tools the app mounts: classes made with `new` by the control window's wiring and the developer panel, and the mount functions of its buttons. */
const MOUNT_FILES = ['src/wiring/control-window-wiring.ts', 'src/wiring/memory-wiring.ts', 'src/wiring/senses-wiring.ts', 'src/wiring/mood-wiring.ts', 'src/mood/MoodCompanion.ts'];
const PANEL_CLASS = /\bnew ([A-Z]\w*(?:Panel|Controls|Section|Cards|Page|Tasks|Library|Toggle|Notice|Switch|History|Button|Options))\(/gu;
const MOUNT_FUNCTION = /\b(mount\w+Button)\(/gu;
function mountedPanels(sources: Record<string, string> = Object.fromEntries(MOUNT_FILES.map(file => [file, read(file)]))): string[] {
  const found = new Set<string>();
  for (const text of Object.values(sources)) {
    for (const match of text.matchAll(PANEL_CLASS)) found.add(match[1]);
    for (const match of text.matchAll(MOUNT_FUNCTION)) found.add(match[1]);
  }
  return [...found].sort();
}

const real = (): CoverageInput => ({
  leaves: leavesOf(CONTROL_NAVIGATION), capabilityIds: CAPABILITIES.map(entry => entry.id), panels: mountedPanels(), destinations: TAKE_ME_THERE,
});

test('every page, switch, panel and developer tool has a 带我去 place or a reason it has none', () => {
  assert.deepEqual(takeMeThereGaps(real()), [],
    '这些页面、开关、面板没有「带我去」的去处：在 shared/initiative/take-me-there-places.ts 加一个去处（或用已有的），再在 take-me-there-coverage.ts 登记，英文标题放进 ui-copy.take-me-there.en.ts；确实不是一页的，写明原因。');
});

test('the scans see what they should (so an empty result means something)', () => {
  const panels = mountedPanels();
  for (const name of ['VoiceprintPanel', 'ChannelGatesPanel', 'UnboundSwitch', 'MoodPanel', 'mountPhysicsLabButton', 'CodexTasks', 'MemoryPanel']) assert.ok(panels.includes(name), `the scan should find ${name}`);
  assert.ok(panels.length >= 25, `only ${panels.length} panels found`);
  assert.ok(leavesOf(CONTROL_NAVIGATION).length >= 50);
  assert.ok(CAPABILITIES.length >= 100);
});

test('the guard fails when a place is removed, and when a new page, switch or tool has no entry', () => {
  const base = real();
  // A destination taken away: the leaf only it reached, and the switches and panels pointed at it, are left out.
  for (const removed of ['voiceprint', 'physics-lab', 'developer-mode', 'user-profile', 'companion-window', 'trial-features'] as const) {
    const { [removed]: _gone, ...rest } = TAKE_ME_THERE;
    assert.ok(takeMeThereGaps({ ...base, destinations: rest }).length > 0, `removing ${removed} must be noticed`);
  }
  // Something new in each registry.
  assert.match(takeMeThereGaps({ ...base, leaves: [...base.leaves, 'a-new-page'] }).join('\n'), /a-new-page/);
  assert.match(takeMeThereGaps({ ...base, capabilityIds: [...base.capabilityIds, 'a_new_switch'] }).join('\n'), /a_new_switch/);
  assert.match(takeMeThereGaps({ ...base, panels: [...base.panels, 'AFreshPanel'] }).join('\n'), /AFreshPanel/);
  // An opt-out with no reason does not count; neither does one pointing at a place that does not exist.
  assert.ok(takeMeThereGaps({ ...base, leaves: ['x-leaf'], capabilityIds: [], panels: [], notNavigableLeaves: { 'x-leaf': '' } }).length > 0);
  assert.ok(takeMeThereGaps({ ...base, leaves: [], capabilityIds: ['k'], panels: [], capabilityPlaces: { k: 'no-such-place' as never } }).length > 0);
  assert.ok(takeMeThereGaps({ ...base, leaves: [], capabilityIds: ['k'], panels: [], capabilityPlaces: { k: { not: '' } } }).length > 0);
});

test('the features named in I-163 each keep their own place (several share a page, so the page check alone would not notice one missing)', () => {
  for (const id of ['physics-lab', 'touch-soft', 'unbound-entry', 'unbound-lab', 'trial-features', 'voiceprint', 'user-profile', 'touching-help', 'developer-mode', 'companion-window'])
    assert.ok(id in TAKE_ME_THERE, `${id} lost its 带我去 place`);
});

test('a scan of the wiring sources notices a panel mounted without an entry', () => {
  const sources = { 'src/wiring/control-window-wiring.ts': "new BrandNewPanel($('x'), {}); mountSomethingButton(el);", 'src/mood/MoodCompanion.ts': 'new OtherToolSwitch(this.body, {});' };
  assert.deepEqual(mountedPanels(sources), ['BrandNewPanel', 'OtherToolSwitch', 'mountSomethingButton']);
  assert.ok(takeMeThereGaps({ ...real(), panels: mountedPanels(sources) }).length >= 3);
});

test('the opt-out lists are honest: reasons are written, nothing stale, nothing both a destination and not navigable', () => {
  const leaves = new Set(leavesOf(CONTROL_NAVIGATION));
  const reached = new Set(Object.values(TAKE_ME_THERE).map(destination => destination.leafId));
  for (const [leaf, reason] of Object.entries(NOT_NAVIGABLE_LEAVES)) {
    assert.ok(leaves.has(leaf), `${leaf} is not a leaf any more: remove it from NOT_NAVIGABLE_LEAVES`);
    assert.ok(!reached.has(leaf), `${leaf} has a destination now: remove it from NOT_NAVIGABLE_LEAVES`);
    assert.ok(reason.trim().length >= 4, leaf);
  }
  const capabilityIds = new Set(CAPABILITIES.map(entry => entry.id));
  for (const id of Object.keys(CAPABILITY_PLACES)) assert.ok(capabilityIds.has(id), `${id} is not in the capability list any more`);
  const panels = new Set(mountedPanels());
  for (const name of Object.keys(PANEL_PLACES)) assert.ok(panels.has(name), `${name} is not mounted any more: remove it from PANEL_PLACES`);
  for (const cover of [...Object.values(CAPABILITY_PLACES), ...Object.values(PANEL_PLACES)]) {
    if (typeof cover === 'string') assert.ok(cover in TAKE_ME_THERE, cover);
    else assert.ok(cover.not.trim().length >= 4);
  }
});

test('every place has its English title (the button and the channel page list read it in either language)', () => {
  const english = ENGLISH_UI_COPY as Record<string, string>;
  for (const id of TAKE_ME_THERE_IDS) assert.ok(english[TAKE_ME_THERE[id].title], `${id}: "${TAKE_ME_THERE[id].title}" needs an English title in ui-copy.take-me-there.en.ts`);
  assert.ok(CONSENT_PLACES.every(id => id in TAKE_ME_THERE));
});

test('opening a place never changes anything: the host only opens the page, for every place and the consent ones above all', () => {
  for (const id of TAKE_ME_THERE_IDS) {
    const calls: string[] = [];
    const host = new TakeMeThere({ send: () => calls.push('send'), open: destination => calls.push(`open:${destination}`), id: () => 'offer-1' });
    const turn = host.beginTurn('');
    turn.destination = id; // the offer for this place, as if her reply carried it
    assert.ok(host.offer(turn, 7, false));
    calls.length = 0;
    assert.equal(host.go(7, { offerId: 'offer-1', destination: id }), true);
    assert.deepEqual(calls, [`open:${id}`], `${id}: a tap does nothing but open its page`);
  }
});
