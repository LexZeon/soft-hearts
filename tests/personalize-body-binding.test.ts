import test from 'node:test';import assert from 'node:assert/strict';
import { bodyPoseBinding,bodyPoseChoices } from '../shared/personalize-body-bindings';
test('only the adopted Gene fixed pose resolves with its exact source and three rotation properties',()=>{
 const target='0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37';
 const choices=bodyPoseChoices(target);assert.equal(choices.length,1);
 assert.equal(choices[0].sourceSha,'88c9c426eb725ab6cb3448df2d614df4a020f5078d6814c92b41d6dd79b90ad7');
 assert.equal(choices[0].qualifiedStrength,.5);assert.deepEqual(choices[0].properties.map(p=>[p.boneIndex,p.boneName]),[[17,'左肩'],[18,'左腕'],[21,'左ひじ']]);
 assert.deepEqual(bodyPoseBinding('body.gene-left-arm-soft-bend',target),choices[0]);
 assert.equal(bodyPoseBinding('body.gene-left-arm-soft-bend','0'.repeat(64)),null);
 assert.deepEqual(bodyPoseChoices('0'.repeat(64)),[]);
});
