import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write a tiny, original VMD fixture for smoke tests. The caller chooses an ignored
 * output path (normally test-results/); no model or downloaded motion is required.
 */
export async function writeTestMotion(target) {
  const frameNumbers = [0, 30, 60];
  const positionsY = [0, 0.08, 0];
  const frameSize = 15 + 4 + 12 + 16 + 64;
  // VMD 0002 header, model name, bone frames, then empty morph/camera/light/shadow/IK sections.
  const data = Buffer.alloc(
    30 + 20 + 4 + frameNumbers.length * frameSize + 5 * 4,
  );
  data.write("Vocaloid Motion Data 0002", 0, "ascii");
  data.write("DeskMate original", 30, "ascii");
  let offset = 50;
  data.writeUInt32LE(frameNumbers.length, offset);
  offset += 4;
  // Shift-JIS for センター, encoded explicitly to keep the fixture dependency-free.
  const centerName = Buffer.from([
    0x83, 0x5a, 0x83, 0x93, 0x83, 0x5e, 0x81, 0x5b,
  ]);
  const interpolation = Buffer.from([
    20, 20, 20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107,
  ]);
  for (let index = 0; index < frameNumbers.length; index++) {
    centerName.copy(data, offset);
    offset += 15;
    data.writeUInt32LE(frameNumbers[index], offset);
    offset += 4;
    data.writeFloatLE(0, offset);
    offset += 4;
    data.writeFloatLE(positionsY[index], offset);
    offset += 4;
    data.writeFloatLE(0, offset);
    offset += 4;
    for (const component of [0, 0, 0, 1]) {
      data.writeFloatLE(component, offset);
      offset += 4;
    }
    for (let block = 0; block < 4; block++) {
      interpolation.copy(data, offset);
      offset += 16;
    }
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}
