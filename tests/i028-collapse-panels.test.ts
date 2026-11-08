// I-028: folding the pet's toolbar closes every floating
// panel it opened, unfolding opens none of them again, and only the interface closes (sharing, listening, developer mode,
// the reply itself go on). The register (src/ui/pet-popups.ts) is kept complete by structure: a toolbar button, a pet panel
// or a source file making floating pet UI that is not in it fails here. docs/claude/2026-11-04-i028-collapse-panels.md.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { installPetWindow, type FakeElement } from './helpers/pet-window-dom';
import { createMoodState, getMoodSnapshot, DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import { createAudioReadingView, type AudioReadingView } from '../shared/audio-reading-toggles';
import type { RuntimeState } from '../shared/contracts';
import { PetUI, renderPet } from '../src/ui/PetUI';
import { ImmersiveNotice } from '../src/ui/ImmersiveNotice';
import { MoodCompanion, type MoodCompanionAPI } from '../src/ui/MoodCompanion';
import { ScreenSharingOptions, DEFAULT_SCREEN_SHARING_OPTIONS, type ScreenSharingOptionsState } from '../src/ui/ScreenSharingOptions';
import { PET_FLOATING_NOT_POPUPS, PET_POPUP_KEYS, PET_POPUPS, PET_TOOLBAR_PLAIN, NOT_IN_PET_WINDOW, PetPopups, laterPopup, type PetPopupKey } from '../src/ui/pet-popups';

// UserProfilePanel and AudioReadingClient import their stylesheets (Vite bundles them); here a stylesheet is an empty module,
// so the real panels can run in the test.
registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
const { UserProfilePanel } = await import('../src/ui/UserProfilePanel');
const { AudioReadingClient } = await import('../src/ui/AudioReadingClient');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** On screen as the panel itself says: no hidden ancestor, and a dialog only while open. */
function shown(node: FakeElement | null): boolean {
  if (!node || (node.tagName === 'dialog' && !node.open)) return false;
  for (let up: FakeElement | null = node; up; up = up.parent) if (up.hidden) return false;
  return true;
}

/** The pet window as src/main.ts init() wires it, with the host replaced by recording fakes. */
async function petWindow(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hostCalls: string[] = [];
  const dom = installPetWindow(t, {
    openControls: async () => { hostCalls.push('openControls'); },
    updatePetReply: async () => undefined,
    setPetWindowOperation: async () => undefined,
  });
  const { document, byId } = dom;
  renderPet(dom.app as unknown as HTMLElement);
  byId('stage').rect = { left: 0, top: 0, right: 400, bottom: 560, width: 400, height: 560, x: 0, y: 0 };

  let userProfilePanel: InstanceType<typeof UserProfilePanel> | null = null;
  let ambientAudioController: InstanceType<typeof AudioReadingClient> | null = null;
  let screenSharingOptions: ScreenSharingOptions | null = null;
  let moodCompanion: MoodCompanion | null = null;
  const ui: PetUI = new PetUI({
    edit: enabled => hostCalls.push(`edit:${enabled}`),
    feature: feature => hostCalls.push(`feature:${feature}`),
    systemAudio: () => ambientAudioController?.toggleExpanded(),
    closeSystemAudioPanel: () => { if (ambientAudioController?.isExpanded) ambientAudioController.toggleExpanded(); },
    toggleUserProfile: () => userProfilePanel?.toggle(), closeUserProfile: () => userProfilePanel?.close(),
    popups: {
      'screen-sharing-options': laterPopup(() => screenSharingOptions, options => options.isOpen, options => options.close()),
      'mood-companion': laterPopup(() => moodCompanion, mood => mood.panelOpen, mood => mood.closePanel()),
    },
    send: () => hostCalls.push('send'), stop: () => hostCalls.push('stop'), error: message => { throw Error(message); },
  });
  const notice = new ImmersiveNotice(document as unknown as Document, { quietOrdinaryFailures: true });
  userProfilePanel = new UserProfilePanel(byId('user-profile-panel') as unknown as HTMLElement, byId('user-profile-toggle') as unknown as HTMLButtonElement, {
    getUserProfile: async () => null, onUserProfileChanged: () => () => {},
    setUserProfileEnabled: async () => { hostCalls.push('setUserProfileEnabled'); throw Error('unused'); },
    editUserProfile: async () => { throw Error('unused'); }, deleteUserProfile: async () => { throw Error('unused'); },
    editUserDiary: async () => { throw Error('unused'); }, deleteUserDiary: async () => { throw Error('unused'); }, clearUserDiary: async () => { throw Error('unused'); },
  }, message => { throw Error(message); }, () => { byId('notice-detail-panel').hidden = true; });
  byId('notice-details').addEventListener('click', () => userProfilePanel?.close());

  // Mood: the host's view, and developer mode switched by the toolbar button (MoodCompanion listens to it).
  const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS);
  const mood: MoodView = { characterId: 'gene', token: 'gene-one', revision: 1, developerMode: false, expressions: true, parameters,
    snapshot: getMoodSnapshot(createMoodState(0, parameters)), gesture: null } as MoodView;
  const moodListeners = new Set<(view: MoodView) => void>();
  const broadcastMood = () => { mood.revision++; for (const listener of moodListeners) listener(structuredClone(mood)); return structuredClone(mood); };
  const moodApi: MoodCompanionAPI = {
    getMood: async () => structuredClone(mood),
    onMood: listener => { moodListeners.add(listener); return () => { moodListeners.delete(listener); }; },
    setMoodDeveloperMode: async value => { hostCalls.push(`setMoodDeveloperMode:${value}`); mood.developerMode = value; return broadcastMood(); },
    setMoodExpressions: async value => { hostCalls.push('setMoodExpressions'); mood.expressions = value; return broadcastMood(); },
    setMoodParameters: async () => broadcastMood(), restoreMoodParameters: async () => broadcastMood(),
    moodInteraction: async () => structuredClone(mood),
    openControls: async () => { hostCalls.push('openControls'); },
  };
  moodCompanion = new MoodCompanion({ isPet: true, surface: byId('stage') as unknown as HTMLElement, api: moodApi,
    getHeadRegion: () => ({ x: 195, y: 80, radius: 30 }), canInteract: () => true, onFeedback() {}, onInteraction() {},
    onView: view => ui.setDeveloperMode(view.developerMode) });
  await moodCompanion.init();

  // Screen sharing options: a mount at the end of the toolbar, as src/main.ts makes it.
  const sharingMount = document.createElement('div'); sharingMount.className = 'pet-sharing-options'; sharingMount.dataset.moodUi = 'true';
  byId('pet-toolbar').append(sharingMount);
  screenSharingOptions = new ScreenSharingOptions(sharingMount as unknown as HTMLElement, patch => hostCalls.push(`setVisionOptions:${JSON.stringify(patch)}`));
  let runtime: RuntimeState = { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: 'pet', cameraOwner: 'pet' } as RuntimeState;
  let vision: ScreenSharingOptionsState = { ...DEFAULT_SCREEN_SHARING_OPTIONS };
  const hostRuntime = (patch: Partial<RuntimeState>) => {
    runtime = { ...runtime, ...patch }; vision = { ...vision, screenSharing: runtime.screenSharing, cameraSharing: runtime.cameraSharing };
    ui.applyRuntime(runtime); screenSharingOptions!.update({ ...vision });
  };

  // 一起听: the real client, its host replaced; every request it would send is recorded.
  const audioListeners: { view?: (view: AudioReadingView) => void } = {};
  const record = (name: string) => async () => { hostCalls.push(name); return true as never; };
  ambientAudioController = new AudioReadingClient(byId('ambient-audio-controls') as unknown as HTMLElement, {
    api: {
      onAudioReadingView: listener => { audioListeners.view = listener; return () => {}; },
      onAudioCaptureState: () => () => {}, onAmbientAudioState: () => () => {}, onAudioDanceSample: () => () => {},
      getAudioReadingView: record('getAudioReadingView'), getAudioCaptureState: record('getAudioCaptureState'),
      setAudioReadingIntent: record('setAudioReadingIntent'), setAudioDanceIntent: record('setAudioDanceIntent'),
      setAudioDanceSourceIntent: record('setAudioDanceSourceIntent'), ackAudioCapture: record('ackAudioCapture'),
      submitAudioReadingPcm: record('submitAudioReadingPcm'), submitAudioDanceSample: record('submitAudioDanceSample'),
    },
    owner: 'pet', media: { pushVoicePcm() {}, microphoneReady() {} } as never, system: null,
    onMusicEnabled() {}, onError: message => { throw Error(message); },
    onDanceStatus: (active, status) => ui.setAudioDanceState(active, status),
    onExpanded: expanded => ui.setSystemAudioExpanded(expanded),
  });
  const listening = createAudioReadingView('listen-1'); listening.sources['system-audio'].music.intent = true;
  audioListeners.view!(listening);

  dom.beforeClose(() => {
    moodCompanion?.dispose(); ambientAudioController?.dispose(); screenSharingOptions?.dispose(); userProfilePanel?.dispose(); notice.dispose(); ui.dispose();
  });

  const fold = byId('pet-toolbar-toggle');
  const panel = (key: PetPopupKey) => document.querySelector(PET_POPUPS[key].panel);
  /** Brings each popup up the way the user does. Typed over every key: a popup added to the register needs an opener here. */
  const openers: Record<PetPopupKey, () => Promise<void>> = {
    'system-audio': async () => byId('pet-system-audio-sharing').click(),
    'user-profile': async () => byId('user-profile-toggle').click(),
    'reply-reader': async () => byId('pet-read-reply').click(),
    'notice-detail': async () => byId('notice-details').click(),
    // Already on, the button turns it off first (the user clicks twice), so its options come up as a new opening.
    'screen-sharing-options': async () => {
      if (runtime.screenSharing) { byId('pet-screen-sharing').click(); hostRuntime({ screenSharing: false }); }
      byId('pet-screen-sharing').click(); hostRuntime({ screenSharing: true });
    },
    // I-036: the camera button only expands the two camera switches (already open, the first click closes it).
    'camera-sharing': async () => {
      if (byId('pet-camera-sharing').attributes.get('aria-expanded') === 'true') byId('pet-camera-sharing').click();
      byId('pet-camera-sharing').click();
    },
    'mood-companion': async () => {
      if (mood.developerMode) { byId('pet-developer-mode').click(); await flush(); }
      byId('pet-developer-mode').click(); await flush();
    },
  };
  return { ...dom, ui, notice, hostCalls, fold, panel, openers, hostRuntime, broadcastMood, mood,
    runtime: () => runtime, audio: () => ambientAudioController!, sharing: () => screenSharingOptions!, companion: () => moodCompanion!,
    openKeys: () => PET_POPUP_KEYS.filter(key => shown(panel(key))),
    /** Her reply, so 回复全文 has something to show; a failure notice in developer mode, so 问题详情 has its button. */
    async prepare() {
      ui.showAnswer('这是她的一段完整回复。', false, 'reply-1');
      notice.setDeveloperMode(true); notice.publish('出了点问题', true);
      await flush();
    },
  };
}

