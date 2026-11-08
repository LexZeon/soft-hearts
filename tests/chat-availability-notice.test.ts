import test from 'node:test';
import assert from 'node:assert/strict';
import { setUiLanguage } from '../shared/ui-language';
import type { ChatAvailabilityView } from '../shared/chat-availability';
import { ChatAvailabilityNotice, RECOVERED_NOTICE_MS, type ChatAvailabilityPorts } from '../src/ui/ChatAvailabilityNotice';

class Element {
  children: Element[] = []; className = ''; textContent: string | null = ''; type = '';
  disabled = false; hidden = false; dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  onclick: (() => void) | null = null;
  private classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name), contains: (name: string) => this.classes.has(name) };
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  get innerHTML(): string { throw new Error('the panel never reads or writes markup'); }
  set innerHTML(_value: string) { throw new Error('the panel never reads or writes markup'); }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const buttons = (root: Element) => all(root).filter(node => node.tagName === 'button');
const text = (root: Element) => all(root).filter(node => !node.hidden && node.children.length === 0).map(node => node.textContent).filter(Boolean).join(' | ');
const flush = () => new Promise(resolve => setImmediate(resolve));
(globalThis as any).document = { createElement: (tag: string) => new Element(tag) };
setUiLanguage('zh-CN');

const NOW = Date.UTC(2026, 10, 2, 18, 0);
const quota: ChatAvailabilityView = { state: 'unavailable', kind: 'quota', since: NOW - 1000, resumeAt: NOW + 3 * 3_600_000, checking: false };
const ok: ChatAvailabilityView = { state: 'ok', checking: false };

function setup(initial: ChatAvailabilityView = ok, overrides: Partial<ChatAvailabilityPorts> = {}) {
  const root = new Element('section');
  const calls: string[] = [], errors: string[] = [], timers: { callback: () => void; ms: number; live: boolean }[] = [];
  let push: (view: ChatAvailabilityView) => void = () => {};
  let released = false;
  const ports: ChatAvailabilityPorts = {
    get: async () => initial,
    changed: callback => { push = callback; return () => { released = true; }; },
    retry: async () => { calls.push('retry'); return ok; },
    help: async () => { calls.push('help'); },
    networkSettings: async () => { calls.push('network'); },
    error: message => errors.push(message),
    now: () => NOW,
    timers: { set: (callback, ms) => { const entry = { callback, ms, live: true }; timers.push(entry); return entry; }, clear: handle => { (handle as { live: boolean }).live = false; } },
    ...overrides,
  };
  const panel = new ChatAvailabilityNotice(root as unknown as HTMLElement, ports);
  return { root, panel, calls, errors, timers, push: (view: ChatAvailabilityView) => push(view), released: () => released };
}

test('hidden while chat works, and nothing is built from markup', async () => {
  const { root } = setup();
  await flush();
  assert.equal(root.hidden, true);
});

test('quota: the reason, the expected time and a single retry button', async () => {
  const { root } = setup(quota);
  await flush();
  assert.equal(root.hidden, false);
  const shown = text(root);
  assert.match(shown, /需要处理/);
  assert.match(shown, /Claude 的使用额度暂时用完了/);
  assert.match(shown, /预计 \d\d:\d\d 恢复/);
  assert.deepEqual(buttons(root).map(b => b.dataset.chatAvailability), ['retry']);
  assert.equal(buttons(root)[0].textContent, '重试');
});

test('each kind offers only its own fixed buttons', async () => {
  const expected: Record<string, string[]> = {
    'login-expired': ['retry', 'help'], 'not-found': ['retry', 'help'], certificate: ['retry', 'help'],
    network: ['retry', 'network-settings'], quota: ['retry'], 'rate-limited': ['retry'], other: ['retry'],
  };
  const { root, push } = setup();
  for (const [kind, actions] of Object.entries(expected)) {
    push({ state: 'unavailable', kind: kind as never, since: NOW, checking: false });
    assert.deepEqual(buttons(root).map(b => b.dataset.chatAvailability), actions, kind);
  }
  push({ state: 'unavailable', kind: 'certificate', since: NOW, checking: false });
  assert.equal(buttons(root)[1].textContent, '查看公司代理和证书的说明');
  push({ state: 'unavailable', kind: 'login-expired', since: NOW, checking: false });
  assert.equal(buttons(root)[1].textContent, '查看 Claude Code 安装与登录说明');
});

