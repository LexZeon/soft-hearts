import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AssetRef } from "../shared/contracts";

export class AssetRegistry {
  private roots = new Map<string, string>();
  /** `guard` (agent channel) runs after the file checks and right before the folder is granted to the renderer. */
  async register(filePath: string, guard?: () => void): Promise<AssetRef> {
    const file = await realpath(filePath);
    if (!(await stat(file)).isFile()) throw new Error("所选资源不是文件。");
    guard?.();
    const root = path.dirname(file);
    const token =
      [...this.roots].find(([, dir]) => dir === root)?.[0] ??
      randomBytes(16).toString("hex");
    this.roots.set(token, root);
    return {
      path: file,
      name: path.basename(file),
      url: `mmd-asset://${token}/${encodeURIComponent(path.basename(file))}`,
    };
  }
  async resolve(urlString: string): Promise<string> {
    const url = new URL(urlString);
    if (url.protocol !== "mmd-asset:" || url.search || url.hash)
      throw new Error("资源地址不正确。");
    const root = this.roots.get(url.hostname);
    if (!root) throw new Error("资源未授权。");
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (
      relativePath.includes("\0") ||
      relativePath.includes(":") ||
      path.isAbsolute(relativePath)
    )
      throw new Error("资源路径不正确。");
    const candidate = await realpath(path.resolve(root, relativePath));
    const relative = path.relative(root, candidate);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
      throw new Error("不能访问模型目录以外的文件。");
    if (!(await stat(candidate)).isFile()) throw new Error("资源不是文件。");
    const ext = path.extname(candidate).toLowerCase();
    if (
      ![
        ".pmx",
        ".pmd",
        ".vmd",
        ".png",
        ".jpg",
        ".jpeg",
        ".bmp",
        ".tga",
        ".gif",
        ".webp",
        ".sph",
        ".spa",
      ].includes(ext)
    )
      throw new Error("不支持的资源类型。");
    return candidate;
  }
  clear(): void {
    this.roots.clear();
  }
}