test('folding the toolbar closes every open popup, and unfolding opens none of them again', async t => {
  const pet = await petWindow(t); await pet.prepare();
  // 读取本机音频、用户画像、回复全文、问题详情 replace one another, so each takes a turn beside the two that stay up together.
  for (const exclusive of ['system-audio', 'user-profile', 'reply-reader', 'notice-detail'] as const) {
    if (pet.fold.attributes.get('aria-expanded') === 'false') pet.fold.click();
    await pet.openers['screen-sharing-options'](); await pet.openers['mood-companion'](); await pet.openers[exclusive]();
    assert.deepEqual(pet.openKeys().sort(), [exclusive, 'screen-sharing-options', 'mood-companion'].sort(), `${exclusive}: opened as the user does`);
    pet.fold.click();
    assert.equal(pet.fold.attributes.get('aria-expanded'), 'false');
    assert.deepEqual(pet.openKeys(), [], `${exclusive}: folding closes every popup`);
    assert.equal(pet.byId('pet-system-audio-sharing').attributes.get('aria-expanded'), 'false', 'the audio button no longer says expanded');
    assert.equal(pet.byId('user-profile-toggle').attributes.get('aria-expanded'), 'false', 'the profile button no longer says expanded');
    // The host goes on sending the same state; none of it brings a closed popup back.
    pet.hostRuntime({}); pet.broadcastMood(); await flush();
    pet.fold.click();
    assert.equal(pet.fold.attributes.get('aria-expanded'), 'true');
    pet.hostRuntime({}); pet.broadcastMood(); t.mock.timers.tick(1000); await flush();
    assert.deepEqual(pet.openKeys(), [], `${exclusive}: unfolding opens none of them again`);
  }
  // Every popup can still be opened again by hand after a fold.
  pet.fold.click(); pet.fold.click();
  await pet.openers['system-audio']();
  assert.deepEqual(pet.openKeys(), ['system-audio']);
  assert.equal(pet.byId('pet-system-audio-sharing').attributes.get('aria-expanded'), 'true');
});

