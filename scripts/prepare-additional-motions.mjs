/** Maintainer-only, offline preparation from reviewed original downloads. Never runs upstream code. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js';
import { retargetBvhToGene, parseBvh } from './lib/bvh-to-gene.mjs';

if (process.argv.length > 2) throw new Error('This offline preparation script accepts no paths or URLs.');
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(workspace, '.local/motion-sources');
const catalogFile = path.join(workspace, 'shared/motion-catalog.json');
const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
const gene = catalog.packs.find(pack => pack.id === 'gene');
const parser = new MMDParser.Parser();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = body => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
const pmxBytes = await readFile(path.join(workspace, `assets/bundled/mmdagent-ex/gene/${gene.revision}/model/gene.pmx`));
const pmx = parser.parsePmx(arrayBuffer(pmxBytes), true);
const converterHash = hash(await readFile(path.join(workspace, 'scripts/lib/bvh-to-gene.mjs')));
const license = await readFile(path.join(workspace, `assets/bundled/mmdagent-ex/gene/${gene.revision}/metadata/cc-by-4.0.txt`));
const licenseUrl = 'https://creativecommons.org/licenses/by/4.0/';
const newPacks = [];

async function prepare({ id, name, source, sourceUrl, attribution, modifications, compatibilityNote, upstreamNotes, inputs }) {
  const outputs = [];
  for (const input of inputs) {
    assert.ok(!/(^|[\\/])(FNA|UNA)([\\/._-]|$)/i.test(input.originalPath));
    const original = await readFile(path.join(local, input.localPath));
    if (input.sha256) assert.equal(hash(original), input.sha256, `Reviewed source changed: ${input.originalPath}`);
    let bytes = original;
    let conversion = null;
    if (input.options) {
      const result = retargetBvhToGene(original.toString('utf8'), pmx.bones, input.options);
      bytes = result.bytes;
      conversion = result.report;
    }
    const motion = parser.parseVmd(arrayBuffer(bytes), true);
    assert.ok(motion.motions.length > 0);
    assert.ok(motion.motions.every(frame => [...frame.position, ...frame.rotation].every(Number.isFinite)));
    const durationFrames = Math.max(0, ...motion.motions.map(frame => frame.frameNum), ...motion.morphs.map(frame => frame.frameNum));
    outputs.push({
      bytes,
      descriptor: {
        id: input.id, name: input.name, category: input.category,
        tags: ['mmd', 'vmd', 'gene', source, input.category, ...(input.tags ?? [])],
        relativePath: `motions/${input.category}/${input.id}.vmd`,
        originalPath: input.originalPath, downloadUrl: input.downloadUrl,
        sha256: hash(bytes), bytes: bytes.length, durationFrames,
        boneFrames: motion.motions.length, morphFrames: motion.morphs.length,
      },
      provenance: {
        originalPath: input.originalPath, sourceUrl: input.sourceUrl ?? sourceUrl,
        downloadUrl: input.downloadUrl, originalSha256: hash(original), originalBytes: original.length,
        ...(input.archive ? { archive: input.archive } : {}),
        modifications: input.options ? 'BVH body retargeted to Gene; cropped, resampled to 30fps, fixed root, loop seam blended. Face and fingers are not synthesized.' : 'English filename only; original VMD bytes unchanged.',
        ...(conversion ? { options: input.options, conversion, converterSha256: converterHash } : {}),
      },
    });
  }
  // Content revision identifies these source hashes and exact conversion settings; it is not an upstream Git commit.
  const revision = hash(JSON.stringify(outputs.map(output => ({ file: output.descriptor, provenance: output.provenance })))).slice(0, 40);
  const base = path.join(workspace, 'assets/bundled', source, id, revision);
  const save = async (relative, body) => {
    assert.match(relative, /^[a-z0-9.-]+(?:\/[a-z0-9.-]+)+$/);
    const target = path.join(base, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    return { relativePath: relative, originalPath: relative, downloadUrl: sourceUrl, sha256: hash(body), bytes: Buffer.byteLength(body) };
  };
  for (const output of outputs) await save(output.descriptor.relativePath, output.bytes);
  const pack = {
    id, name, source, sourceUrl, revision, bundledOnly: true,
    license: { id: 'CC-BY-4.0', url: licenseUrl, attribution },
    modifications, compatibilityNote, motions: outputs.map(output => output.descriptor), documents: [],
  };
  const provenance = {
    schemaVersion: 1, packId: id, revision, revisionKind: 'sha256-of-reviewed-motion-descriptors-and-conversion-provenance-first-40-hex',
    source, sourceUrl, license: pack.license, modifications, compatibilityNote,
    geneModelRevision: gene.revision, motions: outputs.map(output => ({ ...output.descriptor, provenance: output.provenance })),
  };
  const attributionText = `${attribution}\n\nCC BY 4.0: ${licenseUrl}\nSource: ${sourceUrl}\nContent revision: ${revision}\n\n${modifications}\n${compatibilityNote}\n\nOnly motion data is included. Music, video, preview characters and stages are not included.\nEnglish filenames, categories and descriptive tags do not create automatic moods or behaviors.\n`;
  pack.documents.push(await save('metadata/source.json', JSON.stringify(provenance, null, 2) + '\n'));
  pack.documents.push(await save('metadata/attribution.txt', attributionText));
  pack.documents.push(await save('metadata/cc-by-4.0.txt', license));
  pack.documents.push(await save('metadata/upstream-notes.md', upstreamNotes));
  newPacks.push(pack);
  console.log(`${id}: ${pack.motions.length} motions, ${revision}`);
}

const styleRoot = path.join(local, '100style');
const cuts = (await readFile(path.join(styleRoot, 'samples/Frame_Cuts.csv'), 'utf8')).trim().split(/\r?\n/).map(line => line.split(','));
const headers = cuts.shift();
const styleNames = [
  ['Neutral', 'neutral-idle', 'Neutral Idle'],
  ['ArmsFolded', 'arms-folded-idle', 'Arms Folded Idle'],
  ['ArmsBehindBack', 'arms-behind-back-idle', 'Arms Behind Back Idle'],
  ['Proud', 'proud-idle', 'Proud Idle'],
  ['Depressed', 'depressed-idle', 'Depressed Idle'],
];
const reviewedStyleHashes = {
  Neutral: '71aead2e3246bdb47a5b839cb3e60e0574e9a1a046c071cc147e2922a35f259f',
  ArmsFolded: '94d32c7200b6359fec0be3118b67fd36b836917a36980f59cdd31052950bb296',
  ArmsBehindBack: '3994fa04798328a1e907ebca6e4fd864b674deaea8314addc5e20a5e02228bdc',
  Proud: '9e29739d07c5b8d340011907099d11e298182de9280701d76e8497fd6826382b',
  Depressed: 'b0ed9a0eada80df18424fdb5b9eea676cf3033a0b4910420ad4021c29f62d7f9',
};
await prepare({
  id: '100style-idles', name: '100STYLE · Gene Idles', source: '100style', sourceUrl: 'https://www.ianxmason.com/100style/',
  attribution: 'The 100STYLE Dataset - Ian Mason. Ian Mason, Sebastian Starke and Taku Komura (2022), Real-Time Style Modelling of Human Locomotion via Feature-Wise Transformations and Local Motion Phases. DOI: 10.1145/3522618.',
  modifications: 'BVH→VMD：为 Gene 重定向，裁去 T-pose，转为 30 FPS，固定根位移并平滑循环接缝。英文命名与 tags 由 soft hearts 添加。',
  compatibilityNote: 'Adapted for Gene. Body motion only; no face, finger articulation or physics. Each idle is selected manually; style names are descriptive tags.',
  upstreamNotes: '# 100STYLE\n\nSource and license declaration: https://www.ianxmason.com/100style/\nArchive: https://zenodo.org/records/8127870/files/100STYLE.zip?download=1\nUpstream MD5: 3cf627852fd8192024c04a8d0ef49583\n\nThe author declares CC BY 4.0 for this dataset and requests creative/commercial attribution to “The 100STYLE Dataset - Ian Mason”.\nThe original 60 FPS captures include leading/trailing T-poses. Frame_Cuts.csv supplied by the author defines usable ranges. This subset crops within those ranges and uses the exact options recorded in source.json.\n',
  inputs: styleNames.map(([style, id, name]) => {
    const row = cuts.find(row => row[0] === style);
    assert.ok(row, `Missing author frame cuts: ${style}`);
    const start = Number(row[headers.indexOf('ID_START')]) + 60;
    const stop = Math.min(Number(row[headers.indexOf('ID_STOP')]) - 60, start + 599);
    return {
      id, name, category: 'idle', tags: ['loop', 'in-place', 'body-motion', style.toLowerCase()],
      localPath: `100style/samples/${style}_ID.bvh`, originalPath: `100STYLE/${style}/${style}_ID.bvh`, sha256: reviewedStyleHashes[style],
      downloadUrl: 'https://zenodo.org/records/8127870/files/100STYLE.zip?download=1',
      archive: { file: '100STYLE.zip', md5: '3cf627852fd8192024c04a8d0ef49583', frameCuts: 'Frame_Cuts.csv' },
      options: { startFrame: start, endFrame: stop, rootMode: 'fixed', faceForward: true, loopBlendSeconds: 0.5 },
    };
  }),
});

const mpiSource = JSON.parse(await readFile(path.join(local, 'mpi-embm/metadata/source.json'), 'utf8'));
const mpiShortlist = JSON.parse(await readFile(path.join(local, 'mpi-embm/metadata/recommended-clips.json'), 'utf8'));
const mpiInputs = [];
for (const emotion of ['neutral', 'joy', 'pride', 'sadness', 'anger']) {
  const selected = mpiShortlist.find(motion => motion.tags.includes(emotion));
  assert.ok(selected, `No complete MPI sample: ${emotion}`);
  const text = await readFile(path.join(local, 'mpi-embm', selected.relativePath), 'utf8');
  const bvh = parseBvh(text);
  const startFrame = Math.round(0.25 / bvh.frameTime);
  const endFrame = Math.min(bvh.frameCount - 1, startFrame + Math.round(4 / bvh.frameTime));
  mpiInputs.push({
    id: `conversation-${emotion}`, name: `Conversation ${emotion[0].toUpperCase()}${emotion.slice(1)}`, category: 'gesture',
    tags: ['conversation', 'upper-body', 'loop', emotion], localPath: `mpi-embm/${selected.relativePath}`,
    originalPath: selected.originalPath, sha256: selected.sha256, downloadUrl: mpiSource.downloadUrl,
    archive: mpiSource.archive,
    options: { startFrame, endFrame, rootMode: 'fixed', faceForward: true, upperBodyOnly: true, loopBlendSeconds: 0.35 },
  });
}
await prepare({
  id: 'mpi-embm-gestures', name: 'MPI EMBM · Gene Gestures', source: 'mpi-embm', sourceUrl: mpiSource.sourceUrl,
  attribution: mpiSource.attribution,
  modifications: 'BVH→VMD：截取会话片段并重定向 Gene 上半身，保留站姿下肢、固定根位移、转为 30 FPS 并平滑接缝。添加英文命名与 tags。',
  compatibilityNote: 'Gene upper-body gestures from seated body captures. No facial expressions or finger articulation; emotion tags describe source labels, not an automatic mood system.',
  upstreamNotes: `# MPI EMBM\n\nSource: ${mpiSource.sourceUrl}\nDOI: ${mpiSource.doi}\nThe official Figshare API declares CC BY 4.0.\n\nThe official 50,099,276-byte archive matches its published MD5 but is truncated and has no ZIP central directory. Only complete CRC-verified BVH members were recovered; partial members are excluded. These five excerpts are from intact files. The source's advertised total was not fully recoverable.\n`,
  inputs: mpiInputs,
});

const geneaSource = JSON.parse(await readFile(path.join(local, 'genea-2022/metadata/source.json'), 'utf8'));
const geneaInputs = ['003', '017'].map((number, index) => {
  const selected = geneaSource.motions.find(motion => motion.id === `full-body-fsb-test-${number}`);
  assert.ok(selected && !['FNA', 'UNA'].includes(selected.condition));
  return {
    id: `speaking-gesture-${index + 1}`, name: `Speaking Gesture ${index + 1}`, category: 'gesture',
    tags: ['speaking', 'upper-body', 'loop', 'fsb'], localPath: `genea-2022/${selected.relativePath}`,
    originalPath: selected.originalPath, sha256: selected.sha256, downloadUrl: selected.archiveUrl,
    archive: { file: 'full-body_bvh.zip', memberCrc32: selected.zipCrc32, condition: selected.condition, version: geneaSource.version },
    options: { startFrame: 150, endFrame: 330, rootMode: 'fixed', faceForward: true, upperBodyOnly: true, loopBlendSeconds: 0.4 },
  };
});
await prepare({
  id: 'genea-2022-gestures', name: 'GENEA 2022 · Gene Gestures', source: 'genea-2022', sourceUrl: geneaSource.sourceUrl,
  attribution: geneaSource.attribution,
  modifications: 'BVH→VMD：从 FSB 的合格生成手势中截取两段并重定向 Gene 上半身，转为 30 FPS、固定根位移并平滑接缝。',
  compatibilityNote: 'CC BY 4.0 subset only. FNA and UNA (CC BY-NC 4.0) are excluded. Body gestures only; no audio, face or finger articulation.',
  upstreamNotes: `# GENEA Challenge 2022\n\nSource: ${geneaSource.sourceUrl}\nVersion: ${geneaSource.version}\nOnly FSB is used in this curated subset. FNA and UNA are entirely excluded before downloading motion bytes.\n\n## Original distribution README\n\n${await readFile(path.join(local, 'genea-2022/metadata/upstream-readme.txt'), 'utf8')}\n`,
  inputs: geneaInputs,
});

const danceSource = JSON.parse(await readFile(path.join(local, 'fnoji/split-dance/source.json'), 'utf8'));
await prepare({
  id: 'fnoji-dances', name: 'fnoji · Short Dances', source: 'fnoji', sourceUrl: 'https://booth.pm/ja/items/8103074',
  attribution: danceSource.attribution,
  modifications: 'Split Dance 原始 VMD 内容未改写，仅使用英文文件名、分类与 tags。',
  compatibilityNote: 'Manual full-body dance. Model-specific clothing, hair and morph tracks may be ignored by Gene. No music, audio, video, model or stage is distributed.',
  upstreamNotes: `# fnoji Split Dance\n\nAuthor: fnoji (えふのじ)\nOfficial author page: https://www.nicovideo.jp/watch/sm46039479\nBOOTH: https://booth.pm/ja/items/8103074\nThe author page declares CC BY 4.0 and links the downloaded Google Drive VMD.\n\n叉子摇 / Fork Shake is not included: the author links an X post whose account is currently suspended; no downloadable original was retrieved. Its separate source record remains local.\n`,
  inputs: [{
    id: 'split-dance', name: 'Split Dance', category: 'dance', tags: ['short', 'manual', 'full-body'],
    localPath: 'fnoji/split-dance/original/split-dance.vmd', originalPath: danceSource.download.originalName,
    downloadUrl: danceSource.download.url, sourceUrl: 'https://www.nicovideo.jp/watch/sm46039479', sha256: danceSource.download.sha256,
  }],
});

// The project's own pack (T-211, Codex's actions) is not prepared here; keep it as it is.
catalog.packs = [gene, ...newPacks, ...catalog.packs.filter(pack => pack.id === 'soft-hearts-actions')];
await writeFile(catalogFile, JSON.stringify(catalog, null, 2) + '\n');
