import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { layoutSingleEmoji, type EmojiRect } from '../electron/single-emoji-layout';
import { SingleEmojiCues } from '../electron/single-emoji-cues';
import { registerSingleEmojiControls } from '../electron/single-emoji-controls-host';
import { EmojiSettingsStore } from '../electron/single-emoji-settings';
import { DEFAULT_EMOJI_SETTINGS } from '../shared/single-emoji';

const overlap = (a: EmojiRect, b: EmojiRect) => a.x < b.x+b.width && a.x+a.width>b.x && a.y<b.y+b.height && a.y+a.height>b.y;
test('safe native DIP placement avoids whole pet and old/planned reply, including negative display coordinates; no room suppresses', () => {
  const owner = {x:-1200,y:120,width:460,height:650}, area={x:-1600,y:0,width:1600,height:1000};
  const reply={x:-726,y:100,width:420,height:360};
  const result=layoutSingleEmoji(owner,area,[reply]); assert.ok(result);
  assert.equal(overlap(result.bounds,owner),false); assert.equal(overlap(result.bounds,reply),false);
  assert.ok(result.bounds.x>=area.x && result.bounds.y>=area.y);
  const moved={...owner,x:owner.x+20}, next=layoutSingleEmoji(moved,area,[reply],result.slot);assert.ok(next);
  assert.equal(overlap(next.bounds,moved),false);
  assert.equal(layoutSingleEmoji(area,area,[]),null);
  assert.equal(layoutSingleEmoji({...owner,width:NaN},area,[]),null);
  assert.equal(layoutSingleEmoji(owner,area,[{...reply,x:Infinity}]),null);
});
test('one accepted host event, bounded cooldown/TTL, context/hide cancellation and no disabled/no-space replay', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let context='card:model:g1',now=10000,room=true;const shown:any[]=[];let hidden=0;
  const settings=structuredClone(DEFAULT_EMOJI_SETTINGS);
  const cues=new SingleEmojiCues({context:()=>context,settings:()=>settings,available:()=>true,
    show:cue=>{if(!room)return false;shown.push(cue);return true;},hide:()=>hidden++},()=>now);
  assert.equal(cues.offerMood('disabled','happy',context),false);
  settings.enabled=true;assert.equal(cues.offerMood('disabled','happy',context),false);
  assert.equal(cues.offerMood('reply-1','happy',context),true);
  assert.equal(cues.offerMood('reply-1','happy',context),false);
  assert.equal(cues.offerMood('reply-2','happy',context),false);assert.equal(shown.length,1);
  t.mock.timers.tick(2601);assert.ok(hidden>=2);
  now+=9000;room=false;assert.equal(cues.offerMood('no-space','happy',context),false);
  room=true;assert.equal(cues.offerMood('no-space','happy',context),false);
  assert.equal(cues.offerMood('reply-3','happy',context),true);
  context='other-card:model:g2';cues.invalidate();
  assert.equal(cues.offerMood('late','happy','card:model:g1'),false);
  now+=9000;settings.selected=['heart'];
  assert.equal(cues.offerMood('wrong-mood','sad',context),false);assert.equal(shown.length,2);
  cues.dispose();assert.equal(cues.offer('after-dispose','heart',context),false);
});
test('native surface failure stays cosmetic and does not escape into successful reply completion', () => {
  const settings={...structuredClone(DEFAULT_EMOJI_SETTINGS),enabled:true};
  const cues=new SingleEmojiCues({context:()=> 'scope',settings:()=>settings,available:()=>true,
    show:()=>{throw Error('native creation failed');},hide:()=>{throw Error('window already destroyed');}});
  assert.equal(cues.offerMood('completed-reply','happy','scope'),false);
  assert.doesNotThrow(()=>cues.invalidate());cues.dispose();
  const invalidSettings=new SingleEmojiCues({context:()=> 'scope',settings:()=>{throw Error('settings unavailable');},
    available:()=>true,show:()=>true,hide:()=>{}});
  assert.equal(invalidSettings.offerMood('completed-reply','happy','scope'),false);invalidSettings.dispose();
});
test('completed reply context selects concern instead of a lingering positive mood', () => {
  const selected:string[]=[];
  const cues=new SingleEmojiCues({context:()=> 'scope',
    settings:()=>({...structuredClone(DEFAULT_EMOJI_SETTINGS),enabled:true}),
    available:()=>true,show:cue=>{selected.push(cue.catalogId);return true;},hide:()=>{}});
  assert.equal(cues.offerReply('reply-support',{primary:'happy',context:'support'},'scope'),true);
  assert.deepEqual(selected,['concern']);cues.dispose();
});
test('actual controls host handlers persist returned state and request one local catalog preview; reject extra authority', async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'soft-hearts-emoji-'));
  const store=new EmojiSettingsStore(directory);await store.load();
  const methods=new Map<string,(...args:unknown[])=>any>(),offered:any[]=[],published:any[]=[];
  const cues=new SingleEmojiCues({context:()=> 'current',settings:()=>store.current,available:()=>true,
    show:cue=>{offered.push(cue);return true;},hide:()=>{}});
  registerSingleEmojiControls((id,handler)=>methods.set(id,handler),
    {store,cues:()=>cues,context:()=> 'current',publish:s=>published.push(s)});
  try {
    assert.equal(methods.get('getSingleEmojiSettings')!().enabled,false);
    const sent={...store.current,enabled:true,selected:['heart']};
    const saved=await methods.get('setSingleEmojiSettings')!(sent);
    assert.deepEqual(saved,store.current);assert.equal(published.length,1);
    assert.equal(methods.get('previewSingleEmoji')!('heart'),true);assert.equal(offered.length,1);
    assert.equal(methods.get('previewSingleEmoji')!('smile'),false);
    assert.throws(()=>methods.get('previewSingleEmoji')!('file:///secret'));
    await assert.rejects(methods.get('setSingleEmojiSettings')!({...saved,source:'custom',path:'/private'}));
    assert.throws(()=>methods.get('getSingleEmojiSettings')!({window:'generic'}));
    assert.deepEqual(store.current,saved);
  } finally {
    cues.dispose();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('soft-hearts-emoji-'));
    await rm(directory,{recursive:true,force:true});
  }
});