test('with all six up at once, folding closes all six', async t => {
  const pet = await petWindow(t); await pet.prepare();
  for (const key of PET_POPUP_KEYS) await pet.openers[key]();
  // Bypass the one-at-a-time rule between the first four, so all six are up together.
  pet.audio().isExpanded || pet.audio().toggleExpanded();
  pet.byId('user-profile-panel').hidden = false; pet.byId('user-profile-toggle').setAttribute('aria-expanded', 'true');
  pet.byId('notice-detail-panel').hidden = false;
  pet.byId('pet-reply-reader').showModal();
  assert.deepEqual(pet.openKeys(), PET_POPUP_KEYS);
  pet.fold.click();
  assert.deepEqual(pet.openKeys(), []);
});

test('folding closes the interface only: sharing, listening, developer mode, the reply and its reader stay as they were', async t => {
  const pet = await petWindow(t); await pet.prepare();
  await pet.openers['screen-sharing-options'](); await pet.openers['mood-companion'](); await pet.openers['system-audio']();
  pet.ui.setSystemAudioState({ active: true });
  const pressed = () => ['pet-voice-input', 'pet-screen-sharing', 'pet-camera-sharing', 'pet-system-audio-sharing', 'pet-developer-mode', 'pet-camera-edit']
    .map(id => pet.byId(id).attributes.get('aria-pressed'));
  const before = pressed(), calls = pet.hostCalls.length;
  assert.deepEqual(before, ['false', 'true', 'false', 'true', 'true', 'false']);
  pet.fold.click(); pet.fold.click(); await flush();
  assert.deepEqual(pet.openKeys(), []);
  assert.deepEqual(pressed(), before, 'screen sharing, listening and developer mode are still on');
  assert.deepEqual(pet.hostCalls.slice(calls), [], 'nothing is asked of the host: no sharing, listening, option or mode change');
  assert.equal(pet.runtime().screenSharing, true);
  assert.equal(pet.mood.developerMode, true);
  assert.equal(pet.audio().active, true, '一起听 is still on');
  assert.equal(pet.byId('pet-read-reply').disabled, false, 'her reply is still there to read again');
  assert.match(pet.byId('pet-media-indicator').textContent, /屏幕共享/);
});

