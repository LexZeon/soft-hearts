import test from 'node:test';
import assert from 'node:assert/strict';
import { setUiLanguage } from '../shared/ui-language';
import type { AgentChannelView } from '../shared/agent-channel';
import { AgentChannelPanel, agentChannelStatusText, agentNoticeText, runAgentRendererAction } from '../src/ui/AgentChannelPanel';

class Element {
  children: Element[] = []; className = ''; textContent: string | null = ''; type = '';
  checked = false; disabled = false; hidden = false;
  dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  onchange: (() => void) | null = null; onclick: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  get innerHTML(): string { throw new Error('the panel never reads or writes markup'); }
  set innerHTML(_value: string) { throw new Error('the panel never reads or writes markup'); }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const part = (root: Element, name: string) => { const found = all(root).find(node => node.dataset.agentChannel === name); assert.ok(found, name); return found; };
const flush = () => new Promise(resolve => setImmediate(resolve));
(globalThis as any).document = { createElement: (tag: string) => new Element(tag) };
setUiLanguage('zh-CN');

const off: AgentChannelView = { enabled: false, listening: false, connections: 0, lastAction: null };
const on: AgentChannelView = { enabled: true, listening: true, connections: 1, lastAction: null,
  setup: { claudeCode: 'claude mcp add --transport stdio --scope user --env ELECTRON_RUN_AS_NODE=1 soft-hearts-next -- "a" "b"', desktopConfig: '{"mcpServers":{}}' } };

test('status line: off by default, then on with connections and the last action', () => {
  assert.match(agentChannelStatusText(off), /^已关闭/);
  assert.match(agentChannelStatusText({ ...on, connections: 0 }), /已开启 · 只接受本机当前用户 · 还没有 Claude 连接/);
  const text = agentChannelStatusText({ ...on, lastAction: { tool: 'activate_character', title: '切换角色', tier: 'reversible', outcome: 'denied', at: 1_000 } }, 181_000);
  assert.match(text, /1 个 Claude 已连接 · 最近：切换角色（已拒绝，3 分钟前）/);
  assert.equal(agentChannelStatusText({ ...off, error: '通道名已被其他程序占用，未开启。' }), '通道名已被其他程序占用，未开启。');
  assert.equal(agentNoticeText({ title: '切换角色', at: 0 }), '由 Claude 操作：切换角色');
});

test('the toggle starts disabled and unchecked, follows host state, and shows setup text only while on', async () => {
  const requests: boolean[] = [], errors: string[] = [], copied: string[] = [];
  let publish: (view: AgentChannelView) => void = () => {};
  const root = new Element('div');
  const panel = new AgentChannelPanel(root as any, {
    get: async () => off,
    setEnabled: async enabled => { requests.push(enabled); return enabled ? on : off; },
    changed: callback => { publish = callback; return () => { publish = () => {}; }; },
    copy: async text => { copied.push(text); },
    error: message => errors.push(message),
  });
  const toggle = part(root, 'enabled'), status = part(root, 'status'), setup = part(root, 'setup');
  assert.equal(toggle.checked, false); assert.equal(toggle.disabled, true, 'no switch before the host answers');
  await flush();
  assert.equal(toggle.disabled, false); assert.equal(toggle.checked, false); assert.equal(setup.hidden, true);
  assert.match(status.textContent!, /已关闭/);
  toggle.checked = true; toggle.onchange!();
  assert.equal(toggle.disabled, true);
  await flush();
  assert.deepEqual(requests, [true]);
  assert.equal(toggle.checked, true); assert.equal(setup.hidden, false);
  assert.ok(all(root).some(node => node.textContent === on.setup!.claudeCode));
  part(root, 'copy-claude-code').onclick!(); await flush();
  assert.deepEqual(copied, [on.setup!.claudeCode]);
  publish({ ...off });
  assert.equal(toggle.checked, false); assert.equal(setup.hidden, true);
  assert.ok(!all(root).some(node => node.textContent === on.setup!.claudeCode), 'snippets are cleared when the channel turns off');
  panel.dispose();
  publish(on);
  assert.equal(toggle.checked, false);
  assert.deepEqual(errors, []);
});

test('a failed switch keeps the last host state and reports the error', async () => {
  const errors: string[] = [];
  const root = new Element('div');
  new AgentChannelPanel(root as any, { get: async () => off, setEnabled: async () => { throw new Error('未能开启：权限不足'); },
    changed: () => () => {}, error: message => errors.push(message) });
  await flush();
  const toggle = part(root, 'enabled');
  toggle.checked = true; toggle.onchange!(); await flush();
  assert.equal(toggle.checked, false);
  assert.match(errors[0], /未能开启/);
});

test('renderer actions are a closed set mapped to existing buttons', () => {
  const calls: string[] = [];
  const ports = { playPreview: (recipe: string) => calls.push(`play:${recipe}`), voicePreview: () => calls.push('voice') };
  assert.equal(runAgentRendererAction({ kind: 'play-preview', recipe: 'shy' }, ports), true);
  assert.equal(runAgentRendererAction({ kind: 'voice-preview' }, ports), true);
  for (const bad of [{ kind: 'play-preview', recipe: 'cry' }, { kind: 'eval', code: 'x' }, null, 'voice-preview'])
    assert.equal(runAgentRendererAction(bad as any, ports), false);
  assert.deepEqual(calls, ['play:shy', 'voice']);
});

// I-014 "三方互通".
const mutualOn: AgentChannelView = { ...on, interconnect: { enabled: true, explicit: false, recycleDays: 7,
  claudeCode: { state: 'registered', name: 'soft-hearts-next', message: '已接上你的 Claude Code：刚把 soft-hearts-next 加了进去，新开的 Claude Code 会话里就能用。' },
  recycleBin: [{ id: 'e1', characterId: 'c1', characterName: '小桃', part: 'chat', count: 3, label: '聊天记忆 3 段', deletedAt: Date.UTC(2026, 10, 3), expiresAt: Date.UTC(2026, 10, 10, 12) }] },
  lastAction: { tool: 'set_setting', title: '调整设置', tier: 'reversible', outcome: 'allowed', at: Date.now(), undo: { id: 'u1', label: '把「渲染帧率」改回 60 FPS · 流畅', expiresAt: Date.now() + 60_000 } } };

test('三方互通: on by default with the channel switch locked open; 撤回, 找回, 重新接上 and the bin period go to the host', async () => {
  const requests: string[] = [];
  let publish: (view: AgentChannelView) => void = () => {};
  const root = new Element('div');
  new AgentChannelPanel(root as any, {
    get: async () => mutualOn, setEnabled: async enabled => { requests.push(`channel:${enabled}`); return mutualOn; },
    changed: callback => { publish = callback; return () => {}; }, error: message => requests.push(`error:${message}`),
    setInterconnect: async enabled => { requests.push(`mutual:${enabled}`); return { ...off, interconnect: { ...mutualOn.interconnect!, enabled, explicit: true } }; },
    relink: async () => { requests.push('relink'); return mutualOn; },
    undo: async id => { requests.push(`undo:${id}`); return { ...mutualOn, lastAction: { ...mutualOn.lastAction!, undo: undefined } }; },
    restore: async id => { requests.push(`restore:${id}`); return mutualOn; },
    setRecycleDays: async days => { requests.push(`days:${days}`); return mutualOn; },
  });
  await flush();
  const mutual = part(root, 'interconnect'), channel = part(root, 'enabled');
  assert.equal(mutual.checked, true); assert.equal(mutual.disabled, false);
  assert.equal(channel.checked, true); assert.equal(channel.disabled, true, 'the channel stays open while 三方互通 is on');
  assert.match(part(root, 'interconnect-status').textContent!, /不再弹窗确认.*桌宠聊天里对她说的，仍然先给你选项或弹窗确认/);
  assert.match(part(root, 'claude-code').textContent!, /已接上你的 Claude Code/);
  const undo = part(root, 'undo');
  assert.equal(undo.hidden, false); assert.match(undo.textContent!, /^撤回：把「渲染帧率」改回/);
  undo.onclick!(); await flush();
  assert.equal(part(root, 'undo').hidden, true, 'undone once');
  assert.equal(part(root, 'relink').hidden, true, 'nothing to reconnect while it is connected');
  publish({ ...mutualOn, lastAction: null, interconnect: { ...mutualOn.interconnect!, claudeCode: { state: 'removed', name: 'soft-hearts-next', message: '你的 Claude Code 里现在没有 soft-hearts-next' } } });
  assert.equal(part(root, 'relink').hidden, false);
  // After an update: re-pointed needs nothing; someone else's entry or one that cannot be read offers 「重新接上」.
  for (const [state, hidden] of [['updated', true], ['stale', false], ['unverified', false], ['linked', true]] as const) {
    publish({ ...mutualOn, lastAction: null, interconnect: { ...mutualOn.interconnect!, claudeCode: { state, name: 'soft-hearts-next', message: state } } });
    assert.equal(part(root, 'relink').hidden, hidden, state);
  }
  publish({ ...mutualOn, lastAction: null, interconnect: { ...mutualOn.interconnect!, claudeCode: { state: 'removed', name: 'soft-hearts-next', message: '你的 Claude Code 里现在没有 soft-hearts-next' } } });
  part(root, 'relink').onclick!(); await flush();
  const entry = all(root).find(node => node.dataset.recycleEntry === 'e1')!;
  assert.match(entry.children[0].textContent!, /「小桃」的聊天记忆 3 段 · 11 月 10 日前可以找回/);
  entry.children[1].onclick!(); await flush();
  const days = part(root, 'recycle-days') as any;
  assert.equal(days.value, '7');
  days.value = '14'; days.onchange(); await flush();
  days.value = '0'; days.onchange(); await flush();
  mutual.checked = false; mutual.onchange!(); await flush();
  assert.deepEqual(requests, ['undo:u1', 'relink', 'restore:e1', 'days:14', 'mutual:false'], 'an out-of-range period is not sent');
  assert.equal(mutual.checked, false); assert.equal(channel.disabled, false, 'off: the channel switch decides again');
  assert.match(part(root, 'interconnect-status').textContent!, /你关掉的，会一直记着/);
  publish({ ...mutualOn, interconnect: { ...mutualOn.interconnect!, enabled: false, explicit: false, unreadable: true } });
  assert.match(part(root, 'interconnect-status').textContent!, /读不出来/);
});

test('notices name what Claude did in one host-written line; control characters never reach the toast', () => {
  assert.equal(agentNoticeText({ title: '导入角色卡', at: 0, detail: 'aoi.json' }), '由 Claude 操作：导入角色卡（aoi.json）');
  assert.equal(agentNoticeText({ title: '载入模型', at: 0, detail: 'a\u0000\nb.pmx' }), '由 Claude 操作：载入模型（a b.pmx）');
});
