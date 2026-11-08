import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

/** Only the Electron boundary is synthetic. The production window module and
 * layout/catalog execute unchanged; no Electron process or native UI starts. */
async function fixture(imageFor?:(id:string)=>Promise<string|null>) {
  const children:MockWindow[]=[];
  class Contents extends EventEmitter {
    url='';mainFrame={url:''};sent:any[]=[];
    isDestroyed(){return false;}getURL(){return this.url;}
    send(channel:string,value:any){this.sent.push({channel,value});}
    setWindowOpenHandler(_handler:any){}
  }
  class MockWindow extends EventEmitter {
    // Like Electron: once destroyed (already true during its 'closed' event), a
    // BrowserWindow's own members throw; only EventEmitter methods and isDestroyed() remain.
    private contents=new Contents();
    get webContents(){if(this.dead)throw new TypeError('Object has been destroyed');return this.contents;}
    visible=false;dead=false;top=false;
    bounds={x:300,y:180,width:400,height:600};options:any;shown=0;ignored=false;
    constructor(options:any={}){super();this.options=options;children.push(this);}
    getBounds(){return {...this.bounds};}setBounds(b:any){this.bounds={...b};}
    isDestroyed(){return this.dead;}isVisible(){return this.visible;}isMinimized(){return false;}getOpacity(){return 1;}
    isAlwaysOnTop(){return this.top;}setAlwaysOnTop(value:boolean){this.top=value;}
    setIgnoreMouseEvents(value:boolean){this.ignored=value;}
    showInactive(){this.visible=true;this.shown++;this.emit('show');}
    hide(){this.visible=false;}destroy(){this.dead=true;this.visible=false;this.emit('closed');}
    loadURL(url:string){this.webContents.url=url;this.webContents.mainFrame.url=url;return Promise.resolve();}
  }
  const screen=Object.assign(new EventEmitter(),{area:{x:0,y:0,width:1600,height:1000},
    getDisplayMatching(){return {workArea:this.area};}});
  const ipcMain=new EventEmitter(), key='singleEmojiFixture'+randomUUID().replaceAll('-','');
  (globalThis as any)[key]={BrowserWindow:MockWindow,screen,ipcMain};
  const compiled=await build({entryPoints:['electron/single-emoji-window.ts'],bundle:true,write:false,
    format:'esm',platform:'node',target:'node22',define:{__dirname:JSON.stringify('/owned-test-preload')},
    plugins:[{name:'synthetic-electron-boundary',setup(b){
      b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'const f=globalThis['+JSON.stringify(key)+'];export const BrowserWindow=f.BrowserWindow;export const screen=f.screen;export const ipcMain=f.ipcMain;'}));
    }}]});
  const {SingleEmojiWindow}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  let context='current',now=1000,obstacles:any[]=[];
  const owner=new MockWindow();owner.visible=true;
  const display=new SingleEmojiWindow(owner,()=>obstacles,()=>context,()=>now,imageFor);
  const cue=(id:string)=>({id,catalogId:'smile',context,expiresAt:now+2600});
  const child=()=>children.at(-1)!;
  const ready=()=>child().webContents.emit('did-finish-load');
  const token=()=>child().webContents.sent.at(-1).value.token;
  const paint=(value=token(),sender=child().webContents)=>ipcMain.emit('desk:single-emoji-presented',{sender,senderFrame:sender.mainFrame},value);
  return {owner,display,screen,ipcMain,children,child,ready,token,paint,cue,
    setContext:(value:string)=>{context=value;},setNow:(value:number)=>{now=value;},setObstacles:(value:any[])=>{obstacles=value;},
    dispose:()=>{display.dispose();delete (globalThis as any)[key];}};
}
test('late or foreign paint cannot show a retired/context-lost glyph; no old glyph flashes before new paint', async () => {
  const f=await fixture();try{
    assert.equal(f.display.show(f.cue('one')),true);
    f.paint(null);assert.equal(f.child().visible,false);
    f.ready();assert.equal(f.child().visible,false);
    const old=f.token();f.paint(old,f.owner.webContents);assert.equal(f.child().visible,false);
    f.display.clear();f.paint(old);assert.equal(f.child().visible,false);
    f.display.show(f.cue('two'));const current=f.token();f.paint(old);assert.equal(f.child().visible,false);
    f.paint(current);assert.equal(f.child().visible,true);
    f.setContext('new-card');f.display.sync();assert.equal(f.child().visible,false);f.paint(current);assert.equal(f.child().visible,false);
    assert.equal(f.children.length,2);assert.equal(f.child().options.focusable,false);assert.equal(f.child().ignored,true);
  }finally{f.dispose();}
});
test('planned reply movement relocates before display; exhausted workarea permanently discards current cue', async () => {
  const f=await fixture();try{
    f.display.show(f.cue('one'));f.ready();f.paint();const first=f.child().getBounds();
    f.setObstacles([first]);f.display.sync();assert.equal(f.child().visible,false);
    const second=f.child().getBounds();assert.notDeepEqual(first,second);f.paint();assert.equal(f.child().visible,true);
    f.screen.area=f.owner.getBounds();f.screen.emit('display-metrics-changed');assert.equal(f.child().visible,false);
    const stale=f.token();f.screen.area={x:0,y:0,width:1600,height:1000};f.screen.emit('display-metrics-changed');
    f.paint(stale);assert.equal(f.child().visible,false);
  }finally{f.dispose();}
});
test('TTL, owner reload/hide/restore, and disposal retire the pending cue and listeners without replay', async () => {
  const f=await fixture();try{
    f.display.show(f.cue('expired'));f.ready();const old=f.token();f.setNow(4000);f.paint(old);assert.equal(f.child().visible,false);
    f.display.show(f.cue('reload'));const reload=f.token();f.owner.webContents.emit('did-start-loading');f.paint(reload);assert.equal(f.child().visible,false);
    f.display.show(f.cue('hide'));const hidden=f.token();f.owner.visible=false;f.owner.emit('hide');f.owner.visible=true;f.owner.emit('restore');f.paint(hidden);assert.equal(f.child().visible,false);
    f.dispose();assert.equal(f.ipcMain.listenerCount('desk:single-emoji-presented'),0);
    assert.equal(f.screen.listenerCount('display-metrics-changed'),0);assert.equal(f.child().dead,true);
  }finally{f.dispose();}
});
test('destroying the owner disposes through its closed event without touching the destroyed owner', async () => {
  // reply-smoke's last step destroys the pet window: the owner-closed dispose read
  // owner.webContents, threw "Object has been destroyed" and froze the main process
  // behind Electron's uncaught-exception dialog (docs/claude/2026-11-02-smoke-triage.md).
  const f=await fixture();try{
    f.display.show(f.cue('one'));f.ready();f.paint();assert.equal(f.child().visible,true);
    const child=f.child(),contents=f.owner.webContents;
    assert.doesNotThrow(()=>f.owner.destroy());
    assert.equal(child.dead,true);
    assert.equal(contents.listenerCount('did-start-loading')+contents.listenerCount('render-process-gone'),0);
    assert.equal(f.ipcMain.listenerCount('desk:single-emoji-presented'),0);
    assert.equal(f.screen.listenerCount('display-metrics-changed'),0);
    assert.equal(f.owner.listenerCount('closed'),0);
    assert.equal(f.display.show(f.cue('after')),false,'a disposed surface never shows again');
  }finally{f.dispose();}
});

test('saved character PNG resolves before paint in same safe window; late cancelled image never reappears',async()=>{let resolve!:(v:string|null)=>void;let f=await fixture(()=>new Promise(r=>resolve=r));try{f.display.show(f.cue('image'));f.ready();assert.equal(f.child().webContents.sent.length,0);resolve('data:image/png;base64,c3ludGhldGlj');await Promise.resolve();await Promise.resolve();assert.equal(f.child().webContents.sent.at(-1).value.png,'data:image/png;base64,c3ludGhldGlj');assert.equal(f.child().visible,false);f.paint();assert.equal(f.child().visible,true);f.display.show(f.cue('late'));f.display.clear();resolve('data:image/png;base64,bGF0ZQ==');await Promise.resolve();await Promise.resolve();f.display.sync();assert.equal(f.child().visible,false);}finally{f.dispose();}});
