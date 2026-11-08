import { type AtomicFileWriter } from './atomic-file';
import { CharacterRevisionStore } from './character-revision-store';
import { validateBodyPoseProfile, type BodyPoseProfile } from '../shared/personalize-body';

/** Only the explicitly confirmed card/model/binding identity is persisted. */
export class PersonalizeBodyStore extends CharacterRevisionStore<BodyPoseProfile | null> {
  constructor(directory: string, characterIds: () => readonly string[], writeAtomic?: AtomicFileWriter) {
    super(directory, characterIds, {
      file: 'personalize-body.json', label: '身体姿势', empty: () => null, validate: validateBodyPoseProfile,
    }, writeAtomic);
  }
}
