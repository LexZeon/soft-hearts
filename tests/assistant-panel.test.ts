// I-071 v2 第二步 「Claude 助手」 page: streaming text, action lines with 撤回, choice buttons, the popup, 停止, and nothing from
// the model or the host ever becomes markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setUiLanguage } from '../shared/foundation/ui-language';
import type { AssistantEvent, AssistantView } from '../shared/safety/assistant';

class Element {
  children: Element[] = []; className = ''; textContent: string | null = ''; type = ''; value = ''; id = ''; placeholder = ''; rows = 0;
  disabled = false; hidden = false; scrollHeight = 0; scrollTop = 0; clientHeight = 0;
  attributes = new Map<string, string>();
  onclick: (() => void) | null = null; onchange: (() => void) | null = null; onsubmit: ((event: any) => void) | null = null; onkeydown: ((event: any) => void) | null = null;
  classList = { toggle: (name: string, on: boolean) => { const set = new Set(this.className.split(' ').filter(Boolean)); if (on) set.add(name); else set.delete(name); this.className = [...set].join(' '); } };
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  focus() {}
  get innerHTML(): string { throw new Error('the panel never reads or writes markup'); }
  set innerHTML(_value: string) { throw new Error('the panel never reads or writes markup'); }
}
class Option extends Element { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } }
(globalThis as any).document = { createElement: (tag: string) => new Element(tag) };
(globalThis as any).Option = Option;
const { AssistantPanel, assistantActionText } = await import('../src/safety/AssistantPanel');