test('a closed popup that follows a state comes back only when that state starts again', async t => {
  const pet = await petWindow(t); await pet.prepare();
  await pet.openers['screen-sharing-options'](); await pet.openers['mood-companion']();
  pet.fold.click(); pet.fold.click();
  assert.deepEqual(pet.openKeys(), []);
  pet.hostRuntime({ cameraSharing: true });
  assert.deepEqual(pet.openKeys(), ['screen-sharing-options'], 'camera sharing starting is a new opening');
  pet.fold.click(); pet.fold.click();
  pet.hostRuntime({ screenSharing: false, cameraSharing: false }); pet.hostRuntime({ screenSharing: true });
  assert.deepEqual(pet.openKeys(), ['screen-sharing-options'], 'sharing turned on again shows its options');
  pet.byId('pet-developer-mode').click(); await flush(); // off
  assert.equal(pet.mood.developerMode, false);
  pet.byId('pet-developer-mode').click(); await flush(); // on again
  assert.deepEqual(pet.openKeys().sort(), ['mood-companion', 'screen-sharing-options']);
  const options = pet.panel('screen-sharing-options')!;
  assert.equal(options.querySelector('[data-screen-option="proactiveVision"]')!.disabled, false, 'the shown options are usable');
});

// ---------------------------------------------------------------- the register stays complete

