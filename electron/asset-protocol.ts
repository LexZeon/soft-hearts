/**
 * The `mmd-asset://` protocol handler (moved out of electron/main.ts).
 *
 * GET/HEAD only. The URL is resolved by the AssetRegistry (approved folders,
 * allowed extensions) and the file is streamed with Electron's net.fetch, plus
 * `Access-Control-Allow-Origin: *`; any failure answers 403. That path is
 * unchanged.
 *
 * One addition (docs/claude/2026-11-02-pmx-utf8.md): a `.pmx` whose header
 * says UTF-8 text, version 2.1 or additional UVs (`pmxMayNeedPreparation`) is
 * read whole and, when needed, served as the bytes three's MMDParser can read
 * (shared/pmx-text-encoding.ts `preparePmxForMmdParser`): UTF-16LE text,
 * because MMDParser decodes PMX text as UTF-16LE only; a 2.1 file as 2.0,
 * because MMDParser refuses every 2.1 file; additional-UV morphs without their
 * offsets, because MMDParser reads none of their bytes. Such a response
 * carries an `X-PMX-Conversion` header saying what changed (visible in the
 * renderer's DevTools network panel). Only the header (11 bytes) of other PMX
 * files is read; they, and a file the converter leaves alone, stream from
 * net.fetch as before. The file on disk is never written; host identity hashes
 * (blush calibration, model profile cache, the reviewed Gene check) keep
 * reading the original file.
 */
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PMX_HEADER_SNIFF_BYTES, describePmxPreparation, pmxMayNeedPreparation, preparePmxForMmdParser, readPmxHeader,
} from '../shared/pmx-text-encoding';

export interface AssetProtocolPorts {
  /** AssetRegistry.resolve: the approved file behind an mmd-asset:// URL; throws when it is not allowed. */
  resolve(url: string): Promise<string>;
  /** Electron's net.fetch for a file:// URL. */
  fetchFile(url: string): Promise<Response>;
  /** The first `length` bytes of a file (default node:fs). */
  readHead?(file: string, length: number): Promise<Uint8Array>;
  /** A whole file (default node:fs). */
  readFile?(file: string): Promise<Uint8Array>;
}

async function readFileHead(file: string, length: number): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const head = new Uint8Array(length);
    const { bytesRead } = await handle.read(head, 0, length, 0);
    return head.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** A PMX as MMDParser-readable bytes with a note on what changed, or null to serve the file as it is. */
async function convertedPmx(file: string, ports: AssetProtocolPorts): Promise<{ bytes: Uint8Array; note: string } | null> {
  if (path.extname(file).toLowerCase() !== '.pmx') return null;
  try {
    const header = readPmxHeader(await (ports.readHead ?? readFileHead)(file, PMX_HEADER_SNIFF_BYTES));
    if (!header || !pmxMayNeedPreparation(header)) return null;
    const result = preparePmxForMmdParser(await (ports.readFile ?? readFile)(file));
    return result.changed ? { bytes: result.bytes, note: describePmxPreparation(result) } : null;
  } catch { return null; }
}

export function createAssetProtocolHandler(ports: AssetProtocolPorts): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method))
        return new Response('Method not allowed', { status: 405 });
      const file = await ports.resolve(request.url);
      const converted = await convertedPmx(file, ports);
      if (converted) {
        const headers = new Headers({
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(converted.bytes.byteLength),
          'Access-Control-Allow-Origin': '*',
          'X-PMX-Conversion': converted.note,
        });
        return new Response(request.method === 'HEAD' ? null : (converted.bytes as Uint8Array<ArrayBuffer>), { status: 200, headers });
      }
      const response = await ports.fetchFile(pathToFileURL(file).href);
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(
        request.method === 'HEAD' ? null : response.body,
        { status: response.status, headers },
      );
    } catch {
      return new Response('Asset unavailable', { status: 403 });
    }
  };
}