test('the buttons call only their own fixed operation, with no argument', async () => {
  const seen: unknown[][] = [];
  const { root, push, calls } = setup(ok, {
    retry: async (...args: unknown[]) => { seen.push(['retry', ...args]); return { state: 'unavailable', kind: 'network', since: NOW, checking: false }; },
    help: async (...args: unknown[]) => { seen.push(['help', ...args]); },
    networkSettings: async (...args: unknown[]) => { seen.push(['network', ...args]); },
  } as Partial<ChatAvailabilityPorts>);
  push({ state: 'unavailable', kind: 'network', since: NOW, checking: false });
  const [retry, network] = buttons(root);
  network.onclick!(); await flush();
  retry.onclick!(); await flush();
  assert.deepEqual(seen, [['network'], ['retry']]);
  assert.equal(calls.length, 0);
  push({ state: 'unavailable', kind: 'not-found', since: NOW, checking: false });
  buttons(root)[1].onclick!(); await flush();
  assert.deepEqual(seen.at(-1), ['help']);
});

test('while a retry runs the buttons are disabled and say so; a failed retry says it is still not working', async () => {
  const { root, push } = setup(ok, { retry: async () => ({ state: 'unavailable', kind: 'network', since: NOW, checking: false }) });
  push({ state: 'unavailable', kind: 'network', since: NOW, checking: true });
  assert.ok(buttons(root).every(b => b.disabled));
  assert.equal(buttons(root)[0].textContent, '正在重试……');
  assert.match(text(root), /正在重试……/);
  push({ state: 'unavailable', kind: 'network', since: NOW, checking: false });
  assert.ok(buttons(root).every(b => !b.disabled));
  buttons(root)[0].onclick!(); await flush();
  assert.match(text(root), /还是不行/);
});

test('recovery: a short "chat is back" message with her line, then the panel goes away', async () => {
  const { root, push, timers } = setup();
  push(quota);
  assert.equal(root.hidden, false);
  push({ state: 'ok', checking: false, recovered: { line: '我回来啦！' } });
  assert.equal(root.hidden, false);
  assert.ok(root.classList.contains('recovered'));
  assert.match(text(root), /已经恢复，可以继续聊天了。 \| 「我回来啦！」/);
  assert.equal(buttons(root).length, 0);
  push(ok); // the plain view that follows must not cut the message short
  assert.equal(root.hidden, false);
  assert.equal(timers.at(-1)!.ms, RECOVERED_NOTICE_MS);
  timers.at(-1)!.callback();
  assert.equal(root.hidden, true);
});

test('recovery without a cached line shows only the plain message; a new outage cancels the message', async () => {
  const { root, push, timers } = setup();
  push({ state: 'ok', checking: false, recovered: { line: null } });
  assert.doesNotMatch(text(root), /「/);
  push({ state: 'unavailable', kind: 'network', since: NOW, checking: false });
  assert.equal(timers.at(-1)!.live, false);
  assert.ok(!root.classList.contains('recovered'));
  assert.match(text(root), /连不上 Claude/);
});

test('a retry that works clears the panel straight away; errors from a button are reported, not thrown', async () => {
  const { root, push, errors } = setup(ok, { help: async () => { throw new Error('这个设置页只在 Windows 上有。'); } });
  push({ state: 'unavailable', kind: 'login-expired', since: NOW, checking: false });
  buttons(root)[1].onclick!(); await flush();
  assert.deepEqual(errors, ['这个设置页只在 Windows 上有。']);
  buttons(root)[0].onclick!(); await flush();
  assert.equal(root.hidden, true);
});

test('English shows no Chinese, and dispose lets go of the feed', async () => {
  setUiLanguage('en');
  try {
    const { root, push, panel, released } = setup();
    push({ state: 'unavailable', kind: 'certificate', since: NOW, checking: false });
    assert.ok(!/[\u4e00-\u9fff]/.test(text(root)), text(root));
    assert.ok(buttons(root).every(b => !/[\u4e00-\u9fff]/.test(b.textContent ?? '')));
    panel.dispose();
    assert.equal(released(), true);
    assert.equal(root.hidden, true);
  } finally { setUiLanguage('zh-CN'); }
});

test('a slow first read never overwrites a newer update', async () => {
  let release!: (view: ChatAvailabilityView) => void;
  const { root, push } = setup(ok, { get: () => new Promise<ChatAvailabilityView>(resolve => { release = resolve; }) });
  push({ state: 'unavailable', kind: 'network', since: NOW, checking: false });
  release(ok); await flush();
  assert.equal(root.hidden, false);
});
