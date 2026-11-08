import { uiText, uiTemplate } from './ui-language';
import type {R20ProactiveOfferEvent,R20ProactiveOfferResponse,R20ProactiveOfferResult,
  R20ProactiveOfferState,R20ProactiveOfferView} from '../../shared/r20-proactive-offer';

export interface ProactiveAgentOfferAPI {
  r20ProactiveOfferGet():Promise<R20ProactiveOfferState>;
  r20ProactiveOfferAcknowledge(input:{id:string;revision:number}):Promise<R20ProactiveOfferView|null>;
  r20ProactiveOfferRespond(input:R20ProactiveOfferResponse):Promise<R20ProactiveOfferResult>;
  r20ProactiveOfferEvents(callback:(event:R20ProactiveOfferEvent)=>void):()=>void;
}
interface Options {
  isPet:boolean;
  publish(offer:R20ProactiveOfferView):Promise<void>;
  retract(id:string):void;
  presented?(offer:R20ProactiveOfferView):void;
  error(message:string):void;
}

/** A view/plan/scope form only; task creation remains in the original confirmation UI. */
export class ProactiveAgentOffer {
  private offer:R20ProactiveOfferView|null=null;
  private revision=-1;
  private epoch=0;
  private disposed=false;
  private busy=false;
  private unsubscribe:(()=>void)|null=null;
  private draftId='';
  private goal='';
  private scope='';
  private reply='';
  private readonly acknowledged=new Set<string>();
  private readonly published=new Set<string>();
  constructor(private readonly root:HTMLElement,private readonly api:ProactiveAgentOfferAPI,private readonly options:Options){}
  async init():Promise<void>{
    if(this.unsubscribe||this.disposed)return;
    this.unsubscribe=this.api.r20ProactiveOfferEvents(event=>this.event(event));
    try{this.state(await this.api.r20ProactiveOfferGet());}catch(error){if(!this.disposed)this.options.error(String(error));}
  }
  private event(event:R20ProactiveOfferEvent):void {
    if(this.disposed||event.revision<this.revision)return;
    if(event.type==='cancel'){
      this.revision=event.revision;
      if(this.offer?.id===event.id){this.epoch++;this.offer=null;this.busy=false;this.options.retract(event.id);this.render();}
      return;
    }
    this.state({revision:event.revision,offer:event.offer});
  }
  private state(state:R20ProactiveOfferState):void {
    if(this.disposed||state.revision<this.revision)return;
    this.revision=state.revision;
    const previous=this.offer;this.offer=state.offer?structuredClone(state.offer):null;
    if(previous&&previous.id!==this.offer?.id)this.options.retract(previous.id);
    if(!this.offer){this.render();return;}
    if(this.draftId!==this.offer.id){this.epoch++;this.draftId=this.offer.id;this.goal=this.offer.goal;this.scope='';this.reply='';}
    this.render();
    if(this.offer.presented){
      if(!this.published.has(this.offer.id)){this.published.add(this.offer.id);if(this.published.size>128)this.published.delete(this.published.values().next().value!);this.options.presented?.(structuredClone(this.offer));}
    }else if(this.options.isPet){void this.acknowledge(this.offer);}
  }
  private async acknowledge(offer:R20ProactiveOfferView):Promise<void>{
    const key=`${offer.id}:${offer.revision}`,epoch=this.epoch;
    if(this.acknowledged.has(key))return;
    this.acknowledged.add(key);if(this.acknowledged.size>128)this.acknowledged.delete(this.acknowledged.values().next().value!);
    try{
      await this.options.publish(offer);
      if(!this.current(offer.id,epoch))return;
      const accepted=await this.api.r20ProactiveOfferAcknowledge({id:offer.id,revision:offer.revision});
      if(!this.current(offer.id,epoch))return;
      if(accepted)this.state({revision:accepted.revision,offer:accepted});
      else if(!this.offer?.presented){this.options.retract(offer.id);this.offer=null;this.render();}
    }catch(error){if(this.current(offer.id,epoch)){this.offer=null;this.options.retract(offer.id);this.render();this.options.error(String(error));}}
  }
  private async respond(action:R20ProactiveOfferResponse['action']):Promise<void>{
    const offer=this.offer,epoch=this.epoch;if(this.disposed||this.busy||!offer?.presented)return;
    this.busy=true;this.render();
    const request:R20ProactiveOfferResponse={id:offer.id,revision:offer.revision,requestId:crypto.randomUUID(),action,
      ...(action==='reply'?{text:this.reply}:{}),...(action==='confirm'?{goal:this.goal,scope:this.scope}:{})};
    try{
      const result=await this.api.r20ProactiveOfferRespond(request);
      if(!this.current(offer.id,epoch)&&result.status!=='confirmation-opened')return;
      if(this.disposed||epoch!==this.epoch)return;
      this.state(result.state);
    }catch(error){if(!this.disposed&&epoch===this.epoch)this.options.error(String(error));}
    finally{if(!this.disposed&&epoch===this.epoch){this.busy=false;this.render();}}
  }
  private current(id:string,epoch:number):boolean{return !this.disposed&&this.epoch===epoch&&this.offer?.id===id;}
  private render():void {
    const doc=this.root.ownerDocument;this.root.replaceChildren();this.root.hidden=!this.offer;
    if(!this.offer)return;
    const offer=this.offer;
    const make=<T extends keyof HTMLElementTagNameMap>(tag:T,text='',className='')=>{const node=doc.createElement(tag);node.textContent=text;node.className=className;return node;};
    const card=make('section','','r20-proactive-offer');card.setAttribute('data-mood-ui','');
    card.append(make('strong',uiText('建议方案 · 尚未执行')),make('p',offer.question));
    card.append(make('p',uiText('可以先看方案；带入任务后，仍需核对工作目录与读写范围。当前不承诺直接操作电脑。'),'hint'));
    const actions=make('div','','r20-offer-actions');
    const button=(label:string,action:R20ProactiveOfferResponse['action'])=>{const node=make('button',label);node.type='button';node.disabled=this.busy||!offer.presented;node.onclick=()=>void this.respond(action);return node;};
    if(offer.stage!=='offered')card.append(make('p',offer.plan,'r20-offer-plan'));
    actions.append(button(uiText('查看方案'),'view'),button(uiText('补充范围'),'scope'),button(uiText('这次不用'),'decline'),button(uiText('取消提议'),'cancel'));
    card.append(actions);
    const reply=make('textarea');reply.maxLength=600;reply.value=this.reply;reply.setAttribute('aria-label',uiText('回复这次代办建议'));
    reply.placeholder=uiText('也可以用文字回复这次建议');reply.disabled=this.busy||!offer.presented;reply.oninput=()=>{this.reply=reply.value;};
    card.append(reply,button(uiText('回复建议'),'reply'));
    if(offer.stage==='scope'){
      const form=make('form');const goal=make('textarea');goal.maxLength=1000;goal.value=this.goal;goal.setAttribute('aria-label',uiText('这次任务的具体目标'));goal.oninput=()=>{this.goal=goal.value;};
      const scope=make('textarea');scope.maxLength=2000;scope.value=this.scope;scope.placeholder=offer.scopeHint;scope.setAttribute('aria-label',uiText('这次允许的范围与限制'));scope.oninput=()=>{this.scope=scope.value;};
      goal.disabled=scope.disabled=this.busy;
      const submit=button(uiText('带入任务确认'),'confirm');submit.type='submit';submit.onclick=null;
      form.onsubmit=event=>{event.preventDefault();this.goal=goal.value;this.scope=scope.value;if(this.goal.trim()&&this.scope.trim())void this.respond('confirm');else this.options.error(uiText('请写清这次的目标、允许范围与限制。'));};
      form.append(make('label',uiText('具体目标')),goal,make('label',uiText('允许范围与限制')),scope,make('p',uiText('此处不接收目录权限。请在下一步的原任务界面选择可信目录；这次确认不会直接开始任务。'),'hint'),submit);card.append(form);
    }
    if(!offer.presented)card.append(make('output',uiText('建议正在显示，尚未等待你的确认。')));
    this.root.append(card);
  }
  dispose():void{if(this.disposed)return;this.disposed=true;this.epoch++;this.unsubscribe?.();this.unsubscribe=null;const offer=this.offer;this.offer=null;if(offer)this.options.retract(offer.id);this.root.replaceChildren();this.root.hidden=true;}
}
