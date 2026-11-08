import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {UiLanguageStore} from '../electron/ui-language';

test('separate language sidecar preserves legacy files and applies the preference only after a new load',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'soft-hearts-ui-language-'));
 const legacy=path.join(directory,'settings.json'),file=path.join(directory,'ui-language-settings.json');
 const original='{"version":1,"privateFixture":"preserve"}\n';await writeFile(legacy,original);
 const store=new UiLanguageStore(file,'zh-CN');assert.deepEqual(await store.load(),{preference:'system',language:'zh-CN'});
 assert.deepEqual(await readdir(directory),['settings.json']);
 assert.deepEqual(await store.persist('en'),{preference:'en',language:'zh-CN'});
 assert.deepEqual(store.current,{preference:'en',language:'zh-CN'});
 assert.deepEqual(await new UiLanguageStore(file,'zh-CN').load(),{preference:'en',language:'en'});
 assert.equal(await readFile(legacy,'utf8'),original);
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{version:1,preference:'en'});
});

test('malformed sidecars are preserved and failed writes do not adopt an unsaved preference',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'soft-hearts-ui-language-invalid-'));
 const file=path.join(directory,'ui-language-settings.json'),original='{"version":1,"preference":"execute"}';
 await writeFile(file,original);
 const store=new UiLanguageStore(file,'en-US',async()=>{throw Error('fixture disk unavailable');});
 assert.deepEqual(await store.load(),{preference:'system',language:'en',notice:'preference-unavailable'});
 assert.equal(await readFile(file,'utf8'),original);
 assert.throws(()=>store.persist({preference:'en'}));
 await assert.rejects(store.persist('zh-CN'),/fixture disk unavailable/);
 assert.deepEqual(store.current,{preference:'system',language:'en',notice:'preference-unavailable'});
 assert.equal(await readFile(file,'utf8'),original);
});
