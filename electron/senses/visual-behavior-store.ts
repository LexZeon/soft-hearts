import { type AtomicFileWriter } from '../foundation/atomic-file';
import { CharacterRevisionStore } from '../cards';
import { emptyVisualBehavior, validateVisualBehavior, type VisualBehaviorProfile } from '../../shared/stage/personalize-visual'; // direct, not via ../../shared/stage: personalize-visual.ts imports the cards page, which comes back to the stage page (docs/claude/2026-11-16-overhaul-parts-4.md)

/** Minimal confirmed semantic recipe only. No image, path, material hash or analysis. */
export class VisualBehaviorStore extends CharacterRevisionStore<VisualBehaviorProfile> {
  constructor(directory:string,characterIds:()=>readonly string[],writeAtomic?:AtomicFileWriter){
    super(directory,characterIds,{file:'personalize-visual.json',label:'眉眼行为',empty:emptyVisualBehavior,validate:validateVisualBehavior},writeAtomic);
  }
}
