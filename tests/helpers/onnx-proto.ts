// Tiny ONNX-shaped protobuf writer for tests: ir_version, a filler graph of the given size, opset and metadata_props.
const varint = (value: number): Buffer => { const out: number[] = []; do { let byte = value % 128; value = Math.floor(value / 128); if (value) byte |= 0x80; out.push(byte); } while (value); return Buffer.from(out); };
const field = (number: number, wire: number) => varint(number * 8 + wire);
const bytesField = (number: number, data: Uint8Array): Buffer => Buffer.concat([field(number, 2), varint(data.length), data]);
const text = (value: string) => Buffer.from(value, 'utf8');

export function onnxWithMetadata(metadata: Record<string, string>, graphBytes = 1000): Uint8Array {
  const parts: Buffer[] = [field(1, 0), varint(8), bytesField(2, text('pytorch')),
    bytesField(7, Buffer.alloc(graphBytes, 0x2a)), // the graph: skipped by its length
    bytesField(8, Buffer.concat([field(2, 0), varint(13)]))]; // opset_import { version: 13 }
  for (const [key, value] of Object.entries(metadata)) parts.push(bytesField(14, Buffer.concat([bytesField(1, text(key)), bytesField(2, text(value))])));
  return new Uint8Array(Buffer.concat(parts));
}

/** The metadata keys sherpa-onnx writes for SenseVoice (synthetic CMVN). */
export function senseVoiceMetadata(): Record<string, string> {
  return {
    model_type: 'sense_voice_ctc', lfr_window_size: '7', lfr_window_shift: '6', normalize_samples: '0', vocab_size: '17',
    neg_mean: Array.from({ length: 560 }, () => '-1').join(','), inv_stddev: Array.from({ length: 560 }, () => '0.5').join(','),
    lang_auto: '0', lang_zh: '3', lang_en: '4', lang_yue: '7', lang_ja: '11', lang_ko: '12', lang_nospeech: '13', with_itn: '14', without_itn: '15',
  };
}
