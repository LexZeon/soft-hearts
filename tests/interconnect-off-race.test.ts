// Codex T-112 第 029 轮反例（2026-11-03，固定 17f9807）：点"关闭三方互通"后、宿主的关闭还没返回时，已认证的连接提交一项
// 新的确认级请求，仍按"互通开"直接生效，关闭后结果还留着。修正：宿主收到关闭的那一刻先收回直接执行（新请求按关闭处理），
// 再保存开关、关连接；保存失败也不恢复直接执行，除非用户再打开。docs/claude/2026-11-03-three-way-interconnect.md。
// 照 Codex 的 O01（保存边界停住）/ O02（关闭后紧接一帧）相邻事件顺序，另加保存失败和真实连接正常关闭。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentChannelHost } from '../electron/agent-channel/host';
import { InterconnectStore, type InterconnectState } from '../electron/agent-channel/interconnect';
import { AGENT_CREDENTIALS_FILE } from '../electron/agent-channel/credentials';
import { type AgentConfirmRequest, type AgentToolDefinition } from '../electron/agent-channel/registry';
import { noArgs } from '../electron/agent-channel/validate';
import { FrameReader, clientProof, encodeFrame, nonce } from '../scripts/agent-channel-wire.mjs';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

type Gate = { promise: Promise<void>; resolve: () => void };

