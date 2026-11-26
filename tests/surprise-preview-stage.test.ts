import test from 'node:test';import assert from 'node:assert/strict';
import { surpriseSample } from '../src/mood/surprise-preview-overlay';
import { SURPRISE_CLIP_ID, SHY_CLIP_ID, SURPRISE_MODEL_SHA, SURPRISE_REVISION } from '../shared/initiative/surprise-preview';

const view={id:'test-host-lease',clipId:SURPRISE_CLIP_ID,revision:SURPRISE_REVISION,targetModelSha:SURPRISE_MODEL_SHA,modelUrl:'asset://gene',expiresAt:Date.now()+100000};
function globals(desktop:Record<string,unknown>){const oldDocument=globalThis.document,oldWindow=globalThis.window;
 Object.assign(globalThis,{document:{hidden:false},window:{desktop}});return()=>{Object.assign(globalThis,{document:oldDocument,window:oldWindow});};}

test('shy samples are distinct, bounded and reject foreign clip identities',()=>{
 assert.notDeepEqual(surpriseSample(500,SHY_CLIP_ID),surpriseSample(500));
 assert.equal(surpriseSample(850,SHY_CLIP_ID)!.eye_wide,0);
 assert.equal(surpriseSample(900,SHY_CLIP_ID)!.torso_z_degrees,1.1);
 assert.equal(surpriseSample(1800,SHY_CLIP_ID),null);assert.equal(surpriseSample(200,'foreign'),null);
});
