import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { platformTarget, pinnedPnpm, checkNode, findOnPath, setupPlan, applicationEnvironment, packagingArguments } from '../scripts/setup-platform.mjs';

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
  const found=await findOnPath('codex',env,async f=>{checked.push(f);return f===path.resolve('/second/codex');});
  assert.equal(found,path.resolve('/second/codex'));
  assert.deepEqual(checked,[path.resolve('/first/codex'),path.resolve('/second/codex')]);
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
  const original={CODEX_HOME:'/own/home',PATH:'/tools',ELECTRON_RUN_AS_NODE:'1',PSExecutionPolicyPreference:'test',OTHER:'keep'};
  const child=applicationEnvironment(original,path.resolve('/node/bin/node'),'/tools/codex');
  assert.equal(child.CODEX_HOME,original.CODEX_HOME);
  assert.equal(child.CODEX_PATH,'/tools/codex');
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
