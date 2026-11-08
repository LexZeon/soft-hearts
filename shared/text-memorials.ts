/** Data-only projections. These do not grant storage, provider or media access. */
export interface TextMemorialOffer { id: string; invite: string; quote: string; purpose: string }
export interface TextMemorialEntry {
  id: string; text: string; purpose: string; createdAt: number; updatedAt: number;
}
export interface TextMemorialView {
  scopeId: string; generation: number; revision: number; entries: TextMemorialEntry[];
}
export interface TextMemorialExpected { scopeId: string; generation: number; revision: number }
export interface TextMemorialEdit extends TextMemorialExpected { id: string; text: string; purpose: string }
export interface TextMemorialDelete extends TextMemorialExpected { id: string }
/** Revision is monotonically increasing for this host lifetime, across scopes. */
export interface TextMemorialOfferState {revision:number;offer:TextMemorialOffer|null}
export interface TextMemorialAcknowledgement {id:string;revision:number}
export interface TextMemorialOrigin {kind:'proactive';id:string;at:number;sources:['text'];labels:['本次文字纪念邀请']}
export interface TextMemorialPresented {revision:number;offer:TextMemorialOffer;context:{replyId:string};origin:TextMemorialOrigin}
export type TextMemorialEvent = {type:'offer';revision:number;offer:TextMemorialOffer}
  | {type:'cancel';revision:number;id:string} | {type:'presented';revision:number;id:string;offer:TextMemorialOffer;origin:TextMemorialOrigin};

export function textMemorialRecord(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error('文字纪念数据不正确。');
  const keys=Reflect.ownKeys(input), result:Record<string,unknown>={};
  if(keys.length!==names.length||keys.some(key=>typeof key!=='string'||!names.includes(key))) throw Error('文字纪念字段不正确。');
  for(const name of names){const descriptor=Object.getOwnPropertyDescriptor(input,name);
    if(!descriptor||!Object.hasOwn(descriptor,'value'))throw Error('文字纪念字段不正确。');result[name]=descriptor.value;}
  return result;
}
export function textMemorialText(value: unknown, limit: number): string {
  if(typeof value!=='string'||!value.trim()||value.length>limit||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))throw Error('文字纪念内容不正确。');
  return value;
}
export function textMemorialInteger(value: unknown): number {
  if(!Number.isSafeInteger(value)||(value as number)<0)throw Error('文字纪念版本不正确。');return value as number;
}
export function validateTextMemorialOffer(input: unknown): TextMemorialOffer {
  const value=textMemorialRecord(input,['id','invite','quote','purpose']);
  const id=textMemorialText(value.id,100);if(!/^[A-Za-z0-9_-]+$/u.test(id))throw Error('文字纪念身份不正确。');
  const invite=textMemorialText(value.invite,600),quote=textMemorialText(value.quote,240),purpose=textMemorialText(value.purpose,80);
  if(!invite.includes(quote)||!invite.includes(purpose))throw Error('纪念邀请缺少准确内容或用途。');
  return {id,invite,quote,purpose};
}

