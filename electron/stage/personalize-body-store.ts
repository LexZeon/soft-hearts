import { type AtomicFileWriter } from '../foundation/atomic-file';
import { CharacterRevisionStore } from '../cards';
import { validateBodyPoseProfile, type BodyPoseProfile } from '../../shared/stage/personalize-body';

/** Only the explicitly confirmed card/model/binding identity is persisted. */
export class PersonalizeBodyStore extends CharacterRevisionStore<BodyPoseProfile | null> {
  constructor(directory: string, characterIds: () => readonly string[], writeAtomic?: AtomicFileWriter) {
    super(directory, characterIds, {
      file: 'personalize-body.json', label: '身体姿势', empty: () => null, validate: validateBodyPoseProfile,
    }, writeAtomic);
  }
}
