import { uiText, uiTemplate } from './ui-language';
import type { DesktopAPI } from '../../shared/contracts';
import { BODY_AUTHORING_PURPOSE, BODY_TWEAK_BINDING, BODY_VISUAL_PURPOSE, validateBodyPoseSelection, type BodyPosePreview, type BodyVisualState } from '../../shared/personalize-body';

type Bridge = Pick<DesktopAPI, 'getBodyAuthoring'|'chooseBodyMaterial'|'researchBody'|'discardBodyAdvice'|'consumeBodyAdvice'|'previewBodyBinding'|'previewFixedBodyBinding'|'bodyPreviewReceipt'|'saveBodyBehavior'|'changeBodyBehavior'|'cancelBodyAuthoring'|'onBodyPreviewCancelled'>;
type Action = 'load'|'choose'|'research'|'fill-advice'|'fill-right'|'fill-both'|'fill-head'|'fill-torso'|'fill-all'|'discard-advice'|'preview'|'preview-fixed'|'reset'|'clear-right'|'clear-head'|'clear-torso'|'save'|'disable'|'undo'|'remove';
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const e = document.createElement(tag); e.textContent = text; return e; };
const semantics: Record<string,string> = { 'mood.close':'亲近时','mood.content':'满足时','mood.happy':'开心时','mood.excited':'兴奋时',
  'mood.concerned':'关切时','mood.disappointed':'失落时','mood.upset':'不满时','mood.longing':'想念时','mood.sad':'难过时',
  'mood.relieved':'放松时','mood.tense-expectation':'紧张期待时','cue.satisfied':'满足反应','cue.reunion':'久别反应','cue.motion':'互动反应' };

