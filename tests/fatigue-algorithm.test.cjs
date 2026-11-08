const assert=require('node:assert/strict');
const {test}=require('node:test');
// The model now imports its rhythm (I-022, shared/behaviors/sleep-rhythm/), so it is loaded through the test runner's own loader.
const {createFatigue,advanceFatigue,acceptWakeEvent,fatigueSnapshot,DEFAULT_FATIGUE_PARAMETERS:P}=require('../shared/fatigue.ts');
// The two offline tests below pin the behaviour before I-022 (A/F frozen off screen, at most 2 hours): its parameters are the fake.
const {originalFatigueParameters}=require('../shared/behaviors/sleep-rhythm/fake.ts');
const O=originalFatigueParameters(P);
const channels={D:50,O:50,E:50,N:50,C:50},blockers={chat:false,tts:false,manualMotion:false};
const clock=(monotonicMs,localMinute=900)=>({monotonicMs,localMinute});
const input=(ms,patch={})=>({clock:clock(ms),channels,baseline:channels,blockers,mode:'active',...patch});
const create=(initial={},p=P)=>createFatigue(clock(0),initial,p);
const step=(s,ms,patch={},p=P)=>advanceFatigue(s,input(s.monotonicMs+ms,patch),p);
function run(s,ms,patch={},p=P){for(let left=ms;left>0;){const dt=Math.min(1000,left);s=step(s,dt,patch,p);left-=dt;}return s;}
test('pure frozen serializable state/snapshot preserves separate variables',()=>{
 const s=create(),copy=JSON.stringify(s),out=step(s,1000);assert.equal(JSON.stringify(s),copy);assert.ok(Object.isFrozen(s)&&Object.isFrozen(s.seen));assert.ok(Object.isFrozen(fatigueSnapshot(out)));assert.deepEqual(JSON.parse(JSON.stringify(out)),out);assert.equal(out.version,1);
});
test('invalid clocks/channels/baselines/parameters fail rather than injecting energy',()=>{
 for(const c of [clock(NaN),clock(-1),clock(0,1440),clock(Infinity)])assert.throws(()=>createFatigue(c));
 for(const patch of [{channels:{...channels,N:Infinity}},{baseline:{...channels,D:0}},{blockers:{...blockers,chat:0}},{mode:'frame'}])assert.throws(()=>step(create(),1000,patch));
 for(const patch of [{maxW:NaN},{wakeTauMs:0},{sleepEnter:.2},{pressureWeight:.5},{maxPhaseCorrectionPerSecond:2}])assert.throws(()=>create({}, {...P,...patch}));
});
test('active A increases exponentially, sleeping A rests; no F jump beyond rate',()=>{
 const awake=create({A:.6,F:.5}),sleep=create({A:.6,F:.5,phase:'asleep'});const a=step(awake,60000),r=step(sleep,60000);
 assert.ok(Math.abs(a.A-(1-.4*Math.exp(-60000*P.wakeRateDay/P.wakeTauMs)))<1e-12); // 15:00 is day: I-043 day paceassert.ok(Math.abs(r.A-.6*Math.exp(-60000/P.restTauMs))<1e-12);
 assert.ok(Math.abs(a.F-awake.F)<=.12+1e-12);assert.ok(r.A<sleep.A);
});
test('clock rollback does not lower high water or re-integrate time',()=>{
 const s=step(create(),30000),back=advanceFatigue(s,input(10000));assert.equal(back.A,s.A);assert.equal(back.F,s.F);assert.equal(back.monotonicMs,30000);
 const catchup=advanceFatigue(back,input(30000));assert.equal(catchup.A,s.A);assert.equal(step(catchup,1000).monotonicMs,31000);
});
test('forward stalls integrate only bounded duration, not full wall jump',()=>{
 const s=create({A:.2,F:.2});const jump=advanceFatigue(s,input(7*86400000));const expected=step(s,P.maxActiveGapMs);
 assert.equal(jump.A,expected.A);assert.equal(jump.monotonicMs,7*86400000);assert.ok(jump.A<.21);assert.equal(jump.phase,'awake');
});
test('local time and timezone jumps only slew phase and bounded F, never A',()=>{
 const s=create({A:.6,F:.5}),normal=step(s,1000,{clock:clock(1000,900)}),jump=step(s,1000,{clock:clock(1000,180)});
 assert.equal(normal.A,jump.A);assert.ok(Math.abs(jump.localPhaseMs-s.localPhaseMs)<=1500);assert.ok(Math.abs(jump.F-s.F)<=.002+1e-12);
 const midnight=createFatigue(clock(0,1439.99));const crossed=step(midnight,1000,{clock:clock(1000,0.01)});assert.ok(crossed.localPhaseMs>=0&&crossed.localPhaseMs<86400000);
});
test('relative baselines normalize equally and maximum alert channels cannot erase long pressure',()=>{
 const a=step(create(),60000,{channels:{D:75,O:25,E:75,N:75,C:25}});
 const b=step(create(),60000,{baseline:{D:20,O:80,E:20,N:20,C:80},channels:{D:60,O:40,E:60,N:60,C:40}});assert.ok(Math.abs(a.F-b.F)<1e-12);assert.ok(Math.abs(a.A-b.A)<1e-12);
 const high=run(create({A:1,F:.8,phase:'drowsy'}),240000,{channels:{D:100,O:0,E:100,N:100,C:0}});assert.ok(high.F>P.sleepEnter);assert.equal(high.phase,'asleep');
});
test('original (before I-022) offline pauses A/F, caps W decay and resets transition dwell',()=>{
 const s=create({A:.8,F:.8,W:.4,phase:'drowsy'},O),out=step(s,30*86400000,{mode:'offline'},O);
 assert.equal(out.A,s.A);assert.equal(out.F,s.F);assert.equal(out.phase,s.phase);assert.equal(out.phaseAgeMs,0);assert.equal(out.candidate,null);assert.ok(out.W<s.W);
 const capped=step(s,O.maxOfflineMs,{mode:'offline'},O);assert.equal(out.W,capped.W);
});
test('original explicit virtual offline rest is bounded low quality and never fabricates visible sleep',()=>{
 const p={...O,offlineVirtualRest:true},s=create({A:.9,F:.8},p),out=step(s,30*86400000,{mode:'offline'},p);
 assert.ok(Math.abs(out.A-.9*Math.exp(-O.maxOfflineMs*O.offlineRestQuality/O.restTauMs))<1e-11);assert.equal(out.phase,'awake');assert.ok(out.A>.7);
});
test('I-022 default: off screen is rest, bounded by the longest rest, and still never fabricates a visible phase change',()=>{
 const s=create({A:.9,F:.8,phase:'drowsy'}),out=step(s,30*86400000,{mode:'offline'}),capped=step(s,P.maxOfflineMs,{mode:'offline'});
 assert.ok(out.A<.05,'a day and more off screen leaves little sleep pressure');assert.equal(out.A,capped.A);assert.equal(out.phase,'drowsy');assert.equal(out.phaseAgeMs,0);assert.equal(out.candidate,null);
});
test('hysteresis plus dwell resists threshold chatter and covers full sleep ladder',()=>{
 let s=create({A:.95,F:.8});const observed=new Set([s.phase]);for(let i=0;i<500;i++){s=step(s,1000);observed.add(s.phase);}for(const phase of ['awake','light-drowsy','drowsy','falling-asleep','asleep'])assert.ok(observed.has(phase),phase);
 const near=run(create({A:.45,F:.37,phase:'light-drowsy'}),60000);assert.equal(near.phase,'light-drowsy');
});
test('chat/TTS/manual blockers only prevent sleep entry, retain numeric advance and drowsy gaze',()=>{
 for(const key of Object.keys(blockers)){const s=create({A:.95,F:.85,phase:'drowsy'}),out=run(s,240000,{blockers:{...blockers,[key]:true}});assert.equal(out.phase,'drowsy');assert.ok(out.A>s.A);assert.equal(fatigueSnapshot(out).gazeAllowed,true);}
 const falling=create({A:.95,F:.85,phase:'falling-asleep'}),blocked=step(falling,0,{blockers:{...blockers,tts:true}});assert.equal(blocked.phase,'drowsy');
});
test('accepted physical/chat pulse preserves A/F, deduplicates and rejects non-user sources',()=>{
 const s=createFatigue(clock(10000),{A:.8,F:.7,phase:'asleep'}),e={id:'touch:1',kind:'physical',acceptedAtMonotonicMs:10000};const a=acceptWakeEvent(s,e);
 assert.equal(a.A,s.A);assert.equal(a.F,s.F);assert.equal(a.W,P.physicalPulse);assert.equal(a.phase,'micro-awake');assert.equal(fatigueSnapshot(a).gazeAllowed,false);assert.equal(acceptWakeEvent(a,e),a);
 for(const kind of ['frame','tts','model-reply','background-audio'])assert.throws(()=>acceptWakeEvent(s,{...e,kind}));
 assert.equal(acceptWakeEvent(a,{...e,id:'touch:2',acceptedAtMonotonicMs:10000}),a);
});
test('micro-wake returns to sleep; accumulated or explicit wake restores gaze without clearing pressure',()=>{
 let s=createFatigue(clock(10000),{A:.9,F:.8,phase:'asleep'});s=acceptWakeEvent(s,{id:'touch:1',kind:'physical',acceptedAtMonotonicMs:10000});const rested=run(s,13000);assert.equal(rested.phase,'asleep');
 for(let i=0;i<4;i++){s=step(s,1100);s=acceptWakeEvent(s,{id:'chat:'+i,kind:'direct-chat',acceptedAtMonotonicMs:s.monotonicMs});}assert.equal(s.phase,'awake');assert.ok(s.A>.89);assert.ok(s.F>.7);assert.equal(fatigueSnapshot(s).gazeAllowed,true);
 const explicit=acceptWakeEvent(createFatigue(clock(500),{A:.95,F:.9,phase:'asleep'}),{id:'explicit',kind:'explicit-wake',acceptedAtMonotonicMs:500});assert.equal(explicit.phase,'awake');assert.equal(explicit.A,.95);assert.equal(explicit.F,.9);
});
test('dedup capacity is bounded and evicted identities cannot replay through old acceptance times',()=>{
 let s=createFatigue(clock(1000));for(let i=0;i<140;i++){s=step(s,1100);s=acceptWakeEvent(s,{id:'evt:'+i,kind:'physical',acceptedAtMonotonicMs:s.monotonicMs});}assert.equal(s.seen.length,128);
 const prior=s;assert.equal(acceptWakeEvent(s,{id:'evt:0',kind:'physical',acceptedAtMonotonicMs:2100}),prior);assert.ok(s.W<=P.maxW);
});
test('fine/coarse monotonic partitions agree within numerical smoothing tolerance',()=>{
 const s=create({A:.4,F:.4});const fine=run(s,60000),coarse=step(s,60000);assert.ok(Math.abs(fine.A-coarse.A)<1e-12);assert.ok(Math.abs(fine.F-coarse.F)<1e-5);
});
test('rest recovery exits sleep after residence and dwell; TTS alone never fabricates wake',()=>{
 const low=create({A:.1,F:.1,phase:'asleep'}),before=run(low,290000),after=run(before,80000);assert.equal(before.phase,'asleep');assert.ok(['light-drowsy','awake'].includes(after.phase));assert.equal(fatigueSnapshot(after).gazeAllowed,true);
 const sleepy=step(create({A:.95,F:.9,phase:'asleep'}),1000,{blockers:{...blockers,chat:true,tts:true,manualMotion:true}});assert.equal(sleepy.phase,'asleep');assert.equal(fatigueSnapshot(sleepy).gazeAllowed,false);
});
test('separate character states never share wake events, memory or numeric changes',()=>{
 const a=createFatigue(clock(10000),{A:.8,F:.7,phase:'asleep'}),b=createFatigue(clock(10000),{A:.3,F:.2}),copy=JSON.stringify(b);
 const event={id:'same-local-id',kind:'physical',acceptedAtMonotonicMs:10000};const aa=acceptWakeEvent(a,event);assert.equal(JSON.stringify(b),copy);const bb=acceptWakeEvent(b,event);assert.equal(aa.W,P.physicalPulse);assert.equal(bb.W,P.physicalPulse);assert.equal(bb.A,.3);assert.equal(aa.A,.8);assert.notEqual(aa.seen,bb.seen);
});
test('future, late and non-monotonic accepted events cannot produce wake pulses',()=>{
 const s=createFatigue(clock(10000)),base={id:'test-event',kind:'direct-chat'};
 assert.equal(acceptWakeEvent(s,{...base,acceptedAtMonotonicMs:10001}),s);assert.equal(acceptWakeEvent(s,{...base,acceptedAtMonotonicMs:7999}),s);
 const a=acceptWakeEvent(s,{...base,acceptedAtMonotonicMs:9500});assert.equal(acceptWakeEvent(a,{...base,id:'older',acceptedAtMonotonicMs:9400}),a);
});
