import { type AtomicFileWriter } from './atomic-file';
import { CharacterRevisionStore } from './character-revision-store';
import { emptyVisualBehavior, validateVisualBehavior, type VisualBehaviorProfile } from '../shared/personalize-visual';

/** Minimal confirmed semantic recipe only. No image, path, material hash or analysis. */
export class VisualBehaviorStore extends CharacterRevisionStore<VisualBehaviorProfile> {
  constructor(directory:string,characterIds:()=>readonly string[],writeAtomic?:AtomicFileWriter){
    super(directory,characterIds,{file:'personalize-visual.json',label:'眉眼行为',empty:emptyVisualBehavior,validate:validateVisualBehavior},writeAtomic);
  }
}