/** Problems with the register against a pet window's markup (empty when every button and panel is accounted for). */
function markupProblems(toolbar: FakeElement, all: FakeElement[]): string[] {
  const problems: string[] = [];
  const triggers = new Map<string, PetPopupKey>();
  for (const key of PET_POPUP_KEYS) for (const id of PET_POPUPS[key].triggers) triggers.set(id, key);
  const buttons = toolbar.children.filter(node => node.tagName === 'button');
  for (const button of buttons) {
    const asTrigger = triggers.has(button.id), plain = Object.hasOwn(PET_TOOLBAR_PLAIN, button.id);
    if (asTrigger === plain) problems.push(`toolbar button #${button.id || '(no id)'} must be either a popup trigger or a plain button`);
    const controls = button.getAttribute('aria-controls');
    if ((button.hasAttribute('aria-expanded') || controls) && controls !== 'pet-toolbar') {
      const key = triggers.get(button.id);
      if (!key) problems.push(`#${button.id} expands something but is no popup's trigger`);
      else if (controls && !PET_POPUPS[key].panel.startsWith(`#${controls}`)) problems.push(`#${button.id} controls #${controls}, not ${PET_POPUPS[key].panel}`);
    }
  }
  for (const [id, key] of triggers) if (!buttons.some(button => button.id === id)) problems.push(`${key}: trigger #${id} is not on the toolbar`);
  for (const key of PET_POPUP_KEYS) {
    const id = /^#([\w-]+)/.exec(PET_POPUPS[key].panel)?.[1];
    if (id && !all.some(node => node.id === id)) problems.push(`${key}: #${id} is not in the pet window`);
  }
  for (const node of all) {
    if (node.tagName !== 'dialog' && node.dataset.moodUi === undefined) continue;
    if (!PET_POPUP_KEYS.some(key => node.matches(PET_POPUPS[key].panel) || node.closest(PET_POPUPS[key].panel.split(' ')[0])))
      problems.push(`floating panel #${node.id || node.className} is in no popup's place`);
  }
  return problems;
}

test('every toolbar button is a popup trigger or a plain button, and every panel in the markup is a popup', t => {
  const { app, byId } = installPetWindow(t);
  renderPet(app as unknown as HTMLElement);
  const all = [app, ...app.querySelectorAll('*')];
  assert.deepEqual(markupProblems(byId('pet-toolbar'), all), []);
  // The check is not vacuous: a new expanding button, or a new panel, that nobody registered is caught.
  const planted = app.ownerDocument.parse('<button id="pet-new-panel" aria-expanded="false" aria-controls="pet-new-list">x</button><section id="pet-new-list" data-mood-ui hidden></section>');
  byId('pet-toolbar').append(planted[0]); app.append(planted[1]);
  const problems = markupProblems(byId('pet-toolbar'), [app, ...app.querySelectorAll('*')]);
  assert.ok(problems.some(problem => problem.includes('#pet-new-panel must be either')), problems.join('\n'));
  assert.ok(problems.some(problem => problem.includes('#pet-new-panel expands something')), problems.join('\n'));
  assert.ok(problems.some(problem => problem.includes('#pet-new-list is in no popup')), problems.join('\n'));
});