const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const texts = (root: Element) => all(root).map(node => node.textContent).filter(Boolean) as string[];
const button = (root: Element, text: string) => { const found = all(root).find(node => node.tagName === 'button' && node.textContent === text); assert.ok(found, text); return found; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(view: AssistantView) {
  setUiLanguage('zh-CN');
  const calls: string[] = [];
  let emit: (event: AssistantEvent) => void = () => {};
  const root = new Element('div'), overlayHost = new Element('body');
  const panel = new AssistantPanel(root as any, {
    get: async () => view,
    send: async (text, choiceId) => { calls.push(`send ${text}${choiceId ? ` @${choiceId}` : ''}`); return { ...view, busy: true }; },
    cancel: async () => { calls.push('cancel'); return { ...view, busy: false }; },
    clear: async () => { calls.push('clear'); return { ...view, messages: [] }; },
    setPrefs: async prefs => { calls.push(`prefs ${JSON.stringify(prefs)}`); return { ...view, prefs: { ...view.prefs, ...prefs } }; },
    answer: async (id, allow) => { calls.push(`answer ${id} ${allow}`); },
    undo: async id => { calls.push(`undo ${id}`); return view; },
    events: callback => { emit = callback; return () => {}; },
    error: message => calls.push(`error ${message}`),
  }, overlayHost as any);
  return { root, overlayHost, calls, panel, emit: (event: AssistantEvent) => emit(event) };
}

const base: AssistantView = { busy: false, prefs: { model: 'sonnet', effort: 'medium' }, messages: [
  { id: 'u1', role: 'user', at: 0, parts: [{ kind: 'text', text: '<b>把朗读关掉</b>' }] },
  { id: 'a1', role: 'assistant', at: 0, status: 'done', parts: [
    { kind: 'text', text: '关好了。' },
    { kind: 'action', action: { tool: 'set_read_aloud', title: '朗读开关', tier: 'reversible', outcome: 'done', detail: '关掉', undoId: 'slot-1' } },
    { kind: 'choices', choices: { id: 'c1', question: '还要别的吗？', options: ['不用了', '再调声音'] } },
  ] },
] };

test('the conversation renders as text; an action line says what was done and offers 撤回; choices are buttons that answer once', async () => {
  const { root, calls } = setup(base);
  await flush();
  assert.ok(texts(root).includes('<b>把朗读关掉</b>'), 'the user’s words stay text');
  assert.ok(texts(root).includes('朗读开关：关掉 · 可以撤回'));
  button(root, '撤回').onclick!();
  button(root, '再调声音').onclick!();
  await flush();
  assert.deepEqual(calls, ['undo slot-1', 'send 再调声音 @c1']);
  const selects = all(root).filter(node => node.tagName === 'select');
  assert.deepEqual(selects.map(node => node.value), ['sonnet', 'medium'], 'Sonnet and 中 shown');
  selects[1].value = 'high'; selects[1].onchange!();
  await flush();
  assert.equal(calls.at(-1), 'prefs {"effort":"high"}');
});

test('streaming: text events grow the reply while it is written; 停止 replaces 发送 while busy', async () => {
  const streaming: AssistantView = { ...base, busy: true, messages: [...base.messages, { id: 'u2', role: 'user', at: 0, parts: [{ kind: 'text', text: '你好' }] },
    { id: 'a2', role: 'assistant', at: 0, status: 'streaming', parts: [] }] };
  const { root, calls, emit } = setup(streaming);
  await flush();
  assert.ok(texts(root).includes('思考中…'));
  emit({ type: 'part', messageId: 'a2', part: { kind: 'text', text: '' } });
  emit({ type: 'text', messageId: 'a2', text: '你' });
  emit({ type: 'text', messageId: 'a2', text: '好！' });
  assert.ok(texts(root).includes('你好！'));
  assert.ok(!texts(root).includes('思考中…'));
  const stop = button(root, '停止');
  const form = all(root).find(node => node.tagName === 'form')!;
  form.onsubmit!({ preventDefault() {} });
  await flush();
  assert.deepEqual(calls, ['cancel']);
  assert.ok(stop);
  // Old choices cannot be clicked while a turn runs or once a newer message exists.
  assert.ok(all(root).filter(node => node.tagName === 'button' && node.className.startsWith('assistant-choice')).every(node => node.disabled));
});

test('the popup shows the host’s own words over the whole window; only a click answers; it closes when the host says so', async () => {
  const { overlayHost, calls, emit } = setup(base);
  await flush();
  const overlay = overlayHost.children[0];
  assert.equal(overlay.hidden, true);
  emit({ type: 'confirm', request: { id: 'q1', title: 'Claude 请求导入角色卡', detail: 'card.json', toolTitle: '导入角色卡', buttons: ['不允许', '允许'], timeoutMs: 120_000 } });
  assert.equal(overlay.hidden, false);
  assert.ok(texts(overlay).includes('Claude 请求导入角色卡'));
  assert.match(texts(overlay).find(text => text.startsWith('来自'))!, /120 秒内不回应就算不允许/);
  button(overlay, '允许').onclick!();
  await flush();
  assert.deepEqual(calls, ['answer q1 true']);
  emit({ type: 'confirm-closed', id: 'q1' });
  assert.equal(overlay.hidden, true);
});

test('action lines in both languages', () => {
  setUiLanguage('zh-CN');
  assert.equal(assistantActionText({ tool: 'import_character_card', title: '导入角色卡', tier: 'confirm', outcome: 'declined' }), '没有执行：导入角色卡（你没有允许）');
  assert.equal(assistantActionText({ tool: 'read_handbook', title: '翻手册', tier: 'read', outcome: 'read' }), '查看了：翻手册');
  setUiLanguage('en');
  assert.equal(assistantActionText({ tool: 'set_read_aloud', title: '朗读开关', tier: 'reversible', outcome: 'done', detail: 'off', undoId: 'x' }), 'Reading aloud: off · can be undone');
  assert.equal(assistantActionText({ tool: 'x', title: '导入角色卡', tier: 'confirm', outcome: 'timeout' }), 'Not done: Import character card (no answer, counted as not allowed)');
  setUiLanguage('zh-CN');
});

test('I-071 v2 第三步: a conversion line shows each step, 取消转换 while it can, then the result; every value is text', async () => {
  const steps = ['backup', 'read', 'persona', 'memories', 'check', 'save'].map((id, index) => ({ id, status: index < 3 ? 'done' : index === 3 ? 'running' : 'waiting', ...(index === 3 ? { done: 1, total: 2 } : {}) }));
  const job = { id: 'job-1', sourceId: 'a', sourceName: '<i>阿澄</i>', target: 'en', state: 'running', steps, startedAt: 1, cancellable: true } as any;
  const view: AssistantView = { ...base, messages: [{ id: 'a9', role: 'assistant', at: 0, status: 'done', parts: [{ kind: 'conversion', job }] }] };
  const { root, emit } = setup(view);
  const panelRoot = root;
  await flush();
  assert.ok(texts(panelRoot).includes('把「<i>阿澄</i>」转成英文版'));
  assert.ok(texts(panelRoot).includes('… 翻译记忆 1/2'));
  assert.ok(texts(panelRoot).includes('✓ 先备份'));
  assert.equal(all(panelRoot).some(node => node.tagName === 'button' && node.textContent === '取消转换'), false, 'no cancel port in this setup: no button');
  emit({ type: 'conversion', job: { ...job, state: 'done', cancellable: false, newName: 'Cheng', steps: steps.map(step => ({ ...step, status: 'done' })), lint: ['名字和已有的卡重了'] } });
  assert.ok(texts(panelRoot).includes('转好了：新角色「Cheng」在角色页（还不是当前角色）。原来的「<i>阿澄</i>」没有任何改动。'));
  assert.ok(texts(panelRoot).includes('名字和已有的卡重了'));
});

test('I-071 v2 第三步: 取消转换 asks the host once', async () => {
  setUiLanguage('zh-CN');
  const steps = ['backup', 'read', 'persona', 'memories', 'check', 'save'].map(id => ({ id, status: 'waiting' }));
  const job = { id: 'job-2', sourceId: 'a', sourceName: '阿澄', target: 'zh-CN', state: 'running', steps, startedAt: 1, cancellable: true } as any;
  const view: AssistantView = { ...base, messages: [{ id: 'a9', role: 'assistant', at: 0, status: 'done', parts: [{ kind: 'conversion', job }] }] };
  const root = new Element('div');
  const cancelled: string[] = [];
  new AssistantPanel(root as any, { get: async () => view, send: async () => view, cancel: async () => view, clear: async () => view, setPrefs: async () => view,
    answer: async () => {}, undo: async () => view, events: () => () => {}, error: () => {}, cancelConversion: async id => { cancelled.push(id); } }, new Element('body') as any);
  await flush();
  assert.ok(texts(root).includes('把「阿澄」转成中文版'));
  const cancel = button(root, '取消转换');
  cancel.onclick!();
  assert.equal(cancel.disabled, true);
  assert.deepEqual(cancelled, ['job-2']);
});

test('I-071 fix 5: the software\'s own intro line, and the memories left out listed by title and reason (text only); both kept in the history', async () => {
  const { cleanHistory } = await import('../electron/safety/assistant/store');
  const steps = ['backup', 'read', 'persona', 'memories', 'check', 'save'].map(id => ({ id, status: 'done' }));
  const job = { id: 'job-3', sourceId: 'a', sourceName: '阿澄', target: 'en', state: 'done', steps, startedAt: 1, cancellable: false, newName: 'Cheng',
    leftOut: [{ title: '<b>周五面试</b>', kind: 'note', reasons: ['leftover'] }, { title: '2026-11-10 的日记', kind: 'diary', reasons: ['invented', 'left-name'] }], leftOutCount: 3 } as any;
  const intro = '会新建一个英文版角色，原来的「阿澄」一个字都不动。\n额度：一共 3 次调用';
  const view: AssistantView = { ...base, messages: [{ id: 'a9', role: 'assistant', at: 0, status: 'done', parts: [{ kind: 'notice', text: intro }, { kind: 'conversion', job }] }] };
  const { root } = setup(view);
  await flush();
  const shown = texts(root);
  assert.ok(shown.includes(intro));
  assert.ok(all(root).some(node => node.className === 'assistant-notice' && node.textContent === intro));
  assert.ok(shown.includes('有 3 条记忆重问一次还是翻得不合格，没有带过去（新卡里没有它们，原角色里都还在）：'));
  assert.ok(shown.includes('「<b>周五面试</b>」：还留着原来语言的字'));
  assert.ok(shown.includes('「2026-11-10 的日记」：像是自己编了一个昵称或爱称、又写出了先不带的名字'));
  assert.ok(shown.includes('还有 1 条'));
  // the history keeps them, bounded, closed reasons only
  const [message] = cleanHistory([{ id: 'm', role: 'assistant', at: 1, status: 'done', parts: [{ kind: 'notice', text: intro },
    { kind: 'conversion', job: { ...job, leftOut: [...job.leftOut, { title: 'x', kind: 'note', reasons: ['made-up'] }] } }] }]);
  assert.deepEqual(message!.parts[0], { kind: 'notice', text: intro });
  const stored = (message!.parts[1] as { job: { leftOut: unknown[]; leftOutCount: number } }).job;
  assert.deepEqual(stored.leftOut, job.leftOut);
  assert.equal(stored.leftOutCount, 3);
});

test('T-252: the assistant reply drops its own **bold** markers, the words stay; single asterisks, math and the user typing are kept', async () => {
  const view: AssistantView = { ...base, messages: [
    { id: 'u1', role: 'user', at: 0, parts: [{ kind: 'text', text: '帮我 **摸头**' }] },
    { id: 'a1', role: 'assistant', at: 0, status: 'done', parts: [{ kind: 'text', text: '按住 **摸头** 的位置，*轻轻* 划，2**3**4 不变。' }] }] };
  const { root } = setup(view);
  await flush();
  assert.ok(texts(root).includes('按住 摸头 的位置，*轻轻* 划，2**3**4 不变。'));
  assert.ok(texts(root).includes('帮我 **摸头**'));
});
