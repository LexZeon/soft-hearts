/** Credentials and machine paths never belong in the private profile sidecar (entries or diary). */
export const PRIVATE_LITERAL = /(?:\bsk-[A-Za-z0-9._-]{8,}|Bearer\s+\S+|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+|[A-Za-z]:[\\/]|file:\/\/|\/Users\/|\/home\/)/i;
