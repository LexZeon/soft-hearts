import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { platformTarget, pinnedPnpm, checkNode, findOnPath, setupPlan, applicationEnvironment, packagingArguments, findUnixClaude, claudeVersion, claudeNextStep, findOtherAgents, otherAgentHint, OTHER_AGENTS } from '../scripts/setup-platform.mjs';

test('release architecture matrix includes native Windows x64 and both macOS architectures', () => {
  for (const [os, arch] of [['win32','x64'],['win32','arm64'],['darwin','arm64'],['darwin','x64'],['linux','x64']]) assert.equal(platformTarget(os,arch).arch,arch);
  for (const [os, arch] of [['win32','ia32'],['linux','arm64'],['freebsd','x64']]) assert.throws(() => platformTarget(os,arch), /Unsupported/);
});
test('runtime and package manager versions are bounded', () => {
  assert.equal(pinnedPnpm('pnpm@11.25.0'), '11.25.0');
  for (const value of ['pnpm@latest','pnpm@^11.25.0','npm@11.25.0']) assert.throws(() => pinnedPnpm(value));
  checkNode('22.12.0'); checkNode('24.0.0');
  for (const value of ['22.11.9','20.99.0','invalid']) assert.throws(() => checkNode(value));
});
test('PATH lookup skips empty entries, preserves order, and asks executable predicate', async () => {
  const checked=[];
  const env={PATH:['','/first','/second',''].join(path.delimiter)};
  const found=await findOnPath('claude',env,async f=>{checked.push(f);return f===path.resolve('/second/claude');});
  assert.equal(found,path.resolve('/second/claude'));
  assert.deepEqual(checked,[path.resolve('/first/claude'),path.resolve('/second/claude')]);
});
test('check-only has no commands, no-launch preserves preparation, Windows refuses the Unix entry', () => {
  const input={platform:'darwin',arch:'arm64',nodeVersion:'22.12.0',packageManager:'pnpm@11.25.0',args:['--check-only']};
  assert.deepEqual(setupPlan(input),{version:'11.25.0',commands:[],launch:false});
  const noLaunch=setupPlan({...input,platform:'linux',arch:'x64',args:['--no-launch']});
  assert.deepEqual(noLaunch.commands,[['install','--frozen-lockfile'],['run','build']]);
  assert.equal(noLaunch.launch,false);
  assert.equal(setupPlan({...input,args:[]}).launch,true);
  assert.throws(()=>setupPlan({...input,platform:'win32',arch:'x64'}),/cannot replace a refused/);
  assert.throws(()=>setupPlan({...input,args:['--force']}),/Usage/);
});
test('app child environment preserves own login location and clears inherited mode/policy flags', () => {
  const original={CLAUDE_CONFIG_DIR:'/own/home',PATH:'/tools',ELECTRON_RUN_AS_NODE:'1',PSExecutionPolicyPreference:'test',OTHER:'keep'};
  const child=applicationEnvironment(original,path.resolve('/node/bin/node'),'/tools/claude');
  assert.equal(child.CLAUDE_CONFIG_DIR,original.CLAUDE_CONFIG_DIR);
  assert.equal(child.CLAUDE_PATH,'/tools/claude');
  assert.equal(child.OTHER,'keep');
  assert.equal(child.ELECTRON_RUN_AS_NODE,undefined);
  assert.equal(child.PSExecutionPolicyPreference,undefined);
  assert.equal(original.ELECTRON_RUN_AS_NODE,'1');
});
test('packaging is native, closed and never implicitly publishes', () => {
  for(const [os,arch,flag,format] of [['win32','x64','--win','portable'],['win32','arm64','--win','portable'],['darwin','x64','--mac','zip'],['darwin','arm64','--mac','zip'],['linux','x64','--linux','tar.gz']]) {
    assert.deepEqual(packagingArguments(os,arch,[flag,format,`--${arch}`]),[flag,format,`--${arch}`,'--publish','never']);
  }
  assert.deepEqual(packagingArguments('linux','x64',['--dir']),['--dir','--x64','--publish','never']);
  for(const args of [['--mac','zip','--x64'],['--linux','AppImage','--x64'],['--linux','tar.gz','--arm64'],['--linux','tar.gz','--x64','--publish','always']]) assert.throws(()=>packagingArguments('linux','x64',args));
});
// Fake file system and fake PATH only: no real claude is ever run.
const fakeIo = executables => ({
  stat: async f => { if (!executables.includes(f)) throw new Error('ENOENT'); return { isFile: () => true }; },
  access: async () => undefined,
});
test('Claude Code on PATH is found; PATH wins over install folders; CLAUDE_PATH wins over PATH', async () => {
  const onPath = path.posix.resolve('/opt/tools/claude');
  const local = '/home/u/.local/bin/claude';
  const io = fakeIo([onPath, local, '/explicit/claude']);
  const base = { platform: 'linux', home: '/home/u', io };
  assert.deepEqual(await findUnixClaude({ PATH: '/nope:/opt/tools' }, base), { status: 'found', path: onPath });
  assert.deepEqual(await findUnixClaude({ PATH: '/nope' }, base), { status: 'found', path: local });
  assert.equal((await findUnixClaude({ PATH: '/opt/tools', CLAUDE_PATH: '/explicit/claude' }, base)).path, path.posix.resolve('/explicit/claude'));
});
test('Claude Code missing gives a clear next step for the adapting agent', async () => {
  const result = await findUnixClaude({ PATH: '/nope' }, { platform: 'darwin', home: '/home/u', io: fakeIo([]) });
  assert.deepEqual(result, { status: 'missing', path: null });
  const hint = claudeNextStep(result.status);
  assert.match(hint, /CLAUDE_PATH/);
  assert.match(hint, /docs\/PORTING\.md section 5/);
});
test('an invalid CLAUDE_PATH stops with no fallback even when PATH has claude', async () => {
  const io = fakeIo([path.posix.resolve('/opt/tools/claude')]);
  const result = await findUnixClaude({ PATH: '/opt/tools', CLAUDE_PATH: '/typo/claude' }, { platform: 'linux', home: '/home/u', io });
  assert.deepEqual(result, { status: 'invalid-override', path: null });
  assert.match(claudeNextStep(result.status), /not an executable/);
});
test('version check reads only a version string and never throws', async () => {
  assert.equal(await claudeVersion('/x/claude', async () => '2.1.316 (Claude Code)\n'), '2.1.316');
  assert.equal(await claudeVersion('/x/claude', async () => 'garbage'), 'unknown');
  assert.equal(await claudeVersion('/x/claude', async () => { throw new Error('boom'); }), 'unknown');
});

test('other agents are recognised on PATH from a small table, only as a hint', async () => {
  const dsh = path.resolve('/bin2/dsh');
  const found = await findOtherAgents({ PATH: [path.resolve('/bin1'), path.resolve('/bin2')].join(path.delimiter) }, async f => f === dsh);
  assert.deepEqual(found.map(a => a.id), ['deepseek-harness']);
  assert.match(otherAgentHint(found), /Found DeepSeek Harness.*PORTING.*continues/);
  assert.match(otherAgentHint([]), /Install Claude Code.*PORTING/);
  const extra = await findOtherAgents({ PATH: path.resolve('/b') }, async f => f === path.resolve('/b/foo'), [...OTHER_AGENTS, { id: 'x', command: 'foo', label: 'Foo' }]);
  assert.deepEqual(extra.map(a => a.label), ['Foo']);
});
