import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';

export const MAX_SELECTED_IMAGE_BYTES = 2_800_000, MAX_IMAGE_EDGE = 4_096, MAX_IMAGE_PIXELS = 12_000_000;
export interface EncodedVisualImage { bytes: Buffer; width: number; height: number; thumbnail: Buffer }
export interface SelectedVisualImage {
  dataUrl: string; sha256: string; width: number; height: number; previewDataUrl: string;
  /** Clear only the exact owned transformed buffer; transport copies have their own lifetime. */
  release(): void;
}
function dimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS) throw Error('图片尺寸超出制作范围。');
  return { width, height };
}
/** Read dimensions before native decoding; no image library, file path or execution capability. */
export function selectedImageHeader(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.length > MAX_SELECTED_IMAGE_BYTES) throw Error('图片大小不合格。');
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (bytes.subarray(12,16).toString('ascii') !== 'IHDR' || bytes.readUInt32BE(8) !== 13) throw Error('PNG头不正确。');
    const size=dimensions(bytes.readUInt32BE(16),bytes.readUInt32BE(20));
    let cursor=8,count=0;
    while(cursor+12<=bytes.length && count++<10_000){const length=bytes.readUInt32BE(cursor),end=cursor+12+length;
      if(end>bytes.length)throw Error('PNG数据不完整。');const kind=bytes.subarray(cursor+4,cursor+8).toString('ascii');
      if(kind==='acTL')throw Error('首版只接受静态图片。');cursor=end;if(kind==='IEND')return size;}
    throw Error('PNG数据不完整。');
  }
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255){let cursor=2,count=0;
    while(cursor+4<=bytes.length&&count++<10_000){if(bytes[cursor++]!==255)throw Error('JPEG头不正确。');while(bytes[cursor]===255)cursor++;
      const marker=bytes[cursor++];if(marker===0xd9||marker===0xda)break;
      if(marker===1||(marker>=0xd0&&marker<=0xd8))continue;
      if(cursor+2>bytes.length)break;const length=bytes.readUInt16BE(cursor);if(length<2||cursor+length>bytes.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
        if(length<8)break;return dimensions(bytes.readUInt16BE(cursor+5),bytes.readUInt16BE(cursor+3));}
      cursor+=length;
    }
    throw Error('JPEG尺寸无法验证。');
  }
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'){
    if(bytes.readUInt32LE(4)+8!==bytes.length)throw Error('WebP数据不完整。');
    const kind=bytes.subarray(12,16).toString('ascii');
    if(kind==='VP8X'&&bytes.length>=30){if(bytes[20]&2)throw Error('首版只接受静态图片。');return dimensions(1+bytes.readUIntLE(24,3),1+bytes.readUIntLE(27,3));}
    if(kind==='VP8L'&&bytes.length>=25&&bytes[20]===0x2f)return dimensions(1+(bytes[21]|((bytes[22]&0x3f)<<8)),1+((bytes[22]>>6)|(bytes[23]<<2)|((bytes[24]&0xf)<<10)));
    if(kind==='VP8 '&&bytes.length>=30&&bytes.subarray(23,26).equals(Buffer.from([0x9d,1,0x2a])))return dimensions(bytes.readUInt16LE(26)&0x3fff,bytes.readUInt16LE(28)&0x3fff);
  }
  throw Error('只接受可验证的静态 PNG、JPEG 或 WebP。');
}
/** The caller is the narrow host dialog, never renderer input. Original file is read-only. */
export async function readSelectedVisualImage(file: string, signal: AbortSignal,
  transform: (bytes: Buffer, signal: AbortSignal) => Promise<EncodedVisualImage>): Promise<SelectedVisualImage> {
  let handle: Awaited<ReturnType<typeof open>> | undefined, original: Buffer | undefined, encoded: EncodedVisualImage | undefined;
  try {
    signal.throwIfAborted();const before=await lstat(file);
    if(!before.isFile()||before.isSymbolicLink()||before.size<24||before.size>MAX_SELECTED_IMAGE_BYTES)throw Error('Selected image rejected');
    handle=await open(file,'r');const opened=await handle.stat();
    if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw Error('Selected image changed');
    original=await handle.readFile();signal.throwIfAborted();const after=await handle.stat();
    if(original.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('Selected image changed');
    selectedImageHeader(original);encoded=await transform(original,signal);signal.throwIfAborted();
    const size=dimensions(encoded.width,encoded.height),output=selectedImageHeader(encoded.bytes),thumb=selectedImageHeader(encoded.thumbnail);
    if(encoded.bytes[0]!==255||encoded.bytes[1]!==216||encoded.thumbnail[0]!==255||encoded.thumbnail[1]!==216
      ||output.width!==size.width||output.height!==size.height||encoded.thumbnail.length>160_000||thumb.width>400||thumb.height>400)throw Error('Transformed image rejected');
    const dataUrl=`data:image/jpeg;base64,${encoded.bytes.toString('base64')}`,previewDataUrl=`data:image/jpeg;base64,${encoded.thumbnail.toString('base64')}`;
    if(dataUrl.length>4_000_000)throw Error('Transformed image too large');
    const bytes=encoded.bytes,sha256=createHash('sha256').update(bytes).digest('hex');encoded.thumbnail.fill(0);encoded=undefined;
    const result:SelectedVisualImage={dataUrl,previewDataUrl,sha256,...size,release:()=>{bytes.fill(0);result.dataUrl='';result.previewDataUrl='';result.sha256='';}};
    return result;
  } catch { encoded?.bytes.fill(0);encoded?.thumbnail.fill(0);throw Error('图片无法安全读取或超出静态制作范围；原图未修改。'); }
  finally { original?.fill(0);try{await handle?.close();}catch{throw Error('图片读取资源无法释放；原图未修改。');} }
}