/** Files that make floating pet UI: an input-reserving panel, a dialog, or an expandable control. */
const FLOATING_MARKERS = /data-mood-ui|dataset\.moodUi|\.showModal\(|aria-expanded|<dialog\b|createElement\(\s*['"]dialog['"]/;
function sourceProblems(files: Map<string, string>): string[] {
  const named = new Set<string>([
    ...PET_POPUP_KEYS.flatMap(key => PET_POPUPS[key].sources),
    ...Object.values(PET_FLOATING_NOT_POPUPS).flatMap(entry => entry.sources),
    ...Object.keys(NOT_IN_PET_WINDOW),
  ]);
  const problems: string[] = [];
  for (const [file, text] of files) if (file !== 'src/ui/pet-popups.ts' && FLOATING_MARKERS.test(text) && !named.has(file)) problems.push(`${file} makes floating UI but is not in src/ui/pet-popups.ts`);
  for (const file of named) if (!existsSync(path.join(root, file))) problems.push(`src/ui/pet-popups.ts names ${file}, which does not exist`);
  return problems;
}

test('every source file that makes floating UI is in the register, as a popup, as not-a-popup, or as outside the pet window', () => {
  const files = new Map<string, string>();
  for (const entry of readdirSync(path.join(root, 'src'), { recursive: true }) as string[]) {
    if (!/\.ts$/.test(entry)) continue;
    const file = `src/${entry.split(path.sep).join('/')}`;
    files.set(file, readFileSync(path.join(root, file), 'utf8'));
  }
  assert.ok(files.has('src/ui/PetUI.ts') && files.size > 50, 'read the renderer sources');
  assert.deepEqual(sourceProblems(files), []);
  files.set('src/ui/NewFloatingPanel.ts', "panel.dataset.moodUi = 'true';");
  assert.deepEqual(sourceProblems(files), ['src/ui/NewFloatingPanel.ts makes floating UI but is not in src/ui/pet-popups.ts'], 'a new panel file nobody registered is caught');
});

test('the register closes only what is open, and one panel failing to close does not keep the others open', () => {
  const state = Object.fromEntries(PET_POPUP_KEYS.map(key => [key, true])) as Record<PetPopupKey, boolean>;
  state['notice-detail'] = false;
  const closes: PetPopupKey[] = [], errors: string[] = [];
  const handles = Object.fromEntries(PET_POPUP_KEYS.map(key => [key, {
    isOpen: () => state[key],
    close: () => { closes.push(key); if (key === 'user-profile') throw Error('profile would not close'); state[key] = false; },
  }])) as Record<PetPopupKey, { isOpen(): boolean; close(): void }>;
  const popups = new PetPopups(handles, message => errors.push(message));
  assert.deepEqual(popups.closeAll(), PET_POPUP_KEYS.filter(key => key !== 'notice-detail' && key !== 'user-profile'));
  assert.deepEqual(closes, PET_POPUP_KEYS.filter(key => key !== 'notice-detail'), 'every open one was asked, a closed one was not');
  assert.deepEqual(errors, ['Error: profile would not close']);
  assert.deepEqual(popups.openKeys(), ['user-profile']);
  // A popup whose panel is not made yet (or in the control window, never) is simply not open.
  let target: { open: boolean } | null = null;
  const later = laterPopup(() => target, it => it.open, it => { it.open = false; });
  assert.equal(later.isOpen(), false); later.close();
  target = { open: true }; assert.equal(later.isOpen(), true); later.close(); assert.equal(target.open, false);
});
