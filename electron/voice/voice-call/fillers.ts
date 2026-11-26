/**
 * I-091 step 2: her short sounds ("嗯……", "诶？") for calls, made once with her CURRENT reading voice and kept on this computer
 * per character and voice (<profile>/voice-call-fillers/<character>/<voice>/<id>.pcm, 24 kHz mono PCM16). A different voice
 * for the character is a different folder; making the new one removes the old ones for that character (regenerated when the
 * voice changes).
 *
 * Spending: the system voice needs nothing (free, local; the window says the fixed text itself). Bailian and Drama 3 are paid:
 * the clips are generated only through generate(), which the window calls after it has shown the notice for exactly this voice
 * (its key comes back with the request) — never on start, never silently. At most CALL_FILLER_IDS.length short calls per voice,
 * each once; Drama 3 goes through the monthly limit like every reading. Folder and file names are hashes and fixed ids: no
 * voice name, key or text is written. Nothing here is conversation: no archive, reward or history.
 */
import { createHash } from 'node:crypto';
import { existsSync, promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { FEED_CUE_MAX_BYTES } from '../../../shared/initiative';
import type { TtsConfig } from '../../../shared/foundation/tts-config';
import { CALL_FILLER_IDS, CALL_FILLER_TEXT, CALL_FILLER_TONE, type CallFillerClips, type CallFillerId, type CallFillerStatus } from '../../../shared/voice/voice-call';
import { supportsTurnSpeechEmotion } from '../../mood';
import type { SpeechSynthesizer } from '../speech-runtime';
import { validateTtsConfig } from '../tts';

export const CALL_FILLER_FOLDER = 'voice-call-fillers';
/** One filler synthesis that takes longer than this is abandoned. */
export const CALL_FILLER_TIMEOUT_MS = 8000;

export interface CallFillerFs {
  readFile(file: string): Promise<Buffer>;
  writeFile(file: string, data: Buffer): Promise<void>;
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  readdir(dir: string): Promise<string[]>;
  rm(target: string, options: { recursive: true; force: true }): Promise<void>;
  exists(file: string): boolean;
}
export interface CallFillerStorePorts {
  /** The profile directory, or null before settings are loaded. */
  directory(): string | null;
  /** The reading synthesizer (Drama 3 under its monthly limit; Bailian). */
  synthesize: SpeechSynthesizer;
  fs?: CallFillerFs;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Everything that changes how her voice sounds (never the key). */
export function callFillerVoiceKey(config: TtsConfig): string {
  return hash(JSON.stringify([config.provider, config.apiHost, config.region, config.model, config.voice, config.rate,
    config.provider === 'fish' ? config.fishVoiceId ?? '' : '', config.provider === 'fish' ? config.fishActingStyle ?? '' : '']));
}
const paid = (config: TtsConfig) => config.provider === 'bailian' || config.provider === 'fish';

export class CallFillerStore {
  private readonly memory = new Map<string, Buffer>();
  private running: Promise<{ generated: number; failed: number }> | null = null;
  private readonly fs: CallFillerFs;
  constructor(private readonly ports: CallFillerStorePorts) {
    this.fs = ports.fs ?? {
      readFile: file => fsPromises.readFile(file), writeFile: (file, data) => fsPromises.writeFile(file, data),
      mkdir: (dir, options) => fsPromises.mkdir(dir, options), readdir: dir => fsPromises.readdir(dir),
      rm: (target, options) => fsPromises.rm(target, options),
      exists: file => { try { return existsSync(file); } catch { return false; } },
    };
  }

  private folder(characterId: string, config: TtsConfig): string | null {
    const root = this.ports.directory();
    return root ? path.join(root, CALL_FILLER_FOLDER, hash(characterId), callFillerVoiceKey(config)) : null;
  }

  status(characterId: string, config: TtsConfig): CallFillerStatus {
    const voiceKey = callFillerVoiceKey(config);
    if (!paid(config)) return { provider: config.provider, paid: false, ready: true, missing: 0, voiceKey };
    const folder = this.folder(characterId, config);
    const missing = folder ? CALL_FILLER_IDS.filter(id => !this.memory.has(path.join(folder, id)) && !this.fs.exists(path.join(folder, `${id}.pcm`))).length : CALL_FILLER_IDS.length;
    return { provider: config.provider, paid: true, ready: missing === 0, missing, voiceKey };
  }

  /**
   * Makes the missing clips of the current voice. `noticedKey`: the voice key the window showed the spending notice for; a
   * paid voice without that exact key generates nothing.
   */
  generate(characterId: string, config: TtsConfig, noticedKey: unknown): Promise<{ generated: number; failed: number }> {
    if (!paid(config)) return Promise.resolve({ generated: 0, failed: 0 });
    if (noticedKey !== callFillerVoiceKey(config)) return Promise.reject(Error('还没有给这个声音显示过费用说明，没有生成。'));
    if (this.running) return this.running;
    const run = this.make(characterId, config).finally(() => { if (this.running === run) this.running = null; });
    this.running = run;
    return run;
  }

  /** The clips of the current voice that exist (base64 PCM16 24 kHz mono); none for the system voice. */
  async clips(characterId: string, config: TtsConfig): Promise<CallFillerClips> {
    const voiceKey = callFillerVoiceKey(config), clips: CallFillerClips['clips'] = {};
    const folder = paid(config) ? this.folder(characterId, config) : null;
    if (folder) for (const id of CALL_FILLER_IDS) {
      const pcm = await this.read(folder, id);
      if (pcm) clips[id] = pcm.toString('base64');
    }
    return { voiceKey, provider: config.provider, clips };
  }

  private async read(folder: string, id: CallFillerId): Promise<Buffer | null> {
    const key = path.join(folder, id), cached = this.memory.get(key);
    if (cached) return cached;
    try {
      const data = await this.fs.readFile(path.join(folder, `${id}.pcm`));
      if (data.length < 2 || data.length > FEED_CUE_MAX_BYTES || data.length % 2) return null;
      this.memory.set(key, data);
      return data;
    } catch { return null; }
  }

  private async make(characterId: string, config: TtsConfig): Promise<{ generated: number; failed: number }> {
    const folder = this.folder(characterId, config);
    if (!folder) return { generated: 0, failed: 0 };
    // A new voice for this character: the clips of its earlier voices are removed (they would never be played again).
    const characterFolder = path.dirname(folder), current = path.basename(folder);
    try { for (const name of await this.fs.readdir(characterFolder)) if (name !== current) { await this.fs.rm(path.join(characterFolder, name), { recursive: true, force: true }); for (const key of this.memory.keys()) if (key.startsWith(path.join(characterFolder, name))) this.memory.delete(key); } }
    catch { /* first voice for this character */ }
    await this.fs.mkdir(folder, { recursive: true });
    let voice: TtsConfig;
    try { voice = validateTtsConfig(structuredClone(config.provider === 'bailian' && supportsTurnSpeechEmotion(config.model) ? { ...config, emotion: 'custom', instruction: CALL_FILLER_TONE } : { ...config })); }
    catch { return { generated: 0, failed: CALL_FILLER_IDS.length }; }
    let generated = 0, failed = 0;
    for (const id of CALL_FILLER_IDS) {
      if (await this.read(folder, id)) continue;
      const pcm = await this.synthesize(voice, CALL_FILLER_TEXT[id]);
      if (!pcm) { failed++; continue; }
      try { await this.fs.writeFile(path.join(folder, `${id}.pcm`), pcm); this.memory.set(path.join(folder, id), pcm); generated++; }
      catch { failed++; }
    }
    return { generated, failed };
  }

  private async synthesize(config: TtsConfig, text: string): Promise<Buffer | null> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), CALL_FILLER_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    const chunks: Buffer[] = [];
    let bytes = 0, bad = false;
    try {
      await this.ports.synthesize(config, text, controller.signal, event => {
        if (event.type !== 'audio' || controller.signal.aborted) return;
        if (event.format !== 'pcm_s16le' || event.sampleRate !== 24000 || event.channels !== 1) { bad = true; controller.abort(); return; }
        const chunk = Buffer.from(event.data, 'base64');
        bytes += chunk.length;
        if (bytes > FEED_CUE_MAX_BYTES) { bad = true; controller.abort(); return; }
        chunks.push(chunk);
      });
    } catch { return null; }
    finally { clearTimeout(timer); }
    if (bad || controller.signal.aborted || bytes < 2) return null;
    const pcm = Buffer.concat(chunks);
    return pcm.subarray(0, pcm.length - (pcm.length % 2));
  }
}
