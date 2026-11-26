// I-186 step 0: one warm Claude Code chat process per character (pool.ts; the cap in knobs.ts). Like claude-session.ts it is not on the
// brain part's page (electron/brain/index.ts explains the import cycle); the brain wiring imports it from here.
export { ClaudeSessionPool, capVictims, chatSessionKey, poolIdentity, sessionSlotKey, type CapCandidate, type ClaudeSessionPoolOptions, type PoolIdentitySources, type PoolStage,
  type PoolTurnIdentity } from './pool';
export { SESSION_POOL_KNOBS } from './knobs';
