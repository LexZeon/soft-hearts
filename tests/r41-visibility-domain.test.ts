import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionCommandHost,type CommandCommitResult} from '../electron/companion-command-host';
import {classifyCompanionCommand,formatCompanionCommandReceipt} from '../electron/companion-command-intent';
import type {CompanionCommandAction,CompanionCommandCandidate,CompanionCommandView} from '../shared/companion-commands';

const visible=(value:boolean):CompanionCommandAction=>({actionId:'pet.set-visible',parameters:{value}});
function fixture(candidate:CompanionCommandCandidate={kind:'explicit',action:visible(true)}){
  let desired=false,native=false,visibilityRevision=0,topmost=false,topRevision=0,context='target-one',ownerVisible=true,petSender=false,now=0,n=0;
  const calls:Array<{id:string;value:boolean}>=[],views:CompanionCommandView[]=[];
  let run=<T>(job:()=>Promise<T>)=>job();
  let commit=(value:boolean,id:CompanionCommandAction['actionId']):Promise<CommandCommitResult>=>{
    calls.push({id,value});
    if(id==='pet.set-visible'){const persistence=desired===value?'unchanged':'saved';desired=value;native=value;visibilityRevision++;if(petSender&&!value)ownerVisible=false;host.refresh();return Promise.resolve({persistence,presentation:'applied',value,nativeValue:native});}
    topmost=value;topRevision++;return Promise.resolve({persistence:'saved',presentation:'applied',value});
  };
  const host=new CompanionCommandHost({now:()=>now,id:()=>`c${++n}`,
    target:(owner,id,ownHide)=>{
      if(owner!==7||!context||(!ownerVisible&&!(petSender&&id==='pet.set-visible'&&ownHide)))return null;
      if(id==='pet.set-always-on-top'&&!native)return null;
      return {contextId:context,value:id==='pet.set-visible'?desired:topmost,revision:id==='pet.set-visible'?visibilityRevision:topRevision};
    },classify:input=>{assert.equal(input.currentVisible,ownerVisible?desired:undefined);return candidate;},
    enqueue:job=>run(job),commit:(value,id)=>commit(value,id),format:r=>`${r.actionId??'topmost'}:${r.persistence}/${r.presentation}`,publish:v=>views.push(v)});
  return{host,calls,views,admit:(id='human',source:'current-human'|'quoted'|'model'|'screen'|'history'='current-human')=>host.admit({requestId:id,owner:7,window:petSender?'pet':'controls',text:'显示桌宠',source}),
    setCandidate:(value:CompanionCommandCandidate)=>{candidate=value;},state:()=>({desired,native,visibilityRevision,topmost}),
    manualVisibility:(value:boolean)=>{desired=value;native=value;visibilityRevision++;},manualTop:()=>{topmost=!topmost;topRevision++;},
    nativeRevision:()=>{visibilityRevision++;},context:(value:string)=>{context=value;},hideOwner:()=>{ownerVisible=false;},petSender:()=>{petSender=true;},
    enqueue:(fn:typeof run)=>{run=fn;},commit:(fn:typeof commit)=>{commit=fn;},time:(value:number)=>{now=value;}};
}
const clarify:CompanionCommandCandidate={kind:'clarify',prompt:'显示还是隐藏桌宠？',choices:[{label:'显示',action:visible(true)},{label:'隐藏',action:visible(false)}]};

