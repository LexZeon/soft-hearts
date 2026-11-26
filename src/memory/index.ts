// 记忆和关系 (part 4), window side: the public page. Other parts and the wiring import this part only through this file (overhaul plan
// section 8). Files inside src/memory/ import each other directly; stylesheets are imported by path (side effects, not this page).
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part memory`).

// The memory panels of the control window: chat archive, journal, moving memory, our things, people and things, recall by meaning,
// text memorials (panel, offer, delivered history), the profile of the user, and the letter under 「关于」.
export { MemoryPanel } from './MemoryPanel';
export { JournalPanel } from './JournalPanel';
export { MovingMemoryPanel } from './MovingMemoryPanel';
export { OurThingsPanel } from './OurThingsPanel';
export { PeopleThingsPanel } from './PeopleThingsPanel';
export { SemanticRecallPanel } from './SemanticRecallPanel';
export { TextMemorialPanel } from './TextMemorialPanel';
export { TextMemorialDeliveredHistory, TextMemorialOfferController } from './TextMemorialOffer';
export { UserProfilePanel } from './UserProfilePanel';
export { mountAboutLetter } from './AboutLetter';
