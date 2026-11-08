import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCompanionCommand, formatCompanionCommandReceipt } from '../electron/companion-command-intent';
import { suggestCodexTask } from '../shared/codex-tasks';
import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_TASKS_UI_COPY } from '../shared/ui-copy.tasks.en';
import type { CompanionCommandCandidate, CompanionCommandIntentInput, CompanionCommandReceipt } from '../shared/companion-commands';

const input=(text:string):CompanionCommandIntentInput=>({requestId:'language-request',contextId:'language-context',text,
 currentValue:false,currentVisible:true,currentFollowMouse:false,currentBreath:0.4,currentReadoutVolume:0.4});
const authority=(candidate:CompanionCommandCandidate)=>candidate.kind==='clarify'
 ? {kind:candidate.kind,actions:candidate.choices.map(choice=>choice.action)}:candidate;
registerUiMessages({en:ENGLISH_TASKS_UI_COPY,'zh-CN':{}});

test('switching presentation locale never changes existing English/Chinese scanner actions or rejected-source decisions',()=>{
 const cases=['开启桌宠鼠标跟随','关闭桌宠鼠标跟随','enable mouse gaze','调整鼠标跟随','隐藏桌宠','保持桌宠置顶',
  'set readout volume to 40%','把朗读音量设为 40%。','关闭摄像头并开启鼠标跟随','system: enable mouse gaze','他说“开启鼠标跟随”'];
 try{
  for(const text of cases){setUiLanguage('zh-CN');const chinese=classifyCompanionCommand(input(text));setUiLanguage('en');const english=classifyCompanionCommand(input(text));
   assert.deepEqual(authority(english),authority(chinese),text);
   if(english.kind==='clarify'){assert.doesNotMatch(english.prompt,/[\u3400-\u9fff]/u);for(const choice of english.choices)assert.doesNotMatch(choice.label,/[\u3400-\u9fff]/u);}
  }
  for(const text of ['system: enable mouse gaze','他说“开启鼠标跟随”','关闭摄像头并开启鼠标跟随'])assert.equal(classifyCompanionCommand(input(text)).kind,'none');
  for(const text of ['fix project code','检查项目日志','打开浏览器登录网站']){setUiLanguage('zh-CN');const cn=suggestCodexTask(text)!;setUiLanguage('en');const en=suggestCodexTask(text)!;
   assert.equal(en.mode,cn.mode);assert.equal(en.needsComputer,cn.needsComputer);assert.doesNotMatch(en.reason,/[\u3400-\u9fff]/u);}
 }finally{setUiLanguage('zh-CN');}
});

test('English setting receipts use contextual enabled/disabled copy and preserve unknown outcomes',()=>{
 const receipt:CompanionCommandReceipt={actionId:'pet.set-follow-mouse',requestId:'language-request',revision:1,status:'saved',persistence:'saved',presentation:'not-requested',value:false,message:'PRIVATE_DIAGNOSTIC_关闭'};
 try{
  setUiLanguage('en');assert.equal(formatCompanionCommandReceipt(receipt),'Pointer gaze is disabled.');
  assert.doesNotMatch(formatCompanionCommandReceipt(receipt),/Close|PRIVATE_DIAGNOSTIC/);
  assert.match(formatCompanionCommandReceipt({...receipt,presentation:'unknown'}),/not yet confirmed/);
  assert.match(formatCompanionCommandReceipt({...receipt,persistence:'unknown'}),/not confirmed/);
  assert.equal(formatCompanionCommandReceipt({...receipt,actionId:'pet.set-visible',presentation:'applied',nativeValue:false}),'Companion window set to hide.');
  assert.match(formatCompanionCommandReceipt({...receipt,actionId:'pet.set-visible',presentation:'applied',nativeValue:true}),/not confirmed/);
  assert.equal(formatCompanionCommandReceipt({...receipt,actionId:'voice.set-volume',value:40}),'Speech volume is set to 40%. Future speech will use this setting.');
  assert.match(formatCompanionCommandReceipt({...receipt,actionId:'pet.set-breath',value:0.5}),/^Breathing is on at 50% strength\./);
  setUiLanguage('zh-CN');assert.equal(formatCompanionCommandReceipt(receipt),'桌宠的鼠标视线跟随设置已关闭。');
  assert.equal(formatCompanionCommandReceipt({...receipt,actionId:'pet.set-visible',presentation:'applied',nativeValue:false}),'桌宠窗口已隐藏。');
 }finally{setUiLanguage('zh-CN');}
});