test('visibility domain can show an existing hidden target while topmost remains unavailable, and consumes current human once',async()=>{
  const f=fixture(),ticket=f.admit()!;assert.ok(ticket);const view=await f.host.run(ticket);
  assert.equal(view?.receipt?.actionId,'pet.set-visible');assert.equal(view?.receipt?.status,'saved');assert.equal(view?.receipt?.nativeValue,true);
  assert.deepEqual(f.calls,[{id:'pet.set-visible',value:true}]);assert.equal(await f.host.run(ticket),null);assert.equal(f.admit(),null);
  for(const source of ['quoted','model','screen','history']as const)assert.equal(f.admit(source,source),null);
  assert.equal(f.calls.length,1);
});
test('visibility choices keep independent relevant CAS, reject manual/native changes, and ignore unrelated topmost state',async()=>{
  for(const conflict of ['desiredABA','native']as const){const f=fixture(clarify),view=await f.host.run(f.admit()!);if(conflict==='desiredABA'){f.manualVisibility(true);f.manualVisibility(false);}else f.nativeRevision();
    assert.equal((await f.host.choose(7,{requestId:'human',choiceId:view!.choices[0].choiceId}))?.receipt?.status,'conflict');assert.equal(f.calls.length,0);}
  const f=fixture(clarify),view=await f.host.run(f.admit()!);f.manualTop();
  assert.equal((await f.host.choose(7,{requestId:'human',choiceId:view!.choices[0].choiceId}))?.receipt?.status,'saved');assert.equal(f.calls.length,1);
});
test('an issued own pet hide retains its committed receipt through refresh, without admitting hidden controls',async()=>{
  const f=fixture({kind:'explicit',action:visible(false)});f.manualVisibility(true);f.petSender();
  const view=await f.host.run(f.admit()!);assert.equal(view?.receipt?.status,'saved');assert.equal(view?.receipt?.nativeValue,false);assert.equal(view?.receipt?.value,false);assert.equal(f.calls.length,1);
  const controls=fixture();controls.hideOwner();assert.equal((await controls.host.run(controls.admit()!))?.receipt?.status,'rejected');assert.equal(controls.calls.length,0);
});
test('visibility expiry, cancellation, wrong owner and queued context change never issue a commit',async()=>{
  const f=fixture(clarify),view=await f.host.run(f.admit()!);assert.equal(await f.host.choose(8,{requestId:'human',choiceId:view!.choices[0].choiceId}),null);
  assert.equal((await f.host.choose(7,{requestId:'human',choiceId:view!.choices[2].choiceId}))?.receipt?.status,'cancelled');assert.equal(f.calls.length,0);
  const late=fixture();late.enqueue(async job=>{late.context('replacement');return job();});assert.equal((await late.host.run(late.admit()!))?.receipt?.status,'expired');assert.equal(late.calls.length,0);
  const expired=fixture(clarify),offer=await expired.host.run(expired.admit()!);expired.time(60000);assert.equal((await expired.host.choose(7,{requestId:'human',choiceId:offer!.choices[0].choiceId}))?.receipt?.status,'expired');assert.equal(expired.calls.length,0);
});
test('visibility save/native facts remain distinct and a genuinely invalidated issued write never publishes late success',async()=>{
  const f=fixture();f.commit(async(value,id)=>({persistence:'saved',presentation:'failed',value,nativeValue:false}));
  const receipt=(await f.host.run(f.admit()!))!.receipt!;assert.equal(receipt.actionId,'pet.set-visible');assert.equal(receipt.persistence,'saved');assert.equal(receipt.presentation,'failed');assert.equal(receipt.nativeValue,false);
  const late=fixture();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
  late.commit(async value=>{entered();await wait;return{persistence:'saved',presentation:'applied',value,nativeValue:value};});const running=late.host.run(late.admit()!);await started;late.host.invalidate();release();assert.equal(await running,null);assert.ok(!late.views.some(v=>v.receipt?.status==='saved'));
});
test('visibility action schema stays closed and clarification cannot mix domains',()=>{
  for(const candidate of [{kind:'explicit',action:{...visible(true),confirmed:true}},{kind:'explicit',action:{actionId:'pet.set-visible',parameters:{value:'true'}}},{kind:'clarify',prompt:'mixed',choices:[{label:'show',action:visible(true)},{label:'top',action:{actionId:'pet.set-always-on-top',parameters:{value:false}}}]}]){
    const f=fixture(candidate as CompanionCommandCandidate);assert.throws(()=>f.admit());assert.equal(f.calls.length,0);
  }
});
test('unavailable existing pet is refused from trusted saved intent without any provider or native commit',async()=>{
  let commits=0;const host=new CompanionCommandHost({now:()=>0,id:()=>'',target:()=>null,classify:classifyCompanionCommand,
    format:formatCompanionCommandReceipt,enqueue:async job=>job(),commit:async()=>{commits++;throw Error('No target');},publish:()=>{}});
  const ticket=host.admit({requestId:'not-ready',owner:7,window:'controls',text:'显示桌宠',source:'current-human',currentVisible:true});
  assert.ok(ticket);const receipt=(await host.run(ticket))!.receipt!;
  assert.equal(receipt.actionId,'pet.set-visible');assert.equal(receipt.status,'rejected');assert.equal(receipt.persistence,'not-committed');assert.equal(receipt.presentation,'not-requested');assert.equal(commits,0);assert.ok(receipt.message);
  const legacy=host.admit({requestId:'legacy-unavailable',owner:7,window:'controls',text:'保持桌宠置顶',source:'current-human',currentVisible:true});
  assert.ok(legacy);const oldReceipt=(await host.run(legacy))!.receipt!;assert.equal(oldReceipt.status,'expired');assert.equal(oldReceipt.actionId,undefined);assert.equal(commits,0);
});
