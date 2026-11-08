// 退出时等「允许记录」开关的存盘写完，但有上限（electron/settle-within.ts；main.ts 的 before-quit 里用）。
// 真实的 UserProfileStore 在临时目录里；"重启"= 新建一个 store 读同一个目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserProfileStore } from '../electron/user-profile';
import { QUIT_SETTLE_LIMIT_MS, settleWithin } from '../electron/settle-within';

const scope = { characterId: 'character-a', providerScope: 'provider-a' };

async function withDirectory(run: (directory: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quit-settle-'));
  try { await run(path.join(root, 'profiles')); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

async function restartedValue(directory: string): Promise<boolean | undefined> {
  const next = new UserProfileStore(directory);
  try { return (await next.activate(scope))?.enabled; }
  finally { await next.settled().catch(() => undefined); next.dispose(); }
}

test('开关切换后立刻走退出流程：等存盘写完，重启读到新值', async () => {
  await withDirectory(async directory => {
    const store = new UserProfileStore(directory);
    await store.activate(scope);
    store.setEnabled(true);
    assert.equal(await settleWithin(store.settled()), 'settled');
    store.dispose();
    assert.equal(await restartedValue(directory), true, '重启后是新值（开着）');

    const again = new UserProfileStore(directory);
    await again.activate(scope);
    again.setEnabled(false);
    assert.equal(await settleWithin(again.settled()), 'settled');
    again.dispose();
    assert.equal(await restartedValue(directory), false, '关掉也一样');
  });
});

test('存盘卡住：退出最多等上限，然后继续；存盘失败也不拦退出', async () => {
  let fire!: () => void; let cleared = false;
  const stuck = new Promise<void>(() => {});
  const pending = settleWithin(stuck, QUIT_SETTLE_LIMIT_MS, (callback, ms) => {
    assert.equal(ms, QUIT_SETTLE_LIMIT_MS); fire = callback; return { clear: () => { cleared = true; } };
  });
  let done = false; void pending.then(() => { done = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(done, false, '上限没到，还在等');
  fire();
  assert.equal(await pending, 'timeout');
  assert.equal(cleared, true, '定时器收掉，不拖住进程');
  assert.equal(await settleWithin(Promise.reject(new Error('disk full'))), 'settled');
  assert.equal(await settleWithin(undefined), 'settled', '没有画像存储（还没启动好）：直接过');
  assert.ok(QUIT_SETTLE_LIMIT_MS <= 2_000, '上限不超过两秒');
});

test('真实时间下卡住的存盘：退出被拖住不超过上限（容许一点调度误差）', async () => {
  const started = Date.now();
  const outcome = await settleWithin(new Promise<void>(() => {}), 200);
  const took = Date.now() - started;
  assert.equal(outcome, 'timeout');
  assert.ok(took >= 150 && took < 1_000, `${took} ms`);
});
