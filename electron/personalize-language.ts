import { type AtomicFileWriter } from './atomic-file';
import { CharacterRevisionStore } from './character-revision-store';
import { emptyLanguageProfile, validateLanguageProfile, type LanguageProfile } from '../shared/personalize-language';

/** Original optional v1 codec and public shape; shared mechanics do not alter portable cards. */
export class PersonalizeLanguageStore extends CharacterRevisionStore<LanguageProfile> {
  constructor(directory:string,characterIds:()=>readonly string[],writeAtomic?:AtomicFileWriter){
    super(directory,characterIds,{file:'personalize-language.json',label:'语言习惯',noun:'规则',
      corruptMessage:'语言习惯存档无法读取，原 personalize-language.json 已保留。暂用原有表达；修复并重新启动前不能覆盖。',
      empty:emptyLanguageProfile,validate:validateLanguageProfile},writeAtomic);
  }
}