/** The save boundary of the switch, held or failing on demand (what Codex held in O01). */
class HeldStore extends InterconnectStore {
  hold: { entered: Gate; release: Gate } | null = null;
  failNext: Error | null = null;
  onSave: ((enabled: unknown) => void) | null = null;
  override async setEnabled(enabled: unknown): Promise<InterconnectState> {
    this.onSave?.(enabled);
    const hold = this.hold;
    if (hold) { this.hold = null; hold.entered.resolve(); await hold.release.promise; }
    const failure = this.failNext;
    if (failure) { this.failNext = null; throw failure; }
    return super.setEnabled(enabled);
  }
}

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sh-off-race-'));
  const effects: string[] = [], asked: AgentConfirmRequest[] = [];
  const tools: AgentToolDefinition[] = [
    { name: 'get_status', title: '读取状态', tier: 'read', validate: noArgs, run: () => ({ ok: true }) },
    // Like the app's confirm-tier settings: the commit checks the call's guard first.
    { name: 'set_realer_emotions', title: '更真实的情绪', tier: 'confirm', validate: noArgs, confirmation: () => ({ title: '打开？', detail: '确认级' }),
      run: (_input, context) => { context.check(); effects.push('realer_emotions'); return { on: true }; } },
  ];
  const store = new HeldStore(dir);
  const host = new AgentChannelHost({ profileDirectory: dir, tools, interconnect: store, confirmTimeoutMs: 200,
    confirm: async request => { asked.push(request); return true; } });
  t.after(async () => { await host.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  await host.init();
  assert.equal(host.interconnected, true, '默认开着');
  return { dir, host, store, effects, asked };
}

/** Refused as with the channel closed (the code; the text depends on where the call was stopped). */
/** I-025: with 三方互通 on a confirm-tier call carries the user's own words; these calls would run if the channel let them. */
const WORDS = { userWords: '打开更真实的情绪吧' };
const refused = (result: { ok: boolean; error?: { code: string } }) => {
  assert.equal(result.ok, false); assert.equal(result.error?.code, 'channel_off');
};

test('O01：关闭在保存边界停住时，新的确认级请求不再直接执行，也不弹窗；关闭后没有留下结果', async t => {
  const f = await fixture(t);
  const entered = deferred(), release = deferred();
  f.store.hold = { entered, release };
  const switching = f.host.setInterconnect(false);
  try {
    await entered.promise;
    assert.equal(f.store.enabled, true, '开关还没保存');
    assert.equal(f.host.interconnected, false, '点击那一刻就收回了直接执行');
    assert.equal(f.host.view().interconnect?.enabled, false, '面板也马上显示关');
    refused(await f.host.registry.call('set_realer_emotions', WORDS));
    refused(await f.host.registry.call('get_status', {}));
    assert.deepEqual(f.effects, []); assert.deepEqual(f.asked, [], '没有闪一下的确认框');
  } finally { release.resolve(); }
  const view = await switching;
  assert.equal(view.enabled, false); assert.equal(view.interconnect?.enabled, false);
  assert.deepEqual(f.effects, [], '关闭后也没有结果');
  await assert.rejects(stat(path.join(f.dir, AGENT_CREDENTIALS_FILE)), '旧令牌已撤销');
  assert.equal((await new InterconnectStore(f.dir).load()).enabled, false, '关闭已保存');
});

test('O02：不加任何延迟，关闭调用发出后紧接着的一项新请求也按关闭处理', async t => {
  const f = await fixture(t);
  let acknowledged = false;
  const switching = f.host.setInterconnect(false).then(view => { acknowledged = true; return view; });
  const overlapping = f.host.registry.call('set_realer_emotions', WORDS);
  refused(await overlapping);
  assert.equal(acknowledged, false, '观察结果时关闭还没返回');
  await switching;
  assert.deepEqual(f.effects, []); assert.deepEqual(f.asked, []);
  assert.equal(f.host.interconnected, false);
});

test('保存失败：通道照样关闭，直接执行不恢复；手动开通道后确认级逐次弹窗；用户再打开互通才恢复', async t => {
  const f = await fixture(t);
  f.store.failNext = new Error('磁盘已满');
  await assert.rejects(f.host.setInterconnect(false), /关闭没能保存（磁盘已满）.*这次已按关闭处理/);
  assert.equal(f.store.enabled, true, '文件里还是开（没能保存）');
  assert.equal(f.host.interconnected, false, '但这次运行里直接执行已收回');
  const view = f.host.view();
  assert.equal(view.enabled, false, '通道已关'); assert.equal(view.interconnect?.enabled, false);
  assert.match(view.error ?? '', /没能保存/, '面板说明发生了什么');
  await assert.rejects(stat(path.join(f.dir, AGENT_CREDENTIALS_FILE)));
  refused(await f.host.registry.call('set_realer_emotions', WORDS));
  // 回到"互通关"时的样子：用户自己打开通道，确认级每次都问。
  await f.host.setEnabled(true);
  const asked = await f.host.registry.call('set_realer_emotions', WORDS);
  assert.equal(asked.ok, true);
  assert.equal(f.asked.length, 1, '弹窗确认了'); assert.deepEqual(f.effects, ['realer_emotions']);
  // 只有用户再打开（保存成功）才恢复直接执行。
  await f.host.setInterconnect(true);
  assert.equal(f.host.interconnected, true);
  assert.equal((await f.host.registry.call('set_realer_emotions', WORDS)).ok, true);
  assert.equal(f.asked.length, 1, '这次没有弹窗：互通开着');
});

test('连点：关（停在保存）→ 开 → 关，中间那次"开"完成时也不恢复直接执行；最后是关', async t => {
  const f = await fixture(t);
  const entered = deferred(), release = deferred();
  f.store.hold = { entered, release };
  const seen: Array<[unknown, boolean]> = [];
  f.store.onSave = enabled => seen.push([enabled, f.host.interconnected]);
  const first = f.host.setInterconnect(false);
  await entered.promise;
  const again = f.host.setInterconnect(true), last = f.host.setInterconnect(false);
  release.resolve();
  await first; await again; await last;
  assert.deepEqual(seen, [[false, false], [true, false], [false, false]], '第二次"关"开始保存时，前面的"开"没有把直接执行还回来');
  assert.equal(f.host.interconnected, false); assert.equal(f.host.enabled, false);
  assert.equal((await new InterconnectStore(f.dir).load()).enabled, false);
});

/** A real client on the profile's pipe: authenticates with the token file, like the user's Claude Code does. */
async function pipeClient(dir: string) {
  const { endpoint, token } = JSON.parse(await readFile(path.join(dir, AGENT_CREDENTIALS_FILE), 'utf8'));
  const socket = net.createConnection(endpoint);
  const frames: Record<string, any>[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  const wake = () => waiters.splice(0).forEach(resolve => resolve());
  const reader = new FrameReader(frame => { frames.push(frame); wake(); }, () => {});
  socket.on('data', chunk => reader.push(chunk));
  socket.on('close', () => { closed = true; wake(); });
  socket.on('error', () => {});
  const until = async (find: () => Record<string, any> | undefined) => {
    for (;;) { const found = find(); if (found || closed) return found; await new Promise<void>(resolve => waiters.push(resolve)); }
  };
  const hello = await until(() => frames.find(frame => frame.t === 'hello'));
  const clientNonce = nonce();
  socket.write(encodeFrame({ t: 'auth', nonce: clientNonce, proof: clientProof(token, hello!.nonce, clientNonce) }));
  assert.ok(await until(() => frames.find(frame => frame.t === 'ready')), '认证通过');
  return {
    send: (id: number, tool: string, args: Record<string, unknown> = WORDS) => socket.write(encodeFrame({ t: 'call', id, tool, args })),
    result: (id: number) => until(() => frames.find(frame => frame.t === 'result' && frame.id === id)),
    closed: () => until(() => undefined).then(() => closed),
    destroy: () => socket.destroy(),
  };
}

test('真实连接正常关闭：互通开时直接执行；点关闭后紧接着的新请求不生效，连接断开、令牌撤销', async t => {
  const f = await fixture(t);
  const client = await pipeClient(f.dir);
  t.after(() => client.destroy());
  client.send(1, 'set_realer_emotions');
  const before = await client.result(1);
  assert.equal(before?.ok, true); assert.deepEqual(f.effects, ['realer_emotions']); assert.deepEqual(f.asked, [], '互通开：不弹窗');
  const switching = f.host.setInterconnect(false);
  client.send(2, 'set_realer_emotions'); // 紧接着点击之后发出
  const after = await client.result(2);
  // 结果要么是"通道已关"，要么连接先断了没有结果；绝不是 ok。
  if (after) assert.equal(after.ok === false && after.error.code, 'channel_off');
  await switching;
  assert.equal(await client.closed(), true, '连接已断开');
  assert.deepEqual(f.effects, ['realer_emotions'], '点击之后的请求没有生效'); assert.deepEqual(f.asked, []);
  await assert.rejects(stat(path.join(f.dir, AGENT_CREDENTIALS_FILE)), '令牌文件已删除');
  assert.equal(f.host.interconnected, false);
});
