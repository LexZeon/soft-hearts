import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { constants } from 'node:fs';
import { discoverCodex } from '../scripts/codex-discovery.mjs';

function fixture(files = {}, directories = {}) {
  const calls=[];
  return { calls, io: {
    async stat(file) { calls.push(['stat',file]); if (!files[file]) throw Error('missing'); return { isFile:()=>files[file].kind!=='directory',mtimeMs:files[file].time??1 }; },
    async access(file,mode) { calls.push(['access',file,mode]); if (!files[file] || (mode===constants.X_OK && files[file].executable===false)) throw Error('denied'); },
    async readdir(file) { calls.push(['readdir',file]); if (!directories[file]) throw Error('missing'); return directories[file].map(name=>({name,isDirectory:()=>true})); },
  }};
}

test('explicit missing/nonexecutable override never consults another path or home', async () => {
  for(const platform of ['win32','darwin','linux']) {
    const f=fixture({'/fallback/codex':{}});
    assert.deepEqual(await discoverCodex({platform,env:{CODEX_PATH:'/missing',PATH:'/fallback'},home:'/synthetic',io:f.io}),{status:'invalid-override',path:null});
    assert.deepEqual(f.calls,[['stat','/missing']]);
  }
  const f=fixture({'/explicit':{executable:false}});
  assert.equal((await discoverCodex({platform:'darwin',env:{CODEX_PATH:'/explicit'},home:'/synthetic',io:f.io})).status,'invalid-override');
});
test('explicit executable identity wins without reading any auth or configuration', async () => {
  const f=fixture({'/chosen/codex':{}});
  assert.deepEqual(await discoverCodex({platform:'linux',env:{CODEX_PATH:'/chosen/codex',CODEX_HOME:'/private/auth'},home:'/synthetic',io:f.io}),{status:'found',path:'/chosen/codex'});
  assert.equal(f.calls.some(row=>row[1].includes('/private')),false);
});
test('a valid relative explicit override is frozen as an absolute executable identity', async () => {
  const f=fixture({'relative/codex':{}});
  assert.equal((await discoverCodex({platform:'linux',env:{CODEX_PATH:'relative/codex'},home:'/synthetic',io:f.io})).path,path.posix.resolve('relative/codex'));
});
test('Unix PATH order and native separators are independent of the test host', async () => {
  const f=fixture({'/two/codex':{}});
  assert.deepEqual(await discoverCodex({platform:'linux',env:{PATH:':/one:/two:'},home:'/synthetic',io:f.io}),{status:'found',path:'/two/codex'});
  assert.deepEqual(f.calls.filter(row=>row[0]==='stat').map(row=>row[1]),['/one/codex','/two/codex']);
});
test('macOS GUI fallback finds standard Apple Silicon CLI path without a shell', async () => {
  const f=fixture({'/opt/homebrew/bin/codex':{}});
  assert.deepEqual(await discoverCodex({platform:'darwin',env:{PATH:'/usr/bin'},home:'/synthetic',io:f.io}),{status:'found',path:'/opt/homebrew/bin/codex'});
  assert.equal(f.calls.some(row=>row[0]==='readdir'),false);
});
test('Linux GUI fallback finds user standalone CLI; nonexecutables and directories are rejected', async () => {
  const f=fixture({'/synthetic/.local/bin/codex':{}});
  assert.equal((await discoverCodex({platform:'linux',env:{},home:'/synthetic',io:f.io})).path,'/synthetic/.local/bin/codex');
  const denied=fixture({'/synthetic/.local/bin/codex':{executable:false},'/usr/local/bin/codex':{kind:'directory'}});
  assert.deepEqual(await discoverCodex({platform:'linux',env:{},home:'/synthetic',io:denied.io}),{status:'missing',path:null});
});
test('Windows PATH and newest existing desktop binary fallback are preserved', async () => {
  const p=path.win32,bin=p.join('C:\\AppData','OpenAI','Codex','bin');
  const older=p.join(bin,'older','codex.exe'),newer=p.join(bin,'newer','codex.exe');
  const f=fixture({[older]:{time:1},[newer]:{time:2}}, {[bin]:['older','missing','newer']});
  assert.equal((await discoverCodex({platform:'win32',env:{PATH:';"C:\\Tools";;',LOCALAPPDATA:'C:\\AppData'},io:f.io})).path,newer);
  assert.equal(f.calls[0][1],'C:\\Tools\\codex.exe');
  assert.equal(f.calls.filter(row=>row[0]==='access').every(row=>row[2]===constants.F_OK),true);
});
