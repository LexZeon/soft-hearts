import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parseWeightQuery, parseWeightSave, parseWeightTags, weightData, motionWeightPackId,
  type MotionWeightAsset, type MotionWeightResults, type MotionWeightTag, type MotionWeightView,
} from '../shared/motion-weights';
import { buildMotionTagIndex, type MotionRecord } from '../shared/r32/motion-tag-index';
import { rankMotionTagAnnotations } from '../shared/r32/motion-tag-query';

interface RecordRow { assetKey: string; sha256: string; revision: number; tags: MotionWeightTag[] }
interface Lease { owner: number; asset: MotionWeightAsset; generation: number }
interface Dependencies { assets(packId: unknown): Promise<readonly MotionWeightAsset[]> }
const MAX_BYTES = 2 * 1024 * 1024, MAX_RECORDS = 2048;
const keyOf = (asset: Pick<MotionWeightAsset, 'assetKey' | 'sha256'>) => JSON.stringify([asset.assetKey, asset.sha256]);
const sameAsset = (a: MotionWeightAsset, b: MotionWeightAsset) =>
  a.packId === b.packId && a.motionId === b.motionId && a.assetKey === b.assetKey && a.sha256 === b.sha256;
const stale = (): never => { throw Error('动作或标签已变更，请重新选择后保存。'); };

