import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { SpeechPlaybackActivity } from '../electron/speech-playback-activity';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';
import { VoiceOutput } from '../src/ui/VoiceOutput';
import { DEFAULT_TTS_CONFIG } from '../shared/tts';
import { formatReplyBubbles } from '../shared/reply-segments';

const parse = (text: string) => ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);
const host = parse(await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'));
const renderer = parse(await readFile(new URL('../src/main.ts', import.meta.url), 'utf8'));
function declaration(name: string): string {
  const found = host.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(found.length, 1); return found[0].getText(host);
}
function callback(name: string): string {
  const found: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(host) === 'scopedHost'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === name) found.push(node.arguments[1]);
    ts.forEachChild(node, visit);
  }
  visit(host); assert.equal(found.length, 1); return found[0].getText(host);
}
const rendererSpeech = renderer.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : [])
  .find(n => n.name.getText(renderer) === 'speech')!.initializer!.getText(renderer);
const extracted = [declaration('canBeginSpeechPlaybackActivity'),
  `var begin=${callback('beginSpeechPlaybackActivity')};`, `var end=${callback('endSpeechPlaybackActivity')};`,
  `var cancel=${callback('cancelReplySpeech')};`].join('\n');
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await Promise.resolve(); }
  assert.fail('controlled transition did not settle');
}
function fixture() {
  let now = 0, scope = 'scope-a', visible = false, minimized = false, petVisible = true, petMinimized = false, petDestroyed = false;
  let bubble = '', id = 0, voiceEnabled = true;
  const owner = 7, calls: { text: string; finish(): void }[] = [], order: string[] = [], errors: string[] = [];
  const plan = new CompletedReplySpeech(() => now), leases = new SpeechPlaybackActivity(); leases.setScope(scope);
  const controls = { webContents: { id: owner }, isVisible: () => visible, isMinimized: () => minimized };
  const pet = { webContents: { id: 8 }, isVisible: () => petVisible, isMinimized: () => petMinimized, isDestroyed: () => petDestroyed };
  const settings = { get enabled() { return voiceEnabled; }, voiceURI: '', rate: 1, volume: 0 };
  const ctx: Record<string, any> = { controls, pet, windows: () => [controls, pet],
    store: { current: { voice: settings } }, completedReplySpeech: plan, speechPlaybackActivity: leases,
    speechScope: () => scope, formatReplyBubbles,
    petReply: { isPresentationCurrent: (text: string) => text === bubble },
    syncFatigueActivity() { leases.setScope(scope); }, cancelReplyStyle(replyId: string) { order.push('cancel'); plan.cancelReply(replyId); },
  };
  vm.createContext(ctx); vm.runInContext(transformSync(extracted, { loader: 'ts', target: 'es2022' }).code, ctx);
  const api = {
    onSpeechEvent: () => () => {}, synthesizeSpeech: async () => { assert.fail('no provider call is allowed'); }, cancelSpeech: async () => {},
    beginSpeechPlaybackActivity: async (playbackId: string) => { order.push('begin'); return ctx.begin(owner, playbackId) as string | null; },
    endSpeechPlaybackActivity: async (playbackId: string, lease: string) => { ctx.end(owner, playbackId, lease); },
    cancelReplySpeech: async (replyId: string) => { ctx.cancel(owner, replyId); },
    nextReplySpeechSegment: async (replyId: string, completedIndex?: number) => {
      const segment = plan.next(owner, replyId, scope, completedIndex);
      if (segment) { bubble = plan.fullPresentationText(owner, replyId, scope, segment)!; assert.ok(bubble); assert.ok(plan.approvePresentation(owner, replyId, scope, segment)); }
      return segment;
    },
  };
  const output = new VoiceOutput({ api, getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG }), getVoiceConfig: () => settings,
    createId: () => `playback-${++id}`, onSpeaking() {}, onError: message => errors.push(message),
    createSystem: () => ({ voices: () => [], stop() {}, speak(text) {
      const done = deferred<void>(); calls.push({ text, finish: () => done.resolve() }); return done.promise;
    } }),
  });
  function record(text = '第一句。第二句。') { plan.record(owner, 'reply-a', scope, text); }
  function approve() { const segment = plan.next(owner, 'reply-a', scope); assert.ok(segment);
    bubble = plan.fullPresentationText(owner, 'reply-a', scope, segment)!; assert.ok(bubble); assert.ok(plan.approvePresentation(owner, 'reply-a', scope, segment)); return segment; }
  return { owner, ctx, plan, leases, api, output, calls, order, errors, settings, record, approve,
    hide: () => { visible = false; }, show: () => { visible = true; }, minimize: () => { minimized = true; },
    petHide: () => { petVisible = false; }, petMinimize: () => { petMinimized = true; }, petDestroy: () => { petDestroyed = true; },
    voiceOff: () => { voiceEnabled = false; }, staleBubble: () => { bubble = 'different approved presentation'; },
    changeScope: () => { scope = 'scope-b'; }, expire: () => { now = 15 * 60_000; },
  };
}

