import { uiText, uiTemplate } from './ui-language';
import type { DesktopAPI } from '../../shared/contracts';
import { VISUAL_PURPOSE, validateVisualSelection, type VisualAuthoringState, type VisualPreview, type VisualSelection } from '../../shared/personalize-visual';
import { EXPRESSION_MORPHS, isExpressionPreview, type AuthoringPreview, type ExpressionPreview, type ExpressionPatch } from '../../shared/expression-composition';

type Bridge=Pick<DesktopAPI,'getVisualAuthoring'|'chooseVisualMaterial'|'researchVisual'|'previewVisualBinding'|'visualPreviewReceipt'|'saveVisualBehavior'|'changeVisualBehavior'|'cancelVisualAuthoring'|'onVisualPreviewCancelled'>
  &Partial<Pick<DesktopAPI,'researchExpression'|'editExpression'|'previewExpression'>>;
type Action='load'|'choose'|'research'|'preview'|'save'|'disable'|'undo'|'remove';
interface Draft {label:string;choice:string;strength:number;dirty:boolean}
const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const value=document.createElement(tag);value.textContent=text;return value;};
const semantics:Record<string,string>={'mood.close':'亲近时','mood.content':'满足时','mood.happy':'开心时','mood.excited':'兴奋时','mood.concerned':'关切时','mood.disappointed':'失落时','mood.upset':'不满时','mood.longing':'想念时','mood.sad':'难过时','mood.relieved':'放松时','mood.tense-expectation':'紧张期待时','cue.satisfied':'满足反应','cue.reunion':'久别反应','cue.motion':'互动反应'};
const bindings:Record<string,string>={'face.smile':'微笑眉眼','face.embarrassed-smile':'羞涩微笑','face.happy':'快乐眉眼','face.laugh':'笑意','face.compassion':'关切','face.in-trouble':'为难','face.disappointed':'失落','face.disgust':'反感','face.sentimental':'感伤','face.sad':'难过','face.convinced':'认同'};
export class PersonalizeVisualControls {
  private readonly drafts=new Map<string,Draft>();
  private card:{id:string;name:string}|null=null;
  private state:VisualAuthoringState|null=null;
  private preview:AuthoringPreview|null=null;
  private previewReady=false;
  private generation=0;
  private busy=false;
  private locked=false;
  private opened=false;
  private disposed=false;
  private notice='';
  private readonly details=node('details');
  private readonly target=node('p');private readonly purpose=node('p');private readonly image=node('img');
  private readonly report=node('pre');private readonly status=node('output');
  private readonly feedback=node('textarea');private readonly label=node('input');private readonly choices=node('select');private readonly strength=node('input');
  private readonly buttons=new Map<Action,HTMLButtonElement>();private readonly unsubscribe:()=>void;
  private readonly expressionDescriptions=new Map<string,string>();
  private readonly expressionInput=node('textarea');private readonly expressionLabel=node('input');private readonly expressionStrength=node('input');
  private readonly expressionReport=node('pre');private readonly expressionSliders=new Map<string,HTMLInputElement>();
  private readonly expressionButtons=new Map<string,HTMLButtonElement>();
  constructor(container:HTMLElement,private readonly options:{api:Bridge;preview?(view:VisualPreview):Promise<boolean>;previewExpression?(view:ExpressionPreview):Promise<boolean>;confirm?(text:string):boolean;onError?(message:string):void}){
    this.details.className='personalize-language personalize-visual';this.details.append(node('summary',uiText('personalize · 眉眼制作')),this.target,
      node('p',uiText('先选择一张静图，再单独决定是否发送给当前 Claude。观察和解释只是候选；身体与动态动作留待后续。没有匹配表情时保持草稿。')),this.purpose);
    this.image.className='personalize-visual-image';this.image.alt=uiText('所选图片的本地临时预览');this.image.src='data:,';
    this.feedback.rows=3;this.feedback.maxLength=2_000;this.feedback.dataset.visualField='feedback';this.feedback.setAttribute('aria-label',uiText('回答澄清问题或说明你想表达什么'));
    this.label.maxLength=80;this.label.dataset.visualField='label';this.label.setAttribute('aria-label',uiText('自己确认的简短行为标签'));
    this.choices.dataset.visualField='choice';this.choices.setAttribute('aria-label',uiText('手动选择已审眉眼与情境'));
    this.strength.type='range';this.strength.min='0.05';this.strength.max='0.7';this.strength.step='0.05';this.strength.dataset.visualField='strength';this.strength.setAttribute('aria-label',uiText('表情强度上限'));
    for(const input of [this.label,this.choices,this.strength])input.oninput=()=>{const draft=this.draft();if(!draft)return;
      draft.label=this.label.value;draft.choice=this.choices.value;draft.strength=Number(this.strength.value);draft.dirty=true;this.edited();this.render();};
    this.choices.onchange=this.choices.oninput;
    this.feedback.oninput=()=>{this.edited();this.render();};
    const feedbackLabel=node('label',uiText('回答澄清问题／希望如何打磨'));feedbackLabel.append(this.feedback);
    const choiceLabel=node('label',uiText('由你选择的情境与已审眉眼（不是识图结论）'));choiceLabel.append(this.choices);
    const labelLabel=node('label',uiText('你确认的简短标签'));labelLabel.append(this.label);
    const strengthLabel=node('label',uiText('强度上限（实际仍受原情绪强度、眨眼与手选优先级约束）'));strengthLabel.append(this.strength);
    const actions=node('div');actions.className='personalize-actions';
    for(const [id,title]of [['choose',uiText('选择一张静图')],['research',uiText('将当前图片送给 Claude 研究')],['preview',uiText('仅预览所选眉眼')],['save',uiText('确认保存并启用')],['disable',uiText('停用已保存行为')],['undo',uiText('恢复上次确认版本')],['remove',uiText('移除临时图片')]] as const){const button=node('button',title);button.type='button';button.dataset.visualAction=id;button.onclick=()=>{void this.run(id);};this.buttons.set(id,button);actions.append(button);}
    this.status.setAttribute('role','status');this.details.append(this.image,feedbackLabel,this.report,choiceLabel,labelLabel,strengthLabel,actions);
    const textSection=node('section');textSection.dataset.expressionSection='text';textSection.append(node('h4',uiText('用文字制作临时眉眼')),
      node('p',uiText('描述你想表达的感觉，点击后交给当前 Claude 提出候选；可调整、撤销并临时预览。组合尚未验证观感，不会保存或用于桌宠。')));
    this.expressionInput.rows=3;this.expressionInput.maxLength=2000;this.expressionInput.dataset.expressionField='description';this.expressionInput.setAttribute('aria-label',uiText('希望表达的感觉或澄清回答'));
    this.expressionInput.oninput=()=>{if(this.card)this.expressionDescriptions.set(this.card.id,this.expressionInput.value);this.edited();this.render();};
    this.expressionLabel.maxLength=80;this.expressionLabel.dataset.expressionField='label';this.expressionLabel.setAttribute('aria-label',uiText('组合标签'));
    this.expressionLabel.onchange=()=>{void this.runExpression('edit',{label:this.expressionLabel.value});};
    this.expressionStrength.type='range';this.expressionStrength.min='0';this.expressionStrength.max='.7';this.expressionStrength.step='.01';this.expressionStrength.dataset.expressionField='strength';this.expressionStrength.setAttribute('aria-label',uiText('临时组合强度'));
    this.expressionStrength.oninput=()=>this.stopPreview();
    this.expressionStrength.onchange=()=>{void this.runExpression('edit',{strength:Number(this.expressionStrength.value)});};
    textSection.append(this.expressionInput,this.expressionReport,this.expressionLabel,this.expressionStrength);
    for(const target of EXPRESSION_MORPHS){const label=node('label',uiText(target.label)),slider=node('input');slider.type='range';slider.min='0';slider.max='.6';slider.step='.005';slider.dataset.expressionMorph=target.id;slider.setAttribute('aria-label',uiText(target.label));
      slider.oninput=()=>this.stopPreview();slider.onchange=()=>{void this.runExpression('edit',{morphWeights:{[target.id]:Number(slider.value)}});};this.expressionSliders.set(target.id,slider);label.append(slider);textSection.append(label);}
    const textActions=node('div');textActions.className='personalize-actions';
    for(const [action,title]of [['research',uiText('请 Claude 提出组合')],['undo',uiText('撤销组合修改')],['redo',uiText('重做组合修改')],['preview',uiText('仅临时预览组合')],['cancel',uiText('停止生成／取消预览')]] as const){
      const button=node('button',title);button.type='button';button.dataset.expressionAction=action;button.onclick=()=>{if(action==='cancel'){if(this.busy)this.close();else this.stopPreview();this.notice=uiText('已取消，原模型和已保存设置保持。');this.render(true);}else void this.runExpression(action);};this.expressionButtons.set(action,button);textActions.append(button);}
    textSection.append(textActions);this.details.append(textSection,this.status);container.append(this.details);
    this.details.ontoggle=()=>{this.opened=this.details.open;if(this.opened)void this.run('load');else{this.close();this.render();}};
    this.unsubscribe=options.api.onVisualPreviewCancelled(value=>{if(this.preview?.id===value.id&&this.preview.token===value.token){this.preview=null;this.previewReady=false;this.render();}});
    this.render(true);
  }
  select(card:{id:string;name:string}|null,locked=false):void{
    if(this.disposed)return;const changed=this.card?.id!==card?.id;
    if(changed||(locked&&!this.locked))this.close();this.card=card?{...card}:null;this.locked=locked;
    if(card&&!this.drafts.has(card.id))this.drafts.set(card.id,{label:'',choice:'',strength:0.34,dirty:false});
    this.render(changed);if(this.opened&&card&&!locked&&!this.state&&!this.busy)void this.run('load');
  }
  private draft():Draft|undefined{return this.card?this.drafts.get(this.card.id):undefined;}
  private confirm(text:string):boolean{return(this.options.confirm??(value=>window.confirm(value)))(text);}
  private stopPreview():void{const preview=this.preview;this.preview=null;this.previewReady=false;
    if(preview)void this.options.api.visualPreviewReceipt({phase:'stop',id:preview.id,token:preview.token,stageGeneration:0}).catch(()=>{});}
  private close():void{
    this.generation++;this.busy=false;this.stopPreview();const state=this.state;this.state=null;
    if(state)void this.options.api.cancelVisualAuthoring(state.id).catch(()=>{});this.feedback.value='';this.report.textContent='';this.image.src='data:,';
  }
  private edited():void{if(this.busy){this.close();this.notice=uiText('编辑已保留，旧制作已取消；请重新选择图片。');}
    else{this.generation++;this.stopPreview();this.notice=uiText('个人草稿尚未生效；需要同遮罩预览并明确保存。');}}
  private accept(state:VisualAuthoringState,replace=false):void{
    if(state.characterId!==this.card?.id||state.purpose!==VISUAL_PURPOSE)throw Error(uiText('返回的制作角色或用途不匹配，已忽略。'));this.state=state;
    const draft=this.draft();if(draft&&(replace||!draft.dirty)){const profile=state.saved.profile;
      draft.label=profile.label;draft.choice=profile.semantic&&profile.bindingId?`${profile.semantic}|${profile.bindingId}`:'';draft.strength=profile.strength;draft.dirty=false;}
  }
  private selection():VisualSelection{
    const draft=this.draft(),[semantic,bindingId]=(draft?.choice??'').split('|');
    return validateVisualSelection({semantic,bindingId,label:draft?.label??'',strength:draft?.strength??0.34});
  }
  private async run(action:Action):Promise<void>{
    const card=this.card;if(!card||this.locked||this.busy||this.disposed||!this.opened)return;
    const generation=++this.generation,current=()=>!this.disposed&&this.opened&&this.card?.id===card.id&&this.generation===generation;
    this.busy=true;this.notice=uiText('正在处理；切卡、关闭或新编辑会取消旧结果。');this.render();
    try{
      if(!this.state){const state=await this.options.api.getVisualAuthoring(card.id);if(!current()){void this.options.api.cancelVisualAuthoring(state.id).catch(()=>{});return;}this.accept(state);}
      const state=this.state!;let result:VisualAuthoringState|undefined;
      if(action==='choose'){this.stopPreview();result=await this.options.api.chooseVisualMaterial(state.id,state.revision);}
      if(action==='research'){
        if(!state.material||!state.submitNonce||!state.imageSupported)throw Error(uiText('请先选择图片，并在设置中使用已确认支持图片的 Claude 连接。'));
        if(!this.confirm(uiTemplate`把当前这张重新编码的图片提交给 ${state.connectionLabel}，用于「${card.name}」(${card.id}) 的本次眉眼研究？\n${state.material.width} × ${state.material.height}\n本次确认只用于这一次研究；不进入普通聊天、记忆或导出。`)){this.notice=uiText('未提交图片。');return;}
        this.stopPreview();result=await this.options.api.researchVisual({sessionId:state.id,revision:state.revision,materialId:state.material.id,submitNonce:state.submitNonce,purpose:VISUAL_PURPOSE,refinement:this.feedback.value});
      }
      if(action==='preview'){
        const value=await this.options.api.previewVisualBinding(state.id,state.revision,this.selection());
        if(!current()){void this.options.api.visualPreviewReceipt({phase:'stop',id:value.id,token:value.token,stageGeneration:0}).catch(()=>{});return;}
        state.revision=value.revision;this.preview=value;this.previewReady=false;
        const ready=await this.options.preview?.(value);
        if(!current()||this.preview!==value)return;
        this.previewReady=ready===true;if(!this.previewReady){this.stopPreview();throw Error(uiText('未得到同一目标的受审眉眼预览；请检查模型、表情开关和手选占用，草稿未保存。'));}
        this.notice=uiText('同遮罩预览已加载，请查看效果；确认保存才用于之后已接受的情境。');
      }
      if(action==='save'){
        const preview=this.preview;if(!preview||isExpressionPreview(preview)||!this.previewReady)throw Error(uiText('请先预览当前选择，临时组合不能保存。'));
        if(!this.confirm(uiTemplate`确认保存并启用「${card.name}」(${card.id}) 的眉眼行为？\n${this.draft()!.label}\n${uiText(semantics[preview.selection.semantic]??preview.selection.semantic)} · ${uiText(bindings[preview.selection.bindingId]??preview.selection.bindingId)}\n只保存已确认的模型和行为引用，不保存图片或分析。`)){this.notice=uiText('未保存。');return;}
        result=await this.options.api.saveVisualBehavior({sessionId:state.id,revision:state.revision,savedRevision:state.savedRevision,previewId:preview.id,previewToken:preview.token});
      }
      if(action==='disable'||action==='undo'){
        if(!this.confirm(`${action==='disable'?uiText('停用已保存行为'):uiText('恢复上次确认版本')}：${card.name} (${card.id})？`)){this.notice=uiText('未更改。');return;}
        result=await this.options.api.changeVisualBehavior({sessionId:state.id,revision:state.revision,kind:action});
      }
      if(action==='remove'){this.close();this.notice=uiText('临时图片和制作上下文已移除；已保存行为保留。');this.render();return;}
      if(!current())return;if(result)this.accept(result,action==='save'||action==='undo');
      if(action!=='preview')this.notice=action==='research'?uiText('模型候选已返回。请回答问题或编辑个人意图，再手动选择匹配表情；不匹配可保持草稿。'):action==='choose'?uiText('图片仅在本地暂存，尚未发送。研究使用重新编码的 JPEG，不修改原图。'):action==='save'?uiText('已确认保存；当前卡、模型和已接受情境匹配时才使用。'):action==='disable'?uiText('已停用；未保存的个人草稿保留。'):action==='undo'?uiText('已恢复上次确认版本。'):uiText('尚未发送任何图片。');
    }catch(error){if(current()){this.notice=this.failure(error);const previous=this.state;
      if(previous){try{const fresh=await this.options.api.getVisualAuthoring(card.id);if(current())this.accept(fresh);}catch{/* Keep unsaved personal draft and the safe error. */}}
    }}finally{if(current()){this.busy=false;this.render(true);}}
  }
  private async runExpression(action:'research'|'edit'|'undo'|'redo'|'preview',patch?:ExpressionPatch):Promise<void>{
    const card=this.card;if(!card||this.locked||this.busy||this.disposed||!this.opened)return;
    const generation=++this.generation,current=()=>!this.disposed&&this.opened&&this.card?.id===card.id&&this.generation===generation;
    this.busy=true;this.stopPreview();this.notice=uiText('正在处理临时组合；停止、切卡或关闭会取消旧结果。');this.render();
    try{
      if(!this.state){const state=await this.options.api.getVisualAuthoring(card.id);if(!current()){void this.options.api.cancelVisualAuthoring(state.id).catch(()=>{});return;}this.accept(state);}
      const state=this.state!;if(!state.expression?.available)throw Error(uiText('当前 Claude 或 Gene 眉眼目标尚不可用。'));
      let result:VisualAuthoringState|undefined;
      if(action==='research'){
        if(!this.options.api.researchExpression)throw Error(uiText('文字组合入口尚未就绪。'));
        result=await this.options.api.researchExpression({sessionId:state.id,revision:state.revision,description:this.expressionInput.value});
      }else if(action==='preview'){
        if(!this.options.api.previewExpression)throw Error(uiText('组合预览入口尚未就绪。'));
        const value=await this.options.api.previewExpression(state.id,state.revision);
        if(!current()){void this.options.api.visualPreviewReceipt({phase:'stop',id:value.id,token:value.token,stageGeneration:0}).catch(()=>{});return;}
        state.revision=value.revision;this.preview=value;const ready=await this.options.previewExpression?.(value);
        if(!current()||this.preview!==value)return;
        this.previewReady=ready===true;if(!this.previewReady){this.stopPreview();throw Error(uiText('组合未得到当前目标的预览回执；请检查手选、接触与表情开关。'));}
      }else{
        if(!this.options.api.editExpression)throw Error(uiText('组合编辑入口尚未就绪。'));
        result=await this.options.api.editExpression(action==='edit'?{sessionId:state.id,revision:state.revision,action,patch:patch!}:{sessionId:state.id,revision:state.revision,action});
      }
      if(!current())return;if(result)this.accept(result);
      this.notice=action==='preview'?uiText('临时组合已加载；取消会回到当前底层，不保存或自动启用。'):uiText('临时草稿已更新；可回答澄清、修改或预览，尚未生效。');
    }catch(error){if(current()){this.notice=this.failure(error);try{const state=await this.options.api.getVisualAuthoring(card.id);if(current())this.accept(state);}catch{/* Keep local description and error. */}}}
    finally{if(current()){this.busy=false;this.render(true);}}
  }
  private failure(error:unknown):string {
    const detail=String(error);
    if(!this.options.onError)return detail;
    this.options.onError(detail);
    return uiText('这次眉眼制作未完成，草稿保留，可查看问题详情。');
  }
  private render(fields=false):void{
    if(this.disposed)return;const state=this.state,draft=this.draft(),locked=!this.card||this.locked,study=state?.study;
    this.target.textContent=this.card?uiTemplate`目标卡：${this.card.name} · ${this.card.id}`:uiText('请先保存并启用一张角色卡。');
    this.purpose.textContent=state?`${state.connectionLabel} · ${state.imageSupported?uiText('图片能力已确认'):uiText('图片能力尚未确认，不能研究')} · ${state.targetSupported?uiText('当前模型已审眉眼可用'):uiText('当前模型待适配，不启用假映射')}。`:uiText('选图不会外发；只有每次明确研究才提交当前素材。');
    const preview=state?.material?.previewDataUrl;this.image.hidden=!preview;
    this.image.src=preview&&preview.length<=220_000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(preview)?preview:'data:,';
    if(fields){this.label.value=draft?.label??'';this.strength.value=String(draft?.strength??0.34);
      const empty=node('option',uiText('不选择／没有匹配，保持草稿'));empty.value='';this.choices.replaceChildren(empty);
      for(const choice of state?.choices??[]){const option=node('option',`${uiText(semantics[choice.semantic]??choice.semantic)} · ${uiText(bindings[choice.bindingId]??choice.bindingId)}`);option.value=`${choice.semantic}|${choice.bindingId}`;this.choices.append(option);}this.choices.value=draft?.choice??'';}
    for(const input of [this.feedback,this.label,this.choices,this.strength])input.disabled=locked||!!state?.saved.storageError;
    const blocked=locked||this.busy||!state||!!state.saved.storageError;
    for(const button of this.buttons.values())button.disabled=blocked;
    this.buttons.get('choose')!.disabled=locked||this.busy;
    this.buttons.get('research')!.disabled=blocked||!state?.material||!state.imageSupported||!state.submitNonce;
    this.buttons.get('preview')!.disabled=blocked||!state?.material||!state.targetSupported||!draft?.choice||!draft.label.trim();
    this.buttons.get('save')!.disabled=blocked||!this.previewReady||!this.preview||isExpressionPreview(this.preview);
    this.buttons.get('disable')!.disabled=blocked||!state?.saved.profile.enabled;
    this.buttons.get('undo')!.disabled=blocked||!state?.saved.previous;
    this.buttons.get('remove')!.disabled=locked||this.busy||!state?.material;
    const visible:Record<string,string>={visible:uiText('可见'),occluded:uiText('遮挡'),outside_frame:uiText('画外'),ambiguous:uiText('不确定')};
    this.report.textContent=study?[uiText('模型观察候选（不是人工真值）'),...study.observations.map(row=>`${row.region==='eye'?uiText('眼睛'):uiText('眉毛')} · ${uiText(visible[row.visibility])}：${row.description}`),
      uiText('候选解释（不自动选择表情）'),...study.inferences.map(row=>`${row.label}：${row.rationale}${row.unknown?uiTemplate`；未知：${row.unknown}`:''}`),uiText('需要你解释的问题'),...study.questions,
      study.insufficient?uiTemplate`证据不足：${study.insufficient}`:''].filter(Boolean).join('\n'):'';
    this.status.textContent=state?.saved.storageError||this.notice;
    const expression=state?.expression,recipe=expression?.recipe,textBlocked=locked||this.busy||!expression?.available;
    this.expressionInput.disabled=locked;this.expressionLabel.disabled=this.expressionStrength.disabled=textBlocked||!recipe;
    if(fields){this.expressionInput.value=this.card?this.expressionDescriptions.get(this.card.id)??'':'';this.expressionLabel.value=recipe?.label??'';this.expressionStrength.value=String(recipe?.strength??.45);
      for(const [id,slider]of this.expressionSliders)slider.value=String(recipe?.morphs.find(row=>row.id===id)?.weight??0);}
    for(const slider of this.expressionSliders.values())slider.disabled=textBlocked||!recipe;
    for(const button of this.expressionButtons.values())button.disabled=textBlocked;
    this.expressionButtons.get('research')!.disabled=textBlocked||!this.expressionInput.value.trim()||!this.options.api.researchExpression;
    this.expressionButtons.get('preview')!.disabled=textBlocked||!recipe||recipe.strength<=0||!this.options.api.previewExpression;
    this.expressionButtons.get('undo')!.disabled=textBlocked||!expression?.undoDepth;
    this.expressionButtons.get('redo')!.disabled=textBlocked||!expression?.redoDepth;
    this.expressionButtons.get('cancel')!.disabled=locked||(!this.busy&&!this.preview);
    this.expressionReport.textContent=expression?.study?[expression.study.label,...expression.study.questions,expression.study.insufficient,recipe?uiText('候选系数可调整；当前组合没有观感验证。'):uiText('尚无合格组合，请补充描述。')].filter(Boolean).join('\n'):'';
  }
  dispose():void{if(this.disposed)return;this.close();this.disposed=true;this.unsubscribe();this.drafts.clear();this.expressionDescriptions.clear();}
}