/** User search annotations only. This store never supplies playback admission or mutates a catalog. */
export class MotionWeightStore {
  private readonly leases = new Map<string, Lease>();
  private readonly generations = new Map<string, number>();
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string, private readonly dependencies: Dependencies) {}

  invalidateSelection(owner: number, packId: unknown): void {
    if (!Number.isSafeInteger(owner) || owner < 1 || !motionWeightPackId(packId)) return stale();
    this.generations.delete(this.slot(owner, packId));
    for (const [token, lease] of this.leases)
      if (lease.owner === owner && lease.asset.packId === packId) this.leases.delete(token);
  }

  dropOwner(owner: number): void {
    for (const [token, lease] of this.leases) if (lease.owner === owner) this.leases.delete(token);
    for (const key of this.generations.keys()) if (key.startsWith(`${owner}:`)) this.generations.delete(key);
  }
  private slot(owner: number, packId: string): string { return `${owner}:${packId}`; }
  private async records(): Promise<RecordRow[]> {
    let bytes: Buffer;
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw Error('invalid-sidecar');
      bytes = await readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw Error('动作标签文件无法读取，原文件已保留。');
    }
    try {
      if (bytes.length > MAX_BYTES) throw Error('oversize');
      const data: unknown = JSON.parse(bytes.toString('utf8'));
      if (!weightData(data, ['schemaVersion', 'records']) || data.schemaVersion !== 1
        || !Array.isArray(data.records) || data.records.length > MAX_RECORDS) throw Error('schema');
      const seen = new Set<string>();
      return data.records.map((row: unknown) => {
        if (!weightData(row, ['assetKey', 'sha256', 'revision', 'tags']) || typeof row.assetKey !== 'string'
          || row.assetKey.length > 512 || !row.assetKey.length || /[\u0000-\u001f\u007f]/.test(row.assetKey)
          || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)
          || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1) throw Error('record');
        const record = { assetKey: row.assetKey, sha256: row.sha256, revision: row.revision as number, tags: parseWeightTags(row.tags) };
        const key = keyOf(record); if (seen.has(key)) throw Error('duplicate'); seen.add(key); return record;
      });
    } catch { throw Error('动作标签文件格式不受支持，原文件已保留。'); }
  }
  async read(owner: number, packId: unknown, motionId: unknown): Promise<MotionWeightView> {
    if (!Number.isSafeInteger(owner) || owner < 1 || !motionWeightPackId(packId) || typeof motionId !== 'string'
      || !/^[a-z0-9-]{1,80}$/.test(motionId)) return stale();
    const slot = this.slot(owner, packId), generation = ++this.generation;
    if (!Number.isSafeInteger(generation)) return stale();
    this.generations.set(slot, generation);
    for (const [token, lease] of this.leases) if (lease.owner === owner && lease.asset.packId === packId) this.leases.delete(token);
    const assets = await this.dependencies.assets(packId), asset = assets.find(row => row.motionId === motionId);
    if (!asset || this.generations.get(slot) !== generation) return stale();
    const rows = await this.records();
    if (this.generations.get(slot) !== generation) return stale();
    const token = randomBytes(24).toString('hex'), row = rows.find(row => keyOf(row) === keyOf(asset));
    this.leases.set(token, { owner, asset: { ...asset }, generation });
    return { asset: { ...asset }, token, revision: row?.revision ?? 0, tags: structuredClone(row?.tags ?? []) };
  }
  async save(owner: number, value: unknown): Promise<MotionWeightView> {
    const request = parseWeightSave(value);
    const operation = async () => {
      const lease = this.leases.get(request.token);
      const current = () => {
        if (!lease || lease.owner !== owner || this.leases.get(request.token) !== lease
          || this.generations.get(this.slot(owner, lease.asset.packId)) !== lease.generation) return stale();
        return lease;
      };
      current();
      const verify = async () => {
        const live = current(), assets = await this.dependencies.assets(live.asset.packId);
        current(); if (!assets.some(row => sameAsset(row, live.asset))) return stale();
      };
      await verify();
      const live = current(), rows = await this.records(); current();
      const old = rows.find(row => keyOf(row) === keyOf(live.asset));
      if ((old?.revision ?? 0) !== request.revision) return stale();
      const revision = request.revision + 1;
      if (!Number.isSafeInteger(revision) || !old && rows.length >= MAX_RECORDS) throw Error('动作标签记录已满。');
      const saved: RecordRow = { assetKey: live.asset.assetKey, sha256: live.asset.sha256, revision, tags: request.tags };
      const next = old ? rows.map(row => row === old ? saved : row) : [...rows, saved];
      const bytes = JSON.stringify({ schemaVersion: 1, records: next }, null, 2) + '\n';
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw Error('动作标签记录已满。');
      await mkdir(path.dirname(this.file), { recursive: true }); current();
      const temporary = this.file + '.' + randomBytes(12).toString('hex') + '.tmp';
      let created = false;
      try {
        await writeFile(temporary, bytes, { flag: 'wx' });
        created = true;
        await verify(); current();
        await rename(temporary, this.file);
      } finally { if (created) await rm(temporary, { force: true }); }
      return { asset: { ...live.asset }, token: request.token, revision, tags: structuredClone(saved.tags) };
    };
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async search(value: unknown): Promise<MotionWeightResults> {
    const query = parseWeightQuery(value), assets = await this.dependencies.assets(query.packId), rows = await this.records();
    const records: MotionRecord[] = assets.map(asset => {
      const row = rows.find(row => keyOf(row) === keyOf(asset));
      return { sourceId: `catalog:${asset.packId}/${asset.motionId}`, assetKey: asset.assetKey, outputSha256: asset.sha256,
        availability: 'available', license: { status: 'reviewed', scopes: ['local-preview'], ref: 'installed-host-catalog' },
        tags: (row?.tags ?? []).map(tag => ({ dimension: tag.dimension, raw: tag.tag, tag: tag.tag, fit: tag.weight,
          layer: 'candidate', evidence: 'candidate', refs: [`user-annotation:${row?.revision ?? 0}`] })),
        uses: [], evidenceConfidence: null, playbackStrength: null };
    });
    const ranked = rankMotionTagAnnotations(buildMotionTagIndex(records), { layer: 'candidate', preferred: query.preferred });
    return { rows: ranked.map(row => ({ asset: { ...assets.find(asset => JSON.stringify(['asset', asset.assetKey, asset.sha256]) === row.key)! },
      rankingValue: row.rankingValue, score: row.score, knownCoverage: row.knownCoverage, dimensions: row.dimensions })), executionAuthority: false };
  }
}