test('hidden then minimized controls keep each acknowledged ordinary segment through controlled final playback', async () => {
  const f = fixture(); f.record();
  const queue = new CompletedReplySpeechQueue(f.api, segment => f.output.speak(segment.text, f.settings, segment.context), () => true);
  try {
    const done = queue.speak('reply-a');
    await until(() => f.calls.length === 1); assert.equal(f.leases.busy, true);
    f.minimize(); f.calls[0].finish();
    await until(() => f.calls.length === 2); assert.equal(f.leases.busy, true, 'second hidden-owner admission survives the segment gap');
    f.calls[1].finish(); await done;
    assert.deepEqual(f.calls.map(call => call.text), ['第一句。', '第二句。']);
    assert.equal(f.leases.busy, false); assert.deepEqual(f.errors, []);
  } finally { queue.cancel(); f.output.dispose(); }
});

test('the hidden-owner exception requires the current approved ordinary presentation and native pet', async () => {
  const denials: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['not approved', f => { f.plan.record(f.owner, 'new-reply', 'scope-a', '未确认。'); }],
    ['wrong scope', f => f.changeScope()], ['expired', f => f.expire()], ['voice off', f => f.voiceOff()],
    ['pet hidden', f => f.petHide()], ['pet minimized', f => f.petMinimize()], ['pet destroyed', f => f.petDestroy()],
    ['stale native presentation', f => f.staleBubble()], ['cancelled', f => { f.plan.cancelReply('reply-a'); }],
  ];
  for (const [name, deny] of denials) {
    const f = fixture(); try { f.record(); f.approve(); deny(f); assert.equal(await f.ctx.begin(f.owner, 'denied'), null, name); assert.equal(f.leases.busy, false); }
    finally { f.output.dispose(); }
  }
  const f = fixture(); try {
    f.record(); f.approve(); assert.equal(await f.ctx.begin(99, 'foreign'), null);
    f.petHide(); assert.equal(await f.ctx.begin(8, 'other-hidden-owner'), null, 'only actual controls can use the exception');
    f.show(); assert.equal(typeof await f.ctx.begin(f.owner, 'visible-preview'), 'string', 'original visible controls behavior remains');
  } finally { f.output.dispose(); }
});

test('actual renderer preview wrappers cancel the ordinary plan before a hidden-owner lease attempt', async () => {
  for (const mode of ['preview', 'previewCharacter'] as const) {
    const f = fixture(), playing = deferred<void>(); let preparations = 0;
    const queue = new CompletedReplySpeechQueue(f.api, () => playing.promise, () => true);
    const js = transformSync(`var speech=${rendererSpeech};`, { loader: 'ts', target: 'es2022' }).code;
    const ctx: Record<string, any> = { speechOutput: f.output, replySpeechQueue: queue }; vm.createContext(ctx); vm.runInContext(js, ctx);
    try {
      f.record(); const ordinary = queue.speak('reply-a'); await until(() => !!f.plan.approvedCurrentSegment(f.owner, 'scope-a'));
      const preview = mode === 'preview' ? ctx.speech.preview('公开预览。')
        : ctx.speech.previewCharacter('公开预览。', async () => { preparations++; return { replyId: 'preview-a' }; });
      await assert.rejects(preview, /语音播放活动未获授权/);
      assert.deepEqual(f.order.slice(0, 2), ['cancel', 'begin']);
      assert.equal(f.plan.approvedCurrentSegment(f.owner, 'scope-a'), null);
      assert.equal(f.calls.length, 0); assert.equal(preparations, 0); assert.equal(f.leases.busy, false);
      playing.resolve(); await ordinary;
    } finally { playing.resolve(); queue.cancel(); f.output.dispose(); }
  }
});
