/**
 * The one interruption arbiter of full-screen Unbound: the public page of the part (README.md).
 */
export { ACTION_END_KNOBS, ACTION_END_KNOB_RANGES, actionEndKnobs, type ActionEndKnobs } from './knobs';
export {
  ACTION_ENDS, ACTION_KINDS, END_CAUSES, USER_END_CAUSES, endsAction, isUserEndCause, pressSize, tugPoint, tugTarget,
  type ActionKind, type EndCause, type UserEndCause,
} from './rules';
export { ACTION_WORDS, interruptedLine, type ActionInterrupted } from './words';