/** A selected image is transient; a pose is always chosen separately by the user. */
export class PersonalizeBodyControls {
  private card: { id:string; name:string } | null = null;
  private state: BodyVisualState | null = null;
  private preview: BodyPosePreview | null = null;
  private previewReady = false; private generation = 0; private busy = false; private locked = false; private disposed = false;
  private notice = ''; private readonly details = node('details'); private readonly target = node('p'); private readonly purpose = node('p');
  private readonly saved = node('p');
  private readonly image = node('img'); private readonly feedback = node('textarea'); private readonly report = node('pre');
  private readonly adviceReport = node('pre');
  private readonly binding = node('select'); private readonly semantic = node('select'); private readonly label = node('input');
  private readonly strength = node('input'); private readonly status = node('output'); private readonly buttons = new Map<Action,HTMLButtonElement>();
  private readonly shoulder = node('input'); private readonly upperArm = node('input'); private readonly elbow = node('input');
  private readonly rightEnabled=node('input');private readonly rightShoulder=node('input');private readonly rightUpperArm=node('input');private readonly rightElbow=node('input');private readonly rightStrength=node('input');
  private rightPresent=false;
  private readonly headEnabled=node('input');private readonly headOffset=node('input');private readonly headStrength=node('input');private headPresent=false;
  private readonly torsoEnabled=node('input');private readonly torsoOffset=node('input');private readonly torsoStrength=node('input');private torsoPresent=false;
  private bindingToRestore: string | null = null;
  private draftChoices: BodyVisualState['choices'] | null = null;
  private openingCleanup: Promise<void> | null = null;
  private readonly unsubscribe: () => void;
  constructor(container:HTMLElement,private readonly options:{api:Bridge;preview(view:BodyPosePreview):Promise<boolean>;confirm?(text:string):boolean;onError?(message:string):void}) {
    this.details.className='personalize-language personalize-visual';
    this.details.append(node('summary',uiText('personalize · 身体姿态')),this.target,node('p',uiText('可手选姿势并调整后预览。右臂默认不参与；启用后可小幅试调，效果尚待验证。图片观察需要单独确认，不会自动生成姿势。')),this.purpose,this.saved);
    this.details.append(node('p',uiText('手动头姿参与时会暂时让自动转头、点头让位；关闭后恢复。头部强度为 1 时静态目标替换当前头部朝向；效果尚待验证。')));
    this.details.append(node('p',uiText('躯干倾斜随当前动作微调，并保留允许的呼吸；局部方向不等于屏幕左右。头和手臂的局部设置不变，但会随躯干在空间中一起移动；这不是图片姿态重建。')));
    this.image.className='personalize-visual-image';this.image.alt=uiText('所选图片的本地临时预览');this.image.src='data:,';
    this.feedback.rows=3;this.feedback.maxLength=2000;this.feedback.setAttribute('aria-label',uiText('回答澄清问题'));
    this.label.maxLength=80;this.label.setAttribute('aria-label',uiText('你确认的姿势标签'));
    this.binding.setAttribute('aria-label',uiText('手选可用姿势'));this.semantic.setAttribute('aria-label',uiText('使用情境'));
    this.feedback.dataset.bodyField='feedback';this.binding.dataset.bodyField='binding';this.semantic.dataset.bodyField='semantic';
    this.label.dataset.bodyField='label';this.strength.dataset.bodyField='strength';
    const empty=node('option',uiText('选择情境'));empty.value='';this.semantic.append(empty);
    for(const [key,title] of Object.entries(semantics)){const option=node('option',uiText(title));option.value=key;this.semantic.append(option);}
    this.strength.type='number';this.strength.min='0';this.strength.max='1';this.strength.step='0.05';this.strength.value='0.5';this.strength.setAttribute('aria-label',uiText('姿势强度'));
    for(const [input,key,label] of [[this.shoulder,'shoulder',uiText('肩部调整')],[this.upperArm,'upper-arm',uiText('上臂调整')],[this.elbow,'elbow',uiText('肘部调整')]] as const){
      input.type='number';input.min='-10';input.max='10';input.step='1';input.value='0';input.dataset.bodyField=key;input.setAttribute('aria-label',label);
    }
    this.rightEnabled.type='checkbox';this.rightEnabled.dataset.bodyField='right-enabled';this.rightEnabled.setAttribute('aria-label',uiText('参与右臂'));
    this.rightStrength.type='number';this.rightStrength.min='0';this.rightStrength.max='1';this.rightStrength.step='0.05';this.rightStrength.value='0.5';this.rightStrength.dataset.bodyField='right-strength';
    this.headEnabled.type='checkbox';this.headEnabled.dataset.bodyField='head-enabled';this.headEnabled.setAttribute('aria-label',uiText('参与头部'));
    this.headStrength.type='number';this.headStrength.min='0';this.headStrength.max='1';this.headStrength.step='0.05';this.headStrength.value='0.5';this.headStrength.dataset.bodyField='head-strength';
    this.headOffset.type='number';this.headOffset.min='-10';this.headOffset.max='10';this.headOffset.step='1';this.headOffset.value='0';this.headOffset.dataset.bodyField='head-offset';
    this.torsoEnabled.type='checkbox';this.torsoEnabled.dataset.bodyField='torso-enabled';this.torsoEnabled.setAttribute('aria-label',uiText('参与躯干'));
    this.torsoStrength.type='number';this.torsoStrength.min='0';this.torsoStrength.max='1';this.torsoStrength.step='0.05';this.torsoStrength.value='0.5';this.torsoStrength.dataset.bodyField='torso-strength';
    this.torsoOffset.type='number';this.torsoOffset.min='-10';this.torsoOffset.max='10';this.torsoOffset.step='1';this.torsoOffset.value='0';this.torsoOffset.dataset.bodyField='torso-offset';
    for(const [input,key,label] of [[this.rightShoulder,'right-shoulder',uiText('右肩调整')],[this.rightUpperArm,'right-upper-arm',uiText('右上臂调整')],[this.rightElbow,'right-elbow',uiText('右肘调整')]] as const){
      input.type='number';input.min='-10';input.max='10';input.step='1';input.value='0';input.dataset.bodyField=key;input.setAttribute('aria-label',label);}
    for(const input of [this.feedback,this.binding,this.semantic,this.label,this.strength,this.shoulder,this.upperArm,this.elbow])input.oninput=()=>this.edited();
    for(const input of [this.rightEnabled,this.rightStrength,this.rightShoulder,this.rightUpperArm,this.rightElbow])input.oninput=()=>{this.rightPresent=true;this.edited();};
    for(const input of [this.headEnabled,this.headStrength,this.headOffset])input.oninput=()=>{this.headPresent=true;this.edited();};
    for(const input of [this.torsoEnabled,this.torsoStrength,this.torsoOffset])input.oninput=()=>{this.torsoPresent=true;this.edited();};
    const fields:[string,HTMLElement][]=[
      [uiText('回答澄清问题'),this.feedback],[uiText('手选静态姿势'),this.binding],[uiText('使用情境'),this.semantic],[uiText('你确认的标签'),this.label],
      [uiText('左肩调整（度）'),this.shoulder],[uiText('左上臂调整（度）'),this.upperArm],[uiText('左肘调整（度）'),this.elbow],[uiText('左臂强度'),this.strength],
      [uiText('参与右臂'),this.rightEnabled],[uiText('右肩调整（度）'),this.rightShoulder],[uiText('右上臂调整（度）'),this.rightUpperArm],[uiText('右肘调整（度）'),this.rightElbow],[uiText('右臂强度'),this.rightStrength],[uiText('参与头部'),this.headEnabled],[uiText('头部倾斜（度）'),this.headOffset],[uiText('头部强度'),this.headStrength],[uiText('参与躯干'),this.torsoEnabled],[uiText('躯干倾斜（度）'),this.torsoOffset],[uiText('躯干强度'),this.torsoStrength]];
    this.details.append(this.image);for(const [title,input]of fields){const row=node('label',title);row.append(input);this.details.append(row);if(input===this.feedback)this.details.append(this.report,this.adviceReport);}
    const actions=node('div');actions.className='personalize-actions';
    for(const [id,title] of [['reset',uiText('恢复左臂预设')],['clear-right',uiText('移除右臂贡献')],['clear-head',uiText('关闭头部贡献')],['clear-torso',uiText('关闭躯干贡献')],['preview-fixed',uiText('预览手选姿势')],['choose',uiText('选择一张静图')],['research',uiText('将当前图片送给 Claude 观察')],['fill-advice',uiText('填左臂建议')],['fill-right',uiText('填右臂建议')],['fill-both',uiText('填双臂建议')],['fill-head',uiText('填头部建议')],['fill-torso',uiText('填躯干建议')],['fill-all',uiText('填所有建议')],['discard-advice',uiText('舍弃建议')],['preview',uiText('观察后预览手选姿势')],['save',uiText('确认保存并启用')],['disable',uiText('停用已保存姿势')],['undo',uiText('恢复上次版本')],['remove',uiText('移除临时图片')]] as const){
      const button=node('button',title);button.type='button';button.dataset.bodyAction=id;button.onclick=()=>void this.run(id);this.buttons.set(id,button);actions.append(button);
    }
    this.status.setAttribute('role','status');this.details.append(actions,this.status);container.append(this.details);
    this.details.ontoggle=()=>{if(this.details.open)void this.run('load');else this.close();};
    this.unsubscribe=options.api.onBodyPreviewCancelled(value=>{if(this.preview?.id===value.id&&this.preview.token===value.token){this.preview=null;this.previewReady=false;this.render();}});
    this.render();
  }
  select(card:{id:string;name:string}|null,locked=false):void {
    if(this.disposed)return;const changed=this.card?.id!==card?.id;if(changed||(locked&&!this.locked))this.close();
    this.card=card?{...card}:null;this.locked=locked;this.render();if(this.details.open&&card&&!locked&&!this.state&&!this.busy)void this.run('load');
  }
  private confirm(text:string):boolean{return(this.options.confirm??(value=>window.confirm(value)))(text);}
  private stopPreview():void { const p=this.preview;this.preview=null;this.previewReady=false;
    if(p)void this.options.api.bodyPreviewReceipt({phase:'stop',id:p.id,token:p.token,stageGeneration:0}).catch(()=>{}); }
  private discardAdvice():void {const s=this.state;if(!s?.advice)return;s.advice=null;
    void this.options.api.discardBodyAdvice(s.id,s.revision).catch(()=>{});}
  private close(preserveDraft=false):Promise<void> { this.generation++;this.busy=false;this.stopPreview();const s=this.state;this.state=null;
    if(preserveDraft){this.draftChoices=s?.choices??this.draftChoices??[];this.bindingToRestore=this.binding.value;}
    else{this.draftChoices=null;this.feedback.value='';this.binding.value='';this.bindingToRestore=null;this.semantic.value='';this.label.value='';this.strength.value='0.5';this.shoulder.value=this.upperArm.value=this.elbow.value='0';
      this.rightPresent=false;this.rightEnabled.checked=false;this.rightStrength.value='0.5';this.rightShoulder.value=this.rightUpperArm.value=this.rightElbow.value='0';this.headPresent=false;this.headEnabled.checked=false;this.headStrength.value='0.5';this.headOffset.value='0';this.torsoPresent=false;this.torsoEnabled.checked=false;this.torsoStrength.value='0.5';this.torsoOffset.value='0';}
    const cancelled=s?this.options.api.cancelBodyAuthoring(s.id).catch(()=>{}):Promise.resolve();const opening=this.openingCleanup;
    this.report.textContent='';this.image.src='data:,';this.render();return Promise.all([cancelled,opening]).then(()=>{}); }
  private edited():void {if(this.busy){const cancelled=this.close(true),draft=this.draftChoices;this.notice=uiText('编辑已保留；已请求取消旧操作，迟到结果会被忽略。');
      void cancelled.then(()=>{if(!this.disposed&&this.details.open&&this.card&&!this.locked&&!this.busy&&!this.state&&draft!==null&&this.draftChoices===draft)void this.run('load');});}
    else{this.generation++;this.discardAdvice();this.stopPreview();this.notice=uiText('草稿尚未生效，需要预览并明确保存。');}this.render();}
  private accept(s:BodyVisualState):void {if(s.characterId!==this.card?.id||s.purpose!==BODY_AUTHORING_PURPOSE)throw Error(uiText('制作目标已改变。'));
    if(!this.state&&!this.draftChoices&&s.saved.profile){const p=s.saved.profile;this.bindingToRestore=p.bindingId;this.semantic.value=p.semantic;this.label.value=p.label;
      this.strength.value=String(p.strength);this.shoulder.value=String(p.tweak?.shoulderOffsetDegrees??0);this.upperArm.value=String(p.tweak?.upperArmOffsetDegrees??0);this.elbow.value=String(p.tweak?.elbowOffsetDegrees??0);
      this.rightPresent=!!p.right;this.rightEnabled.checked=p.right?.enabled??false;this.rightStrength.value=String(p.right?.strength??.5);
      this.rightShoulder.value=String(p.right?.shoulderOffsetDegrees??0);this.rightUpperArm.value=String(p.right?.upperArmOffsetDegrees??0);this.rightElbow.value=String(p.right?.elbowOffsetDegrees??0);
      this.headPresent=!!p.head;this.headEnabled.checked=p.head?.enabled??false;this.headStrength.value=String(p.head?.strength??.5);this.headOffset.value=String(p.head?.offsetDegrees??0);
      this.torsoPresent=!!p.torso;this.torsoEnabled.checked=p.torso?.enabled??false;this.torsoStrength.value=String(p.torso?.strength??.5);this.torsoOffset.value=String(p.torso?.offsetDegrees??0);}
    this.state=s;this.draftChoices=null;}
  private async run(action:Action):Promise<void> {
    const card=this.card;if(!card||this.locked||this.busy||this.disposed||!this.details.open)return;
    const generation=++this.generation,current=()=>!this.disposed&&this.details.open&&this.card?.id===card.id&&this.generation===generation;
    this.busy=true;this.notice=uiText('正在处理；切卡、关闭或编辑会取消旧结果。');this.render();
    try {
      if(!this.state){const opening=this.options.api.getBodyAuthoring(card.id);
        const cleanup=opening.then(async s=>{if(!current())await this.options.api.cancelBodyAuthoring(s.id).catch(()=>{});},()=>{});this.openingCleanup=cleanup;
        const s=await opening;if(!current()){await cleanup;return;}this.accept(s);}
      const s=this.state!;let result:BodyVisualState|undefined;
      if(action==='choose'){this.stopPreview();result=await this.options.api.chooseBodyMaterial(s.id,s.revision);}
      if(action==='research'){
        if(!s.material||!s.submitNonce||!s.imageSupported)throw Error(uiText('请先选择图片，并使用已确认支持图片的 Claude。'));
        if(!this.confirm(uiTemplate`把当前图片提交给 ${s.connectionLabel}，用于「${card.name}」本次身体姿态观察？\n${s.material.width} × ${s.material.height}\n本次确认仅用于这一次。`)){this.notice=uiText('未提交图片。');return;}
        this.stopPreview();result=await this.options.api.researchBody({sessionId:s.id,revision:s.revision,materialId:s.material.id,submitNonce:s.submitNonce,purpose:BODY_VISUAL_PURPOSE,refinement:this.feedback.value});
      }
      if(action==='fill-advice'||action==='fill-right'||action==='fill-both'||action==='fill-head'||action==='fill-torso'||action==='fill-all'){
        const candidate=s.advice?.id;if(!candidate||!s.targetSupported||(this.binding.value!==''&&this.binding.value!==BODY_TWEAK_BINDING))throw Error(uiText('当前建议或目标已改变。'));
        const side=action==='fill-advice'?'left':action==='fill-right'?'right':action==='fill-both'?'both':action==='fill-head'?'head':action==='fill-torso'?'torso':'all';
        const filled=await this.options.api.consumeBodyAdvice(s.id,s.revision,candidate,side);if(!current()||this.state!==s)return;
        s.revision=filled.revision;s.advice=null;this.stopPreview();
        if(filled.shoulderOffsetDegrees!==null)this.shoulder.value=String(filled.shoulderOffsetDegrees);
        if(filled.upperArmOffsetDegrees!==null)this.upperArm.value=String(filled.upperArmOffsetDegrees);
        if(filled.elbowOffsetDegrees!==null)this.elbow.value=String(filled.elbowOffsetDegrees);
        if(filled.right){if(filled.right.shoulderOffsetDegrees!==null){this.rightShoulder.value=String(filled.right.shoulderOffsetDegrees);this.rightPresent=true;}
          if(filled.right.upperArmOffsetDegrees!==null){this.rightUpperArm.value=String(filled.right.upperArmOffsetDegrees);this.rightPresent=true;}
          if(filled.right.elbowOffsetDegrees!==null){this.rightElbow.value=String(filled.right.elbowOffsetDegrees);this.rightPresent=true;}}
        if(filled.headOffsetDegrees!==undefined&&filled.headOffsetDegrees!==null)this.headOffset.value=String(filled.headOffsetDegrees);
        if(filled.torsoOffsetDegrees!==undefined&&filled.torsoOffsetDegrees!==null)this.torsoOffset.value=String(filled.torsoOffsetDegrees);
        this.notice=uiText('建议已填入草稿；请自行调整，再预览和确认保存。');
      }
      if(action==='discard-advice'){await this.options.api.discardBodyAdvice(s.id,s.revision);if(!current())return;s.advice=null;this.notice=uiText('已舍弃建议，草稿保持原样。');}
      if(action==='preview'||action==='preview-fixed'){
        if([this.strength,this.shoulder,this.upperArm,this.elbow,...(this.rightPresent?[this.rightStrength,this.rightShoulder,this.rightUpperArm,this.rightElbow]:[]),...(this.headPresent?[this.headStrength,this.headOffset]:[]),...(this.torsoPresent?[this.torsoStrength,this.torsoOffset]:[])].some(input=>input.value.trim()===''))throw Error(uiText('请填写完整的姿势数值。'));
        const choice=validateBodyPoseSelection({bindingId:this.binding.value,semantic:this.semantic.value,label:this.label.value,strength:Number(this.strength.value),
          offsets:{shoulderOffsetDegrees:Number(this.shoulder.value),upperArmOffsetDegrees:Number(this.upperArm.value),elbowOffsetDegrees:Number(this.elbow.value)},
          ...(this.rightPresent?{right:{enabled:this.rightEnabled.checked,strength:Number(this.rightStrength.value),shoulderOffsetDegrees:Number(this.rightShoulder.value),upperArmOffsetDegrees:Number(this.rightUpperArm.value),elbowOffsetDegrees:Number(this.rightElbow.value)}}:{}),...(this.headPresent?{head:{enabled:this.headEnabled.checked,strength:Number(this.headStrength.value),offsetDegrees:Number(this.headOffset.value)}}:{}),...(this.torsoPresent?{torso:{enabled:this.torsoEnabled.checked,strength:Number(this.torsoStrength.value),offsetDegrees:Number(this.torsoOffset.value)}}:{})});
        const p=await (action==='preview-fixed'?this.options.api.previewFixedBodyBinding(s.id,s.revision,choice):this.options.api.previewBodyBinding(s.id,s.revision,choice));if(!current()){void this.options.api.bodyPreviewReceipt({phase:'stop',id:p.id,token:p.token,stageGeneration:0});return;}
        s.revision=p.revision;s.advice=null;this.preview=p;const ready=await this.options.preview(p);if(!current()||this.preview!==p)return;
        this.previewReady=ready===true;if(!ready){this.stopPreview();throw Error(uiText('未得到当前模型的同属性预览，草稿未保存。'));}this.notice=uiText('请查看预览；明确确认后才会保存。');
      }
      if(action==='reset'){this.discardAdvice();this.stopPreview();this.shoulder.value=this.upperArm.value=this.elbow.value='0';this.strength.value='0.5';this.notice=uiText('已恢复预设数值；尚未保存。');}
      if(action==='clear-right'){this.discardAdvice();this.stopPreview();this.rightPresent=true;this.rightEnabled.checked=false;this.notice=uiText('右臂贡献已从草稿移除；尚未保存。');}
      if(action==='clear-head'){this.discardAdvice();this.stopPreview();this.headPresent=true;this.headEnabled.checked=false;this.notice=uiText('头部贡献已关闭；尚未保存。');}
      if(action==='clear-torso'){this.discardAdvice();this.stopPreview();this.torsoPresent=true;this.torsoEnabled.checked=false;this.notice=uiText('躯干贡献已关闭；尚未保存。');}
      if(action==='save'){
        const p=this.preview;if(!p||!this.previewReady)throw Error(uiText('请先观看当前姿势预览。'));
        if(!this.confirm(uiTemplate`确认保存并启用「${card.name}」的姿势「${this.label.value}」？\n保存模型、姿势和手调数值，不保存图片或分析。`)){this.notice=uiText('未保存。');return;}
        result=await this.options.api.saveBodyBehavior({sessionId:s.id,revision:s.revision,savedRevision:s.savedRevision,previewId:p.id,previewToken:p.token});
      }
      if(action==='disable'||action==='undo'){
        if(!this.confirm(`${action==='disable'?uiText('停用已保存姿势'):uiText('恢复上次版本')}：${card.name}？`)){this.notice=uiText('未更改。');return;}
        result=await this.options.api.changeBodyBehavior({sessionId:s.id,revision:s.revision,kind:action});
      }
      if(action==='remove'){this.close();this.notice=uiText('临时图片已移除。');this.render();return;}
      if(!current())return;if(result){if(action==='undo')this.state=null;this.accept(result);}
      if(!['preview','preview-fixed','reset','clear-right','clear-head','clear-torso','fill-advice','fill-right','fill-both','fill-head','fill-torso','fill-all','discard-advice'].includes(action))this.notice=action==='research'?uiText('观察候选已返回，请解释不确定处，再由你手选姿势。'):action==='choose'?uiText('图片仅在本地暂存，尚未发送。'):action==='save'?uiText('已保存当前卡与模型的姿势引用。'):action==='disable'?uiText('已停用。'):action==='undo'?uiText('已恢复上次版本。'):uiText('尚未发送图片。');
    } catch(error){if(current()){const detail=String(error);this.notice=detail;
      if(this.options.onError){this.options.onError(detail);this.notice=uiText('这次姿势制作未完成，草稿保留，可查看问题详情。');}
      try{const fresh=await this.options.api.getBodyAuthoring(card.id);if(current())this.accept(fresh);}catch{/* preserve draft */}}}
    finally{if(current()){this.busy=false;this.render();}}
  }
  private render():void {
    if(this.disposed)return;const s=this.state,locked=!this.card||this.locked,blocked=locked||this.busy||!s||!!s.saved.storageError;
    this.target.textContent=this.card?uiTemplate`目标卡：${this.card.name} · ${this.card.id}`:uiText('请先启用一张角色卡。');
    this.purpose.textContent=s?`${s.connectionLabel} · ${s.imageSupported?uiText('图片能力已确认'):uiText('图片能力尚未确认')} · ${s.targetSupported?uiText('固定预设有有限数值核对；手调和画面效果待验证'):uiText('当前模型尚无数值核对过的姿势')}`:uiText('选择图片不会发送。');
    const saved=s?.saved.profile;this.saved.textContent=saved?uiTemplate`已保存：${saved.label} · ${uiText(semantics[saved.semantic]??saved.semantic)} · ${saved.enabled?uiText('启用'):uiText('停用')}${saved.targetModelSha!==s?.targetModelSha?uiText(' · 当前模型不匹配'):''}`:uiText('尚未保存身体姿势。');
    const preview=s?.material?.previewDataUrl;this.image.hidden=!preview;this.image.src=preview&&preview.length<=220000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(preview)?preview:'data:,';
    const old=this.bindingToRestore??this.binding.value;const empty=node('option',uiText('不选择／保持草稿'));empty.value='';this.binding.replaceChildren(empty);
    for(const item of s?.choices??this.draftChoices??[]){const option=node('option',item.id===BODY_TWEAK_BINDING?uiText('左臂轻屈（固定姿势）'):item.label);option.value=item.id;this.binding.append(option);}this.binding.value=old;this.bindingToRestore=null;
    for(const input of [this.feedback,this.binding,this.semantic,this.label,this.strength,this.shoulder,this.upperArm,this.elbow,this.rightEnabled,this.rightStrength,this.rightShoulder,this.rightUpperArm,this.rightElbow,this.headEnabled,this.headStrength,this.headOffset,this.torsoEnabled,this.torsoStrength,this.torsoOffset])input.disabled=locked||!!s?.saved.storageError;
    for(const button of this.buttons.values())button.disabled=blocked;this.buttons.get('choose')!.disabled=locked||this.busy;
    this.buttons.get('research')!.disabled=blocked||!s?.material||!s.imageSupported||!s.submitNonce;
    const hasValues=(v:{shoulder:{offsetDegrees:number|null};upperArm:{offsetDegrees:number|null};elbow:{offsetDegrees:number|null}}|null|undefined)=>!!v&&[v.shoulder,v.upperArm,v.elbow].some(j=>j.offsetDegrees!==null);
    const leftAdvice=hasValues(s?.advice?.suggestion),rightAdvice=hasValues(s?.advice?.rightSuggestion),adviceBlocked=blocked||!s?.advice?.id||!s.targetSupported||(this.binding.value!==''&&this.binding.value!==BODY_TWEAK_BINDING);
    this.buttons.get('fill-advice')!.disabled=adviceBlocked||!leftAdvice;this.buttons.get('fill-right')!.disabled=adviceBlocked||!rightAdvice;this.buttons.get('fill-both')!.disabled=adviceBlocked||!leftAdvice||!rightAdvice;
    const headAdvice=s?.advice?.headSuggestion?.offsetDegrees,torsoAdvice=s?.advice?.torsoSuggestion?.offsetDegrees;this.buttons.get('fill-head')!.disabled=adviceBlocked||headAdvice==null;this.buttons.get('fill-torso')!.disabled=adviceBlocked||torsoAdvice==null;this.buttons.get('fill-all')!.disabled=adviceBlocked||(!leftAdvice&&!rightAdvice&&headAdvice==null&&torsoAdvice==null);
    this.buttons.get('discard-advice')!.disabled=blocked||!s?.advice;
    this.buttons.get('preview')!.disabled=blocked||!s?.study||!s.targetSupported||!this.binding.value||!this.semantic.value||!this.label.value.trim();
    this.buttons.get('preview-fixed')!.disabled=blocked||!s?.targetSupported||!this.binding.value||!this.semantic.value||!this.label.value.trim();
    this.buttons.get('save')!.disabled=blocked||!this.previewReady;this.buttons.get('disable')!.disabled=blocked||!s?.saved.profile?.enabled;
    this.buttons.get('undo')!.disabled=blocked||!s?.saved.previous;this.buttons.get('remove')!.disabled=locked||this.busy||!s?.material;
    const study=s?.study;this.report.textContent=study?[uiText('观察候选（并非人工真值）'),...study.observations.map(v=>`${v.region} · ${v.visibility}：${v.description}`),
      ...study.inferences.map(v=>uiTemplate`${v.label}：${v.rationale}；未知：${v.unknown}`),...study.questions,study.insufficient].filter(Boolean).join('\n'):'';
    const advice=s?.advice;const show=(n:number|null)=>n===null?uiText('未知'):`${n}°`;
    const line=(label:string,v:{shoulder:{offsetDegrees:number|null};upperArm:{offsetDegrees:number|null};elbow:{offsetDegrees:number|null};reason:string;unknowns:string}|null)=>v?[uiTemplate`${label}：肩${show(v.shoulder.offsetDegrees)}；上臂${show(v.upperArm.offsetDegrees)}；肘${show(v.elbow.offsetDegrees)}`,uiTemplate`依据：${v.reason}；未知：${v.unknowns}`]:[];
    const h=advice?.headSuggestion,t=advice?.torsoSuggestion;this.adviceReport.textContent=advice?[uiText('粗略建议（模型自述，非已验证的三维姿态）'),...line(uiText('左臂'),advice.suggestion),...line(uiText('右臂'),advice.rightSuggestion??null),...(h?[uiTemplate`头部倾斜：${show(h.offsetDegrees)}；依据：${h.reason}；未知：${h.unknowns}`]:[]),...(t?[uiTemplate`躯干倾斜试调：${show(t.offsetDegrees)}；依据：${t.reason}；未知：${t.unknowns}`]:[])].join('\n'):'';
    this.status.textContent=s?.saved.storageError||this.notice;
  }
  dispose():void {if(this.disposed)return;this.close();this.disposed=true;this.unsubscribe();}
}
