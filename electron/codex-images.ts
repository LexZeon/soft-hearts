import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function withCodexImages<T>(
  dataUrls: string[],
  temporaryRoot: string,
  signal: AbortSignal,
  operation: (files: string[]) => Promise<T>,
): Promise<T> {
  if (!Array.isArray(dataUrls) || !dataUrls.length || dataUrls.length > 2)
    throw new Error("Codex 每次只接受 1–2 张图片。");
  signal.throwIfAborted();
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(temporaryRoot, "vision-"));
  try {
    const files: string[] = [];
    for (const [index, value] of dataUrls.entries()) {
      signal.throwIfAborted();
      if (typeof value !== "string" || value.length > 4_000_000)
        throw new Error("Codex 图片格式不正确或过大。");
      const match =
        /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);
      if (!match) throw new Error("Codex 只接受 PNG、JPEG 或 WebP 图片。");
      const bytes = Buffer.from(match[2], "base64");
      const valid =
        match[1] === "png"
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : match[1] === "jpeg"
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP";
      if (!valid || bytes.toString("base64") !== match[2])
        throw new Error("Codex 图片数据不正确。");
      const file = path.join(
        directory,
        `frame-${index}.${match[1] === "jpeg" ? "jpg" : match[1]}`,
      );
      await writeFile(file, bytes, { flag: "wx", mode: 0o600, signal });
      files.push(file);
    }
    signal.throwIfAborted();
    return await operation(files);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
