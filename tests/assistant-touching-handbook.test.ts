// T-250 (Codex trial): "我想摸摸她的头、喂一个零食，入口在哪里？" must reach the exact path in the shipped manuals, not a guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppTools } from '../electron/safety/agent-channel/app-tools';
import type { AgentAppBridge } from '../electron/safety/agent-channel/app-tools';
import { handbookDocsReader } from '../electron/safety/assistant/docs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = { signal: new AbortController().signal, check: () => {}, offerUndo: () => {} };
const tool = createAppTools({} as AgentAppBridge, { docs: handbookDocsReader(root) }).find(item => item.name === 'read_handbook')!;
const handbook = async (args: unknown) => tool.run(await (tool.prepare?.(tool.validate(args)) ?? tool.validate(args)), context) as Promise<unknown>;

test('read_handbook finds the pat, pinch, feeding and hand-holding paths (docs/touching-her.md)', async () => {
  for (const query of ['喂零食', '我想摸摸她的头、喂一个零食，入口在哪里', '摸摸她的头怎么摸', '捏脸怎么捏', '牵手怎么牵'])
    assert.ok(JSON.stringify(await handbook({ find: query })).includes('touching-her'), query);
  const page = JSON.stringify(await Promise.all(['拖到嘴边松开', '头顶', '脸颊 左键', '点一下'].map(find => handbook({ doc: 'touching-her', find }))));
  for (const word of ['拖', '嘴边', '松开', '头顶', '脸颊', '左键', '点一下']) assert.ok(page.includes(word), word);
});

test('read_handbook finds the pull steps for "拉她的手" and says how they differ from holding hands (T-252)', async () => {
  for (const query of ['拉她的手', '按住她的手拖', '拉她', '拉她的头'])
    assert.ok(JSON.stringify(await handbook({ find: query })).includes('touching-her'), query);
  const page = JSON.stringify(await handbook({ doc: 'touching-her', find: '拉她' }));
  assert.ok(JSON.stringify(await handbook({ doc: 'touching-her', find: 'Unbound 迈步' })).includes('迈步'));
  for (const word of ['按住', '拖', '手', '身体', '头', '腿', '睡着', '镜头', '牵手']) assert.ok(page.includes(word), word);
});
