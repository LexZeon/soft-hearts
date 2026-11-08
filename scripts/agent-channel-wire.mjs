// Agent channel wire format, shared by the app (electron/agent-channel/transport.ts)
// and the MCP shim (scripts/soft-hearts-mcp.mjs). Newline-delimited JSON frames over a
// local pipe/socket. Both sides prove they hold the profile token with HMAC; the token
// itself never crosses the wire, so a process squatting on the pipe name learns nothing.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const WIRE_VERSION = 1;
export const WIRE_APP = 'soft-hearts-next';
export const MAX_FRAME_BYTES = 64 * 1024;
/** This edition only. The Codex edition ("soft hearts") never uses this prefix. */
export const AGENT_PIPE_PREFIX = '\\\\.\\pipe\\soft-hearts-next-agent-';

/**
 * Windows: the one pipe that belongs to this user and this profile directory. Both sides derive
 * it, so a token file copied into another profile (stable -> development) points at a pipe that
 * profile does not accept. User and path compare case-insensitively, like Windows does.
 */
export function agentPipeName(username, profileDirectory) {
  const key = `${String(username ?? '').toLowerCase()}\n${path.win32.resolve(String(profileDirectory)).toLowerCase()}`;
  return `${AGENT_PIPE_PREFIX}${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

export function nonce() { return randomBytes(32).toString('base64'); }

function mac(token, role, first, second) {
  return createHmac('sha256', Buffer.from(String(token), 'utf8')).update(`${WIRE_APP}\n${role}\n${first}\n${second}`).digest('hex');
}
/** Client proof: binds the server's challenge and the client's own nonce. */
export function clientProof(token, serverNonce, clientNonce) { return mac(token, 'client', serverNonce, clientNonce); }
/** Server proof: lets the client check it reached the real app before sending any request. */
export function serverProof(token, clientNonce, serverNonce) { return mac(token, 'server', clientNonce, serverNonce); }

export function proofEquals(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)) return false;
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(actual, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encodeFrame(value) {
  const line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new Error('frame too large');
  return line;
}

/** Splits a byte stream into JSON frames; reports oversize or malformed input instead of buffering it. */
export class FrameReader {
  constructor(onFrame, onError, maxBytes = MAX_FRAME_BYTES) {
    this.onFrame = onFrame; this.onError = onError; this.maxBytes = maxBytes;
    this.chunks = []; this.size = 0; this.failed = false;
  }
  push(chunk) {
    if (this.failed) return;
    let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    for (;;) {
      const end = buffer.indexOf(0x0a);
      if (end < 0) {
        this.size += buffer.length;
        if (this.size > this.maxBytes) { this.fail('too_large'); return; }
        if (buffer.length) this.chunks.push(buffer);
        return;
      }
      const piece = buffer.subarray(0, end);
      if (this.size + piece.length > this.maxBytes) { this.fail('too_large'); return; }
      const line = Buffer.concat([...this.chunks, piece]).toString('utf8');
      this.chunks = []; this.size = 0; buffer = buffer.subarray(end + 1);
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { this.fail('malformed'); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { this.fail('malformed'); return; }
      this.onFrame(value);
      if (this.failed) return;
    }
  }
  fail(reason) { if (this.failed) return; this.failed = true; this.chunks = []; this.onError(reason); }
}
